/**
 * One archived match's battle ratings, from a stored snapshot that follows the archive - and, from the
 * same snapshot, team power for a list of players (body `{ players: [...] }`; see storePowers and
 * src/lib/tournament/teamPower.ts), which the tournament pages put lines on matches with.
 *
 * -- Why this exists -------------------------------------------------------------------------------
 *
 * A rating ranks a captain's game against every rated game on the same board, so a recap cannot rate
 * its match from the match alone. It used to download the whole shot log to do it: ~37,000 rows at the
 * PostgREST cap of 1,000 a page, about forty requests per recap, for every player at the end of every
 * match. In October 2026 that was a fifth of the project's API-gateway log volume on its own, and
 * Supabase began metering log ingest - and the cost grew with every match archived.
 *
 * Now the recap makes one request here. The rating itself still moves with the archive: the snapshot
 * carries a fingerprint of what it was computed from, and anything that changes the inputs - a match
 * archived, voided or unvoided, an admin deleting or re-timing a shot, a deploy that changed the rating
 * code - changes the fingerprint, and the next request recomputes. So the recap still agrees with the
 * Hall of Fame about the same game, which is the reason ratings were never frozen at archive time.
 *
 * -- Why the database directly, not supabase-js ---------------------------------------------------
 *
 * A recompute reads the whole archive. Through the REST API that is the same forty paged requests the
 * browser was making, each one a gateway log line; over SUPABASE_DB_URL it is three queries and no
 * gateway traffic at all. The rows are built with json_agg, which is what PostgREST uses to build its
 * responses, so timestamps and numbers reach the rating code in exactly the shape the browser gets
 * them - rateBattles orders on the finished_at STRING, and a Date here would quietly reorder ties.
 *
 * -- The rating code ------------------------------------------------------------------------------
 *
 * ratingCode.generated.js is src/lib/battleRatingBoards.ts bundled by scripts/build-rating-bundle.mjs,
 * not a copy of it - see that script for why it cannot simply be imported like auto-fire's helpers.
 * A full recompute is about 150ms of CPU at 37k shots and grows linearly, against a budget of ~2s.
 */
import postgres from 'npm:postgres@3.4.7'
import {
  playerPower,
  POWER_PARAMS,
  prepareEvents,
  prepareParticipants,
  rateEveryBoard,
  replayElo,
  RATING_CODE_VERSION,
  type BattleRating,
  type BoardSource,
  type PowerGame,
} from './ratingCode.generated.js'

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

// Module scope, so a warm instance reuses its connection. `prepare: false` keeps it working through
// the transaction pooler as well as on a direct connection.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1 })

/**
 * The browser's caps, mirrored: fetchMatchEvents reads at most 50,000 shot rows and fetchParticipants
 * 20,000, both newest first and BEFORE voided matches are dropped. Reading more here would rate against
 * a larger field than the Hall of Fame does once the archive passes them. Raise them together or not
 * at all - see profiles.ts.
 */
const EVENT_LIMIT = 50000
const PARTICIPANT_LIMIT = 20000

/** Any recompute holds this, so a match's worth of players opening the recap at once costs one. */
const LOCK_KEY = 'battle_rating_snapshots'

/**
 * Everything the ratings read, boiled down. Cheap - three aggregates over indexed tables - and run on
 * every request, which is what lets the snapshot follow the archive without a trigger or a cron.
 *
 * Counts catch archives and deletions, the sums catch an admin re-timing or moving a shot and a
 * corrected participation row, the void list catches voids in either direction, and the code version
 * catches a deploy that changed the formula.
 */
async function fingerprint(tx: postgres.Sql | postgres.TransactionSql): Promise<string> {
  const [row] = await tx`
    select md5(concat_ws('|',
      (select concat_ws(':', count(*), sum(match_seconds), sum(cell_index), max(finished_at))
         from public.match_events),
      (select concat_ws(':', count(*), sum(shots), sum(hits), sum(sunk),
                        count(*) filter (where won), count(*) filter (where draw))
         from public.match_participants),
      (select string_agg(match_key, ',' order by match_key) from public.voided_matches),
      ${RATING_CODE_VERSION}::text
    )) as fp`
  return row.fp as string
}

interface Stored {
  fingerprint: string | null
  weights: Record<string, number> | null
  ratings: unknown[] | null
}

/**
 * The snapshot's fingerprint, and one tab's weights and one match's ratings out of it.
 *
 * The fingerprint is read off ANY row, not the tab's own: every row is written in the same recompute,
 * and a tab nobody has played a rated game on has no row at all - reading freshness off it would make
 * every request for that tab look stale and recompute for ever.
 */
async function readSnapshot(tx: postgres.Sql | postgres.TransactionSql, set: string, matchKey: string) {
  const [row] = await tx<Stored[]>`
    select (select fingerprint from public.battle_rating_snapshots limit 1) as fingerprint,
           (select weights from public.battle_rating_snapshots where square_set = ${set}::text) as weights,
           (select ratings -> ${matchKey}::text from public.battle_rating_snapshots
             where square_set = ${set}::text) as ratings`
  return row
}

/** Rates every tab from the live archive and replaces the whole snapshot with the result. */
async function recompute(tx: postgres.TransactionSql, fp: string): Promise<void> {
  const [[parts], [events], sources] = await Promise.all([
    tx`
      select coalesce(json_agg(t), '[]'::json) as rows from (
        select match_key, user_id, nickname, team, won, draw, shots, hits, misses, sunk,
               team_ships_lost, awards, room_code, finished_at, square_set
          from (select * from public.match_participants
                 order by finished_at desc, id desc limit ${PARTICIPANT_LIMIT}) p
         where match_key not in (select match_key from public.voided_matches)
         order by finished_at desc, id desc
      ) t`,
    tx`
      select coalesce(json_agg(t), '[]'::json) as rows from (
        select match_key, user_id, nickname, team, cell_index, challenge_name, result, match_seconds,
               board_size, finished_at, square_set, auto
          from (select * from public.match_events
                 order by finished_at desc, id desc limit ${EVENT_LIMIT}) e
         where match_key not in (select match_key from public.voided_matches)
         order by finished_at desc, id desc
      ) t`,
    // board_dealt_at as ISO text, the shape the browser gets it in: postgres.js would hand back a Date,
    // and dealtPool reads a string.
    tx<BoardSource[]>`select match_key, room_id, board_seed, board_perm,
                             to_json(board_dealt_at) #>> '{}' as board_dealt_at
                        from public.match_board_sources`,
  ])

  const boards = rateEveryBoard(
    prepareParticipants(parts.rows),
    prepareEvents(events.rows, new Map(sources.map((s) => [s.match_key, s])))
  )

  await tx`delete from public.battle_rating_snapshots`
  for (const [set, board] of boards) {
    const byMatch: Record<string, BattleRating[]> = {}
    for (const r of board.ratings) (byMatch[r.matchKey] ??= []).push(r)
    await tx`
      insert into public.battle_rating_snapshots (square_set, fingerprint, weights, ratings)
      values (${set}, ${fp}, ${tx.json(Object.fromEntries(board.weights))}, ${tx.json(byMatch)})`
  }

  await storePowers(tx, fp, parts.rows, boards)
}

/** Keyed like a career (participantKey): the account, or the name for a game played signed out. */
const playerKey = (userId: string | null | undefined, nickname: string) => userId ?? `name:${String(nickname).trim().toLowerCase()}`

/**
 * Every player's team power, from the same rows the ratings were just made from: Elo by replaying every
 * game in order, plus their battle ratings across every board. See src/lib/tournament/teamPower.ts.
 */
async function storePowers(
  tx: postgres.TransactionSql,
  fp: string,
  // deno-lint-ignore no-explicit-any
  parts: any[],
  boards: Map<string, { ratings: BattleRating[] }>,
): Promise<void> {
  const byMatch = new Map<string, PowerGame>()
  for (const p of parts) {
    const game = byMatch.get(p.match_key) ?? { matchKey: p.match_key, finishedAt: p.finished_at, players: [] }
    game.players.push({ key: playerKey(p.user_id, p.nickname), team: p.team, won: !!p.won, draw: !!p.draw })
    byMatch.set(p.match_key, game)
  }
  const elo = replayElo([...byMatch.values()], POWER_PARAMS.k)

  const battles = new Map<string, number[]>()
  for (const board of boards.values()) {
    for (const r of board.ratings) {
      const k = playerKey(r.userId as string | null, r.nickname as string)
      const list = battles.get(k) ?? []
      list.push(r.rating as number)
      battles.set(k, list)
    }
  }

  const rows = [...new Set([...elo.keys(), ...battles.keys()])].map((key) => {
    const p = playerPower(elo.get(key), battles.get(key) ?? [])
    return { player_key: key, fingerprint: fp, elo: p.elo, games: p.games, battle: p.battle, power: p.power }
  })
  await tx`delete from public.player_power_snapshots`
  // In slices: one insert per few hundred players keeps each statement small.
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500)
    await tx`insert into public.player_power_snapshots ${tx(slice, 'player_key', 'fingerprint', 'elo', 'games', 'battle', 'power')}`
  }
}

/** The most players one request may ask about - a big event's every roster, with room to spare. */
const MAX_PLAYERS = 400

/** Recomputes everything if the archive has moved since the snapshot was taken. */
async function ensureFresh(): Promise<void> {
  const fp = await fingerprint(sql)
  const [row] = await sql`select (select fingerprint from public.battle_rating_snapshots limit 1) as fp`
  if (row.fp === fp) return
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}::text))`
    const now = await fingerprint(tx)
    const [again] = await tx`select (select fingerprint from public.battle_rating_snapshots limit 1) as fp`
    if (again.fp === now) return
    await recompute(tx, now)
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = (await req.json().catch(() => ({}))) as { matchKey?: unknown; set?: unknown; players?: unknown }

    // Team power for a list of players: { players: [key, ...] } -> { powers: { key: {...} } }. A player
    // missing from the answer has never played a counted game, and the page counts them as average.
    if (Array.isArray(body.players)) {
      const keys = body.players.filter((k): k is string => typeof k === 'string').slice(0, MAX_PLAYERS)
      if (keys.length === 0) return jsonResponse({ powers: {} })
      await ensureFresh()
      const rows = await sql`select player_key, elo, games, battle, power from public.player_power_snapshots
                              where player_key = any(${keys}::text[])`
      const powers: Record<string, { elo: number; games: number; battle: number | null; power: number }> = {}
      for (const r of rows) powers[r.player_key] = { elo: r.elo, games: r.games, battle: r.battle, power: r.power }
      return jsonResponse({ powers })
    }

    if (typeof body.matchKey !== 'string' || typeof body.set !== 'string') {
      return jsonResponse({ error: 'bad_request' }, 400)
    }
    const { matchKey, set } = body

    const fp = await fingerprint(sql)
    let row = await readSnapshot(sql, set, matchKey)

    if (row.fingerprint !== fp) {
      row = await sql.begin(async (tx) => {
        // Blocking, on purpose: whoever arrives second waits for the first recompute and then finds
        // it already done, instead of doing the same work again.
        await tx`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}::text))`
        const now = await fingerprint(tx)
        const again = await readSnapshot(tx, set, matchKey)
        if (again.fingerprint === now) return again
        await recompute(tx, now)
        return await readSnapshot(tx, set, matchKey)
      })
    }

    // No weights means a tab with no rated game; no ratings means a match that was not rated (a 1v1,
    // say). Both are answers, not errors - the scoreboard shows a dash.
    return jsonResponse({ weights: row.weights ?? {}, ratings: row.ratings ?? [] })
  } catch (e) {
    return jsonResponse({ error: 'failed', detail: (e as Error).message }, 500)
  }
})
