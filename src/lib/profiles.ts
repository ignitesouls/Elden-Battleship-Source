import { supabase } from "./supabase";
import type { ParticipantRow } from "./careerStats";

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

export async function fetchMatchFleets(limit = 1000) {
  const { data, error } = await supabase
    .from("match_fleets")
    .select()
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as never[];
}

export async function fetchMatchEvents(limit = 5000) {
  const { data, error } = await supabase
    .from("match_events")
    .select()
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as never[];
}

/** Recent participation rows, newest first. The whole career table is small enough to aggregate client-side. */
export async function fetchParticipants(limit = 2000): Promise<ParticipantRow[]> {
  const { data, error } = await supabase
    .from("match_participants")
    .select()
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as ParticipantRow[]).map((r) => ({ ...r, awards: Array.isArray(r.awards) ? r.awards : [] }));
}
