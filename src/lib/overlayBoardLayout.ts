/**
 * The one piece of arithmetic the board source and the control page's monitor must agree on.
 *
 * They now render the SAME thing: the control page shows a 1000x1000 viewport, scaled down for the
 * screen, containing the board laid out exactly as the source lays it out. That is what makes the
 * preview trustworthy - it isn't a model of the stream that has to be kept in step, it IS the
 * stream at a smaller display size, so there is no second calculation left to drift.
 *
 * It also deletes a whole class of bug. The preview used to draw a rectangle predicting what the
 * source had in frame, which meant guessing the source's aspect, reporting its real size back over
 * the channel, and deriving visible fractions per axis. All of that existed only to approximate
 * something we can simply show.
 */

/**
 * The board source's assumed pixel size, and the size the control page's monitor emulates.
 *
 * Also what the control page tells the caster to make their Browser Source. A source at a different
 * size still works - the board fits itself to whatever it measures - but at exactly this size the
 * monitor is pixel-for-pixel honest.
 */
export const SOURCE_SIZE = 1000;

/**
 * Zoom bounds. 1 fits the whole board; 2 shows a quarter of it.
 *
 * Capped at 2 deliberately, down from 6. Past 2x a board is a handful of squares and the pan gets
 * twitchy - a small movement of the caster's hand throws a viewer clear across the board, and the
 * thing they were reading is gone before they finished it. 2x is about where the square names stop
 * being the reason to zoom, so it's the useful end of the range rather than an arbitrary limit.
 *
 * Here rather than in lib/overlayCast, where they used to live and from where they are still
 * re-exported, because they are an input to `placeBoard` above: at MAX_ZOOM the clamp in there is
 * what makes the four quadrant centres reachable and the four corners of the pannable box the same
 * four points, which is the whole geometry the self-aiming camera is built on. Two facts that have
 * to agree belong in one file - and this one is pure, so both can be asserted.
 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2;

/**
 * Where the board sits so its (centre) point is in the middle of the frame.
 *
 * Smaller than the frame on an axis means centre it; larger means pan, clamped so an edge can never
 * pull blank space into view. `boardSide` must be MEASURED rather than computed - the rendered
 * board is never exactly `cells * cellSize` once gutters, gaps and borders are counted, and
 * computing it is what put the board in the corner with half of it cropped.
 */
export function placeBoard(boardSide: number, frameSide: number, centre: number): number {
  if (boardSide <= frameSide) return (frameSide - boardSide) / 2;
  return Math.min(0, Math.max(frameSide - boardSide, frameSide / 2 - centre * boardSide));
}
