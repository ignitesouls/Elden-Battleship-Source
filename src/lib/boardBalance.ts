/**
 * Evening up a board against the fleets that are about to be shot at on it.
 *
 * Every team fires at the SAME named grid, so a match's whole competitive asymmetry is which bosses
 * happen to sit on which fleet's cells. Nobody chooses that - the board is dealt from a seed struck
 * before a single ship was placed - and it decides matches.
 *
 * So the deal is finished after placement instead of before it. The squares stay exactly the squares
 * the seed chose; only their positions move.
 *
 * -- Reachability, not difficulty ----------------------------------------------------------------
 *
 * The cost of a square is how often it actually gets fired at, measured over the archive - not how
 * hard the boss is to kill. Those turned out to be different questions, and only the first one
 * decides matches. Starscourge Radahn is a wall of a fight and is taken on every board he appears
 * on; Caelid Duelist is a tier-7 pushover reached on 18% of boards, because it sits at the end of a
 * ride nobody makes. A fleet parked on squares like that is close to untouchable however easy its
 * bosses are. See scripts/build-reachability.mjs for where the numbers come from and why they are
 * frozen between seasons.
 *
 * A fleet's burden is therefore the sum of (1 - reach) over its cells: the expected number of its
 * cells the enemy never gets to. Plain linearity of expectation, no independence assumed, and it
 * reads in units anyone can argue with - "they have three more untakeable squares than we do".
 *
 * -- Why it rejects rather than optimises --------------------------------------------------------
 *
 * The first version of this searched: it swapped squares around until the fleets' totals were inside
 * a tolerance band. That was metagameable, and inevitably so. A search that pushes toward a target
 * leaves the answer sitting against that target, and any pass that "corrects" a board is a pass
 * whose corrections can be learned and played around. Players found it within a season.
 *
 * This draws instead. Take a fresh random layout, test it, and if it fails throw it away and draw
 * another. The board that gets played is then a uniform sample from the set of layouts that pass -
 * there is no search dynamic to reverse-engineer, no edge of a band to sit against, and nothing
 * about the accepted layout that a rejected one would not equally have had.
 *
 * -- Why the tests are tight, having once been loose ---------------------------------------------
 *
 * The tests started deliberately loose, on the reasoning that a test which almost never binds tells
 * a player almost nothing. Nine boards in ten passed on the first draw and were therefore layouts
 * nothing had looked at.
 *
 * The price of that was a board nobody could defend. A 24-cell fleet was permitted a burden gap of
 * 3.5 and a difference of SIX untakeable squares, and a real match shipped with one fleet holding
 * four squares the enemy reaches under 35% of the time against the other fleet's one. It passed
 * with room to spare, because it was built to.
 *
 * So the tests are tight now, and the reason that is safe is the paragraph above rather than the
 * looseness: rejection sampling is unbiased at ANY threshold. Tightening does not bring back the
 * exploit that killed the searching version, because there is still no search - no gradient to
 * follow, no band edge for a layout to come to rest against, and no way to tell an accepted layout
 * from one that got there on the first draw.
 *
 * What tightening does cost is inference about the CONSTRAINT. A player who knows the two fleets
 * hold equal numbers of untakeable squares, and who can see the board and their own fleet, learns
 * something about the distribution of the enemy's. That is a real leak and it is worth naming - but
 * it is symmetric, it names no cell, and it is a far smaller edge than reading a lopsided board off
 * the screen and knowing the match was decided before anyone fired.
 *
 * Measured over 600 boards per configuration: two-team boards accept 100% of the time at every size,
 * at a median of 7 redraws on a 10x10 and 3 on a 12x12. Small boards work hardest - a 7x7 runs to
 * about 29 draws - because a fraction-of-fleet threshold bites hardest on a short fleet.
 *
 * -- Why declumping is exempt from all that ------------------------------------------------------
 *
 * Region declumping is not a rejection test; every candidate layout is spread out before it is ever
 * scored. That is safe for a reason worth stating: crowding is a function of the visible board
 * alone. It does not know where any ship is, so conditioning on it publishes nothing that was not
 * already going to be on screen. Only the fairness tests touch hidden fleet positions.
 *
 * -- Why it only ever permutes -------------------------------------------------------------------
 *
 * The output is an index per cell into the seeded board, never a board. Which squares are in play
 * therefore remains a pure function of (room id, square set, seed), which is what auto-fire's flag
 * coverage, the Almanac's census of squares nobody fired at, and archived-match replay all rest on.
 * A balanced board is the same pack of cards in a different order.
 *
 * Deliberately import-free, like squareSetFormat.ts and for the same reason: the Deno edge function
 * that runs this in production and the check script that tests it both read this exact file, so
 * there is no second implementation to drift.
 */

/**
 * Reorders a dealt board into its balanced layout: out[cell] = board[perm[cell]].
 *
 * Lives here, beside the thing that produces the permutation, because it has two consumers that
 * must never disagree - challengesForRoom, which decides what a player sees on a cell, and
 * auto-fire, which decides which cell a boss kill fires at. Two copies of this that drifted would
 * put a kill on the square that boss used to be on: a shot that lands, reports a hit or a miss, and
 * is wrong, with no undo. One implementation is the only version of this that is safe.
 *
 * Ignores a permutation that does not describe this board - wrong length, or an index out of range -
 * and returns the plain deal instead. A room whose board_size changed under a stored layout, or a
 * truncated write, should show the honest unbalanced board rather than one with holes in it: every
 * consumer treats a missing square as "no square", which would read as a cell nobody can ever fire
 * at and no kill can ever resolve to.
 */
export function applyBoardPerm<T>(board: T[], perm?: number[] | null): T[] {
  if (!perm || perm.length !== board.length) return board;
  const out: T[] = new Array(board.length);
  for (let cell = 0; cell < board.length; cell++) {
    const from = perm[cell];
    if (!Number.isInteger(from) || from < 0 || from >= board.length) return board;
    out[cell] = board[from];
  }
  return out;
}

/**
 * How many unreached cells two fleets may differ by, per cell of fleet.
 *
 * 0.03 is 0.51 cells on a 17-cell fleet: the two fleets must be within about half a square of each
 * other in expected-unreached terms. That is roughly a tenth of a fleet's own burden of ~5.3, and
 * it is deliberately tight.
 *
 * -- Why this used to be five times looser, and why that was wrong -------------------------------
 *
 * It was 2.5/17, chosen so the test would almost never bind - the argument being that a test which
 * rarely fires gives nothing away about where anybody's ships are, and that a full crew can send
 * somebody to cover a bad square anyway. Both halves of that turned out to be worth less than the
 * fairness they were paying for. A 24-cell fleet was allowed a gap of 3.5 and a difference of SIX
 * untakeable squares, and a real match duly shipped with one fleet holding four squares the enemy
 * reaches under 35% of the time against the other's one. Nothing flagged it, because nothing was
 * meant to: it passed with room to spare.
 *
 * The cost of tightening it is close to nothing, which is the part that settles the argument. Over
 * 600 dealt boards per configuration, two-team boards accept on 100% of draws at every size, at a
 * median of 7 redraws on a 10x10 and 3 on a 12x12. Mean gap actually played falls from 0.88 to 0.25
 * on a 10x10, and the mean difference in untakeable squares falls from 1.28 to 0.00.
 *
 * -- Why a flat fraction already makes small boards stricter -------------------------------------
 *
 * The gap between two fleets is a difference of sums, so its spread grows like the square root of
 * the fleet, while a threshold set as a fraction of the fleet grows with the fleet itself. Small
 * boards are therefore held to a tighter standard automatically, without a second dial to tune -
 * which is why the redraw loop works harder on a 7x7 than on a 12x12 and why the small boards are
 * where the budget below actually gets spent.
 */
export const GAP_PER_CELL = 0.03;

/**
 * Below this reach, a square counts as one the enemy probably never gets to.
 *
 * 0.4 is where the archive thins out: 31 of 206 squares sit below it, against 86 above 0.8. Those 31
 * are the ones that decide whether a fleet can be finished off at all.
 */
export const HARD_REACH = 0.4;

/**
 * How many more hard-to-reach squares one fleet may hold than another, per cell of fleet.
 *
 * A second test, because the sum above is an average and averages hide bottlenecks: a fleet holding
 * two untakeable squares among fifteen easy ones can total the same as one holding fifteen medium
 * squares, and those are not the same match.
 *
 * 0.08 rounds to a limit of 1 on fleets up to 17 cells and 2 on a 24-cell one - so on most boards
 * the two fleets must hold the SAME number of untakeable squares, not merely a similar number. The
 * old 5/17 allowed six apart on a 24-cell fleet, which is the hole SILENTBARNACLE went through.
 */
export const HARD_GAP_PER_CELL = 0.08;

/**
 * Floor for the hard-square test, however small the fleet.
 *
 * One, so the smallest fleets are held to an exact match rather than being allowed a free square.
 * This used to be two on the reasoning that a gap of one is noise - true of a single board, but the
 * point of the test is not to spot a fluke, it is to refuse to PLAY one when a redraw is free.
 */
export const MIN_HARD_GAP = 1;

/**
 * How many layouts to draw before giving up and playing the best one seen.
 *
 * 300 rather than the 60 this started at, because the tests above now bind on most boards instead of
 * almost none. Median draws are 7 on a 10x10 and 3 on a 12x12, but small boards work much harder -
 * a 7x7 runs to about 29 - and the cost of an extra draw is a shuffle and a declumping pass. If the
 * limit is ever actually reached the fallback is the fairest layout of the three hundred, which is
 * strictly better than the deal.
 *
 * Worth knowing where the ceiling is: 300 spent draws is 413ms on a 10x10, and startBattle awaits
 * this. See BALANCE_TIMEOUT_MS in lib/rooms.ts, which has to be comfortably above that plus the
 * function's own cold start and its half-dozen queries.
 */
const MAX_ATTEMPTS = 300;

/**
 * How far apart two fleets' ships may be at the same rank, in seconds.
 *
 * The one fairness number. Ships are sorted longest-first within each fleet and compared position
 * by position - longest against longest, cheapest against cheapest - and no pair may differ by more
 * than this.
 *
 * Rank by rank rather than by any single summary, because a summary is what let the bad boards
 * through. On the match that prompted all of this, both fleets took about 86 minutes to eliminate:
 * identical by any maximum, and identical by total to within a few percent. What differed was the
 * bottom of the list. One fleet's cheapest ship was gated at 76:56; the other's at 50:52, with a
 * second at 69:16. For the first seventy minutes of an eighty-two minute match, one side could take
 * ships off the board and the other could not. That is the whole match, and only a rank-by-rank
 * comparison sees it.
 *
 * Five minutes, from a sweep over 250 dealt boards per configuration. Two-team boards accept on
 * 100% of draws at 10x10 and 12x12, at a median of 11 and 13 redraws, and the gap actually played
 * settles around 3:50. A 7x7 small-crew board accepts 87% - the rest are held up by the DLC floor
 * rather than by this - and falls back to the fairest layout drawn.
 *
 * Five is chosen because it is where the cost stops falling: the sweep gains almost nothing going
 * looser and the acceptance rate is already saturated, so there is no argument for spending fairness
 * on redraws nobody needs. For scale, the board that prompted this had a rank-7 gap of 26 minutes -
 * one fleet's cheapest ship gated at 50:52 against the other's 76:56 - which fails this five times
 * over.
 */
export const RANK_GAP_SECONDS = 5 * 60;

/**
 * The scale clumping is measured at: every 3x3 patch of the grid.
 *
 * Chosen because it is the scale the problem is reported at - "eight DLC bosses in a ten-square
 * area" is a complaint about a patch, not about which squares happen to touch.
 */
const DECLUMP_WINDOW = 3;

/**
 * How much of a draw's natural region crowding to break up.
 *
 * 0.75 rather than zero, because the floor here is not an even sprinkle: with twenty DLC squares on
 * a hundred cells some patch is always crowded by luck, and a board driven to its true minimum stops
 * looking dealt and starts looking sorted - which is its own kind of tell.
 */
const DECLUMP_TARGET = 0.75;

/** Iteration cap for one declumping pass. Convergence is typically a few thousand. */
const MAX_DECLUMP_SWAPS = 12000;

/** How many candidate cells the crowded end of a declumping swap is drawn from. */
const SAMPLE = 8;

/**
 * The tests a layout has to pass.
 *
 * One profile for every board; the small-crew cut differs only by carrying a region floor. See
 * RANK_GAP_SECONDS for what the numbers mean and smallCrewFloor for the floor.
 */
export interface BalanceRules {
  /** How far apart two fleets' ships may be at the same rank, in seconds. See RANK_GAP_SECONDS. */
  rankGapSeconds: number;
  /** How many layouts to draw before playing the best one seen. */
  maxAttempts: number;
  /**
   * A region every fleet must hold at least  squares of, or null for no such requirement.
   *
   * The region is NAMED BY THE CALLER rather than known here, which keeps this module's promise that
   * region strings are only ever compared for equality and what they mean is nobody's business but
   * the board's.  likewise comes from the caller - it depends on how many squares the board is
   * dealt, which is a property of the room. See regionFloorFor.
   */
  regionFloor: { region: string; min: number } | null;
}

/** The tests every board is held to. A small-crew board adds a region floor on top. */
export const DEFAULT_RULES: BalanceRules = {
  rankGapSeconds: RANK_GAP_SECONDS,
  maxAttempts: MAX_ATTEMPTS,
  regionFloor: null,
};

/**
 * How many squares of the floored region each fleet must hold, on a board this size.
 *
 * Two, except on a 5x5, where the board is only dealt three or four DLC squares in the first place
 * and a floor of two per fleet is unsatisfiable on more than half of them. One there is a real
 * requirement rather than an aspiration, which is the difference between a rule and a wish.
 */
export function regionFloorFor(boardSize: number): number {
  return boardSize <= 5 ? 1 : 2;
}

/**
 * The DLC floor a small-crew board additionally carries. See regionFloorFor.
 *
 * Two-team boards, the case it exists for, satisfy it on 91.5% of 7x7 draws and 98.5% and up from
 * 8x8. Three-team boards often cannot - a floor of 2 across three fleets wants six DLC squares and
 * a quarter of 7x7 deals do not contain six - and fall back to the fairest layout drawn.
 */
export function smallCrewFloor(region: string, boardSize: number): BalanceRules['regionFloor'] {
  return { region, min: regionFloorFor(boardSize) };
}

export interface BalanceInput {
  /**
   * Seconds of a match each cell's square costs, in seeded board order.
   *
   * Generated into src/data/bossTimeCost.json - the expected time before that square is done, with
   * matches that ended first treated as censored rather than as evidence it is unreachable. Replaced
   * a 0-1 "share of boards it was fired at on", which asked how PROBABLE a square was when what
   * decides matches is how EXPENSIVE it is; see the header of build-time-cost.mjs.
   */
  cost: number[];
  /**
   * Region per cell, in the same seeded board order. Omit to skip declumping entirely.
   *
   * Only ever compared for equality, so what the strings mean is none of this module's business -
   * it spreads out whatever the board says belongs together.
   */
  regions?: Array<string | null | undefined>;
  /** Grid width. Defaults to the square root of the cell count, which every board size satisfies. */
  boardSize?: number;
  /**
   * Per team, the cells of each of its SHIPS separately. Teams with no ships are ignored.
   *
   * Per ship rather than a flat cell list, and that distinction is the whole test. A ship is sunk
   * only when every one of its cells has been fired at, so the time to take it off the board is the
   * time to finish the SLOWEST square on it - one expensive cell gates a five-cell Carrier however
   * quick its other four are. Flattening a fleet into cells averages that away and hides the thing
   * that decides matches.
   */
  fleets: Array<{ team: number; ships: number[][] }>;
  next: () => number;
  /** Which profile of tests to hold this board to. Omit for the original, loose ones. */
  rules?: BalanceRules;
}

export interface BalanceResult {
  /** perm[cell] = index into the seeded board that this cell should show. */
  perm: number[];
  /** The widest same-rank gap between two fleets, in the seeded deal and in the accepted layout. */
  rankGapBefore: number;
  rankGapAfter: number;
  /** The threshold this board was held to, in seconds. */
  rankLimit: number;
  /**
   * The fewest floored-region squares any one fleet ends up holding, or null when no floor applied.
   *
   * The number worth logging: it is what the floor was trying to raise, and comparing it to
   * `rules.regionFloor.min` says at a glance whether this board met the requirement or fell back
   * because no layout could.
   */
  regionLow: number | null;
  /**
   * How many layouts were drawn. One means the first fleet-blind draw passed, which is the ordinary
   * case and the one where nothing about the fleets influenced the board at all.
   */
  attempts: number;
  /** Whether the layout being returned passes both tests. False only if MAX_ATTEMPTS ran out. */
  accepted: boolean;
  /** False when there was nothing to balance - one fleet, or no fleet with any ships. */
  balanced: boolean;
  /**
   * Region crowding of the raw deal and of the accepted layout - the summed patch score described
   * at DECLUMP_WINDOW. Null when no regions were supplied, or the board is too small for a patch.
   */
  clumpBefore: number | null;
  clumpAfter: number | null;
}

/**
 * The threshold a board is held to.
 *
 * Takes no fleet size any more, and that is the point: the old thresholds scaled with the number of
 * CELLS a fleet covered, which quietly said that a bigger fleet deserved a bigger unfairness. A rank
 * gap is a comparison between two individual ships, so the same number is right on every board.
 *
 * Exported because the checker asserts against it and the edge function reports it.
 */
export function limitsFor(rules: BalanceRules = DEFAULT_RULES): { rankGap: number } {
  return { rankGap: rules.rankGapSeconds };
}

/** Widest minus narrowest. Fewer than two values means there is no gap to speak of. */
function spread(values: number[]): number {
  if (values.length < 2) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

/**
 * Balances a seeded board against the fleets placed on it.
 *
 * Never throws and never refuses: a board with nothing to balance comes back as the identity
 * permutation, which is the board the seed dealt and the game as it played before any of this
 * existed.
 */
export function balanceBoard(input: BalanceInput): BalanceResult {
  const { cost, regions, fleets, next } = input;
  const rules = input.rules ?? DEFAULT_RULES;
  const cells = cost.length;
  const size = input.boardSize ?? Math.round(Math.sqrt(cells));

  // Neither region rule can apply unless the board said which squares are in which region.
  const floor = regions && rules.regionFloor ? rules.regionFloor : null;

  // perm[cell] -> board index. Starts as identity, i.e. exactly the seeded deal.
  const perm: number[] = new Array(cells);
  for (let i = 0; i < cells; i++) perm[i] = i;

  // Each fleet as a list of ships, each ship a list of cells, bounds-checked. A cell several fleets
  // occupy counts toward every one of them: a hull sitting on a square the enemy happens to be
  // sitting on too still has to be shot off it, so it is part of what that fleet costs to sink.
  const active: number[][][] = [];
  for (const fleet of fleets) {
    const ships: number[][] = [];
    for (const ship of fleet.ships ?? []) {
      const own = new Set<number>();
      for (const c of ship) {
        if (Number.isInteger(c) && c >= 0 && c < cells) own.add(c);
      }
      if (own.size > 0) ships.push([...own]);
    }
    if (ships.length > 0) active.push(ships);
  }

  /** Every cell a fleet holds, for the region floor - which counts squares, not ships. */
  const cellsOfFleet = (ships: number[][]) => {
    const out = new Set<number>();
    for (const s of ships) for (const c of s) out.add(c);
    return out;
  };

  const { rankGap: rankLimit } = limitsFor(rules);

  /**
   * A fleet's cost profile: what each of its ships costs, longest first.
   *
   * A ship costs the slowest square on it, because it only sinks once every one of its cells has
   * been fired at. Sorting matters as much as the maximum does - two fleets can have identical
   * longest ships and still be nothing like each other if one of them has a ship that falls in half
   * the time, which is the ship that gets picked off while the match is still being played.
   */
  const profileOf = (ships: number[][]) =>
    ships.map((s) => Math.max(...s.map((c) => cost[perm[c]]))).sort((a, b) => b - a);

  /** All the fairness measures for the layout `perm` currently describes. */
  const measure = () => {
    const profiles = active.map(profileOf);

    // Compared RANK BY RANK: the longest ship against the longest, the shortest against the
    // shortest. A single summary - the max, or a total - is what let a board through where both
    // fleets took about 86 minutes to eliminate but one of them had a ship gated at 50 minutes and
    // the other's cheapest was 77. Ranks past the shortest fleet's length are not compared, because
    // a fleet with fewer ships has nothing to put opposite them.
    const ranks = Math.min(...profiles.map((p) => p.length));
    let worstRank = 0;
    for (let i = 0; i < ranks; i++) {
      const at = profiles.map((p) => p[i]);
      worstRank = Math.max(worstRank, spread(at));
    }

    // The fewest floored-region squares any fleet holds. Null with no floor, so the acceptance test
    // reads the same either way and nothing has to branch on whether a floor exists.
    let low: number | null = null;
    if (floor) {
      low = Infinity;
      for (const ships of active) {
        let inRegion = 0;
        for (const c of cellsOfFleet(ships)) if (regions?.[perm[c]] === floor.region) inRegion++;
        low = Math.min(low, inRegion);
      }
      if (low === Infinity) low = null;
    }

    return { rankGap: worstRank, profiles, regionLow: low };
  };

  const before = measure();

  // -- region crowding ---------------------------------------------------------------------------
  // Every DECLUMP_WINDOW-square patch of the grid scores the sum of the squares of its per-region
  // counts, and the board scores the sum over all patches. Squaring is what makes it a crowding
  // measure rather than a counting one: nine squares spread one-per-region score 9, and nine of the
  // same region score 81, so the number is dominated by exactly the patches worth breaking up.
  //
  // Held in flat arrays with running per-patch subtotals so a swap costs a couple of dozen
  // operations instead of a rescan - this runs thousands of times per attempt.
  const W = DECLUMP_WINDOW;
  const perRow = size - W + 1;
  const windowCount = perRow > 0 ? perRow * perRow : 0;
  const declumping = Boolean(regions) && windowCount > 0;

  /** Region as a small integer per BOARD index, -1 for a square with no region. */
  const regionId: number[] = [];
  let regionCount = 0;
  if (declumping) {
    const ids = new Map<string, number>();
    for (let i = 0; i < cells; i++) {
      const r = regions?.[i];
      if (r === null || r === undefined) {
        regionId.push(-1);
        continue;
      }
      let id = ids.get(r);
      if (id === undefined) {
        id = ids.size;
        ids.set(r, id);
      }
      regionId.push(id);
    }
    regionCount = ids.size;
  }

  /** Which patches each cell belongs to. At most W*W of them. */
  const patchesOf: number[][] = [];
  if (declumping) {
    for (let c = 0; c < cells; c++) patchesOf.push([]);
    let w = 0;
    for (let r = 0; r + W <= size; r++) {
      for (let k = 0; k + W <= size; k++) {
        for (let dr = 0; dr < W; dr++) {
          for (let dk = 0; dk < W; dk++) patchesOf[(r + dr) * size + (k + dk)].push(w);
        }
        w++;
      }
    }
  }

  const counts = declumping ? new Int32Array(windowCount * regionCount) : new Int32Array(0);
  const patchScore = declumping ? new Int32Array(windowCount) : new Int32Array(0);
  let crowding = 0;

  /** Rebuilds the patch tallies from whatever the permutation currently says. */
  const measureCrowding = () => {
    if (!declumping) return 0;
    counts.fill(0);
    for (let c = 0; c < cells; c++) {
      const r = regionId[perm[c]];
      if (r < 0) continue;
      for (const w of patchesOf[c]) counts[w * regionCount + r]++;
    }
    crowding = 0;
    for (let w = 0; w < windowCount; w++) {
      let s = 0;
      for (let r = 0; r < regionCount; r++) {
        const n = counts[w * regionCount + r];
        s += n * n;
      }
      patchScore[w] = s;
      crowding += s;
    }
    return crowding;
  };

  const clumpBefore = declumping ? measureCrowding() : null;

  // One fleet, or fleets whose cells all coincide, means there is no asymmetry to even out. With no
  // regions either there is nothing left to do at all, so the seeded deal stands.
  const canBalance = active.length >= 2;
  if (!canBalance && !declumping) {
    return {
      perm,
      rankGapBefore: before.rankGap,
      rankGapAfter: before.rankGap,
      rankLimit,
      regionLow: before.regionLow,
      attempts: 0,
      accepted: true,
      balanced: false,
      clumpBefore,
      clumpAfter: clumpBefore,
    };
  }

  // -- declumping ---------------------------------------------------------------------------------
  // Runs on every candidate before it is scored, and never looks at a fleet. See the header for why
  // that exemption is safe: crowding is a property of the board everyone is about to see.
  const mark = new Int32Array(declumping ? windowCount : 0);
  let stamp = 0;

  /** Moves one cell's region from `from` to `to` across a patch, keeping its subtotal current. */
  const shift = (w: number, from: number, to: number) => {
    if (from >= 0) {
      const i = w * regionCount + from;
      const n = counts[i];
      patchScore[w] -= 2 * n - 1;
      crowding -= 2 * n - 1;
      counts[i] = n - 1;
    }
    if (to >= 0) {
      const i = w * regionCount + to;
      const n = counts[i];
      patchScore[w] += 2 * n + 1;
      crowding += 2 * n + 1;
      counts[i] = n + 1;
    }
  };

  /**
   * Trades the regions of two cells across every patch that holds exactly one of them.
   *
   * Patches holding BOTH are skipped, and not as an optimisation: such a patch loses and regains
   * each region in the same breath, so its counts are unchanged and touching it would be a pair of
   * cancelling edits to a running total. Calling this again with the regions reversed undoes it.
   */
  const shiftPair = (a: number, b: number, ra: number, rb: number) => {
    stamp++;
    for (const w of patchesOf[b]) mark[w] = stamp;
    for (const w of patchesOf[a]) if (mark[w] !== stamp) shift(w, ra, rb);
    stamp++;
    for (const w of patchesOf[a]) mark[w] = stamp;
    for (const w of patchesOf[b]) if (mark[w] !== stamp) shift(w, rb, ra);
  };

  /** How crowded the patches around a cell are, which is what makes it worth moving. */
  const pressure = (cell: number) => {
    let s = 0;
    for (const w of patchesOf[cell]) s += patchScore[w];
    return s;
  };

  const declump = () => {
    if (!declumping) return;
    const target = measureCrowding() * DECLUMP_TARGET;
    for (let i = 0; i < MAX_DECLUMP_SWAPS && crowding > target; i++) {
      // Biased toward cells sitting in the most crowded patches. Uniform draws spend most of their
      // budget on squares that were never part of a clump.
      let a = Math.floor(next() * cells);
      for (let k = 1; k < SAMPLE; k++) {
        const c = Math.floor(next() * cells);
        if (pressure(c) > pressure(a)) a = c;
      }
      // The destination stays uniform: the point is to send the crowd somewhere unremarkable, and
      // choosing that end too would start carving a pattern.
      const b = Math.floor(next() * cells);
      if (a === b) continue;

      const ra = regionId[perm[a]];
      const rb = regionId[perm[b]];
      if (ra === rb) continue; // same region, or both regionless: nothing to spread

      const was = crowding;
      shiftPair(a, b, ra, rb);
      if (crowding < was) {
        const t = perm[a];
        perm[a] = perm[b];
        perm[b] = t;
      } else {
        shiftPair(a, b, rb, ra);
      }
    }
  };

  // -- draw until one passes ----------------------------------------------------------------------
  // A fresh uniform layout every time, declumped, then tested. Nothing carries over between
  // attempts: a rejected layout is discarded whole rather than repaired, which is what keeps the
  // accepted one an unbiased draw from the layouts that pass rather than a walk toward the line.
  let best: number[] | null = null;
  let bestGap = Infinity;
  let bestLow: number | null = floor ? -1 : null;
  let bestClump = clumpBefore;
  let attempts = 0;
  let accepted = false;

  while (attempts < rules.maxAttempts) {
    attempts++;
    for (let i = cells - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    declump();

    const now = measure();
    const floorMet = !floor || (now.regionLow ?? 0) >= floor.min;
    if (!canBalance || (now.rankGap <= rankLimit && floorMet)) {
      best = perm.slice();
      bestGap = now.rankGap;
      bestLow = now.regionLow;
      bestClump = declumping ? crowding : null;
      accepted = true;
      break;
    }
    // Keep the fairest layout seen, in case every attempt is spent. Ranked by the region floor
    // first, then the rank gap: a board dealt too few DLC squares can never satisfy the floor, so
    // the fallback should at least hand each fleet as many as exist, and only then argue about
    // which of two equally DLC-poor layouts pairs the ships up better.
    const low = now.regionLow ?? 0;
    const better =
      floor && low !== (bestLow ?? 0) ? low > (bestLow ?? 0) : now.rankGap < bestGap;
    if (better) {
      best = perm.slice();
      bestGap = now.rankGap;
      bestLow = now.regionLow;
      bestClump = declumping ? crowding : null;
    }
  }

  const chosen = best ?? perm;
  for (let i = 0; i < cells; i++) perm[i] = chosen[i];

  return {
    perm,
    rankGapBefore: before.rankGap,
    rankGapAfter: bestGap,
    rankLimit,
    regionLow: bestLow === -1 ? null : bestLow,
    attempts,
    accepted,
    balanced: canBalance,
    clumpBefore,
    clumpAfter: bestClump,
  };
}
