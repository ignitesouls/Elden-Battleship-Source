import type { ShipDefinition } from "../types/battleship";

/** One hull, paired with where it sits in the room's `ship_defs`. */
export interface FleetHull {
  /**
   * The hull's index in `ship_defs` - NOT its position in this list.
   *
   * Everything that says something about a particular ship is keyed on this: `ShipPlacement.
   * shipIndex`, every `ship_sunk` / `sunkHulls` array, `shipIndexGrid`. A roster that sorted the
   * defs and then read `sunkHulls[i]` off the sorted position would strike through whichever hull
   * happened to land where the dead one used to be, so the index travels with the def.
   */
  index: number;
  def: ShipDefinition;
}

/**
 * A fleet in reading order: longest hull first.
 *
 * `ship_defs` is in DEALT order, which is the order fleetFor() laid the pattern down and the order
 * placement asks for them. On the classic 5-4-3-3-2 that already reads as biggest-first, but the
 * pattern cycles on anything busier - an Armada board deals 5-4-3-3-2-5-4-3-3-2, so a roster
 * following it lists two Carriers a column apart with everything else interleaved between. Nobody
 * reads a fleet that way. Sorted, the same roster groups the classes together and answers "what
 * have they got left" top to bottom.
 *
 * Ties keep dealt order, so a pair of 3s still reads "Cruiser, Submarine" rather than flipping
 * about between renders.
 */
export function fleetByLength(shipDefs: ShipDefinition[]): FleetHull[] {
  return shipDefs
    .map((def, index) => ({ def, index }))
    .sort((a, b) => b.def.size - a.def.size || a.index - b.index);
}
