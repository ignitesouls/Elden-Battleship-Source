/**
 * Reproduces the "logged out after refresh" bug, and checks the proposed fix.
 *
 * The edge function writes the Twitch identity server-side with admin.updateUserById. The browser
 * then calls getUser(), which fetches the updated record over the network and hands it back - but
 * auth-js's _getUser never calls _saveSession, so the session sitting in localStorage keeps the
 * user object it was created with: an anonymous user with empty metadata.
 *
 * So the UI is correct until the page reloads. On reload getSession() returns that stored object,
 * profileFromUser() finds no twitch_id and no identity, and the player looks signed out - until the
 * access token happens to expire and autoRefreshToken pulls a fresh one.
 *
 * Uses a throwaway anonymous user and an in-memory store standing in for localStorage, so what is
 * persisted can be inspected directly. Cleans up after itself.
 *
 *   node scripts/repro-stale-session.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match) env[match[1]] = match[2]
  }
  return env
}

const env = loadEnv('../.env.local')

// Stand-in for localStorage, so "what would survive a refresh" is directly observable.
const store = new Map()
const memoryStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
}

const client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { storage: memoryStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
})
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/** What a page reload would actually read back. */
function persistedMetadata() {
  for (const [key, value] of store) {
    if (!key.includes('auth-token')) continue
    try {
      const parsed = JSON.parse(value)
      return parsed?.user?.user_metadata ?? parsed?.currentSession?.user?.user_metadata ?? null
    } catch {
      return null
    }
  }
  return null
}

let userId = null
let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`)
}

try {
  const { data: anon } = await client.auth.signInAnonymously()
  userId = anon.user.id
  console.log(`\nThrowaway anonymous user ${userId}\n${'='.repeat(70)}\n`)

  // What the edge function does.
  await admin.auth.admin.updateUserById(userId, {
    user_metadata: { twitch_id: '999', twitch_login: 'repro', display_name: 'Repro' },
  })
  console.log('Wrote twitch metadata server-side (as twitch-login does)\n')

  // -- The bug ----------------------------------------------------------------
  console.log('=== Current behavior ===\n')
  const { data: fetched } = await client.auth.getUser()
  check(
    'getUser() sees the new metadata (so the UI updates)',
    Boolean(fetched?.user?.user_metadata?.twitch_id),
    `twitch_id = ${JSON.stringify(fetched?.user?.user_metadata?.twitch_id)}`
  )

  const beforeFix = persistedMetadata()
  check(
    'BUG: what a reload would read has NO twitch_id',
    !beforeFix?.twitch_id,
    `persisted metadata = ${JSON.stringify(beforeFix)}`
  )

  const { data: reloaded } = await client.auth.getSession()
  check(
    'BUG: getSession() (what runs on reload) reports signed-out',
    !reloaded?.session?.user?.user_metadata?.twitch_id,
    'profileFromUser() would return isTwitch: false here'
  )

  // -- The fix ----------------------------------------------------------------
  console.log('\n=== With refreshSession() ===\n')
  const { data: refreshed, error: refreshError } = await client.auth.refreshSession()
  check(
    'refreshSession() returns the updated user',
    !refreshError && Boolean(refreshed?.user?.user_metadata?.twitch_id),
    refreshError ? refreshError.message : `twitch_id = ${refreshed?.user?.user_metadata?.twitch_id}`
  )

  const afterFix = persistedMetadata()
  check(
    'FIXED: persisted session now carries twitch_id',
    Boolean(afterFix?.twitch_id),
    `persisted metadata = ${JSON.stringify(afterFix)}`
  )

  const { data: reloadedAfter } = await client.auth.getSession()
  check(
    'FIXED: getSession() now reports signed-in across a reload',
    Boolean(reloadedAfter?.session?.user?.user_metadata?.twitch_id),
    `twitch_id = ${reloadedAfter?.session?.user?.user_metadata?.twitch_id}`
  )
} catch (err) {
  check('Unexpected error', false, String(err))
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {})
  console.log(`\n${'='.repeat(70)}`)
  console.log(failures === 0 ? 'Diagnosis confirmed; refreshSession() is the fix.' : `${failures} check(s) unexpected.`)
  console.log('='.repeat(70))
  process.exit(failures === 0 ? 0 : 1)
}
