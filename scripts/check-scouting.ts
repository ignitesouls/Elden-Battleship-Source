/**
 * Prints the scouting reports the Captains tab would build from the live archive.
 *
 * The point is the gating, not the numbers: with a handful of matches on record every card should
 * come back unrated, with no traits and no field baseline. If a trait shows up while the field is
 * this thin, the thresholds in scouting.ts are not doing their job and the tab is making claims the
 * record books can't support.
 *
 *   node --experimental-strip-types scripts/check-scouting.ts
 */
import { readFileSync } from 'node:fs'
import { buildScoutingReports, METRICS, MIN_FIELD_SIZE, MIN_MATCHES_FOR_TRAITS } from '../src/lib/scouting.ts'
import type { ParticipantRow } from '../src/lib/careerStats.ts'
import type { MatchEventRow } from '../src/lib/almanac.ts'

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

async function rows<T>(table: string, query: string): Promise<T[]> {
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key!, Authorization: `Bearer ${key!}` },
  })
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T[]
}

const parts = await rows<ParticipantRow>('match_participants', 'select=*&order=finished_at.desc&limit=4000')
const events = await rows<MatchEventRow>('match_events', 'select=*&order=finished_at.desc&limit=40000')

const reports = buildScoutingReports(
  parts.map((p) => ({ ...p, awards: Array.isArray(p.awards) ? p.awards : [] })),
  events
)

const rated = reports.filter((r) => r.rated)
console.log(`\n${reports.length} captain(s) from ${parts.length} participation row(s)`)
console.log(`thresholds: ${MIN_MATCHES_FOR_TRAITS} matches per captain, ${MIN_FIELD_SIZE} such captains for a field\n`)

for (const r of reports) {
  const traits = r.traits.length > 0 ? r.traits.map((t) => t.name).join(', ') : '-'
  console.log(`  ${r.nickname.padEnd(14)} ${String(r.matches).padStart(2)} matches  ${r.confidence.padEnd(8)} traits: ${traits}`)
  console.log(`    ${r.summary}`)
  const shown = METRICS.map((d) => {
    const v = r.readings[d.id].value
    return v === null ? null : `${d.label} ${d.format(v)}`
  }).filter(Boolean)
  console.log(`    ${shown.join(' · ')}\n`)
}

// The check itself: no card may claim a trait, a rank or a field delta while the field is too thin.
const failures: string[] = []
if (rated.length < MIN_FIELD_SIZE) {
  for (const r of reports) {
    if (r.traits.length > 0 || r.supporting.length > 0) failures.push(`${r.nickname}: traits shown on an unratable field`)
    for (const d of METRICS) {
      const reading = r.readings[d.id]
      if (reading.rank !== null) failures.push(`${r.nickname}: ${d.label} ranked with only ${rated.length} qualified captain(s)`)
      if (reading.field !== null) failures.push(`${r.nickname}: ${d.label} compared to a field of ${rated.length}`)
    }
  }
}

// Whatever the sample, a rate can never exceed 1 and a count can never be negative.
for (const r of reports) {
  for (const id of ['winRate', 'accuracy', 'firstBloodRate', 'sinkConversion'] as const) {
    const v = r.readings[id].value
    if (v !== null && (v < 0 || v > 1)) failures.push(`${r.nickname}: ${id} is ${v}, outside 0..1`)
  }
}

if (failures.length) console.log([...new Set(failures)].slice(0, 10).map((f) => `  ${f}`).join('\n'))
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  cards only claim what the sample supports`)
process.exitCode = failures.length === 0 ? 0 : 1
