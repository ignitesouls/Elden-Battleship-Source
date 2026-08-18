import type { RoomStatus } from "../types/battleship";
import type { BattlePhaseName } from "./matchTime";

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
 * them, appear once the match clock is past its first window, and stay up through `finished` for
 * the recap.
 *
 * -- Why not the moment `battle` begins ----------------------------------------------------------
 *
 * Because the board is not finished being dealt then. The clock's first window - the one that reads
 * RANDOMIZATION - is where the squares are permuted against the fleets that have just gone down
 * (see lib/boardBalance.ts), and naming them across it would be showing a board mid-shuffle. Pass
 * the phase and they hold until PREPARATION, which is the window that exists for reading the board
 * in the first place. Callers with no clock to hand omit it and keep the old status-only rule.
 *
 * Note this is not a secret being kept: the squares are derived from the room id, set, seed and
 * permutation, all of which any player can read. It is a rule about when the game shows them - the
 * same kind of rule as not dealing the flop before the betting. Making it hard to do by accident,
 * and obvious when done on purpose, is the job.
 *
 * What IS genuinely unavailable now, rather than merely undrawn, is the board during placement:
 * until every fleet is confirmed there is no permutation to read, so a layout computed by peeking
 * mid-placement is guaranteed wrong on precisely the cells that decide the match.
 */
export function squaresRevealed(
  status: RoomStatus | undefined,
  phase?: BattlePhaseName | null
): boolean {
  if (status === "finished") return true;
  if (status !== "battle") return false;
  return phase !== "starting";
}
