import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * The persistent stream overlay: one token per player, and the sources an OBS scene is built from.
 *
 * -- What this is for ----------------------------------------------------------------------------
 *
 * Every overlay URL the site hands out names a room. That is right for what those sources are, and
 * it is also why a streamer edits seven Browser Sources before every match: the scene they arranged
 * is fine, and the URLs inside it went stale the moment the room changed.
 *
 * So there is a second way in. The token names the PLAYER; the room is resolved at read time from
 * the seat they are already sitting in (see the overlay_session RPC). The Browser Source URLs never
 * change, and one imported scene follows them from match to match, through lobbies and rematches,
 * for as long as they keep the token.
 *
 * -- The division of labour ----------------------------------------------------------------------
 *
 * Elden Battleship owns the DATA. OBS owns the LAYOUT. The scene this module describes is an
 * INITIAL arrangement and nothing more: once it is imported it belongs to the streamer, who will
 * move it, resize it, hide half of it and hang filters off the rest. Nothing here ever tries to
 * reach back into OBS and put it back. That is also why every element is its own Browser Source
 * rather than one page drawing the lot - a single source would be a scene the streamer cannot take
 * apart, which is the entire thing they want to do with it.
 *
 * -- Why a third credential ----------------------------------------------------------------------
 *
 * Not the ingest token, which fires shots, and not the rejoin code, which hands over the seat. A
 * Browser Source URL is about the least private string a streamer owns - it lives in scene exports
 * they trade with each other, in screen shares, and in any browser dock they happen to open. The
 * migration has the full argument; the short version is that this one is read-only and the worst it
 * can do is show someone an overlay they could have watched on the stream anyway.
 */

/** Where the room is in its life, as `rooms.status` spells it. */
export type OverlayRoomStatus = "lobby" | "placement" | "battle" | "finished";

/**
 * Which match the token's owner is in right now, resolved fresh on every call.
 *
 * A valid token always resolves to one of these, even when its owner is in no room at all - that is
 * the `roomCode: null` case, and it is the difference between "nobody is playing" (draw nothing, keep
 * watching) and a token that does not exist (resolveOverlaySession returns null outright).
 */
export interface OverlaySession {
  /** The room they are seated in, or null when they are in none. */
  roomCode: string | null;
  status: OverlayRoomStatus | null;
  /** The fleet they are on, or null for a spectator - which is what a caster is. */
  team: number | null;
  /**
   * Their auth id, so the overlay can watch its own seat for changes without polling.
   *
   * Not a secret and not new exposure: `players` is world-readable and carries this column already,
   * which is how every spectator in the room reads the roster. See useOverlayToken.
   */
  userId: string;
}

/* -- the token ---------------------------------------------------------------------------------- */

/**
 * Reads the signed-in player's overlay token, or null if they have never made one.
 *
 * Row-level security scopes this to the caller's own row, so there is no id to pass and no way to
 * read anybody else's. An anonymous session simply matches nothing - which is correct: a token that
 * outlives a browser's local storage is only meaningful for an account that does too.
 */
export async function fetchOverlayToken(): Promise<string | null> {
  const { data, error } = await supabase.from("overlay_tokens").select("token").maybeSingle();
  if (error) throw error;
  return data?.token ?? null;
}

/**
 * Mints one.
 *
 * The string comes from the database's `gen_random_bytes` default, not from here - one definition of
 * the format, and no dependence on how good a given browser's randomness happens to be. Same
 * arrangement as createIngestToken, deliberately.
 */
export async function createOverlayToken(): Promise<string> {
  const { data: session } = await supabase.auth.getUser();
  const userId = session.user?.id;
  if (!userId) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("overlay_tokens")
    .insert({ user_id: userId })
    .select("token")
    .single();
  if (error) throw error;
  return data.token as string;
}

/**
 * Rotates it, invalidating the old string immediately.
 *
 * Delete then insert rather than an update, so the replacement comes from the same database default
 * as the original. The unique constraint on user_id is what makes that safe: there is only ever one
 * row to replace, so a rotation can never leave a second token quietly still working in a scene
 * somebody forgot they had.
 *
 * Rotating costs the streamer a re-import, because every URL in their scene carries the old string.
 * The setup page says so before it does it.
 */
export async function rotateOverlayToken(): Promise<string> {
  const { data: session } = await supabase.auth.getUser();
  const userId = session.user?.id;
  if (!userId) throw new Error("Not signed in");

  const { error } = await supabase.from("overlay_tokens").delete().eq("user_id", userId);
  if (error) throw error;
  return createOverlayToken();
}

/** Revokes it outright. Every source pointed at it goes transparent; nothing else is affected. */
export async function revokeOverlayToken(): Promise<void> {
  const { data: session } = await supabase.auth.getUser();
  const userId = session.user?.id;
  if (!userId) throw new Error("Not signed in");

  const { error } = await supabase.from("overlay_tokens").delete().eq("user_id", userId);
  if (error) throw error;
}

/**
 * token -> the match its owner is in, right now.
 *
 * Returns null for anything unexpected rather than throwing, for the reason fetchOverlayFleet does:
 * a stale token, an unapplied migration, and a player who is simply not in a room all mean the same
 * thing to a browser source, and that thing is "draw nothing". An overlay that throws is a black
 * rectangle on somebody's stream.
 */
export async function resolveOverlaySession(token: string): Promise<OverlaySession | null> {
  if (!isSupabaseConfigured || !token) return null;

  const { data, error } = await supabase.rpc("overlay_session", { p_token: token });
  if (error) {
    // By far the most likely cause is the migration not being applied yet, which is worth saying out
    // loud - it is otherwise indistinguishable from a wrong token.
    console.warn("[overlay] could not resolve token:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  // No row at all means no such token. A row with a null room means a real token whose owner simply
  // is not in a match - see the OverlaySession note on why those two must not collapse together.
  if (!row || typeof row.user_id !== "string") return null;

  return {
    roomCode: typeof row.room_code === "string" ? row.room_code : null,
    status: typeof row.room_status === "string" ? (row.room_status as OverlayRoomStatus) : null,
    team: typeof row.team === "number" ? row.team : null,
    userId: row.user_id as string,
  };
}

/** Enough of the token to recognise it without putting the whole string on screen. Mirrors maskToken. */
export function maskOverlayToken(token: string): string {
  return token.length <= 12 ? token : `${token.slice(0, 6)}${"·".repeat(8)}${token.slice(-4)}`;
}

/**
 * The source catalogue and the URL builders, re-exported.
 *
 * They live in ./streamSources so a check script can reach them without dragging the supabase client
 * into Node - see the note at the top of that file. Re-exported here because a caller wanting "the
 * persistent overlay" should not have to know which half of it is browser-only.
 */
export {
  sourcesFor,
  streamSourceUrl,
  streamCastUrl,
  type StreamElement,
  type SceneKind,
  type StreamSource,
  type SceneSettings,
} from "./streamSources";
