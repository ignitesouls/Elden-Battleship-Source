/**
 * Checks the bot crew (src/lib/botCrew.ts) by playing whole matches on real dealt boss boards.
 *
 * The crew is meant to look like a real crew from the outside, so the checks are about what a
 * spectator would notice: the three captains of a three-player crew keep to the lanes real crews
 * keep to, nobody fires into the DLC before they have entry, nobody does a square before what it
 * needs, the early-value bosses go early, the first shot comes after a real opening, and the crew
 * fires about as many squares in an evening as a real one. Plus the plumbing: no square twice.
 *
 * Seeded, so a failure is the same failure every run.
 *
 *   node --experimental-strip-types scripts/check-bot-crew.ts
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

const { newCrew, playCrew, crewDue, crewReady } = await import('../src/lib/botCrew.ts')
const { aimWeights } = await import('../src/lib/botBrain.ts')
const { stepsTo, hasDlcEntry, BOT_PREREQS, DLC_MAJOR_GATES, DLC_MINOR_GATES, EARLY_VALUE } = await import('../src/lib/botRules.ts')
const { buildFlatBoard, dealtPool } = await import('../src/lib/squareSetFormat.ts')
const { randomPlacements, validatePlacements } = await import('../src/lib/battleshipLogic.ts')
const { fleetFor } = await import('../src/types/battleship.ts')
const { rng, seedFrom } = await import('../src/lib/seededRandom.ts')
import type { BotTier } from '../src/lib/bot.ts'
import type { BotShot } from '../src/lib/botBrain.ts'
import type { CrewWorld, BotRoutes } from '../src/lib/botCrew.ts'

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const squares = read('../src/data/battleshipChallenges.json') as { name: string; tooltip: string; region: string }[]
const routes = read('../src/data/botRoutes.json') as BotRoutes
const shared = read('../src/data/bossPrereqs.json') as Record<string, unknown>
const byName = new Map(squares.map((s) => [s.name, s]))

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

// -- the rules name real squares ---------------------------------------------------------------------
{
  const named = [...Object.keys(BOT_PREREQS), ...Object.values(BOT_PREREQS).flat(2), ...DLC_MAJOR_GATES, ...DLC_MINOR_GATES, ...EARLY_VALUE]
  const unknown = named.filter((n) => typeof n === 'string' && !byName.has(n))
  check('every name in the bot rules is a square', unknown.length === 0, unknown.join(', '))
  check('every square has route data', squares.every((s) => routes.squares[s.name]), '')
}

interface Played {
  shots: { cell: number; at: number }[]
  captains: { label: string; kills: string[] }[]
  board: { name: string; region: string }[]
  hits: number
}

/** One match: a bot crew against one random fleet, minute by minute, for `minutes`. */
function play(tier: BotTier, crew: number, seed: string, size = 10, minutes = 90): Played {
  const random = rng(seedFrom(seed))
  const cells = size * size
  const board = buildFlatBoard(dealtPool(squares, null), cells, rng(seedFrom(`board:${seed}`))) as unknown as {
    name: string
    tooltip: string
    region: string
  }[]
  const shipDefs = fleetFor(size)
  const placements = randomPlacements(size, shipDefs)
  const { shipIndexGrid } = validatePlacements(size, shipDefs, placements)
  const hitsLeft = shipDefs.map((s) => s.size)

  const world: CrewWorld = { tier, routes, shared, board, lookup: (n) => byName.get(n) }
  const shots: BotShot[] = []
  const fired: { cell: number; at: number }[] = []
  const turn = () => ({
    fired: new Set(shots.map((s) => s.cell)),
    aim: aimWeights({
      tier, boardSize: size, shipDefs, shots,
      defenders: [{ team: 1, truth: tier === 'shaker' ? shipIndexGrid : null }],
    }),
    random,
  })

  const state = newCrew(world, crew, turn())
  let hits = 0
  for (let now = 0; now <= minutes * 60; now += 30) {
    if (crewDue(state) > now) continue
    for (const cell of playCrew(state, world, turn(), now)) {
      fired.push({ cell, at: now })
      const ship = shipIndexGrid[cell]
      if (ship < 0) {
        shots.push({ cell, defender: 1, result: 'miss' })
        continue
      }
      hits++
      hitsLeft[ship]--
      const p = placements[ship]
      shots.push(hitsLeft[ship] > 0
        ? { cell, defender: 1, result: 'hit' }
        : { cell, defender: 1, result: 'sunk', sunkSize: shipDefs[ship].size, sunkStartRow: p.startRow, sunkStartCol: p.startCol, sunkHorizontal: p.isHorizontal })
    }
  }
  return { shots: fired, captains: state.captains.map((c) => ({ label: c.label, kills: c.kills })), board, hits }
}

check('the crew runs on a dealt boss board', crewReady({ routes, board: buildFlatBoard(dealtPool(squares, null), 100, rng(1)) as never }))

// -- three captains, three lanes ---------------------------------------------------------------------
const GAMES = 40
const games = Array.from({ length: GAMES }, (_, g) => play('tarnished', 3, `three:${g}`))
{
  const mix = (label: string) => {
    const counts: Record<string, number> = {}
    let n = 0
    for (const game of games) {
      const onBoard = new Set(game.board.map((s) => s.name))
      for (const c of game.captains.filter((x) => x.label === label)) {
        for (const k of c.kills) {
          if (!onBoard.has(k)) continue
          const r = byName.get(k)!.region
          counts[r] = (counts[r] ?? 0) + 1
          n++
        }
      }
    }
    return (r: string[]) => r.reduce((s, x) => s + (counts[x] ?? 0), 0) / Math.max(1, n)
  }
  const lim = mix('limgrave')
  const flex = mix('flex')
  const dlc = mix('dlc')
  const pct = (x: number) => `${Math.round(x * 100)}%`
  check('the Limgrave player keeps to Limgrave, Liurnia and Caelid', lim(['limgrave', 'liurnia', 'caelid']) > 0.6,
    pct(lim(['limgrave', 'liurnia', 'caelid'])))
  check('the flex player keeps to Altus and the Mountaintops', flex(['altus', 'mountaintops']) > 0.4,
    pct(flex(['altus', 'mountaintops'])))
  check('the DLC player spends most of the evening in the DLC', dlc(['dlc']) > 0.3, pct(dlc(['dlc'])))
  check('the Limgrave player all but never goes to the DLC', lim(['dlc']) < 0.05, pct(lim(['dlc'])))
}

// -- the rules hold, captain by captain ----------------------------------------------------------------
{
  let broken = 0
  let dlcEarly = 0
  const price = (n: string) => routes.squares[n]?.gap ?? routes.overallGap
  for (const tier of ['chud', 'tarnished', 'sweat', 'shaker'] as BotTier[]) {
    for (let g = 0; g < 15; g++) {
      for (const c of play(tier, 3, `rules:${tier}:${g}`).captains) {
        const done = new Set<string>()
        for (const k of c.kills) {
          if (byName.get(k)?.region === 'dlc' && !hasDlcEntry(done)) dlcEarly++
          if (stepsTo(k, done, (n) => byName.get(n), shared, price).length > 0) broken++
          done.add(k)
        }
      }
    }
  }
  check('nobody does a square before what it needs', broken === 0, `${broken} out of order`)
  check('nobody enters the DLC before earning entry', dlcEarly === 0, `${dlcEarly} too early`)
}

// -- the shape of an evening ---------------------------------------------------------------------------
{
  const first = games.map((g) => g.shots[0]?.at ?? Infinity).sort((a, b) => a - b)
  const med = first[Math.floor(first.length / 2)]
  check('a crew of three opens about when real crews do', med > 10 * 60 && med < 22 * 60, `${Math.round(med / 60)} min`)

  // What real crews have fired by these minutes - medians over the archive, October 2026 (boss sets,
  // voided matches out, only matches that lasted that long). A Tarnished crew is the median crew, so
  // it should land within about a quarter of these.
  const REAL: Record<number, Record<number, number>> = {
    1: { 40: 6, 60: 10, 81: 16 },
    3: { 40: 25, 60: 46, 81: 65 },
  }
  const solos = Array.from({ length: GAMES }, (_, g) => play('tarnished', 1, `solo:${g}`))
  const medianBy = (list: Played[], min: number) =>
    list.map((g) => g.shots.filter((s) => s.at <= min * 60).length).sort((a, b) => a - b)[Math.floor(list.length / 2)]
  for (const [crew, list] of [[3, games], [1, solos]] as const) {
    for (const min of [40, 60, 81]) {
      const got = medianBy(list, min)
      const want = REAL[crew][min]
      check(`a crew of ${crew} has fired about what a real one has by minute ${min}`,
        Math.abs(got - want) <= Math.max(4, want * 0.25), `${got} vs ${want}`)
    }
  }

  let early = 0
  let dealt = 0
  for (const g of games) {
    for (const name of EARLY_VALUE) {
      const cell = g.board.findIndex((s) => s.name === name)
      if (cell < 0) continue
      dealt++
      const shot = g.shots.find((s) => s.cell === cell)
      if (shot && shot.at <= 40 * 60) early++
    }
  }
  check('the early-value bosses mostly go in the first forty minutes', early / Math.max(1, dealt) > 0.5, `${early}/${dealt}`)

  const repeats = games.filter((g) => new Set(g.shots.map((s) => s.cell)).size !== g.shots.length).length
  check('no square is fired at twice', repeats === 0, `${repeats} games`)
}

// -- tiers ---------------------------------------------------------------------------------------------
{
  const hits = (tier: BotTier) =>
    Array.from({ length: 30 }, (_, g) => play(tier, 3, `tier:${g}`, 10, 60).hits).reduce((s, h) => s + h, 0) / 30
  const h = { chud: hits('chud'), tarnished: hits('tarnished'), sweat: hits('sweat'), shaker: hits('shaker') }
  console.log(`       hits in the first hour, crew of three: ${Object.entries(h).map(([t, v]) => `${t} ${v.toFixed(1)}`).join(', ')}`)
  check('Shaker lands more than Chud', h.shaker > h.chud)
  check('Sweat lands more than Tarnished', h.sweat > h.tarnished)
}

console.log(failures === 0 ? '\nall bot crew checks passed' : `\n${failures} bot crew check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
