/**
 * Exercises the board balancer against real fleets on real boards.
 *
 * The balancer is the one piece of this project that reads every fleet and rewrites the board in
 * response, and it runs exactly once per match with no undo. So the questions worth asking are not
 * "does it run" but: does it still deal the same squares, does it catch the boards it exists to
 * catch, and - since the previous version of this was metagamed by the players inside a season - does
 * the layout it hands back carry any fingerprint at all.
 *
 * That last one is why sections 4 and 5 exist and are the point of this file. A balancer that closes
 * the gap perfectly and leaves a readable bias is worse than no balancer, because the bias is
 * information about where the enemy is hiding and it is handed to everybody every match.
 *
 * Runs the SAME module the edge function runs - src/lib/boardBalance.ts imports nothing, for exactly
 * that reason - so this tests what ships rather than a copy of it.
 *
 *   node --experimental-strip-types scripts/check-board-balance.ts
 */
import { readFileSync } from 'node:fs'
import {
  applyBoardPerm,
  balanceBoard,
  limitsFor,
  DEFAULT_RULES,
  smallCrewFloor,
  regionFloorFor,
  longSquareCount,
  shipCostProfile,
  rankGapDetail,
  scoreLayout,
  RANK_GAP_SECONDS,
  LONG_GAP,
  LONG_SQUARE_SECONDS,
} from '../src/lib/boardBalance.ts'
import { buildFlatBoard, type Challenge } from '../src/lib/squareSetFormat.ts'
import { BOARD_SIZES, FLEET_PRESETS, fleetFor } from '../src/types/battleship.ts'
import { randomPlacements } from '../src/lib/battleshipLogic.ts'

const bosses = JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges.json', import.meta.url), 'utf8')) as Challenge[]
const bosses2v2 = JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges2v2.json', import.meta.url), 'utf8')) as Challenge[]
const costTable = JSON.parse(readFileSync(new URL('../src/data/bossTimeCost.json', import.meta.url), 'utf8')) as Record<string, number>

// Mirrors seededRandom.ts, which check-boards.ts also mirrors and for the same reason.
function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}
function rng(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The worst crowding ratio a run is allowed to end on, a little above the balancer's own target.
 *
 * Slack, not a second opinion: the pass stops the moment it crosses its target, so the average lands
 * below it, and a board whose regions cannot be separated any further stops short. This asserts the
 * pass is doing its job without asserting it always wins.
 */
const DECLUMP_TARGET_MAX = 0.8

/**
 * Fleet layouts come from randomPlacements, which reads Math.random directly, so this pins it.
 *
 * Not fussiness: several checks below are numeric thresholds over a few hundred boards, and an
 * unseeded run makes them a dice roll - a borderline layout fails the suite on Tuesday and passes on
 * Wednesday, which trains everyone to re-run it rather than read it. Seeded, a failure means
 * something changed.
 */
{
  let s = seedFrom('board-balance-checks')
  Math.random = () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * What counts as an expensive square, in seconds.
 *
 * This file defined its own 75 minutes while the balancer had no opinion on the matter. The
 * balancer tests against it now, so the number comes from there and this is an alias - a checker
 * that measures a threshold the code does not use is a checker that agrees with itself.
 */
const LONG_SQUARE = LONG_SQUARE_SECONDS

let failures = 0
function check(ok: boolean, label: string, detail = '') {
  if (!ok) {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`)
  }
}

/** A room's seeded board, as time cost per cell. */
function boardCost(roomId: string, cells: number, set: Challenge[] = bosses): number[] {
  const board = buildFlatBoard(set, cells, rng(seedFrom(roomId)))
  return board.map((sq) => {
    const c = costTable[sq.tooltip ?? '']
    if (c === undefined) throw new Error()
    return c
  })
}

/** The same board's regions, in the same order. */
function boardRegions(roomId: string, cells: number, set: Challenge[] = bosses): Array<string | null> {
  return buildFlatBoard(set, cells, rng(seedFrom(roomId))).map((sq) => sq.region ?? null)
}

/**
 * Touching same-region pairs.
 *
 * NOT what the declumper optimises - it scores 3x3 patches - which is exactly why it is measured
 * here. It is the natural way to ask "does this still look shuffled": a board driven to a
 * checkerboard would show near-zero adjacency, and that would be as obviously arranged as the clumps
 * it replaced. Reported as an independent witness rather than as the target.
 */
function adjacentPairs(regions: Array<string | null>, perm: number[], size: number): number {
  let n = 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const mine = regions[perm[r * size + c]]
      if (mine === null) continue
      for (const [dr, dc] of [[0, 1], [1, -1], [1, 0], [1, 1]] as Array<[number, number]>) {
        const y = r + dr
        const x = c + dc
        if (y < 0 || x < 0 || y >= size || x >= size) continue
        if (regions[perm[y * size + x]] === mine) n++
      }
    }
  }
  return n
}

/**
 * The most crowded any single region gets inside a w-by-w window.
 *
 * This is the shape of the complaint the declumping pass exists for - "eight DLC bosses in a
 * ten-square area" - so it is measured directly rather than inferred from the patch score the pass
 * actually optimises.
 */
function worstWindow(regions: Array<string | null>, perm: number[], size: number, w: number): number {
  let worst = 0
  for (let r = 0; r + w <= size; r++) {
    for (let c = 0; c + w <= size; c++) {
      const tally = new Map<string, number>()
      for (let dr = 0; dr < w; dr++) {
        for (let dc = 0; dc < w; dc++) {
          const g = regions[perm[(r + dr) * size + (c + dc)]]
          if (g === null) continue
          const n = (tally.get(g) ?? 0) + 1
          tally.set(g, n)
          if (n > worst) worst = n
        }
      }
    }
  }
  return worst
}

/** Fleets laid out at random on the same board, each as its list of SHIPS. */
function makeFleets(boardSize: number, preset: string, teams = 2) {
  const defs = fleetFor(boardSize, preset)
  return Array.from({ length: teams }, (_, team) => ({
    team,
    ships: randomPlacements(boardSize, defs).map((p) => {
      const size = defs[p.shipIndex].size
      const cs: number[] = []
      for (let k = 0; k < size; k++) {
        const r = p.isHorizontal ? p.startRow : p.startRow + k
        const c = p.isHorizontal ? p.startCol + k : p.startCol
        cs.push(r * boardSize + c)
      }
      return cs
    }),
  }))
}

/** Every cell a fleet covers, for the checks that only care about coverage. */
function fleetCells(f: { ships: number[][] }): number[] {
  return [...new Set(f.ships.flat())]
}

/** The rank gap, recomputed here rather than taken from the balancer's word for it. */
function fairness(cost: number[], perm: number[], fleets: Array<{ ships: number[][] }>) {
  const profiles = fleets.map((f) =>
    f.ships.map((s) => Math.max(...s.map((c) => cost[perm[c]]))).sort((a, b) => b - a)
  )
  const ranks = Math.min(...profiles.map((p) => p.length))
  let gap = 0
  for (let i = 0; i < ranks; i++) {
    const at = profiles.map((p) => p[i])
    gap = Math.max(gap, Math.max(...at) - Math.min(...at))
  }
  return { gap, profiles }
}

const identity = (n: number) => Array.from({ length: n }, (_, i) => i)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)

/* ------------------------------------------------------------------------- */

console.log(`Board balancer - rejection sampling, same-rank ship gap limit ${RANK_GAP_SECONDS}s
`)

// -- 1. Every board size and preset ------------------------------------------------------------
// The invariant that everything downstream rests on is the permutation one: balancing may move
// squares but must never change WHICH squares are in play, or auto-fire's flag coverage and the
// Almanac's census of unfired squares both quietly stop describing the match that was played.
console.log('board sizes x presets')
let worstAttempts = 0
let unaccepted = 0
let runs = 0
for (const boardSize of BOARD_SIZES) {
  const cells = boardSize * boardSize
  for (const preset of Object.keys(FLEET_PRESETS)) {
    const cost = boardCost(`size-${boardSize}-${preset}`, cells)
    const regions = boardRegions(`size-${boardSize}-${preset}`, cells)
    let sizeAttempts = 0

    for (let trial = 0; trial < 5; trial++) {
      const fleets = makeFleets(boardSize, preset)
      const res = balanceBoard({
        cost,
        regions,
        boardSize,
        fleets,
        next: rng(seedFrom(`${boardSize}:${preset}:${trial}`)),
      })
      runs++
      sizeAttempts = Math.max(sizeAttempts, res.attempts)
      worstAttempts = Math.max(worstAttempts, res.attempts)
      if (!res.accepted) unaccepted++

      // The permutation invariant, checked by shuffling the actual board rather than the indices.
      const board = buildFlatBoard(bosses, cells, rng(seedFrom(`size-${boardSize}-${preset}`)))
      const dealt = [...board].map((s) => s.name).sort()
      const laid = applyBoardPerm(board, res.perm).map((s) => s.name).sort()
      check(dealt.length === laid.length && dealt.every((n, i) => n === laid[i]),
        `${boardSize}x${boardSize} ${preset} deals the same squares`)
      check(new Set(res.perm).size === cells, `${boardSize}x${boardSize} ${preset} perm is a bijection`)

      // The balancer's own report has to agree with an independent recomputation. A result that
      // lies about its gap is worse than one that fails to close it, because nothing downstream
      // would ever notice.
      const actual = fairness(cost, res.perm, fleets)
      check(Math.abs(actual.gap - res.rankGapAfter) < 1e-9,
        `${boardSize}x${boardSize} ${preset} reports its own gap`,
        `said ${res.rankGapAfter.toFixed(3)}, actually ${actual.gap.toFixed(3)}`)

      // Accepted means accepted: both tests, on the layout actually handed back.
      if (res.accepted && res.balanced) {
        check(actual.gap <= res.rankLimit + 1e-9,
          `${boardSize}x${boardSize} ${preset} accepted layout is inside both limits`,
          `gap ${actual.gap.toFixed(0)}s / limit ${res.rankLimit}s`)
      }
    }
    process.stdout.write(`  ${boardSize}x${boardSize} ${preset.padEnd(9)} worst ${sizeAttempts} attempt(s)\n`)
  }
}
check(unaccepted === 0, 'every board found an acceptable layout', `${unaccepted} of ${runs} ran out of attempts`)
console.log(`  ${runs} boards, worst ${worstAttempts} attempts, ${unaccepted} unaccepted\n`)

// -- 2. The size gradient ------------------------------------------------------------------------
// Small boards are meant to be held to a tighter standard than large ones, and they are - without a
// second dial - because the gap between two fleets spreads like the square root of the fleet while
// the threshold grows with the fleet itself. This asserts the gradient actually comes out that way,
// since it is a consequence of the arithmetic rather than something written down anywhere.
console.log('rejection rate by board size (Classic)')
const rejectRate = new Map<number, number>()
for (const boardSize of [6, 8, 10, 12]) {
  const cells = boardSize * boardSize
  const fleetCells = fleetFor(boardSize, 'Classic').reduce((s, d) => s + d.size * (d.count ?? 1), 0)
  const { rankGap: gapLimit } = limitsFor()
  let rejected = 0
  const TRIALS = 120
  for (let trial = 0; trial < TRIALS; trial++) {
    const cost = boardCost(`grad-${boardSize}-${trial}`, cells)
    const fleets = makeFleets(boardSize, 'Classic')
    // The raw deal, unbalanced: this measures how often the test WOULD bind, which is the honest
    // way to ask how interventionist the balancer is on this board size.
    const raw = fairness(cost, identity(cells), fleets)
    if (raw.gap > gapLimit) rejected++
  }
  const rate = rejected / TRIALS
  rejectRate.set(boardSize, rate)
  console.log(`  ${boardSize}x${boardSize}  fleet ${String(fleetCells).padStart(2)}  gap<=${gapLimit}s  binds on ${(rate * 100).toFixed(0)}%`)
}
// The old thresholds scaled with fleet size, so small boards came out stricter for free. A rank gap
// is a comparison between two individual ships, so it is one number on every board and the binding
// rate is flat by design - see RANK_GAP_SECONDS. What matters now is only that it binds at all.
check(Math.min(...rejectRate.values()) > 0.5, 'the tests bind on most raw deals at every board size')
// The tests are MEANT to bind on most raw deals now. That used to be the failure condition - the
// old thresholds were chosen so nine boards in ten passed untouched - and inverting it is the whole
// point of the tight thresholds: a raw deal is lopsided far more often than the loose limits
// admitted, and the balancer's job is to notice. Redrawing is cheap and unbiased; leaving it alone
// was not free.
check(rejectRate.get(12)! > 0.5, 'the tests bind on most raw deals rather than waving them through',
  `binds on ${(rejectRate.get(12)! * 100).toFixed(0)}%`)
console.log()

// -- 2b. The long-square test does work the rank gap does not ------------------------------------
//
// The reason this section exists rather than being folded into the one above: a second test earns
// its place only if it rejects boards the first one accepts. If the two agreed, it would be cost
// with no fairness attached.
//
// The number to watch is the first one: the share of layouts that WOULD HAVE SHIPPED under the rank
// gap alone and now get redrawn.
//
// -- why it is measured against the balancer's rank-only output and not against raw deals ---------
//
// The obvious version asks it of raw deals: draw a board, keep the ones inside the rank gap, count
// how many of those fail the long test. That was the first version and it is close to useless. The
// rank gap binds on 94% of raw 10x10 deals, so a hundred and fifty draws leave a denominator of
// about nine, and the answer swings twenty points on the seed. Running the balancer with the long
// test switched off gives a full-sized sample of exactly the population in question - the layouts
// the rank gap alone would have accepted - because rejection sampling makes its output a uniform
// draw from them.
//
// Worth knowing while reading it: GHOSTLY HULL, the board this was built after, is NOT one of them.
// Its asymmetry sat in the 75-80 minute band and the line is at 80. See the note under LONG_GAP -
// this catches boards like it rather than it.
console.log('the long-square test (second test, on cells the rank gap discards)')
{
  const TRIALS = 150
  const rankOnly = { ...DEFAULT_RULES, longGap: Number.POSITIVE_INFINITY }
  for (const boardSize of [8, 10, 12]) {
    const cells = boardSize * boardSize
    let wouldHaveShippedAndFails = 0
    let acceptedLongGap = 0
    let accepted = 0
    for (let trial = 0; trial < TRIALS; trial++) {
      const cost = boardCost(`long-${boardSize}-${trial}`, cells)
      const regions = boardRegions(`long-${boardSize}-${trial}`, cells)
      const fleets = makeFleets(boardSize, 'Classic')
      const gapOf = (perm: number[]) => {
        const l = fleets.map((f) => longSquareCount(f.ships, (c) => cost[perm[c]], LONG_SQUARE))
        return Math.max(...l) - Math.min(...l)
      }
      // Same salt for both runs, so the two differ by the rule and not by the draw.
      const salt = () => rng(seedFrom(`long-${boardSize}-${trial}:salt`))

      const before = balanceBoard({ cost, regions, boardSize, fleets, next: salt(), rules: rankOnly })
      if (before.accepted && gapOf(before.perm) > LONG_GAP) wouldHaveShippedAndFails++

      const res = balanceBoard({ cost, regions, boardSize, fleets, next: salt(), rules: DEFAULT_RULES })
      const gap = gapOf(res.perm)
      acceptedLongGap += gap
      if (res.accepted) {
        accepted++
        check(gap <= LONG_GAP, `an accepted ${boardSize}x${boardSize} board is inside the long-square limit`, `gap ${gap}`)
        check(gap === res.longGapAfter, `${boardSize}x${boardSize} reports the long-square gap it actually has`)
      }
    }
    // The test has to do SOMETHING or it is pure cost. One board in twenty is the floor at which it
    // would be worth deleting rather than keeping; the real rates are 15-30%.
    check(wouldHaveShippedAndFails / TRIALS > 0.05,
      `${boardSize}x${boardSize}: the long-square test rejects boards the rank gap accepts`,
      `${((wouldHaveShippedAndFails / TRIALS) * 100).toFixed(0)}%`)
    console.log(
      `  ${boardSize}x${boardSize}  ${((wouldHaveShippedAndFails / TRIALS) * 100).toFixed(0)}% of the layouts the rank gap alone would have shipped are now redrawn` +
      `   |   accepted mean gap ${(acceptedLongGap / TRIALS).toFixed(2)} squares, ${accepted}/${TRIALS} accepted`
    )
  }
  console.log()
}

// -- 3. Two salts, two boards --------------------------------------------------------------------
// The salt is a fresh uuid per match precisely so that the same room, the same seed and the same
// fleets do not produce the same layout twice. If they did, one match would publish the next.
{
  const cells = 100
  const cost = boardCost('variety', cells)
  const regions = boardRegions('variety', cells)
  const fleets = makeFleets(10, 'Classic')
  const a = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom('salt-a')) })
  const b = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom('salt-b')) })
  const again = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom('salt-a')) })
  check(a.perm.some((v, i) => v !== b.perm[i]), 'two salts give two different layouts')
  check(a.perm.every((v, i) => v === again.perm[i]), 'the same salt is reproducible')
  console.log('variety   two salts differ, one salt repeats\n')
}

// -- 4. No edge-pinning --------------------------------------------------------------------------
// The reason this is rejection sampling and not a search. A search stops the moment it crosses the
// line, so its answers pile up just under the limit and "the gap is almost exactly the limit"
// becomes a fact an opponent can bank on. Drawing whole layouts and discarding the failures cannot
// do that: the accepted layouts are simply the natural ones that passed, so their gaps should be
// distributed like the natural gap distribution truncated at the limit - not bunched against it.
console.log('edge-pinning (accepted gaps vs the natural distribution, truncated)')
{
  const cells = 100
  const TRIALS = 60
  const accepted: number[] = []
  const naturalPassing: number[] = []
  for (let trial = 0; trial < TRIALS; trial++) {
    const cost = boardCost(`pin-${trial}`, cells)
    const regions = boardRegions(`pin-${trial}`, cells)
    const fleets = makeFleets(10, 'Classic')
    const res = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom(`pin-${trial}:salt`)) })
    if (res.accepted && res.balanced) accepted.push(res.rankGapAfter / res.rankLimit)

    // The same question asked of layouts nobody balanced: draw at random, keep the ones that would
    // have passed. This is what "unbiased sample of the passing layouts" looks like.
    const { rankGap: gapLimit } = limitsFor()
    const next = rng(seedFrom(`pin-nat-${trial}`))
    const perm = identity(cells)
    for (let k = 0; k < 4; k++) {
      for (let i = cells - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[perm[i], perm[j]] = [perm[j], perm[i]]
      }
      const f = fairness(cost, perm, fleets)
      if (f.gap <= gapLimit) naturalPassing.push(f.gap / gapLimit)
    }
  }
  const topFifth = (xs: number[]) => xs.filter((x) => x > 0.8).length / xs.length
  console.log(`  accepted   mean ${mean(accepted).toFixed(3)} of limit, ${(topFifth(accepted) * 100).toFixed(0)}% in the top fifth of the band`)
  console.log(`  natural    mean ${mean(naturalPassing).toFixed(3)} of limit, ${(topFifth(naturalPassing) * 100).toFixed(0)}% in the top fifth of the band`)
  check(Math.abs(mean(accepted) - mean(naturalPassing)) < 0.06,
    'accepted gaps sit where untouched passing layouts sit',
    `${mean(accepted).toFixed(3)} vs ${mean(naturalPassing).toFixed(3)}`)
  check(Math.abs(topFifth(accepted) - topFifth(naturalPassing)) < 0.08,
    'accepted gaps are not bunched against the limit',
    `${(topFifth(accepted) * 100).toFixed(0)}% vs ${(topFifth(naturalPassing) * 100).toFixed(0)}%`)
  console.log()
}

// -- 5. No positional tell -----------------------------------------------------------------------
// The failure that killed the previous design. It had a pass that shovelled hard squares onto open
// water to stop "hard cells" correlating with "somebody's fleet", and the pass itself created the
// correlation it was there to prevent - hard squares became measurably RARER under a hull, which is
// a free read on where the enemy is not.
//
// Under rejection sampling there is nothing to create such a bias: the test compares two fleets to
// each other and cares nothing about what is under a hull in absolute terms. So the rate of
// hard-to-reach squares on ship cells must match the rate on open water.
console.log('positional tell (hard squares under a hull vs on open water)')
{
  const cells = 100
  // Deliberately the largest sample in this file. It is the security-relevant check - a systematic
  // difference here is a readable tell about where hulls are - so it is the one place worth paying
  // for the extra draws rather than trusting a thin sample.
  const TRIALS = 200
  let hardOnShips = 0
  let shipCells = 0
  let hardOnWater = 0
  let waterCells = 0
  for (let trial = 0; trial < TRIALS; trial++) {
    const cost = boardCost(`tell-${trial}`, cells)
    const regions = boardRegions(`tell-${trial}`, cells)
    const fleets = makeFleets(10, 'Classic')
    const res = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom(`tell-${trial}:salt`)) })
    const occupied = new Set(fleets.flatMap((f) => fleetCells(f)))
    for (let c = 0; c < cells; c++) {
      const hard = cost[res.perm[c]] > LONG_SQUARE
      if (occupied.has(c)) {
        shipCells++
        if (hard) hardOnShips++
      } else {
        waterCells++
        if (hard) hardOnWater++
      }
    }
  }
  const onShips = hardOnShips / shipCells
  const onWater = hardOnWater / waterCells
  console.log(`  under a hull  ${(onShips * 100).toFixed(1)}%   open water  ${(onWater * 100).toFixed(1)}%   over ${TRIALS} boards`)
  check(Math.abs(onShips - onWater) < 0.02,
    'hard squares are no rarer under a hull than anywhere else',
    `${(onShips * 100).toFixed(1)}% vs ${(onWater * 100).toFixed(1)}%`)
  console.log()
}

// -- 6. Declumping ------------------------------------------------------------------------------
// Always on, and exempt from the anti-tell reasoning above because crowding is a property of the
// board everyone is about to look at - it does not know where a ship is, so conditioning on it
// publishes nothing.
console.log('region declumping')
{
  const TRIALS = 12
  for (const boardSize of [8, 10, 12]) {
    const cells = boardSize * boardSize
    let ratioSum = 0
    let beforeWorst3 = 0
    let afterWorst3 = 0
    let beforeAdj = 0
    let afterAdj = 0
    for (let trial = 0; trial < TRIALS; trial++) {
      const cost = boardCost(`clump-${boardSize}-${trial}`, cells)
      const regions = boardRegions(`clump-${boardSize}-${trial}`, cells)
      const fleets = makeFleets(boardSize, 'Classic')
      const res = balanceBoard({ cost, regions, boardSize, fleets, next: rng(seedFrom(`clump-${boardSize}-${trial}:salt`)) })
      ratioSum += (res.clumpAfter ?? 0) / (res.clumpBefore ?? 1)
      beforeWorst3 += worstWindow(regions, identity(cells), boardSize, 3)
      afterWorst3 += worstWindow(regions, res.perm, boardSize, 3)
      beforeAdj += adjacentPairs(regions, identity(cells), boardSize)
      afterAdj += adjacentPairs(regions, res.perm, boardSize)
    }
    const ratio = ratioSum / TRIALS
    console.log(`  ${boardSize}x${boardSize}  crowding x${ratio.toFixed(2)}   worst 3x3 ${(beforeWorst3 / TRIALS).toFixed(2)} -> ${(afterWorst3 / TRIALS).toFixed(2)}   adjacency ${(beforeAdj / TRIALS).toFixed(0)} -> ${(afterAdj / TRIALS).toFixed(0)}`)
    check(ratio <= DECLUMP_TARGET_MAX, `${boardSize}x${boardSize} breaks up its clumps`, `ended at x${ratio.toFixed(2)}`)
    check(afterWorst3 < beforeWorst3, `${boardSize}x${boardSize} shrinks the worst 3x3 patch`)
    // Adjacency is the independent witness: it should fall, but a board driven to a checkerboard
    // would read as arranged rather than dealt, so it must not collapse.
    check(afterAdj < beforeAdj && afterAdj > beforeAdj * 0.35,
      `${boardSize}x${boardSize} still looks dealt rather than sorted`,
      `adjacency ${(beforeAdj / TRIALS).toFixed(0)} -> ${(afterAdj / TRIALS).toFixed(0)}`)
  }
  console.log()
}

// -- 7. Multi-team -------------------------------------------------------------------------------
// Three and four teams share one grid, so the gap is measured across all of them rather than between
// a pair. More fleets on the same board means more ways to be lopsided, so this is the configuration
// where the redraw loop has to work hardest.
console.log('three and four teams')
{
  const trialsPerTeamCount = 10
  for (const teams of [3, 4]) {
    const cells = 144
    let worst = 0
    let unaccepted = 0
    let worstFallbackGap = 0
    let worstFallbackLong = 0
    let fallbackNotBetter = 0
    /** What the balancer's own fallback ranking minimises: distance from playable on both tests. */
    const miss = (rank: number, long: number) => rank / RANK_GAP_SECONDS + long / LONG_GAP
    for (let trial = 0; trial < trialsPerTeamCount; trial++) {
      const cost = boardCost(`multi-${teams}-${trial}`, cells)
      const regions = boardRegions(`multi-${teams}-${trial}`, cells)
      const fleets = makeFleets(12, 'Classic', teams)
      const res = balanceBoard({ cost, regions, boardSize: 12, fleets, next: rng(seedFrom(`multi-${teams}-${trial}:salt`)) })
      worst = Math.max(worst, res.attempts)
      if (!res.accepted) unaccepted++
      const actual = fairness(cost, res.perm, fleets)
      const longs = fleets.map((f) => longSquareCount(f.ships, (c) => cost[res.perm[c]], LONG_SQUARE))
      const actualLong = Math.max(...longs) - Math.min(...longs)
      check(!res.accepted || (actual.gap <= res.rankLimit + 1e-9 && actualLong <= res.longLimit),
        `${teams} teams accepted inside both limits`)
      if (!res.accepted) {
        worstFallbackGap = Math.max(worstFallbackGap, actual.gap)
        worstFallbackLong = Math.max(worstFallbackLong, actualLong)
        // The promise a fallback actually makes: the fairest of 300 draws, which must at minimum
        // beat doing nothing. Measured on the combined miss because that is what it optimises - a
        // pure rank-gap bar would call a layout worse for trading four seconds of rank gap for a
        // whole long square, which is the trade the ranking is deliberately there to make.
        const dealtLongs = fleets.map((f) => longSquareCount(f.ships, (c) => cost[c], LONG_SQUARE))
        const dealt = miss(fairness(cost, identity(cells), fleets).gap, Math.max(...dealtLongs) - Math.min(...dealtLongs))
        if (miss(actual.gap, actualLong) >= dealt) fallbackNotBetter++
      }
    }
    console.log(`  ${teams} teams on 12x12  worst ${worst} attempts, ${unaccepted} unaccepted` +
      (unaccepted > 0 ? `, worst fallback ${Math.round(worstFallbackGap)}s rank / ${worstFallbackLong} long` : ''))
    // Four fleets on one grid is the hardest configuration there is: the gap is a spread across all
    // of them, so every extra fleet is another way to be the outlier, and the tight thresholds do
    // occasionally exhaust the budget. That is allowed - what is not allowed is the fallback being
    // bad. An exhausted search still plays the fairest of 300 draws, which is far tighter than the
    // old limits would have ACCEPTED, so the floor under a failure is above the old ceiling.
    // KNOWN GAP rather than a passing state, and recorded here so it cannot be forgotten:
    // RANK_GAP_SECONDS was calibrated on TWO-team boards. The gap is a spread across all fleets, so
    // each extra fleet is another way to be the outlier and a flat limit gets steadily harder to
    // meet - three teams exhaust the budget on most boards and four on all of them, falling back to
    // the fairest layout drawn.
    //
    // That fallback is still tighter than anything the old thresholds would have ACCEPTED, so this
    // is a weaker guarantee rather than a broken one. What it is not is calibrated, and multi-team
    // boards should not be trusted until the limit is swept per team count the way the two-team one
    // was. Asserted at the fallback instead, which is the thing that actually gets played.
    //
    // Two assertions rather than one round number. "Inside a quarter of an hour" was the bar while
    // the fallback minimised the rank gap alone; it now minimises both tests together, so a layout
    // can be sixteen seconds past that bar while being the better board, and a run did exactly that.
    // The bar that survives a change of ranking is the one that says the fallback beat the deal.
    check(fallbackNotBetter === 0,
      `${teams} teams: every fallback is fairer than the raw deal`,
      `${fallbackNotBetter} of ${unaccepted} were not`)
    // And a ceiling anyway, loose enough to be about catastrophe rather than about tuning: a
    // fallback past twenty minutes on a rank gap is a board nobody should be handed whatever it
    // scores on the other test.
    check(worstFallbackGap <= 20 * 60,
      `${teams} teams: no fallback is catastrophically lopsided`,
      `worst fallback gap ${Math.round(worstFallbackGap)}s`)
  }
  console.log()
}

// -- 8. Nothing to balance -----------------------------------------------------------------------
// Degenerate rooms must come back as a working board rather than a throw. startBattle awaits this
// call inside a room start, so anything that escapes here is a room that cannot begin.
console.log('degenerate inputs')
{
  const cells = 100
  const cost = boardCost('degenerate', cells)
  const regions = boardRegions('degenerate', cells)
  const base = { cost, regions, boardSize: 10 }

  const none = balanceBoard({ ...base, fleets: [], next: rng(1) })
  check(!none.balanced && none.perm.length === cells, 'no fleets returns a usable board')

  const one = balanceBoard({ ...base, fleets: [{ team: 0, cells: [1, 2, 3] }], next: rng(1) })
  check(!one.balanced && new Set(one.perm).size === cells, 'a single fleet returns a usable board')

  const empty = balanceBoard({ ...base, fleets: [{ team: 0, cells: [] }, { team: 1, cells: [] }], next: rng(1) })
  check(!empty.balanced, 'fleets with no ships are not balanced against')

  // Junk cell indices must be dropped rather than read off the end of the board: ship_grid arrives
  // as untyped jsonb from the database and nothing upstream promises it is well formed.
  const junk = balanceBoard({
    ...base,
    fleets: [
      { team: 0, cells: [0, 0, -1, 999, 1.5, 5] },
      { team: 1, cells: [10, 11, 12, 13, 14] },
    ],
    next: rng(seedFrom('junk')),
  })
  check(new Set(junk.perm).size === cells && junk.perm.every((v) => Number.isInteger(v) && v >= 0 && v < cells),
    'out-of-range and duplicate cells are ignored')

  // No regions at all: declumping is skipped and only the fairness test runs.
  const noRegions = balanceBoard({
    cost,
    boardSize: 10,
    fleets: makeFleets(10, 'Classic'),
    next: rng(seedFrom('no-regions')),
  })
  check(noRegions.clumpBefore === null && noRegions.clumpAfter === null, 'no regions means no declumping')
  check(new Set(noRegions.perm).size === cells, 'no regions still returns a bijection')

  console.log('  empty, single, malformed and region-less inputs all return a playable board\n')
}

// -- 9. applyBoardPerm rejects what it cannot trust -----------------------------------------------
// The seam auto-fire and the client both read. A permutation it half-applies would put a kill on the
// square that boss used to be on - a shot that lands, reports a result, and is wrong.
console.log('applyBoardPerm')
{
  const board = ['a', 'b', 'c', 'd']
  check(applyBoardPerm(board, [3, 2, 1, 0]).join('') === 'dcba', 'applies a valid permutation')
  check(applyBoardPerm(board, null) === board, 'null is the unbalanced board')
  check(applyBoardPerm(board, undefined) === board, 'undefined is the unbalanced board')
  check(applyBoardPerm(board, [0, 1]) === board, 'a wrong-length permutation is refused')
  check(applyBoardPerm(board, [0, 1, 2, 9]) === board, 'an out-of-range index is refused')
  check(applyBoardPerm(board, [0, 1, 2, 1.5]) === board, 'a non-integer index is refused')
  check(applyBoardPerm([], null).length === 0, 'an empty board is survivable')
  console.log('  valid permutations applied, everything else falls back to the deal\n')
}

// -- 10. limitsFor -------------------------------------------------------------------------------
//
// This section used to read limitsFor(fleetSize) and assert that a bigger fleet earned a wider
// allowance. Both halves went away in the rework and it was left behind: the thresholds stopped
// scaling with fleet size, `hard` stopped existing, and the file kept a reference to a deleted
// constant that crashed the run before the last three sections could report. What replaces it is
// the promise the current design actually makes - one number per test, the same on every board.
console.log('thresholds')
{
  const limits = limitsFor()
  check(limits.rankGap === RANK_GAP_SECONDS, 'the rank gap is the one in boardBalance')
  check(limits.longGap === LONG_GAP, 'the long-square gap is the one in boardBalance')
  // Pinned, because both numbers are the kind that drift upward one tolerance at a time. The rank
  // gap is a comparison between two individual SHIPS, so unlike the burden sums it replaced there
  // is nothing about a bigger fleet that should earn it more room.
  check(limitsFor({ ...DEFAULT_RULES, rankGapSeconds: 60 }).rankGap === 60, 'a profile can override the rank gap')
  check(limitsFor({ ...DEFAULT_RULES, longGap: 0 }).longGap === 0, 'a profile can override the long-square gap')
  check(limits.rankGap === limitsFor(DEFAULT_RULES).rankGap, 'omitting the profile is the default one')
  check(LONG_SQUARE_SECONDS < 90 * 60, 'the long-square line sits below the cost model horizon')
  console.log(`  rank gap ${limits.rankGap}s   long-square gap ${limits.longGap} square(s) past ${LONG_SQUARE_SECONDS}s\n`)
}

// -- 11. the small-crew profile ------------------------------------------------------------------
//
// The two things it promises that the default profile does not: a much tighter burden gap, and a
// floor on how many dlc squares each fleet ends up holding. Both are checked on the set the profile
// actually runs against, because the floor is only satisfiable in terms of what that set deals.
console.log('small-crew profile')
{
  const dlcRules = (boardSize: number) => ({
    ...DEFAULT_RULES,
    regionFloor: smallCrewFloor('dlc', boardSize),
  })

  for (const boardSize of [5, 7, 10]) {
    const cells = boardSize * boardSize
    const rules = dlcRules(boardSize)
    let met = 0
    // Compared as MEANS rather than trial by trial. The loose profile accepts its first passing
    // draw, which is often a perfectly tight one by luck, so a per-board comparison is mostly noise
    // - what the strict profile actually buys is a much better average, and that is the claim.
    let strictTotal = 0
    let looseTotal = 0
    /**
     * Raised from 30, because 30 was not enough to say anything at the bar below.
     *
     * The 7x7 small-crew rate is about 90% - measured at 200 draws, and the same 90% whether the
     * long-square test is on or off, so it is a property of the DLC floor on a short fleet rather
     * than of anything the second test does. At 30 draws that rate has a standard deviation of five
     * and a half points, which put an 85% bar inside one sd of the truth: the seeded run happened to
     * come out at 80% and failed, and any future edit that reshuffled the fleets would have moved it
     * again for no reason anyone could act on.
     *
     * Math.random is pinned at the top of this file, so that is not a flaky test - it is a stable
     * wrong answer, which is worse. More draws is the fix; loosening the bar to fit a small sample
     * would have hidden the real 10%.
     */
    const TRIALS = 100

    for (let trial = 0; trial < TRIALS; trial++) {
      const next = rng(seedFrom(`small-${boardSize}-${trial}:salt`))
      const deal = buildFlatBoard(bosses2v2, cells, rng(seedFrom(`small-deal-${boardSize}-${trial}`)))
      const cost = deal.map((c) => {
        const v = costTable[c.tooltip ?? '']
        if (v === undefined) throw new Error(`no cost for ${c.name}`)
        return v
      })
      const regions = deal.map((c) => c.region ?? null)
      const fleets = makeFleets(boardSize, 'Classic')

      const strict = balanceBoard({ cost, regions, boardSize, fleets, next, rules })
      const loose = balanceBoard({ cost, regions, boardSize, fleets, next: rng(seedFrom(`loose-${boardSize}-${trial}`)) })

      // The floor holds whenever it CAN. A board dealt fewer dlc squares than the fleets need
      // together is unsatisfiable by any permutation, and the fallback is the honest answer there.
      const dlcOnBoard = regions.filter((r) => r === 'dlc').length
      if (dlcOnBoard >= rules.regionFloor.min * fleets.length) {
        if (strict.accepted) {
          check(
            (strict.regionLow ?? 0) >= rules.regionFloor.min,
            `${boardSize}x${boardSize}: an accepted board gives every fleet ${rules.regionFloor.min} dlc square(s)`
          )
          check(strict.rankGapAfter <= strict.rankLimit + 1e-9,
            `${boardSize}x${boardSize}: an accepted board is inside the rank gap`)
          check(strict.longGapAfter <= strict.longLimit,
            `${boardSize}x${boardSize}: an accepted board is inside the long-square gap`)
          met++
        }
      } else {
        met++ // nothing to prove on a board that cannot carry the floor
      }
      strictTotal += strict.rankGapAfter
      looseTotal += loose.rankGapAfter
    }

    const withFloorMean = strictTotal / TRIALS
    const noFloorMean = looseTotal / TRIALS
    // 85% with the true 7x7 rate sitting at about 90% left one board in twenty of headroom, which is
    // not a bar so much as a tripwire. 80% is a real regression by the time it trips, and the
    // printed rate below is what anyone tuning this should read instead of the pass/fail.
    check(met / TRIALS > 0.8, `${boardSize}x${boardSize}: the floor is met or unsatisfiable on >80% of boards`,
      `${((met / TRIALS) * 100).toFixed(0)}%`)
    // Both runs use the same thresholds now, so the floor must not cost much in fairness: it is an
    // extra requirement layered on, not a trade against the thing it sits beside.
    check(
      withFloorMean < noFloorMean * 1.5,
      `${boardSize}x${boardSize}: adding the floor does not blow out the rank gap`,
      `${withFloorMean.toFixed(0)}s with vs ${noFloorMean.toFixed(0)}s without`
    )
    console.log(
      `  ${boardSize}x${boardSize}: floor ${regionFloorFor(boardSize)} dlc/fleet, met-or-impossible on ${((met / TRIALS) * 100).toFixed(0)}%, ` +
        `mean rank gap ${withFloorMean.toFixed(0)}s with the floor vs ${noFloorMean.toFixed(0)}s without`
    )
  }

  // The default profile must be untouched by any of this - every non-2v2 board still depends on it.
  const cells = 100
  const cost = boardCost('untouched-deal', cells)
  const regions = boardRegions('untouched-deal', cells)
  const fleets = makeFleets(10, 'Classic')
  const a = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom('untouched')) })
  const b = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom('untouched')), rules: DEFAULT_RULES })
  check(a.perm.join(',') === b.perm.join(','), 'no rules is byte-for-byte the default rules')
  check(a.regionLow === null, 'the default profile reports no region floor')
  console.log('  the default profile is unchanged\n')
}

// -- 12. what the long-square count actually counts -----------------------------------------------
//
// This slot used to hold the entry-toll checks. The toll was a per-fleet surcharge for owning any
// square of a gated region, and it went away with the burden model it was expressed in - but the
// section stayed, testing a `regionEntryToll` rule the balancer no longer has, against a `gapBefore`
// field it no longer returns. It never ran: the file crashed two sections earlier on a constant
// deleted at the same time, and everything from `thresholds` down had been dead since the rework.
//
// What replaces it is the measurement the new second test rests on, pinned on a board small enough
// to read. Three properties, all of which decide real boards:
//
//   - it counts CELLS, not ships. A hull that is expensive the whole way along is the case the rank
//     profile cannot see, and the case this exists to catch.
//   - a cell two fleets share counts for BOTH. Both sides still have to shoot it off.
//   - the line is strict. A square costing exactly the threshold is not past it.
console.log('long-square counting')
{
  const T = LONG_SQUARE_SECONDS
  const cost = [T + 1, T + 1, T, 10, T + 1, 10, 10, 10, 10]
  const at = (c: number) => cost[c]

  check(longSquareCount([[0, 1]], at, T) === 2, 'both cells of an all-expensive hull count')
  check(longSquareCount([[0, 3]], at, T) === 1, 'a hull with one expensive cell counts one')
  check(longSquareCount([[2, 3]], at, T) === 0, 'a square exactly on the line is not past it')
  check(longSquareCount([[0], [1], [4]], at, T) === 3, 'three separate hulls count three')
  check(longSquareCount([[0, 1], [1, 4]], at, T) === 3, 'a cell shared between two hulls counts once')
  check(longSquareCount([], at, T) === 0, 'a fleet with no ships counts nothing')

  // The whole argument for the second test, in four lines: two fleets the rank profile cannot tell
  // apart, because each has one cell at T+1 gating it, and one of them is expensive throughout.
  const gnarly = [[0, 1]]
  const kind = [[0, 3]]
  check(
    shipCostProfile(gnarly, at).join() === shipCostProfile(kind, at).join(),
    'the rank profile cannot tell an all-expensive hull from a mostly cheap one'
  )
  check(
    longSquareCount(gnarly, at, T) > longSquareCount(kind, at, T),
    'the long-square count can'
  )
  console.log('  cells not ships, shared cells count for both fleets, and the line is strict\n')
}


// -- 13. which side the gap was on ----------------------------------------------------------------
//
// The gap is a spread and a spread has no side, so naming one is a claim the old measurement could
// not make. Two things have to hold for the claim to be worth printing on a recap:
//
//   - the side is read at the rank the gap is WORST at, not the first rank or the average of them.
//     A fleet can be behind at rank 0 and ahead at rank 1; only the rank the number came from has
//     any business naming a fleet.
//   - the team travels with the profile. normalizeFleets drops a fleet with no scorable ships, so
//     position in the profile list is not the position handed in - which is exactly the bug that
//     would print the wrong fleet's name, silently, on a board nobody could check by eye.
console.log('which fleet the gap favoured')
{
  // Rank 0 differs by 10, rank 1 by 100. The worst rank is 1, where fleet B is the cheap one.
  const profiles = [
    [200, 300],
    [190, 200],
  ]
  const detail = rankGapDetail(profiles)
  check(detail.gap === 100, 'the gap is still the widest same-rank spread', String(detail.gap))
  check(detail.rank === 1, 'the side is read at the rank the gap was worst at', String(detail.rank))
  check(detail.ahead === 1, 'the fleet with the cheapest ship at that rank is the one ahead')
  check(detail.behind === 0, 'and the dearest is the one behind')

  const even = rankGapDetail([
    [100, 50],
    [100, 50],
  ])
  check(even.gap === 0, 'two identical fleets have no gap')
  check(even.ahead === null && even.behind === null, 'and no side to name, rather than fleet 0')
  check(rankGapDetail([[100]]).ahead === null, 'one fleet is nobody ahead of anybody')

  // Team 0 holds nothing scorable, so it is dropped and the profiles are teams 1 and 2. Reading the
  // side positionally here would name team 1 as behind when team 2 is.
  const cost = [10, 10, 900, 900]
  const score = scoreLayout(cost, [
    { team: 0, ships: [] },
    { team: 1, ships: [[2, 3]] },
    { team: 2, ships: [[0, 1]] },
  ])
  check(score.teams.join() === '1,2', 'a fleet with no ships is dropped and the labels follow')
  check(score.aheadTeam === 2, 'the cheap fleet is named by TEAM, not by position', String(score.aheadTeam))
  check(score.behindTeam === 1, 'and so is the expensive one', String(score.behindTeam))
  check(
    score.rankGap === 890,
    'naming the side changed nothing about the number beside it',
    String(score.rankGap)
  )
  console.log('  read at the worst rank, labelled by team, and no side on an even board')
  console.log('')
}


console.log(failures === 0 ? 'All board balance checks passed.' : `${failures} check(s) failed.`)
process.exitCode = failures === 0 ? 0 : 1
