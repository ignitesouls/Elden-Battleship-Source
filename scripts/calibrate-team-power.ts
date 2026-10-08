/**
 * Measures whether team power predicts anything, against the live record books, and picks its constants.
 *
 * Team power (src/lib/tournament/teamPower.ts) puts a betting-style line on tournament matches. A line
 * looks authoritative whether or not it means anything, so before one goes on a page this replays the
 * whole archive in order and, for every two-fleet game, predicts the winner from ONLY the games played
 * before it - the way a line would have been set at the time. Then it scores those predictions.
 *
 * It prints, for each candidate model, how much better than a coin flip it did (Brier and log loss), how
 * often the favourite won, and a calibration table: of the games it called 70%, did about 70% go that way?
 * The constants are fitted on the older 60% of games and the scores reported on the newer 40%, so the
 * headline number is out-of-sample - fitting and grading on the same games would flatter it.
 *
 * Needs the live database and .env.local, so it is NOT in `npm run check` - run it when the archive has
 * grown, or when the model changes, and copy the fitted values into POWER_PARAMS:
 *
 *   node --experimental-strip-types scripts/calibrate-team-power.ts
 *
 * Read-only. About fifty paged requests (the shot log is most of them).
 *
 * One known leak, small and stated: a battle rating is a percentile against every rated game on the
 * board, later ones included, so a player's EARLIER battle ratings are graded against a field that
 * includes the future. Their own later games never enter their own average, which is the part that
 * would matter.
 */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

const { replayElo, playerPower, teamPower, gameWinProbability } = await import('../src/lib/tournament/teamPower.ts')
// The Edge Function's bundle of the rating code: plain JS, so node can load it where the TS (which pulls
// in the square-set JSON) cannot - and it is, by construction, exactly what the server rates with.
const { prepareEvents, prepareParticipants, rateEveryBoard } = await import('../supabase/functions/battle-ratings/ratingCode.generated.js')
import type { PowerGame, PowerParams } from '../src/lib/tournament/teamPower.ts'

const env: Record<string, string> = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

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

interface Part {
  match_key: string; user_id: string | null; nickname: string; team: number; won: boolean; draw: boolean
  shots: number; hits: number; misses: number; sunk: number; team_ships_lost: number; awards: string[] | null
  room_code: string | null; finished_at: string; square_set: string | null
}

console.log('reading the archive...')
// One after another, not at once: the shot log is the heavy read, and a burst of parallel pages against
// the live database is what its statement timeout is there to stop.
const partsRaw = await all<Part>('match_participants', 'match_key,user_id,nickname,team,won,draw,shots,hits,misses,sunk,team_ships_lost,awards,room_code,finished_at,square_set')
const eventsRaw = await all<Record<string, unknown>>('match_events', 'match_key,user_id,nickname,team,cell_index,challenge_name,result,match_seconds,board_size,finished_at,square_set,auto')
const voids = await all<{ match_key: string }>('voided_matches', 'match_key')
// A view over the shot log: paging it with offsets re-runs the view for every page and times out. Read in
// one request, the way the site's own fetchBoardSources does.
const sourcesRes = await sb.from('match_board_sources').select('match_key,room_id,board_seed,board_perm,board_dealt_at')
if (sourcesRes.error) throw new Error(`match_board_sources: ${sourcesRes.error.message}`)
const sourcesRaw = (sourcesRes.data ?? []) as Array<{ match_key: string }>
const voided = new Set(voids.map((v) => v.match_key))
const parts = partsRaw.filter((p) => !voided.has(p.match_key))
const events = eventsRaw.filter((e) => !voided.has(e.match_key as string))
console.log(`  ${new Set(parts.map((p) => p.match_key)).size} matches, ${parts.length} player rows, ${events.length} shots (${voided.size} voided left out)\n`)

const keyOf = (r: { user_id: string | null; nickname: string }) => r.user_id ?? `name:${r.nickname.trim().toLowerCase()}`

// -- every rated game's battle rating, by player, in time order --------------------------------------
const boards = rateEveryBoard(prepareParticipants(parts as never), prepareEvents(events as never, new Map(sourcesRaw.map((s) => [s.match_key, s]))))
const battles = new Map<string, Array<{ at: string; rating: number }>>()
for (const board of boards.values()) {
  for (const r of board.ratings as Array<{ userId: string | null; nickname: string; finishedAt: string; rating: number }>) {
    const k = keyOf({ user_id: r.userId, nickname: r.nickname })
    const list = battles.get(k) ?? []
    list.push({ at: r.finishedAt, rating: r.rating })
    battles.set(k, list)
  }
}
for (const list of battles.values()) list.sort((a, b) => a.at.localeCompare(b.at))
const battlesBefore = (key: string, at: string) => (battles.get(key) ?? []).filter((b) => b.at < at).map((b) => b.rating)

// -- the games -------------------------------------------------------------------------------------
const byMatch = new Map<string, Part[]>()
for (const p of parts) {
  const list = byMatch.get(p.match_key) ?? []
  list.push(p)
  byMatch.set(p.match_key, list)
}
const games: PowerGame[] = [...byMatch.entries()].map(([matchKey, rows]) => ({
  matchKey,
  finishedAt: rows[0].finished_at,
  players: rows.map((r) => ({ key: keyOf(r), team: r.team, won: r.won, draw: r.draw })),
}))

interface Prediction { p: number; won: boolean; at: string; known: boolean }

/** Every gradable game predicted with `params`, each from only the games before it. */
function predict(params: PowerParams): Prediction[] {
  const out: Prediction[] = []
  // Each game's players' Elo as it stood just before it, copied out of the replay's live table.
  const eloBefore = new Map<string, Map<string, { elo: number; games: number }>>()
  replayElo(games, params.k, (game, table) => {
    const snap = new Map<string, { elo: number; games: number }>()
    for (const p of game.players) {
      const e = table.get(p.key)
      if (e) snap.set(p.key, { ...e })
    }
    eloBefore.set(game.matchKey, snap)
  })
  for (const game of games) {
    const snap = eloBefore.get(game.matchKey)
    if (!snap) continue // not a two-fleet game with a result
    if (game.players.some((p) => p.draw)) continue // nothing to call
    const teams = [...new Set(game.players.map((p) => p.team))]
    const powers = teams.map((t) => {
      const crew = game.players.filter((p) => p.team === t)
      return { crew, power: teamPower(crew.map((p) => playerPower(snap.get(p.key), battlesBefore(p.key, game.finishedAt), params)))! }
    })
    const known = powers.every(({ crew }) => crew.some((p) => (snap.get(p.key)?.games ?? 0) > 0 || battlesBefore(p.key, game.finishedAt).length > 0))
    const p = gameWinProbability(powers[0].power, powers[1].power)
    out.push({ p, won: powers[0].crew.some((x) => x.won), at: game.finishedAt, known })
  }
  return out
}

function score(rows: Prediction[]) {
  const n = rows.length
  const brier = rows.reduce((s, r) => s + (r.p - (r.won ? 1 : 0)) ** 2, 0) / n
  const logLoss = -rows.reduce((s, r) => s + Math.log(Math.min(1 - 1e-9, Math.max(1e-9, r.won ? r.p : 1 - r.p))), 0) / n
  const called = rows.filter((r) => Math.abs(r.p - 0.5) > 1e-9)
  const right = called.filter((r) => (r.p > 0.5) === r.won).length
  return { n, brier, logLoss, favouriteWon: called.length ? right / called.length : NaN, called: called.length }
}

// -- fit on the older 60%, grade on the newer 40% ----------------------------------------------------
const all0 = predict({ k: 0, battleWeight: 0, battleShrink: 3 })
const sortedAt = all0.map((r) => r.at).sort()
const cutAt = sortedAt[Math.floor(sortedAt.length * 0.6)]
const train = (rows: Prediction[]) => rows.filter((r) => r.at < cutAt)
const test = (rows: Prediction[]) => rows.filter((r) => r.at >= cutAt)
console.log(`gradable games: ${all0.length} (fit on ${train(all0).length} before ${cutAt.slice(0, 10)}, graded on ${test(all0).length} after)\n`)

const grid: PowerParams[] = []
for (const k of [0, 8, 16, 24, 32, 48, 64, 96, 128]) {
  for (const battleWeight of [0, 2, 4, 8, 12, 16, 20, 28]) {
    for (const battleShrink of [0.5, 1, 2, 3, 6]) {
      if (battleWeight === 0 && battleShrink !== 3) continue
      grid.push({ k, battleWeight, battleShrink })
    }
  }
}
const fits = grid.map((params) => ({ params, preds: predict(params) }))
const best = (pick: (p: PowerParams) => boolean) =>
  fits.filter((f) => pick(f.params)).sort((a, b) => score(train(a.preds)).logLoss - score(train(b.preds)).logLoss)[0]

const models = [
  { name: 'coin flip (no model)', fit: fits.find((f) => f.params.k === 0 && f.params.battleWeight === 0)! },
  { name: 'Elo only', fit: best((p) => p.k > 0 && p.battleWeight === 0) },
  { name: 'battle rating only', fit: best((p) => p.k === 0 && p.battleWeight > 0) },
  { name: 'blend (Elo + battle)', fit: best((p) => p.k > 0 && p.battleWeight > 0) },
]

const base = score(test(models[0].fit.preds))
console.log('-- out-of-sample (newer 40%) ---------------------------------------------------------------')
console.log('  model                     params                    Brier   log loss  favourite won   skill')
for (const m of models) {
  const s = score(test(m.fit.preds))
  const skill = 100 * (1 - s.brier / base.brier)
  const params = `K ${m.fit.params.k}, w ${m.fit.params.battleWeight}, shrink ${m.fit.params.battleShrink}`
  console.log(`  ${m.name.padEnd(25)} ${params.padEnd(25)} ${s.brier.toFixed(4)}  ${s.logLoss.toFixed(4)}   ${Number.isNaN(s.favouriteWon) ? '   -  ' : `${(s.favouriteWon * 100).toFixed(1)}% of ${s.called}`.padEnd(13)} ${skill >= 0 ? '+' : ''}${skill.toFixed(1)}%`)
}

const blend = models[3].fit
const knownOnly = test(blend.preds).filter((r) => r.known)
const ks = score(knownOnly)
console.log(`\n  blend, games where BOTH sides had history: ${ks.n} games, favourite won ${(ks.favouriteWon * 100).toFixed(1)}%, Brier ${ks.brier.toFixed(4)}`)

console.log('\n-- calibration of the blend, out-of-sample ----------------------------------------------------')
console.log('  it said        n    actually won')
const rows = test(blend.preds).flatMap((r) => [r, { ...r, p: 1 - r.p, won: !r.won }]).filter((r) => r.p >= 0.5)
const edges = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0001]
for (let b = 0; b < edges.length - 1; b++) {
  const inB = rows.filter((r) => r.p >= edges[b] && r.p < edges[b + 1])
  if (inB.length === 0) continue
  const said = inB.reduce((s, r) => s + r.p, 0) / inB.length
  const actual = inB.filter((r) => r.won).length / inB.length
  console.log(`  ${(said * 100).toFixed(0).padStart(3)}%      ${String(inB.length).padStart(4)}    ${(actual * 100).toFixed(1)}%`)
}

console.log(`\n-- for POWER_PARAMS ------------------------------------------------------------------------`)
console.log(`  { k: ${blend.params.k}, battleWeight: ${blend.params.battleWeight}, battleShrink: ${blend.params.battleShrink} }`)
