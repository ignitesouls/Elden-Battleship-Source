import { supabase } from "./supabase";
import { canonicalSquareName } from "./squareSetFormat";
import { participantKey, type ParticipantRow } from "./careerStats";
import { withoutVoided } from "./voidedMatches";
import { cached, forget } from "./archiveCache";
import { prepareEvents, prepareParticipants, type BoardSource } from "./battleRatingBoards";
import { boardShapeKey } from "./boardShape";

export type { BoardSource };

export interface Profile {
  id: string;
  display_name: string;
  /** The player's own choice of name. Null means they've never set one - show display_name. */
  nickname: string | null;
  avatar_url: string | null;
}

/** Longest nickname the input, and the profiles_nickname_length constraint, will accept. */
export const NICKNAME_MAX = 20;

/** What to call an account on screen: its owner's choice first, their Twitch name second. */
export function profileName(profile: Profile | null | undefined): string | null {
  return profile?.nickname ?? profile?.display_name ?? null;
}

/**
 * Mirrors the signed-in Twitch identity into `profiles` so the leaderboard can show a real name
 * and avatar for a user id. Only ever called for accounts with a Twitch identity - anonymous
 * users have nothing durable worth storing, and their stats fall back to nickname grouping.
 *
 * Errors are swallowed: a missing profile row costs you an avatar, not a game.
 */
export async function upsertProfile(input: {
  id: string;
  twitchId: string | null;
  displayName: string;
  avatarUrl: string | null;
}): Promise<void> {
  try {
    await supabase.from("profiles").upsert(
      {
        id: input.id,
        // Omitted rather than written as null when unknown, so it stays out of the ON CONFLICT
        // SET list and an existing twitch_id survives. Nulling it would unpick anything resolved
        // through it - the owner grant in the admins migration is keyed on twitch_id, not uuid.
        ...(input.twitchId ? { twitch_id: input.twitchId } : {}),
        display_name: input.displayName,
        avatar_url: input.avatarUrl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
  } catch {
    // Non-essential.
  }
}

/**
 * The four fields anything on the site actually draws a person with.
 *
 * Spelled out rather than left as a wildcard because the row has three more - `twitch_id`,
 * `updated_at` and `created_at` - and nothing draws any of them. On a single profile that is noise;
 * on fetchProfiles below, which asks for every account that has ever played, it was dead weight on
 * every row, on three separate pages.
 */
const PROFILE_COLUMNS = "id,display_name,nickname,avatar_url";

/** Namespaces the profile entries in the shared cache, so a rename can drop them alone. */
const PROFILE_CACHE_PREFIX = "profiles:";

export async function fetchProfile(id: string): Promise<Profile | null> {
  const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as Profile;
}

/**
 * Stores the player's chosen name, or clears it (null) so their Twitch name takes over again.
 *
 * Deliberately an update rather than an upsert: the row is created by the twitch-login function at
 * sign-in and by upsertProfile above, and inserting here would need a display_name we don't have.
 *
 * Unlike upsertProfile, errors are thrown. A profile mirror that quietly fails costs an avatar; a
 * rename that quietly fails is the bug this whole column exists to fix, so the caller must be able
 * to tell the player it didn't take.
 */
export async function saveProfileNickname(id: string, nickname: string | null): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ nickname, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  // The whole point of a rename is seeing it. Only the profile entries go - the archive feeds
  // beside them in the cache have not changed, and re-reading those would cost more than the
  // staleness this is fixing.
  forget(PROFILE_CACHE_PREFIX);
}

/**
 * Names and avatars for a set of accounts, cached like the feed that produced the set.
 *
 * Every caller passes the user ids off a stats feed, which means in practice every account that
 * has ever played - and all three of them (Almanac, Leaderboard, PlayerStats) did it uncached while
 * the participant rows they took the ids FROM were being cached around them. A visitor reading all
 * three downloaded the same profile table three times.
 *
 * Keyed on the sorted ids, so the three pages agree on the key whenever they are working from the
 * same feed - which, since that feed is itself cached, is the normal case. A page asking about a
 * different set of people misses and reads, exactly as it should.
 *
 * Sorted rather than taken in argument order because the callers build their lists by mapping over
 * rows, and two feeds in different orders describing the same people must not be two cache misses.
 */
export async function fetchProfiles(ids: string[]): Promise<Map<string, Profile>> {
  const unique = [...new Set(ids.filter(Boolean))].sort();
  if (unique.length === 0) return new Map();

  const rows = await cached(`${PROFILE_CACHE_PREFIX}${unique.join(",")}`, async () => {
    const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).in("id", unique);
    if (error || !data) return [];
    return data as Profile[];
  });

  return new Map(rows.map((p) => [p.id, p]));
}

/*
 * The four record tables used to be written straight from here, one function each. They aren't
 * any more: those tables accepted `insert with check (true)`, which meant anyone holding the anon
 * key - it ships in the bundle - could POST invented career stats under any name and attribute
 * them to any account. Archiving now goes through the `archive_match` RPC, which re-derives every
 * number from the room's own attack log, and the insert policies are gone.
 *
 * See lib/archiveMatch.ts for the caller and the lock_down_writes migration for the function.
 * Reads below are unchanged - the record books are still public to look at.
 */

/**
 * Rows PostgREST will return in one response, however many were asked for.
 *
 * This is the server's `db-max-rows`, not a choice made here, and it is enforced SILENTLY: a
 * `.limit(5000)` against a table holding 4816 rows comes back with 1000 of them, no error and
 * nothing on the response saying it was cut. Asking via `.range(0, 4999)` gets the same 1000.
 *
 * That is worth spelling out because of how it fails downstream. Nothing breaks and no page goes
 * blank - the newest rows are all there, so every screen renders something plausible. What it
 * actually does is silently shorten history to whatever the newest thousand rows happen to cover,
 * which for match_events was ONE DAY out of a three-week archive. The record book then computed its
 * streak and timing records from that day alone: records set earlier were invisible, worse numbers
 * held them, and because the window slides as new matches land, a standing record could vanish
 * without anybody having beaten it.
 *
 * Raise this only to match a raised server setting. Setting it higher than the server's own cap
 * puts the silent truncation straight back, because a short page is this loop's stop condition.
 */
const PAGE_SIZE = 1000;

/**
 * Reads a whole table the caller's way, a page at a time.
 *
 * Sorted by `finished_at` descending like every caller wants, but with `id` as a tiebreak, and that
 * second key is load-bearing rather than tidiness: every row archived from one match shares one
 * `finished_at`, so on ties alone Postgres is free to order two pages inconsistently and paging
 * would then duplicate some rows and skip others. Breaking ties on the primary key makes the total
 * order stable, so page boundaries land in the same place every time.
 *
 * That tiebreak survives `id` being dropped from `columns`, which is not a contradiction: PostgREST
 * sorts on any column of the table, not merely the projected ones. Dropping it is worth more than
 * its 36 characters suggest - a uuid is random, so it is the one field in these rows gzip cannot
 * compress at all, and it was about a third of the compressed weight of every stats feed here.
 *
 * Stops on a short page, on an error (returning what it has - a partial book beats a blank one),
 * and at `limit`, which is the caller's ceiling rather than the server's.
 */
async function fetchAllRows<T>(
  table: string,
  columns: string,
  limit: number,
  /**
   * An optional `column = value` narrowing, applied server-side.
   *
   * The three whole-archive feeds pass nothing and read everything, as they always have. It exists
   * for fetchPlayerEvents, which wants one person's shots and should not have to download the
   * other ten thousand to find them.
   */
  match?: { column: string; value: string }
): Promise<T[]> {
  const out: T[] = [];

  while (out.length < limit) {
    const size = Math.min(PAGE_SIZE, limit - out.length);
    const base = supabase
      .from(table)
      .select(columns)
      .order("finished_at", { ascending: false })
      .order("id", { ascending: false });
    const { data, error } = await (match ? base.eq(match.column, match.value) : base).range(
      out.length,
      out.length + size - 1
    );

    // A filter naming a column the database does not have errors here rather than throwing, which
    // is what lets fetchPlayerEvents treat an unapplied migration as an empty result and fall back.
    if (error || !data) break;
    out.push(...(data as T[]));
    if (data.length < size) break; // the last page, so there is nothing after it
  }

  return out;
}

/*
 * -- Why every column below is written out ---------------------------------------------------------
 *
 * These three feeds are the heaviest reads on the site by a wide margin, and four pages read them
 * in full. `select()` with no list fetches every column of every row, and the archive only grows:
 * each finished match adds ~120 event rows, so an unnarrowed feed makes every page load on the site
 * permanently more expensive than the last.
 *
 * The lists are therefore explicit, and each was traced to a consumer before it was written down.
 * Nothing here is guessed at, and nothing is dropped for looking unused: `user_id` on an event row
 * reads as redundant beside the nickname and is not - recordBook keys careers on it - and
 * `square_set` costs almost nothing while deciding which tab a match appears under.
 *
 * What IS dropped is `id`, on all three, which nothing downstream of these functions reads; and on
 * events the three board-source columns, which move to the view read below.
 */

/** Fields the placement heatmap, the Almanac and archived-match reconstruction read off a fleet row. */
const FLEET_COLUMNS = "match_key,team,board_size,placements,ship_defs,room_id,finished_at,square_set";

/**
 * Fields the stats read off an event row.
 *
 * Deliberately without `room_id`, `board_seed` and `board_perm`. All three describe the MATCH rather
 * than the shot, every consumer already reads them one-per-match, and carrying them on every row was
 * about 660 KB of every Almanac, Leaderboard and PlayerStats load. They are read once per match from
 * `match_board_sources` and put back on the rows below - see fetchMatchEvents.
 */
const EVENT_COLUMNS =
  "match_key,user_id,nickname,team,cell_index,challenge_name,result,match_seconds,board_size,finished_at,square_set,auto";

/** Fields careers, the leaderboard, captain cards and scouting read off a participation row. */
const PARTICIPANT_COLUMNS =
  "match_key,user_id,nickname,team,won,draw,shots,hits,misses,sunk,team_ships_lost,awards,room_code,finished_at,square_set";

// The cache these three feeds share with the history list lives in lib/archiveCache.

/**
 * Every match's board source, one row each.
 *
 * A view over the same `match_events` rows the perm used to be read off, so it cannot disagree with
 * them - see the match_board_sources migration for why a view and not a table.
 *
 * Failure is swallowed, and deliberately: an un-migrated project has no such view, and the only
 * consequence is that unfired squares cannot be reconstructed, which is a case the Almanac has
 * always had to handle anyway (see bossFrequency, which then counts only what was fired at).
 */
async function fetchBoardSources(): Promise<Map<string, BoardSource>> {
  const { data, error } = await supabase
    .from("match_board_sources")
    .select("match_key,room_id,board_seed,board_perm");
  if (error || !data) return new Map();
  return new Map((data as BoardSource[]).map((r) => [r.match_key, r]));
}

/**
 * The three stats feeds, and the one thing they all do before returning.
 *
 * Everything the site counts is built from these: careers and the leaderboard from participants,
 * pace and the record book and the boss stats from events, the hiding-place heatmap from fleets.
 * That makes them the one place a voided match has to be dropped - see lib/voidedMatches. The
 * archive's own readers (fetchArchivedMatches, fetchArchivedMatch in lib/matchArchive) deliberately
 * do NOT filter: a voided match keeps its recap page and its line in the history list.
 */
export async function fetchMatchFleets(limit = 5000) {
  return cached("fleets", async () => {
    const rows = await fetchAllRows<{ match_key: string }>("match_fleets", FLEET_COLUMNS, limit);
    return (await withoutVoided(rows)) as never[];
  });
}

export async function fetchMatchEvents(limit = 50000) {
  return cached("events", async () => {
    const [rows, sources] = await Promise.all([
      fetchAllRows<{ match_key: string; challenge_name?: string | null }>("match_events", EVENT_COLUMNS, limit),
      fetchBoardSources(),
    ]);

    // Square renames folded and board sources put back, in the one function the battle-ratings Edge
    // Function also runs - see lib/battleRatingBoards.
    return prepareEvents(await withoutVoided(rows), sources) as never[];
  });
}

/**
 * One player's shots, and the reason the career page is no longer the most expensive page here.
 *
 * -- What it replaces --------------------------------------------------------------------------
 *
 * fetchMatchEvents(), filtered in the browser. Every one of the five panels a career page draws -
 * playerPace, squarePace, playerBestKills, playerKills and the match list - takes the player's key
 * and reads only rows belonging to it, so the whole global log was being downloaded to be thrown
 * away. `participant_key` is a generated column carrying exactly the fold participantKey applies,
 * so the same narrowing now happens in Postgres - see the match_event_participant_key migration.
 *
 * -- The fallback, and why it is not paranoia ---------------------------------------------------
 *
 * An empty result falls back to the old whole-log read. Three different things produce one, and
 * the fallback is right for all three:
 *
 *   the migration is not applied   PostgREST rejects the unknown column, fetchAllRows breaks out
 *                                  with an error and returns nothing. So this file is safe to ship
 *                                  ahead of the migration, and safe against a rollback.
 *   the folds disagree             `btrim` is ASCII-only where JavaScript's `.trim()` is not. A
 *                                  nickname with an exotic space folds differently in the two
 *                                  places, and the visitor gets a correct page at the old price.
 *   the player really has none     a captain who has never fired. The fallback costs one read and
 *                                  finds nothing either, which is the honest answer.
 *
 * -- What it does NOT fetch ---------------------------------------------------------------------
 *
 * Board sources. fetchMatchEvents attaches room_id, board_seed and board_perm to every row for the
 * Almanac's sake - a per-match read of its own, and the perms are the largest thing in it. Not one
 * of the five career panels looks at them, so they are not fetched. A consumer that grows a need
 * for them must say so here rather than discover them by accident.
 */
export async function fetchPlayerEvents(key: string, limit = 50000) {
  const own = await cached(`events:${key}`, async () => {
    const rows = await fetchAllRows<{ match_key: string; challenge_name?: string | null }>(
      "match_events",
      EVENT_COLUMNS,
      limit,
      { column: "participant_key", value: key }
    );
    // Same rename fold and same voided-match drop as the global feed, so the two describe a match
    // identically and a career page cannot disagree with the Almanac about what happened in it.
    return (await withoutVoided(rows)).map((r) => ({
      ...r,
      challenge_name: canonicalSquareName(r.challenge_name),
    })) as never[];
  });
  if (own.length > 0) return own;

  const all = (await fetchMatchEvents(limit)) as unknown as { user_id: string | null; nickname: string }[];
  return all.filter((e) => participantKey(e) === key) as never[];
}

/**
 * The board each of these matches was played on, as a boardShapeKey ("10|5,4,3,3,2"), from
 * match_fleets - for the career page's "Single-game bests", which only compares like with like.
 *
 * Asked for by key, in chunks, rather than through fetchMatchFleets: that feed carries every fleet's
 * placements, which is most of its weight and none of this. Every fleet in a match shares the room's
 * one ship_defs, so the first row per match is the match.
 */
export async function fetchMatchBoards(matchKeys: string[]): Promise<Map<string, string>> {
  const keys = [...new Set(matchKeys)];
  const CHUNK = 100; // match keys are ~40 characters; this keeps the URL well under any proxy's limit
  const out = new Map<string, string>();
  await Promise.all(
    Array.from({ length: Math.ceil(keys.length / CHUNK) }, async (_, i) => {
      const { data } = await supabase
        .from("match_fleets")
        .select("match_key,board_size,ship_defs")
        .in("match_key", keys.slice(i * CHUNK, (i + 1) * CHUNK));
      for (const r of (data ?? []) as { match_key: string; board_size: number; ship_defs: { size: number }[] | null }[]) {
        if (!out.has(r.match_key)) out.set(r.match_key, boardShapeKey(r.board_size, r.ship_defs));
      }
    })
  );
  return out;
}

/** Participation rows, newest first. The whole career table is small enough to aggregate client-side. */
export async function fetchParticipants(limit = 20000): Promise<ParticipantRow[]> {
  return cached("participants", async () => {
    return prepareParticipants(
      await withoutVoided(await fetchAllRows<ParticipantRow>("match_participants", PARTICIPANT_COLUMNS, limit))
    );
  });
}
