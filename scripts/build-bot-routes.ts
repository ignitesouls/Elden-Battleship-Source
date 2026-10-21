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
import { canonicalSquareName } from '../src/lib/squareSetFormat.ts'

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
}

const squares = JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges.json', import.meta.url), 'utf8')) as {
  name: string
  region: string
}[]
const regionOf = new Map(squares.map((s) => [s.name, s.region]))

const voided = new Set((await readAll<{ match_key: string }>('voided_matches?select=match_key')).map((v) => v.match_key))
const raw = await readAll<Event>('match_events?select=match_key,nickname,team,challenge_name,match_seconds,auto,square_set')

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
    'Frozen on purpose, like bossTimeCost.json: regenerate BETWEEN seasons, never during one.',
  ],
  overallGap,
  roles,
  squares: perSquare,
  next: nextOut,
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
const timed = Object.values(perSquare).filter((s) => s.gap !== null).length
console.log(`squares with their own walk time: ${timed}/${squares.length}; squares with a next list: ${Object.keys(nextOut).length}`)

if (!DRY_RUN) {
  writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n')
  console.log(`wrote ${OUT.pathname}`)
}
