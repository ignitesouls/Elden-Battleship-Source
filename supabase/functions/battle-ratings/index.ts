/**
 * One archived match's battle ratings, from a stored snapshot that follows the archive.
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
  prepareEvents,
  prepareParticipants,
  rateEveryBoard,
  RATING_CODE_VERSION,
  type BattleRating,
  type BoardSource,
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
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = (await req.json().catch(() => ({}))) as { matchKey?: unknown; set?: unknown }
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
