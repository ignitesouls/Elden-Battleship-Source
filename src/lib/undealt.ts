import { squareSet, squareTitle, buildFlatBoard, maxBoardSize, type Challenge, type SquareSetId } from "./squareSets";
import { dealSeed } from "./challenges";
import { dealtPool } from "./squareSetFormat";

/**
 * How close to a set's ceiling a board has to be before the squares it left out are worth naming.
 *
 * One size. "Which bosses missed the cut" is a real question at 14x14, where ten of the 206 stay in
 * the pack and knowing them tells a crew what the board cannot ask of them. Two sizes down it is a
 * different question wearing the same words: an 11x11 boss board leaves 85 out, which is not a list
 * anybody reads, it is the pack with a hole in it.
 *
 * So this gates the feature EXISTING rather than thresholding when it opens. Below it there is no
 * card and no tab at all, because an affordance whose only outcome is a wall of text is worse than
 * no affordance.
 */
const NEAR_CEILING = 1;

/**
 * Whether this board is close enough to its set's ceiling to be asked what it left out.
 *
 * Flat sets only, and that is the format's doing rather than a shortcut. A flat set deals verbatim
 * names, so a square it never dealt still has text to print. A bingo set picks through category
 * limits and resolves `%variables%` at deal time, which means a square it passed over was never
 * resolved into anything - "Kill %n% Bosses" is a template, not something a crew could have been
 * sent to do. Printing those would be naming squares that do not exist.
 */
export function undealtOffered(boardSize: number, setId: SquareSetId | null | undefined): boolean {
  const set = squareSet(setId);
  if (set.format !== "flat") return false;
  return boardSize >= maxBoardSize(set) - NEAR_CEILING;
}

/**
 * The squares this room's deal left in the pack: everything its set holds that the board has no
 * cell for.
 *
 * Read out of the same shuffle the board itself came from, rather than reconstructed by diffing
 * names against a rebuilt board. buildFlatBoard shuffles the WHOLE list and then takes the first
 * `count` of it, so asking it for a board of `data.length` cells hands back that entire permutation
 * - the dealt squares are its head and these are its tail. One shuffle, one seed, one function: the
 * two answers cannot disagree, which a name-diff could quietly start doing the day a set grew two
 * entries sharing a name.
 *
 * Takes no `board_perm` on purpose. The balancer reorders which cell shows which square and never
 * re-picks the squares themselves (see challengesForRoom), so what stays in the pack is the same
 * before and after it runs - and a perm parameter here would imply otherwise.
 *
 * Empty for every bingo set, and empty for a board with a cell for everything. undealtOffered says
 * which boards should be ASKING; this only answers.
 */
export function undealtSquares(
  roomId: string,
  count: number,
  setId: SquareSetId | null | undefined,
  seed?: string | null,
  /** When the board was dealt. A square added to the set after that was never in this pack. */
  dealtAt?: string | null
): Challenge[] {
  const set = squareSet(setId);
  if (set.format !== "flat") return [];
  const pack = dealtPool(set.data, dealtAt);
  if (pack.length <= count) return [];
  return (
    buildFlatBoard(pack, pack.length, dealSeed(roomId, setId, seed))
      .slice(count)
      // Titled here for the reason the board is titled at the end of its own deal: how a square
      // reads to a person depends on which set it came from, and this is the last point that knows.
      // On the boss board that turns "LG Tree Sent" into "Tree Sentinel - Church of Elleh", which is
      // the form somebody can actually check against what they remember killing.
      .map((c) => ({ ...c, title: squareTitle(c, set) }))
  );
}
