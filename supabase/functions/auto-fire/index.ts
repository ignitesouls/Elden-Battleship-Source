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
import { MATCH_START_MARKER, matchTimings, battlePhaseAt } from '../../../src/lib/matchTime.ts'
import { pauseInfoAt, pausedMsAt, type PauseFields } from '../../../src/lib/matchPause.ts'
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
 * Pace's own two thresholds, copied rather than imported - see the comment on `pace` inside
 * liveStats for why. Keep these equal to MIN_GAP_SECONDS in src/lib/recordBook.ts and
 * MIN_GAPS_FOR_PACE in src/lib/squarePace.ts, by hand, whenever either changes.
 */
const MIN_GAP_SECONDS = 10
const MIN_GAPS_FOR_PACE = 5

/** The middle value, averaging the two middles on an even count - same rule as squarePace's median. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

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
async function liveStats(
  admin: SupabaseClient,
  roomId: string,
  playerId: string,
  pause: PauseFields
): Promise<LiveTally> {
  const { data } = await admin
    .from('attacks')
    .select('cell_index, result, created_at, auto')
    .eq('room_id', roomId)
    .eq('attacker_player_id', playerId)
    .gte('cell_index', 0) // negative cells are bookkeeping markers, never real shots

  const connected = new Map<number, boolean>()
  // Hulls, not shots: one `sunk` row per fleet finished, summed - the same count archive_match()
  // writes to match_participants.sunk, so a live sunk can be held against an archived one.
  let sunk = 0
  // One entry per square this player has fired at, keyed the same way `connected` is. created_at
  // and auto agree across every defender row one shot writes (see the upsert below), so the first
  // row seen for a cell is as good as any of the others.
  const squares = new Map<number, { atMs: number; auto: boolean }>()
  for (const row of data ?? []) {
    const was = connected.get(row.cell_index) ?? false
    connected.set(row.cell_index, was || CONNECTED.has(row.result))
    if (row.result === 'sunk') sunk++
    if (!squares.has(row.cell_index)) {
      squares.set(row.cell_index, { atMs: Date.parse(row.created_at), auto: row.auto === true })
    }
  }

  const shots = connected.size
  let hits = 0
  for (const hit of connected.values()) if (hit) hits++

  /**
   * Median seconds between this player's consecutive squares, on the website's match clock rather
   * than IGT - the same measurement lib/squarePace.ts makes of the archive and buildPlayerStats()
   * makes of a finished match, applied live.
   *
   * Not imported from squarePace.ts: that module pulls in recordBook.ts, which pulls in
   * matchReport.ts, both built for the browser and neither safe to evaluate inside an edge
   * function. The rule itself is copied instead - drop a gap under MIN_GAP_SECONDS (a duo boss or a
   * banked kill, not a fast square), require both ends auto-fired (a clicked square is stamped with
   * whenever someone got round to clicking it, not the kill time), and take the median once there
   * are MIN_GAPS_FOR_PACE of them.
   */
  const clockMs = (atMs: number) => atMs - pausedMsAt(pause, atMs)
  const ordered = [...squares.values()].sort((a, b) => a.atMs - b.atMs)
  const gaps: number[] = []
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const cur = ordered[i]
    if (!prev.auto || !cur.auto) continue
    const gapSeconds = (clockMs(cur.atMs) - clockMs(prev.atMs)) / 1000
    if (gapSeconds >= MIN_GAP_SECONDS) gaps.push(gapSeconds)
  }
  const pace = gaps.length >= MIN_GAPS_FOR_PACE ? median(gaps) : null

  return {
    hits,
    misses: shots - hits,
    shots,
    // Null rather than 0 before the first shot: nothing has missed yet, and the overlay shows a dash.
    accuracy: shots > 0 ? Math.round((hits / shots) * 100) : null,
    pace,
    sunk,
  }
}

interface LiveTally {
  hits: number
  misses: number
  shots: number
  accuracy: number | null
  pace: number | null
  sunk: number
}

/**
 * Accuracy's floor, copied from MIN_SHOTS_FOR_ACCURACY in src/lib/recordBook.ts for the same reason
 * the pace thresholds above are copied. Below it a game neither holds an accuracy PB nor beats one.
 */
const MIN_SHOTS_FOR_ACCURACY = 5

/**
 * A captain's best single game on the boss board, for the overlay's PB line.
 *
 * The same records the website's "Single-game bests" panel reads off the record book, rebuilt from
 * the same two tables: hits, sunk and accuracy from match_participants, pace from match_events.
 * `accuracyRatio` is kept unrounded so a PB of 83.4% is not "beaten" by 83.1%.
 *
 * Pace is the best per-match MEDIAN, built exactly like the live tally's pace - auto-fired squares at
 * both ends, gaps under MIN_GAP_SECONDS dropped, MIN_GAPS_FOR_PACE of them needed - because the whole
 * point of the line is to hold the two against each other. That is a different number from the
 * website's "Best match", which is a mean; see the career panel in PlayerStats.tsx.
 */
interface PersonalBests {
  hits: number | null
  sunk: number | null
  accuracyRatio: number | null
  pace: number | null
}

/**
 * PBs per captain per room, so they are read once per match rather than on every one-second poll.
 *
 * Safe to hold for the life of the match: the rows are archived games, and the match being played
 * is not one of them until it finishes - by which time the room is no longer in battle and nothing
 * asks for it. The TTL only bounds memory on a long-lived instance; a cold one simply reads again.
 */
const PB_TTL_MS = 30 * 60 * 1000
const pbCache = new Map<string, { at: number; bests: PersonalBests }>()

/** PostgREST caps a read at 1000 rows; a career's shot log is well past that. */
async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const SIZE = 1000
  const out: T[] = []
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < SIZE) return out
  }
}

/**
 * Every stored id that folds into the boss board: null (rooms from before square sets) and both
 * cuts. They are one board for records, exactly as displaySquareSet folds them on the website.
 */
const BOSS_BOARD_FILTER = `square_set.is.null,square_set.in.(${Object.keys(BOSS_SETS).join(',')})`

async function personalBests(admin: SupabaseClient, userId: string): Promise<PersonalBests> {
  const [voided, games, events] = await Promise.all([
    // The durable list, which outlives the 30-day sweep of match_reports - see 20261003000000.
    admin.from('voided_matches').select('match_key'),
    allRows<{ match_key: string; shots: number; hits: number; sunk: number }>((from, to) =>
      admin
        .from('match_participants')
        .select('match_key, shots, hits, sunk')
        .eq('user_id', userId)
        .or(BOSS_BOARD_FILTER)
        .order('match_key')
        .range(from, to)
    ),
    allRows<{ match_key: string; cell_index: number; match_seconds: number | null }>((from, to) =>
      admin
        .from('match_events')
        .select('match_key, cell_index, match_seconds')
        .eq('participant_key', userId)
        .eq('auto', true)
        .gte('cell_index', 0)
        .or(BOSS_BOARD_FILTER)
        // The order match_events_participant_idx is built in, so paging walks the index rather than
        // sorting a career's worth of rows - and `id` makes it a total order, so no page skips a row.
        .order('finished_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
    ),
  ])
  // Voided games count for nothing anywhere on the site, PBs included - see lib/voidedMatches.
  const struck = new Set((voided.data ?? []).map((r) => r.match_key))

  const bests: PersonalBests = { hits: null, sunk: null, accuracyRatio: null, pace: null }
  for (const g of games) {
    if (struck.has(g.match_key)) continue
    if (g.hits > 0) bests.hits = Math.max(bests.hits ?? 0, g.hits)
    if (g.sunk > 0) bests.sunk = Math.max(bests.sunk ?? 0, g.sunk)
    if (g.shots >= MIN_SHOTS_FOR_ACCURACY && g.hits > 0) {
      bests.accuracyRatio = Math.max(bests.accuracyRatio ?? 0, g.hits / g.shots)
    }
  }

  // One time per square per match: a shot writes a row per opposing fleet, all on the same clock.
  const squareTimes = new Map<string, Map<number, number>>()
  for (const e of events) {
    if (struck.has(e.match_key) || e.match_seconds === null) continue
    let cells = squareTimes.get(e.match_key)
    if (!cells) squareTimes.set(e.match_key, (cells = new Map()))
    if (!cells.has(e.cell_index)) cells.set(e.cell_index, e.match_seconds)
  }
  for (const cells of squareTimes.values()) {
    // Only auto rows were read, so every neighbouring pair here is auto at both ends - but a manual
    // square between two auto ones is missing from this list, which joins its neighbours into one
    // long gap. That can only make a pace slower, never faster, so it cannot hand out a false PB.
    const times = [...cells.values()].sort((a, b) => a - b)
    const gaps: number[] = []
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1]
      if (gap >= MIN_GAP_SECONDS) gaps.push(gap)
    }
    if (gaps.length < MIN_GAPS_FOR_PACE) continue
    const pace = median(gaps)!
    if (bests.pace === null || pace < bests.pace) bests.pace = pace
  }
  return bests
}

/**
 * The PB line's payload, or null to leave `pb` out of the reply entirely.
 *
 * Null on a captain's first game (nothing archived to beat) and on ANY failure. This rides on the
 * same request that fires shots, and a PB lookup going wrong must never be the reason a kill's reply
 * comes back as an error - the shots have already landed by the time this runs.
 *
 * `pb_beaten` is decided here rather than in the DLL so the floors and the which-way-is-better
 * rules live in one place. A stat is only beaten against a PB that exists, and strictly - a tie
 * goes to the earlier game, as it does in the record book.
 */
async function pbPayload(
  admin: SupabaseClient,
  userId: string,
  roomId: string,
  tally: LiveTally
): Promise<{ pb: Record<string, number | null>; pb_beaten: string[] } | null> {
  try {
    const key = `${userId}|${roomId}`
    const now = Date.now()
    let hit = pbCache.get(key)
    if (!hit || now - hit.at > PB_TTL_MS) {
      hit = { at: now, bests: await personalBests(admin, userId) }
      pbCache.set(key, hit)
      for (const [k, v] of pbCache) if (now - v.at > PB_TTL_MS) pbCache.delete(k)
    }
    const b = hit.bests
    if (b.hits === null && b.sunk === null && b.accuracyRatio === null && b.pace === null) return null

    const beaten: string[] = []
    if (b.hits !== null && tally.hits > b.hits) beaten.push('hits')
    if (b.sunk !== null && tally.sunk > b.sunk) beaten.push('sunk')
    if (
      b.accuracyRatio !== null &&
      tally.shots >= MIN_SHOTS_FOR_ACCURACY &&
      tally.hits / tally.shots > b.accuracyRatio
    ) {
      beaten.push('accuracy')
    }
    if (b.pace !== null && tally.pace !== null && tally.pace < b.pace) beaten.push('pace')

    return {
      pb: {
        hits: b.hits,
        sunk: b.sunk,
        accuracy: b.accuracyRatio === null ? null : Math.round(b.accuracyRatio * 100),
        pace: b.pace === null ? null : Math.round(b.pace),
      },
      pb_beaten: beaten,
    }
  } catch {
    return null
  }
}

/** What the DLL renders in place of IGT. */
interface ClockPayload {
  phase: 'starting' | 'preparation' | 'match' | 'paused'
  /** Seconds left in the STARTING/PREPARATION countdown, or elapsed since MATCH began. Never both. */
  seconds: number
  /** False while the room is stopped - see PauseInfo.stopped in lib/matchPause. */
  running: boolean
}

/**
 * The website's match clock, in the shape the overlay renders. Mirrors what MatchDock's clock panel
 * shows a player already - see lib/matchTime.battlePhaseAt - so a player glancing between the two
 * never catches them disagreeing.
 *
 * Sent as elapsed/remaining seconds rather than a start timestamp, on purpose: a player's PC clock
 * being wrong must not throw the in-game number off, and the DLL is expected to count these forward
 * itself between replies rather than re-deriving them from wall time.
 *
 * `null` before the start marker exists, which the caller reads as "say nothing" - the same case
 * that hides the ingest tally line entirely.
 */
function computeClock(room: { starting_seconds?: number; prep_seconds?: number } & PauseFields, startedAt: string | null, nowMs: number): ClockPayload | null {
  if (!startedAt) return null
  const pause = pauseInfoAt(room, nowMs)
  const info = battlePhaseAt(startedAt, nowMs, matchTimings(room), pause)
  if (!info) return null
  return {
    // The warning window before a pause takes hold (PauseInfo's "pausing" phase) still counts as
    // running here, same as it does on the website: the clock has not actually stopped yet.
    phase: pause.stopped ? 'paused' : info.phase,
    seconds: Math.max(0, Math.round(info.phase === 'match' ? info.matchElapsed : info.countdown)),
    running: !pause.stopped,
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
          // The extra five columns past board_perm are the website's own match clock: starting_seconds
          // and prep_seconds size its countdown, pause_at/resume_at/pause_log stop it - see computeClock.
          .select('id, board_size, square_set, seed, board_perm, starting_seconds, prep_seconds, pause_at, resume_at, pause_log')
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
              // Marks this shot as timed off a real kill event rather than a manual click - see
              // the 20260920 migration. Only this path should ever set it.
              auto: true,
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

    // The start marker, room-wide rather than keyed to this player - see MATCH_START_MARKER. Every
    // room reaches 'battle' with one already written (startBattle checks the insert before flipping
    // status), so a live match missing one here is the rare room from before the marker existed.
    const { data: markerRow } = await admin
      .from('attacks')
      .select('created_at')
      .eq('room_id', room.id)
      .eq('cell_index', MATCH_START_MARKER)
      .limit(1)
      .maybeSingle()

    const tally = await liveStats(admin, room.id, seat.id, room)
    // Spread rather than assigned, so a captain with no PBs gets no `pb` key at all - which is how
    // the overlay knows to draw no PB line, and how an older DLL never sees a field it can't read.
    const pb = await pbPayload(admin, tokenRow.user_id, room.id, tally)

    return jsonResponse({
      ok: true,
      fired,
      skipped,
      tally,
      ...(pb ?? {}),
      clock: computeClock(room, markerRow?.created_at ?? null, Date.now()),
    })
  } catch (err) {
    return jsonResponse({ ok: false, error: 'internal', detail: String(err) }, 500)
  }
})
