/**
 * Regenerates src/data/botRoutes.json - how real crews move around the boss board, for the bot
 * opponent to imitate.
 *
 *   node --experimental-strip-types scripts/build-bot-routes.ts             regenerate the table
 *   node --experimental-strip-types scripts/build-bot-routes.ts --dry-run   report, write nothing
 *
 * Same provenance rules as bossTimeCost.json: read out of the archive, committed, and regenerated
 * deliberately between seasons rather than computed live. Read with the anon key - everything here
 * is public archive data.
 *
 * -- What it measures ------------------------------------------------------------------------------
 *
 * Roles. Real crews split the map, and on a three-player crew the split is stark: one captain lives
 * in Limgrave, Liurnia and Caelid, one in Altus and the Mountaintops, one in the DLC. Smaller and
 * bigger crews split it differently, so every crew size gets its own roles, each one a region mix,
 * a kill count and a list of the squares that captains in that role open with.
 *
 * Which squares follow which. For every square, the squares a player most often killed NEXT. This is
 * the route: a randomized start does not open where vanilla Elden Ring does (the most common first
 * square in the archive is Makar, not Margit), so it has to be learned, not written down.
 *
 * Per square, when it usually falls and how long the walk to it usually takes - the gap from the
 * player's previous kill, auto-fired at both ends so both timestamps are real kill times.
 *
 * -- What it leaves out ----------------------------------------------------------------------------
 *
 * Voided matches - practice, and every bot match - for the reason build-time-cost.mjs gives: a bot
 * that learned from its own games would end up imitating itself. Anything off the boss sets.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildFlatBoard, canonicalSquareName, dealtPool } from '../src/lib/squareSetFormat.ts'
import { applyBoardPerm } from '../src/lib/boardBalance.ts'
import { rng, seedFrom } from '../src/lib/seededRandom.ts'
import { BOT_TIERS, BOT_TIER_SPECS } from '../src/lib/bot.ts'
import type { BotRoutes } from '../src/lib/botCrew.ts'
import { simulate, median as medianOf, paceBy, accuracyOf } from './botSim.ts'

const DRY_RUN = process.argv.includes('--dry-run')
const OUT = new URL('../src/data/botRoutes.json', import.meta.url)
const BOSS_SETS = new Set(['bosses', 'bosses-2v2', 'boss-shuffle'])
const REGIONS = ['limgrave', 'liurnia', 'caelid', 'altus', 'mountaintops', 'underground', 'dlc']

/** Two kills closer than this are one duo fight or a banked kill, not a walk - see recordBook. */
const MIN_GAP_SECONDS = 20
/** A per-square number needs this many observations before it replaces the overall one. */
const MIN_SAMPLES = 8
/** How many next squares to keep per square. The tail is noise and the file is shipped. */
const NEXT_KEEP = 12
const OPENERS_KEEP = 20
/** Crew sizes with roles of their own. Bigger crews borrow the biggest. */
const MAX_CREW = 4

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}
const env = loadEnv('../.env.local')

async function readAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < 80; page++) {
    const res = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`,
        Range: `${page * 1000}-${page * 1000 + 999}`,
      },
    })
    const rows = await res.json()
    if (!Array.isArray(rows)) throw new Error(`${path}: ${JSON.stringify(rows)}`)
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

interface Event {
  match_key: string
  nickname: string
  team: number
  challenge_name: string
  match_seconds: number | null
  auto: boolean | null
  square_set: string | null
  room_id: string | null
  cell_index: number
  result: string | null
  board_size: number
  board_seed: string | null
  board_perm: number[] | null
  board_dealt_at: string | null
}

const squares = JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges.json', import.meta.url), 'utf8')) as {
  name: string
  region: string
}[]
const regionOf = new Map(squares.map((s) => [s.name, s.region]))

const voided = new Set((await readAll<{ match_key: string }>('voided_matches?select=match_key')).map((v) => v.match_key))
const raw = await readAll<Event>(
  'match_events?select=match_key,nickname,team,challenge_name,match_seconds,auto,square_set,room_id,cell_index,result,board_size,board_seed,board_perm,board_dealt_at'
)

// -- one run per player ------------------------------------------------------------------------------
const runs = new Map<string, Event[]>()
let skippedName = 0
for (const e of raw) {
  if (voided.has(e.match_key) || e.match_seconds == null) continue
  if (e.square_set && !BOSS_SETS.has(e.square_set)) continue
  const name = canonicalSquareName(e.challenge_name)
  if (!regionOf.has(name)) {
    skippedName++
    continue
  }
  const key = `${e.match_key}|${e.team}|${e.nickname}`
  if (!runs.has(key)) runs.set(key, [])
  runs.get(key)!.push({ ...e, challenge_name: name })
}
for (const run of runs.values()) run.sort((a, b) => a.match_seconds! - b.match_seconds!)

const crews = new Map<string, string[]>()
for (const key of runs.keys()) {
  const crew = key.split('|').slice(0, 2).join('|')
  if (!crews.has(crew)) crews.set(crew, [])
  crews.get(crew)!.push(key)
}

// -- hunting -----------------------------------------------------------------------------------------
// How often each player fires beside a hit their crew already has, against how often chance alone
// would put a shot there. Needs the board each crew played, which is rebuilt from the room's seed and
// permutation the way challengesForRoom deals it - and only trusted where every fired square lands on
// the cell it was fired at, so a board that cannot be rebuilt exactly is skipped, not guessed at.
const SETS: Record<string, unknown[]> = {
  bosses: squares,
  'bosses-2v2': JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges2v2.json', import.meta.url), 'utf8')),
  'boss-shuffle': squares,
}
const hunting = new Map<string, { near: number; chance: number }>()
let rebuilt = 0
for (const [crew, keys] of crews) {
  const evs = keys.flatMap((k) => runs.get(k)!)
  const f = evs[0]
  const setId = f.square_set ?? 'bosses'
  if (!f.room_id || !SETS[setId]) continue
  const dealId = setId === 'boss-shuffle' ? 'bosses' : setId
  const base = dealId === 'bosses' ? f.room_id : `${f.room_id}:${dealId}`
  const seed = evs.find((e) => e.board_seed)?.board_seed ?? null
  const n = f.board_size
  const board = applyBoardPerm(
    buildFlatBoard(dealtPool(SETS[setId] as never, evs.find((e) => e.board_dealt_at)?.board_dealt_at ?? null), n * n,
      rng(seedFrom(seed ? `${base}:${seed}` : base))),
    evs.find((e) => e.board_perm)?.board_perm ?? null
  ) as unknown as { name: string }[]
  if (evs.some((e) => board[e.cell_index]?.name !== e.challenge_name)) continue
  rebuilt++

  const hits = new Set<number>()
  const fired = new Set<number>()
  const beside = (c: number) => {
    const r = Math.floor(c / n)
    const q = c % n
    return (r > 0 && hits.has(c - n)) || (r < n - 1 && hits.has(c + n)) || (q > 0 && hits.has(c - 1)) || (q < n - 1 && hits.has(c + 1))
  }
  for (const e of [...evs].sort((a, b) => a.match_seconds! - b.match_seconds!)) {
    const key = `${crew}|${e.nickname}`
    const h = hunting.get(key) ?? { near: 0, chance: 0 }
    let open = 0
    let near = 0
    for (let c = 0; c < n * n; c++) {
      if (fired.has(c)) continue
      open++
      if (beside(c)) near++
    }
    if (beside(e.cell_index)) h.near++
    h.chance += near / Math.max(1, open)
    hunting.set(key, h)
    fired.add(e.cell_index)
    if (e.result === 'hit' || e.result === 'sunk') hits.add(e.cell_index)
  }
}
const huntTotal = [...hunting.values()].reduce((s, h) => ({ near: s.near + h.near, chance: s.chance + h.chance }), { near: 0, chance: 0 })
const overallLift = huntTotal.near / Math.max(1e-9, huntTotal.chance)

/** A role's hunting relative to the average player: 1 average, below it route-first, above it hit-first. */
function huntOf(keys: string[]): number {
  const t = keys.reduce((s, k) => {
    const h = hunting.get(k)
    return h ? { near: s.near + h.near, chance: s.chance + h.chance } : s
  }, { near: 0, chance: 0 })
  if (t.chance < 20 || overallLift <= 1) return 1
  const lift = t.near / t.chance
  return Number(Math.min(2.5, Math.max(0.2, (lift - 1) / (overallLift - 1))).toFixed(2))
}

// -- pace --------------------------------------------------------------------------------------------
// What a real crew of each size has fired by these minutes - the median over crews whose match lasted
// that long. The tiers' pace targets are shares of these (BOT_TIER_SPECS.pace).
const PACE_MINUTES = [40, 60, 81]
const matchEnd = new Map<string, number>()
for (const run of runs.values()) for (const e of run) matchEnd.set(e.match_key, Math.max(matchEnd.get(e.match_key) ?? 0, e.match_seconds!))
const pace: Record<string, Record<string, number>> = {}
for (let size = 1; size <= MAX_CREW; size++) {
  pace[size] = {}
  for (const minute of PACE_MINUTES) {
    const counts: number[] = []
    for (const [crew, keys] of crews) {
      if (keys.length !== size || (matchEnd.get(crew.split('|')[0]) ?? 0) < minute * 60) continue
      counts.push(keys.reduce((s, k) => s + runs.get(k)!.filter((e) => e.match_seconds! <= minute * 60).length, 0))
    }
    if (counts.length >= 10) pace[size][minute] = medianOf(counts)
  }
}

// -- roles -------------------------------------------------------------------------------------------
type Mix = Record<string, number>
const mixOf = (run: Event[]): Mix => {
  const c: Mix = Object.fromEntries(REGIONS.map((r) => [r, 0]))
  for (const e of run) c[regionOf.get(e.challenge_name)!]++
  return Object.fromEntries(REGIONS.map((r) => [r, c[r] / Math.max(1, run.length)]))
}
const early = (m: Mix) => m.limgrave + m.liurnia + m.caelid

/**
 * A crew's players in role order: earliest-map player first, the DLC player last, everybody else in
 * between by how early their map is. On a crew of three that is Limgrave, Flex, DLC.
 */
function inRoleOrder(keys: string[]): string[] {
  if (keys.length === 1) return keys
  const withMix = keys.map((k) => ({ k, m: mixOf(runs.get(k)!) }))
  withMix.sort((a, b) => b.m.dlc - a.m.dlc)
  const [dlc, ...rest] = withMix
  rest.sort((a, b) => early(b.m) - early(a.m))
  return [...rest, dlc].map((x) => x.k)
}

const LABELS: Record<number, string[]> = {
  1: ['solo'],
  2: ['early', 'late'],
  3: ['limgrave', 'flex', 'dlc'],
  4: ['limgrave', 'flex', 'flex', 'dlc'],
}

interface Role {
  label: string
  crews: number
  kills: number
  regions: Mix
  openers: Record<string, number>
  hunt: number
}
const roles: Record<string, Role[]> = {}
for (let size = 1; size <= MAX_CREW; size++) {
  const slots: string[][] = Array.from({ length: size }, () => [])
  let count = 0
  for (const keys of crews.values()) {
    if (Math.min(keys.length, MAX_CREW) !== size || keys.length > MAX_CREW + 2) continue
    // A crew bigger than MAX_CREW contributes its first MAX_CREW roles; the extras are more of the
    // middle, which is what a fifth captain on a real crew mostly is.
    const ordered = inRoleOrder(keys)
    const trimmed = ordered.length > size ? [...ordered.slice(0, size - 1), ordered[ordered.length - 1]] : ordered
    trimmed.forEach((k, i) => slots[i].push(k))
    count++
  }
  roles[size] = slots.map((keys, i) => {
    const mixes = keys.map((k) => mixOf(runs.get(k)!))
    const regions = Object.fromEntries(
      REGIONS.map((r) => [r, Number((mixes.reduce((s, m) => s + m[r], 0) / Math.max(1, mixes.length)).toFixed(3))])
    )
    const openers: Record<string, number> = {}
    for (const k of keys) {
      const first = runs.get(k)![0]?.challenge_name
      if (first) openers[first] = (openers[first] ?? 0) + 1
    }
    const kept = Object.fromEntries(Object.entries(openers).sort((a, b) => b[1] - a[1]).slice(0, OPENERS_KEEP))
    return {
      label: LABELS[size][i],
      crews: count,
      kills: Number((keys.reduce((s, k) => s + runs.get(k)!.length, 0) / Math.max(1, keys.length)).toFixed(1)),
      regions,
      openers: kept,
      hunt: huntOf(keys),
    }
  })
}

// -- routes and timing -------------------------------------------------------------------------------
const next = new Map<string, Map<string, number>>()
const gapsInto = new Map<string, number[]>()
const allGaps: number[] = []
const killedAt = new Map<string, number[]>()
for (const run of runs.values()) {
  // The same square twice in a row is the same kill written to two cells - see RENAMED_SQUARES and
  // boards with a square dealt twice. Collapsed, or every square would mostly "lead to itself".
  const steps = run.filter((e, i) => i === 0 || e.challenge_name !== run[i - 1].challenge_name)
  for (const e of steps) {
    if (!killedAt.has(e.challenge_name)) killedAt.set(e.challenge_name, [])
    killedAt.get(e.challenge_name)!.push(e.match_seconds!)
  }
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]
    const b = steps[i]
    if (!next.has(a.challenge_name)) next.set(a.challenge_name, new Map())
    const m = next.get(a.challenge_name)!
    m.set(b.challenge_name, (m.get(b.challenge_name) ?? 0) + 1)
    const gap = b.match_seconds! - a.match_seconds!
    if (a.auto && b.auto && gap >= MIN_GAP_SECONDS) {
      if (!gapsInto.has(b.challenge_name)) gapsInto.set(b.challenge_name, [])
      gapsInto.get(b.challenge_name)!.push(gap)
      allGaps.push(gap)
    }
  }
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const overallGap = Math.round(median(allGaps))

const perSquare: Record<string, { at: number | null; gap: number | null; n: number }> = {}
for (const sq of squares) {
  const at = killedAt.get(sq.name) ?? []
  const gaps = gapsInto.get(sq.name) ?? []
  perSquare[sq.name] = {
    at: at.length >= MIN_SAMPLES ? Math.round(median(at)) : null,
    gap: gaps.length >= MIN_SAMPLES ? Math.round(median(gaps)) : null,
    n: at.length,
  }
}
const nextOut: Record<string, Record<string, number>> = {}
for (const [a, m] of [...next.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
  const kept = [...m.entries()].filter(([, c]) => c >= 2).sort((x, y) => y[1] - x[1]).slice(0, NEXT_KEEP)
  if (kept.length) nextOut[a] = Object.fromEntries(kept)
}

const matches = new Set([...runs.keys()].map((k) => k.split('|')[0])).size
const output = {
  _comment: [
    'GENERATED by scripts/build-bot-routes.ts - do not edit by hand.',
    'How real crews move around the boss board, for the bot opponent (src/lib/botCrew.ts) to imitate.',
    `Measured over ${matches} archived boss matches, ${runs.size} player runs; voided and practice matches left out.`,
    'roles[crew size]: each captain slot - its region mix, kills per match, and the squares that role opens with.',
    'squares[name]: median match second it falls (at) and median walk to it from the previous kill (gap), seconds.',
    'next[name]: the squares a player most often killed next, with counts.',
    'roles[].hunt: how much that role fires beside its crew\'s hits, relative to the average player (1).',
    'pace[crew size][minute]: median squares a real crew of that size has fired by that minute.',
    'calibration: walk scale per crew size and aim strength per tier, fitted by simulation to BOT_TIER_SPECS pace and accuracy.',
    'Frozen on purpose, like bossTimeCost.json: regenerate BETWEEN seasons, never during one.',
  ],
  overallGap,
  roles,
  squares: perSquare,
  next: nextOut,
  pace,
  calibration: { walk: {} as Record<string, number>, aim: {} as Record<string, number>, tierWalk: {} as Record<string, number> },
}

// -- calibration ---------------------------------------------------------------------------------------
// The tables above are what real crews do; these two numbers make the bot do it at the speed and with
// the aim each tier promises. Fitted by playing the bot against itself on 11x11 boards with the
// default fleet (scripts/botSim.ts, the same game check-bot-crew.ts holds it to). Seeded, so the
// same archive always fits the same numbers.
// The same games every round (the seed has no round in it), so a bisection compares like with like
// and the fit is not partly luck.
const CAL_GAMES = 80
const routesObj = output as unknown as BotRoutes
const play = (tier: (typeof BOT_TIERS)[number], crew: number, tune: { walk?: number; aim?: number }, tag: string) =>
  Promise.all(Array.from({ length: CAL_GAMES }, (_, i) => simulate({ tier, crew, routes: routesObj, tune, seed: `cal:${tag}:${tier}:${crew}:${i}` })))

// Walk scale per crew size: Tarnished (pace 1) fires what a median real crew of that size has by
// minute 60, counting only games still being played then (paceBy). Shots after the opening go as
// 1/walk, so a proportional step converges in a few rounds.
for (let size = 1; size <= MAX_CREW; size++) {
  const target = pace[size]?.[60]
  if (!target) continue
  let scale = 1
  for (let round = 0; round < 8; round++) {
    const got = paceBy(await play('tarnished', size, { walk: scale, aim: 1 }, 'walk'), 60)
    if (got === null || Math.abs(got - target) <= Math.max(1, target * 0.03)) break
    scale *= Math.min(1.6, Math.max(0.6, got / target))
  }
  output.calibration.walk[size] = Number(scale.toFixed(3))
}

// Aim strength per tier: hits per shot on a crew of three lands on BOT_TIER_SPECS.accuracy. More
// strength, more hits, so a bisection finds it. Chud's target is about what pure chance gives, so his
// range reaches a little below zero - a captain who drifts AWAY from likely squares.
//
// There is a ceiling, and it is the rules, not the aim: a captain cannot finish a ship behind a gate
// it has not done, in a DLC it has no entry to, or on a square a teammate is already walking to, and
// past a strength of about 8 nothing more comes out of leaning harder. A target above the ceiling is
// reported rather than chased.
const reachable: Record<string, number> = {}
for (const tier of BOT_TIERS) {
  const target = BOT_TIER_SPECS[tier].accuracy
  let lo = -1.5
  let hi = 16
  for (let round = 0; round < 9; round++) {
    const mid = (lo + hi) / 2
    const acc = accuracyOf(await play(tier, 3, { walk: output.calibration.walk[3], aim: mid }, 'aim'))
    if (acc < target) lo = mid
    else hi = mid
  }
  output.calibration.aim[tier] = Number(((lo + hi) / 2).toFixed(3))
  reachable[tier] = accuracyOf(await play(tier, 3, { walk: output.calibration.walk[3], aim: output.calibration.aim[tier] }, 'aim'))
}

// Pace per tier, last, because it depends on the aim just fitted: a captain that leans hard on aim
// crosses the map to finish ships, and those walks are longer than its route's. So each tier gets a
// correction on top of the crew-size scale that puts it back on BOT_TIER_SPECS.pace.
for (const tier of BOT_TIERS) {
  const target = (pace[3]?.[60] ?? 0) * BOT_TIER_SPECS[tier].pace
  let adjust = 1
  for (let round = 0; target > 0 && round < 8; round++) {
    const got = paceBy(await play(tier, 3, { walk: output.calibration.walk[3] * adjust, aim: output.calibration.aim[tier] }, 'tierpace'), 60)
    if (got === null || Math.abs(got - target) <= Math.max(1, target * 0.03)) break
    adjust *= Math.min(1.6, Math.max(0.6, got / target))
  }
  output.calibration.tierWalk[tier] = Number(adjust.toFixed(3))
}

console.log(`matches ${matches}, runs ${runs.size}, kills under unknown names skipped ${skippedName}`)
console.log(`overall walk between kills: median ${overallGap}s over ${allGaps.length} auto pairs`)
for (const [size, rs] of Object.entries(roles)) {
  for (const r of rs) {
    const top = REGIONS.filter((x) => r.regions[x] >= 0.15).map((x) => `${x} ${Math.round(r.regions[x] * 100)}%`).join(', ')
    const opens = Object.keys(r.openers).slice(0, 3).join(', ')
    console.log(`  crew ${size} ${r.label.padEnd(9)} (${r.crews} crews) ${r.kills} kills - ${top} - opens ${opens}`)
  }
}
console.log(`boards rebuilt for hunting: ${rebuilt} crews; average player's hunting lift ${overallLift.toFixed(2)}x chance`)
for (const [size, rs] of Object.entries(roles)) console.log(`  crew ${size} hunt: ${rs.map((r) => `${r.label} ${r.hunt}`).join(', ')}`)
console.log(`real pace by minute 40/60/81: ${Object.entries(pace).map(([s, p]) => `crew ${s} ${p[40]}/${p[60]}/${p[81]}`).join(', ')}`)
console.log(`calibrated walk scale: ${JSON.stringify(output.calibration.walk)}; per tier: ${JSON.stringify(output.calibration.tierWalk)}; aim: ${JSON.stringify(output.calibration.aim)}`)
for (const tier of BOT_TIERS) {
  const want = BOT_TIER_SPECS[tier].accuracy
  const got = reachable[tier]
  console.log(`  ${tier} accuracy ${(got * 100).toFixed(1)}% (target ${want * 100}%)${got < want - 0.015 ? ' - BELOW TARGET: the rules cap it here' : ''}`)
}
const timed = Object.values(perSquare).filter((s) => s.gap !== null).length
console.log(`squares with their own walk time: ${timed}/${squares.length}; squares with a next list: ${Object.keys(nextOut).length}`)

if (!DRY_RUN) {
  writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n')
  console.log(`wrote ${OUT.pathname}`)
}
