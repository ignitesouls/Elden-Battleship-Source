// Plays the bot opponent's side of a practice match.
//
// The bot is a seat on a fleet (see the bot_opponent migration) with nobody behind it, so this is its
// hands: it lays the bot's ships when placement opens, and it fires the bot's shots once the match is
// under way.
//
// On the boss board the bot plays as a CREW - one simulated captain per person on the biggest fleet it
// faces, each running their own route learned from the archive (src/lib/botCrew.ts, with the routes in
// src/data/botRoutes.json and the bot's rules in src/lib/botRules.ts). The captains' runs live in
// rooms.bot_state between turns. On any other square set there are no routes to follow, and the bot
// plays the plain way it always did (src/lib/botBrain.ts chooseShots).
//
// -- Who calls it -----------------------------------------------------------------------------------
//
// A browser in the room, whenever rooms.bot_next_s says something is due (see useBotDriver). The caller
// only says "now, maybe" - it never says where to fire or what the bot knows. The clock is checked
// here, and the turn is claimed with a compare-and-set on bot_next_s, so a call that is early, a
// duplicate, or from a second tab does nothing at all. Any signed-in player in the room may call it;
// that is what keeps the bot playing when the host's tab is the one that closed.
//
// -- Why it has to be server-side ------------------------------------------------------------------
//
// It places the bot's ships, and no browser should hold those: the host could read them out of the
// network tab. And a Shaker reads the hull it has already hit, which means reading a human fleet -
// something `fleets` RLS gives no client but that fleet's own crew.
//
// -- Why the database directly ---------------------------------------------------------------------
//
// Same as auto-fire: over SUPABASE_DB_URL the reads and writes below cost no gateway log lines, so a
// bot turn costs the project one line - this request - the same as a person's click. It also means
// the session is `postgres`, which is what guard_fleet_placement lets place the bot's ships.

import postgres from 'npm:postgres@3.4.7'
import { rng, seedFrom } from '../../../src/lib/seededRandom.ts'
import { buildFlatBoard, dealtPool } from '../../../src/lib/squareSetFormat.ts'
import { applyBoardPerm } from '../../../src/lib/boardBalance.ts'
import { activeTeams, initialHitsRemaining, randomPlacements, validatePlacements } from '../../../src/lib/battleshipLogic.ts'
import { MATCH_START_MARKER, matchTimings, battlePhaseAt } from '../../../src/lib/matchTime.ts'
import { pauseInfoAt } from '../../../src/lib/matchPause.ts'
import { effectiveCosts } from '../../../src/lib/prereqCost.ts'
import { BOT_USER_ID, isBotTier, type BotTier } from '../../../src/lib/bot.ts'
import { aimWeights, chooseShots, nextGapSeconds, openingSeconds, type BotShot } from '../../../src/lib/botBrain.ts'
import { crewDue, crewReady, newCrew, playCrew, type BotRoutes, type CrewState, type CrewWorld } from '../../../src/lib/botCrew.ts'
import type { RuleSquare } from '../../../src/lib/botRules.ts'
import type { ShipDefinition } from '../../../src/types/battleship.ts'
import bossData from '../../../src/data/battleshipChallenges.json' with { type: 'json' }
import bossData2v2 from '../../../src/data/battleshipChallenges2v2.json' with { type: 'json' }
import bossCost from '../../../src/data/bossTimeCost.json' with { type: 'json' }
import bossPrereqs from '../../../src/data/bossPrereqs.json' with { type: 'json' }
import botRoutes from '../../../src/data/botRoutes.json' with { type: 'json' }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2, idle_timeout: 30 })

/** A query's rows exactly as PostgREST would have returned them - see auto-fire. */
async function rows<T>(query: postgres.PendingQuery<postgres.Row[]>): Promise<T[]> {
  const [{ rows }] = await sql`select coalesce(json_agg(q), '[]'::json) as rows from (${query}) q`
  return rows as T[]
}

/**
 * The boss sets, which are the ones with routes and time costs. Mirrors auto-fire's table and its
 * DEALS_AS, for the same reason: the seeding rule is frozen and has to match challengesForRoom.
 */
const BOSS_SETS: Record<string, RuleSquare[]> = {
  'bosses': bossData as RuleSquare[],
  'bosses-2v2': bossData2v2 as RuleSquare[],
  'boss-shuffle': bossData as RuleSquare[],
}
const DEALS_AS: Record<string, string> = { 'boss-shuffle': 'bosses' }
const DEFAULT_SET = 'bosses'

const byName = new Map((bossData as RuleSquare[]).map((s) => [s.name, s]))

const costFor = new Map<string, number>()
for (const [tooltip, r] of Object.entries(bossCost as Record<string, unknown>)) {
  if (tooltip.startsWith('_')) continue
  costFor.set(tooltip, r as number)
}
const costByName: Record<string, number> = {}
for (const set of Object.values(BOSS_SETS)) {
  for (const square of set) {
    const c = costFor.get(square.tooltip ?? '')
    if (c !== undefined) costByName[square.name] = c
  }
}

/**
 * The room's boss board as played (balanced perm applied): the square on each cell, and its time cost
 * for the plain bot's reach. Null off the boss sets.
 */
function bossBoard(
  roomId: string,
  setId: string,
  cells: number,
  seed: string | null,
  perm: number[] | null,
  dealtAt: string | null
): { squares: RuleSquare[]; cost: number[] | null } | null {
  if (!BOSS_SETS[setId]) return null
  const dealId = DEALS_AS[setId] ?? setId
  const base = dealId === DEFAULT_SET ? roomId : `${roomId}:${dealId}`
  // Cast as narrowly as auto-fire's: buildFlatBoard hands back the very objects it is given.
  const pool = dealtPool(BOSS_SETS[setId], dealtAt) as unknown as Parameters<typeof buildFlatBoard>[0]
  const dealt = buildFlatBoard(pool, cells, rng(seedFrom(seed ? `${base}:${seed}` : base))) as unknown as RuleSquare[]
  const raw = dealt.map((square) => costFor.get(square?.tooltip ?? ''))
  const cost = raw.every((c) => c !== undefined)
    ? applyBoardPerm(effectiveCosts(dealt, raw as number[], bossPrereqs as Record<string, unknown>, costByName), perm)
    : null
  return { squares: applyBoardPerm(dealt, perm), cost }
}

/**
 * The caller's user id, read from the JWT the gateway has already verified (verify_jwt is on for
 * this function). Decoded here rather than asked of the auth server, which would be one more
 * metered request per shot for a fact already in hand.
 */
function callerId(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json.sub === 'string' ? json.sub : null
  } catch {
    return null
  }
}

interface RoomRow {
  id: string
  status: string
  board_size: number
  ship_defs: ShipDefinition[]
  square_set: string | null
  seed: string | null
  seed_set_at: string | null
  board_perm: number[] | null
  starting_seconds: number | null
  prep_seconds: number | null
  pause_at: string | null
  resume_at: string | null
  pause_log: { at: string; until: string }[] | null
  bot_tier: string | null
  bot_team: number | null
  bot_next_s: number | null
  bot_state: CrewState | null
}

/** Lays the bot's ships once placement opens. Idempotent: a placed bot fleet is left alone. */
async function place(room: RoomRow, team: number) {
  const cells = room.board_size * room.board_size
  const [fleet] = await rows<{ placement_confirmed: boolean; cells: number }>(sql`
    select placement_confirmed, jsonb_array_length(ship_grid) as cells
      from public.fleets where room_id = ${room.id} and team = ${team}`)
  if (fleet?.placement_confirmed && fleet.cells === cells) return jsonResponse({ ok: true, placed: 'already' })

  const placements = randomPlacements(room.board_size, room.ship_defs)
  const { valid, shipGrid, shipIndexGrid } = validatePlacements(room.board_size, room.ship_defs, placements)
  if (!valid) return jsonResponse({ ok: false, reason: 'no_layout' }, 500)

  const hits = initialHitsRemaining(room.ship_defs)
  const sunk = room.ship_defs.map(() => false)
  await sql.begin(async (tx) => {
    await tx`
      insert into public.fleets (room_id, team, ship_grid, ship_index_grid, ship_hits_remaining, ship_sunk, placements, placement_confirmed)
      values (${room.id}, ${team}, ${tx.json(shipGrid)}, ${tx.json(shipIndexGrid)}, ${tx.json(hits)},
              ${tx.json(sunk)}, ${tx.json(placements as unknown as postgres.JSONValue)}, true)
      on conflict (room_id, team) do update
        set ship_grid = excluded.ship_grid, ship_index_grid = excluded.ship_index_grid,
            ship_hits_remaining = excluded.ship_hits_remaining, ship_sunk = excluded.ship_sunk,
            placements = excluded.placements, placement_confirmed = true`
    // The public "this crew is ready" mirror, which is what the host's start-the-battle effect reads.
    await tx`
      insert into public.team_ready (room_id, team, ready) values (${room.id}, ${team}, true)
      on conflict (room_id, team) do update set ready = true`
  })
  return jsonResponse({ ok: true, placed: true })
}

/** What the bot knows going into a turn: its own shots and verdicts, and who is still afloat. */
async function knowledge(room: RoomRow, tier: BotTier, team: number, defenders: number[]) {
  const [mine, fallen] = await Promise.all([
    rows<{
      cell_index: number
      defender_team: number
      result: string
      sunk_ship_size: number | null
      sunk_start_row: number | null
      sunk_start_col: number | null
      sunk_horizontal: boolean | null
    }>(sql`
      select cell_index, defender_team, result, sunk_ship_size, sunk_start_row, sunk_start_col, sunk_horizontal
        from public.attacks
       where room_id = ${room.id} and attacker_team = ${team} and cell_index >= 0`),
    rows<{ team: number }>(sql`
      select team from public.team_ready where room_id = ${room.id} and eliminated`),
  ])
  const sunkTeams = new Set(fallen.map((f) => f.team))
  const alive = defenders.filter((t) => !sunkTeams.has(t))

  let truth = new Map<number, number[]>()
  if (tier === 'shaker' && alive.length > 0) {
    const grids = await rows<{ team: number; ship_index_grid: number[] }>(sql`
      select team, ship_index_grid from public.fleets
       where room_id = ${room.id} and team in ${sql(alive)}`)
    truth = new Map(grids.map((g) => [g.team, g.ship_index_grid]))
  }

  const shots: BotShot[] = mine.map((a) => ({
    cell: a.cell_index,
    defender: a.defender_team,
    result: a.result as BotShot['result'],
    sunkSize: a.sunk_ship_size,
    sunkStartRow: a.sunk_start_row,
    sunkStartCol: a.sunk_start_col,
    sunkHorizontal: a.sunk_horizontal,
  }))
  return { shots, defenders: alive.map((t) => ({ team: t, truth: truth.get(t) ?? null })) }
}

/** Fires the bot's shots if anything is due, and books the next turn. */
async function fire(room: RoomRow, tier: BotTier, team: number) {
  const [roster, [marker]] = await Promise.all([
    rows<{ id: string; team: number | null; user_id: string }>(sql`
      select id, team, user_id from public.players where room_id = ${room.id}`),
    rows<{ created_at: string }>(sql`
      select created_at from public.attacks
       where room_id = ${room.id} and cell_index = ${MATCH_START_MARKER} limit 1`),
  ])
  const seat = roster.find((p) => p.user_id === BOT_USER_ID)
  if (!seat || !marker) return jsonResponse({ ok: false, reason: 'not_ready' })

  const now = Date.now()
  const pause = pauseInfoAt(room, now)
  const phase = battlePhaseAt(marker.created_at, now, matchTimings({
    starting_seconds: room.starting_seconds ?? undefined,
    prep_seconds: room.prep_seconds ?? undefined,
  }), pause)
  if (!phase || pause.stopped || phase.phase !== 'match') return jsonResponse({ ok: true, waiting: 'clock' })
  const elapsed = Math.floor(phase.matchElapsed)
  if (room.bot_next_s !== null && elapsed < room.bot_next_s) return jsonResponse({ ok: true, next: room.bot_next_s })

  // One captain per person on the biggest fleet it faces - pace is per captain.
  const crewSizes = new Map<number, number>()
  for (const p of roster) {
    if (p.team === null || p.user_id === BOT_USER_ID) continue
    crewSizes.set(p.team, (crewSizes.get(p.team) ?? 0) + 1)
  }
  const crew = Math.max(1, ...crewSizes.values())

  // Fired at every other fleet, the way a person's shot is (see sendAttack and auto-fire).
  const defenders = activeTeams(roster).filter((t) => t !== team)
  if (defenders.length === 0) return jsonResponse({ ok: true, waiting: 'no_opponents' })

  const cells = room.board_size * room.board_size
  const board = bossBoard(room.id, room.square_set ?? DEFAULT_SET, cells, room.seed, room.board_perm, room.seed_set_at)
  const world: CrewWorld | null = board
    ? { tier, routes: botRoutes as unknown as BotRoutes, shared: bossPrereqs as Record<string, unknown>, board: board.squares, lookup: (n) => byName.get(n) }
    : null
  const asCrew = world !== null && crewReady(world)
  const random = Math.random

  let firing: number[] = []
  let next: number
  let state: CrewState | null = room.bot_state

  if (asCrew) {
    const known = await knowledge(room, tier, team, defenders)
    const turn = {
      fired: new Set(known.shots.map((s) => s.cell)),
      aim: aimWeights({ tier, boardSize: room.board_size, shipDefs: room.ship_defs, shots: known.shots, defenders: known.defenders }),
      random,
    }
    // The first turn of a match only sets the captains off; their first kills come after a real
    // run's opening, twenty-odd minutes in (see openingSeconds).
    if (!state || state.v !== 1) {
      state = newCrew(world!, crew, turn)
      for (const c of state.captains) c.at = Math.max(c.at, elapsed)
    } else {
      firing = playCrew(state, world!, turn, elapsed)
    }
    next = crewDue(state)
  } else if (room.bot_next_s === null) {
    // The plain bot: the first call books the first shot at a real crew's opening. Never in the past:
    // a driver whose tab only opened late gets a bot that starts now, not one that fires a backlog.
    next = Math.max(elapsed, openingSeconds(tier, crew, random))
  } else {
    const known = await knowledge(room, tier, team, defenders)
    firing = chooseShots({
      tier,
      boardSize: room.board_size,
      shipDefs: room.ship_defs,
      shots: known.shots,
      defenders: known.defenders,
      cost: board?.cost ?? null,
      matchElapsed: elapsed,
      random,
    })
    next = elapsed + nextGapSeconds(tier, crew, random)
  }

  // Claim the turn. Whoever moves bot_next_s on is the one who fires; everyone else gets nothing. The
  // crew's state rides in the same write, so it can never disagree with the shots it explains.
  const claimed = room.bot_next_s === null
    ? await sql`
        update public.rooms set bot_next_s = ${next}, bot_state = ${state ? sql.json(state as unknown as postgres.JSONValue) : null}
         where id = ${room.id} and bot_next_s is null and status = 'battle' returning id`
    : await sql`
        update public.rooms set bot_next_s = ${next}, bot_state = ${state ? sql.json(state as unknown as postgres.JSONValue) : null}
         where id = ${room.id} and bot_next_s = ${room.bot_next_s} and status = 'battle' returning id`
  if (claimed.length === 0) return jsonResponse({ ok: true, raced: true })

  const at = new Date(now).toISOString()
  const fired: number[] = []
  for (const cell of firing) {
    const inserted = (await sql`
      insert into public.attacks ${sql(defenders.map((defender_team) => ({
        room_id: room.id,
        cell_index: cell,
        attacker_team: team,
        defender_team,
        attacker_player_id: seat.id,
        created_at: at,
      })))}
      on conflict (room_id, attacker_team, defender_team, cell_index) do nothing
      returning id`) as unknown as { id: string }[]
    // Resolved here rather than left for a browser: every client would do it anyway, but the next
    // turn of the bot wants to know what this shot found.
    await Promise.all(inserted.map((row) => sql`select public.resolve_attack(${row.id}::uuid)`.catch(() => null)))
    fired.push(cell)
  }

  return jsonResponse({ ok: true, fired, next, crew: asCrew })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { roomId } = await req.json().catch(() => ({ roomId: null }))
    if (!roomId || typeof roomId !== 'string') return jsonResponse({ ok: false, reason: 'no_room' }, 400)

    const userId = callerId(req)
    if (!userId) return jsonResponse({ ok: false, reason: 'not_signed_in' }, 401)

    const [[room], [me]] = await Promise.all([
      rows<RoomRow>(sql`
        select id, status, board_size, ship_defs, square_set, seed, seed_set_at, board_perm,
               starting_seconds, prep_seconds, pause_at, resume_at, pause_log,
               bot_tier, bot_team, bot_next_s, bot_state
          from public.rooms where id = ${roomId}`),
      rows<{ id: string }>(sql`
        select id from public.players where room_id = ${roomId} and user_id = ${userId}`),
    ])
    if (!room) return jsonResponse({ ok: false, reason: 'no_room' }, 404)
    if (!me) return jsonResponse({ ok: false, reason: 'not_in_room' }, 403)
    if (!isBotTier(room.bot_tier) || room.bot_team === null) return jsonResponse({ ok: false, reason: 'no_bot' })

    if (room.status === 'placement') return await place(room, room.bot_team)
    if (room.status === 'battle') return await fire(room, room.bot_tier, room.bot_team)
    return jsonResponse({ ok: true, idle: room.status })
  } catch (err) {
    console.error('bot', err)
    return jsonResponse({ ok: false, reason: 'error' }, 500)
  }
})
