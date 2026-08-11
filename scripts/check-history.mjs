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

const bosses = JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges.json', import.meta.url), 'utf8'))

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

/** buildFlatBoard() with the default set's seeding: the bare room id, as it was before square sets. */
function bossBoard(roomId, cells) {
  const next = rng(seedFrom(roomId))
  const pool = [...bosses]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const out = []
  for (let i = 0; i < cells; i++) out.push(pool[i % pool.length])
  return out.map((c) => c.name)
}

const { data, error } = await supabase
  .from('match_events')
  .select('match_key, room_id, cell_index, challenge_name, board_size')
  .order('finished_at', { ascending: false })
  .limit(4000)

if (error) {
  console.log(`FAIL  could not read match_events: ${error.message}`)
  process.exitCode = 1
} else {
  const byMatch = new Map()
  for (const row of data ?? []) {
    if (!row.room_id || !row.challenge_name || row.cell_index < 0) continue
    if (!byMatch.has(row.match_key)) byMatch.set(row.match_key, [])
    byMatch.get(row.match_key).push(row)
  }

  let matched = 0
  let unmatched = 0
  const failures = []
  for (const [key, rows] of byMatch) {
    const cells = rows[0].board_size * rows[0].board_size
    const board = bossBoard(rows[0].room_id, cells)
    const agrees = rows.every((r) => board[r.cell_index] === r.challenge_name)
    if (agrees) matched++
    else {
      unmatched++
      const bad = rows.find((r) => board[r.cell_index] !== r.challenge_name)
      failures.push(`${key}: cell ${bad.cell_index} logged "${bad.challenge_name}", rebuild says "${board[bad.cell_index]}"`)
    }
  }

  console.log(`\n${byMatch.size} archived match(es) with a room id and named squares\n`)
  console.log(`  ${matched} reconstruct exactly as 'bosses'`)
  console.log(`  ${unmatched} do not`)
  if (failures.length) console.log('\n' + failures.slice(0, 5).map((f) => `  ${f}`).join('\n'))
  if (byMatch.size === 0) console.log('  (nothing archived yet - nothing to lose)')

  console.log(`\n${unmatched === 0 ? 'PASS' : 'FAIL'}  existing history still reconstructs`)
  process.exitCode = unmatched === 0 ? 0 : 1
}
