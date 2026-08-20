/**
 * Checks the replay engine against every match already in the record books.
 *
 * The replay recomputes each shot's outcome from the archived placements instead of trusting the
 * collapsed `result` column, which means it can disagree with the archive - and one of those
 * disagreements would be a bug in either the fold or the columns. So this compares its answers to
 * two things the server worked out independently at the end of each match:
 *
 *   - team_ships_lost on match_participants, against the hulls the fold says went down
 *   - the per-shot `result` column, against the outcome the fold derives for the same shot
 *
 * The second is expected to differ in exactly one direction on matches with three or more fleets
 * (archive_match ORs a shot across every defender, so a shot that struck one fleet is stored as a
 * hit against all of them). A disagreement the other way - the fold seeing a hit the archive
 * called a miss - means placements and shots have gone out of step.
 *
 *   node --experimental-strip-types scripts/check-replay.ts
 */
import { readFileSync } from 'node:fs'
import { buildReplay, replayStateAt, type ReplayEventInput, type ReplayFleetInput } from '../src/lib/replay.ts'

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const env = loadEnv('../.env.local')
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY
if (!url || !key) {
  console.log('FAIL  no VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local')
  process.exit(1)
}

/** How many rows one PostgREST response can carry. Matches `max_rows` in supabase/config.toml. */
const PAGE = 1000

/**
 * Every row of a table, fetched a page at a time.
 *
 * This used to ask for `limit=40000` in one request and take what came back. PostgREST caps a
 * response at `max_rows` and says nothing about having done so - no error, no header this code
 * read, just a short array - so the check was quietly running against the newest 1000 of the 9600+
 * rows in match_events. Whole matches arrived with a handful of their shots, the fold concluded
 * that nothing had sunk, and the script reported real matches as disagreeing with the archive.
 *
 * Every failure it has ever printed was that. See lib/profiles.fetchAllRows, which is the same
 * paging loop and carries the longer version of this warning - the app fixed this some time ago and
 * this script was never brought along.
 */
async function rows<T>(table: string, query: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key!}`,
        // Range, not `limit`: the ceiling is the server's, so asking for more per request achieves
        // nothing. This asks for a WINDOW, which is the part the server honours.
        Range: `${from}-${from + PAGE - 1}`,
      },
    })
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`)
    const page = (await res.json()) as T[]
    out.push(...page)
    // A short page is the end of the table. A full one might be, so it costs one empty request.
    if (page.length < PAGE) return out
  }
}

type FleetRow = ReplayFleetInput & { match_key: string }
type EventRow = ReplayEventInput & { match_key: string }
type PartRow = { match_key: string; team: number; nickname: string; team_ships_lost: number; won: boolean; draw: boolean }

const fleets = await rows<FleetRow>('match_fleets', 'select=match_key,team,board_size,placements,ship_defs')
const events = await rows<EventRow>(
  'match_events',
  'select=match_key,nickname,team,cell_index,challenge_name,result,match_seconds,board_size'
)
const parts = await rows<PartRow>('match_participants', 'select=match_key,team,nickname,team_ships_lost,won,draw')

function group<T extends { match_key: string }>(list: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of list) {
    const l = m.get(r.match_key)
    if (l) l.push(r)
    else m.set(r.match_key, [r])
  }
  return m
}

const fleetsBy = group(fleets)
const eventsBy = group(events)
const partsBy = group(parts)

let checked = 0
let exact = 0
const failures: string[] = []
const notes: string[] = []

for (const [matchKey, evs] of eventsBy) {
  const replay = buildReplay(fleetsBy.get(matchKey) ?? [], evs)
  if (!replay) {
    failures.push(`${matchKey}: no replay could be built from ${evs.length} shots`)
    continue
  }
  checked++
  if (replay.exact) exact++

  const final = replayStateAt(replay, replay.shots.length)

  // 1. Hull damage must only ever increase, and the last frame must equal the final state.
  let previous = -1
  for (let c = 0; c <= replay.shots.length; c++) {
    const damage = replayStateAt(replay, c).teams.reduce((n, t) => n + t.hullHit, 0)
    if (damage < previous) {
      failures.push(`${matchKey}: hull damage fell from ${previous} to ${damage} at shot ${c}`)
      break
    }
    previous = damage
  }

  // 2. Ships the fold says went down, against what the server recorded at the time.
  for (const team of replay.teams) {
    const state = final.teams.find((t) => t.team === team)!
    const recorded = (partsBy.get(matchKey) ?? []).find((p) => p.team === team)?.team_ships_lost
    if (recorded === undefined) continue
    if (state.shipsTotal === 0) continue // no placements archived for this fleet - nothing to check
    if (state.shipsSunk !== recorded) {
      failures.push(
        `${matchKey}: team ${team} - fold says ${state.shipsSunk} hull(s) sunk, match_participants says ${recorded}`
      )
    }
  }

  // 3. Per-shot outcome vs the archived column.
  let softer = 0
  for (const shot of replay.shots) {
    const derived = shot.sank.length > 0 ? 'sunk' : shot.outcomes.some((o) => o.result !== 'miss') ? 'hit' : 'miss'
    const archived = evs.find(
      (e) => e.nickname === shot.nickname && e.cell_index === shot.cellIndex
    )?.result
    if (!archived || archived === derived) continue
    // A shot the archive called a miss cannot have struck a hull: that direction is a real
    // contradiction. The reverse is the documented collapse, and only counted.
    if (archived === 'miss' && derived !== 'miss') {
      failures.push(`${matchKey}: shot at cell ${shot.cellIndex} by ${shot.nickname} archived as miss, fold says ${derived}`)
    } else {
      softer++
    }
  }
  if (softer > 0) {
    notes.push(`${matchKey}: ${softer} shot(s) where the fold is more specific than the archived result`)
  }

  const afloat = final.teams.map((t) => `${t.shipsTotal - t.shipsSunk}/${t.shipsTotal}`).join(' vs ')
  console.log(
    `  ${matchKey}  ${replay.shots.length} shots, ${replay.teams.length} board(s), fleets afloat at the end ${afloat}${
      replay.exact ? '' : '  (approximate: placements missing)'
    }`
  )
}

console.log(`\n${checked} match(es) replayed, ${exact} of them exactly`)
if (notes.length) console.log('\n' + notes.map((n) => `  note  ${n}`).join('\n'))
if (failures.length) console.log('\n' + failures.slice(0, 10).map((f) => `  ${f}`).join('\n'))
if (checked === 0) console.log('  (nothing archived yet - nothing to replay)')

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  replays agree with the archive`)
process.exitCode = failures.length === 0 ? 0 : 1
