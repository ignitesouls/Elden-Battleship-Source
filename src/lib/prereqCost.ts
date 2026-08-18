/**
 * Applying src/data/bossPrereqs.json to a dealt board.
 *
 * The cost table says how long a square takes; this says what that number is missing.
 *
 * -- What it corrects, and what it deliberately does not ------------------------------------------
 *
 * A measured time ALREADY contains the prerequisite work. Ymir's 86:10 was recorded in matches where
 * whoever got there had to kill Metyr first, so charging Metyr again on top would be counting the
 * same minutes twice. That is why this is a DISCOUNT and not a surcharge, which is the opposite of
 * what it looks like it should be.
 *
 * What the timings cannot know is when the prerequisite is free. Metyr is on the board perhaps one
 * time in five; on those boards somebody is going to Metyr anyway, and Ymir stops costing what the
 * archive says it costs. Nothing in a per-square average can express "cheaper today because of what
 * else got dealt", and it is exactly the case that decides whether a fleet is reachable.
 *
 * So: a prerequisite that is ALSO on the board discounts the square that needs it. A prerequisite
 * that is not on the board changes nothing, because the measurement already assumed that.
 *
 * -- Why this is safe to condition on ------------------------------------------------------------
 *
 * It reads the dealt board and nothing else - no fleet, no ship, no placement. Like the declumping
 * pass, it is a property of what everyone is about to look at, so it leaks nothing about where
 * anybody is hiding. The costs it produces are the same for both teams before either has placed.
 */

/** A prerequisite: a square name, a placeholder like "long run", or an OR-group of either. */
export type PrereqNode = string | PrereqNode[];

/** The shape of bossPrereqs.json. `_`-prefixed keys are the comment and the location rules. */
export interface PrereqTable {
  [key: string]: unknown;
}

/**
 * Placeholders that name no square.
 *
 * They are annotations rather than prerequisites - "this is far", "this fight is long" - and they
 * can never be satisfied by something on the board, so they never discount anything. Kept because
 * the ones the timings understate are exactly the ones a person can see and a measurement cannot;
 * see the notes in bossPrereqs.json.
 */
export const PLACEHOLDERS = new Set(["long run", "long fight", "restore a great rune"]);

/** How much of a shared prerequisite's cost comes off the square that needed it. */
export const SHARE_DISCOUNT = 0.5;

/**
 * Never discount a square below this, in seconds.
 *
 * A gated square with its gate on the board is cheaper, not free: the fight itself still has to
 * happen, and something has to stop a chain of discounts driving a square to nothing. The cheapest
 * measured square in the game is about fifteen minutes, so nothing should ever price below that.
 */
export const COST_FLOOR = 15 * 60;

const leaves = (n: PrereqNode): string[] => (Array.isArray(n) ? n.flatMap(leaves) : [n]);

/** The location half of a tooltip: everything after the first " - ". */
function placeOf(tooltip: string | undefined): string {
  return (tooltip ?? "").split(" - ").slice(1).join(" - ");
}

/**
 * Everything gating one square: its own entry, plus every location rule whose place it sits in.
 *
 * The two add together rather than one overriding the other, so "everything in Jagged Peak needs
 * Ancient Dragon Man" and "Bayle is also a long run" both apply to Bayle.
 */
export function prereqsFor(
  square: { name: string; tooltip?: string },
  table: PrereqTable
): string[] {
  const own = table[square.name];
  const out = Array.isArray(own) ? leaves(own as PrereqNode) : [];

  const locations = table._locations as Record<string, PrereqNode> | undefined;
  for (const [place, rule] of Object.entries(locations ?? {})) {
    if (placeOf(square.tooltip).includes(place)) out.push(...leaves(rule));
  }
  return [...new Set(out)];
}

/**
 * The board's costs, adjusted for prerequisites that this deal happens to make free.
 *
 * `base[i]` is what the archive says cell i's square costs. The result is the same array with a
 * discount applied wherever a square's gate is standing on the board beside it.
 *
 * An OR-group discounts if ANY of its options is on the board - you only need one of them - and the
 * discount is taken from the cheapest option present, since that is the one a team would actually
 * do. An AND-list discounts once per satisfied member, because each is separate work avoided.
 */
export function effectiveCosts(
  board: Array<{ name: string; tooltip?: string } | undefined>,
  base: number[],
  table: PrereqTable,
  costByName: Record<string, number>
): number[] {
  const onBoard = new Set<string>();
  for (const sq of board) if (sq?.name) onBoard.add(sq.name);

  return base.map((cost, i) => {
    const sq = board[i];
    if (!sq?.name) return cost;

    let discount = 0;
    for (const p of prereqsFor(sq, table)) {
      if (PLACEHOLDERS.has(p)) continue; // names nothing, so nothing can satisfy it
      if (!onBoard.has(p)) continue; // off the board: the measurement already assumed this
      discount += (costByName[p] ?? 0) * SHARE_DISCOUNT;
    }
    return Math.max(COST_FLOOR, cost - discount);
  });
}
