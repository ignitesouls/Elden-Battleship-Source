// Finishes dealing the board, once both fleets are down and neither can move again.
//
// Every team fires at the SAME named grid, so which bosses land on which fleet's cells is the entire
// competitive asymmetry of a match. Until now that was struck from a seed before anyone had placed a
// ship: a fleet parked on squares nobody ever reaches is close to unsinkable, and nobody chose that.
//
// So the deal is finished here instead. The squares stay exactly the squares the seed chose - this
// only permutes their positions. It does that by drawing whole layouts at random and testing them,
// keeping the first that is not lopsided, rather than by searching toward a target: see
// src/lib/boardBalance.ts for why that distinction is the point rather than an implementation
// detail.
//
// -- Why this is an edge function and not a database function ------------------------------------
//
// Same reason auto-fire is. Boards are a pure function of room id, square set and seed that every
// client re-derives, and the only place that can import the real derivation is here. Reimplementing
// a seeded shuffle in plpgsql would create a second source of truth, and the failure mode when it
// eventually disagreed would be a permutation indexed against a board nobody else is looking at.
//
// -- Why it has to be server-side at all ---------------------------------------------------------
//
// It reads every fleet. `fleets` RLS gives a client its own team and nothing else, deliberately, so
// no client can compute this - and no client should be trusted to, since the whole point is to
// decide something both teams care about. Postgres and this function are the only participants who
// can see both sides. Precedent: roll_deep_water, which picks hiding places the same way at the
// same moment for the same reason.
//
// -- What it refuses to do -----------------------------------------------------------------------
//
// Only the boss board, either cut of it - the objective sets have no time-cost data and would be
// guessed at. Only the host of the room. Only during placement, with every fleet confirmed and
// nothing yet fired. Only once. Every refusal is a 200 with a reason, never a throw: startBattle
// awaits this, and a room that cannot start is a far worse outcome than a room with an unbalanced
// board.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { rng, seedFrom } from '../../../src/lib/seededRandom.ts'
import { buildFlatBoard } from '../../../src/lib/squareSetFormat.ts'
import { balanceBoard, DEFAULT_RULES, smallCrewFloor } from '../../../src/lib/boardBalance.ts'
import { activeTeams } from '../../../src/lib/battleshipLogic.ts'
import bossData from '../../../src/data/battleshipChallenges.json' with { type: 'json' }
import bossData2v2 from '../../../src/data/battleshipChallenges2v2.json' with { type: 'json' }
import bossCost from '../../../src/data/bossTimeCost.json' with { type: 'json' }
import bossPrereqs from '../../../src/data/bossPrereqs.json' with { type: 'json' }
import { effectiveCosts } from '../../../src/lib/prereqCost.ts'

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

/**
 * The square sets this works for, and the squares each one deals. Anything else is refused rather
 * than approximated.
 *
 * Both are cuts of the boss board - see squareSets.ts. The cost table below covers the
 * smaller one for free, because it is keyed by tooltip and the smaller set is a strict subset: every
 * square in it already has a measured number, drawn from the same archive.
 */
const BOSS_SETS: Record<string, { name: string; tooltip?: string }[]> = {
  'bosses': bossData,
  'bosses-2v2': bossData2v2,
}

/** `null` is a room from before square sets, which is the default set. */
const DEFAULT_SET = 'bosses'

/**
 * The tests a board on this set is held to, and the region those tests are about.
 *
 * `dlc` is named here rather than inside the balancer because the balancer treats region strings as
 * opaque - it spreads out and prices whatever the board says belongs together, and which region is
 * the gated one is a fact about Elden Ring rather than about balancing. This is the layer that
 * knows both.
 *
 * Every board gets the same threshold - see RANK_GAP_SECONDS for why it stopped being loose, and
 * why it is one number rather than a pair scaled by fleet size.
 *
 * The FLOOR is the one thing still particular to the small-crew cut. It is a requirement rather
 * than a price: requiring a full crew to split its attention across the DLC is a rule about how to
 * play, whereas a crew of two that never has to go there at all is a board its opponents did not
 * get. See squareSets.ts for how a room comes to be on that set.
 */
function rulesFor(setId: string, boardSize: number) {
  return {
    ...DEFAULT_RULES,
    regionFloor: setId === 'bosses-2v2' ? smallCrewFloor('dlc', boardSize) : null,
  }
}

/** tooltip -> expected seconds of a match before that square is done. See build-time-cost.mjs. */
const costFor = new Map<string, number>()
for (const [tooltip, r] of Object.entries(bossCost as Record<string, unknown>)) {
  if (tooltip.startsWith('_')) continue // `_comment`, per the convention the other data files use
  costFor.set(tooltip, r as number)
}

/**
 * The same numbers keyed by square NAME, which is how bossPrereqs.json refers to squares.
 *
 * Two keys for one table because the two files are written for different readers: everything
 * generated is keyed by tooltip, which is unique and stable, while the hand-authored prerequisites
 * are keyed by the name a person reads off the board.
 */
const costByName: Record<string, number> = {}
for (const set of Object.values(BOSS_SETS)) {
  for (const square of set) {
    const c = costFor.get(square.tooltip ?? '')
    if (c !== undefined) costByName[square.name] = c
  }
}

/**
 * The room's board as time cost per cell, in seeded order.
 *
 * Mirrors challengesForRoom()'s seeding, which cannot be imported here because the square-set
 * registry binds a dozen JSON files - the same duplication auto-fire carries, for the same reason.
 * Both branches of that seeding are live now that a boss room can be on either cut of the board:
 * the default set seeds from the bare room id, every other set from `roomId:setId`. A set id left
 * out of the base balances a board nobody is playing.
 *
 * Returns null if any square has no cost. A missing number would read as the cheapest square in the
 * game and quietly understate whichever fleet was sitting on it, which is worse than not balancing
 * at all.
 */
function boardCost(
  roomId: string,
  setId: string,
  cells: number,
  seed: string | null
): { cost: number[]; regions: Array<string | null> } | null {
  // Cast kept as narrow as auto-fire's: buildFlatBoard returns Challenge[] whatever it is handed,
  // and it passes the very same objects through, so `region` is read off the RESULT - where it is
  // properly typed - rather than asserted onto the input.
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base))
  const board = buildFlatBoard(BOSS_SETS[setId], cells, next)

  const cost: number[] = []
  const regions: Array<string | null> = []
  for (const square of board) {
    const r = costFor.get(square?.tooltip ?? '')
    if (r === undefined) return null
    cost.push(r)
    // Missing regions are survivable in a way a missing cost is not: a square with no region
    // simply never counts as clumped with anything, which is a slightly weaker spread rather than a
    // wrong one.
    regions.push(square?.region ?? null)
  }

  // Discount the squares whose gate this deal happens to have put on the board beside them. Reads
  // the board and nothing else - no fleet, no placement - so it is as safe to condition on as the
  // declumping pass. See prereqCost.ts for why it is a discount rather than a surcharge.
  const adjusted = effectiveCosts(board, cost, bossPrereqs as Record<string, unknown>, costByName)
  return { cost: adjusted, regions }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { roomId } = await req.json().catch(() => ({ roomId: null }))
    if (!roomId || typeof roomId !== 'string') {
      return jsonResponse({ balanced: false, reason: 'no_room' }, 400)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // -- who is asking -----------------------------------------------------------------------
    // The caller's own token, not the service key, so this identifies a real signed-in player
    // rather than trusting an id in the body.
    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData } = await caller.auth.getUser()
    const userId = userData?.user?.id
    if (!userId) return jsonResponse({ balanced: false, reason: 'not_signed_in' }, 401)

    const { data: me } = await admin
      .from('players')
      .select('is_host')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!me?.is_host) return jsonResponse({ balanced: false, reason: 'not_host' }, 403)

    // -- is this the moment ------------------------------------------------------------------
    const { data: room } = await admin
      .from('rooms')
      .select('id, board_size, square_set, seed, status, board_perm')
      .eq('id', roomId)
      .maybeSingle()
    if (!room) return jsonResponse({ balanced: false, reason: 'no_room' }, 404)

    // `null` is the default set. Anything that is not a cut of the boss board is refused - see the
    // header.
    const setId = room.square_set ?? DEFAULT_SET
    if (!BOSS_SETS[setId]) {
      return jsonResponse({ balanced: false, reason: 'unsupported_square_set' })
    }
    if (room.status !== 'placement') {
      return jsonResponse({ balanced: false, reason: 'not_placement' })
    }
    // Idempotent: a retry, a double-click or two hosts racing must not re-deal a board somebody is
    // already looking at.
    if (room.board_perm) return jsonResponse({ balanced: false, reason: 'already_balanced' })

    // Never mid-match. Nothing below could tell a fired square from an unfired one, and rearranging
    // the board under a shot already taken would change what that shot hit.
    const { count: shots } = await admin
      .from('attacks')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', roomId)
      .gte('cell_index', 0)
    if ((shots ?? 0) > 0) return jsonResponse({ balanced: false, reason: 'already_fired' })

    // -- the fleets --------------------------------------------------------------------------
    const { data: roster } = await admin.from('players').select('team').eq('room_id', roomId)
    const teams = activeTeams(roster ?? [])
    if (teams.length < 2) return jsonResponse({ balanced: false, reason: 'not_enough_teams' })

    const { data: fleetRows } = await admin
      .from('fleets')
      .select('team, ship_grid, ship_index_grid, placement_confirmed')
      .eq('room_id', roomId)
    const fleets = (fleetRows ?? []).filter((f) => teams.includes(f.team))

    // Every hull still has to be final. Balancing against a fleet that can still move is balancing
    // against nothing, and the captain would then be laying ships against a board already dealt to
    // where they used to be.
    if (fleets.length < teams.length || fleets.some((f) => !f.placement_confirmed)) {
      return jsonResponse({ balanced: false, reason: 'fleets_not_confirmed' })
    }

    const cells = room.board_size * room.board_size
    const deal = boardCost(room.id, setId, cells, room.seed)
    if (!deal) return jsonResponse({ balanced: false, reason: 'missing_reach_data' })

    // Each fleet as its SHIPS, not as a flat list of cells - which is the whole fairness test, since
    // a ship is only sunk once every one of its cells is fired at and therefore costs whatever its
    // slowest square costs. See BalanceInput.fleets.
    //
    // `ship_index_grid` carries which hull owns each cell, so the ships come straight back out of
    // it. `ship_grid` alone could not do this: it says a cell is occupied and nothing about which
    // of five hulls occupies it, so two ships lying end to end would read as one long one and a
    // five-cell Carrier gated by one cold square would be scored as if that square gated nothing.
    // A fleet whose index grid is missing or the wrong length falls back to one cell per ship,
    // which prices every cell as its own hull - conservative, and never silently merges two.
    const occupied = fleets.map((f) => {
      const grid = Array.isArray(f.ship_grid) ? f.ship_grid : []
      const idx = Array.isArray(f.ship_index_grid) ? f.ship_index_grid : []
      const byShip = new Map<number, number[]>()
      const loose: number[][] = []
      for (let c = 0; c < cells; c++) {
        if (grid[c] !== true) continue
        const ship = idx.length === cells ? idx[c] : null
        if (typeof ship === 'number' && ship >= 0) {
          if (!byShip.has(ship)) byShip.set(ship, [])
          byShip.get(ship)!.push(c)
        } else {
          loose.push([c])
        }
      }
      return { team: f.team, ships: [...byShip.values(), ...loose] }
    })

    // -- deal --------------------------------------------------------------------------------
    // A fresh random salt, never stored and never derived from anything public. If it came from the
    // room id or the seed, both of which any player can read, a team could compute the balanced
    // board for themselves during placement - which is the exact thing this exists to prevent.
    const result = balanceBoard({
      cost: deal.cost,
      regions: deal.regions,
      boardSize: room.board_size,
      fleets: occupied,
      next: rng(seedFrom(crypto.randomUUID())),
      rules: rulesFor(setId, room.board_size),
    })

    // Two conditions, and the second one matters more than it looks.
    //
    // `board_perm is null` is the last word on two hosts racing, decided by the database rather
    // than by us. `status = placement` is the last word on the CLOCK: startBattle gives up waiting
    // after BALANCE_TIMEOUT_MS and flips the room to battle, and without this guard a slow run
    // could land its permutation after that - re-dealing every square under players who were
    // already looking at the board, and invalidating any shot already taken. The room having moved
    // on is a perfectly ordinary outcome and the right response is to drop the layout on the floor.
    const { data: written, error } = await admin
      .from('rooms')
      .update({ board_perm: result.perm })
      .eq('id', roomId)
      .eq('status', 'placement')
      .is('board_perm', null)
      .select('id')
    if (error) return jsonResponse({ balanced: false, reason: 'write_failed' }, 500)
    if (!written?.length) return jsonResponse({ balanced: false, reason: 'too_late' })

    return jsonResponse({
      balanced: result.balanced,
      // On the default profile `attempts: 1` is the ordinary answer and means the fairness test
      // never bound - the layout being played was chosen without reference to anyone's ships, and
      // anything higher is a board that would have been lopsided. On the small-crew profile the
      // tests bind on nearly every board and the median is around thirty, so what is worth watching
      // there is `accepted` and `regionLow` instead: accepted false means no layout in 300 draws
      // met the rules and this is the fairest of them.
      attempts: result.attempts,
      accepted: result.accepted,
      // Seconds. The widest same-rank gap between two fleets' ship profiles, before and after.
      rankGapBefore: Math.round(result.rankGapBefore),
      rankGapAfter: Math.round(result.rankGapAfter),
      rankLimit: result.rankLimit,
      // Null on the default profile. Otherwise the fewest dlc squares any one fleet holds - below
      // the floor means the board could not carry it, which is the honest way that reads.
      regionLow: result.regionLow,
      clumpBefore: result.clumpBefore,
      clumpAfter: result.clumpAfter,
      teams: occupied.length,
    })
  } catch (err) {
    console.error('balance-board', err)
    // Still a 200-shaped refusal rather than a throw: the caller awaits this inside a room start.
    return jsonResponse({ balanced: false, reason: 'error' }, 500)
  }
})
