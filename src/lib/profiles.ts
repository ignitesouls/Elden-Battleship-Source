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
 * Stops on a short page, on an error (returning what it has - a partial book beats a blank one),
 * and at `limit`, which is the caller's ceiling rather than the server's.
 */
async function fetchAllRows<T>(table: string, limit: number): Promise<T[]> {
  const out: T[] = [];

  while (out.length < limit) {
    const size = Math.min(PAGE_SIZE, limit - out.length);
    const { data, error } = await supabase
      .from(table)
      .select()
      .order("finished_at", { ascending: false })
      .order("id", { ascending: false })
      .range(out.length, out.length + size - 1);

    if (error || !data) break;
    out.push(...(data as T[]));
    if (data.length < size) break; // the last page, so there is nothing after it
  }

  return out;
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
  const rows = await fetchAllRows<{ match_key: string }>("match_fleets", limit);
  return (await withoutVoided(rows)) as never[];
}

export async function fetchMatchEvents(limit = 50000) {
  const rows = await fetchAllRows<{ match_key: string; challenge_name?: string | null }>("match_events", limit);
  // Rows archived before a square was renamed still carry its old name. Folded here rather than in
  // each of the several things that group on it - see canonicalSquareName.
  return (await withoutVoided(rows)).map((r) => ({
    ...r,
    challenge_name: canonicalSquareName(r.challenge_name),
  })) as never[];
}

/** Participation rows, newest first. The whole career table is small enough to aggregate client-side. */
export async function fetchParticipants(limit = 20000): Promise<ParticipantRow[]> {
  const rows = await withoutVoided(await fetchAllRows<ParticipantRow>("match_participants", limit));
  return rows.map((r) => ({ ...r, awards: Array.isArray(r.awards) ? r.awards : [] }));
}
