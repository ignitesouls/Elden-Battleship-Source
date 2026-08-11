import type { CSSProperties } from "react";
import { REGION_ORDER, REGION_LABELS, colorKeyFor, type Challenge, type Region } from "./challenges";

export interface LegendItem {
  key: string;
  label: string;
  /** Carries the colour for a region-tagged set; the keyword sets use `style` instead. */
  className: string;
  style?: CSSProperties;
}

/**
 * The colour key's contents for one board: what to draw, and what to call the whole thing.
 *
 * Its own module because there are now three keys built from it - the card beside a player's board,
 * the inline strip in the match dock and the spectator's bar, and the caster's OBS strip
 * (OverlayKey). Two derivations would be two chances for a stream to name a colour differently from
 * the board it is describing.
 *
 * Lists only what is actually dealt onto THIS board, not everything the set can produce. A board is
 * 100 squares out of 200-odd, so a couple of groups routinely don't appear at all - and a key naming
 * colours that aren't on screen makes the reader hunt for something that was never there.
 *
 * Two schemes reach it, because the sets genuinely disagree about what a colour is. Region-tagged
 * sets (Bosses, Objectives) name a closed vocabulary, so their swatches carry the same .bg-region-*
 * classes the squares themselves use and the colours are read from one definition in BoardGrid.css
 * rather than repeated here, where they could drift. Keyword-tinted sets (the two community ones)
 * resolve to a loose hex instead, which arrives already computed on the square and is written into
 * the same variable those classes set - so a swatch can't disagree with its board either way. See
 * colorLegend for where a keyword group's NAME comes from, since the set files don't record one.
 *
 * Ringus has neither, and gets an empty list - every caller renders nothing rather than an empty
 * panel.
 */
export function legendItems(
  challenges: Challenge[],
  /** The room's square set, which is what says how to name a keyword-tinted board's colours. */
  setId?: string | null
): { items: LegendItem[]; heading: string } {
  const regionsPresent = new Set<Region>();
  const colorsPresent = new Set<string>();
  for (const c of challenges) {
    if (c.region) regionsPresent.add(c.region);
    if (c.color) colorsPresent.add(c.color);
  }

  const regions = REGION_ORDER.filter((r) => regionsPresent.has(r));
  const colors = colorKeyFor(setId).filter((c) => colorsPresent.has(c.hex));

  const items: LegendItem[] = [
    ...regions.map((region) => ({
      key: region,
      label: REGION_LABELS[region],
      className: `bg-region-${region}`,
    })),
    ...colors.map((c) => ({
      key: c.hex,
      label: c.label,
      className: "",
      // Written into the same variable the .bg-region-* classes set, so one rule paints every swatch.
      style: { ["--bg-region" as string]: c.hex } as CSSProperties,
    })),
  ];

  // A set uses one scheme or the other, so "Key" is only reachable if one ever mixed them.
  const heading = regions.length === 0 ? "Colours" : colors.length === 0 ? "Regions" : "Key";
  return { items, heading };
}
