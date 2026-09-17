// Fires a player's shot when the game tells us they killed the boss on that square.
//
// The caller is a native mod running inside Elden Ring. It knows two things: an opaque token, and
// which boss event flags are currently set. It has no idea what a match, a team, a board or an
// opponent is - every piece of match-specific knowledge is resolved here, from state the website
// already holds because it has to render that player's board anyway.
//
// -- Why this is an edge function and not a database function ------------------------------------
//
// Boards are never stored. A board is a pure function of room id, square set and match seed, which
// every client re-derives independently - that is why there is nothing to sync and nothing that can
// drift mid-match. Turning a flag id into a cell index therefore means running that same derivation,
// and the only place that can import the real one is here. Reimplementing a seeded shuffle in plpgsql
// would create a second source of truth, and the failure mode when it eventually disagreed would be
// shots landing on the wrong squares.
//
// -- Why the payload is full state rather than one event -----------------------------------------
//
// The client sends every flag it currently sees set, not just the newest. We diff against what has
// already been fired, so a dropped request, a network blip or the mod restarting mid-match all heal
// on the next send. No acknowledgements, no sequence numbers, no replay buffer on either side.
//
// -- What it refuses to do -----------------------------------------------------------------------
//
// Only boss rooms, either cut of that board. The objective square sets are counters and judgement calls ("collect 4 unique
// helms") that no event flag can settle, and a stale client left running must not be able to fire
// into one. Only rooms actually in battle. Only when the token resolves to exactly one live match -
// two would mean guessing which board to shoot at, and a shot cannot be taken back.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rng, seedFrom } from '../../../src/lib/seededRandom.ts'
import { buildFlatBoard } from '../../../src/lib/squareSetFormat.ts'
import { applyBoardPerm } from '../../../src/lib/boardBalance.ts'
import { activeTeams } from '../../../src/lib/battleshipLogic.ts'
import bossData from '../../../src/data/battleshipChallenges.json' with { type: 'json' }
import bossData2v2 from '../../../src/data/battleshipChallenges2v2.json' with { type: 'json' }
import bossFlags from '../../../src/data/bossFlags.json' with { type: 'json' }

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
 * Both are cuts of the boss board - see squareSets.ts. The smaller one is what a room lands on when
 * every team is one or two players, and it is auto-fireable for the same reason the full one is:
 * every square in it is a boss with an event flag, because it is a subset of the full one.
 */
const BOSS_SETS: Record<string, { name: string; tooltip?: string }[]> = {
  'bosses': bossData,
  'bosses-2v2': bossData2v2,
}

/** `null` is a room from before square sets, which is the default set. */
const DEFAULT_SET = 'bosses'

/**
 * How far back a client-supplied kill time is honoured.
 *
 * The time matters: under fire-on-kill a shot's timestamp IS the kill time, and taking it from the
 * client rather than from arrival keeps poll and network latency out of every record. But an
 * unclamped client timestamp is a backdating tool, and the timing tables in recordBook are derived
 * entirely from this column. Five seconds is far more than a 1s poll plus a round trip needs, and
 * far less than any margin worth cheating for.
 */
const MAX_BACKDATE_MS = 5000

/** flag id -> square tooltip. bossFlags.json is keyed the other way because that diffs better. */
const flagToTooltip = new Map<number, string>()
for (const [tooltip, flag] of Object.entries(bossFlags as Record<string, unknown>)) {
  if (tooltip.startsWith('_')) continue // `_comment`, per the convention the other data files use
  flagToTooltip.set(flag as number, tooltip)
}

interface KillReport {
  flag: number
  at?: string
}

/**
 * Rebuilds the room's board and returns tooltip -> cell indices.
 *
 * Mirrors challengesForRoom()'s seeding, which cannot be imported here because the square-set
 * registry binds a dozen JSON files - the same reason scripts/check-boards.ts mirrors it. Safe to
 * duplicate precisely because the rule is frozen: the DEFAULT set seeds from the bare room id, and
 * every other set from `roomId:setId`. Changing either would re-deal every board already in play and
 * strand the Almanac, which reconstructs archived boards from the room id alone.
 *
 * Both branches are live now that a boss room can be on either cut of the board, so the split below
 * has to match challengesForRoom line for line - a set id left out of the seed base deals a
 * different board from the one the players are looking at, and auto-fire would mark the wrong cell.
 *
 * The permutation has to be applied here too, and it is the part that fails silently when
 * forgotten: a balanced board deals the same squares to different cells, so a kill would resolve to
 * the cell that boss USED to be on and fire there. The shot would land, report a hit or a miss, and
 * be wrong, with no undo. Null means an unbalanced room, which is every room from before balancing
 * existed and any room whose balancer was unreachable.
 *
 * applyBoardPerm is imported rather than rewritten for exactly that reason: it is also what
 * challengesForRoom applies to decide what the player is looking at, and these two agreeing is the
 * whole correctness condition of auto-fire on a balanced board.
 */
function boardIndex(
  roomId: string,
  setId: string,
  cells: number,
  seed: string | null,
  perm: number[] | null
): Map<string, number[]> {
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base))
  const dealt = buildFlatBoard(BOSS_SETS[setId], cells, next)
  const board = applyBoardPerm(dealt, perm)

  const byTooltip = new Map<string, number[]>()
  board.forEach((square, cell) => {
    const tooltip = square?.tooltip
    if (!tooltip) return
    // A square can legitimately occupy more than one cell when a set is smaller than the board.
    // The lobby no longer lets that happen - each set is held to the biggest board it can fill from
    // its own squares, 14x14 for the full boss set and 12x12 for the 164-square cut (see
    // maxBoardSize) - but rooms are not re-validated on load and this function reads rooms it did
    // not create, so a list is still the honest answer. Assuming a single index would turn a board
    // that got past the lobby into a silent wrong answer instead of a loud one.
    if (!byTooltip.has(tooltip)) byTooltip.set(tooltip, [])
    byTooltip.get(tooltip)!.push(cell)
  })
  return byTooltip
}

/** The two verdicts the site counts as connecting - `sunk` is a hit that also finished a hull. */
const CONNECTED = new Set(['hit', 'sunk'])

/**
 * The player's running score for this match, in the website's own terms.
 *
 * One shot counts once no matter how many boards it landed on, and counts as a hit if it connected
 * with any of them - the definition buildPlayerStats() uses and archive_match() records. Connecting
 * means `hit` OR `sunk`: resolve_attack returns `sunk` for the shot that finishes a hull, so
 * counting only `hit` filed every kill shot as a miss and made the overlay's accuracy read lower
 * than the scoreboard's for the same match.
 *
 * Computed here rather than tallied by the client so that manually-clicked squares are included, so
 * there is no reset to detect between matches, and so the number can never disagree with the
 * scoreboard.
 */
async function tallyFor(
  admin: SupabaseClient,
  roomId: string,
  playerId: string
): Promise<{ hits: number; misses: number; shots: number; accuracy: number | null }> {
  const { data } = await admin
    .from('attacks')
    .select('cell_index, result')
    .eq('room_id', roomId)
    .eq('attacker_player_id', playerId)
    .gte('cell_index', 0) // negative cells are bookkeeping markers, never real shots

  const connected = new Map<number, boolean>()
  for (const row of data ?? []) {
    const was = connected.get(row.cell_index) ?? false
    connected.set(row.cell_index, was || CONNECTED.has(row.result))
  }

  const shots = connected.size
  let hits = 0
  for (const hit of connected.values()) if (hit) hits++

  return {
    hits,
    misses: shots - hits,
    shots,
    // Null rather than 0 before the first shot: nothing has missed yet, and the overlay shows a dash.
    accuracy: shots > 0 ? Math.round((hits / shots) * 100) : null,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405)

  try {
    const body = await req.json().catch(() => null)
    const token: unknown = body?.token
    const kills: KillReport[] = Array.isArray(body?.kills) ? body.kills : []
    if (typeof token !== 'string' || !token) return jsonResponse({ ok: false, error: 'missing_token' }, 400)

    // Service role throughout: the caller holds no session, and every table it needs to reach is
    // closed to anon by design. Authorisation is the token lookup below, not RLS.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: tokenRow } = await admin
      .from('ingest_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle()
    if (!tokenRow) return jsonResponse({ ok: false, error: 'unknown_token' }, 403)

    // Which match is this person in right now? Resolved per request rather than stored in the token,
    // which is what lets one permanent token follow a player across rooms, teams and matches.
    //
    // Two queries rather than one embedded join: square_counts holds foreign keys to both players and
    // rooms, so PostgREST sees more than one relationship between them and refuses to guess which one
    // to embed. Naming the constraint would work right up until the next junction table appears.
    const { data: seats } = await admin
      .from('players')
      .select('id, team, room_id')
      .eq('user_id', tokenRow.user_id)
    const seated = (seats ?? []).filter((s) => s.team !== null && s.team !== undefined)

    const { data: battles } = seated.length
      ? await admin
          .from('rooms')
          .select('id, board_size, square_set, seed, board_perm')
          .in(
            'id',
            seated.map((s) => s.room_id)
          )
          .eq('status', 'battle')
      : { data: [] }

    const live = seated.flatMap((seat) => {
      const room = (battles ?? []).find((r) => r.id === seat.room_id)
      return room ? [{ seat, room }] : []
    })
    if (live.length === 0) return jsonResponse({ ok: false, error: 'not_in_match' })
    // Two live matches means guessing which board to fire at. A shot cannot be taken back, so this
    // refuses rather than picks.
    if (live.length > 1) return jsonResponse({ ok: false, error: 'ambiguous_match' }, 409)

    const { seat, room } = live[0]

    // `null` is the default set. Anything that is not a cut of the boss board is refused - see the
    // header.
    const setId = room.square_set ?? DEFAULT_SET
    if (!BOSS_SETS[setId]) {
      return jsonResponse({ ok: false, error: 'unsupported_square_set' })
    }

    const cells = room.board_size * room.board_size
    const byTooltip = boardIndex(room.id, setId, cells, room.seed, room.board_perm)

    const { data: roster } = await admin.from('players').select('team').eq('room_id', room.id)
    const defenders = activeTeams(roster ?? []).filter((t) => t !== seat.team)

    // Everything this team has already put on the board, so a re-reported kill - or a square the
    // player clicked manually before the mod got to it - is skipped rather than duplicated.
    const { data: mine } = await admin
      .from('attacks')
      .select('cell_index')
      .eq('room_id', room.id)
      .eq('attacker_team', seat.team)
    const alreadyFired = new Set((mine ?? []).map((a) => a.cell_index))

    const now = Date.now()
    const fired: { flag: number; cell: number; result: string | null }[] = []
    const skipped: { flag: number; reason: string }[] = []

    for (const kill of kills) {
      const flag = Number(kill?.flag)
      if (!Number.isFinite(flag)) continue

      const tooltip = flagToTooltip.get(flag)
      if (!tooltip) {
        // Expected and harmless: the mod watches every boss in the game, and only some are squares.
        skipped.push({ flag, reason: 'not_a_square' })
        continue
      }

      const targets = byTooltip.get(tooltip)
      if (!targets?.length) {
        skipped.push({ flag, reason: 'not_on_this_board' })
        continue
      }

      for (const cell of targets) {
        if (alreadyFired.has(cell)) {
          skipped.push({ flag, reason: 'already_fired' })
          continue
        }
        if (defenders.length === 0) {
          skipped.push({ flag, reason: 'no_opponents' })
          continue
        }

        const reported = kill.at ? Date.parse(kill.at) : NaN
        const at = new Date(
          Number.isFinite(reported) ? Math.min(Math.max(reported, now - MAX_BACKDATE_MS), now) : now
        ).toISOString()

        // Same shape a click produces: one row per opposing fleet, resolved individually.
        //
        // Upsert, not insert: `alreadyFired` is a snapshot read at the top of this request, so a
        // poll that overlaps one still in flight for the same kill - the mod resends every
        // currently-set flag on every poll, precisely so a slow or dropped request heals on the
        // next one - can read that snapshot before the earlier request's row lands. Without
        // attacks_one_shot_per_square backing this up, that race inserted a second row at a square
        // already fired at; with it, the second insert is a no-op instead of a duplicate.
        const { data: inserted, error: insertError } = await admin
          .from('attacks')
          .upsert(
            defenders.map((defender_team) => ({
              room_id: room.id,
              cell_index: cell,
              attacker_team: seat.team,
              defender_team,
              attacker_player_id: seat.id,
              created_at: at,
            })),
            { onConflict: 'room_id,attacker_team,defender_team,cell_index', ignoreDuplicates: true }
          )
          .select('id')
        if (insertError) {
          skipped.push({ flag, reason: 'insert_failed' })
          continue
        }
        if (!inserted || inserted.length === 0) {
          // Every defender's row already existed - a race with another poll (or a manual click
          // that beat the mod to it) got here first. Nothing landed, so there is nothing to resolve.
          alreadyFired.add(cell)
          skipped.push({ flag, reason: 'already_fired' })
          continue
        }

        let verdict: string | null = null
        for (const row of inserted ?? []) {
          const { data: result } = await admin.rpc('resolve_attack', { p_attack_id: row.id })
          // One shot, one verdict: connecting with any fleet makes the shot a hit, matching how the
          // scoreboard and the archive both count it. `sunk` is the strongest verdict and wins over
          // a plain `hit`; without that a shot that sank a ship on one board and missed another
          // reported as a miss whenever the missing fleet resolved first.
          if (result === 'sunk') verdict = 'sunk'
          else if (result === 'hit' && verdict !== 'sunk') verdict = 'hit'
          else if (verdict === null) verdict = result as string | null
        }

        alreadyFired.add(cell)
        fired.push({ flag, cell, result: verdict })
      }
    }

    return jsonResponse({
      ok: true,
      fired,
      skipped,
      tally: await tallyFor(admin, room.id, seat.id),
    })
  } catch (err) {
    return jsonResponse({ ok: false, error: 'internal', detail: String(err) }, 500)
  }
})
