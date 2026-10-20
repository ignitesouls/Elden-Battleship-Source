/**
 * Checks the official pool cutoffs against the data they were computed from.
 *
 * The cutoffs are frozen numbers derived from the cost table, the prerequisites and both boss sets.
 * Regenerate any of those and the cutoffs silently describe a board that no longer exists - too
 * strict and official-seed works harder, too loose and the guarantee quietly stops being one. So
 * this fails until scripts/build-pool-cutoffs.ts has been rerun, and then re-measures, on a fresh
 * batch, that each cutoff lets through roughly the share of pools it claims to.
 *
 *   node --experimental-strip-types scripts/check-official-pool.ts
 */
import { readFileSync } from 'node:fs'
import { buildFlatBoard, dealtPool, type Challenge } from '../src/lib/squareSetFormat.ts'
import { effectiveCosts } from '../src/lib/prereqCost.ts'
import { rng, seedFrom } from '../src/lib/seededRandom.ts'
import { BOARD_SIZES } from '../src/types/battleship.ts'
import {
  OFFICIAL_POOL_PERCENTILE,
  POOL_SOURCE_FILES,
  VETTED_SETS,
  cutoffFor,
  poolSourceHash,
  poolSpread,
  type PoolCutoffTable,
} from '../src/lib/officialPool.ts'

let failures = 0
function check(ok: boolean, label: string, detail = '') {
  if (!ok) {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`)
  }
}

const file = (p: string) => readFileSync(new URL(`../src/data/${p}`, import.meta.url), 'utf8')
const texts = POOL_SOURCE_FILES.map(file)
const table = JSON.parse(file('officialPoolCutoffs.json')) as PoolCutoffTable

console.log('official pool cutoffs')

// -- 1. the table was computed from the files on disk ---------------------------------------------
check(
  table.source === poolSourceHash(texts),
  'the cutoffs were computed from the current cost table, prerequisites and boss sets',
  'regenerate with: node --experimental-strip-types scripts/build-pool-cutoffs.ts'
)
check(table.percentile === OFFICIAL_POOL_PERCENTILE, 'the table was built at the percentile the code uses')

// -- 2. the pure pieces ---------------------------------------------------------------------------
check(poolSpread([]) === 0, 'an empty pool has no spread')
check(poolSpread([5, 5, 5]) === 0, 'an all-equal pool has no spread')
check(Math.abs(poolSpread([0, 10]) - 5) < 1e-9, 'spread is the population standard deviation')
check(cutoffFor(table, 'objectives', 10) === null, 'a set with no costs has no cutoff')
check(cutoffFor(table, 'bosses', 99) === null, 'a board size nobody can have has no cutoff')
check(poolSourceHash(['a\r\nb']) === poolSourceHash(['a\nb']), 'the fingerprint ignores line endings')

// -- 3. every board a vetted room can be on has a cutoff, and it lets through about the right share --
const [bossText, boss2v2Text, costText, prereqText] = texts
const sets: Record<string, Challenge[]> = { bosses: JSON.parse(bossText), 'bosses-2v2': JSON.parse(boss2v2Text) }
const costT = JSON.parse(costText) as Record<string, number>
const prereqs = JSON.parse(prereqText) as Record<string, unknown>
const costByName: Record<string, number> = {}
for (const set of Object.values(sets)) for (const s of set) if (costT[s.tooltip ?? ''] !== undefined) costByName[s.name] = costT[s.tooltip ?? '']
const now = new Date().toISOString()

// The same deal as build-pool-cutoffs, balance-board and official-seed.
function dealCost(setId: string, roomId: string, seed: string, cells: number): number[] {
  const base = setId === 'bosses' ? roomId : `${roomId}:${setId}`
  const board = buildFlatBoard(dealtPool(sets[setId], now), cells, rng(seedFrom(`${base}:${seed}`)))
  return effectiveCosts(board, board.map((s) => costT[s.tooltip ?? '']), prereqs, costByName)
}

// A different stream from the builder's, so this is a fresh sample rather than a re-read of its own.
const draw = rng(seedFrom('official-pool-check'))
const SAMPLES = 4000
for (const setId of VETTED_SETS) {
  const pool = dealtPool(sets[setId], now).length
  for (const size of BOARD_SIZES) {
    const cells = size * size
    if (cells > pool) continue
    const cut = cutoffFor(table, setId, size)
    check(cut !== null, `${setId} ${size}x${size} has a cutoff`)
    if (cut === null) continue
    let under = 0
    for (let i = 0; i < SAMPLES; i++) {
      const room = `check-${Math.floor(draw() * 1e12)}`
      const seed = String(100_000_000 + Math.floor(draw() * 900_000_000))
      if (poolSpread(dealCost(setId, room, seed, cells)) <= cut) under++
    }
    // Generous bounds: 4000 draws at the target share expect a few dozen hits, and the point is to
    // catch a cutoff that is wildly off (the wrong size, the wrong set, a stale table), not to
    // re-estimate the percentile.
    const share = under / SAMPLES
    check(
      share > OFFICIAL_POOL_PERCENTILE * 0.3 && share < OFFICIAL_POOL_PERCENTILE * 2.5,
      `${setId} ${size}x${size}'s cutoff lets through about the intended share of pools`,
      `${(share * 100).toFixed(2)}%`
    )
  }
}

if (failures > 0) {
  console.log(`\n${failures} official pool check(s) FAILED`)
  process.exit(1)
}
console.log('  all official pool checks passed\n')
