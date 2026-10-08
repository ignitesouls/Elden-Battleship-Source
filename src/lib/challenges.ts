import {
  squareSet,
  buildBingoBoard,
  buildFlatBoard,
  SQUARE_SETS,
  DEFAULT_SQUARE_SET,
  squareTitle,
  squareTitleFr,
  shortLabel,
  type Challenge,
  type SquareSetId,
  type Region,
} from "./squareSets";
import { rng, seedFrom } from "./seededRandom";
import { BAYLE_SQUARES, igonUnveiled, dealtPool } from "./squareSetFormat";
import { applyBoardPerm } from "./boardBalance";

export type { Challenge, SquareSetId, Region };
export { SQUARE_SETS, SQUARE_SET_LIST, DEFAULT_SQUARE_SET, squareSet } from "./squareSets";
export { rowSquareSet, busiestSquareSet } from "./squareSets";
export { displaySquareSet, squareSetVariants } from "./squareSets";
export { squarePool, maxBoardSize, clampBoardSize } from "./squareSets";
export { REGION_ORDER, REGION_LABELS, colorKeyFor } from "./squareSets";
export type { SquareSetDef, ColorLegendEntry } from "./squareSets";

/**
 * The PRNG a room's deal runs from.
 *
 * Exported, and its own function, because two things now have to agree about it exactly: the deal
 * itself, and lib/undealt.ts, which answers what the deal LEFT OUT. A second copy of this
 * three-line seeding would be a copy that can drift, and a drifted seed there is not a crash - it
 * is a card confidently naming ten bosses that are in fact sitting on the board.
 *
 * The default set seeds from the bare room id, exactly as it did before square sets existed; see
 * challengesForRoom for why that exception can never be tidied away.
 */
export function dealSeed(
  roomId: string,
  setId: SquareSetId | null | undefined,
  seed?: string | null
): () => number {
  const set = squareSet(setId);
  const base = set.id === DEFAULT_SQUARE_SET ? roomId : `${roomId}:${set.id}`;
  return rng(seedFrom(seed ? `${base}:${seed}` : base));
}

/**
 * The board's challenges, derived purely from the room id and its chosen square set.
 *
 * Deliberately not stored in the database: every client seeds the same shuffle from the same
 * room id and independently computes an identical board, so there's nothing to sync, nothing
 * that can drift between players, and no schema change needed to add or reorder challenges.
 *
 * The set id is seeded in alongside the room id, so switching sets in the lobby genuinely
 * reshuffles rather than dealing the same positions out of a different pack.
 *
 * The default set is the exception: it seeds from the bare room id, exactly as it did before square
 * sets existed. Mixing the id in there instead would re-deal every board already in play the moment
 * this deployed - renaming squares under a live match - and would strand the Almanac, which
 * reconstructs finished boards from the room id and could no longer reproduce a single archived one.
 */
export function challengesForRoom(
  roomId: string,
  count: number,
  setId: SquareSetId | null | undefined = DEFAULT_SQUARE_SET,
  /**
   * The room's current randomizer seed, which is rerolled every time the room returns to the lobby.
   *
   * Without it the board is a pure function of the room id, so a second match in the same room
   * dealt exactly the same squares in exactly the same places - the rematch was the same board.
   * Omit (or pass null) to get the original room-id-only board, which is what rooms created before
   * seeds existed still have.
   */
  seed?: string | null,
  /**
   * The room's balanced layout: perm[cell] is the index into the seeded deal that this cell shows.
   *
   * Written once by the balance-board function, after both fleets are locked and before anything is
   * fired, so that neither team's ships end up sitting on a wall of late-game bosses while the
   * other's sit on tutorial soldiers. It reorders the board and never re-picks it - the squares in
   * play stay a pure function of the arguments above, which is what the Almanac's census of unfired
   * squares and auto-fire's flag coverage both rest on.
   *
   * Omit (or pass null) for the unbalanced deal. That is what every room created before balancing
   * existed has, what every archived match has, and what a room gets when the balancer was
   * unreachable - so this must stay a no-op rather than a fallback that guesses.
   */
  perm?: number[] | null,
  /**
   * When this board was dealt - `rooms.seed_set_at`, or `board_dealt_at` on an archived match. Decides
   * whether squares added to the set later are in the deal; see dealtPool. Omit (or pass null) for
   * "before any of them", which is right for every board dealt before the first one was added.
   */
  dealtAt?: string | null
): Challenge[] {
  const set = squareSet(setId);
  const next = dealSeed(roomId, setId, seed);
  const dealt =
    set.format === "bingo"
      ? buildBingoBoard(
          set.data,
          count,
          next,
          set.shortNames,
          set.regions,
          set.colors,
          set.namesFr,
          set.tooltipsFr,
          set.shortNamesFr,
          set.optionsFr
        )
      : buildFlatBoard(dealtPool(set.data, dealtAt), count, next);
  // Applied after the deal and never during it, so the sequence of next() calls above is untouched.
  // Consuming the PRNG differently would re-deal every live board and strand every archived one.
  const board = applyBoardPerm(dealt, perm);
  // Hover text is settled here rather than at each board, because how a square reads on hover
  // depends on which set it came from and this is the last point that knows. See squareTitle.
  //
  // French is resolved in the same place for the same reason, and additively. A bingo board has
  // already resolved `nameFr`/`tooltipFr` through its own %variable% pipeline (see buildBingoBoard)
  // and those values win; a flat set never does that resolution, so its Fr text is a plain lookup
  // by the square's own (English, archived-identity) name here instead - never derived from it, so
  // a square with no translation yet simply carries no Fr text and titleFr comes back undefined,
  // which every renderer must read as "show the English title instead". See squareTitleFr.
  return board.map((c) => {
    const nameFr = c.nameFr ?? set.namesFr?.[c.name];
    const withFr: Challenge = {
      ...c,
      nameFr,
      // Keyed by the English TOOLTIP text, not the name - see the matching note in buildBingoBoard.
      tooltipFr: c.tooltipFr ?? (c.tooltip ? set.tooltipsFr?.[c.tooltip] : undefined),
      // Same authored-wins, else shortLabel(nameFr), else nothing rule buildBingoBoard applies -
      // bingo boards already resolved this themselves (c.shortFr wins below), a flat set never did.
      shortFr: c.shortFr ?? set.shortNamesFr?.[c.name] ?? (nameFr !== undefined ? shortLabel(nameFr) : undefined),
    };
    return { ...withFr, title: squareTitle(c, set), titleFr: squareTitleFr(withFr, set) };
  });
}

/**
 * Works out which square set a finished match was played on, by rebuilding its board with each set
 * and seeing which one puts the recorded names where the log says they were.
 *
 * The Almanac needs this and cannot simply look it up: it reads archived rows long after the room
 * itself has been pruned, and `match_events` records only the squares somebody fired at. Storing
 * the set id on every archived row would answer it for future matches while leaving every match
 * already in the books unreadable; reconstruction answers it for both.
 *
 * Returns null when nothing matches - a set that has changed since the match was played, most
 * likely - and callers should then fall back to what was actually fired at.
 */
export function detectSquareSet(
  roomId: string,
  cells: number,
  fired: Array<{ cell: number; name: string }>,
  seed?: string | null,
  /** The match's balanced layout, or null. Without it a balanced match matches no set at all. */
  perm?: number[] | null,
  /** When the board was dealt, or null - see challengesForRoom. */
  dealtAt?: string | null
): SquareSetId | null {
  if (fired.length === 0) return null;
  // Three is plenty: names are near-unique across sets, and a single agreement could in principle
  // be a name two sets share.
  const sample = fired.slice(0, 3);

  for (const set of Object.values(SQUARE_SETS)) {
    const board = challengesForRoom(roomId, cells, set.id, seed, perm, dealtAt);
    if (sample.every(({ cell, name }) => board[cell]?.name === name)) return set.id;
  }
  return null;
}


/**
 * Memo for bayleCell(), keyed on everything the deal depends on.
 *
 * Worth having because three of the callers - the two overlays and the caster's control page - work
 * out the water inline on every render rather than inside a useMemo, and each of those renders on
 * every realtime tick of a live match. Without this, each tick reshuffles 206 squares to answer a
 * question whose answer was fixed when the board was dealt.
 */
const bayleCellMemo = new Map<string, number | null>();

/**
 * Which cell this room's board put Bayle on, or null if it didn't put him anywhere.
 *
 * Null is the ordinary answer and the reason Igon is rare without any tuning: Bayle is one square
 * out of the 206 the boss set deals from, so a 10x10 lands him about half the time and a 5x5 about
 * one time in eight. Also null for every set that has no arena square at all, `bosses-2v2` included.
 *
 * Lives here rather than in lib/deepWater.ts on purpose. Reconstructing a board means importing the
 * square-set registry, and that registry binds a dozen JSON files - which is exactly why both edge
 * functions and scripts/check-boards.ts mirror challengesForRoom()'s seeding instead of importing
 * it. deepWater.ts is imported by scripts/check-deep-water.ts under bare Node, so it takes the cell
 * as an argument and this is the one place that answers the question.
 *
 * The first arena wins when a board holds more than one. Only the objectives set can manage that -
 * it deals "Kill Bayle the Dread" and the Placidusax pair from the same pool - and either is a
 * square you go and kill Bayle on, so there is no better answer than the earlier cell.
 */
/**
 * Where Igon is allowed to be waiting: Bayle's cell, or null because this room is from before he
 * existed.
 *
 * The gate and the board question are kept apart on purpose. `bayleCell` answers "where did the deal
 * put the dragon", which stays true regardless, and this composes the reveal on top of it - so the
 * one place that decides whether the egg is live reads as a decision rather than as an oddity buried
 * in a lookup. Every caller that feeds deepWater uses THIS one.
 */
export function igonAnchor(room: {
  id: string;
  board_size: number;
  square_set?: string | null;
  seed?: string | null;
  seed_set_at?: string | null;
  board_perm?: number[] | null;
}): number | null {
  return igonUnveiled(room.seed_set_at) ? bayleCell(room) : null;
}

export function bayleCell(room: {
  id: string;
  board_size: number;
  square_set?: string | null;
  seed?: string | null;
  board_perm?: number[] | null;
  seed_set_at?: string | null;
}): number | null {
  const cells = room.board_size * room.board_size;
  const key = `${room.id}:${room.square_set ?? ""}:${room.seed ?? ""}:${room.board_perm?.join(",") ?? ""}:${cells}:${room.seed_set_at ?? ""}`;
  const cached = bayleCellMemo.get(key);
  if (cached !== undefined) return cached;

  const board = challengesForRoom(room.id, cells, room.square_set, room.seed, room.board_perm, room.seed_set_at);
  const found = board.findIndex((c) => BAYLE_SQUARES.has(c.name));
  const cell = found === -1 ? null : found;
  bayleCellMemo.set(key, cell);
  return cell;
}
