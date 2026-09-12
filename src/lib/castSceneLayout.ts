/**
 * Where every box in a casting scene lands on a 1080p canvas.
 *
 * -- Why this is its own module, and pure ------------------------------------------------------
 *
 * lib/obsScene builds the scene FILE and has to run in Node so scripts/check-obs-scene can pull it
 * apart. The casting scene adds a second question that also wants asserting away from a browser:
 * given a room of N players split across two fleets, where do the N stream boxes, the board and the
 * clock go, and does any of it fall off the canvas. That is arithmetic, it has edge cases (one
 * player a side, four a side, an odd split), and getting it wrong puts a box half off a stream. So
 * it lives here, pure, with scripts/check-cast-scene over it - the same split, and the same reason,
 * as lib/obsScene sitting apart from the page that downloads it.
 */

/** The canvas nearly every stream is composed at, and what the fractions below are measured from. */
export const CAST_CANVAS = { w: 1920, h: 1080 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CastLayoutConfig {
  /**
   * How many fleets are on camera. Two is the reference and the clean case - one column a side.
   * Three or four still work: the boxes fill the two columns top to bottom in slot order, so the
   * team grouping can straddle the middle, but every box is still coloured by its player's real
   * fleet where it renders (see pages/OverlayScreen).
   */
  teams: number;
  /** Stream boxes per fleet, down one side. One to four. */
  perTeam: number;
}

/** The vertical band the side columns live in - below the clock, above the canvas floor. */
const COL_TOP = 96;
const COL_BOTTOM = 1004;
/** Gap between stacked boxes, and the inset of a column from the canvas edge. */
const BOX_GAP = 16;
const COL_INSET = 20;
/** A stream box never gets wider than this, however much vertical room a short column leaves. */
const MAX_BOX_W = 470;
const BOX_ASPECT = 9 / 16;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** How many boxes total, and how they divide between the left and right columns. */
export function columnCounts(cfg: CastLayoutConfig): { left: number; right: number } {
  const total = Math.max(0, Math.floor(cfg.teams) * Math.floor(cfg.perTeam));
  const left = Math.ceil(total / 2);
  return { left, right: total - left };
}

/** One column of `count` boxes, stacked and vertically centred in the band, at column x-origin. */
function columnRects(count: number, onLeft: boolean): Rect[] {
  if (count <= 0) return [];
  const band = COL_BOTTOM - COL_TOP;
  const slotH = (band - (count - 1) * BOX_GAP) / count;
  const boxW = clamp(slotH / BOX_ASPECT, 0, MAX_BOX_W);
  const boxH = boxW * BOX_ASPECT;
  const x = onLeft ? COL_INSET : CAST_CANVAS.w - COL_INSET - boxW;
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const slotTop = COL_TOP + i * (slotH + BOX_GAP);
    rects.push({ x, y: slotTop + (slotH - boxH) / 2, w: boxW, h: boxH });
  }
  return rects;
}

/**
 * The stream boxes in slot order: the left column top to bottom, then the right column.
 *
 * Slot order matches lib/castScreens - team, then join time - so for the two-fleet case slot 0..k-1
 * is one crew down the left and k..n-1 is the other down the right, which is the reference exactly.
 */
export function screenRects(cfg: CastLayoutConfig): Rect[] {
  const { left, right } = columnCounts(cfg);
  return [...columnRects(left, true), ...columnRects(right, false)];
}

/**
 * The driven board, centred in the channel between the columns.
 *
 * Square, and sized to leave a strip along the bottom of the channel for the two caster cams -
 * see castCamRects. It used to run to y 940; the cams pushed it up and in.
 */
export function boardRect(): Rect {
  const w = 556;
  return { x: (CAST_CANVAS.w - w) / 2, y: 196, w, h: w };
}

/** The caster clock, along the top of the channel, above the board. */
export function clockRect(): Rect {
  const w = 624;
  return { x: (CAST_CANVAS.w - w) / 2, y: 12, w, h: w * (300 / 1200) };
}

/**
 * The two caster cams in the MAIN scene: side by side, along the bottom of the centre channel,
 * under the board - exactly where the reference layout puts them.
 *
 * These become their own `frame` source (`?layout=cast`) in the EB Cast scene: two bordered
 * cut-outs the caster drops their webcams behind, the same arrangement as the break scene's boxes.
 */
export function castCamRects(): Rect[] {
  const w = 378;
  const h = 284;
  const gap = 24;
  const y = CAST_CANVAS.h - h - 24;
  const x0 = (CAST_CANVAS.w - (w * 2 + gap)) / 2;
  return [
    { x: x0, y, w, h },
    { x: x0 + w + gap, y, w, h },
  ];
}

/**
 * The two big camera cut-outs in the "EB Casters" break scene.
 *
 * Informational only: the break scene is a single full-canvas `frame` source that draws its own
 * borders (see pages/OverlayFrame), and the caster puts their webcams behind it. These rects are
 * what the setup-page preview draws so a caster can see the shape before they import.
 */
export function casterCamRects(): Rect[] {
  const w = 690;
  const h = 820;
  const y = 135;
  return [
    { x: 125, y, w, h },
    { x: CAST_CANVAS.w - 125 - w, y, w, h },
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
export function castSceneRects(cfg: CastLayoutConfig): Rect[] {
  return [...screenRects(cfg), boardRect(), clockRect(), ...castCamRects()];
}
