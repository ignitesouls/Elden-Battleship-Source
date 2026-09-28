/**
 * Where every box in a casting scene lands on a 1080p canvas.
 *
 * -- Traced from the frame art --------------------------------------------------------------------
 *
 * The casting scene is drawn over two pieces of frame art (public/frames): battleship-overlays.png
 * for the match and battleship-casters.png for the break. Each is a 1920x1080 PNG with transparent
 * holes, and every rect below is one of those holes measured to the pixel. The art is the source of
 * truth - if it is redrawn, re-measure the holes and update these numbers, or the streams and the
 * board slide out from under their borders.
 *
 * One shape only: two fleets of three, the competitive format. The art has six player holes and
 * nothing else would fit it.
 *
 * -- Why this is its own module, and pure ------------------------------------------------------
 *
 * lib/obsScene builds the scene FILE and has to run in Node so scripts/check-cast-scene can pull it
 * apart, and the layout wants asserting there too - that nothing falls off the canvas and nothing
 * overlaps. Same split, and the same reason, as lib/obsScene sitting apart from the page that
 * downloads it.
 */

/** The canvas nearly every stream is composed at, and what the fractions below are measured from. */
export const CAST_CANVAS = { w: 1920, h: 1080 };

/** The frame art, relative to the site root. */
export const CAST_ART = {
  match: "frames/battleship-overlays.png",
  break: "frames/battleship-casters.png",
};

/** Players on camera: two fleets of three. */
export const CAST_SEATS = 6;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The side columns' holes, top to bottom. The middle one is 4px shorter than the other two. */
const COLUMN_W = 636;
const COLUMN_ROWS: Array<{ y: number; h: number }> = [
  { y: 0, h: 356 },
  { y: 364, h: 352 },
  { y: 724, h: 356 },
];

/**
 * The stream boxes in slot order: the left column top to bottom, then the right column.
 *
 * Slot order matches lib/castScreens - team, then join time - so slots 0..2 are one crew down the
 * left and 3..5 are the other down the right.
 */
export function screenRects(): Rect[] {
  const column = (x: number) => COLUMN_ROWS.map(({ y, h }) => ({ x, y, w: COLUMN_W, h }));
  return [...column(0), ...column(CAST_CANVAS.w - COLUMN_W)];
}

/** The driven board: the square hole in the middle of the channel. */
export function boardRect(): Rect {
  return { x: 644, y: 114, w: 632, h: 632 };
}

/**
 * The caster clock: the water banner along the top of the channel, above the board.
 *
 * Not a hole - the banner is opaque art - so the clock is the one source that sits ABOVE the frame
 * in the scene rather than behind it. See lib/obsScene.
 */
export function clockRect(): Rect {
  return { x: 644, y: 0, w: 632, h: 106 };
}

/** The two caster cams in the MAIN scene: the holes along the bottom of the channel, under the board. */
export function castCamRects(): Rect[] {
  return [
    { x: 644, y: 754, w: 312, h: 326 },
    { x: 964, y: 754, w: 312, h: 326 },
  ];
}

/** The two big camera holes in the "EB Casters" break scene. */
export function casterCamRects(): Rect[] {
  return [
    { x: 132, y: 152, w: 676, h: 776 },
    { x: 1112, y: 152, w: 676, h: 776 },
  ];
}

/** A rect as fractions of the canvas, for a CSS-positioned preview. */
export function frac(r: Rect): { left: number; top: number; width: number; height: number } {
  return {
    left: r.x / CAST_CANVAS.w,
    top: r.y / CAST_CANVAS.h,
    width: r.w / CAST_CANVAS.w,
    height: r.h / CAST_CANVAS.h,
  };
}

/** Every box in the main cast scene, for the preview and for the "nothing off canvas" check. */
export function castSceneRects(): Rect[] {
  return [...screenRects(), boardRect(), clockRect(), ...castCamRects()];
}
