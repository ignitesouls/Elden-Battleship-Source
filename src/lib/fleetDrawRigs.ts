/**
 * Five pirate rigs, built from predictable primitives rather than hand-drawn
 * path data: a crescent hull struck as an arc, a raked stern castle, masts,
 * and bellied canvas.
 *
 * Every hull points BOW RIGHT. Turning a ship around is a scaleX(-1) on a
 * wrapper that holds only the hull, never the nameplate - mirror the plate and
 * the name comes out backwards, which is the one thing a randomiser may not do.
 */

interface Mast {
  x: number;
  top: number;
  kind: "square" | "gaff";
  /** half-width of the square sails */
  w?: number;
  /** how far a gaff sail trails aft */
  reach?: number;
}

interface Rig {
  w: number;
  stern: number;
  bow: number;
  castle: number;
  masts: Mast[];
}

const DECK = 100;
const VBH = 130;

const RIGS: Rig[] = [
  { w: 122, stern: 22, bow: 100, castle: 12, masts: [{ x: 60, top: 16, kind: "gaff", reach: 30 }] },
  { w: 154, stern: 20, bow: 132, castle: 13, masts: [{ x: 54, top: 20, kind: "gaff", reach: 28 }, { x: 98, top: 12, kind: "gaff", reach: 30 }] },
  { w: 180, stern: 20, bow: 158, castle: 16, masts: [{ x: 58, top: 14, kind: "square", w: 26 }, { x: 112, top: 22, kind: "gaff", reach: 30 }] },
  { w: 208, stern: 18, bow: 184, castle: 15, masts: [{ x: 56, top: 20, kind: "square", w: 23 }, { x: 104, top: 10, kind: "square", w: 27 }, { x: 152, top: 20, kind: "square", w: 23 }] },
  { w: 226, stern: 18, bow: 198, castle: 30, masts: [{ x: 62, top: 22, kind: "square", w: 24 }, { x: 116, top: 12, kind: "square", w: 29 }, { x: 170, top: 26, kind: "gaff", reach: 30 }] },
];

/** A sail with a bellied foot, as if the wind were in it. */
function squareSail(cx: number, top: number, bottom: number, halfW: number, belly: number): string {
  return (
    `M${cx - halfW},${top}` +
    ` Q${cx},${top + belly * 0.45} ${cx + halfW},${top}` +
    ` L${cx + halfW},${bottom}` +
    ` Q${cx},${bottom + belly} ${cx - halfW},${bottom} Z`
  );
}

/** A gaff sail, trailing aft of its mast. */
function gaffSail(mx: number, top: number, bottom: number, reach: number): string {
  return (
    `M${mx - 1},${top} L${mx - 1},${bottom} L${mx - reach},${bottom - 3}` +
    ` Q${mx - reach * 0.55},${(top + bottom) / 2} ${mx - 1},${top} Z`
  );
}

export interface RigShape {
  viewBox: string;
  /** Drawn in order; class decides how each piece is painted. */
  parts: { cls: "hull" | "castle" | "spar" | "rig" | "sail" | "sail-lee" | "flag" | "port"; d: string }[];
}

/** Geometry only - no colour, no DOM. The component paints it. */
export function rigShape(index: number): RigShape {
  const rig = RIGS[index % RIGS.length];
  const parts: RigShape["parts"] = [];

  // standing rigging first, so everything else sits over it
  for (const m of rig.masts) {
    parts.push({ cls: "rig", d: `M${m.x},${m.top + 4} L${rig.bow + 6},${DECK - 4}` });
    parts.push({ cls: "rig", d: `M${m.x},${m.top + 4} L${rig.stern + 2},${DECK - 6}` });
  }

  const span = rig.bow - rig.stern;
  parts.push({
    cls: "hull",
    d: `M${rig.stern},${DECK} L${rig.bow},${DECK} A ${span * 1.15} ${span * 1.15} 0 0 1 ${rig.stern},${DECK} Z`,
  });

  for (let p = rig.stern + 14; p < rig.bow - 16; p += 17) {
    parts.push({ cls: "port", d: `M${p},${DECK + 5} h5 v5 h-5 Z` });
  }

  parts.push({
    cls: "castle",
    d:
      `M${rig.stern - 4},${DECK} L${rig.stern - 1},${DECK - rig.castle}` +
      ` L${rig.stern + 26},${DECK - rig.castle} L${rig.stern + 26},${DECK} Z`,
  });

  parts.push({ cls: "spar", d: `M${rig.bow - 12},${DECK - 3} L${rig.bow + 18},${DECK - 17}` });

  for (const mast of rig.masts) {
    parts.push({ cls: "spar", d: `M${mast.x},${mast.top} L${mast.x},${DECK}` });

    if (mast.kind === "square") {
      const w = mast.w ?? 24;
      const hi = mast.top + 8;
      const mid = mast.top + 34;
      const lo = mast.top + 40;
      const foot = DECK - 12;
      parts.push({ cls: "spar", d: `M${mast.x - w - 3},${hi} L${mast.x + w + 3},${hi}` });
      parts.push({ cls: "sail-lee", d: squareSail(mast.x, hi, mid, w * 0.78, 5) });
      parts.push({ cls: "spar", d: `M${mast.x - w - 4},${lo} L${mast.x + w + 4},${lo}` });
      parts.push({ cls: "sail", d: squareSail(mast.x, lo, foot, w, 7) });
    } else {
      const reach = mast.reach ?? 30;
      parts.push({ cls: "spar", d: `M${mast.x},${mast.top + 6} L${mast.x - reach * 0.7},${mast.top + 1}` });
      parts.push({ cls: "sail", d: gaffSail(mast.x, mast.top + 5, DECK - 6, reach) });
    }
  }

  const fore = rig.masts[rig.masts.length - 1];
  parts.push({
    cls: "sail-lee",
    d: `M${fore.x + 3},${fore.top + 10} L${rig.bow + 15},${DECK - 16} L${rig.bow - 14},${DECK - 8} Z`,
  });

  const main = rig.masts.reduce((a, b) => (a.top <= b.top ? a : b));
  parts.push({
    cls: "flag",
    d: `M${main.x + 1},${main.top} L${main.x + 24},${main.top + 4} L${main.x + 1},${main.top + 9} Z`,
  });

  return { viewBox: `0 0 ${rig.w + 22} ${VBH}`, parts };
}

export const RIG_COUNT = RIGS.length;
