/**
 * Checks that the Almanac can still identify the square set of matches ALREADY in the record books.
 *
 * The Almanac reconstructs a finished board from its room id so it can count squares nobody fired
 * at - and now has to work out which square set to reconstruct it with, because the room row was
 * pruned long ago and match_events records only the squares somebody shot. detectSquareSet() does
 * that by rebuilding the board with each set and seeing which one puts the recorded names in the
 * recorded places.
 *
 * Every archived match predates square sets, so every one of them should come back as 'bosses'.
 * Anything else means the seeding changed under existing history and the Almanac has quietly lost
 * its denominator.
 *
 *   node scripts/check-history.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { canonicalSquareName } from '../src/lib/squareSetFormat.ts'

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match) env[match[1]] = match[2]
  }
  return env
}

const env = loadEnv('../.env.local')
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})

/** Every cut of the boss board, keyed by the id its matches are archived under. */
const BOSS_SETS = {
  'bosses': JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges.json', import.meta.url), 'utf8')),
  'bosses-2v2': JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges2v2.json', import.meta.url), 'utf8')),
}

const DEFAULT_SET = 'bosses'

function seedFrom(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * buildFlatBoard() with the boss sets' seeding, then the balancer's layout on top.
 *
 * The default set seeds from the bare room id and every other set from `roomId:setId`, which is what
 * `base` is - get that wrong for the small-crew cut and its matches all rebuild into boards nobody
 * played, which this script would then report as lost history.
 *
 * All three of the remaining inputs matter and two of them arrived later than this script did. A room with a `seed`
 * shuffles from `roomId:seed` rather than the bare room id, and a match that was balanced stores the
 * permutation that finished the deal - without either, every match played since those columns landed
 * rebuilds into a different board and this check fails on all of them for no reason.
 */
/**
 * Mirrors squareSetFormat.dealtPool: a square added after this board was dealt was never in its pack.
 * This is the check that proves adding one re-dealt nothing - every match from before the add has to
 * keep rebuilding exactly as it did.
 */
function dealtPool(list, dealtAt) {
  const at = Date.parse(dealtAt ?? '')
  return list.filter((sq) => {
    if (sq.dealtFrom === undefined) return true
    const from = Date.parse(sq.dealtFrom)
    return Number.isFinite(from) && Number.isFinite(at) && at >= from
  })
}

function bossBoard(roomId, setId, cells, seed, perm, dealtAt) {
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base))
  const pool = dealtPool(BOSS_SETS[setId], dealtAt)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  let out = []
  for (let i = 0; i < cells; i++) out.push(pool[i % pool.length])
  if (Array.isArray(perm) && perm.length === cells) out = perm.map((from) => out[from])
  return out.map((c) => c.name)
}

const COLUMNS = 'match_key, room_id, cell_index, challenge_name, board_size, square_set, board_seed, board_perm'
const read = (columns) =>
  supabase.from('match_events').select(columns).order('finished_at', { ascending: false }).limit(4000)
// board_dealt_at arrived with its own migration. Before it is applied no late square has been dealt,
// so reading without it checks exactly the same thing.
let { data, error } = await read(`${COLUMNS}, board_dealt_at`)
if (error) ({ data, error } = await read(COLUMNS))

if (error) {
  console.log(`FAIL  could not read match_events: ${error.message}`)
  process.exitCode = 1
} else {
  const byMatch = new Map()
  for (const row of data ?? []) {
    if (!row.room_id || !row.challenge_name || row.cell_index < 0) continue
    // Rooms can choose a set now, and a match played on one of the objective sets was never dealt
    // from these pools - rebuilding it as a boss board would fail on every cell by construction.
    // Both cuts of the boss board are checked, each rebuilt from its own pool and its own seed.
    if (!BOSS_SETS[row.square_set ?? DEFAULT_SET]) continue
    if (!byMatch.has(row.match_key)) byMatch.set(row.match_key, [])
    byMatch.get(row.match_key).push(row)
  }

  // Compared in today's names on both sides. A row archived before a square was renamed says the old
  // thing and is still the same square, so folding it through RENAMED_SQUARES is what keeps this
  // check about SEEDING - which is the only thing it can usefully fail on. Without that, every rename
  // would fail every match old enough to have logged one, and the signal worth having would be lost
  // in it. A rename nobody recorded shows up here too, but audit-square-names.mjs names it directly.
  let matched = 0
  let unmatched = 0
  const failures = []
  for (const [key, rows] of byMatch) {
    const cells = rows[0].board_size * rows[0].board_size
    const board = bossBoard(rows[0].room_id, rows[0].square_set ?? DEFAULT_SET, cells, rows[0].board_seed, rows[0].board_perm, rows.find((r) => r.board_dealt_at)?.board_dealt_at ?? null)
    const agrees = rows.every((r) => board[r.cell_index] === canonicalSquareName(r.challenge_name))
    if (agrees) matched++
    else {
      unmatched++
      const bad = rows.find((r) => board[r.cell_index] !== canonicalSquareName(r.challenge_name))
      failures.push(`${key}: cell ${bad.cell_index} logged "${bad.challenge_name}", rebuild says "${board[bad.cell_index]}"`)
    }
  }

  console.log(`\n${byMatch.size} archived match(es) with a room id and named squares\n`)
  console.log(`  ${matched} reconstruct exactly on the boss board`)
  console.log(`  ${unmatched} do not`)
  if (failures.length) console.log('\n' + failures.slice(0, 5).map((f) => `  ${f}`).join('\n'))
  if (byMatch.size === 0) console.log('  (nothing archived yet - nothing to lose)')

  console.log(`\n${unmatched === 0 ? 'PASS' : 'FAIL'}  existing history still reconstructs`)
  process.exitCode = unmatched === 0 ? 0 : 1
}
