import type { CSSProperties } from "react";
import { SQUARE_SETS, type Region } from "./squareSets";
import { boardColor } from "./squareSetFormat";

/**
 * What colourblind mode adds to a board beyond a palette: a short code on every square.
 *
 * -- Why a code and not just better colours -----------------------------------------------------
 *
 * The square names are tinted with seven to ten colours per set, and they have to be LIGHT tints to
 * read as text on the near-black cell. That leaves lightness and the blue-yellow axis as the only
 * room to move in, and the two common colour deficiencies (deutan, protan) erase exactly the other
 * axis. The palettes colourblind mode swaps in (BoardGrid.css, the data-colorblind block) were
 * searched for the widest worst-case gap a simulated deutan, protan and tritan eye can still see, and
 * the best that exists for ten light tints is still "different if you look", not "different at a
 * glance". So the colour is the second cue in this mode and the code is the first: every square says
 * which group it is in, in the corner, and the key prints the same code beside each swatch.
 *
 * Everything here is always rendered and only SHOWN under :root[data-colorblind="1"] - the same
 * reason the fleet palette is a set of CSS variables. Flipping the toggle restyles every board live,
 * with no re-render and nothing for a call site to thread through.
 */

/**
 * The corner code for each region.
 *
 * Place names, because the places are proper nouns that read the same in French and a player already
 * knows "LI" is Liurnia. Unique within each set's vocabulary, which is all that matters - no board
 * mixes the two (see REGION_ORDER). "C" for combined squares is the (C) the set already marks them
 * with; "*" for squares that are deliberately nowhere in particular.
 */
export const REGION_CODES: Record<Region, string> = {
  limgrave: "LG",
  liurnia: "LI",
  caelid: "CA",
  altus: "AL",
  mountaintops: "MT",
  underground: "UG",
  dlc: "DLC",

  prealtus: "PRE",
  postaltus: "POST",
  snowfield: "MT",
  dlcgeneral: "DLC",
  belurat: "BEL",
  shadowkeep: "SK",
  rauh: "RB",
  dlcsouth: "CC",
  combined: "C",
  general: "*",
};

/**
 * Colourblind-mode replacements for the community sets' keyword colours, keyed by the colour as the
 * set's own colour file writes it.
 *
 * Keyed by the authored string rather than the board hex because the board hex is computed (see
 * boardColor's legibility lift) and the authored string is what anybody editing this would be
 * looking at. Picked by the same search as the region palettes, across the union of both sets so one
 * table serves both. A colour missing from here keeps its normal hex in the mode - its code still
 * marks it.
 */
const KEYWORD_COLORBLIND: Record<string, string> = {
  lime: "#ccffcc",
  blue: "#aa99cc",
  red: "#ee8899",
  fuchsia: "#ffbbff",
  "170,140,0": "#ddbb00",
  yellow: "#eeff11",
  "255,128,0": "#ee7755",
  "128,128,255": "#9988ff",
  "255,255,128": "#ccdd88",
  "128,255,255": "#55ccbb",
};

const authoredKey = (color: string) => color.trim().toLowerCase().replace(/\s+/g, "");

/**
 * Board hex -> its code and colourblind replacement, for every keyword colour any set uses.
 *
 * Built once over every keyword-tinted set, so a square needs only the hex it already carries -
 * BoardGrid never has to be told which set it is drawing. Codes are letters handed out in set order
 * then file order, which makes them A, B, C... down the first set's key; a later set shares the
 * letter wherever it shares the colour, so within any one set every colour still gets its own.
 */
const KEYWORDS = (() => {
  const byHex = new Map<string, { code: string; colorblind: string }>();
  for (const set of Object.values(SQUARE_SETS)) {
    if (set.format !== "bingo" || !set.colors) continue;
    for (const rule of set.colors) {
      if (typeof rule?.Color !== "string") continue;
      const hex = boardColor(rule.Color);
      if (!hex || byHex.has(hex)) continue;
      byHex.set(hex, {
        code: String.fromCharCode(65 + byHex.size),
        colorblind: KEYWORD_COLORBLIND[authoredKey(rule.Color)] ?? hex,
      });
    }
  }
  return byHex;
})();

/** The corner code for a square's colour group, or null for a square with no group (Ringus). */
export function squareCode(group: { region?: Region; color?: string } | null | undefined): string | null {
  if (!group) return null;
  // Colour first, matching the board: where a square carries both, its inline keyword colour is the
  // one it is painted in (.bg-kw comes after the region classes), so that is the group it shows.
  if (group.color) return KEYWORDS.get(group.color)?.code ?? null;
  if (group.region) return REGION_CODES[group.region] ?? null;
  return null;
}

/**
 * The inline style that paints a keyword-tinted square (or swatch) its colour.
 *
 * Two variables and a class rather than --bg-region directly: an inline --bg-region can't be
 * overridden by a stylesheet, so the mode would have no way to swap it. `.bg-kw` resolves
 * --bg-region from whichever of the pair the mode wants. Pair it with KEYWORD_CLASS.
 */
export function keywordStyle(hex: string): CSSProperties {
  return {
    ["--bg-kw" as string]: hex,
    ["--bg-kw-cb" as string]: KEYWORDS.get(hex)?.colorblind ?? hex,
  } as CSSProperties;
}

export const KEYWORD_CLASS = "bg-kw";
