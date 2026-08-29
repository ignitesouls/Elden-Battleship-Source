import { supabase, isSupabaseConfigured } from "./supabase";
import type { ShipPlacement } from "../types/battleship";

export interface OverlayFleet {
  team: number;
  placements: ShipPlacement[];
  shipSunk: boolean[];
}

/**
 * Fetches the fleet belonging to the player who owns this overlay, via the `overlay_fleet` RPC.
 *
 * The overlay runs as a fresh anonymous session that belongs to no team, so RLS hands it nothing
 * from `fleets` directly - see the migration for why the rejoin code is the credential here.
 *
 * Returns null for anything unexpected rather than throwing. A stale code, an unapplied
 * migration, or a player who hasn't picked a fleet yet all mean the same thing to the caller:
 * no ships to draw. An overlay that throws is a dead rectangle on someone's stream, and the
 * spoiler-free layout is a perfectly good thing to fall back to.
 */
export async function fetchOverlayFleet(
  roomCode: string,
  rejoinCode: string
): Promise<OverlayFleet | null> {
  if (!isSupabaseConfigured || !roomCode || !rejoinCode) return null;

  const { data, error } = await supabase.rpc("overlay_fleet", {
    p_room_code: roomCode,
    p_rejoin_code: rejoinCode,
  });

  if (error) {
    // Most likely cause by far is the migration not being applied yet, which is worth saying out
    // loud in the console - it's otherwise indistinguishable from a wrong code.
    console.warn("[overlay] could not load fleet:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.team !== "number") return null;

  return {
    team: row.team,
    placements: Array.isArray(row.placements) ? (row.placements as ShipPlacement[]) : [],
    shipSunk: Array.isArray(row.ship_sunk) ? (row.ship_sunk as boolean[]) : [],
  };
}

/**
 * The same fleet, for a persistent overlay: resolved from the owner's overlay token instead.
 *
 * -- Why this exists rather than reusing the call above -------------------------------------------
 *
 * fetchOverlayFleet needs a room code and a rejoin code, and the rejoin code is a bearer credential
 * that hands its holder the SEAT - claim_player_slot will re-point the player row at whoever redeems
 * it. Today that is tolerable because the streamer copies that URL themselves, once, and the box
 * warns them in red not to share it.
 *
 * A persistent scene is a different bargain. The URL goes into a scene-collection file that gets
 * exported, traded between co-streamers, and pasted into support threads, and it stays valid for a
 * season rather than for a match. Putting a seat-stealing credential in there and hoping nobody ever
 * shares the file is not a security model.
 *
 * So the token does the work: overlay_token_fleet resolves the player AND their current room
 * server-side, and returns nothing but the ships. It is read-only by construction - see the CRITICAL
 * note in the migration about why it must never learn to call claim_player_slot.
 *
 * Fails soft for the same reason as its sibling: a stale token or an unapplied migration means "no
 * ships to draw", and the spoiler-free layout is a perfectly good thing to fall back to.
 */
export async function fetchOverlayFleetByToken(token: string): Promise<OverlayFleet | null> {
  if (!isSupabaseConfigured || !token) return null;

  const { data, error } = await supabase.rpc("overlay_token_fleet", { p_token: token });

  if (error) {
    console.warn("[overlay] could not load fleet by token:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.team !== "number") return null;

  return {
    team: row.team,
    placements: Array.isArray(row.placements) ? (row.placements as ShipPlacement[]) : [],
    shipSunk: Array.isArray(row.ship_sunk) ? (row.ship_sunk as boolean[]) : [],
  };
}

export { shipCellIndices } from "./shipCells";
