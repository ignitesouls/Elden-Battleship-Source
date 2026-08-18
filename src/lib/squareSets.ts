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
  /**
   * The set this one is a smaller cut of, for sets nobody picks by name.
   *
   * A variant is a real set everywhere it has to be one - it has its own id in `rooms.square_set`,
   * its own seeded deal, and its own row in the archive - but it is not a separate BOARD as far as
   * anyone reading the site is concerned. So it never appears in a picker or a records tab, and
   * everything that groups matches by board folds it back into its parent. See displaySquareSet.
   *
   * The alternative - one set id whose contents depend on the room - was the thing to avoid: the
   * board would stop being a pure function of what the database stores, and the Almanac, the
   * overlays and both Edge Functions all rebuild boards from exactly that.
   */
  variantOf?: string;
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
  /**
   * The boss board as it is dealt for small crews: the same set with its 42 longest squares taken
   * out, leaving 164.
   *
   * What comes out is the far end of the game - Bayle, Consort Radahn, Messmer, the Jagged Peak
   * climb, Mohg in the Dynasty - plus the scattered Night's Cavalrys and Deathbirds that cost a
   * detour and settle nothing. On a full crew somebody can be sent for those while the rest of the
   * team keeps working; one or two players cannot, so on a small crew they are squares that sit
   * there all match and quietly decide it by never being touched.
   *
   * Nobody picks this. The lobby has one "Bosses" button and this is what it means when every team
   * is one or two players - see bossSetForRoster and the sync in LobbyPhase. It is hidden rather
   * than offered because it is not a different board to play, it is the same board sized to the
   * room, and a second entry in the picker would make it a decision players have to have opinions
   * about.
   */
  "bosses-2v2": {
    id: "bosses-2v2",
    label: "Bosses",
    blurb: "The boss board, minus the squares a crew of one or two can never get to.",
    format: "flat",
    data: bossData2v2 as Challenge[],
    tooltipReplacesName: true,
    variantOf: "bosses",
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
 */
export function squareSetVariants(id: string | null | undefined): SquareSetId[] {
  const parent = displaySquareSet(id);
  return [parent, ...Object.values(SQUARE_SETS).filter((s) => s.variantOf === parent).map((s) => s.id)];
}

/**
 * Which cut of the boss board a room's roster calls for.
 *
 * One or two players on every team gets the trimmed set; three or more on any team gets the full
 * one. The rule reads the biggest team rather than the total, because what decides whether the far
 * end of the map is reachable is how many people one team can spare - a 2v2 and a 1v1 are the same
 * problem, and a 3v3 is not.
 *
 * Spectators (`team === null`) are not players and never count. A lobby with nobody on a team yet
 * has no roster to read and gets the full set, which is the default - though the sync in
 * retargetBossSet declines to ACT on that, since an empty roster is not evidence of anything.
 */
export function bossSetForRoster(players: Array<{ team: number | null }>): SquareSetId {
  const sizes = new Map<number, number>();
  for (const p of players) {
    if (p.team === null || p.team === undefined) continue;
    sizes.set(p.team, (sizes.get(p.team) ?? 0) + 1);
  }
  if (sizes.size === 0) return DEFAULT_SQUARE_SET;
  const biggest = Math.max(...sizes.values());
  return biggest <= 2 ? "bosses-2v2" : DEFAULT_SQUARE_SET;
}

/**
 * Keeps a room on the right cut of the boss board as people arrive and leave, or null if it is
 * already there.
 *
 * Only ever moves a room BETWEEN the boss sets. A room on an objectives set has been deliberately
 * put there and must stay, and that is the whole guard - without it a full lobby switching to
 * Objectives would be dragged back to the boss board by its own roster.
 *
 * A lobby with nobody on a team yet is left alone rather than sent to the default. Everyone being
 * on no team is a state a room passes THROUGH - it is how a freshly made room starts and what a
 * shuffle of fleets looks like halfway - and reading it as "this is a big-crew match" would re-deal
 * the board twice for a room that never changed its mind.
 */
export function retargetBossSet(
  current: string | null | undefined,
  players: Array<{ team: number | null }>
): SquareSetId | null {
  if (displaySquareSet(current) !== DEFAULT_SQUARE_SET) return null;
  if (!players.some((p) => p.team !== null && p.team !== undefined)) return null;
  const want = bossSetForRoster(players);
  return want === (current ?? DEFAULT_SQUARE_SET) ? null : want;
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
