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

export { shipCellIndices } from "./shipCells";
