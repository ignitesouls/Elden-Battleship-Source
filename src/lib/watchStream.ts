import { supabase, isSupabaseConfigured } from "./supabase";
import type { SeatRoomStatus } from "../hooks/useFollowedSeat";
import type { ShipPlacement } from "../types/battleship";

/**
 * The streamer's watch link: one public URL that always shows the match they are in right now, from
 * their seat and no other.
 *
 * -- What this is for ----------------------------------------------------------------------------
 *
 * A streamer's audience has had exactly one way in: the room link with ?spectate=1 on it. It goes
 * stale every match, so it cannot live in a Twitch panel or behind a !watch command - and following
 * it joins the room, which hands every viewer the other crew's ship positions. The full argument is
 * in the migration; the short version is that a room link is the wrong shape for an audience twice
 * over, and this is the right one.
 *
 * -- Why there is no credential here -------------------------------------------------------------
 *
 * Every other cross-match identity on the site is a secret: the ingest token fires shots, the rejoin
 * code hands over the seat, the overlay token unlocks the owner's fleet. This one is the opposite by
 * design. It is meant to be broadcast - pasted into a panel, said out loud on stream - so there is
 * nothing to protect and no reason for it to be a random string. It is the streamer's Twitch name,
 * which their viewers already know how to type, and which is unique and URL-safe because Twitch
 * makes it so.
 *
 * What keeps it safe is not secrecy but reach. A watch handle resolves to a room code, a status, a
 * team and a name. It grants no writes, cannot be redeemed for a seat, is accepted by no gameplay
 * path, and - unless its owner has deliberately said otherwise - will not return a fleet to anybody.
 *
 * -- Why the viewer never joins ------------------------------------------------------------------
 *
 * The page reads only tables that are already world-readable. It does not write a `players` row, and
 * that omission IS the feature: `fleets` and `square_counts` are both gated on the existence of a
 * spectator row in that room, so a viewer who never takes a seat cannot read either one no matter
 * what they type into a console. "No option to see both sides" is a property of the schema here,
 * not a rule in a component.
 */

/** Which match the handle's owner is in right now, resolved fresh on every call. */
export interface WatchSession {
  /** The room they are seated in, or null when they are in none. */
  roomCode: string | null;
  status: SeatRoomStatus | null;
  /**
   * The fleet they are on, or null when they are spectating rather than playing.
   *
   * A null team is not an error and not an empty state: a streamer who is casting rather than
   * playing has no crew to ride with, and the page says so instead of drawing a board for nobody.
   */
  team: number | null;
  /**
   * Their auth id, so the page can watch their seat for changes without polling - see
   * useFollowedSeat. Not new exposure: `players` is world-readable and carries this column already.
   */
  userId: string;
  /** What to call them at the top of the page - their nickname, or their Twitch name. */
  streamerName: string | null;
  /** Whether they have opted into their own hulls being drawn. See the note on fetchWatchFleet. */
  showFleet: boolean;
}

/**
 * The address, re-exported.
 *
 * It lives in ./watchLink so a check script can reach it without dragging the supabase client into
 * Node - and, more to the point, so there is a place to assert that this URL never grows a query
 * string. See the note at the top of that file. Re-exported here because a caller wanting "the watch
 * link" should not have to know which half of it is browser-only.
 */
export { normalizeHandle, watchUrl, WATCH_ROUTE } from "./watchLink";
import { normalizeHandle } from "./watchLink";

/**
 * handle -> the match its owner is in, right now.
 *
 * Returns null for anything unexpected rather than throwing, the way the overlay resolver does. An
 * unknown handle, an unapplied migration and a mistyped URL all mean one thing to the page, and that
 * thing is "there is nobody here" - which it can say far better than an error boundary can.
 *
 * A REAL handle whose owner is between matches is emphatically not that case: it comes back with a
 * null `roomCode`, and the page waits, because a viewer who followed the link five minutes early
 * should not have to refresh when the match starts.
 */
export async function resolveWatchSession(handle: string): Promise<WatchSession | null> {
  if (!isSupabaseConfigured || !handle) return null;

  const { data, error } = await supabase.rpc("watch_session", { p_handle: normalizeHandle(handle) });
  if (error) {
    // By far the most likely cause is the migration not being applied yet, which is worth saying out
    // loud - it is otherwise indistinguishable from a handle that does not exist.
    console.warn("[watch] could not resolve handle:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  // No row at all means no such streamer. A row with a null room means a real one who is not playing
  // - see the WatchSession note on why those two must not collapse together.
  if (!row || typeof row.user_id !== "string") return null;

  return {
    roomCode: typeof row.room_code === "string" ? row.room_code : null,
    status: typeof row.room_status === "string" ? (row.room_status as SeatRoomStatus) : null,
    team: typeof row.team === "number" ? row.team : null,
    userId: row.user_id as string,
    streamerName: typeof row.display_name === "string" ? row.display_name : null,
    showFleet: row.show_fleet === true,
  };
}

/** The ships the watch page may draw, which is only ever the streamer's own and only with consent. */
export interface WatchFleet {
  team: number;
  placements: ShipPlacement[];
}

/**
 * handle -> the streamer's ships, if and only if they have said yes.
 *
 * The consent lives in the database (`profiles.watch_show_fleet`, checked inside
 * `watch_handle_fleet`), not here. That is deliberate and it is the only arrangement that means
 * anything: the anonymous key ships in the JS bundle, so a check that lived in this file could be
 * skipped by calling the RPC by hand. While the switch is off the function returns the empty set and
 * there is no argument that changes that.
 *
 * This page is public and permanent, so what the switch actually decides is whether the streamer's
 * OPPONENT can read their hulls - the opponent can follow the link like anybody else. It defaults
 * off, and the setup page says why in as many words.
 *
 * Fails soft, like every other fleet read: no ships is a perfectly good board. The second one still
 * shows every hit, miss and sinking that has landed on them.
 */
export async function fetchWatchFleet(handle: string): Promise<WatchFleet | null> {
  if (!isSupabaseConfigured || !handle) return null;

  const { data, error } = await supabase.rpc("watch_handle_fleet", { p_handle: normalizeHandle(handle) });
  if (error) {
    console.warn("[watch] could not load fleet:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.team !== "number") return null;

  return {
    team: row.team,
    placements: Array.isArray(row.placements) ? (row.placements as ShipPlacement[]) : [],
  };
}

/* -- the streamer's own end of it --------------------------------------------------------------- */

/** What the setup page needs to show somebody their own watch link and the switch under it. */
export interface MyWatchLink {
  /** Null for an account with no Twitch identity - an anonymous session has no permanent name. */
  handle: string | null;
  showFleet: boolean;
}

/**
 * The signed-in player's own handle and consent flag.
 *
 * Read off `profiles` directly rather than through an RPC: the row is world-readable already (the
 * leaderboard draws every one of them), and the only reason to ask for your own by id is to find out
 * what your link is.
 *
 * Returns null when nobody is signed in, which is also the answer for an anonymous session - and the
 * right one. A watch link is a permanent public address, and an anonymous account has neither half
 * of that.
 */
export async function fetchMyWatchLink(): Promise<MyWatchLink | null> {
  if (!isSupabaseConfigured) return null;

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("twitch_login,watch_show_fleet")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;

  return {
    handle: typeof data.twitch_login === "string" && data.twitch_login ? data.twitch_login : null,
    showFleet: data.watch_show_fleet === true,
  };
}

/**
 * Turns the streamer's own hulls on or off for their audience.
 *
 * The only half of this feature its owner can write. The handle itself is refused by a trigger -
 * see guard_twitch_login in the migration, and the note there about why squatting one would mean
 * serving your match at somebody else's address.
 *
 * Throws rather than swallowing: this is a switch about who can see the streamer's ships, and one
 * that silently failed to turn OFF would be the worst possible way for it to fail.
 */
export async function setWatchShowFleet(on: boolean): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error("Not signed in");

  const { error } = await supabase.from("profiles").update({ watch_show_fleet: on }).eq("id", userId);
  if (error) throw error;
}
