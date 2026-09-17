/**
 * Holds shut the "one square, two wounds" bug, against the live cloud project.
 *
 * The report: a spectator watched a five-cell hull go down with only four burst markers on it, and
 * separately a player was said to have clicked one square twice and got two hits for it. Same
 * cause - resolve_attack() decremented a ship's hit counter for every attack ROW aimed at a square
 * rather than for every distinct SQUARE, so a repeat shot wounded the same piece of hull twice and
 * ships sank early.
 *
 * A square collects a second attack row two ways, and this checks both:
 *   * two shots from the same fleet (a race the client is supposed to prevent, and mostly does)
 *   * one shot from each of two DIFFERENT fleets, which is not a mistake at all - firing hits every
 *     other fleet at that square, so a three-fleet match generates these constantly.
 *
 * FAILS on a project that hasn't had 20260803000000_idempotent_shot_resolution.sql applied - that's
 * the point. Remedy: the "one square, one wound" step of supabase/migrations/20260803000000_idempotent_shot_resolution.sql.
 *
 * A second, later bug lived one layer up from this: nothing stopped that second row from being
 * INSERTED in the first place, only from damaging anything once it landed. A caller that checks
 * "have I already fired here" by reading `attacks` and then inserting is a check-then-act race,
 * and auto-fire's mod resends every currently-set kill flag on every poll by design - see the
 * 20260914 migration for the live match this produced dozens of true duplicate rows in. This file
 * also checks that a repeat fire from the same fleet leaves exactly one row behind, which is what
 * attacks_one_shot_per_square (20260914_one_attack_per_square.sql) is for. FAILS on a project
 * without that index too.
 *
 * Read-write: creates one throwaway room and deletes it again. Archives nothing, so the record
 * books are untouched.
 *
 *   node scripts/check-double-shots.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const env = loadEnv('../.env.local')
const url = env.VITE_SUPABASE_URL
const anon = env.VITE_SUPABASE_ANON_KEY

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

async function session(name) {
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInAnonymously()
  if (error) throw new Error(`${name}: ${error.message}`)
  return { name, client, userId: data.user.id }
}

const SHIPS = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
]
const BOARD = 10

/** Ships in fixed rows, one per row, starting at column 0. Same shape submitPlacement writes. */
function fleetRows(rowOffset) {
  const shipGrid = Array(BOARD * BOARD).fill(false)
  const shipIndexGrid = Array(BOARD * BOARD).fill(-1)
  const placements = SHIPS.map((s, i) => {
    const row = rowOffset + i
    for (let c = 0; c < s.size; c++) {
      shipGrid[row * BOARD + c] = true
      shipIndexGrid[row * BOARD + c] = i
    }
    return { shipIndex: i, startRow: row, startCol: 0, isHorizontal: true }
  })
  return { shipGrid, shipIndexGrid, placements }
}

const alpha = await session('alpha')
const bravo = await session('bravo')
const charlie = await session('charlie')

const code = `TESTDUP${Date.now().toString(36).toUpperCase().slice(-4)}`
let roomId = null

/**
 * Inserts a shot and resolves it, returning the resolved row - mirroring sendAttack(), including
 * the upsert: attacks_one_shot_per_square means a repeat fire at a square this fleet already has a
 * row against inserts nothing, so there is no new id to resolve. That case reads the existing row
 * back instead (already resolved, since every call in this script runs to completion before the
 * next one starts).
 */
async function fire(who, team, cell, defender) {
  const { data, error } = await who.client
    .from('attacks')
    .upsert(
      { room_id: roomId, cell_index: cell, attacker_team: team, defender_team: defender },
      { onConflict: 'room_id,attacker_team,defender_team,cell_index', ignoreDuplicates: true }
    )
    .select()
  if (error) throw new Error(`${who.name} fire ${cell}: ${error.message}`)

  if (data.length === 0) {
    const { data: existing, error: existingErr } = await who.client
      .from('attacks')
      .select()
      .eq('room_id', roomId)
      .eq('attacker_team', team)
      .eq('defender_team', defender)
      .eq('cell_index', cell)
      .single()
    if (existingErr) throw new Error(`${who.name} lookup ${cell}: ${existingErr.message}`)
    return existing
  }

  const [inserted] = data
  const { error: rpcErr } = await who.client.rpc('resolve_attack', { p_attack_id: inserted.id })
  if (rpcErr) throw new Error(`resolve ${cell}: ${rpcErr.message}`)
  const { data: row } = await who.client.from('attacks').select().eq('id', inserted.id).single()
  return row
}

/** Bravo's own hit counters, read as bravo (RLS keeps them private to their fleet). */
async function bravoHits() {
  const { data } = await bravo.client
    .from('fleets')
    .select('ship_hits_remaining, ship_sunk')
    .eq('room_id', roomId)
    .eq('team', 1)
    .single()
  return data
}

try {
  const { data: room, error: roomErr } = await alpha.client
    .from('rooms')
    .insert({ code, board_size: BOARD, ship_defs: SHIPS, seed: '123456789' })
    .select()
    .single()
  if (roomErr) throw roomErr
  roomId = room.id

  for (const [who, team, host] of [[alpha, 0, true], [bravo, 1, false], [charlie, 2, false]]) {
    const { error } = await who.client
      .from('players')
      .insert({ room_id: roomId, user_id: who.userId, nickname: who.name, team, is_host: host })
    if (error) throw error
  }

  await alpha.client.from('rooms').update({ status: 'placement' }).eq('id', roomId)
  for (const [who, team, offset] of [[alpha, 0, 0], [bravo, 1, 2], [charlie, 2, 4]]) {
    const { shipGrid, shipIndexGrid, placements } = fleetRows(offset)
    const { error } = await who.client.from('fleets').upsert(
      {
        room_id: roomId,
        team,
        ship_grid: shipGrid,
        ship_index_grid: shipIndexGrid,
        ship_hits_remaining: SHIPS.map((s) => s.size),
        ship_sunk: SHIPS.map(() => false),
        placements,
        placement_confirmed: true,
      },
      { onConflict: 'room_id,team' }
    )
    if (error) throw new Error(`${who.name} fleet: ${error.message}`)
    await who.client
      .from('team_ready')
      .upsert({ room_id: roomId, team, ready: true }, { onConflict: 'room_id,team' })
  }

  await alpha.client
    .from('attacks')
    .insert({ room_id: roomId, cell_index: -1, attacker_team: -1, defender_team: -1 })
  await alpha.client.from('rooms').update({ status: 'battle' }).eq('id', roomId)

  // Bravo's Carrier (5 long) sits at row 2, columns 0-4: cells 20..24.
  const CARRIER = [20, 21, 22, 23, 24]

  // -- 1. the same fleet fires twice at one square --------------------------
  const first = await fire(alpha, 0, CARRIER[0], 1)
  check('first shot at a hull square is a hit', first.result === 'hit', `result=${first.result}`)

  const again = await fire(alpha, 0, CARRIER[0], 1)
  check('a repeat shot at the same square gets the same verdict', again.result === 'hit', `result=${again.result}`)

  let fleet = await bravoHits()
  check(
    'the repeat did NOT wound the Carrier a second time',
    fleet.ship_hits_remaining[0] === 4,
    `hits_remaining=${fleet.ship_hits_remaining[0]}, expected 4`
  )

  {
    const { data: rows, error } = await alpha.client
      .from('attacks')
      .select('id')
      .eq('room_id', roomId)
      .eq('attacker_team', 0)
      .eq('defender_team', 1)
      .eq('cell_index', CARRIER[0])
    if (error) throw error
    check(
      'the repeat did NOT leave a second row behind',
      rows.length === 1,
      `${rows.length} row(s) for that square, expected 1`
    )
  }

  // -- 2. a different fleet fires at the same square ------------------------
  const crossTeam = await fire(charlie, 2, CARRIER[0], 1)
  check(
    'another fleet firing at that square is still told what is there',
    crossTeam.result === 'hit',
    `result=${crossTeam.result}`
  )
  fleet = await bravoHits()
  check(
    'a second FLEET hitting the same square wounds the hull only once',
    fleet.ship_hits_remaining[0] === 4,
    `hits_remaining=${fleet.ship_hits_remaining[0]}, expected 4`
  )

  // -- 3. it still takes five distinct squares to sink a five-cell hull -----
  for (const cell of CARRIER.slice(1, 4)) await fire(alpha, 0, cell, 1)
  fleet = await bravoHits()
  check(
    'four distinct squares leaves the Carrier afloat with one to go',
    fleet.ship_hits_remaining[0] === 1 && fleet.ship_sunk[0] === false,
    `hits_remaining=${fleet.ship_hits_remaining[0]}, sunk=${fleet.ship_sunk[0]}`
  )

  const repeatBeforeKill = await fire(charlie, 2, CARRIER[1], 1)
  fleet = await bravoHits()
  check(
    'a repeat of an already-hit square cannot land the killing blow',
    fleet.ship_sunk[0] === false && repeatBeforeKill.result === 'hit',
    `sunk=${fleet.ship_sunk[0]}, repeat result=${repeatBeforeKill.result}`
  )

  const kill = await fire(alpha, 0, CARRIER[4], 1)
  check('the fifth distinct square sinks it', kill.result === 'sunk', `result=${kill.result}`)
  check('and it carries the hull geometry', kill.sunk_ship_size === 5 && kill.sunk_start_row === 2)

  // -- 4. misses are unaffected ---------------------------------------------
  const miss = await fire(alpha, 0, 90, 1)
  const missAgain = await fire(charlie, 2, 90, 1)
  check(
    'open water reads as a miss for everyone who fires at it',
    miss.result === 'miss' && missAgain.result === 'miss',
    `${miss.result}/${missAgain.result}`
  )
  fleet = await bravoHits()
  check(
    'and nothing else on the fleet moved',
    JSON.stringify(fleet.ship_hits_remaining) === JSON.stringify([0, 4, 3, 3, 2]),
    JSON.stringify(fleet.ship_hits_remaining)
  )
} finally {
  if (roomId) {
    const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { error } = await admin.from('rooms').delete().eq('id', roomId)
    console.log(error ? `  cleanup FAILED: ${error.message} (room ${code})` : `  cleaned up room ${code}`)
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
