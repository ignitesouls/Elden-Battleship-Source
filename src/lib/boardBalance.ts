/**
 * Evening up a board against the fleets that are about to be shot at on it.
 *
 * Every team fires at the SAME named grid, so a match's whole competitive asymmetry is which bosses
 * happen to sit on which fleet's cells. Nobody chooses that: the board is dealt from a seed struck
 * before a single ship was placed. And it decides matches.
 *
 * So the deal is finished after placement instead of before it. The squares stay exactly the squares
 * the seed chose; only their positions move.
 *
 * -- What a square costs -------------------------------------------------------------------------
 *
 * Minutes of a match, not boss difficulty: the expected time before somebody fires at that square,
 * measured over the archive. Those turned out to be different questions, and only the first decides
 * matches. Starscourge Radahn is a wall of a fight and everyone takes him early; Caelid Duelist is a
 * tier-7 pushover at the end of a ride nobody makes, and costs half an hour more than Malenia. A
 * fleet parked on squares like that is close to untouchable however easy its bosses are. See
 * scripts/build-time-cost.mjs for where the numbers come from and why they are frozen between
 * seasons.
 *
 * A time can be compared against how long a match actually lasts, which is what every test below
 * rests on. It also reads in units anyone can argue with: "their cheapest ship is gated 26 minutes
 * later than ours".
 *
 * -- Why it rejects rather than optimises --------------------------------------------------------
 *
 * The first version of this searched: it swapped squares around until the fleets' totals were inside
 * a tolerance band. That was metagameable, and inevitably so. A search that pushes toward a target
 * leaves the answer sitting against that target, and corrections a player can learn are corrections
 * a player can play around. Players found it within a season.
 *
 * This draws instead. Take a fresh random layout, test it, and if it fails throw it away and draw
 * another. The board that gets played is a uniform sample from the layouts that pass. There is no
 * search to reverse-engineer, no edge of a band to sit against, and nothing about the accepted
 * layout that a rejected one would not equally have had.
 *
 * -- Why the tests are tight, having once been loose ---------------------------------------------
 *
 * The tests started deliberately loose, on the reasoning that a test which almost never binds tells
 * a player almost nothing. Nine boards in ten passed on the first draw and were therefore layouts
 * nothing had looked at.
 *
 * The price was a board nobody could defend: a real match shipped with one fleet holding four
 * squares the enemy hardly ever reaches against the other fleet's one. It passed with room to
 * spare, because it was built to.
 *
 * The tests are tight now, and that is safe for the reason above: rejection sampling is unbiased at
 * ANY threshold. Tightening does not bring back the exploit that killed the searching version,
 * because there is still no search - no gradient to follow, and no band edge for a layout to come to
 * rest against.
 *
 * What tightening does cost is inference about the CONSTRAINT. A player who knows the two fleets
 * hold equal numbers of long squares, and who can see the board and their own fleet, learns
 * something about the enemy's. That is a real leak, and worth naming. But it is symmetric, it names
 * no cell, and it is far smaller than reading a lopsided board off the screen and knowing the match
 * was decided before anyone fired.
 *
 * -- Why there are three tests and not one --------------------------------------------------------
 *
 * The rank gap prices a ship at its slowest square, which is right about when a ship SINKS and blind
 * to everything else about it. Seven ships on a 24-cell fleet is seven numbers out of twenty-four,
 * and the rank comparison then collapses those seven into one. Two fleets can match on it exactly
 * and still be nothing alike: one with four cells the enemy clears inside half an hour, the other
 * with no cell under forty minutes anywhere.
 *
 * So a second test counts whole squares instead of measuring seconds: neither fleet may hold more
 * than one more square past the long-square line than the other. It asks a coarser question, and the
 * coarser question is the one this cost model can answer honestly. See LONG_GAP for the board that
 * made the case and for what the model's resolution actually is.
 *
 * And a third test prices a ship at its CHEAPEST square instead of its slowest, because a ship has
 * two moments that matter and those tests only ever measured one of them. A ship is FOUND the first
 * time anything lands on it and CLEARED when the last of its cells has been fired at, and the whole
 * middle of a match happens between those two events - the enemy knows where a hull is, works out
 * which way it lies, and picks it apart. See FIND_GAP_SECONDS for the archive that says the two are
 * nearly independent and for what a fleet that is fair on one and lopsided on the other plays like.
 *
 * What each test is worth, measured as the share of layouts it rejects that the OTHER tests would
 * have shipped - which is the only question that says whether a test earns its redraws:
 *
 *     long-square   15% at 8x8, 18% at 10x10, 31% at 12x12
 *     find gap      71% at 8x8, 72% at 10x10, 73% at 12x12
 *
 * The find gap is by a distance the most interventionist rule here, and that is a statement about
 * how badly the first two tests were missing an entire half of a ship rather than about the
 * threshold being severe - it sits at twice the rank gap's, for reasons under FIND_GAP_SECONDS.
 * Two-team boards still accept at every size and every preset, with the worst of 150 boards taking
 * 651 draws of a 900 budget.
 *
 * -- Why declumping is exempt from all that ------------------------------------------------------
 *
 * Region declumping is not a rejection test; every candidate layout is spread out before it is ever
 * scored. That is safe because crowding is a function of the visible board alone. It does not know
 * where any ship is, so conditioning on it publishes nothing that was not already going on screen.
 * Only the fairness tests touch hidden fleet positions.
 *
 * -- Why it only ever permutes -------------------------------------------------------------------
 *
 * The output is an index per cell into the seeded board, never a board. Which squares are in play
 * therefore stays a pure function of (room id, square set, seed), which is what auto-fire's flag
 * coverage, the Almanac's census of squares nobody fired at, and archived-match replay all rest on.
 * A balanced board is the same pack of cards in a different order.
 *
 * Import-free on purpose, like squareSetFormat.ts and for the same reason: the Deno edge function
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
 * Past this, a square is one nobody reliably finishes inside a match.
 *
 * 80 minutes, just under the archive's median match of about 82. A square costing more than that is
 * not merely slow - it is one the enemy is more likely than not to run out of clock on, so a cell
 * holding one is a cell that may simply never be fired at.
 *
 * Measured over 3380 archived fleet cells, share eventually fired at by the fleet that needed it:
 *
 *     under 30:00   99%          65:00-80:00   88%
 *     30:00-45:00   98%          past 80:00    72%
 *     45:00-65:00   91%
 *
 * The fall is between the last two rows, which is the argument for the line being somewhere in that
 * neighbourhood rather than for any exact minute in it. 80 puts it at the top of the fall rather
 * than partway down: everything the test counts is a square that goes unfired more than a quarter of
 * the time, and squares in the 75-80 band - which are finished about four times in five - are no
 * longer counted against the fleet holding them.
 *
 * The checker used 75 for this from the rework onward, while the balancer had no opinion. Now that
 * the balancer tests against it the number lives here and the checker reads it, so there is one
 * definition rather than two that can drift. It replaces the retired HARD_REACH, which was a
 * probability threshold from when a square's cost was a share of boards rather than a time.
 */
export const LONG_SQUARE_SECONDS = 80 * 60;

/**
 * How many more long squares one fleet may hold than another.
 *
 * One, flat, at every board size - so on most boards the two fleets hold the SAME number of squares
 * the enemy probably cannot finish, and never more than one apart.
 *
 * -- Why a second test at all, when there is already a rank gap -----------------------------------
 *
 * Because the rank gap prices a ship at its slowest square and throws the rest away. On a 7-ship,
 * 24-cell fleet that is seven numbers out of twenty-four, and then the rank comparison collapses
 * those seven into one. A fleet whose every cell is expensive and a fleet with four cheap cells and
 * one brutal one can produce the same profile, and they are not the same match.
 *
 * GHOSTLY HULL is the board that made the case. Both fleets held 24 cells; the profiles interleaved
 * to a rank gap of 3:58, inside the 5:00 limit and the 4th percentile of the whole archive - one of
 * the fairest boards this has ever produced. What the profiles could not say was that one fleet had
 * no cell cheaper than 42 minutes against the other's four under 28, and cost 83 minutes more to
 * clear in total. The side shooting at it fired all 24 of its cells and needed the full 98 minutes;
 * the other side never fired four of its enemy's cells at all.
 *
 * -- And what this test does NOT catch about it ---------------------------------------------------
 *
 * That board does not fail this test, and the reason is worth writing down rather than discovering
 * again. Its asymmetry sat almost entirely in the 75-80 minute band: counted past 75 the fleets are
 * seven long squares against five, and counted past LONG_SQUARE_SECONDS they are four against five -
 * inside the limit, and tilted the other way. Three of one fleet's expensive squares are of the kind
 * that get finished about four times in five, which is what the line at 80 deliberately stops
 * counting against a fleet.
 *
 * So this is a test that would have caught boards LIKE Ghostly Hull rather than Ghostly Hull itself.
 * Both facts are true and neither cancels the other: it binds on a quarter of the 10x10 layouts the
 * rank gap alone accepts, so it rejects a great many real boards - and the specific one that
 * prompted it is not among them. Tightening the gap to zero would catch it, at a median of 34 draws
 * instead of 15 and boards that start failing to find any layout at all, which is a worse trade than
 * the board is worth.
 *
 * FIND_GAP_SECONDS catches it. Not by tightening this - Ghostly Hull's long-square gap is 1, exactly
 * on the line, and its rank gap is 3:58 inside a 5:00 limit - but by measuring the other end of every
 * ship, where its two fleets are 20:31 apart against a 10:00 limit. The asymmetry that made that
 * board unplayable was never about when ships DIED, which is why two tests that both price a hull at
 * its slowest square could look at it and see nothing. Left standing above rather than rewritten,
 * because the reasoning is still exactly right about what THIS test can and cannot do.
 *
 * -- Why a count of whole squares, and not more seconds -------------------------------------------
 *
 * The rank gap already spends the precision this cost model has. Across 777 archived sunk ships, a
 * ship's slowest square predicts when it was actually sunk with r = 0.40 and a residual RMSE of
 * 17:48 - so a 5:00 threshold is being enforced well inside its own noise, and tightening it
 * further buys nothing real. A count of long squares asks a coarser question the model can actually
 * answer: not "how many minutes apart are these fleets" but "does one side hold more squares the
 * enemy will run out of clock on".
 *
 * It is also the only fairness rule here that can be said in one sentence, which is worth something
 * on a stream: both fleets hold about the same number of squares that take longer than a match.
 *
 * -- What it costs --------------------------------------------------------------------------------
 *
 * Over 300 boards per size, it rejects 15% of the layouts the rank test alone accepts at 8x8, 23% at
 * 10x10 and 30% at 12x12 - so between a seventh and a third of the boards that previously shipped
 * are now redrawn. The median run is 6, 15 and 18 draws, worst 82, 121 and 218, and no board at any
 * size failed to find an acceptable layout inside MAX_ATTEMPTS.
 *
 * Measured on the balancer's own rank-only output rather than on raw deals, which matters more than
 * it sounds: the rank test binds on 94% of raw 10x10 deals, so asking the question of raw deals
 * leaves a denominator of about nine boards in a hundred and an answer that moves twenty points
 * between runs. The population the question is about is the layouts that would have SHIPPED.
 *
 * It also, unexpectedly, makes the positional tell smaller rather than larger: long squares under a
 * hull against on open water moves from 21.7% vs 20.1% to 20.9% vs 20.5%. Equalising the count
 * between fleets pins the rate on ship cells to the rate on the board, where the rank test alone
 * leaves it free to drift.
 */
export const LONG_GAP = 1;

/**
 * How many layouts to draw before giving up and playing the best one seen.
 *
 * 900, raised from 300 when the find test joined the other two. Each test is a separate hurdle on
 * the same draw, so their acceptance rates multiply and a third one costs more budget than it looks
 * like it should: a 10x10 that took a median of 15 draws on two tests takes 56 on three, and its
 * worst board in sixty went to 295. Three hundred would have left that board playing an unaccepted
 * layout, which is the one outcome worth spending milliseconds to avoid - see FIND_GAP_SECONDS for
 * why a test that routinely falls back stops being a test.
 *
 * Nine hundred rather than a round thousand because it is where the measured worst case fits with
 * room to spare rather than exactly: over sixty Classic boards per size the worst was 295 draws at
 * 10x10 and 628 at 12x12, and a sweep of every board size against every fleet preset put the
 * hardest of 150 boards at 651. If the limit is ever actually reached the fallback is the fairest
 * layout of the nine hundred, which is strictly better than the deal.
 *
 * For scale: a draw costs 1.67ms on a 10x10, so a fully spent budget is about 1.5s and the ordinary
 * deal is about 80ms. startBattle awaits this - see BALANCE_TIMEOUT_MS in lib/rooms.ts, which is
 * 10s and has to stay comfortably above a full spend plus the function's own cold start and its
 * half-dozen queries.
 */
const MAX_ATTEMPTS = 900;

/**
 * How far apart two fleets' ships may be at the same rank, in seconds.
 *
 * The first of the two fairness numbers, and the one that speaks in time. Ships are sorted
 * longest-first within each fleet and compared position by position - longest against longest,
 * cheapest against cheapest - and no pair may differ by more than this. LONG_GAP is the other, and
 * covers what pricing a ship at its slowest square necessarily discards.
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
 * How far apart two fleets' ships may be at the same rank when priced by their CHEAPEST square.
 *
 * The third fairness number, and the one that measures how long a fleet takes to be FOUND rather
 * than how long it takes to finish.
 *
 * -- Two moments, not one -------------------------------------------------------------------------
 *
 * A ship has two times that decide a match and RANK_GAP_SECONDS only ever knew about the second of
 * them. It is found the first time anything lands on it, and cleared when the last of its cells has
 * been fired at. Everything that makes the middle of a match - the enemy knowing there is a hull
 * somewhere around D7, working out which way it lies, and spending shots picking it apart - happens
 * between those two events. A fleet nobody can find for fifty minutes is playing a different game
 * from one that gets found at twenty, however long both take to sink afterwards.
 *
 * The slowest square is the wrong instrument for that, because a ship is found through its EASIEST
 * cell: whichever of its squares the enemy happens to reach first. One cheap square on a Carrier
 * gives the whole hull away at that square's price, however cold the other four are. So find time is
 * priced at the minimum exactly where clear time is priced at the maximum, and the two are the same
 * measurement taken from opposite ends of the ship.
 *
 * -- Why this is not the rank gap in a hat --------------------------------------------------------
 *
 * Because the two ends barely move together. Over 2107 archived ships, a ship's cheapest square
 * correlates with its slowest at r = 0.192, and the two sit a median of 30:42 apart. A fleet can be
 * matched rank for rank on when its ships die and be half an hour apart on when they are found.
 *
 * Measured against what actually happened, over 2018 archived ships the enemy ever hit:
 *
 *                                       predicts FOUND      predicts CLEARED
 *     cheapest square on the ship       r = 0.499           r = 0.233
 *     slowest square on the ship        r = 0.157           r = 0.438
 *
 * Read the diagonal. Each end predicts its own moment and neither predicts the other's, which is
 * both the argument for adding this test and the argument for it being min and not mean - the mean
 * square comes in at r = 0.442 on find time, behind the minimum, because averaging a cold cell
 * against a warm one describes a ship the enemy never has to fight.
 *
 * Worth noting where it lands relative to the model already shipping: the cheapest square predicts
 * a find at r = 0.499 with a residual of 17:47, against the slowest square's r = 0.438 and 16:41 on
 * a clear. This is the BETTER-supported of the two, not a speculative extension of the first.
 *
 * -- Why ten minutes and not five ------------------------------------------------------------------
 *
 * Symmetry with RANK_GAP_SECONDS would say five, and five is not reachable. The reason is worth
 * writing down, because "make it match the other one" is the first thing anybody will suggest.
 *
 * A ship's cheapest square spreads WIDER than its slowest - sd 13:13 against 10:49 across the ship
 * values on a 10x10, and a within-fleet top-to-bottom range of 30:03 against 24:32. The maximum of
 * four or five cells piles up against the top of the cost table wherever it is drawn from; the
 * minimum has the whole low tail to fall down. So the same number of seconds is a far harsher test
 * on this profile than on the other one: over 600 raw 10x10 deals, 6.7% come in under a 5:00 rank
 * gap and only 2.8% under a 5:00 find gap.
 *
 * And the three tests have to pass on the SAME draw, so their acceptance rates multiply. Measured on
 * the budget that ships, over 60 boards per cell:
 *
 *     find limit    10x10 draws (median/p90/worst)    boards that ran out of draws
 *      5:00           494 / 900 / 900                  37% at 10x10, 45% at 12x12
 *      7:00           195 / 639 / 900                   5% at 10x10, 10% at 12x12
 *     10:00            55 / 237 / 389                   none at any size
 *
 * Five minutes does not produce fairer boards. It produces boards that spend the whole budget and
 * then play the fairest layout drawn anyway - a test that mostly falls back is not a test, and the
 * fallback is not a uniform sample from the layouts that pass, which is the one property this whole
 * design exists to keep.
 *
 * Ten is where the cost curve flattens with the guarantee intact: no board at any size fails to find
 * an acceptable layout, the median 10x10 deal is 55 draws and about 80ms, and it still rejects
 * roughly four raw deals in five - the median raw find gap is 14:27 and the p90 is 24:12.
 *
 * It is also inside the model's own noise, which is the argument that makes it honest rather than
 * merely affordable. The cheapest square predicts a find with a residual of 17:47, so ten minutes is
 * a little over half of one standard error - the same kind of claim as the rank gap's five against
 * its 16:41, and the same reason both stop where they do instead of chasing seconds the cost table
 * cannot resolve.
 *
 * See scripts/check-board-balance.ts, which measures the sweep above on every run.
 */
export const FIND_GAP_SECONDS = 10 * 60;

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
  /**
   * The same comparison on ships priced by their CHEAPEST square, in seconds. See FIND_GAP_SECONDS.
   *
   * A separate field rather than a share of rankGapSeconds, even though both currently sit at five
   * minutes. They are thresholds on two different models fitted to two different events, and the
   * day one of them is re-fitted and moves is the day a shared field would silently move the other.
   */
  findGapSeconds: number;
  /** What counts as a square the enemy probably cannot finish. See LONG_SQUARE_SECONDS. */
  longSquareSeconds: number;
  /** How many more of those one fleet may hold than another. See LONG_GAP. */
  longGap: number;
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
  findGapSeconds: FIND_GAP_SECONDS,
  longSquareSeconds: LONG_SQUARE_SECONDS,
  longGap: LONG_GAP,
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
   * The same, on ships priced by their cheapest square: how long a fleet takes to be FOUND.
   *
   * Reported beside the rank gap rather than folded into it because the two measure opposite ends
   * of the same ship and barely move together - see FIND_GAP_SECONDS. A board can be even on when
   * ships die and lopsided on when they are found, and a single number would show neither.
   */
  findGapBefore: number;
  findGapAfter: number;
  /** The find-gap threshold this board was held to, in seconds. */
  findLimit: number;
  /**
   * How many more long squares the worst-off fleet held than the best-off, dealt and as played.
   *
   * Whole squares, not seconds - see LONG_GAP. Reported alongside the rank gap rather than folded
   * into it because the two say different things and a board can pass either one while failing the
   * other, which is the entire reason the second test exists.
   */
  longGapBefore: number;
  longGapAfter: number;
  /** The long-square threshold this board was held to, in squares. */
  longLimit: number;
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
  /** Whether the layout being returned passes all three tests. False only if MAX_ATTEMPTS ran out. */
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
 * Takes no fleet size any more, on purpose: the old thresholds scaled with the number of
 * CELLS a fleet covered, which quietly said that a bigger fleet deserved a bigger unfairness. A rank
 * gap is a comparison between two individual ships, so the same number is right on every board.
 *
 * Exported because the checker asserts against it and the edge function reports it.
 */
export function limitsFor(
  rules: BalanceRules = DEFAULT_RULES
): { rankGap: number; findGap: number; longGap: number } {
  return { rankGap: rules.rankGapSeconds, findGap: rules.findGapSeconds, longGap: rules.longGap };
}

/** Widest minus narrowest. Fewer than two values means there is no gap to speak of. */
export function spread(values: number[]): number {
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
 * Normalises raw fleet input into the ships this module will actually score.
 *
 * Cells are bounds-checked and de-duplicated per ship, ships with nothing left are dropped, and
 * fleets with no ships left are dropped entirely. A cell two fleets both occupy counts toward both:
 * a hull sitting on a square the enemy is also sitting on still has to be shot off it.
 *
 * Exported so that anything scoring a board after the fact - the admin stats sweep - starts from
 * exactly the same ships the balancer started from, rather than from its own reading of a placement.
 */
export function normalizeFleets(
  fleets: Array<{ team: number; ships: number[][] }>,
  cells: number
): number[][][] {
  return normalizeFleetsWithTeams(fleets, cells).map((f) => f.ships);
}

/**
 * The same normalisation, with each surviving fleet's team still attached.
 *
 * Everything downstream works in profile arrays indexed by position, and position was all there was
 * - a fleet that lost every ship to the bounds check is dropped, so index 2 of a profile list is not
 * reliably the third fleet handed in, let alone team 2. That was fine while every measure here was a
 * spread and had no side to name. Naming the fleet that came out ahead needs the labels carried
 * through the same drop, so they are carried here rather than reconstructed by a caller guessing at
 * the drop rule.
 */
export function normalizeFleetsWithTeams(
  fleets: Array<{ team: number; ships: number[][] }>,
  cells: number
): Array<{ team: number; ships: number[][] }> {
  const active: Array<{ team: number; ships: number[][] }> = [];
  for (const fleet of fleets) {
    const ships: number[][] = [];
    for (const ship of fleet.ships ?? []) {
      const own = new Set<number>();
      for (const c of ship) {
        if (Number.isInteger(c) && c >= 0 && c < cells) own.add(c);
      }
      if (own.size > 0) ships.push([...own]);
    }
    if (ships.length > 0) active.push({ team: fleet.team, ships });
  }
  return active;
}

/**
 * A fleet's cost profile: what each of its ships costs, longest first.
 *
 * A ship costs the slowest square on it, because it only sinks once every one of its cells has been
 * fired at. Sorting matters as much as the maximum does - two fleets can have identical longest
 * ships and still be nothing like each other if one of them has a ship that falls in half the time,
 * which is the ship that gets picked off while the match is still being played.
 *
 * `costAt` is a lookup rather than an array because the balancer scores a board it is still
 * permuting, and has to read cost through the permutation it is currently trying.
 */
export function shipCostProfile(ships: number[][], costAt: (cell: number) => number): number[] {
  return ships.map((s) => Math.max(...s.map(costAt))).sort((a, b) => b - a);
}

/**
 * A fleet's find profile: how long each of its ships takes to be FOUND, longest first.
 *
 * The same shape as shipCostProfile taken off the other end of the ship. A hull is found the first
 * time anything lands on it, and the enemy gets there through whichever of its cells they reach
 * soonest - so a ship is found at the price of its CHEAPEST square, exactly where it is cleared at
 * the price of its dearest. One warm cell on a five-cell Carrier gives the whole hull away at that
 * cell's price however cold the other four are.
 *
 * Sorted longest-first like the cost profile so the two read the same way and rankGapDetail can
 * compare either: position 0 is the ship that stays hidden longest, and the bottom of the list is
 * the ship that gets stumbled on first. That bottom rank is the one worth watching - it is a fleet's
 * first contact, and a fleet found at 20 minutes has been under fire for half an hour before one
 * found at 50 has been touched.
 *
 * `costAt` is a lookup for the same reason shipCostProfile's is: the redraw loop reads this through
 * a permutation it is still changing.
 */
export function shipFindProfile(ships: number[][], costAt: (cell: number) => number): number[] {
  return ships.map((s) => Math.min(...s.map(costAt))).sort((a, b) => b - a);
}

/**
 * How many of a fleet's CELLS cost more than the long-square line. See LONG_SQUARE_SECONDS.
 *
 * Cells rather than ships, because the rank profile already speaks in ships and cannot see a hull
 * that is expensive all the way along. A cell a fleet shares with the enemy counts
 * for both, the same way it does everywhere else here - both sides still have to shoot it off.
 *
 * `costAt` is a lookup for the same reason shipCostProfile's is: this is read through a permutation
 * the redraw loop is still changing.
 */
export function longSquareCount(
  ships: number[][],
  costAt: (cell: number) => number,
  threshold: number
): number {
  const seen = new Set<number>();
  for (const s of ships) for (const c of s) seen.add(c);
  let n = 0;
  for (const c of seen) if (costAt(c) > threshold) n++;
  return n;
}

/**
 * The widest same-rank gap between any two fleets, in seconds.
 *
 * Compared RANK BY RANK: the longest ship against the longest, the shortest against the shortest. A
 * single summary - the max, or a total - is what let a board through where both fleets took about
 * 86 minutes to eliminate but one of them had a ship gated at 50 minutes and the other's cheapest
 * was 77. Ranks past the shortest fleet's length are not compared, because a fleet with fewer ships
 * has nothing to put opposite them.
 */
export function rankGapOf(profiles: number[][]): number {
  return rankGapDetail(profiles).gap;
}

/**
 * The same measurement, keeping the fleet each end of the gap belongs to.
 *
 * The gap is a spread and a spread has no direction, which is why the stored fairness record was a
 * bare magnitude for as long as it existed. But the rank the spread is worst at has two named ends:
 * the fleet holding the cheapest ship there got the head start, and the fleet holding the dearest
 * paid for it. That is a fact about the board, not an inference, and the only reason it was never
 * reported is that it was computed and thrown away one line later.
 *
 * `ahead` and `behind` are indexes into `profiles`, so a caller that wants a team out of them has to
 * have kept the team labels - see normalizeFleetsWithTeams. Both are null when there is no gap to
 * take a side on: fewer than two fleets, or no rank they both reach.
 */
export function rankGapDetail(profiles: number[][]): {
  gap: number;
  /** Which rank the worst gap was found at, longest ship first. Null when there is no gap. */
  rank: number | null;
  ahead: number | null;
  behind: number | null;
} {
  if (profiles.length < 2) return { gap: 0, rank: null, ahead: null, behind: null };
  const ranks = Math.min(...profiles.map((p) => p.length));
  let gap = 0;
  let rank: number | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  for (let i = 0; i < ranks; i++) {
    const at = profiles.map((p) => p[i]);
    const worst = spread(at);
    // Strictly wider, so the FIRST rank to reach the worst gap is the one reported. Ties on the
    // gap are ties on the whole measurement, and picking a later one would only shuffle which of
    // two identical answers gets printed.
    if (rank !== null && worst <= gap) continue;
    gap = worst;
    rank = i;
    ahead = at.indexOf(Math.min(...at));
    behind = at.indexOf(Math.max(...at));
  }
  // A board where every fleet matches at every rank: measured, perfectly even, and there is no side
  // to name. Reported as no side rather than as fleet 0, which would read as an edge nobody had.
  if (gap === 0) return { gap: 0, rank, ahead: null, behind: null };
  return { gap, rank, ahead, behind };
}

/**
 * Scores one fixed layout, with no redrawing.
 *
 * `balanceBoard` reports `rankGapBefore` for the layout it was handed, but getting at it costs a
 * full rejection-sampling run. This is that measurement on its own, for scoring boards that have
 * already been played and cannot be changed.
 */
export function scoreLayout(
  cost: number[],
  fleets: Array<{ team: number; ships: number[][] }>,
  longSquareSeconds: number = LONG_SQUARE_SECONDS
): {
  rankGap: number;
  profiles: number[][];
  /** The team behind each profile, same order. See normalizeFleetsWithTeams. */
  teams: number[];
  /** The team that held the cheapest ship at the worst rank, or null on a board with no gap. */
  aheadTeam: number | null;
  /** Its opposite number: the team that held the dearest ship there. */
  behindTeam: number | null;
  /** The widest same-rank gap on ships priced by their cheapest square. See shipFindProfile. */
  findGap: number;
  findProfiles: number[][];
  /**
   * The two ends of the find gap, as teams.
   *
   * Named separately from aheadTeam/behindTeam rather than assumed to agree with them, because on
   * this cost model they routinely do not: the two profiles are built off opposite ends of the same
   * ships and correlate at r = 0.192. The fleet that gets found first and the fleet whose ships die
   * first are frequently the same side and frequently not, and a recap that printed one label for
   * both would be inventing the agreement.
   *
   * `findAheadTeam` is the fleet that stayed hidden longer at the worst rank - the one holding the
   * DEARER cheapest-square there, since on this profile a high number is the advantage.
   */
  findAheadTeam: number | null;
  findBehindTeam: number | null;
  longCounts: number[];
  longGap: number;
} {
  const active = normalizeFleetsWithTeams(fleets, cost.length);
  const profiles = active.map((f) => shipCostProfile(f.ships, (c) => cost[c]));
  const findProfiles = active.map((f) => shipFindProfile(f.ships, (c) => cost[c]));
  const longCounts = active.map((f) => longSquareCount(f.ships, (c) => cost[c], longSquareSeconds));
  const detail = rankGapDetail(profiles);
  const findDetail = rankGapDetail(findProfiles);
  return {
    rankGap: detail.gap,
    profiles,
    teams: active.map((f) => f.team),
    aheadTeam: detail.ahead === null ? null : active[detail.ahead].team,
    behindTeam: detail.behind === null ? null : active[detail.behind].team,
    findGap: findDetail.gap,
    findProfiles,
    // rankGapDetail names the ends by cost - `ahead` holds the cheaper ship - and on the cost
    // profile the cheaper ship is the one that dies sooner, so `ahead` is the fleet with the head
    // start. On the find profile the cheaper ship is the one that gets FOUND sooner, which is the
    // disadvantage, so the two ends swap meaning and are swapped here rather than at the reader.
    findAheadTeam: findDetail.behind === null ? null : active[findDetail.behind].team,
    findBehindTeam: findDetail.ahead === null ? null : active[findDetail.ahead].team,
    longCounts,
    longGap: spread(longCounts),
  };
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

  // Each fleet as a list of ships, each ship a list of cells, bounds-checked. See normalizeFleets.
  const active = normalizeFleets(fleets, cells);

  /** Every cell a fleet holds, for the region floor - which counts squares, not ships. */
  const cellsOfFleet = (ships: number[][]) => {
    const out = new Set<number>();
    for (const s of ships) for (const c of s) out.add(c);
    return out;
  };

  const { rankGap: rankLimit, findGap: findLimit, longGap: longLimit } = limitsFor(rules);

  /** See shipCostProfile. Read through `perm`, which the redraw loop is still changing. */
  const profileOf = (ships: number[][]) => shipCostProfile(ships, (c) => cost[perm[c]]);

  /** The same, off the other end of each ship. See shipFindProfile. */
  const findProfileOf = (ships: number[][]) => shipFindProfile(ships, (c) => cost[perm[c]]);

  /** All the fairness measures for the layout `perm` currently describes. */
  const measure = () => {
    const profiles = active.map(profileOf);

    // Rank by rank, and see rankGapOf for why that rather than any single summary.
    const worstRank = rankGapOf(profiles);

    // The third test, on when each fleet gets FOUND rather than cleared. See FIND_GAP_SECONDS.
    const worstFind = rankGapOf(active.map(findProfileOf));

    // The second test, on the cells the profile above throws away. See LONG_GAP.
    const longCounts = active.map((ships) =>
      longSquareCount(ships, (c) => cost[perm[c]], rules.longSquareSeconds)
    );
    const worstLong = spread(longCounts);

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

    return { rankGap: worstRank, findGap: worstFind, longGap: worstLong, profiles, regionLow: low };
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
      findGapBefore: before.findGap,
      findGapAfter: before.findGap,
      findLimit,
      longGapBefore: before.longGap,
      longGapAfter: before.longGap,
      longLimit,
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
  let bestFind = Infinity;
  let bestLong = Infinity;
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
    if (
      !canBalance ||
      (now.rankGap <= rankLimit &&
        now.findGap <= findLimit &&
        now.longGap <= longLimit &&
        floorMet)
    ) {
      best = perm.slice();
      bestGap = now.rankGap;
      bestFind = now.findGap;
      bestLong = now.longGap;
      bestLow = now.regionLow;
      bestClump = declumping ? crowding : null;
      accepted = true;
      break;
    }
    // Keep the fairest layout seen, in case every attempt is spent. Ranked by the region floor
    // first, then by how far the layout misses all three tests COMBINED.
    //
    // The floor leads because a board dealt too few DLC squares can never satisfy it by any
    // permutation, so the fallback should at least hand each fleet as many as exist before arguing
    // about anything else.
    //
    // The three fairness measures are then summed as fractions of their own limits, rather than one
    // being consulted before the others. Ordering them lexicographically was the first thing tried
    // and it is wrong at exactly the moment this code runs: with the long-square count leading, a
    // four-team board fell back to a layout that was one square better on a test it had already
    // failed and eighteen minutes worse on the other. No measure outranks another once all are
    // already blown - what matters is total distance from playable, and a fraction of the limit is
    // the only unit the three share.
    const low = now.regionLow ?? 0;
    // Every term falls back to the raw measure when its limit is zero, which is only reachable
    // through a hand-built profile but would otherwise divide by it and rank every candidate equally
    // infinite - leaving the fallback as whichever layout happened to be drawn first.
    const missOf = (rank: number, find: number, long: number) =>
      (rankLimit > 0 ? rank / rankLimit : rank) +
      (findLimit > 0 ? find / findLimit : find) +
      (longLimit > 0 ? long / longLimit : long);
    const better =
      floor && low !== (bestLow ?? 0)
        ? low > (bestLow ?? 0)
        : missOf(now.rankGap, now.findGap, now.longGap) < missOf(bestGap, bestFind, bestLong);
    if (better) {
      best = perm.slice();
      bestGap = now.rankGap;
      bestFind = now.findGap;
      bestLong = now.longGap;
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
    findGapBefore: before.findGap,
    findGapAfter: bestFind,
    findLimit,
    longGapBefore: before.longGap,
    longGapAfter: bestLong,
    longLimit,
    regionLow: bestLow === -1 ? null : bestLow,
    attempts,
    accepted,
    balanced: canBalance,
    clumpBefore,
    clumpAfter: bestClump,
  };
}
