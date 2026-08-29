/**
 * The billed-side egress for one match's exact window.
 *
 * -- What this reads --------------------------------------------------------------------------------
 *
 * Supabase's own logs carry a byte count on every HTTP response: `edge_logs` has the whole request
 * and response, headers included, and `content_length` on the response headers is the number that
 * was actually on the wire. That is the same number the Usage page adds up. It is reachable through
 * the Management API's analytics endpoint, which takes SQL and a time window - so unlike the Usage
 * page, which only resolves to a day, this can be pointed at a single match.
 *
 * That is the whole reason this function exists. `egress_samples` measures what clients received;
 * this measures what Supabase says it sent. Two independent numbers for the same window, and a
 * disagreement between them is a finding rather than an inconvenience.
 *
 * -- What it cannot tell you ------------------------------------------------------------------------
 *
 * Realtime. Websocket traffic is not in `edge_logs` and there is no byte count for it in any log
 * Supabase exposes, at any plan. For a live match that is the larger half - see the egress_samples
 * migration - and the client meter is the only way to see it. This function covers REST, auth and
 * storage exactly, and realtime not at all. The panel says so rather than presenting the total as
 * the answer.
 *
 * The other limit is retention: log rows live one day on Free and seven on Pro. A match older than
 * that returns zero rows, which is indistinguishable from a match that cost nothing - so the
 * response carries `retentionWarning` when the window starts before the plan's horizon could
 * plausibly reach, and the panel refuses to render a zero as a measurement.
 *
 * -- Why the token lives here ------------------------------------------------------------------------
 *
 * A Supabase personal access token is an ORGANISATION-wide credential. It can read and change every
 * project on the account, which is a great deal more than "how many bytes did Tuesday cost". It
 * therefore never goes near the browser: it is a function secret, this function is the only thing
 * that holds it, and the only thing it will do with it is run the one read-only query below. The
 * caller is checked for admin first, and the SQL is built here rather than accepted from the client -
 * an endpoint that ran caller-supplied SQL against the Management API would be a hole with a token
 * behind it.
 *
 * Set it with:
 *   npx supabase secrets set EGRESS_MANAGEMENT_TOKEN=sbp_... --project-ref <ref>
 *
 * The name deliberately does not begin with SUPABASE_. That prefix is reserved for the values the
 * platform injects itself - SUPABASE_URL, SUPABASE_ANON_KEY and the rest - and `secrets set`
 * refuses to create anything inside it, so the obvious name for this could never have been set.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'

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
 * Total bytes and requests in the window.
 *
 * The triple `unnest` is how Supabase's log schema is shaped rather than anything clever: metadata,
 * response and headers are each a repeated field of one element, so they have to be flattened before
 * `content_length` is reachable. `safe_cast` because the header arrives as a string and is absent on
 * a chunked response - a plain cast turns one missing header into a failed query.
 */
const TOTALS_SQL = `
select
  count(*) as requests,
  sum(coalesce(safe_cast(h.content_length as int64), 0)) as bytes,
  countif(h.content_length is null) as without_length
from edge_logs
  cross join unnest(metadata) as m
  cross join unnest(m.response) as r
  cross join unnest(r.headers) as h
`

/**
 * The same window broken down by what was being asked for.
 *
 * This is the half that turns a number into a decision. "The match cost 40 MB" prompts nothing; "31
 * of it was /rest/v1/match_events" names the fetch to go and fix. Capped at the top twenty paths
 * because the tail is auth refreshes and one-row reads, and the analytics endpoint charges the same
 * for a long answer as a short one.
 */
const BY_PATH_SQL = `
select
  req.path as path,
  count(*) as requests,
  sum(coalesce(safe_cast(h.content_length as int64), 0)) as bytes
from edge_logs
  cross join unnest(metadata) as m
  cross join unnest(m.request) as req
  cross join unnest(m.response) as r
  cross join unnest(r.headers) as h
group by path
order by bytes desc
limit 20
`

interface AnalyticsResult {
  result?: unknown[]
  error?: unknown
}

/** One analytics query, windowed. Errors are surfaced rather than swallowed - a silent zero here reads as "the match was free". */
async function runLogQuery(
  ref: string,
  token: string,
  sql: string,
  startIso: string,
  endIso: string
): Promise<unknown[]> {
  const url = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all`)
  url.searchParams.set('sql', sql)
  url.searchParams.set('iso_timestamp_start', startIso)
  url.searchParams.set('iso_timestamp_end', endIso)

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const body = (await res.json().catch(() => ({}))) as AnalyticsResult

  if (!res.ok) {
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : ((body?.error as { message?: string })?.message ?? `HTTP ${res.status}`)
    throw new Error(detail)
  }
  if (body.error) {
    const detail =
      typeof body.error === 'string'
        ? body.error
        : ((body.error as { message?: string })?.message ?? 'analytics error')
    throw new Error(detail)
  }
  return body.result ?? []
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // The caller's own token, so is_admin() answers about the person asking. Same shape as
    // balance-stats: a claim in the body would be worth nothing.
    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: userData } = await caller.auth.getUser()
    if (!userData?.user) return jsonResponse({ error: 'not_signed_in' }, 401)

    const { data: isAdmin } = await caller.rpc('is_admin')
    if (!isAdmin) return jsonResponse({ error: 'not_admin' }, 403)

    const token = Deno.env.get('EGRESS_MANAGEMENT_TOKEN')
    if (!token) return jsonResponse({ error: 'no_management_token' }, 501)

    /**
     * The project to ask about, derived from SUPABASE_URL rather than configured separately.
     * A second secret naming the ref would be one more thing to get wrong, and the function is
     * always deployed into the project it is reporting on.
     *
     * The override is spelled EGRESS_PROJECT_REF for the same reason as the token above: a
     * SUPABASE_-prefixed name is one `secrets set` will not accept, so an override under that name
     * would have been unsettable and the fallback would have been the only path that ever ran.
     */
    const ref =
      Deno.env.get('EGRESS_PROJECT_REF') ??
      new URL(Deno.env.get('SUPABASE_URL')!).hostname.split('.')[0]

    const body = (await req.json().catch(() => ({}))) as { startedAt?: unknown; endedAt?: unknown }
    const start = typeof body.startedAt === 'string' ? new Date(body.startedAt) : null
    const end = typeof body.endedAt === 'string' ? new Date(body.endedAt) : null
    if (!start || !end || Number.isNaN(+start) || Number.isNaN(+end) || +end <= +start) {
      return jsonResponse({ error: 'bad_window' }, 400)
    }
    // A day is both the Free plan's whole retention and more than any match has ever run. A wider
    // window would be a report about a period rather than about a match, and the analytics endpoint
    // is happier with a bounded one.
    if (+end - +start > 24 * 60 * 60 * 1000) return jsonResponse({ error: 'window_too_wide' }, 400)

    const startIso = start.toISOString()
    const endIso = end.toISOString()

    const [totals, byPath] = await Promise.all([
      runLogQuery(ref, token, TOTALS_SQL, startIso, endIso),
      runLogQuery(ref, token, BY_PATH_SQL, startIso, endIso),
    ])

    const head = (totals[0] ?? {}) as { requests?: number; bytes?: number; without_length?: number }

    return jsonResponse({
      window: { startedAt: startIso, endedAt: endIso },
      requests: Number(head.requests ?? 0),
      bytes: Number(head.bytes ?? 0),
      /**
       * Responses whose headers carried no Content-Length, so they contributed zero to the total.
       * Reported rather than hidden: a large count here means the number below it is a floor.
       */
      withoutLength: Number(head.without_length ?? 0),
      byPath: (byPath as Array<{ path?: string; requests?: number; bytes?: number }>).map((r) => ({
        path: r.path ?? '(unknown)',
        requests: Number(r.requests ?? 0),
        bytes: Number(r.bytes ?? 0),
      })),
      /**
       * Log retention is a day on Free and seven on Pro, and a window past the horizon returns an
       * empty result rather than an error - which would otherwise render as a match that cost
       * nothing. The client refuses to show a zero carrying this flag as a measurement.
       */
      retentionWarning: Number(head.requests ?? 0) === 0,
      /** Realtime is not in edge_logs at all. Stated in the payload so the UI cannot forget to say it. */
      covers: 'rest-auth-storage',
    })
  } catch (e) {
    return jsonResponse({ error: 'failed', detail: (e as Error).message }, 500)
  }
})
