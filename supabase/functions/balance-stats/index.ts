/**
 * Scores archived matches against the current balance model, a few at a time.
 *
 * -- Why this is a function and not a page ---------------------------------------------------------
 *
 * The obvious build is to do this in the Admin page. That is what the previous explainer did, and it
 * is why the previous explainer was deleted: a Vite chunk is a static file. `Admin-<hash>.js` sits on
 * GitHub Pages and anybody can fetch it without signing in - the admin check runs in the browser
 * AFTER the chunk has loaded, so it gates what is rendered and not what is downloaded. Importing
 * bossTimeCost.json there publishes the entire cost model, which is the one input a player could use
 * to work out which squares the balancer thinks are expensive, and therefore where hulls are least
 * likely to be. The previous balancer was metagamed inside a season; that is not a theoretical worry.
 *
 * So the cost table stays server-side. What crosses the wire is one row per match - gaps in seconds -
 * and it crosses to an authenticated admin over the API, which is a different thing from a static
 * file anyone can GET. No square is ever named and no per-square cost is ever sent.
 *
 * -- Why it is paged ------------------------------------------------------------------------------
 *
 * The first version scored the whole archive in one request and was killed with a 546: Supabase caps
 * CPU per invocation at around two seconds, and this does the most expensive thing in the codebase.
 * Scoring one match means a full `balanceBoard` run - rejection sampling, up to MAX_ATTEMPTS draws,
 * about 400ms on a 10x10 - so four matches is already the whole budget and seventy is hopeless.
 *
 * Hence two modes. `index` lists what could be scored, which is cheap. `score` takes a handful of
 * match keys and does only those, fetching only their events. The client walks the index in small
 * slices and adds up the results, which also means it can show progress instead of stalling.
 *
 * Aggregation deliberately happens on the client. It is pure arithmetic over the rows below, it needs
 * no secret, and doing it here would mean either recomputing every total on every slice or keeping
 * state between invocations.
 *
 * -- What a row measures --------------------------------------------------------------------------
 *
 * Three gaps per match, all in seconds, all the rank-by-rank measure the balancer accepts on:
 *
 *   dealt       the raw seeded deal, before anything touched it
 *   played      the board as the match was actually played, archived perm applied
 *   rebalanced  what the CURRENT balancer would have produced from that same deal
 *
 * `dealt` against `played` says what the balancer of the day actually achieved. `dealt` against
 * `rebalanced` says what today's balancer would achieve on the same material. The second is the only
 * honest before/after, because it holds the deal fixed and changes nothing but the balancer.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { rng, seedFrom } from '../../../src/lib/seededRandom.ts'
import { buildFlatBoard, type Challenge } from '../../../src/lib/squareSetFormat.ts'
import {
  balanceBoard,
  scoreLayout,
  DEFAULT_RULES,
  smallCrewFloor,
  RANK_GAP_SECONDS,
} from '../../../src/lib/boardBalance.ts'
import { effectiveCosts } from '../../../src/lib/prereqCost.ts'
import bossData from '../../../src/data/battleshipChallenges.json' with { type: 'json' }
import bossData2v2 from '../../../src/data/battleshipChallenges2v2.json' with { type: 'json' }
import bossCost from '../../../src/data/bossTimeCost.json' with { type: 'json' }
import bossPrereqs from '../../../src/data/bossPrereqs.json' with { type: 'json' }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * The most matches one `score` call will accept.
 *
 * Four full balanceBoard runs is already about the CPU budget, so this is a ceiling and not a
 * target - the client normally asks for fewer, and drops to one after a 546. Refused rather than
 * silently truncated: a caller that asked for thirty and got three would quietly skip the rest.
 */
const MAX_SLICE = 6

const DEFAULT_SET = 'bosses'
// Declared WITHOUT `region`, exactly as balance-board declares it. buildFlatBoard passes the very
// same objects through, so region is read off the RESULT - where it is properly typed as Region -
// rather than asserted onto the input, where a bare `string` would not match the union.
const BOSS_SETS: Record<string, { name: string; tooltip?: string }[]> = {
  bosses: bossData,
  'bosses-2v2': bossData2v2,
}

/** The same two keyings balance-board builds, and for the same reason. See its notes. */
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

function rulesFor(setId: string, boardSize: number) {
  return {
    ...DEFAULT_RULES,
    regionFloor: setId === 'bosses-2v2' ? smallCrewFloor('dlc', boardSize) : null,
  }
}

/**
 * The board a room dealt, optionally with an archived permutation applied.
 *
 * Mirrors challengesForRoom(): the full boss set seeds from the bare room id and every other set
 * from `roomId:setId`. Changing that would re-deal every board in play and strand every archived
 * match, so it is copied rather than improved.
 */
function dealBoard(
  roomId: string,
  setId: string,
  cells: number,
  seed: string | null,
  perm: number[] | null
): Challenge[] {
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base))
  const board = buildFlatBoard(BOSS_SETS[setId], cells, next)
  if (Array.isArray(perm) && perm.length === cells) return perm.map((from) => board[from])
  return board
}

/** Cost and region per cell for a board, with the prerequisite discount applied. */
function costsOf(board: Challenge[]) {
  const cost: number[] = []
  const regions: Array<string | null> = []
  for (const square of board) {
    const c = costFor.get(square?.tooltip ?? '')
    if (c === undefined) return null
    cost.push(c)
    regions.push(square?.region ?? null)
  }
  const adjusted = effectiveCosts(board, cost, bossPrereqs as Record<string, unknown>, costByName)
  return { cost: adjusted, regions }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface ScoredMatch {
  matchKey: string
  boardSize: number
  setId: string
  teams: number
  durationSec: number
  hadPerm: boolean
  dealt: number
  played: number
  rebalanced: number
  /**
   * The same three boards measured on the second test instead: how many more squares past the
   * long-square line the worst-off fleet held. Whole squares, not seconds. See LONG_GAP.
   */
  longDealt: number
  longPlayed: number
  longRebalanced: number
  /** How many fleets held at least one ship gated longer than the match actually lasted. */
  strandedFleets: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // The caller's own token, so this is the signed-in person and not the service key. The same
    // shape balance-board uses to establish who is asking before deciding whether they may.
    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: userData } = await caller.auth.getUser()
    if (!userData?.user) return jsonResponse({ error: 'not_signed_in' }, 401)

    // is_admin() is security definer and reads auth.uid(), so asking through the CALLER's client is
    // what makes it answer about the caller. A claim in the request body would be worth nothing.
    const { data: isAdmin } = await caller.rpc('is_admin')
    if (!isAdmin) return jsonResponse({ error: 'not_admin' }, 403)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const body = (await req.json().catch(() => ({}))) as {
      mode?: string
      matchKeys?: unknown
      persist?: unknown
    }

    // -- index -----------------------------------------------------------------------------------
    // Keyed off match_fleets rather than match_events: a match with no archived placements can never
    // be scored, so listing it would only produce a rejection later. Two to four rows per match, so
    // this is a small read even across the whole archive.
    if (body.mode === 'index') {
      const keys = new Set<string>()
      for (let page = 0; page < 60; page++) {
        const { data, error } = await admin
          .from('match_fleets')
          .select('match_key')
          .range(page * 1000, page * 1000 + 999)
        if (error) throw new Error('match_fleets: ' + error.message)
        for (const r of data ?? []) keys.add((r as { match_key: string }).match_key)
        if (!data || data.length < 1000) break
      }
      return jsonResponse({
        matchKeys: [...keys],
        rankLimitSeconds: RANK_GAP_SECONDS,
        maxSlice: MAX_SLICE,
      })
    }

    // -- score -----------------------------------------------------------------------------------
    const matchKeys = Array.isArray(body.matchKeys)
      ? body.matchKeys.filter((k): k is string => typeof k === 'string')
      : null
    if (!matchKeys || matchKeys.length === 0) {
      return jsonResponse({ error: 'no_match_keys' }, 400)
    }
    if (matchKeys.length > MAX_SLICE) {
      return jsonResponse({ error: 'slice_too_large', maxSlice: MAX_SLICE }, 400)
    }

    const { data: eventRows, error: eventErr } = await admin
      .from('match_events')
      .select(
        'match_key, room_id, cell_index, challenge_name, match_seconds, board_size, board_seed, board_perm, square_set'
      )
      .in('match_key', matchKeys)
    if (eventErr) throw new Error('match_events: ' + eventErr.message)

    const { data: fleetData, error: fleetErr } = await admin
      .from('match_fleets')
      .select('match_key, team, board_size, placements, ship_defs')
      .in('match_key', matchKeys)
    if (fleetErr) throw new Error('match_fleets: ' + fleetErr.message)

    const byMatch = new Map<string, Record<string, unknown>[]>()
    for (const r of (eventRows ?? []) as unknown as Record<string, unknown>[]) {
      const k = r.match_key as string
      if (!byMatch.has(k)) byMatch.set(k, [])
      byMatch.get(k)!.push(r)
    }
    const fleetsByMatch = new Map<string, Record<string, unknown>[]>()
    for (const r of (fleetData ?? []) as unknown as Record<string, unknown>[]) {
      const k = r.match_key as string
      if (!fleetsByMatch.has(k)) fleetsByMatch.set(k, [])
      fleetsByMatch.get(k)!.push(r)
    }

    const rejected: Record<string, number> = {}
    const reject = (why: string) => {
      rejected[why] = (rejected[why] ?? 0) + 1
    }
    const scored: ScoredMatch[] = []

    for (const key of matchKeys) {
      const evs = byMatch.get(key) ?? []
      if (evs.length === 0) {
        reject('no_events')
        continue
      }

      const first = evs.find((e) => e.room_id) ?? evs[0]
      const roomId = first?.room_id as string | undefined
      if (!roomId) {
        reject('no_room_id')
        continue
      }

      const setId = (first.square_set as string) ?? DEFAULT_SET
      if (!BOSS_SETS[setId]) {
        reject('not_a_boss_set')
        continue
      }

      const boardSize = first.board_size as number
      if (!boardSize) {
        reject('no_board_size')
        continue
      }
      const cells = boardSize * boardSize

      const seed = (evs.find((e) => e.board_seed)?.board_seed as string) ?? null
      const perm = (evs.find((e) => e.board_perm)?.board_perm as number[]) ?? null

      const playedBoard = dealBoard(roomId, setId, cells, seed, perm)
      const dealtBoard = dealBoard(roomId, setId, cells, seed, null)

      // Trust a match only if the names it logged land where the rebuild puts them - the same guard
      // build-time-cost.mjs uses, and for the same reason: a rebuild that disagrees with the archive
      // is scoring a board nobody played.
      const fired = evs.filter((e) => (e.cell_index as number) >= 0 && e.challenge_name)
      if (fired.length < 3) {
        reject('too_few_shots')
        continue
      }
      const agree = fired.filter(
        (e) => playedBoard[e.cell_index as number]?.name === e.challenge_name
      ).length
      if (agree < fired.length * 0.8) {
        reject('rebuild_disagrees')
        continue
      }

      const rows = fleetsByMatch.get(key) ?? []
      if (rows.length < 2) {
        reject('fewer_than_two_fleets')
        continue
      }

      // Ships come back out of the placements one hull at a time. Flattening them would price a
      // five-cell Carrier gated by one cold square as though that square gated nothing - see
      // shipCostProfile in boardBalance.ts.
      const fleets: Array<{ team: number; ships: number[][] }> = []
      for (const f of rows) {
        const placements = (f.placements ?? []) as Array<{
          shipIndex: number
          startRow: number
          startCol: number
          isHorizontal: boolean
        }>
        const defs = (f.ship_defs ?? []) as Array<{ size: number }>
        const ships: number[][] = []
        for (const p of placements) {
          const size = defs[p.shipIndex]?.size
          if (!size) continue
          const own: number[] = []
          for (let n = 0; n < size; n++) {
            const row = p.isHorizontal ? p.startRow : p.startRow + n
            const col = p.isHorizontal ? p.startCol + n : p.startCol
            // Bounds-checked per axis before flattening, or a hull running off the right edge would
            // wrap onto the start of the next row. Same reason shipCells.ts does it.
            if (row < 0 || col < 0 || row >= boardSize || col >= boardSize) continue
            own.push(row * boardSize + col)
          }
          if (own.length > 0) ships.push(own)
        }
        if (ships.length > 0) fleets.push({ team: f.team as number, ships })
      }
      if (fleets.length < 2) {
        reject('fleets_had_no_ships')
        continue
      }

      const playedCosts = costsOf(playedBoard)
      const dealtCosts = costsOf(dealtBoard)
      if (!playedCosts || !dealtCosts) {
        reject('square_missing_a_cost')
        continue
      }

      const duration = Math.max(...evs.map((e) => (e.match_seconds as number) ?? 0))
      if (duration <= 0) {
        reject('no_duration')
        continue
      }

      // A fixed salt per match, so the sweep gives the same answer twice and a re-run of a slice
      // agrees with the first. The live balancer uses a random one precisely so that nobody can
      // predict it; here reproducibility is worth more.
      const redraw = balanceBoard({
        cost: dealtCosts.cost,
        regions: dealtCosts.regions,
        boardSize,
        fleets,
        next: rng(seedFrom('stats:' + key)),
        rules: rulesFor(setId, boardSize),
      })

      const played = scoreLayout(playedCosts.cost, fleets)
      // The raw deal on the second test. `redraw` reports its own before/after, but the deal's
      // long-square gap is measured here for the same reason `played` is: it is the board as it
      // existed, not the board the redraw would have produced.
      const dealtScore = scoreLayout(dealtCosts.cost, fleets)

      // "Stranded" = holding a ship whose slowest square costs more than the whole match lasted, so
      // it could not have been sunk in the time the match actually ran. One fleet stranded and the
      // other not is the asymmetry that makes a match unwinnable rather than merely long.
      let strandedFleets = 0
      for (const profile of played.profiles) {
        if (profile.length > 0 && profile[0] > duration) strandedFleets++
      }

      scored.push({
        matchKey: key,
        boardSize,
        setId,
        teams: fleets.length,
        durationSec: duration,
        hadPerm: Array.isArray(perm) && perm.length === cells,
        dealt: redraw.rankGapBefore,
        played: played.rankGap,
        rebalanced: redraw.rankGapAfter,
        longDealt: dealtScore.longGap,
        longPlayed: played.longGap,
        longRebalanced: redraw.longGapAfter,
        strandedFleets,
      })
    }

    // -- backfill ----------------------------------------------------------------------------
    //
    // Matches finished before balance-board started keeping its own record have no fairness number
    // and no way to get one except this: re-derive it here, once, and write it down. Everything
    // after the migration arrives with a record already attached.
    //
    // `is('balance', null)` is what keeps the two sources in the right order. A deal-time record is
    // what the balancer of the day ACTUALLY did, measured on the board as it was played; a swept one
    // is today's cost model re-applied to an old board, which is the honest reconstruction but still
    // a reconstruction. So the sweep fills gaps and never overwrites - re-running it after the cost
    // table changes cannot quietly restate the history of matches that recorded their own.
    let persisted = 0
    if (body.persist === true) {
      for (const m of scored) {
        const { data } = await admin
          .from('match_reports')
          .update({
            balance: {
              v: 1,
              source: 'sweep',
              dealt: Math.round(m.dealt),
              played: Math.round(m.played),
              // Sweep-only: what TODAY's balancer would make of the same deal. There is no such
              // number at deal time, because at deal time today's balancer is the only one there is.
              rebalanced: Math.round(m.rebalanced),
              // The same three on the second test, in whole squares. See LONG_GAP.
              longDealt: m.longDealt,
              longPlayed: m.longPlayed,
              longRebalanced: m.longRebalanced,
              stranded: m.strandedFleets,
              teams: m.teams,
              hadPerm: m.hadPerm,
              at: new Date().toISOString(),
            },
          })
          .eq('match_key', m.matchKey)
          .is('balance', null)
          .select('match_key')
        persisted += data?.length ?? 0
      }
    }

    return jsonResponse({ scored, rejected, persisted, rankLimitSeconds: RANK_GAP_SECONDS })
  } catch (e) {
    return jsonResponse({ error: 'failed', detail: (e as Error).message }, 500)
  }
})
