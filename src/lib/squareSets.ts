import bossData from "../data/battleshipChallenges.json";
import bossData2v2 from "../data/battleshipChallenges2v2.json";
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
import bossTooltipsFr from "../data/battleshipTooltipsFr.json";
import incursionNamesFr from "../data/incursionNamesFr.json";
import incursionTooltipsFr from "../data/incursionTooltipsFr.json";
import incursionShortNamesFr from "../data/incursionShortNamesFr.json";
import rookieRumbleNamesFr from "../data/rookieRumbleNamesFr.json";
import rookieRumbleColorNamesFr from "../data/rookieRumbleColorNamesFr.json";
import scaduLeagueNamesFr from "../data/scaduLeagueNamesFr.json";
import scaduLeagueTooltipsFr from "../data/scaduLeagueTooltipsFr.json";
import scaduLeagueOptionsFr from "../data/scaduLeagueOptionsFr.json";
import scaduLeagueColorNamesFr from "../data/scaduLeagueColorNamesFr.json";
import ringusNamesFr from "../data/ringusNamesFr.json";
import { colorLegend, largestBoardFor, type BingoSquareSet, type Challenge, type ColorLegendEntry, type KeywordColor } from "./squareSetFormat";
import { BOARD_SIZES } from "../types/battleship";

export type { Challenge, BingoSquare, BingoSquareSet, Region, KeywordColor, ColorLegendEntry } from "./squareSetFormat";
export { REGION_ORDER, REGION_LABELS } from "./squareSetFormat";
export { buildBingoBoard, buildFlatBoard, shortLabel } from "./squareSetFormat";

interface BaseSet {
  id: string;
  label: string;
  blurb: string;
  /**
   * True when this set's `tooltip` already spells the square out, so the hover text is the tooltip
   * ALONE. See squareTitle.
   */
  tooltipReplacesName?: boolean;
  /**
   * The set this one is a smaller cut of.
   *
   * A variant is a real set everywhere it has to be one - it has its own id in `rooms.square_set`,
   * its own seeded deal, and its own row in the archive - but it is not a separate BOARD as far as
   * anyone reading the site is concerned. So it never appears in the set picker or a records tab,
   * and everything that groups matches by board folds it back into its parent: two cuts of the boss
   * board are the same board with a different number of squares dealt from it. See displaySquareSet.
   *
   * The host still chooses between the cuts - in a second row that appears once the parent set is
   * picked, not as another entry in the list of sets. See cutLabel.
   *
   * The alternative - one set id whose contents depend on the room - was the thing to avoid: the
   * board would stop being a pure function of what the database stores, and the Almanac, the
   * overlays and both Edge Functions all rebuild boards from exactly that.
   */
  variantOf?: string;
  /**
   * This cut's button, for a set that comes in more than one. Absent on a set that has no cuts,
   * which is how the lobby knows not to draw the row at all.
   *
   * The parent carries one too: it is a cut like any other from the host's side - the whole board -
   * and `label` can't do the job, because every cut of a set shares the set's label by design.
   */
  cutLabel?: string;
  /** The label over that row of buttons. On the parent only, since the row belongs to the set. */
  cutsLabel?: string;
  /**
   * French text for this set's squares, keyed by the square's raw `name` - same keying as
   * `shortNames`/`regions` and the same reason: kept beside the set's own file rather than inside
   * it, so a translation is never lost to a version drop and a square with none simply falls back
   * to English. `namesFr` only applies to flat sets today - see challengesForRoom.
   */
  namesFr?: Record<string, string>;
  tooltipsFr?: Record<string, string>;
  /** French for `short`/`shortNames`, keyed by raw name. Flat and bingo sets both carry a short
   *  form, so this lives here rather than on BingoSet alone. */
  shortNamesFr?: Record<string, string>;
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
  /** French for `colorNames`, same keying. See colorLegend. */
  colorNamesFr?: Record<string, string>;
  /** French for the individual values a square's %variable% can draw - see buildBingoBoard. */
  optionsFr?: Record<string, string>;
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
    cutsLabel: "Boss board",
    cutLabel: "All bosses",
    // The cell handles themselves ("LG Tree Sent", "BOFA") stay English on purpose even in French -
    // they're community nicknames and abbreviations, not prose, and "translating" a nickname would
    // just replace one arbitrary label with another nobody in the community actually calls it. Only
    // the tooltip, which spells the boss and its location out in full, gets a real translation.
    tooltipsFr: bossTooltipsFr as Record<string, string>,
  },
  /**
   * The boss board with its 42 longest squares taken out, leaving 164.
   *
   * What comes out is the far end of the game - Bayle, Consort Radahn, Messmer, the Jagged Peak
   * climb, Mohg in the Dynasty - plus the scattered Night's Cavalrys and Deathbirds that cost a
   * detour and settle nothing. On a full crew somebody can be sent for those while the rest of the
   * team keeps working; one or two players cannot, so on a small crew they are squares that sit
   * there all match and quietly decide it by never being touched.
   *
   * The host picks this, from the cut row under "Bosses" - it is not dealt by the roster. It used
   * to be: every team having one or two players moved the room onto this set on its own, and the
   * room moved back off it the moment a third player took a side. That read the room right most of
   * the time and was still the wrong shape, because a duo who wanted the whole map could not have
   * it and had no way to see why the two biggest board sizes had gone. So the roster now decides
   * nothing and this is an offer, with the full board the default it always was.
   *
   * Still a variant rather than a set of its own: it shares the boss board's records, its Almanac
   * tab and its "Bosses" name everywhere those are read. The cut row is the only place the two are
   * told apart. See variantOf.
   */
  "bosses-2v2": {
    id: "bosses-2v2",
    label: "Bosses",
    blurb:
      "The boss board minus its 42 longest squares - Bayle, Consort Radahn, Messmer, the Jagged " +
      "Peak climb, Mohg in the Dynasty, and the Night's Cavalrys and Deathbirds that cost a detour " +
      "and settle nothing. Worth taking when one or two guns can't be spared for the far end of the map.",
    format: "flat",
    data: bossData2v2 as Challenge[],
    tooltipReplacesName: true,
    variantOf: "bosses",
    cutLabel: "Small crew",
    tooltipsFr: bossTooltipsFr as Record<string, string>,
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
    namesFr: incursionNamesFr as Record<string, string>,
    tooltipsFr: incursionTooltipsFr as Record<string, string>,
    shortNamesFr: incursionShortNamesFr as Record<string, string>,
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
    namesFr: rookieRumbleNamesFr as Record<string, string>,
    colorNamesFr: rookieRumbleColorNamesFr as unknown as Record<string, string>,
  },
  "objectives-dlc": {
    id: "objectives-dlc",
    label: "Objectives: DLC",
    blurb: "Scadubingo League - Shadow of the Erdtree only.",
    format: "bingo",
    data: scaduLeagueData as BingoSquareSet,
    colors: scaduLeagueColors as KeywordColor[],
    colorNames: scaduLeagueColorNames as unknown as Record<string, string>,
    namesFr: scaduLeagueNamesFr as Record<string, string>,
    tooltipsFr: scaduLeagueTooltipsFr as Record<string, string>,
    colorNamesFr: scaduLeagueColorNamesFr as unknown as Record<string, string>,
    optionsFr: scaduLeagueOptionsFr as Record<string, string>,
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
    namesFr: (ringusNamesFr as { names: Record<string, string> }).names,
    shortNamesFr: (ringusNamesFr as { shorts: Record<string, string> }).shorts,
  },
};

/**
 * The sets a person can be shown: pickers, records tabs, the auto-fire "works on" line.
 *
 * Variants are left out - they are cuts of a set already on this list, not boards of their own, and
 * listing one would put two buttons labelled "Bosses" side by side. Anything that has to reason
 * about every set that can be STORED (board reconstruction, set detection) wants SQUARE_SETS.
 */
export const SQUARE_SET_LIST: SquareSetDef[] = Object.values(SQUARE_SETS).filter((s) => !s.variantOf);

/**
 * Which listed set an id belongs under, folding a variant into its parent.
 *
 * Use this for anything that GROUPS - records tabs, per-set tallies, "which board was this played
 * on" - and never for rebuilding a board, which needs the id actually stored. The two differ only
 * for variants, which is exactly where getting it wrong deals the wrong squares.
 */
export function displaySquareSet(id: string | null | undefined): SquareSetId {
  const set = squareSet(id);
  return set.variantOf ?? set.id;
}

/**
 * Every stored id that displays as `id`: the set itself, then any variant of it.
 *
 * For readers that have folded a variant into its parent and then need the real board back - the
 * Almanac's square census being the one that matters, since it rebuilds each match's full board to
 * find the squares nobody fired at. They try these in turn and keep whichever reproduces the log.
 *
 * Also what the lobby's cut row is built from, which is why the parent comes first: the full board
 * is the leftmost button and the default.
 */
export function squareSetVariants(id: string | null | undefined): SquareSetId[] {
  const parent = displaySquareSet(id);
  return [parent, ...Object.values(SQUARE_SETS).filter((s) => s.variantOf === parent).map((s) => s.id)];
}

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

/**
 * French for squareTitle(), or undefined when this square has no French text at all yet.
 *
 * Undefined rather than falling back to English piecemeal: a caller in French mode wants either the
 * whole hover translated or, for a square nobody has gotten to, the whole thing in English - never a
 * title that's half one language and half the other because `tooltip` had a translation and `name`
 * didn't.
 */
export function squareTitleFr(challenge: Challenge, set: SquareSetDef): string | undefined {
  if (set.tooltipReplacesName) return challenge.tooltipFr;
  if (challenge.nameFr === undefined) return undefined;
  return challenge.tooltipFr ? `${challenge.nameFr} - ${challenge.tooltipFr}` : challenge.nameFr;
}

export const DEFAULT_SQUARE_SET = "bosses";

/** Falls back to the default for anything unrecognized, so an unknown id can never blank a board. */
export function squareSet(id: string | null | undefined): SquareSetDef {
  return SQUARE_SETS[id ?? ""] ?? SQUARE_SETS[DEFAULT_SQUARE_SET];
}

/** How many distinct squares a set holds - the flat list's length, or the bingo file's `squares`. */
export function squarePool(set: SquareSetDef): number {
  return set.format === "flat" ? set.data.length : set.data.squares.length;
}

/**
 * The biggest board this set can fill without dealing a square twice.
 *
 * A per-set ceiling rather than one number for everything, because the sets are nowhere near the
 * same size: 206 bosses reach a 14x14, the Scadu League's 101 squares stop at 10x10, and offering
 * every host every size meant the small sets quietly doubled up squares to fill the big boards.
 *
 * Answered for the set a room is ACTUALLY on, which matters most for the boss board, since that is
 * two sets wearing one name - the full 206 and the 164-square small-crew cut, whose ceilings are 14
 * and 12. So a room's ceiling moves when the host takes the other cut, and the lobby brings the
 * board size down with it in the same write; see clampBoardSize.
 */
export function maxBoardSize(set: SquareSetDef): number {
  return largestBoardFor(squarePool(set), BOARD_SIZES);
}

/**
 * A board size held to what a set can carry: itself, or the set's ceiling when it is over.
 *
 * The single place both directions of the problem are settled, since a room goes out of range two
 * ways - the host picks a smaller set while sitting on a big board, or takes the boss board's
 * small-crew cut, whose ceiling is two sizes lower. Never raises a size. A host who chose 8x8 means
 * 8x8, and a bigger set is not a reason to redecide that for them.
 */
export function clampBoardSize(boardSize: number, setId: string | null | undefined): number {
  return Math.min(boardSize, maxBoardSize(squareSet(setId)));
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
 *
 * This is a GROUPING answer, so a variant folds into its parent: a 2v2 boss match and a 4v4 boss
 * match are the same board with a different number of squares dealt from it, and splitting the
 * record books down the middle would halve every table to hide a distinction nobody picked. To
 * rebuild a row's board, read `square_set` off it directly - see displaySquareSet.
 */
export function rowSquareSet(row: { square_set?: string | null }): SquareSetId {
  return displaySquareSet(row.square_set);
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
