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
//
// -- Why the database directly, not supabase-js ----------------------------------------------------
//
// The mod calls this about once a second for the whole of every match. Through supabase-js each of
// those calls made seven or eight REST requests back out through the API gateway, and every gateway
// request is a log line - in October 2026 that made this function the biggest thing on the project's
// metered log ingest. Over SUPABASE_DB_URL the same reads write no gateway lines at all, so a poll now
// costs one line (the mod's own request) instead of eight or nine.
//
// Every read goes through rows(), which builds its result with json_agg - what PostgREST builds its
// responses with - so timestamps, uuids and jsonb reach the code below as the exact strings and shapes
// supabase-js used to hand it. The board derivation, the clock and the PB cache key all read them.

import postgres from 'npm:postgres@3.4.7'
import { rng, seedFrom } from '../../../src/lib/seededRandom.ts'
import { buildFlatBoard, dealtPool } from '../../../src/lib/squareSetFormat.ts'
import { applyBoardPerm } from '../../../src/lib/boardBalance.ts'
import { activeTeams } from '../../../src/lib/battleshipLogic.ts'
import { MATCH_START_MARKER, matchTimings, battlePhaseAt } from '../../../src/lib/matchTime.ts'
import { pauseInfoAt, pausedMsAt, type PauseFields } from '../../../src/lib/matchPause.ts'
import { fleetShape } from '../../../src/lib/boardShape.ts'
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

// Module scope, so a warm instance reuses its connections across polls. `prepare: false` keeps it
// working through the transaction pooler as well as on a direct connection. Two rather than one so a
// captain's first-poll PB read (a career's worth of rows) can't hold up another player's poll queued
// behind it on the same instance; queries sent together are pipelined either way.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2, idle_timeout: 30 })

/** A query's rows exactly as PostgREST would have returned them - see the header. */
async function rows<T>(query: postgres.PendingQuery<postgres.Row[]>): Promise<T[]> {
  const [{ rows }] = await sql`select coalesce(json_agg(q), '[]'::json) as rows from (${query}) q`
  return rows as T[]
}

/**
 * The square sets this works for, and the squares each one deals. Anything else is refused rather
 * than approximated.
 *
 * Both are cuts of the boss board - see squareSets.ts. The smaller one is what a room lands on when
 * every team is one or two players, and it is auto-fireable for the same reason the full one is:
 * every square in it is a boss with an event flag, because it is a subset of the full one.
 *
 * Boss Shuffle is the full board played on the boss randomizer: same squares, same deal, its own
 * records. The randomizer moves where a boss stands, not the flag its death sets.
 */
const BOSS_SETS: Record<string, { name: string; tooltip?: string }[]> = {
  'bosses': bossData,
  'bosses-2v2': bossData2v2,
  'boss-shuffle': bossData,
}

/** Mirrors squareSets.dealsAs: the set whose seeding a set borrows, so its boards deal identically. */
const DEALS_AS: Record<string, string> = {
  'boss-shuffle': 'bosses',
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
  perm: number[] | null,
  dealtAt: string | null
): Map<string, number[]> {
  // A set that deals as another seeds as it too - squareSets.dealsAs, mirrored by DEALS_AS.
  const dealId = DEALS_AS[setId] ?? setId
  const base = dealId === DEFAULT_SET ? roomId : `${roomId}:${dealId}`
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base))
  // Same pool challengesForRoom deals from: a square added to the set after this board was dealt is
  // not on it, and leaving it in would re-deal the board and fire every kill at the wrong cell.
  const dealt = buildFlatBoard(dealtPool(BOSS_SETS[setId], dealtAt), cells, next)
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
async function liveStats(roomId: string, playerId: string, pause: PauseFields): Promise<LiveTally> {
  const data = await rows<{ cell_index: number; result: string; created_at: string; auto: boolean }>(sql`
    select cell_index, result, created_at, auto
    from public.attacks
    where room_id = ${roomId}
      and attacker_player_id = ${playerId}
      and cell_index >= 0`) // negative cells are bookkeeping markers, never real shots

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
 * A captain's best single game on the boss board, for the overlay's PB line - on THIS match's board
 * size and fleet only (see lib/boardShape). A 14x14 game's hits are out of reach on a 6x6 board, so
 * pooling every size made most of the line unbeatable.
 *
 * The same records the website's "Single-game bests" panel reads off the record book, rebuilt from
 * the same tables: hits, sunk and accuracy from match_participants, pace from match_events, and the
 * board and fleet each game was played on from match_fleets.
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
  /** Most shots taken in one game, hits and misses together. */
  shots: number | null
  accuracyRatio: number | null
  pace: number | null
}

/**
 * PBs per captain per match, so they are read once per match rather than on every one-second poll.
 *
 * Safe to hold for the life of the match: the rows are archived games, and the match being played
 * is not one of them until it finishes. Keyed on the match's start marker and its board, not just the
 * room, because a room is replayed: the next match there may be on another board, and has the last
 * one in its archive. The TTL only bounds memory on a long-lived instance; a cold one simply reads again.
 */
const PB_TTL_MS = 30 * 60 * 1000
const pbCache = new Map<string, { at: number; bests: PersonalBests }>()

/**
 * Every stored id that shares a records board with `setId`, exactly as displaySquareSet folds them
 * on the website: the boss board is null (rooms from before square sets) and both cuts; Boss Shuffle
 * keeps its records apart, so its PBs come from its own games only.
 * A function, not a constant, because a postgres.js fragment is a query and is built per use.
 */
const bossBoard = (setId: string) =>
  DEALS_AS[setId]
    ? sql`square_set = ${setId}`
    : sql`(square_set is null or square_set in ${sql(Object.keys(BOSS_SETS).filter((id) => !DEALS_AS[id]))})`

async function personalBests(userId: string, setId: string, boardSize: number, shape: string): Promise<PersonalBests> {
  // No paging: PostgREST's 1000-row cap was the only reason the REST version walked these in pages.
  const [voided, fleets, games, events] = await Promise.all([
    // The durable list, which outlives the 30-day sweep of match_reports - see 20261003000000.
    rows<{ match_key: string }>(sql`select match_key from public.voided_matches`),
    // Every game archived on this board size; the fleet is compared below in JS, with the same
    // fleetShape the website uses. A row per fleet in the match, all carrying the room's one ship_defs.
    rows<{ match_key: string; ship_defs: { size: number }[] | null }>(sql`
      select match_key, ship_defs
      from public.match_fleets
      where board_size = ${boardSize} and ${bossBoard(setId)}
      order by match_key, team`),
    rows<{ match_key: string; shots: number; hits: number; sunk: number }>(sql`
      select match_key, shots, hits, sunk
      from public.match_participants
      where user_id = ${userId} and ${bossBoard(setId)}
      order by match_key`),
    rows<{ match_key: string; cell_index: number; match_seconds: number | null }>(sql`
      select match_key, cell_index, match_seconds
      from public.match_events
      where participant_key = ${userId}
        and auto
        and cell_index >= 0
        -- Narrows the read server-side; the fleet is matched below along with the participants.
        and board_size = ${boardSize}
        and ${bossBoard(setId)}
      -- The order match_events_participant_idx is built in, so the read walks the index, and the
      -- order the first-seen time per square below depends on.
      order by finished_at desc, id desc`),
  ])
  // Voided games count for nothing anywhere on the site, PBs included - see lib/voidedMatches.
  const struck = new Set(voided.map((r) => r.match_key))
  // The games played on this exact board and fleet. Every archived match has its fleets (checked
  // Oct 2026: 290 of 290), so nothing is lost here that could be compared fairly.
  const sameBoard = new Set(fleets.filter((f) => fleetShape(f.ship_defs) === shape).map((f) => f.match_key))
  const counts = (key: string) => sameBoard.has(key) && !struck.has(key)

  const bests: PersonalBests = { hits: null, sunk: null, shots: null, accuracyRatio: null, pace: null }
  for (const g of games) {
    if (!counts(g.match_key)) continue
    if (g.hits > 0) bests.hits = Math.max(bests.hits ?? 0, g.hits)
    if (g.sunk > 0) bests.sunk = Math.max(bests.sunk ?? 0, g.sunk)
    if (g.shots > 0) bests.shots = Math.max(bests.shots ?? 0, g.shots)
    if (g.shots >= MIN_SHOTS_FOR_ACCURACY && g.hits > 0) {
      bests.accuracyRatio = Math.max(bests.accuracyRatio ?? 0, g.hits / g.shots)
    }
  }

  // One time per square per match: a shot writes a row per opposing fleet, all on the same clock.
  const squareTimes = new Map<string, Map<number, number>>()
  for (const e of events) {
    if (!counts(e.match_key) || e.match_seconds === null) continue
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
 * The captain's bests for this match's board and fleet, cached per match, or null on ANY failure.
 * This rides on the same request that fires shots, and a PB lookup going wrong must never be the
 * reason a kill's reply comes back as an error - the shots have already landed by the time this runs.
 */
async function loadBests(
  userId: string,
  room: { id: string; board_size: number; square_set: string | null; ship_defs: { size: number }[] | null },
  matchStartedAt: string | null
): Promise<PersonalBests | null> {
  try {
    const shape = fleetShape(room.ship_defs)
    const setId = room.square_set ?? DEFAULT_SET
    const key = `${userId}|${room.id}|${matchStartedAt}|${setId}|${room.board_size}|${shape}`
    const now = Date.now()
    let hit = pbCache.get(key)
    if (!hit || now - hit.at > PB_TTL_MS) {
      hit = { at: now, bests: await personalBests(userId, setId, room.board_size, shape) }
      pbCache.set(key, hit)
      for (const [k, v] of pbCache) if (now - v.at > PB_TTL_MS) pbCache.delete(k)
    }
    return hit.bests
  } catch {
    return null
  }
}

/**
 * The PB line's payload, or null to leave `pb` out of the reply entirely.
 *
 * Null on a captain's first game on this board size and fleet (nothing archived to beat - their
 * bests on other boards are deliberately not offered instead). Split from loadBests so the read can
 * run alongside liveStats rather than after it - only this half needs the tally.
 *
 * `pb_beaten` is decided here rather than in the DLL so the floors and the which-way-is-better
 * rules live in one place. A stat is only beaten against a PB that exists, and strictly - a tie
 * goes to the earlier game, as it does in the record book.
 */
function pbPayload(
  b: PersonalBests,
  tally: LiveTally
): { pb: Record<string, number | null>; pb_beaten: string[] } | null {
  try {
    if (
      b.hits === null &&
      b.sunk === null &&
      b.shots === null &&
      b.accuracyRatio === null &&
      b.pace === null
    ) {
      return null
    }

    const beaten: string[] = []
    if (b.hits !== null && tally.hits > b.hits) beaten.push('hits')
    if (b.sunk !== null && tally.sunk > b.sunk) beaten.push('sunk')
    if (b.shots !== null && tally.shots > b.shots) beaten.push('shots')
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
        shots: b.shots,
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

    // Authorisation is the token lookup below, not RLS: the caller holds no session, and every table
    // it needs to reach is closed to anon by design. The connection is the database's own role, which
    // the room and fleet guard triggers exempt by name exactly as they exempt service_role.
    //
    // Which match is this person in right now? Resolved per request rather than stored in the token,
    // which is what lets one permanent token follow a player across rooms, teams and matches. The
    // token, their seats and their live rooms are one query - three round trips folded into one.
    //
    // The five room columns past board_perm are the website's own match clock: starting_seconds and
    // prep_seconds size its countdown, pause_at/resume_at/pause_log stop it - see computeClock.
    // ship_defs is the fleet, which with board_size picks the games the PB line compares against.
    // seed_set_at says which squares the board was dealt from - see dealtPool.
    const [tokenRow] = await rows<{
      user_id: string
      seats: { id: string; team: number | null; room_id: string }[]
      battles: ({
        id: string
        board_size: number
        square_set: string | null
        seed: string | null
        board_perm: number[] | null
        seed_set_at: string | null
        ship_defs: { size: number }[] | null
      } & { starting_seconds?: number; prep_seconds?: number } & PauseFields)[]
    }>(sql`
      select
        t.user_id,
        (select coalesce(json_agg(s), '[]'::json)
           from (select id, team, room_id from public.players where user_id = t.user_id) s) as seats,
        (select coalesce(json_agg(r), '[]'::json)
           from (select id, board_size, square_set, seed, board_perm, seed_set_at, starting_seconds,
                        prep_seconds, pause_at, resume_at, pause_log, ship_defs
                   from public.rooms
                  where status = 'battle'
                    and id in (select room_id from public.players
                                where user_id = t.user_id and team is not null)) r) as battles
      from public.ingest_tokens t
      where t.token = ${token}`)
    if (!tokenRow) return jsonResponse({ ok: false, error: 'unknown_token' }, 403)

    const seated = tokenRow.seats.filter((s) => s.team !== null && s.team !== undefined)
    const live = seated.flatMap((seat) => {
      const room = tokenRow.battles.find((r) => r.id === seat.room_id)
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
    const byTooltip = boardIndex(room.id, setId, cells, room.seed, room.board_perm, room.seed_set_at)

    // Three independent reads, sent together. Every read here is a round trip to the database, and
    // the overlay gives up on a reply that takes too long - so a request built as a queue of
    // one-at-a-time reads is how a kill used to end up stuck in the overlay's retry loop for half
    // a minute. Same reads, same count, just not waiting on each other.
    const [roster, mine, [markerRow]] = await Promise.all([
      rows<{ team: number | null }>(sql`select team from public.players where room_id = ${room.id}`),
      // Everything this team has already put on the board, so a re-reported kill - or a square the
      // player clicked manually before the mod got to it - is skipped rather than duplicated.
      rows<{ cell_index: number }>(sql`
        select cell_index from public.attacks where room_id = ${room.id} and attacker_team = ${seat.team}`),
      // The start marker, room-wide rather than keyed to this player - see MATCH_START_MARKER. Every
      // room reaches 'battle' with one already written (startBattle checks the insert before
      // flipping status), so a live match missing one here is the rare room from before the marker
      // existed. Read up front because nothing below changes it.
      rows<{ created_at: string }>(sql`
        select created_at from public.attacks
        where room_id = ${room.id} and cell_index = ${MATCH_START_MARKER}
        limit 1`),
    ])
    const defenders = activeTeams(roster).filter((t) => t !== seat.team)
    const alreadyFired = new Set(mine.map((a) => a.cell_index))
    const matchStartedAt: string | null = markerRow?.created_at ?? null

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
        const shots = defenders.map((defender_team) => ({
          room_id: room.id,
          cell_index: cell,
          attacker_team: seat.team,
          defender_team,
          attacker_player_id: seat.id,
          created_at: at,
          // Marks this shot as timed off a real kill event rather than a manual click - see
          // the 20260920 migration. Only this path should ever set it.
          auto: true,
        }))
        // Not through rows(): an insert can't sit in a subquery, and a uuid comes back a string anyway.
        let inserted: { id: string }[]
        try {
          inserted = (await sql`
            insert into public.attacks ${sql(shots)}
            on conflict (room_id, attacker_team, defender_team, cell_index) do nothing
            returning id`) as unknown as { id: string }[]
        } catch {
          skipped.push({ flag, reason: 'insert_failed' })
          continue
        }
        if (inserted.length === 0) {
          // Every defender's row already existed - a race with another poll (or a manual click
          // that beat the mod to it) got here first. Nothing landed, so there is nothing to resolve.
          alreadyFired.add(cell)
          skipped.push({ flag, reason: 'already_fired' })
          continue
        }

        // Each opposing fleet's row resolves on its own, so they go together rather than in turn.
        // A failed resolution reads as no verdict, as a failed RPC did - the shot has landed regardless.
        const results = await Promise.all(
          inserted.map((row) =>
            sql`select public.resolve_attack(${row.id}::uuid) as result`
              .then(([r]) => (r?.result ?? null) as string | null)
              .catch(() => null)
          )
        )
        let verdict: string | null = null
        for (const result of results) {
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

    // The tally has to wait for the shots above; the bests do not depend on it, so the two are
    // read together.
    const [tally, bests] = await Promise.all([
      liveStats(room.id, seat.id, room),
      loadBests(tokenRow.user_id, room, matchStartedAt),
    ])
    // Spread rather than assigned, so a captain with no PBs gets no `pb` key at all - which is how
    // the overlay knows to draw no PB line, and how an older DLL never sees a field it can't read.
    const pb = bests ? pbPayload(bests, tally) : null

    return jsonResponse({
      ok: true,
      fired,
      skipped,
      tally,
      ...(pb ?? {}),
      clock: computeClock(room, matchStartedAt, Date.now()),
    })
  } catch (err) {
    return jsonResponse({ ok: false, error: 'internal', detail: String(err) }, 500)
  }
})
