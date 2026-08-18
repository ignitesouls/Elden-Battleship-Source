import type { Attack } from "../types/battleship";

/**
 * What one square is showing. The board draws the result; this says which result it is.
 *
 * Lives here rather than beside BoardGrid because `cellVisuals` below is what produces it and every
 * board resolves its squares through that. BoardGrid re-exports the type, so the dozen files that
 * import it alongside the component are untouched.
 */
export type CellVisual =
  | "empty"
  | "ship"
  | "hit"
  | "miss"
  | "sunk"
  | "preview-valid"
  | "preview-invalid";

/**
 * Every square's result, resolved in ONE pass over the attack log instead of one pass per square.
 *
 * -- Why this exists ------------------------------------------------------------------------------
 *
 * Every board used to answer this per cell, with a `attacks.filter(a => a.cell_index === index)`
 * inside the function BoardGrid calls once per square. That is a hundred squares times a couple of
 * hundred rows, plus a hundred throwaway arrays, on every render - and the spectator page pays it
 * once per fleet on show, so a four-fleet match was four hundred filters of the whole log to draw
 * one frame. It was tolerable while boards only re-rendered when a shot landed, and stopped being
 * tolerable once the match clock, the cast heartbeat and presence sync were all re-rendering them.
 *
 * One walk of the log turns the per-square question into a map lookup.
 *
 * -- Precedence -----------------------------------------------------------------------------------
 *
 * Sunk beats hit beats miss. One shot lands against every opponent at once, so a square can carry
 * several outcomes and the board shows the most informative - a square that sank something must
 * never read as a miss because another fleet happened to be empty there.
 *
 * @param attacks the rows this board is drawing. Already narrowed by the caller to the fleet (or
 *   fleets) the board is about - this makes no judgement about whose shots belong on which grid.
 * @param sunkCells every cell of every sunk hull, not just the square that dealt the final blow, so
 *   wreckage covers the whole ship. Build it with `sunkCellOrientations`; its values are the hull
 *   orientation, which only the marker cares about, so a plain Set of cells works here too.
 */
export function cellVisuals(
  attacks: Attack[],
  sunkCells: ReadonlyMap<number, unknown> | ReadonlySet<number>
): Map<number, CellVisual> {
  const out = new Map<number, CellVisual>();
  for (const a of attacks) {
    // Negative indices are bookkeeping rows (the match-start marker), not shots anyone fired.
    if (a.cell_index < 0) continue;
    if (a.result === "hit") out.set(a.cell_index, "hit");
    else if (a.result === "miss" && !out.has(a.cell_index)) out.set(a.cell_index, "miss");
  }
  // Applied last so it wins outright: every cell of a sunk hull reads as wreckage, including the
  // ones that were only ever recorded as hits.
  for (const cell of sunkCells.keys()) out.set(cell, "sunk");
  return out;
}
