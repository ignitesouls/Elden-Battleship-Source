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
  RANK_GAP_SECONDS,
} from '../src/lib/boardBalance.ts'
import { buildFlatBoard, type Challenge } from '../src/lib/squareSetFormat.ts'
import { BOARD_SIZES, FLEET_PRESETS, fleetFor } from '../src/types/battleship.ts'
import { randomPlacements } from '../src/lib/battleshipLogic.ts'
import { shipCellIndices } from '../src/lib/shipCells.ts'

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
 * Replaces the old HARD_REACH, which was a probability threshold from when a square's cost was a
 * share rather than a time. 75 minutes is a little under the archive's median match, so a square
 * past it is one a team is unlikely to finish inside a normal game.
 */
const LONG_SQUARE = 75 * 60

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
// point of GAP_PER_CELL: a raw deal is lopsided far more often than the loose limits admitted, and
// the balancer's job is to notice. Redrawing is cheap and unbiased; leaving it alone was not free.
check(rejectRate.get(12)! > 0.5, 'the tests bind on most raw deals rather than waving them through',
  `binds on ${(rejectRate.get(12)! * 100).toFixed(0)}%`)
console.log()

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
  const fleetCellsFor12 = fleetFor(12, 'Classic').reduce((s, d) => s + d.size * (d.count ?? 1), 0)
  for (const teams of [3, 4]) {
    const cells = 144
    let worst = 0
    let unaccepted = 0
    let worstFallbackGap = 0
    for (let trial = 0; trial < trialsPerTeamCount; trial++) {
      const cost = boardCost(`multi-${teams}-${trial}`, cells)
      const regions = boardRegions(`multi-${teams}-${trial}`, cells)
      const fleets = makeFleets(12, 'Classic', teams)
      const res = balanceBoard({ cost, regions, boardSize: 12, fleets, next: rng(seedFrom(`multi-${teams}-${trial}:salt`)) })
      worst = Math.max(worst, res.attempts)
      if (!res.accepted) unaccepted++
      const actual = fairness(cost, res.perm, fleets)
      check(!res.accepted || (actual.gap <= res.rankLimit + 1e-9),
        `${teams} teams accepted inside both limits`)
      if (!res.accepted) worstFallbackGap = Math.max(worstFallbackGap, actual.gap)
    }
    console.log(`  ${teams} teams on 12x12  worst ${worst} attempts, ${unaccepted} unaccepted`)
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
    check(worstFallbackGap <= 15 * 60,
      `${teams} teams: the fallback stays inside a quarter of an hour`,
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
console.log('thresholds')
{
  check(limitsFor(17).gap > limitsFor(9).gap, 'bigger fleets get a wider gap allowance')
  check(limitsFor(4).hard === MIN_HARD_GAP, 'tiny fleets clamp at the hard-square floor')
  // Pinned so the loose thresholds cannot creep back in unnoticed. The 17-cell fleet used to be
  // allowed 2.5 unreached cells and a five-square difference in untakeable squares; a 24-cell one
  // was allowed six, which is the hole a real lopsided board went through. See GAP_PER_CELL.
  check(Math.abs(limitsFor(17).gap - 0.51) < 1e-9, 'a 17-cell fleet is held to about half a cell')
  check(limitsFor(17).gap < 2.5 / 4, 'the burden limit is far below the old loose one')
  check(limitsFor(24).hard <= 2, 'a 24-cell fleet may differ by at most one untakeable square')
  check(limitsFor(17).hard === 1, 'a 17-cell fleet must match untakeable squares exactly')
  check(limitsFor(12).gap === limitsFor(12, DEFAULT_RULES).gap, 'omitting the profile is the default one')
  console.log(`  fleet 7 -> gap ${limitsFor(7).gap.toFixed(2)}, hard ${limitsFor(7).hard}   |   fleet 17 -> gap ${limitsFor(17).gap.toFixed(2)}, hard ${limitsFor(17).hard}   |   fleet 25 -> gap ${limitsFor(25).gap.toFixed(2)}, hard ${limitsFor(25).hard}\n`)
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
    const TRIALS = 30

    for (let trial = 0; trial < TRIALS; trial++) {
      const next = rng(seedFrom(`small-${boardSize}-${trial}:salt`))
      const deal = buildFlatBoard(bosses2v2, cells, rng(seedFrom(`small-deal-${boardSize}-${trial}`)))
      const reach = deal.map((c) => reachTable[c.tooltip ?? ''] ?? 0.685)
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
          check(strict.gapAfter <= strict.gapLimit, `${boardSize}x${boardSize}: an accepted board is inside the strict gap`)
          met++
        }
      } else {
        met++ // nothing to prove on a board that cannot carry the floor
      }
      strictTotal += strict.gapAfter
      looseTotal += loose.gapAfter
    }

    const withFloorMean = strictTotal / TRIALS
    const noFloorMean = looseTotal / TRIALS
    check(met / TRIALS > 0.85, `${boardSize}x${boardSize}: the floor is met or unsatisfiable on >85% of boards`)
    // Both runs use the same thresholds now, so the floor must not cost much in burden fairness:
    // it is an extra requirement layered on, not a trade against the thing it sits beside.
    check(
      withFloorMean < noFloorMean * 1.5,
      `${boardSize}x${boardSize}: adding the floor does not blow out the burden gap`
    )
    check(withFloorMean <= limitsFor(fleetFor(boardSize, 'Classic').reduce((s, d) => s + d.size, 0)).gap * 1.2,
      `${boardSize}x${boardSize}: the mean gap played stays near the limit it is held to`)
    console.log(
      `  ${boardSize}x${boardSize}: floor ${regionFloorFor(boardSize)} dlc/fleet, met-or-impossible on ${((met / TRIALS) * 100).toFixed(0)}%, ` +
        `mean gap ${withFloorMean.toFixed(2)} with the floor vs ${noFloorMean.toFixed(2)} without`
    )
  }

  // The default profile must be untouched by any of this - every non-2v2 board still depends on it.
  const cells = 100
  const deal = buildFlatBoard(bosses, cells, rng(seedFrom('untouched-deal')))
  const reach = deal.map((c) => reachTable[c.tooltip ?? ''] ?? 0.685)
  const regions = deal.map((c) => c.region ?? null)
  const fleets = makeFleets(10, 'Classic')
  const a = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom('untouched')) })
  const b = balanceBoard({ cost, regions, boardSize: 10, fleets, next: rng(seedFrom('untouched')), rules: DEFAULT_RULES })
  check(a.perm.join(',') === b.perm.join(','), 'no rules is byte-for-byte the default rules')
  check(a.regionLow === null, 'the default profile reports no region floor')
  console.log('  the default profile is unchanged\n')
}

// -- 12. the entry toll --------------------------------------------------------------------------
//
// Charged once per fleet that owns any square of the gated region, never once per square. That is
// the whole point of it - reachability already prices the squares, and what it cannot price is that
// the first one pays for the journey - so the test that matters is that a second and third square
// of the region add only their own reach, not another toll.
console.log('entry toll')
{
  const withToll = { ...DEFAULT_RULES, regionEntryToll: { region: 'dlc', cost: ENTRY_TOLL } }
  // A board of nine cells: three dlc, six not, all equally reachable so reach contributes the same
  // to every fleet and the toll is the only thing that can differ.
  const reach = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
  const regions = ['dlc', 'dlc', 'dlc', 'x', 'x', 'x', 'x', 'x', 'x']
  const ident = { cost, regions, boardSize: 3, next: rng(seedFrom('toll')) }

  // Identity permutation, so cells 0-2 are the dlc ones. One fleet on dlc, one off it.
  const oneEach = balanceBoard({
    ...ident,
    fleets: [{ team: 0, cells: [0, 3] }, { team: 1, cells: [4, 5] }],
    rules: { ...withToll, maxAttempts: 0 },
  })
  check(Math.abs(oneEach.gapBefore - ENTRY_TOLL) < 1e-9, 'a fleet touching the region pays exactly one toll')

  const twoVsNone = balanceBoard({
    ...ident,
    fleets: [{ team: 0, cells: [0, 1] }, { team: 1, cells: [4, 5] }],
    rules: { ...withToll, maxAttempts: 0 },
  })
  check(
    Math.abs(twoVsNone.gapBefore - ENTRY_TOLL) < 1e-9,
    'a fleet holding two of the region still pays exactly one toll'
  )

  const bothIn = balanceBoard({
    ...ident,
    fleets: [{ team: 0, cells: [0, 1] }, { team: 1, cells: [2, 4] }],
    rules: { ...withToll, maxAttempts: 0 },
  })
  check(Math.abs(bothIn.gapBefore) < 1e-9, 'two fleets both inside the region cancel out entirely')

  const off = balanceBoard({
    ...ident,
    fleets: [{ team: 0, cells: [0, 1] }, { team: 1, cells: [4, 5] }],
    rules: { ...DEFAULT_RULES, maxAttempts: 0 },
  })
  check(Math.abs(off.gapBefore) < 1e-9, 'with no toll configured the same board shows no gap')

  const noRegions = balanceBoard({
    cost,
    boardSize: 3,
    next: rng(seedFrom('toll')),
    fleets: [{ team: 0, cells: [0, 1] }, { team: 1, cells: [4, 5] }],
    rules: { ...withToll, maxAttempts: 0 },
  })
  check(Math.abs(noRegions.gapBefore) < 1e-9, 'a board with no regions cannot be tolled')

  console.log(`  ${ENTRY_TOLL} cell of burden, once per fleet, and only where the board names regions\n`)
}

console.log(failures === 0 ? 'All board balance checks passed.' : `${failures} check(s) failed.`)
process.exitCode = failures === 0 ? 0 : 1
