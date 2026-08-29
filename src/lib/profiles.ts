import { supabase } from "./supabase";
import { canonicalSquareName } from "./squareSetFormat";
import type { ParticipantRow } from "./careerStats";
import { withoutVoided } from "./voidedMatches";

export interface Profile {
  id: string;
  twitch_id: string | null;
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

export async function fetchProfile(id: string): Promise<Profile | null> {
  const { data, error } = await supabase.from("profiles").select().eq("id", id).maybeSingle();
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
}

export async function fetchProfiles(ids: string[]): Promise<Map<string, Profile>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.from("profiles").select().in("id", unique);
  if (error || !data) return new Map();
  return new Map((data as Profile[]).map((p) => [p.id, p]));
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
async function fetchAllRows<T>(table: string, columns: string, limit: number): Promise<T[]> {
  const out: T[] = [];

  while (out.length < limit) {
    const size = Math.min(PAGE_SIZE, limit - out.length);
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("finished_at", { ascending: false })
      .order("id", { ascending: false })
      .range(out.length, out.length + size - 1);

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
  "match_key,user_id,nickname,team,cell_index,challenge_name,result,match_seconds,board_size,finished_at,square_set";

/** Fields careers, the leaderboard, captain cards and scouting read off a participation row. */
const PARTICIPANT_COLUMNS =
  "match_key,user_id,nickname,team,won,draw,shots,hits,misses,sunk,team_ships_lost,awards,room_code,finished_at,square_set";

/**
 * How long a fetched feed is reused before it is read again.
 *
 * The archive is immutable apart from one event - a match ending - so the only thing a cache here
 * can get wrong is being a few minutes late to a match that has just been archived, and
 * `clearArchiveCache` covers the case where this tab is the one that archived it.
 *
 * What it buys is the whole reason it exists: Almanac, Leaderboard and PlayerStats each read the
 * same feeds on mount, so a visitor who looks at all three used to download the entire archive
 * three times over. Five minutes comfortably covers somebody clicking between them, and expires
 * well inside the pace matches actually finish at.
 */
const ARCHIVE_CACHE_MS = 5 * 60 * 1000;

const archiveCache = new Map<string, { at: number; rows: Promise<unknown[]> }>();

/**
 * The cached read, or a fresh one.
 *
 * Caches the PROMISE rather than the rows, so the two fetches Leaderboard and PlayerStats kick off
 * in the same tick share one request instead of both missing and both going to the network - the
 * same reason fetchVoidedMatches holds a promise rather than a Set.
 *
 * A read that fails or comes back empty is evicted rather than kept, so a network blip costs one
 * page load rather than five minutes of a site that believes it has no history.
 */
function cached<T>(key: string, read: () => Promise<T[]>): Promise<T[]> {
  const hit = archiveCache.get(key);
  if (hit && Date.now() - hit.at < ARCHIVE_CACHE_MS) return hit.rows as Promise<T[]>;

  const rows = read().then(
    (r) => {
      if (r.length === 0) archiveCache.delete(key);
      return r;
    },
    (e) => {
      archiveCache.delete(key);
      throw e;
    }
  );
  archiveCache.set(key, { at: Date.now(), rows: rows as Promise<unknown[]> });
  return rows;
}

/** Forgets every cached feed, so a tab that has just archived a match sees it in the stats. */
export function clearArchiveCache(): void {
  archiveCache.clear();
}

/** The room, seed and balancer permutation one match's squares were dealt from. */
export interface BoardSource {
  match_key: string;
  room_id: string | null;
  board_seed: string | null;
  board_perm: number[] | null;
}

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

    // Rows archived before a square was renamed still carry its old name. Folded here rather than in
    // each of the several things that group on it - see canonicalSquareName.
    //
    // The board source is put back onto every row in the same pass, because the row is where every
    // consumer already looks for it and this is not the place to teach them otherwise. It costs
    // nothing to hold: all ~120 rows of a match are handed the SAME perm array by reference, which
    // is the arrangement the wire could not express and the whole reason it was sent 120 times.
    return (await withoutVoided(rows)).map((r) => {
      const source = sources.get(r.match_key);
      return {
        ...r,
        challenge_name: canonicalSquareName(r.challenge_name),
        room_id: source?.room_id ?? null,
        board_seed: source?.board_seed ?? null,
        board_perm: source?.board_perm ?? null,
      };
    }) as never[];
  });
}

/** Participation rows, newest first. The whole career table is small enough to aggregate client-side. */
export async function fetchParticipants(limit = 20000): Promise<ParticipantRow[]> {
  return cached("participants", async () => {
    const rows = await withoutVoided(
      await fetchAllRows<ParticipantRow>("match_participants", PARTICIPANT_COLUMNS, limit)
    );
    return rows.map((r) => ({ ...r, awards: Array.isArray(r.awards) ? r.awards : [] }));
  });
}
