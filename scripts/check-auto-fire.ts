/**
 * Drives the auto-fire endpoint end to end, standing in for the game mod.
 *
 * The mod's whole contribution is one HTTP request carrying a token and a list of boss event flags.
 * That is trivially faked, which means every part of this feature except reading game memory can be
 * tested with no Elden Ring, no DLL and nobody else's code - and that is the point of this script.
 * It is also the thing to hand whoever is writing the mod: a live endpoint that already works, in
 * place of a specification.
 *
 * What it proves:
 *   * a reported flag lands on the right cell of the right board, for the right team
 *   * a shot appears on every opposing fleet, and each row gets resolved rather than left pending
 *   * a re-reported kill is skipped instead of firing twice - the property that lets the mod send
 *     full state every tick without an acknowledgement protocol
 *   * the kill time is honoured but clamped, so timing records can't be backdated
 *   * the tally matches what the scoreboard would say, including that a shot which sinks a hull
 *     counts as a hit - `sunk` is a separate verdict from `hit` and a tally that tests only for
 *     the latter files every kill shot as a miss
 *   * every refusal path refuses: unknown token, no live match, wrong square set
 *
 * Board derivation deliberately imports the app's real buildFlatBoard and seededRandom rather than
 * reimplementing them, so a change to either shows up here. Only challengesForRoom()'s one-line seed
 * base is mirrored, for the same reason check-boards.ts mirrors it - the square-set registry binds
 * eleven JSON files and can't be imported outside Vite.
 *
 * Read-write: creates one throwaway room and deletes it again, plus an ingest token for a scratch
 * anonymous user. Archives nothing, so the record books are untouched.
 *
 *   node --experimental-strip-types scripts/check-auto-fire.ts
 *   node --experimental-strip-types scripts/check-auto-fire.ts http://localhost:54321/functions/v1/auto-fire
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { buildFlatBoard, dealtPool, type Challenge } from '../src/lib/squareSetFormat.ts'
import { rng, seedFrom } from '../src/lib/seededRandom.ts'

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
const anon = env.VITE_SUPABASE_ANON_KEY
const endpoint = process.argv[2] ?? `${url}/functions/v1/auto-fire`

const readJson = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const bossData: Challenge[] = readJson('../src/data/battleshipChallenges.json')
const bossFlags: Record<string, number> = readJson('../src/data/bossFlags.json')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

async function session(name: string) {
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInAnonymously()
  if (error) throw new Error(`${name}: ${error.message}`)
  return { name, client, userId: data.user!.id }
}

const SHIPS = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
]
const BOARD = 10
const SEED = '123456789'

/** Ships in fixed rows, one per row, from column 0. Same shape submitPlacement writes. */
function fleetRows(rowOffset: number) {
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

/**
 * Mirrors challengesForRoom()'s seeding for the default set - see the header. The room is created by
 * this run, so its board was dealt just now and draws from today's pool (see dealtPool).
 */
function boardFor(roomId: string, seed: string | null): Challenge[] {
  const next = rng(seedFrom(seed ? `${roomId}:${seed}` : roomId))
  return buildFlatBoard(dealtPool(bossData, new Date().toISOString()), BOARD * BOARD, next)
}

async function post(body: unknown) {
  // Deliberately no Authorization or apikey header: the game mod has neither, so sending them here
  // would let the endpoint pass this script while still rejecting the real client. If this 401s, the
  // function was deployed with JWT verification left on - see its README.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    throw new Error(
      `Endpoint returned non-JSON (${res.status}). Is it deployed / served?\n` +
        `  ${endpoint}\n  ${text.slice(0, 300)}`
    )
  }
}

const alpha = await session('alpha')
const bravo = await session('bravo')
const code = `TESTAF${Date.now().toString(36).toUpperCase().slice(-4)}`
let roomId: string | null = null
let token: string | null = null

try {
  /* --- a real room, mid-battle, two fleets ------------------------------------------------- */

  const { data: room, error: roomErr } = await alpha.client
    .from('rooms')
    .insert({ code, board_size: BOARD, ship_defs: SHIPS, seed: SEED, square_set: 'bosses' })
    .select()
    .single()
  if (roomErr) throw roomErr
  roomId = room.id as string

  for (const [who, team, host] of [
    [alpha, 0, true],
    [bravo, 1, false],
  ] as const) {
    const { error } = await who.client
      .from('players')
      .insert({ room_id: roomId, user_id: who.userId, nickname: who.name, team, is_host: host })
    if (error) throw error
  }

  await alpha.client.from('rooms').update({ status: 'placement' }).eq('id', roomId)
  for (const [who, team, offset] of [
    [alpha, 0, 0],
    [bravo, 1, 2],
  ] as const) {
    const { shipGrid, shipIndexGrid, placements } = fleetRows(offset)
    const { error } = await who.client.from('fleets').upsert(
      {
        room_id: roomId,
        team,
        ship_grid: shipGrid,
        ship_index_grid: shipIndexGrid,
        placements,
        ship_hits_remaining: SHIPS.map((s) => s.size),
        ship_sunk: SHIPS.map(() => false),
        // Required since 20260819010000_no_fleet_no_battle: the room refuses to enter 'battle'
        // while any crewed team's fleet is unconfirmed. This setup always did place both fleets
        // fully, so it was only ever missing the flag a real placement screen sets on confirm -
        // but without it the whole script threw on the status flip and never reached auto-fire.
        placement_confirmed: true,
      },
      { onConflict: 'room_id,team' }
    )
    if (error) throw error
  }
  // Verified rather than assumed: a silent failure here presents as the endpoint reporting
  // `not_in_match`, which reads like an endpoint bug rather than a setup one.
  const { data: started, error: startErr } = await alpha.client
    .from('rooms')
    .update({ status: 'battle' })
    .eq('id', roomId)
    .select('status')
  if (startErr) throw startErr
  check('room is in battle', started?.[0]?.status === 'battle', `status=${started?.[0]?.status}`)

  /* --- a token, as the profile screen will mint one ------------------------------------------ */

  const { data: tokenRow, error: tokenErr } = await alpha.client
    .from('ingest_tokens')
    .insert({ user_id: alpha.userId })
    .select('token')
    .single()
  if (tokenErr) {
    throw new Error(
      `Couldn't mint an ingest token: ${tokenErr.message}\n` +
        `Has supabase/migrations/20260812000000_ingest_tokens.sql been applied?`
    )
  }
  token = tokenRow.token as string
  check('token minted', typeof token === 'string' && token.length >= 32, `${token.length} chars`)

  /* --- fire one kill --------------------------------------------------------------------- */

  const board = boardFor(roomId, SEED)
  // First cell whose square we have a flag for. All 206 map today, so this is cell 0 in practice.
  const cell = board.findIndex((sq) => sq?.tooltip && bossFlags[sq.tooltip] !== undefined)
  const tooltip = board[cell].tooltip!
  const flag = bossFlags[tooltip]
  console.log(`\n  firing flag ${flag} = "${tooltip}" -> expecting cell ${cell}\n`)

  const killedAt = new Date(Date.now() - 1500).toISOString()
  const first = await post({ token, kills: [{ flag, at: killedAt }] })

  check('endpoint accepted', first.body.ok === true, JSON.stringify(first.body).slice(0, 160))
  check('fired exactly one square', first.body.fired?.length === 1)
  check('landed on the derived cell', first.body.fired?.[0]?.cell === cell, `got ${first.body.fired?.[0]?.cell}`)
  check(
    'shot was resolved, not left pending',
    ['hit', 'miss', 'sunk'].includes(first.body.fired?.[0]?.result),
    `result=${first.body.fired?.[0]?.result}`
  )

  const { data: rows } = await alpha.client
    .from('attacks')
    .select('cell_index, attacker_team, defender_team, attacker_player_id, result, created_at, auto')
    .eq('room_id', roomId)
    .eq('cell_index', cell)

  check('one row per opposing fleet', rows?.length === 1, `${rows?.length} rows for 2 teams`)
  check('attributed to the firing player', rows?.every((r) => r.attacker_player_id !== null) ?? false)
  check('fired by the right team', rows?.every((r) => r.attacker_team === 0) ?? false)
  check('no row left pending', rows?.every((r) => r.result !== 'pending') ?? false)
  // The one column that tells the Almanac's timing boards this shot's clock can be trusted - see
  // the 20260920 migration. A manual click never sets it, so this is the whole difference between
  // the two paths as far as anything downstream can tell.
  check('marked as auto-fired', rows?.every((r) => r.auto === true) ?? false)

  // Guarded: with no rows the remaining checks have nothing to say, and a crash here would bury the
  // real failure above under a stack trace.
  if (rows?.length) {
    const stamped = new Date(rows[0].created_at as string).getTime()
    check(
      'kill time honoured, not overwritten with arrival',
      Math.abs(stamped - Date.parse(killedAt)) < 1000,
      `${Math.round((stamped - Date.parse(killedAt)) / 100) / 10}s off`
    )
  } else {
    check('kill time honoured, not overwritten with arrival', false, 'no rows to check')
  }

  check('tally counts the shot', first.body.tally?.shots === 1, JSON.stringify(first.body.tally))
  check(
    'tally hits + misses equals shots',
    first.body.tally?.hits + first.body.tally?.misses === first.body.tally?.shots
  )

  /* --- replay: the mod sends full state every tick, so this must be a no-op ----------------- */

  const replay = await post({ token, kills: [{ flag, at: killedAt }] })
  check('replay fires nothing', replay.body.fired?.length === 0)
  check(
    'replay says why',
    replay.body.skipped?.some((s: { reason: string }) => s.reason === 'already_fired')
  )
  const { count: afterReplay } = await alpha.client
    .from('attacks')
    .select('*', { count: 'exact', head: true })
    .eq('room_id', roomId)
    .eq('cell_index', cell)
  check('replay created no rows', afterReplay === rows?.length, `${afterReplay} vs ${rows?.length}`)

  /* --- backdating ---------------------------------------------------------------------------- */

  const cell2 = board.findIndex(
    (sq, i) => i > cell && sq?.tooltip && bossFlags[sq.tooltip] !== undefined
  )
  const ancient = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const backdated = await post({ token, kills: [{ flag: bossFlags[board[cell2].tooltip!], at: ancient }] })
  const { data: clampedRow } = await alpha.client
    .from('attacks')
    .select('created_at')
    .eq('room_id', roomId)
    .eq('cell_index', cell2)
    .limit(1)
    .single()
  const drift = Date.now() - new Date(clampedRow!.created_at as string).getTime()
  check('an hour-old kill time is clamped, not accepted', drift < 30_000, `${Math.round(drift / 1000)}s old`)

  /* --- a sinking shot is still a hit --------------------------------------------------------- */

  // The regression this exists for: resolve_attack answers `sunk`, not `hit`, for the shot that
  // finishes a hull, so a tally testing for `hit` alone files every kill shot as a miss. It shows up
  // as an overlay that disagrees with the scoreboard about the same match, and only once something
  // has actually sunk - which is exactly why every check above passed while it was broken. The two
  // shots fired here are the first in this script that connect with anything at all.
  //
  // Cells come from fleetRows(), not a second copy of the layout, so if the placement helper moves
  // its ships this test moves with them. Shortest hull on the board = fewest shots to sink.
  const hullIndex = SHIPS.reduce((best, s, i) => (s.size < SHIPS[best].size ? i : best), 0)
  const hull = fleetRows(2).placements[hullIndex]
  const hullCells = Array.from(
    { length: SHIPS[hullIndex].size },
    (_, i) => hull.startRow * BOARD + hull.startCol + i
  )
  const hullFlags = hullCells
    .map((c) => {
      const t = board[c]?.tooltip
      // A tooltip sitting on two cells would fire two shots from one flag and break the arithmetic
      // below. It cannot happen with 206 squares over 100 cells, but a smaller set would.
      if (!t || board.filter((sq) => sq?.tooltip === t).length !== 1) return undefined
      return bossFlags[t]
    })
    .filter((f): f is number => f !== undefined)
  check(
    `${SHIPS[hullIndex].name} occupies flagged cells ${hullCells.join(', ')}`,
    hullFlags.length === hullCells.length,
    `${hullFlags.length}/${hullCells.length} usable - setup problem, not an endpoint bug`
  )

  if (hullFlags.length === hullCells.length) {
    const before = backdated.body.tally
    const fires: Awaited<ReturnType<typeof post>>[] = []
    for (const f of hullFlags) fires.push(await post({ token, kills: [{ flag: f }] }))
    const sank = fires[fires.length - 1]

    check(
      'every hull cell fired one square',
      fires.every((r) => r.body.fired?.length === 1),
      fires.map((r) => r.body.fired?.length).join(', ')
    )
    check(
      'the shot that finishes a hull reports sunk',
      sank.body.fired?.[0]?.result === 'sunk',
      `result=${sank.body.fired?.[0]?.result}`
    )

    // Asked of the table rather than the response, so a verdict invented by the endpoint and never
    // written down would still fail.
    const { data: sunkRow } = await alpha.client
      .from('attacks')
      .select('result')
      .eq('room_id', roomId)
      .eq('cell_index', hullCells[hullCells.length - 1])
      .limit(1)
      .single()
    check('and the row it wrote says sunk too', sunkRow?.result === 'sunk', `result=${sunkRow?.result}`)

    // The guard proper. Every one of these shots connected, so hits must move by all of them - with
    // the sink miscounted it moves by one fewer and the last one turns up as a miss instead.
    const after = sank.body.tally
    check(
      'a sinking shot counts as a hit in the tally',
      after?.hits - before?.hits === hullCells.length,
      `hits ${before?.hits} -> ${after?.hits} over ${hullCells.length} connecting shots`
    )
    check(
      'and does not land in the miss column',
      after?.misses === before?.misses,
      `misses ${before?.misses} -> ${after?.misses}`
    )
    // The overlay's PB line holds this against match_participants.sunk, which counts hulls - so
    // one fleet's hull going down is exactly one, and nothing before it counted any.
    check(
      'the tally counts the sunk hull',
      before?.sunk === 0 && after?.sunk === 1,
      `sunk ${before?.sunk} -> ${after?.sunk}`
    )
    // A scratch user has archived nothing, so there is no PB to draw: the key must be absent rather
    // than present-and-empty, which is how the overlay knows to leave the PB line off entirely.
    check(
      'a captain with no archived games gets no pb',
      !('pb' in sank.body) && !('pb_beaten' in sank.body),
      Object.keys(sank.body).join(', ')
    )
    // Anchored to the hit count the sink SHOULD have produced, not to the one that came back.
    // Recomputing accuracy from the endpoint's own `hits` only proves it can divide: that version of
    // this check sat here reporting "25% from 1/4" while the two above it were failing.
    const owed = Math.round(((before?.hits + hullCells.length) / after?.shots) * 100)
    check(
      'accuracy is computed over the sink as well',
      after?.accuracy === owed,
      `${after?.accuracy}% from ${after?.hits}/${after?.shots}, owed ${owed}%`
    )
  }

  /* --- refusals ------------------------------------------------------------------------------ */

  const bogus = await post({ token: 'not-a-real-token', kills: [{ flag }] })
  check('unknown token refused', bogus.body.ok === false && bogus.body.error === 'unknown_token', bogus.body.error)

  const noToken = await post({ kills: [{ flag }] })
  check('missing token refused', noToken.body.ok === false && noToken.body.error === 'missing_token', noToken.body.error)

  const unmapped = await post({ token, kills: [{ flag: 999_999_999 }] })
  check(
    'a flag that is not a square is skipped, not an error',
    unmapped.body.ok === true &&
      unmapped.body.skipped?.some((s: { reason: string }) => s.reason === 'not_a_square')
  )

  await alpha.client.from('rooms').update({ square_set: 'ringus' }).eq('id', roomId)
  const wrongSet = await post({ token, kills: [{ flag }] })
  check(
    'non-bosses room refused',
    wrongSet.body.ok === false && wrongSet.body.error === 'unsupported_square_set',
    wrongSet.body.error
  )
  await alpha.client.from('rooms').update({ square_set: 'bosses' }).eq('id', roomId)

  await alpha.client.from('rooms').update({ status: 'finished' }).eq('id', roomId)
  const notLive = await post({ token, kills: [{ flag }] })
  check(
    'a room that is not in battle refused',
    notLive.body.ok === false && notLive.body.error === 'not_in_match',
    notLive.body.error
  )
} finally {
  if (token) await alpha.client.from('ingest_tokens').delete().eq('token', token)
  if (roomId) await alpha.client.from('rooms').delete().eq('id', roomId)
}

console.log(`\n${'='.repeat(70)}`)
console.log(failures === 0 ? 'all checks passed' : `${failures} failed`)
console.log('='.repeat(70))
process.exit(failures === 0 ? 0 : 1)
