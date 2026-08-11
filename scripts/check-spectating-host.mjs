/**
 * Drives a whole match whose HOST is a spectator, against the live cloud project.
 *
 * The bug this exists to hold shut: the "every fleet is ready, open fire" trigger used to live
 * inside PlacementPhase, which never mounts for a host who isn't on a fleet - so a room whose host
 * chose to spectate sat in placement forever and looked like the game "refused to start". The
 * trigger moved to Room.tsx; this script performs the exact writes that trigger makes, as a
 * spectator's session, and checks the database lets every one of them through.
 *
 * Also covers leaving mid-match (players delete own), which the new Leave button relies on.
 *
 * Read-write: it creates one throwaway room and deletes it again at the end. It deliberately does
 * NOT archive anything, so the record books are untouched.
 *
 *   node scripts/check-spectating-host.mjs
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

/** A fresh anonymous browser session. */
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

const host = await session('host (spectator)')
const alpha = await session('alpha')
const bravo = await session('bravo')

const code = `TESTSPEC${Date.now().toString(36).toUpperCase().slice(-4)}`
let roomId = null

try {
  // -- 1. A spectating host opens the room ----------------------------------
  const { data: room, error: roomErr } = await host.client
    .from('rooms')
    .insert({ code, board_size: BOARD, ship_defs: SHIPS, seed: '123456789' })
    .select()
    .single()
  if (roomErr) throw roomErr
  roomId = room.id

  const { error: hostErr } = await host.client
    .from('players')
    .insert({ room_id: roomId, user_id: host.userId, nickname: 'Caster', is_host: true, team: null })
  check('host joins with team = null (spectating)', !hostErr, hostErr?.message)

  for (const [who, team] of [[alpha, 0], [bravo, 1]]) {
    const { error } = await who.client
      .from('players')
      .insert({ room_id: roomId, user_id: who.userId, nickname: who.name, team, is_host: false })
    if (error) throw error
  }

  // -- 2. The spectating host starts placement ------------------------------
  const { error: placeErr } = await host.client.from('rooms').update({ status: 'placement' }).eq('id', roomId)
  check('spectating host can move the room to placement', !placeErr, placeErr?.message)
  await host.client.from('team_ready').delete().eq('room_id', roomId)

  // -- 3. Both fleets place and confirm -------------------------------------
  for (const [who, team, offset] of [[alpha, 0, 0], [bravo, 1, 2]]) {
    const { shipGrid, shipIndexGrid, placements } = fleetRows(offset)
    const { error: upErr } = await who.client.from('fleets').upsert(
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
    if (upErr) throw new Error(`${who.name} fleet: ${upErr.message}`)
    const { error: readyErr } = await who.client
      .from('team_ready')
      .upsert({ room_id: roomId, team, ready: true }, { onConflict: 'room_id,team' })
    if (readyErr) throw new Error(`${who.name} ready: ${readyErr.message}`)
  }

  // -- 4. THE FIX: the spectating host opens the battle ---------------------
  // Exactly what Room.tsx's auto-start effect does once every active team is ready.
  const { data: ready } = await host.client.from('team_ready').select().eq('room_id', roomId)
  check('spectating host can read every team_ready row', (ready ?? []).length === 2, `${(ready ?? []).length} rows`)
  check('both fleets report ready', (ready ?? []).every((r) => r.ready))

  const { data: marker, error: markerErr } = await host.client
    .from('attacks')
    .insert({ room_id: roomId, cell_index: -1, attacker_team: -1, defender_team: -1 })
    .select()
  check(
    'spectating host can write the match-start marker',
    !markerErr && (marker ?? []).length === 1,
    markerErr?.message ?? `${(marker ?? []).length} rows`
  )

  const { error: battleErr } = await host.client.from('rooms').update({ status: 'battle' }).eq('id', roomId)
  check('spectating host can flip the room to battle', !battleErr, battleErr?.message)

  const { data: afterStart } = await host.client.from('rooms').select('status').eq('id', roomId).single()
  check('room really is in battle', afterStart?.status === 'battle', `status=${afterStart?.status}`)

  // -- 5. A shot lands, and the spectator can see the result ----------------
  const { error: fireErr } = await alpha.client
    .from('attacks')
    .insert({ room_id: roomId, cell_index: 0, attacker_team: 0, defender_team: 1 })
  check('alpha can fire', !fireErr, fireErr?.message)

  const { data: pending } = await host.client
    .from('attacks')
    .select()
    .eq('room_id', roomId)
    .eq('cell_index', 0)
    .single()
  const { error: resolveErr } = await host.client.rpc('resolve_attack', { p_attack_id: pending.id })
  check('any client (here the spectator) can resolve a pending shot', !resolveErr, resolveErr?.message)

  const { data: resolved } = await host.client.from('attacks').select().eq('id', pending.id).single()
  // Bravo's ships start at row 2, so cell 0 (row 0) is open water.
  check('the shot resolved', resolved.result !== 'pending', `result=${resolved.result}`)

  const { data: specFleets } = await host.client.from('fleets').select().eq('room_id', roomId)
  check(
    'spectator can read every fleet (ship overlays + sounds have data to work with)',
    (specFleets ?? []).length === 2,
    `${(specFleets ?? []).length} fleets`
  )

  // -- 6. Leaving mid-match -------------------------------------------------
  const { data: bravoRow } = await bravo.client
    .from('players')
    .select('id')
    .eq('room_id', roomId)
    .eq('user_id', bravo.userId)
    .single()
  const { error: leaveErr } = await bravo.client.from('players').delete().eq('id', bravoRow.id)
  const { data: stillThere } = await host.client.from('players').select('id').eq('id', bravoRow.id)
  check(
    'a player can leave mid-match (row actually gone)',
    !leaveErr && (stillThere ?? []).length === 0,
    leaveErr?.message
  )

  // A stranger still cannot delete somebody else's seat.
  const { data: alphaRow } = await alpha.client
    .from('players')
    .select('id')
    .eq('room_id', roomId)
    .eq('user_id', alpha.userId)
    .single()
  await bravo.client.from('players').delete().eq('id', alphaRow.id)
  const { data: alphaLeft } = await host.client.from('players').select('id').eq('id', alphaRow.id)
  check('a non-host cannot delete another player (RLS still holds)', (alphaLeft ?? []).length === 1)

  // The host, though, should be able to - they run the room, spectating or not.
  //
  // This one fails on a project that never had the host_controls migration applied, which is not a
  // spectator problem at all: WITHOUT the "players delete by host" policy the lobby's Kick button
  // silently does nothing for every host who isn't also a site admin (admins have their own delete
  // policy from lock_down_writes, which is why it can look like it works). RLS makes a blocked
  // DELETE affect zero rows and report NO error, so there's nothing on screen to notice.
  // Remedy: part 1 of supabase/migrations/20260803000000_idempotent_shot_resolution.sql
  await host.client.from('players').delete().eq('id', alphaRow.id)
  const { data: afterKick } = await host.client.from('players').select('id').eq('id', alphaRow.id)
  check(
    'a host can kick (needs the "players delete by host" policy)',
    (afterKick ?? []).length === 0,
    (afterKick ?? []).length === 0 ? '' : 'run part 1 of RUN_THESE.sql'
  )
} finally {
  if (roomId) {
    // Service role, because "rooms delete by admin" doesn't apply to an anonymous session.
    const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { error } = await admin.from('rooms').delete().eq('id', roomId)
    console.log(error ? `  cleanup FAILED: ${error.message} (room ${code})` : `  cleaned up room ${code}`)
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
