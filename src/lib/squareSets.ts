import bossData from "../data/battleshipChallenges.json";
import incursionData from "../data/incursionSquares.json";
import incursionShortNames from "../data/incursionShortNames.json";
import incursionRegions from "../data/incursionRegions.json";
import rookieRumbleData from "../data/rookieRumbleSquares.json";
import rookieRumbleColors from "../data/rookieRumbleColors.json";
import rookieRumbleColorNames from "../data/rookieRumbleColorNames.json";
import scaduLeagueData from "../data/scaduLeagueSquares.json";
import scaduLeagueColors from "../data/scaduLeagueColors.json";
import scaduLeagueColorNames from "../data/scaduLeagueColorNames.json";
import ringusData from "../data/ringusSquares.json";
import { colorLegend, type BingoSquareSet, type Challenge, type ColorLegendEntry, type KeywordColor } from "./squareSetFormat";

export type { Challenge, BingoSquare, BingoSquareSet, Region, KeywordColor, ColorLegendEntry } from "./squareSetFormat";
export { REGION_ORDER, REGION_LABELS } from "./squareSetFormat";
export { buildBingoBoard, buildFlatBoard } from "./squareSetFormat";

interface BaseSet {
  id: string;
  label: string;
  blurb: string;
  /**
   * True when this set's `tooltip` already spells the square out, so the hover text is the tooltip
   * ALONE. See squareTitle.
   */
  tooltipReplacesName?: boolean;
}

interface FlatSet extends BaseSet {
  format: "flat";
  data: Challenge[];
}

interface BingoSet extends BaseSet {
  format: "bingo";
  data: BingoSquareSet;
  /** Short cell labels for this set's longer squares, keyed by raw name. Optional. */
  shortNames?: Record<string, string>;
  /** Where each square sends you, keyed by raw name, for the board's colour key. Optional. */
  regions?: Record<string, string>;
  /**
   * This set's companion colour file, for sets that tint by keyword rather than by region. A set
   * uses one scheme or the other, never both.
   */
  colors?: KeywordColor[];
  /** What those colours are called, keyed by the colour as `colors` writes it. See colorLegend. */
  colorNames?: Record<string, string>;
}

export type SquareSetDef = FlatSet | BingoSet;

/** Stored in `rooms.square_set`. Free-form text there, validated here. */
export type SquareSetId = string;

/**
 * What a room can put on its squares. The host picks one in the lobby.
 *
 * Ids are what land in the database and must stay stable; labels and blurbs are display text and
 * can change freely. Adding a set is a .json beside this file plus an entry here - no migration,
 * because the column takes any text and anything unrecognized falls back to the default.
 */
export const SQUARE_SETS: Record<string, SquareSetDef> = {
  bosses: {
    id: "bosses",
    label: "Bosses",
    blurb: "Every square is a boss to kill. The original board.",
    format: "flat",
    data: bossData as Challenge[],
    // This set's names are board-sized handles - "LG Tree Sent", "BOFA" - and its tooltips are the
    // squares in full: "Tree Sentinel - Church of Elleh". So the tooltip is the whole hover.
    tooltipReplacesName: true,
  },
  objectives: {
    id: "objectives",
    label: "Objectives: Base+DLC",
    blurb: "Mixed goals across the whole game - items, collectables and multi-part kills.",
    format: "bingo",
    data: incursionData as BingoSquareSet,
    shortNames: incursionShortNames as Record<string, string>,
    // Cast rather than typed directly: the file carries `_`-prefixed comment keys (one of them an
    // array of lines) alongside the real entries, which no square name can collide with and which
    // buildBingoBoard drops anyway, since it only accepts values that name a known region.
    regions: incursionRegions as unknown as Record<string, string>,
  },
  /**
   * The two community sets, each the base game or the DLC alone.
   *
   * Both tint from a keyword file rather than from region tags - that is the format their authors
   * ship, and rewriting them into our region vocabulary would mean maintaining a translation of
   * somebody else's set every time they revise it. Their key therefore comes from a second
   * companion file naming the colours, which is ours rather than the author's; see colorLegend and
   * the notes at the top of rookieRumbleColorNames.json.
   */
  "objectives-base": {
    id: "objectives-base",
    label: "Objectives: Base",
    blurb: "Rookie Rumble - base game only, no Shadow of the Erdtree.",
    format: "bingo",
    data: rookieRumbleData as BingoSquareSet,
    colors: rookieRumbleColors as KeywordColor[],
    // Cast for the same reason incursionRegions is: the file carries a `_comment` key holding an
    // array of lines, which no colour string can collide with and which colorLegend never looks up.
    colorNames: rookieRumbleColorNames as unknown as Record<string, string>,
  },
  "objectives-dlc": {
    id: "objectives-dlc",
    label: "Objectives: DLC",
    blurb: "Scadubingo League - Shadow of the Erdtree only.",
    format: "bingo",
    data: scaduLeagueData as BingoSquareSet,
    colors: scaduLeagueColors as KeywordColor[],
    colorNames: scaduLeagueColorNames as unknown as Record<string, string>,
  },
  /**
   * Ringus, for randomizer runs - hence the "Replacement" squares, which name the boss whose slot
   * you have to reach rather than what you will actually find standing in it.
   *
   * A flat list like the boss set rather than a squareset: it declares no categories, no limits and
   * no variables, so there is nothing for the bingo picker to honour and the plain shuffle is the
   * honest reading of the file. Two hundred squares fills even a 12x12 without reusing one.
   */
  ringus: {
    id: "ringus",
    label: "Ringus",
    blurb: "Randomizer chaos - boss replacements, stunt kills, scavenger hunts and team dares.",
    format: "flat",
    data: ringusData as Challenge[],
  },
};

export const SQUARE_SET_LIST: SquareSetDef[] = Object.values(SQUARE_SETS);

/**
 * A square's hover text: what it is, once, and where it is.
 *
 * Two shapes, because the sets write `tooltip` for two different jobs. The boss set's name is an
 * abbreviation and its tooltip is the expansion, so joining the two printed the boss twice - "LG
 * Tree Sent - Tree Sentinel - Church of Elleh" - and the hover's whole job is to be the place the
 * abbreviation is spelled out. The objective sets write their names in full and use the tooltip for
 * a note that only means anything beside one ("Leda counts as an invader if..."), which does have to
 * be joined or the square loses its identity on hover.
 *
 * Which of the two a set is is a property of the set, not something to be guessed per square - see
 * tooltipReplacesName.
 */
export function squareTitle(challenge: Challenge, set: SquareSetDef): string {
  if (set.tooltipReplacesName) return challenge.tooltip ?? challenge.name;
  return challenge.tooltip ? `${challenge.name} - ${challenge.tooltip}` : challenge.name;
}

export const DEFAULT_SQUARE_SET = "bosses";

/** Falls back to the default for anything unrecognized, so an unknown id can never blank a board. */
export function squareSet(id: string | null | undefined): SquareSetDef {
  return SQUARE_SETS[id ?? ""] ?? SQUARE_SETS[DEFAULT_SQUARE_SET];
}

/**
 * A set's colour key, or nothing for the sets that don't tint by keyword.
 *
 * The board itself needs none of this - a square carries its own hex - so it's computed here on
 * demand rather than folded into buildBingoBoard, which every client runs for every cell.
 */
export function colorKeyFor(id: string | null | undefined): ColorLegendEntry[] {
  const set = squareSet(id);
  if (set.format !== "bingo" || !set.colors) return [];
  return colorLegend(set.colors, set.colorNames);
}

/**
 * The set an archived row belongs to.
 *
 * Null means a match played before rooms could choose, which could only ever have been the boss
 * board - so the record books read correctly without a backfill.
 */
export function rowSquareSet(row: { square_set?: string | null }): SquareSetId {
  return row.square_set ?? DEFAULT_SQUARE_SET;
}

/**
 * Splits archived rows by set and picks which one to show first: whichever has the most, so the
 * page opens on something populated rather than on an empty table for a set nobody has played.
 */
export function busiestSquareSet(rows: Array<{ square_set?: string | null }>): SquareSetId {
  const counts = new Map<SquareSetId, number>();
  for (const row of rows) {
    const id = rowSquareSet(row);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best = DEFAULT_SQUARE_SET;
  for (const [id, n] of counts) {
    if (n > (counts.get(best) ?? 0)) best = id;
  }
  return best;
}
