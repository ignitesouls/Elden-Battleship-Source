import { useEffect, useRef } from "react";
import { supabase } from "./supabase";
import type { ShipPlacement } from "../types/battleship";

/**
 * Letting a crew watch their captain lay the fleet out, before any of it is confirmed.
 *
 * -- Why this goes through the database ----------------------------------------------------------
 *
 * Where a fleet's hulls are is the one secret the whole game rests on, so the route the layout
 * travels by is really a question of who can read it. Writing it straight onto the team's own
 * `fleets` row answers that with something already load-bearing: RLS scopes that row to the owning
 * team (plus spectators, who can see every fleet anyway), the crew are already subscribed to it over
 * realtime, and an opponent asking for it is refused by Postgres rather than by our good manners.
 * No new table, no new policy, no channel anyone could guess the name of.
 *
 * It survives a refresh as a side effect, which is worth having on its own: a captain who reloads
 * mid-placement used to lose every ship they had put down.
 *
 * The road not taken was a Realtime broadcast channel (the caster relay in lib/overlayCast is one),
 * which could also have carried the hover ghost - the hull sliding under the captain's cursor before
 * they commit it. Two reasons it isn't here. Broadcast is not protected by RLS and the only channel
 * name available is derived from a room id and a team number, both of which every opponent in the
 * room already has; and it is the expensive kind of feature, billed per message per subscriber, with
 * a pointer emitting events per display refresh. A crew sees each ship the moment it lands instead,
 * which is the part that was actually missing.
 */

/** Debounce on draft writes, so holding R through a few rotations is one UPDATE and not four. */
const DRAFT_DEBOUNCE_MS = 300;

/** Compact identity of a layout, for "has this actually changed since we last wrote it". */
function layoutKey(placements: ShipPlacement[]): string {
  return placements
    .map((p) => `${p.shipIndex}:${p.startRow}:${p.startCol}:${p.isHorizontal ? "h" : "v"}`)
    .sort()
    .join("|");
}

/**
 * Writes the captain's in-progress layout to their team's fleet row.
 *
 * Only `placements` - deliberately NOT the grids that submitPlacement() writes. Those are what
 * incoming fire is resolved against, and a half-built fleet has no business being shootable. The
 * battle cannot start until every team confirms, and confirming rewrites all of it, so the grids
 * being stale until that moment is exactly right.
 *
 * The captain-only rule is the database's (see guard_fleet_placement in the fleet_captains
 * migration), which is why this doesn't check it.
 */
export async function saveDraftPlacements(
  roomId: string,
  team: number,
  placements: ShipPlacement[]
): Promise<void> {
  const { error } = await supabase
    .from("fleets")
    .update({ placements })
    .eq("room_id", roomId)
    .eq("team", team);
  if (error) throw error;
}

/**
 * Keeps the fleet row in step with the captain's local layout while they work.
 *
 * `serverPlacements` is what the row already held when this mounted, so adopting an existing draft
 * doesn't immediately write it straight back.
 */
export function usePlacementDraftSync(
  roomId: string,
  team: number,
  placements: ShipPlacement[],
  enabled: boolean,
  serverPlacements: ShipPlacement[] | null
): void {
  const lastWritten = useRef("");

  useEffect(() => {
    if (!enabled) return;
    const key = layoutKey(placements);

    // Already what the row holds - which covers adopting an existing draft on mount, and the
    // moment our own write comes back to us over realtime.
    if (key === layoutKey(serverPlacements ?? [])) {
      lastWritten.current = key;
      return;
    }
    // Sent, and the row simply hasn't caught up yet. Without this an unrelated re-render mid-write
    // (a crewmate joining, the roster updating) would queue the identical UPDATE a second time.
    if (key === lastWritten.current) return;

    const timer = setTimeout(() => {
      // Claimed before the await so a second edit landing mid-flight doesn't queue the same write
      // twice; released again on failure so the next edit retries rather than the draft silently
      // stopping.
      lastWritten.current = key;
      saveDraftPlacements(roomId, team, placements).catch((e) => {
        lastWritten.current = "";
        // Nothing actionable for the captain: their own board is unaffected and confirming writes
        // the layout properly. The only casualty is the crew's live view of it.
        console.warn("Could not share the in-progress layout with the crew.", e);
      });
    }, DRAFT_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [enabled, roomId, team, placements, serverPlacements]);
}
