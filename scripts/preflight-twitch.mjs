/**
 * Pre-flight checks for the scope-free Twitch login.
 *
 * Everything the switchover depends on EXCEPT the one thing that genuinely needs a human: clicking
 * "Authorize" on Twitch's consent screen while logged into Twitch. This script verifies the setup
 * around that click, so the click either works or fails for a reason you already know about.
 *
 * Safe to re-run at any point - it only reads. The single write is an anonymous auth session, which
 * is exactly what every visitor to the site creates just by loading the page.
 *
 *   node scripts/preflight-twitch.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const PROD_URI = 'https://kcbrazos.github.io/Elden-Battleship/'
const DEV_URI = 'http://localhost:5173/Elden-Battleship/'

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match) env[match[1]] = match[2]
  }
  return env
}

const env = loadEnv('../.env.local')
const results = []

function record(step, ok, detail) {
  results.push({ step, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${step}\n        ${detail}\n`)
}

// -- 1. Client ID present in the build env ------------------------------------
console.log('\n=== 1. Client ID (step 4) ===\n')
const clientId = env.VITE_TWITCH_CLIENT_ID
if (!clientId) {
  record('VITE_TWITCH_CLIENT_ID set', false, 'Missing from .env.local - the login button ships disabled.')
} else {
  record('VITE_TWITCH_CLIENT_ID set', true, `${clientId.slice(0, 6)}... (${clientId.length} chars)`)
}

// -- 2. Twitch accepts the client ID + each redirect URI ----------------------
// A registered URI gets you the login/consent page; an unregistered one gets a parameter error.
// This is the check that catches a missing trailing slash before a player ever sees it.
console.log('=== 2. Twitch redirect URLs (step 1) ===\n')

async function checkRedirect(label, redirectUri) {
  if (!clientId) return record(`Twitch accepts ${label}`, false, 'Skipped - no client ID.')
  const url = new URL('https://id.twitch.tv/oauth2/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', '')
  url.searchParams.set('state', 'preflight')

  try {
    const res = await fetch(url, { redirect: 'manual' })
    const body = await res.text()
    const blob = `${res.status} ${body.slice(0, 400)}`

    if (/redirect_mismatch|does not match|invalid redirect/i.test(blob)) {
      return record(`Twitch accepts ${label}`, false, `Not registered (or trailing slash differs): ${redirectUri}`)
    }
    if (/invalid client|client does not exist/i.test(blob)) {
      return record(`Twitch accepts ${label}`, false, 'Twitch rejected the Client ID itself.')
    }
    if (res.status >= 400) {
      return record(`Twitch accepts ${label}`, false, `HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    record(`Twitch accepts ${label}`, true, `HTTP ${res.status} - registered, and empty scope accepted.`)
  } catch (err) {
    record(`Twitch accepts ${label}`, false, `Request failed: ${err}`)
  }
}

await checkRedirect('production URI', PROD_URI)
await checkRedirect('localhost URI', DEV_URI)

// -- 3. Anonymous auth still works --------------------------------------------
console.log('=== 3. Anonymous sign-in ===\n')
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const { data: anon, error: anonError } = await supabase.auth.signInAnonymously()
if (anonError || !anon?.user) {
  record('Anonymous sign-in', false, `${anonError?.message ?? 'no user returned'} - the whole flow needs this.`)
} else {
  record('Anonymous sign-in', true, `Session for ${anon.user.id}`)
}

// -- 4. Edge function deployed ------------------------------------------------
// Unauthenticated on purpose: the platform's JWT gate answers 401 for a function that exists and
// 404 for one that doesn't, which distinguishes "deployed" from "not deployed" without a token.
console.log('=== 4. Edge function deployed (step 2) ===\n')
const fnUrl = `${env.VITE_SUPABASE_URL}/functions/v1/twitch-login`
let deployed = false
try {
  const res = await fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (res.status === 404) {
    record('twitch-login deployed', false, 'HTTP 404 - not deployed yet (step 2).')
  } else {
    deployed = true
    record('twitch-login deployed', true, `HTTP ${res.status} - function exists and the JWT gate is active.`)
  }
} catch (err) {
  record('twitch-login deployed', false, `Request failed: ${err}`)
}

// -- 5. Twitch secrets correct ------------------------------------------------
// Sends a deliberately invalid authorization code. Twitch's rejection message differs depending on
// WHY it failed, and that difference is the test: complaining about the code means it was satisfied
// with the credentials, which is the only part we cannot otherwise see.
console.log('=== 5. Edge function secrets (step 3) ===\n')
if (!deployed || !anon?.session) {
  record('TWITCH_CLIENT_ID / SECRET', false, 'Skipped - needs the function deployed and a session.')
} else {
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${anon.session.access_token}`,
      apikey: env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ code: 'preflight-invalid-code', redirectUri: PROD_URI }),
  })
  const body = await res.text()

  if (/invalid client|client secret|forbidden/i.test(body)) {
    record('TWITCH_CLIENT_ID / SECRET', false, `Twitch rejected the credentials: ${body.slice(0, 250)}`)
  } else if (/invalid authorization code|invalid code/i.test(body)) {
    record(
      'TWITCH_CLIENT_ID / SECRET',
      true,
      'Twitch rejected only the fake code, not the credentials - secrets are correct.'
    )
  } else if (/Missing code or redirectUri/i.test(body)) {
    record('TWITCH_CLIENT_ID / SECRET', false, 'Function did not receive the body - check the deployed source.')
  } else {
    record('TWITCH_CLIENT_ID / SECRET', false, `Unrecognized response (HTTP ${res.status}): ${body.slice(0, 250)}`)
  }
}

// -- 6. Reclaim preconditions -------------------------------------------------
// Read-only. Confirms the tables and columns the function writes to are really there, under the
// names the code uses, and reports the owner row that step 7 of the checklist depends on.
console.log('=== 6. Reclaim preconditions (steps 6-7) ===\n')
if (env.SUPABASE_SERVICE_ROLE_KEY) {
  const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  for (const [table, column] of [
    ['profiles', 'id, twitch_id, display_name'],
    ['match_participants', 'user_id'],
    ['match_events', 'user_id'],
    ['admins', 'user_id, is_owner'],
  ]) {
    const { error } = await admin.from(table).select(column).limit(1)
    record(`${table} (${column})`, !error, error ? error.message : 'Present, and reachable by the service role.')
  }

  const { data: owner } = await admin
    .from('profiles')
    .select('id, display_name')
    .eq('twitch_id', '139068303')
    .maybeSingle()
  record(
    'Owner profile (twitch_id 139068303)',
    Boolean(owner),
    owner
      ? `${owner.display_name} -> ${owner.id}. Re-run after signing in; this uuid should follow you.`
      : 'No profile row yet - expected only if the owner has never signed in.'
  )
} else {
  record('Schema checks', false, 'Skipped - no SUPABASE_SERVICE_ROLE_KEY in .env.local.')
}

// -- Tidy up ------------------------------------------------------------------
// The session in check 3 is a real anonymous user. Harmless - it is what every visitor creates just
// by opening the site - but this script is meant to be re-run after each dashboard step, and one
// user per run would accumulate for no reason.
if (anon?.user && env.SUPABASE_SERVICE_ROLE_KEY) {
  const cleaner = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
  const { error } = await cleaner.auth.admin.deleteUser(anon.user.id)
  if (error) console.log(`  note  Could not remove the test session ${anon.user.id}: ${error.message}\n`)
}

// -- Summary ------------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log('='.repeat(70))
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\nOutstanding:')
  for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`)
} else {
  console.log('\nEverything checkable from here is green. The consent screen still needs your eyes.')
}
console.log('='.repeat(70))
