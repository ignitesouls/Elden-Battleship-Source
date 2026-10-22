/**
 * Plays the crew bot (src/lib/botCrew.ts) through a whole match against one random fleet, offline.
 *
 * Shared by scripts/build-bot-routes.ts, which calibrates the bot's pace and aim with it, and
 * scripts/check-bot-crew.ts, which holds the result to its targets - so the number that was fitted
 * and the number that is checked come from the same game. Resolves shots the way resolve_attack
 * does, sinking geometry and all, and asks the bot every 30 seconds, about as often as a driver
 * browser wakes for it.
 */
import { readFileSync } from 'node:fs'
import { newCrew, playCrew, crewDue } from '../src/lib/botCrew.ts'
import type { BotRoutes, CrewShot, CrewWorld } from '../src/lib/botCrew.ts'
import { aimView } from '../src/lib/botBrain.ts'
import type { BotShot } from '../src/lib/botBrain.ts'
import { buildFlatBoard, dealtPool } from '../src/lib/squareSetFormat.ts'
import { randomPlacements, validatePlacements } from '../src/lib/battleshipLogic.ts'
import { fleetFor } from '../src/types/battleship.ts'
import { rng, seedFrom } from '../src/lib/seededRandom.ts'
import type { BotTier } from '../src/lib/bot.ts'

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
export const SQUARES = read('../src/data/battleshipChallenges.json') as { name: string; tooltip: string; region: string }[]
export const SHARED = read('../src/data/bossPrereqs.json') as Record<string, unknown>
export const BY_NAME = new Map(SQUARES.map((s) => [s.name, s]))

export interface SimResult {
  shots: (CrewShot & { hit: boolean })[]
  captains: { label: string; kills: string[] }[]
  board: { name: string; region: string }[]
  hits: number
  /** Match second the last ship went down, or null if the fleet was still afloat at the end. */
  sunkAt: number | null
}

export interface SimOptions {
  tier: BotTier
  crew: number
  seed: string
  routes: BotRoutes
  size?: number
  minutes?: number
  tune?: CrewWorld['tune']
}

export async function simulate(o: SimOptions): Promise<SimResult> {
  const size = o.size ?? 11
  const minutes = o.minutes ?? 90
  const random = rng(seedFrom(o.seed))
  const board = buildFlatBoard(dealtPool(SQUARES as never, null), size * size, rng(seedFrom(`board:${o.seed}`))) as unknown as SimResult['board']

  // randomPlacements reads Math.random; pinned here so a seed means the same fleet every run.
  const realRandom = Math.random
  Math.random = rng(seedFrom(`fleet:${o.seed}`))
  const shipDefs = fleetFor(size)
  const placements = randomPlacements(size, shipDefs)
  Math.random = realRandom
  const { shipIndexGrid } = validatePlacements(size, shipDefs, placements)
  const hitsLeft = shipDefs.map((s) => s.size)

  const world: CrewWorld = { tier: o.tier, routes: o.routes, shared: SHARED, board: board as never, lookup: (n) => BY_NAME.get(n), tune: o.tune }
  const shots: BotShot[] = []
  const fired: SimResult['shots'] = []
  const aim = () =>
    aimView({ tier: o.tier, boardSize: size, shipDefs, shots, defenders: [{ team: 1, truth: o.tier === 'shaker' ? shipIndexGrid : null }] })
  const turn = () => ({ fired: new Set(shots.map((s) => s.cell)), aim: aim(), random })

  let hits = 0
  // Resolved on the spot, the way the bot function resolves each shot before its captain moves on.
  const onShot = (shot: CrewShot) => {
    const ship = shipIndexGrid[shot.cell]
    fired.push({ ...shot, hit: ship >= 0 })
    if (ship < 0) {
      shots.push({ cell: shot.cell, defender: 1, result: 'miss' })
    } else {
      hits++
      hitsLeft[ship]--
      const p = placements[ship]
      shots.push(hitsLeft[ship] > 0
        ? { cell: shot.cell, defender: 1, result: 'hit' }
        : { cell: shot.cell, defender: 1, result: 'sunk', sunkSize: shipDefs[ship].size, sunkStartRow: p.startRow, sunkStartCol: p.startCol, sunkHorizontal: p.isHorizontal })
    }
    return aim()
  }

  const state = newCrew(world, o.crew, turn())
  for (let now = 0; now <= minutes * 60; now += 30) {
    if (hitsLeft.every((h) => h <= 0)) break
    if (crewDue(state) > now) continue
    await playCrew(state, world, turn(), now, onShot)
  }
  const sunkAt = hitsLeft.every((h) => h <= 0) ? fired[fired.length - 1]?.at ?? null : null
  return { shots: fired, captains: state.captains.map((c) => ({ label: c.label, kills: c.kills })), board, hits, sunkAt }
}

export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
export const byMinute = (r: SimResult, minute: number) => r.shots.filter((s) => s.at <= minute * 60).length

/**
 * Median squares fired by `minute`, over the games still being played then. A game the bot already
 * won has stopped firing, and counting it would make the strongest tiers look the slowest - the same
 * reason the archive's pace only counts matches that lasted that long.
 */
export const paceBy = (rs: SimResult[], minute: number) => {
  const live = rs.filter((r) => r.sunkAt === null || r.sunkAt > minute * 60)
  return live.length >= rs.length / 4 ? median(live.map((r) => byMinute(r, minute))) : null
}
export const accuracyOf = (rs: SimResult[]) => {
  const shots = rs.reduce((s, r) => s + r.shots.length, 0)
  return rs.reduce((s, r) => s + r.hits, 0) / Math.max(1, shots)
}
