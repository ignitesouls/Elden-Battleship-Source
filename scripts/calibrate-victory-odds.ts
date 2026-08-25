/**
 * Measures whether the victory-odds model is any GOOD, against the live record books.
 *
 * check-victory-odds.ts asserts the model is coherent - symmetric, ordered, deterministic, cheap.
 * None of that says it is RIGHT. A model can be all of those things and still be confidently
 * wrong all evening, and a percentage on a stream is exactly the kind of claim nobody in the chat
 * can check. This is the script that checks it.
 *
 * The test is calibration, which is the only honest one available: of all the moments the model
 * called 70%, did about 70% of them go on to win? A model that says 95% about matches that turn
 * around a third of the time is worse than useless on a broadcast, because the caster will have
 * spent the whole segment saying it is over.
 *
 * It also refits the two measured constants (HUNT_SHARE and HUNT_HIT_RATE in src/lib/victoryOdds)
 * off today's archive, so drift is visible rather than assumed away.
 *
 * Needs the live database and .env.local, which is why it is NOT in `npm run check` - it is a
 * thing to run when the archive has grown, or when the model changes:
 *
 *   node --experimental-strip-types scripts/calibrate-victory-odds.ts
 */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import type { Attack, ShipDefinition } from '../src/types/battleship.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { victoryOdds, fleetStates } = await import('../src/lib/victoryOdds.ts')

const env: Record<string, string> = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})

/** Reads a whole table out in pages, since the archive is past the default row cap. */
async function all<T>(table: string, columns: string): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...((data ?? []) as T[]))
    if ((data ?? []).length < 1000) break
  }
  return rows
}

interface EventRow {
  match_key: string
  nickname: string
  team: number
  cell_index: number
  result: string
  match_seconds: number | null
  board_size: number
}
interface FleetRow {
  match_key: string
  team: number
  board_size: number
  ship_defs: ShipDefinition[]
}
interface ReportRow {
  match_key: string
  winner_team: number | null
}

console.log('reading the archive...')
const [events, fleets, reports] = await Promise.all([
  all<EventRow>('match_events', 'match_key,nickname,team,cell_index,result,match_seconds,board_size'),
  all<FleetRow>('match_fleets', 'match_key,team,board_size,ship_defs'),
  all<ReportRow>('match_reports', 'match_key,winner_team'),
])
console.log(`  ${reports.length} matches, ${fleets.length} fleets, ${events.length} shots\n`)

const fleetsByMatch = new Map<string, FleetRow[]>()
for (const f of fleets) {
  const list = fleetsByMatch.get(f.match_key) ?? []
  list.push(f)
  fleetsByMatch.set(f.match_key, list)
}
const winnerOf = new Map(reports.map((r) => [r.match_key, r.winner_team]))

const eventsByMatch = new Map<string, EventRow[]>()
for (const e of events) {
  const list = eventsByMatch.get(e.match_key) ?? []
  list.push(e)
  eventsByMatch.set(e.match_key, list)
}

/**
 * Duels with a winner, which is the sample the archive can actually grade.
 *
 * Two-fleet only, because match_events records ONE result per trigger-pull: in a three-way match
 * that single value cannot say which of the two opposing boards it landed on, so the damage cannot
 * be attributed and the state cannot be replayed. Matches with no winner (voided, abandoned, drawn)
 * have no outcome to score against.
 */
const gradable = [...fleetsByMatch.entries()].filter(([key, fl]) => {
  const winner = winnerOf.get(key)
  return fl.length === 2 && winner !== null && winner !== undefined && fl.some((f) => f.team === winner)
})
console.log(`gradable duels: ${gradable.length}\n`)

const START = Date.parse('2026-08-01T12:00:00.000Z')

/** Rebuilds the public attack log for one archived duel, from its shot rows. */
function attacksFor(rows: EventRow[], teams: number[]): Attack[] {
  return rows
    .filter((e) => e.cell_index >= 0 && e.match_seconds !== null)
    .sort((a, b) => (a.match_seconds ?? 0) - (b.match_seconds ?? 0))
    .map((e) => ({
      id: `${e.team}-${e.cell_index}-${e.nickname}`,
      room_id: 'archived',
      cell_index: e.cell_index,
      attacker_team: e.team,
      defender_team: teams.find((t) => t !== e.team) ?? e.team,
      attacker_player_id: null,
      result: e.result as Attack['result'],
      sunk_ship_name: null,
      sunk_ship_size: null,
      sunk_start_row: null,
      sunk_start_col: null,
      sunk_horizontal: null,
      created_at: new Date(START + (e.match_seconds ?? 0) * 1000).toISOString(),
      resolved_at: null,
    }))
}

// -- the calibration sweep -------------------------------------------------

const SAMPLES = 20
const ROLLOUTS = 1500
/** Predictions, as (what the model said, whether that fleet went on to win). */
const graded: { p: number; won: boolean; progress: number }[] = []

for (const [key, fl] of gradable) {
  const rows = eventsByMatch.get(key) ?? []
  if (rows.length < 10) continue
  const teams = fl.map((f) => f.team).sort((a, b) => a - b)
  const shipDefs = fl[0].ship_defs ?? []
  const boardSize = fl[0].board_size
  if (shipDefs.length === 0) continue

  const log = attacksFor(rows, teams)
  if (log.length < 10) continue
  const winner = winnerOf.get(key)

  // Crews, as the shot log reveals them - the archive keeps no roster, but every captain who
  // fired is a captain who was there, which is what pace actually depends on.
  const crew: { team: number | null }[] = []
  const seen = new Set<string>()
  for (const e of rows) {
    const id = `${e.team}|${e.nickname}`
    if (seen.has(id)) continue
    seen.add(id)
    crew.push({ team: e.team })
  }

  const instants = [...new Set(log.map((a) => Date.parse(a.created_at)))].sort((a, b) => a - b)
  const step = Math.max(1, Math.floor(instants.length / SAMPLES))
  for (let i = 0; i < instants.length; i += step) {
    const at = instants[i]
    const states = fleetStates(log, teams, shipDefs, crew, null, at)
    const snap = victoryOdds(states, boardSize, ROLLOUTS)
    if (snap.decided) continue
    const progress = i / instants.length
    for (let t = 0; t < teams.length; t++) {
      graded.push({ p: snap.odds[t], won: teams[t] === winner, progress })
    }
  }
}

console.log(`graded predictions: ${graded.length}\n`)

/** Reliability: of the calls near X%, how many actually won? */
function reliability(rows: { p: number; won: boolean }[], label: string) {
  console.log(`-- ${label} ${'-'.repeat(Math.max(0, 58 - label.length))}`)
  console.log('  model says      n     actually won    error')
  const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]
  for (let b = 0; b < edges.length - 1; b++) {
    const inBucket = rows.filter((r) => r.p >= edges[b] && r.p < edges[b + 1])
    if (inBucket.length === 0) continue
    const said = inBucket.reduce((s, r) => s + r.p, 0) / inBucket.length
    const actual = inBucket.filter((r) => r.won).length / inBucket.length
    const err = actual - said
    const bar = '#'.repeat(Math.round(actual * 30)).padEnd(30, '.')
    console.log(
      `  ${(edges[b] * 100).toFixed(0).padStart(3)}-${(edges[b + 1] * 100).toFixed(0).padStart(3)}%  ${String(inBucket.length).padStart(5)}   ${bar} ${(actual * 100).toFixed(1).padStart(5)}%  ${err >= 0 ? '+' : ''}${(err * 100).toFixed(1)}`
    )
  }
  const brier = rows.reduce((s, r) => s + (r.p - (r.won ? 1 : 0)) ** 2, 0) / rows.length
  const base = rows.filter((r) => r.won).length / rows.length
  const baseline = rows.reduce((s, r) => s + (base - (r.won ? 1 : 0)) ** 2, 0) / rows.length
  console.log(`\n  Brier score      ${brier.toFixed(4)}   (lower is better)`)
  console.log(`  always-say-${(base * 100).toFixed(0)}%   ${baseline.toFixed(4)}`)
  console.log(`  skill vs that    ${(100 * (1 - brier / baseline)).toFixed(1)}%\n`)
}

reliability(graded, 'all moments')
reliability(graded.filter((r) => r.progress < 0.34), 'first third of the match')
reliability(graded.filter((r) => r.progress >= 0.34 && r.progress < 0.67), 'middle third')
reliability(graded.filter((r) => r.progress >= 0.67), 'final third')

// -- refit the measured constants -----------------------------------------

console.log('-- constants, refitted off today\'s archive -----------------')
const duelKeys = new Set(gradable.map(([k]) => k))
const byFleet = new Map<string, EventRow[]>()
for (const e of events) {
  if (!duelKeys.has(e.match_key)) continue
  const k = `${e.match_key}|${e.team}`
  const list = byFleet.get(k) ?? []
  list.push(e)
  byFleet.set(k, list)
}

let adjN = 0, adjHits = 0, coldN = 0, coldHits = 0
for (const [, list] of byFleet) {
  list.sort((a, b) => (a.match_seconds ?? 0) - (b.match_seconds ?? 0))
  const size = list[0].board_size
  const hits: [number, number][] = []
  for (const e of list) {
    if (e.cell_index < 0) continue
    const r = Math.floor(e.cell_index / size)
    const c = e.cell_index % size
    const adjacent = hits.some(([hr, hc]) => Math.abs(hr - r) + Math.abs(hc - c) === 1)
    const isHit = e.result === 'hit' || e.result === 'sunk'
    if (adjacent) { adjN++; if (isHit) adjHits++ } else { coldN++; if (isHit) coldHits++ }
    if (isHit) hits.push([r, c])
  }
}
const share = adjN / (adjN + coldN)
console.log(`  HUNT_SHARE      ${share.toFixed(3)}   (${adjN} of ${adjN + coldN} shots hunt)`)
console.log(`  HUNT_HIT_RATE   ${(adjHits / adjN).toFixed(3)}   (n = ${adjN})`)
console.log(`  cold hit rate   ${(coldHits / coldN).toFixed(3)}   (n = ${coldN}) - modelled, not fitted`)
