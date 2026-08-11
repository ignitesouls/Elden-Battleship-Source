import type { RoomStatus } from "../types/battleship";

/**
 * Whether a square's writing may be drawn yet.
 *
 * The players' own boards are BLANK until the shooting starts: PlacementPhase renders its grid
 * with no cellText at all, so a captain lays their fleet out on unlabelled water and has to commit
 * before learning which square is which. That is the whole shape of the placement decision.
 *
 * The overlay routes were reading the squares straight out of challengesForRoom and drawing them
 * from the moment the URL was pasted in, which handed that decision back: open your own board
 * source in a browser tab during placement and every name is sitting there, so you can park a hull
 * on the squares nobody sane will shoot first. It didn't even need a stream to abuse - the source
 * URL is a page like any other.
 *
 * So the overlays follow the same rule the boards do. Names, and the colour key that goes with
 * them, appear when the room reaches `battle` and stay up through `finished` for the recap.
 *
 * Note this is not a secret being kept: the squares are derived from the room id, set and seed,
 * all of which any player can read. It is a rule about when the game shows them - the same kind of
 * rule as not dealing the flop before the betting. Making it hard to do by accident, and obvious
 * when done on purpose, is the job.
 */
export function squaresRevealed(status: RoomStatus | undefined): boolean {
  return status === "battle" || status === "finished";
}
