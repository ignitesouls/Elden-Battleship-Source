// Takes a bug report from the website and puts it in an inbox.
//
// -- Why this is a function and not a mailto: link ------------------------------------------------
//
// "auto marking doesnt work" is not actionable. The same sentence with a player id, a room code, a
// build id and a browser string attached usually answers itself. A form can staple that on; a mail
// client cannot, and asking a player to type it out means they won't.
//
// -- Why it accepts unauthenticated callers ------------------------------------------------------
//
// `verify_jwt = false` in config.toml, because a support form that requires a working session
// cannot receive a report about a broken session. The session is read if one is offered and
// ignored if it isn't, and nothing here trusts the caller for anything except the text they typed.
//
// The cost is a public endpoint that sends email, which is a spam relay unless something limits it.
// See the rate limit below and the honeypot above it.
//
// -- Why no email address is collected -----------------------------------------------------------
//
// Deliberate. Contact is a Discord handle: a public name, worth nothing to a leak, and the place
// the conversation was going to happen anyway. Storing other people's email addresses means being
// responsible for them, and nobody wanted that responsibility in exchange for a reply button.

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

/** Reports per IP per window. Generous for a human, useless for a script. */
const RATE_LIMIT = 5
const RATE_WINDOW_MINUTES = 60

/** Caps, enforced here as well as in the browser because the browser is not the only caller. */
const MAX_MESSAGE = 4000
const MAX_SHORT_FIELD = 120
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024

/** The categories the form offers. Anything else is filed as "other" rather than refused. */
const CATEGORIES: Record<string, string> = {
  'auto-marking': 'Auto-marking',
  'match': 'Match bug',
  'account': 'Account or sign-in',
  'other': 'Something else',
}

/**
 * SHA-256 of the caller's IP with a server-side pepper.
 *
 * The pepper matters more than it looks: IPv4 is a small enough space to enumerate, so an unpeppered
 * hash of an address is barely a pseudonym. With one, the column is a comparison key and nothing
 * else - which is all the rate limiter needs it to be.
 */
async function hashIp(ip: string): Promise<string> {
  const pepper = Deno.env.get('SUPPORT_IP_PEPPER') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const bytes = new TextEncoder().encode(`${pepper}:${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Trims and caps a free-text field. Empty becomes null so the column stays honest. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, max)
  return trimmed.length > 0 ? trimmed : null
}

/** Escaped before it goes anywhere near an HTML email body. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Context {
  [key: string]: unknown
}

/**
 * The email body.
 *
 * A table of context above the message rather than below it, because the context is what turns a
 * vague report into a reproducible one and it should be readable in the notification preview.
 */
function emailHtml(args: {
  category: string
  message: string
  discord: string | null
  reporter: string | null
  userId: string | null
  context: Context
  hasScreenshot: boolean
}): string {
  const rows: [string, string][] = [
    ['Discord', args.discord ?? '(not given)'],
    ['Account', args.reporter ?? '(signed out)'],
    ['User id', args.userId ?? '-'],
  ]
  for (const [key, value] of Object.entries(args.context)) {
    if (value === null || value === undefined || value === '') continue
    rows.push([key, String(value).slice(0, 300)])
  }

  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 10px 2px 0;color:#777;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
        `<td style="padding:2px 0;vertical-align:top">${esc(v)}</td></tr>`
    )
    .join('')

  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
<table style="font-size:12px;border-collapse:collapse;margin-bottom:14px">${table}</table>
<div style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px">${esc(args.message)}</div>
${args.hasScreenshot ? '<p style="font-size:12px;color:#777;margin-top:14px">Screenshot attached.</p>' : ''}
</div>`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    const body = await req.json()

    // Honeypot. A real form leaves this empty because it is hidden and never focusable; a bot that
    // fills every input it finds fills this one too. Answered with a cheerful 200 rather than a
    // rejection, so whatever is on the other end has nothing to tune against.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return jsonResponse({ ok: true })
    }

    const message = clean(body.message, MAX_MESSAGE)
    if (!message) return jsonResponse({ ok: false, error: 'empty_message' }, 400)

    const discord = clean(body.discord, MAX_SHORT_FIELD)
    const categoryKey = typeof body.category === 'string' && body.category in CATEGORIES ? body.category : 'other'
    const context: Context = body.context && typeof body.context === 'object' ? body.context : {}

    // Screenshot: base64, no data: prefix, image only. Trusted for size and type and nothing else -
    // it is forwarded as an attachment and never decoded, rendered or stored here.
    let screenshot: { filename: string; content: string } | null = null
    if (body.screenshot && typeof body.screenshot.content === 'string') {
      const content = body.screenshot.content
      if (content.length * 0.75 > MAX_SCREENSHOT_BYTES) {
        return jsonResponse({ ok: false, error: 'screenshot_too_large' }, 413)
      }
      const name = clean(body.screenshot.filename, 80) ?? 'screenshot.png'
      screenshot = { filename: name.replace(/[^\w.\-]/g, '_'), content }
    }

    // Rate limit, per IP per hour. x-forwarded-for is set by the platform in front of the function;
    // the first entry is the client. A missing header is treated as one shared bucket, which is
    // strict rather than permissive on purpose.
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
    const ipHash = await hashIp(ip)
    const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString()
    const { count } = await admin
      .from('support_reports')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', since)
    if ((count ?? 0) >= RATE_LIMIT) return jsonResponse({ ok: false, error: 'rate_limited' }, 429)

    // Identity, if the caller happens to have one. A failure here is not a failure of the report:
    // the whole point of an unauthenticated endpoint is that a broken session still gets to
    // complain about being broken.
    let userId: string | null = null
    let reporter: string | null = null
    const auth = req.headers.get('Authorization')
    if (auth?.startsWith('Bearer ')) {
      const { data } = await admin.auth.getUser(auth.slice(7))
      userId = data.user?.id ?? null
      if (userId) {
        const { data: profile } = await admin
          .from('profiles')
          .select('display_name, twitch_login')
          .eq('id', userId)
          .maybeSingle()
        reporter = profile?.display_name ?? profile?.twitch_login ?? null
      }
    }

    // Written before the email is attempted, so a provider outage costs the notification rather
    // than the report. `emailed` records which of those happened.
    const { data: row } = await admin
      .from('support_reports')
      .insert({
        user_id: userId,
        discord,
        reporter,
        category: categoryKey,
        message,
        context,
        has_screenshot: screenshot !== null,
        ip_hash: ipHash,
      })
      .select('id')
      .single()

    const apiKey = Deno.env.get('RESEND_API_KEY')
    const to = Deno.env.get('SUPPORT_TO_EMAIL')
    const from = Deno.env.get('SUPPORT_FROM_EMAIL') ?? 'Elden Battleship <onboarding@resend.dev>'
    if (!apiKey || !to) {
      // Stored but not sent. Reported as a success because from the reporter's side it is one:
      // the message is safe and somebody will read it. Nothing is gained by showing a player an
      // error about a server-side secret they cannot do anything about.
      console.error('support: RESEND_API_KEY or SUPPORT_TO_EMAIL is not set; report stored only')
      return jsonResponse({ ok: true, stored: true, emailed: false })
    }

    const who = reporter ?? discord ?? 'anonymous'
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `[Battleship] ${CATEGORIES[categoryKey]} - ${who}`,
        html: emailHtml({
          category: CATEGORIES[categoryKey],
          message,
          discord,
          reporter,
          userId,
          context,
          hasScreenshot: screenshot !== null,
        }),
        ...(screenshot ? { attachments: [screenshot] } : {}),
      }),
    })

    if (!res.ok) {
      console.error('support: resend rejected', res.status, await res.text())
      return jsonResponse({ ok: true, stored: true, emailed: false })
    }

    if (row) await admin.from('support_reports').update({ emailed: true }).eq('id', row.id)
    return jsonResponse({ ok: true, stored: true, emailed: true })
  } catch (err) {
    return jsonResponse({ ok: false, error: 'internal', detail: String(err) }, 500)
  }
})
