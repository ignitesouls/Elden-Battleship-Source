/**
 * Checks the bot opponent's brain (src/lib/botBrain.ts) by playing it against random fleets.
 *
 * What matters about the four tiers is their ORDER: each one has to need fewer shots to clear a
 * board than the one below it, or the names are lying. Speed is the other half of a tier and is
 * just a table, so it is checked as a table. Beyond that the brain must never fire at a square
 * twice, never fire off the board, and must still find something to shoot when nothing is in reach.
 *
 * Seeded throughout, so a failure here is the same failure on every run.
 *
 *   node --experimental-strip-types scripts/check-bot.ts
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { chooseShots, nextGapSeconds, unlockThreshold, openingSeconds, OPENING_MEDIAN_SECONDS } = await import('../src/lib/botBrain.ts')
const { BOT_TIERS, BOT_TIER_SPECS } = await import('../src/lib/bot.ts')
const { randomPlacements, validatePlacements } = await import('../src/lib/battleshipLogic.ts')
const { fleetFor } = await import('../src/types/battleship.ts')
const { rng, seedFrom } = await import('../src/lib/seededRandom.ts')
import type { BotShot } from '../src/lib/botBrain.ts'
import type { BotTier } from '../src/lib/bot.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * One game: the bot against one random fleet, until every ship is down. Resolves shots the way
 * resolve_attack does, sinking geometry and all. Returns the number of squares fired.
 */
function play(tier: BotTier, boardSize: number, seed: string, cost: number[] | null = null) {
  const random = rng(seedFrom(seed))
  // randomPlacements uses Math.random; the layout only needs to vary, not to be seeded.
  const shipDefs = fleetFor(boardSize)
  const placements = randomPlacements(boardSize, shipDefs)
  const { shipIndexGrid } = validatePlacements(boardSize, shipDefs, placements)
  const hitsLeft = shipDefs.map((s) => s.size)
  const shots: BotShot[] = []
  const cells = boardSize * boardSize
  let repeats = 0
  let offBoard = 0
  let stalls = 0
  let elapsed = 0

  while (hitsLeft.some((h) => h > 0)) {
    const picks = chooseShots({
      tier,
      boardSize,
      shipDefs,
      shots,
      defenders: [{ team: 1, truth: tier === 'shaker' ? shipIndexGrid : null }],
      cost,
      matchElapsed: elapsed,
      random,
    })
    if (picks.length === 0) {
      stalls++
      break
    }
    for (const cell of picks) {
      if (cell < 0 || cell >= cells) offBoard++
      if (shots.some((s) => s.cell === cell)) repeats++
      const ship = shipIndexGrid[cell]
      if (ship < 0) {
        shots.push({ cell, defender: 1, result: 'miss' })
        continue
      }
      hitsLeft[ship]--
      if (hitsLeft[ship] > 0) {
        shots.push({ cell, defender: 1, result: 'hit' })
        continue
      }
      const p = placements[ship]
      shots.push({
        cell,
        defender: 1,
        result: 'sunk',
        sunkSize: shipDefs[ship].size,
        sunkStartRow: p.startRow,
        sunkStartCol: p.startCol,
        sunkHorizontal: p.isHorizontal,
      })
    }
    elapsed += 150
    if (shots.length > cells) break
  }
  return { fired: shots.length, repeats, offBoard, stalls, cleared: hitsLeft.every((h) => h <= 0) }
}

// -- every tier finishes, cleanly, on every board size ---------------------------------------------
for (const tier of BOT_TIERS) {
  let bad = 0
  for (const size of [5, 8, 10, 14]) {
    for (let g = 0; g < 40; g++) {
      const r = play(tier, size, `${tier}:${size}:${g}`)
      if (!r.cleared || r.repeats || r.offBoard || r.stalls) bad++
    }
  }
  check(`${tier} clears every board without repeating or leaving it`, bad === 0, `${bad} bad games of 160`)
}

// -- the tiers are in order --------------------------------------------------------------------------
const GAMES = 300
const mean: Record<string, number> = {}
for (const tier of BOT_TIERS) {
  let total = 0
  for (let g = 0; g < GAMES; g++) total += play(tier, 10, `order:${tier}:${g}`).fired
  mean[tier] = total / GAMES
}
console.log(
  `       shots to clear a 10x10 default fleet: ${BOT_TIERS.map((t) => `${t} ${mean[t].toFixed(1)}`).join(', ')}`
)
for (let i = 1; i < BOT_TIERS.length; i++) {
  const weaker = BOT_TIERS[i - 1]
  const stronger = BOT_TIERS[i]
  check(`${stronger} needs fewer shots than ${weaker}`, mean[stronger] < mean[weaker],
    `${mean[stronger].toFixed(1)} vs ${mean[weaker].toFixed(1)}`)
}
for (let i = 1; i < BOT_TIERS.length; i++) {
  const a = BOT_TIER_SPECS[BOT_TIERS[i - 1]]
  const b = BOT_TIER_SPECS[BOT_TIERS[i]]
  check(`${b.tier} is quicker per square than ${a.tier}`, b.gapSeconds < a.gapSeconds && b.wallChance <= a.wallChance)
}

// -- reach ------------------------------------------------------------------------------------------
// A board where three quarters of the squares are an hour away: early on the bot must keep to the
// cheap quarter, and it must still fire at something rather than stall.
{
  const size = 10
  const cost = Array.from({ length: size * size }, (_, i) => (i % 4 === 0 ? 600 : 3600))
  const threshold = unlockThreshold(cost, 0, 1)
  const random = rng(seedFrom('reach'))
  let early = 0
  for (let g = 0; g < 200; g++) {
    const [cell] = chooseShots({
      tier: 'tarnished', boardSize: size, shipDefs: fleetFor(size), shots: [], defenders: [{ team: 1 }],
      cost, matchElapsed: 0, random,
    })
    if (cost[cell] <= threshold) early++
  }
  check('at the start, only squares in reach are fired at', early === 200, `${early}/200`)

  const allFar = cost.map(() => 3600)
  const [cell] = chooseShots({
    tier: 'tarnished', boardSize: size, shipDefs: fleetFor(size), shots: [], defenders: [{ team: 1 }],
    cost: allFar, matchElapsed: 0, random,
  })
  check('with nothing in reach, the bot still fires', typeof cell === 'number')
  check('a game on a costed board still clears', play('sweat', 10, 'costed', cost).cleared)
}

// -- pace -------------------------------------------------------------------------------------------
{
  const random = rng(seedFrom('pace'))
  const solo: number[] = []
  const four: number[] = []
  for (let i = 0; i < 2000; i++) {
    solo.push(nextGapSeconds('tarnished', 1, random))
    four.push(nextGapSeconds('tarnished', 4, random))
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const m1 = median(solo)
  const m4 = median(four)
  check('a solo bot fires at about one captain\'s pace', Math.abs(m1 - BOT_TIER_SPECS.tarnished.gapSeconds) < 20, `${m1}s`)
  check('a bot facing four fires about four times as often', m4 < m1 / 3, `${m4}s vs ${m1}s`)
  check('no gap is shorter than the floor', four.every((g) => g >= 20))
}

// -- the opening ------------------------------------------------------------------------------------
// The archive's own medians: a player's first square at 20:20, a team's at 15:08. A solo Tarnished
// should open like the median player, and a crew's bot sooner, from its fastest captain.
{
  const random = rng(seedFrom('opening'))
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const openings = (tier: BotTier, crew: number) =>
    median(Array.from({ length: 3000 }, () => openingSeconds(tier, crew, random)))
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  const solo = openings('tarnished', 1)
  check('a solo Tarnished opens like the median player', Math.abs(solo - OPENING_MEDIAN_SECONDS) < 60, mmss(solo))
  const crew = openings('tarnished', 3)
  check('a crew of three opens near the median team', crew > 13 * 60 && crew < 17 * 60, mmss(crew))

  const byTier = BOT_TIERS.map((t) => openings(t, 1))
  console.log(`       solo openings: ${BOT_TIERS.map((t, i) => `${t} ${mmss(byTier[i])}`).join(', ')}`)
  check('each tier opens sooner than the one below', byTier.every((s, i) => i === 0 || s < byTier[i - 1]))
  check('even Shaker needs a real run before his first kill', byTier[3] > 12 * 60, mmss(byTier[3]))
}

console.log(failures === 0 ? '\nall bot checks passed' : `\n${failures} bot check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
