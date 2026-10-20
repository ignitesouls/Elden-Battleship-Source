// Draws the seed for an official match, so its boss pool passes the official cutoff for its board.
//
// The seed decides two things: the Elden Ring randomizer world every player loads, and - with the
// room id - which bosses the board deals. The balancer arranges those bosses after placement but
// cannot change which ones are in play. An official match is dealt only from pools under the
// cutoff (see src/lib/officialPool.ts for what that buys), and the seed has to come from here
// rather than from a browser, for the same reason balance-board's salt does: a seed a player picks
// is a pool a player picks. Any seated player can write rooms, the deal is computable in a browser,
// and an unguarded official lobby let someone reroll until the bosses suited them.
//
// -- How it fits with the database ----------------------------------------------------------------
//
// `rooms.official_seed` records the seed this function vetted. guard_official_room refuses an
// official boss room leaving the lobby unless `official_seed = seed`, refuses any browser writing
// official_seed, and refuses a browser rerolling the seed of an official lobby. Every other write
// that changes the seed, the board size or the square set clears official_seed - so the reset into
// the next game of a series, which rolls a fresh seed from the host's browser, leaves that game's
// lobby waiting for this function again. See 20261020020000_official_seed.sql.
//
// Every refusal is a 200 with a reason, never a throw, like balance-board: the lobby calls this on
// its own and has to be able to say why it did not work.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { rng, seedFrom } from '../../../src/lib/seededRandom.ts'
import { buildFlatBoard, dealtPool } from '../../../src/lib/squareSetFormat.ts'
import { effectiveCosts } from '../../../src/lib/prereqCost.ts'
import { generateSeed } from '../../../src/lib/roomCode.ts'
import {
  OFFICIAL_SEED_BUDGET,
  cutoffFor,
  poolSpread,
  type PoolCutoffTable,
} from '../../../src/lib/officialPool.ts'
import bossData from '../../../src/data/battleshipChallenges.json' with { type: 'json' }
import bossData2v2 from '../../../src/data/battleshipChallenges2v2.json' with { type: 'json' }
import bossCost from '../../../src/data/bossTimeCost.json' with { type: 'json' }
import bossPrereqs from '../../../src/data/bossPrereqs.json' with { type: 'json' }
import cutoffTable from '../../../src/data/officialPoolCutoffs.json' with { type: 'json' }

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

/** The two boss cuts - the only sets with costs, and the same two balance-board works on. */
const BOSS_SETS: Record<string, { name: string; tooltip?: string }[]> = {
  'bosses': bossData,
  'bosses-2v2': bossData2v2,
}
const DEFAULT_SET = 'bosses'

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
 * One candidate seed's pool, as time cost per cell - balance-board's boardCost with the seed
 * passed in, and the copy for the same reason that one is a copy of challengesForRoom. Null if any
 * square has no cost, which the cutoff table's own check rules out for every set it covers.
 */
function poolCost(roomId: string, setId: string, cells: number, seed: string, dealtAt: string): number[] | null {
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`
  const board = buildFlatBoard(dealtPool(BOSS_SETS[setId], dealtAt), cells, rng(seedFrom(`${base}:${seed}`)))
  const cost: number[] = []
  for (const square of board) {
    const r = costFor.get(square?.tooltip ?? '')
    if (r === undefined) return null
    cost.push(r)
  }
  return effectiveCosts(board, cost, bossPrereqs as Record<string, unknown>, costByName)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { roomId } = await req.json().catch(() => ({ roomId: null }))
    if (!roomId || typeof roomId !== 'string') {
      return jsonResponse({ vetted: false, reason: 'no_room' }, 400)
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData } = await caller.auth.getUser()
    const userId = userData?.user?.id
    if (!userId) return jsonResponse({ vetted: false, reason: 'not_signed_in' }, 401)

    const { data: me } = await admin
      .from('players')
      .select('is_host')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!me?.is_host) return jsonResponse({ vetted: false, reason: 'not_host' }, 403)

    const { data: room } = await admin
      .from('rooms')
      .select('id, board_size, square_set, seed, status, tournament_match_id, official_seed')
      .eq('id', roomId)
      .maybeSingle()
    if (!room) return jsonResponse({ vetted: false, reason: 'no_room' }, 404)
    if (!room.tournament_match_id) return jsonResponse({ vetted: false, reason: 'not_official' })
    if (room.status !== 'lobby') return jsonResponse({ vetted: false, reason: 'not_lobby' })

    const setId = room.square_set ?? DEFAULT_SET
    if (!BOSS_SETS[setId]) return jsonResponse({ vetted: false, reason: 'unsupported_square_set' })

    // Idempotent: a second call, a remount or a second host tab must not re-deal a pool everyone
    // has already set their game up against. It is also what stops this being a way to fish: the
    // seed of a vetted lobby is locked, so there is only ever one draw per game.
    if (room.seed && room.official_seed === room.seed) {
      return jsonResponse({ vetted: true, already: true, seed: room.seed })
    }

    const cutoff = cutoffFor(cutoffTable as PoolCutoffTable, setId, room.board_size)
    if (cutoff === null) return jsonResponse({ vetted: false, reason: 'no_cutoff' })

    // The deal date the trigger is about to stamp, give or take the write: it decides whether a
    // square released after some date is in the pool, so the pool is scored as it will be dealt.
    const dealtAt = new Date().toISOString()
    const cells = room.board_size * room.board_size

    let best: { seed: string; spread: number } | null = null
    let attempts = 0
    while (attempts < OFFICIAL_SEED_BUDGET) {
      attempts++
      const seed = generateSeed()
      const cost = poolCost(room.id, setId, cells, seed, dealtAt)
      if (!cost) return jsonResponse({ vetted: false, reason: 'missing_reach_data' })
      const spread = poolSpread(cost)
      if (!best || spread < best.spread) best = { seed, spread }
      if (spread <= cutoff) break
    }
    // Not expected to happen at all (see OFFICIAL_SEED_BUDGET); if it does, the most even pool of
    // the whole budget is still a very even one, and refusing would leave the match unstartable.
    const chosen = best!

    // Conditional on everything the draw depended on, so a reroll, a settings change or the match
    // starting in between drops this on the floor rather than vetting a pool for a different board.
    let write = admin
      .from('rooms')
      .update({ seed: chosen.seed, official_seed: chosen.seed })
      .eq('id', room.id)
      .eq('status', 'lobby')
      .eq('board_size', room.board_size)
      .not('tournament_match_id', 'is', null)
    write = room.seed === null ? write.is('seed', null) : write.eq('seed', room.seed)
    write = room.square_set === null ? write.is('square_set', null) : write.eq('square_set', room.square_set)
    const { data: written, error } = await write.select('id')
    if (error) return jsonResponse({ vetted: false, reason: 'write_failed' }, 500)
    if (!written?.length) return jsonResponse({ vetted: false, reason: 'room_changed' })

    return jsonResponse({
      vetted: true,
      seed: chosen.seed,
      // Seconds. The pool's spread and the line it had to be under.
      spread: Math.round(chosen.spread),
      cutoff,
      attempts,
      accepted: chosen.spread <= cutoff,
    })
  } catch (err) {
    console.error('official-seed', err)
    return jsonResponse({ vetted: false, reason: 'error' }, 500)
  }
})
