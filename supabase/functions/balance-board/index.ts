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
// no client can compute this, and no client should be trusted to, because this decides something
// both teams care about. Postgres and this function are the only participants who
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
import { buildFlatBoard, dealtPool } from '../../../src/lib/squareSetFormat.ts'
import { balanceBoard, scoreLayout, BEST_OF, DEFAULT_RULES, smallCrewFloor } from '../../../src/lib/boardBalance.ts'
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
 * The FLOOR is the only rule still particular to the small-crew cut, and it is a requirement rather
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

/**
 * How long one call spends drawing layouts, in milliseconds.
 *
 * An edge function is stopped at about two seconds of CPU, and a draw costs anywhere from about one
 * millisecond on a small board to two on a 14x14 there, so a draw count that fits one board size
 * overruns another. A clock fits them all. 1200 leaves the rest of the allowance for the boot, the
 * deal and the report; the search carries on in the next call - see BEST_OF.
 */
const DRAW_BUDGET_MS = 1200

/** A ceiling on draws per call, should the clock ever misbehave. Far above what the budget allows. */
const CALL_MAX_ATTEMPTS = 5000

/**
 * Which deal a pooled candidate belongs to: everything the layouts were scored against.
 *
 * The same seed on the same room is the same squares, and the same fleets are the same ships, so a
 * passer from any call with this key is a passer for this deal. A different key - the next match, a
 * re-placed fleet - starts the pool over. See balance_candidates.
 */
async function dealKey(
  room: { seed: string | null; seed_set_at: string | null; board_size: number },
  setId: string,
  fleets: Array<{ team: number; ships: number[][] }>
): Promise<string> {
  const text = JSON.stringify([room.seed, room.seed_set_at, setId, room.board_size, fleets])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
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
  seed: string | null,
  dealtAt: string | null
): { cost: number[]; regions: Array<string | null> } | null {
  // Cast kept as narrow as auto-fire's: buildFlatBoard returns Challenge[] whatever it is handed,
  // and it passes the very same objects through, so `region` is read off the RESULT - where it is
  // properly typed - rather than asserted onto the input.
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base))
  // Same pool challengesForRoom deals from - see dealtPool.
  const board = buildFlatBoard(dealtPool(BOSS_SETS[setId], dealtAt), cells, next)

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
    // `final` is the caller giving up on the pool: deal the fairest passer found so far, however
    // few. It cannot choose WHICH layout is dealt - only stop the search early - so a host sending
    // it at once gains nothing but a less fair board for everyone.
    //
    // `pool` is the caller saying it will call again on `searching`. A tab still running the site
    // from before the pool existed calls once and would read `searching` as a failure and start the
    // match unbalanced, so without it every call is the last one - the old single-call deal.
    const { roomId, final: finalAsked, pool: poolAsked } = await req.json().catch(() => ({ roomId: null }))
    if (!roomId || typeof roomId !== 'string') {
      return jsonResponse({ balanced: false, reason: 'no_room' }, 400)
    }
    const final = finalAsked === true || poolAsked !== true

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
      .select('id, board_size, square_set, seed, seed_set_at, status, board_perm')
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

    // Ordered by team, which costs nothing and makes every array derived from these rows - the cost
    // profiles, topCost - line up with the team numbers rather than with whatever order the table
    // happened to return. The direction below no longer depends on that order, but anything reading
    // topCost positionally still does.
    const { data: fleetRows } = await admin
      .from('fleets')
      .select('team, ship_grid, ship_index_grid, placement_confirmed')
      .eq('room_id', roomId)
      .order('team')
    const fleets = (fleetRows ?? []).filter((f) => teams.includes(f.team))

    // Every hull still has to be final. Balancing against a fleet that can still move is balancing
    // against nothing, and the captain would then be laying ships against a board already dealt to
    // where they used to be.
    if (fleets.length < teams.length || fleets.some((f) => !f.placement_confirmed)) {
      return jsonResponse({ balanced: false, reason: 'fleets_not_confirmed' })
    }

    const cells = room.board_size * room.board_size
    const deal = boardCost(room.id, setId, cells, room.seed, room.seed_set_at)
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
    //
    // Stopped on the clock rather than on a draw count - see DRAW_BUDGET_MS.
    const drawStart = performance.now()
    const result = balanceBoard({
      cost: deal.cost,
      regions: deal.regions,
      boardSize: room.board_size,
      fleets: occupied,
      next: rng(seedFrom(crypto.randomUUID())),
      rules: { ...rulesFor(setId, room.board_size), maxAttempts: CALL_MAX_ATTEMPTS },
      stop: () => performance.now() - drawStart > DRAW_BUDGET_MS,
    })

    // Two conditions, and the second one matters more than it looks.
    //
    // `board_perm is null` is the last word on two hosts racing, decided by the database rather
    // than by us. `status = placement` is the last word on the CLOCK: startBattle gives up waiting
    // eventually (see BALANCE_SEARCH_MS) and flips the room to battle, and without this guard a slow run
    // could land its permutation after that - re-dealing every square under players who were
    // already looking at the board, and invalidating any shot already taken. The room having moved
    // on is a perfectly ordinary outcome and the right response is to drop the layout on the floor.
    // -- what the balancer knew ---------------------------------------------------------------
    //
    // Everything below was already computed above and used to be returned to the caller and dropped.
    // Stored now, because the alternative is balance-stats re-deriving it from the archive later at
    // about 400ms a match - a full re-deal and a fresh rejection sample to recover numbers that are
    // sitting in `result` right here. See the match_balance migration.
    //
    // `topCost` needs one extra pass, and it is the cheap kind: scoreLayout only prices the fleets
    // against a cost array, with no sampling. It is the slowest square gating each fleet's slowest
    // ship - which is what says a fleet was holding a hull that could not have been sunk in the time
    // the match actually ran. That comparison needs a duration, which does not exist yet at deal
    // time, so the number is stored and the recap makes the comparison once the match has ended.
    const playedCost = result.perm.map((from) => deal.cost[from])
    const playedScore = scoreLayout(playedCost, occupied)
    const topCost = playedScore.profiles.map((profile) => profile[0] ?? 0)

    const balanceReport = {
      v: 1,
      source: 'deal',
      // Seconds. The widest same-rank gap between two fleets, in the seeded deal and as played.
      dealt: Math.round(result.rankGapBefore),
      played: Math.round(result.rankGapAfter),
      limit: result.rankLimit,
      // Which fleet the gap above was in favour of, on the board as played.
      //
      // The gap itself is a spread and says only how wide the edge was; this is the fleet that held
      // the cheapest ship at the rank the spread was worst at, and its opposite number. Taken from
      // the same scoreLayout pass that produced topCost, so it is a fact about the same board the
      // `played` number measures - not a second opinion from a different measurement.
      //
      // Null on a board with no gap at all, which is a real outcome and not a missing value.
      aheadTeam: playedScore.aheadTeam,
      behindTeam: playedScore.behindTeam,
      // Seconds. The third test, on the other end of every ship - how far apart the two fleets are
      // on when their ships get FOUND rather than on when they get cleared. Stored separately for
      // the same reason as the long-square gap, and with a sharper case: over the archive the two
      // ends of a ship correlate at r = 0.192, so this number regularly disagrees with `played`
      // about which board was lopsided and which side it favoured. See FIND_GAP_SECONDS.
      findDealt: Math.round(result.findGapBefore),
      findPlayed: Math.round(result.findGapAfter),
      findLimit: result.findLimit,
      // The fleet that stayed hidden longest at the worst find rank, and the one found soonest.
      // Deliberately not assumed to agree with aheadTeam/behindTeam above - see scoreLayout.
      findAheadTeam: playedScore.findAheadTeam,
      findBehindTeam: playedScore.findBehindTeam,
      // Whole squares. The second test, on the cells the rank gap throws away - how many more
      // squares past the long-square line the worst-off fleet held, dealt and as played. Stored
      // beside the rank gap rather than folded into it because a board can pass one and fail the
      // other, which is why the second test exists at all. See LONG_GAP in boardBalance.ts.
      longDealt: result.longGapBefore,
      longPlayed: result.longGapAfter,
      longLimit: result.longLimit,
      attempts: result.attempts,
      accepted: result.accepted,
      // How many passing layouts the board was chosen from, and how fair the chosen one is - see
      // BEST_OF. Overwritten with the pooled totals below when the search ran over several calls.
      passers: result.passers,
      bestOf: BEST_OF,
      fairness: Math.round(result.fairness * 1000) / 1000,
      teams: occupied.length,
      clumpBefore: result.clumpBefore,
      clumpAfter: result.clumpAfter,
      regionLow: result.regionLow,
      topCost: topCost.map((c) => Math.round(c)),
      at: new Date().toISOString(),
    }

    // -- the pool ------------------------------------------------------------------------------
    // Two-team boards collect BEST_OF passers before one is played, and that is more draws than one
    // call can afford, so every call adds what it found to the room's pool and the call that brings
    // the pool to BEST_OF deals the fairest passer in it. startBattle keeps calling - two at a time -
    // while this answers `searching`. See balance_candidates.
    //
    // Boards with three or four fleets rarely find even one passer (see balancing.md), so they keep
    // the old single call: the fairest passer this call found, or the fairest miss if none passed.
    // So does the caller's last call (`final`), which plays the fairest passer pooled so far.
    //
    // If the pool cannot be reached - the migration not yet applied, say - this call's own result is
    // played, which is exactly how a board was dealt before the pool existed.
    let perm = result.perm
    let report: Record<string, unknown> = balanceReport
    if (occupied.length === 2) {
      const { data: pool, error: poolErr } = await admin.rpc('merge_balance_candidate', {
        p_room: room.id,
        p_key: await dealKey(room, setId, occupied),
        p_perm: result.perm,
        p_score: result.fairness,
        p_report: balanceReport,
        p_passers: result.accepted ? result.passers : 0,
        p_attempts: result.attempts,
      })
      if (poolErr) {
        console.warn('balance-board: pool unavailable, dealing this call alone', poolErr.message)
      } else {
        if (pool.passers < BEST_OF && !final) {
          return jsonResponse({ balanced: false, reason: 'searching', passers: pool.passers, attempts: pool.attempts })
        }
        const totals = { passers: pool.passers, attempts: pool.attempts, calls: pool.calls }
        if (pool.perm) {
          perm = pool.perm
          report = { ...pool.report, ...totals }
        } else {
          // The last call, and nothing passed in any of them: the fairest miss this one saw.
          report = { ...balanceReport, ...totals }
        }
      }
    }

    // Two conditions, and the second one matters more than it looks - see the note above the record.
    const { data: written, error } = await admin
      .from('rooms')
      .update({ board_perm: perm, balance_report: report })
      .eq('id', roomId)
      .eq('status', 'placement')
      .is('board_perm', null)
      .select('id')
    if (error) return jsonResponse({ balanced: false, reason: 'write_failed' }, 500)
    if (!written?.length) return jsonResponse({ balanced: false, reason: 'too_late' })

    // Dealt: the pool has done its job. Best-effort - a row left behind is started over by the next
    // deal (its key will not match) and goes with the room either way.
    if (occupied.length === 2) await admin.from('balance_candidates').delete().eq('room_id', room.id)

    // The record as stored. `accepted` false means nothing in the whole search met the rules and
    // this is the fairest miss; `passers` is how many layouts the board was chosen from.
    return jsonResponse({ balanced: result.balanced, ...report })
  } catch (err) {
    console.error('balance-board', err)
    // Still a 200-shaped refusal rather than a throw: the caller awaits this inside a room start.
    return jsonResponse({ balanced: false, reason: 'error' }, 500)
  }
})
