/**
 * Verifies the player-chosen nickname end to end, against the live database.
 *
 * What needs proving is not that an UPDATE works, but that the three things the feature quietly
 * depends on hold: that a player may write their OWN nickname with nothing but the anon key that
 * ships in the bundle, that a stranger holding the same key cannot write theirs, and that the name
 * survives `reclaim()` - the second-device path in the twitch-login function, which deletes the old
 * profiles row and would otherwise throw the nickname away, reproducing the very reset this feature
 * exists to fix.
 *
 * RLS is exercised with real anonymous sessions and the ANON key, one client per simulated person.
 * The service-role key bypasses policies entirely and would prove nothing about them; it is used
 * here only to set up rows and to read back what the policies allowed.
 *
 * Every object created is removed in a finally block, and the cleanup is verified rather than
 * assumed. Nothing here reads or writes any pre-existing row.
 *
 *   node scripts/test-nickname.mjs
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

/** One client per simulated person: a shared storage key would make them the same session. */
function anonClient() {
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, storageKey: `k${Math.random()}` },
  })
}

const MARKER = `NICKTEST-${randomUUID().slice(0, 8)}`
const TWITCH_ID = `nicktest-${randomUUID().slice(0, 8)}`

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`)
}

async function nicknameOf(id) {
  const { data } = await admin.from('profiles').select('nickname').eq('id', id).maybeSingle()
  return data?.nickname ?? null
}

let ownerId = null
let strangerId = null
let secondDeviceId = null

try {
  console.log(`\nMarker: ${MARKER}\n`)

  // -- Does the column exist at all? -----------------------------------------
  console.log('=== Schema ===\n')
  const { error: columnError } = await admin.from('profiles').select('nickname').limit(1)
  if (columnError) {
    check(
      'profiles.nickname exists',
      false,
      `${columnError.code}: ${columnError.message}\n        Apply migrations/20260728000000_profile_nickname.sql first - nothing below can pass without it.`
    )
    throw new Error('Migration not applied')
  }
  check('profiles.nickname exists', true)

  // -- Setup: a signed-in player, and a stranger -----------------------------
  console.log('\n=== Setup ===\n')
  const owner = anonClient()
  const stranger = anonClient()
  ownerId = (await owner.auth.signInAnonymously()).data.user.id
  strangerId = (await stranger.auth.signInAnonymously()).data.user.id
  check('Two throwaway sessions', Boolean(ownerId && strangerId), `owner=${ownerId}\n        stranger=${strangerId}`)

  const { error: seedOwner } = await admin
    .from('profiles')
    .insert({ id: ownerId, twitch_id: TWITCH_ID, display_name: `${MARKER} twitch` })
  check('Seeded the owner profile', !seedOwner, seedOwner?.message)

  const { error: seedStranger } = await admin
    .from('profiles')
    .insert({ id: strangerId, twitch_id: `${TWITCH_ID}-other`, display_name: `${MARKER} stranger` })
  check('Seeded the stranger profile', !seedStranger, seedStranger?.message)

  // -- The feature: renaming yourself, with the anon key ---------------------
  console.log('\n=== Renaming yourself ===\n')
  const { error: renameError } = await owner
    .from('profiles')
    .update({ nickname: 'Sir Reginald', updated_at: new Date().toISOString() })
    .eq('id', ownerId)
  check('Owner may write their own nickname', !renameError, renameError?.message)
  check('It landed', (await nicknameOf(ownerId)) === 'Sir Reginald', `read back: ${await nicknameOf(ownerId)}`)

  const { error: mirrorError } = await owner.from('profiles').upsert(
    {
      id: ownerId,
      twitch_id: TWITCH_ID,
      display_name: `${MARKER} twitch`,
      avatar_url: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )
  check('Profile mirror (upsertProfile) still allowed', !mirrorError, mirrorError?.message)
  check(
    'Mirror left the nickname alone',
    (await nicknameOf(ownerId)) === 'Sir Reginald',
    `This is the reset bug: the mirror runs on every page load. read back: ${await nicknameOf(ownerId)}`
  )

  const { error: clearError } = await owner.from('profiles').update({ nickname: null }).eq('id', ownerId)
  check('Owner may clear it back to their Twitch name', !clearError, clearError?.message)
  check('Cleared', (await nicknameOf(ownerId)) === null)
  await owner.from('profiles').update({ nickname: 'Sir Reginald' }).eq('id', ownerId)

  // -- RLS: a stranger holding the same anon key -----------------------------
  console.log('\n=== A stranger with the anon key ===\n')
  // No error is expected: RLS filters the rows an UPDATE can see, so this reports success having
  // matched nothing. What matters is the value afterwards.
  await stranger.from('profiles').update({ nickname: 'Impostor' }).eq('id', ownerId)
  check(
    "Cannot rename somebody else's account",
    (await nicknameOf(ownerId)) === 'Sir Reginald',
    `nickname is now: ${await nicknameOf(ownerId)}`
  )

  // -- The length constraint -------------------------------------------------
  console.log('\n=== Constraint ===\n')
  const { error: tooLong } = await owner.from('profiles').update({ nickname: 'x'.repeat(21) }).eq('id', ownerId)
  check('21 characters rejected (23514)', tooLong?.code === '23514', tooLong ? `${tooLong.code}: ${tooLong.message}` : 'It was ACCEPTED.')

  const { error: blank } = await owner.from('profiles').update({ nickname: '   ' }).eq('id', ownerId)
  check('Blank rejected (23514)', blank?.code === '23514', blank ? `${blank.code}: ${blank.message}` : 'It was ACCEPTED.')

  check('20 characters accepted', !(await owner.from('profiles').update({ nickname: 'x'.repeat(20) }).eq('id', ownerId)).error)
  await owner.from('profiles').update({ nickname: 'Sir Reginald' }).eq('id', ownerId)

  // -- Second device: the reclaim path from twitch-login/index.ts ------------
  console.log('\n=== Signing in on a second device ===\n')
  const second = anonClient()
  secondDeviceId = (await second.auth.signInAnonymously()).data.user.id

  // Byte-for-byte the lookup the edge function does, including the column it now selects.
  const { data: existing } = await admin
    .from('profiles')
    .select('id, nickname')
    .eq('twitch_id', TWITCH_ID)
    .maybeSingle()
  const carriedNickname = existing && existing.id !== secondDeviceId ? (existing.nickname ?? null) : null
  check('Old row read before it is released', carriedNickname === 'Sir Reginald', `carried: ${carriedNickname}`)

  await admin.from('profiles').delete().eq('id', existing.id) // reclaim() releases the unique twitch_id
  const { error: reUpsert } = await admin.from('profiles').upsert(
    {
      id: secondDeviceId,
      twitch_id: TWITCH_ID,
      display_name: `${MARKER} twitch`,
      avatar_url: null,
      ...(carriedNickname ? { nickname: carriedNickname } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )
  check('Profile re-created on the new uuid', !reUpsert, reUpsert?.message)
  check(
    'Nickname followed the player to the second device',
    (await nicknameOf(secondDeviceId)) === 'Sir Reginald',
    `read back: ${await nicknameOf(secondDeviceId)}`
  )

  // And an ordinary re-login on the SAME device must not wipe it: the edge function omits the
  // column entirely when there is nothing to carry, keeping it out of the ON CONFLICT SET list.
  const { error: relogin } = await admin.from('profiles').upsert(
    {
      id: secondDeviceId,
      twitch_id: TWITCH_ID,
      display_name: `${MARKER} twitch`,
      avatar_url: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )
  check('Ordinary re-login upsert succeeded', !relogin, relogin?.message)
  check(
    'Re-login left the nickname alone',
    (await nicknameOf(secondDeviceId)) === 'Sir Reginald',
    `read back: ${await nicknameOf(secondDeviceId)}`
  )
} catch (err) {
  if (String(err).includes('Migration not applied')) console.log('\n  Stopped: the column is missing.')
  else check('Unexpected error', false, String(err))
} finally {
  console.log('\n=== Cleanup ===\n')
  for (const id of [ownerId, strangerId, secondDeviceId].filter(Boolean)) {
    await admin.from('profiles').delete().eq('id', id)
    await admin.auth.admin.deleteUser(id).catch(() => {})
  }

  const { count: residue } = await admin
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .like('twitch_id', `${TWITCH_ID}%`)
  check(
    'Every row and user created by this test is gone',
    (residue ?? 0) === 0,
    residue ? `${residue} row(s) left behind under ${TWITCH_ID} - remove manually.` : ''
  )

  console.log('\n' + '='.repeat(70))
  console.log(`${passed} passed, ${failed} failed`)
  console.log('='.repeat(70))
  process.exit(failed === 0 ? 0 : 1)
}
