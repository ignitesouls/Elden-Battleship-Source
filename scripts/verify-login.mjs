/**
 * Post-login verification for the scope-free Twitch flow.
 *
 * Answers three questions that "it looks like it worked" cannot:
 *
 *   1. Which flow actually ran? The built-in provider creates a real Supabase identity
 *      (provider 'twitch'); the new one writes only user_metadata. They are trivially
 *      distinguishable after the fact, and a page served from cache could still be running
 *      the old bundle.
 *   2. Was an email address collected? This is the entire objective. The anonymous user the
 *      identity attaches to has no email, so the field staying empty is direct proof that
 *      Twitch never handed one over.
 *   3. Is the owner grant intact? It is keyed on profiles.twitch_id and moved by reclaim().
 *      Owner tier is seeded from SQL and cannot be regranted from inside the site.
 *
 * Read-only.
 *
 *   node scripts/verify-login.mjs
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
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Working backwards from `profiles` rather than listing auth users: only a Twitch sign-in creates a
// profile row, so this is a short list, whereas the auth table is mostly anonymous sessions.
const { data: profiles, error } = await admin
  .from('profiles')
  .select('id, twitch_id, display_name, avatar_url, created_at, updated_at')
  .order('updated_at', { ascending: false })

if (error) {
  console.error(`Could not read profiles: ${error.message}`)
  process.exit(1)
}

console.log(`\n${profiles.length} profile row(s)\n${'='.repeat(70)}\n`)

const { data: admins } = await admin.from('admins').select('user_id, display_name, is_owner')
const adminById = new Map((admins ?? []).map((a) => [a.user_id, a]))

let newFlow = 0
let legacyFlow = 0
let emailsHeld = 0

for (const profile of profiles) {
  const { data: userData } = await admin.auth.admin.getUserById(profile.id)
  const user = userData?.user
  const meta = user?.user_metadata ?? {}
  const providers = (user?.identities ?? []).map((i) => i.provider)
  const hasTwitchIdentity = providers.includes('twitch')
  const usesMetadata = Boolean(meta.twitch_id)

  const flow = !user
    ? 'ORPHAN (no auth user)'
    : hasTwitchIdentity
      ? 'LEGACY built-in provider'
      : usesMetadata
        ? 'NEW scope-free flow'
        : 'UNKNOWN (neither marker)'

  if (flow.startsWith('NEW')) newFlow++
  if (flow.startsWith('LEGACY')) legacyFlow++
  if (user?.email) emailsHeld++

  const grant = adminById.get(profile.id)

  console.log(`${profile.display_name}  (twitch_id ${profile.twitch_id})`)
  console.log(`  uuid          ${profile.id}`)
  console.log(`  flow          ${flow}`)
  console.log(`  email held    ${user?.email ? `YES -> ${user.email}` : 'no (nothing was collected)'}`)
  console.log(`  anonymous     ${user?.is_anonymous ?? 'n/a'}`)
  console.log(`  identities    ${providers.length ? providers.join(', ') : 'none'}`)
  console.log(`  metadata      ${Object.keys(meta).length ? Object.keys(meta).sort().join(', ') : 'empty'}`)
  console.log(`  avatar        ${profile.avatar_url ? 'set' : 'MISSING'}`)
  console.log(`  admin         ${grant ? (grant.is_owner ? 'OWNER' : 'admin') : 'no'}`)
  console.log(`  last updated  ${profile.updated_at}`)
  console.log()
}

// -- Owner integrity ----------------------------------------------------------
console.log('='.repeat(70))
const ownerProfile = profiles.find((p) => p.twitch_id === '139068303')
if (!ownerProfile) {
  console.log('WARNING  No profile carries twitch_id 139068303 (KCBrazos).')
} else if (!adminById.get(ownerProfile.id)?.is_owner) {
  console.log(`WARNING  ${ownerProfile.display_name} holds no owner row at uuid ${ownerProfile.id}.`)
  console.log('         reclaim() should have moved it. Owner tier cannot be regranted in-app.')
} else {
  console.log(`Owner intact: ${ownerProfile.display_name} -> ${ownerProfile.id}`)
}

// -- Orphaned admin rows ------------------------------------------------------
// An admins row whose uuid no longer has a profile is the signature of a reclaim that moved the
// profile but left the grant behind.
const stranded = (admins ?? []).filter((a) => !profiles.some((p) => p.id === a.user_id))
if (stranded.length) {
  console.log(`\nWARNING  ${stranded.length} admin row(s) point at a uuid with no profile:`)
  for (const s of stranded) console.log(`         ${s.display_name ?? '(unnamed)'} -> ${s.user_id}`)
}

// -- Verdict ------------------------------------------------------------------
console.log('\n' + '='.repeat(70))
console.log(`new flow: ${newFlow}   legacy: ${legacyFlow}   holding an email: ${emailsHeld}`)
if (emailsHeld > 0) {
  console.log('\nAn account still holds an email address. That predates the switch (the new flow')
  console.log('cannot collect one) - but it means the built-in provider was used at some point.')
}
if (legacyFlow > 0) {
  console.log('\nAccounts on the legacy provider will move to the new flow next time they sign in.')
}
console.log('='.repeat(70))
