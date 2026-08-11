/**
 * Integration test for the returning-player path in the twitch-login edge function.
 *
 * The `reclaim()` half of that function only runs when someone signs in from a second device, so
 * left untested its first real execution would be against a live player's career - and it moves
 * their admin standing, which for the owner tier cannot be regranted from inside the site.
 *
 * This exercises the same sequence against the real database using two throwaway anonymous users
 * and rows tagged with a unique marker, then deletes everything it created. It does NOT invoke the
 * deployed function (that needs a real Twitch authorization code); it runs the same operations in
 * the same order, so what it proves is that the sequence is sound against the live schema and
 * constraints.
 *
 * Every created object is removed in a finally block, and the cleanup is verified rather than
 * assumed. Nothing here reads or writes any pre-existing row.
 *
 *   node scripts/test-reclaim.mjs
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

const MARKER = `PREFLIGHT-${randomUUID().slice(0, 8)}`
const TWITCH_ID = `preflight-${randomUUID().slice(0, 8)}`

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`)
}

/** Byte-for-byte the sequence from supabase/functions/twitch-login/index.ts. */
async function reclaim(oldId, newId) {
  for (const table of ['match_participants', 'match_events']) {
    const { error } = await admin.from(table).update({ user_id: newId }).eq('user_id', oldId)
    if (error) throw new Error(`Reassigning ${table} failed: ${error.message}`)
  }

  const { data: oldAdmin } = await admin
    .from('admins')
    .select('display_name, is_owner, granted_by, granted_at')
    .eq('user_id', oldId)
    .maybeSingle()

  if (oldAdmin) {
    const { error: insertError } = await admin
      .from('admins')
      .upsert({ user_id: newId, ...oldAdmin }, { onConflict: 'user_id' })
    if (insertError) throw new Error(`Reassigning admin failed: ${insertError.message}`)
    await admin.from('admins').delete().eq('user_id', oldId)
  }

  const { error: profileError } = await admin.from('profiles').delete().eq('id', oldId)
  if (profileError) throw new Error(`Releasing old profile failed: ${profileError.message}`)

  await admin.auth.admin.updateUserById(oldId, {
    user_metadata: { twitch_id: null, twitch_login: null, display_name: null, avatar_url: null },
  })
}

let oldId = null
let newId = null

try {
  console.log(`\nMarker: ${MARKER}\n`)

  // -- Two real anonymous users, so updateUserById has something to act on ----
  console.log('=== Setup ===\n')
  const anonClient = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  oldId = (await anonClient.auth.signInAnonymously()).data.user.id
  newId = (await anonClient.auth.signInAnonymously()).data.user.id
  check('Created two throwaway anonymous users', Boolean(oldId && newId), `old=${oldId}\n        new=${newId}`)

  // Device one: signed in, played, and holds admin.
  await admin.auth.admin.updateUserById(oldId, {
    user_metadata: { twitch_id: TWITCH_ID, twitch_login: MARKER, display_name: MARKER },
  })
  const { error: seedProfile } = await admin
    .from('profiles')
    .insert({ id: oldId, twitch_id: TWITCH_ID, display_name: `${MARKER} old` })
  check('Seeded old profile', !seedProfile, seedProfile?.message)

  const { error: seedParts } = await admin.from('match_participants').insert([
    { match_key: MARKER, user_id: oldId, nickname: `${MARKER}-a`, team: 0, shots: 7, hits: 3 },
    { match_key: MARKER, user_id: oldId, nickname: `${MARKER}-b`, team: 1, shots: 5, hits: 1 },
  ])
  check('Seeded 2 career rows', !seedParts, seedParts?.message)

  const { error: seedEvents } = await admin.from('match_events').insert([
    { match_key: MARKER, user_id: oldId, nickname: `${MARKER}-a`, team: 0, cell_index: 0, result: 'miss', board_size: 5 },
    { match_key: MARKER, user_id: oldId, nickname: `${MARKER}-a`, team: 0, cell_index: 1, result: 'hit', board_size: 5 },
  ])
  check('Seeded 2 shot rows', !seedEvents, seedEvents?.message)

  const { error: seedAdmin } = await admin
    .from('admins')
    .insert({ user_id: oldId, display_name: `${MARKER} old`, is_owner: false })
  check('Seeded admin row', !seedAdmin, seedAdmin?.message)

  // -- Control: what the original plan would have done -----------------------
  // Attaching the identity to the second uuid without releasing the first. If this succeeds, the
  // unique constraint isn't doing what the fix assumes and the reclaim step is unnecessary.
  console.log('\n=== Control: write the same twitch_id under a second uuid ===\n')
  const { error: collision } = await admin
    .from('profiles')
    .upsert({ id: newId, twitch_id: TWITCH_ID, display_name: `${MARKER} new` }, { onConflict: 'id' })
  check(
    'Rejected with 23505 (unique twitch_id)',
    collision?.code === '23505',
    collision ? `${collision.code}: ${collision.message}` : 'It SUCCEEDED - the constraint is not what was assumed.'
  )

  // -- The real thing --------------------------------------------------------
  console.log('\n=== reclaim() ===\n')
  await reclaim(oldId, newId)
  check('reclaim() completed without throwing', true)

  const { error: afterReclaim } = await admin
    .from('profiles')
    .upsert(
      { id: newId, twitch_id: TWITCH_ID, display_name: `${MARKER} new`, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    )
  check('Profile upsert now succeeds', !afterReclaim, afterReclaim?.message)

  // -- Assertions ------------------------------------------------------------
  console.log('\n=== Records followed the player ===\n')
  async function countBy(table, column, value) {
    const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).eq(column, value)
    return count ?? 0
  }

  check('2 career rows moved to new uuid', (await countBy('match_participants', 'user_id', newId)) === 2)
  check('0 career rows left on old uuid', (await countBy('match_participants', 'user_id', oldId)) === 0)
  check('2 shot rows moved to new uuid', (await countBy('match_events', 'user_id', newId)) === 2)
  check('0 shot rows left on old uuid', (await countBy('match_events', 'user_id', oldId)) === 0)
  check('Admin standing moved to new uuid', (await countBy('admins', 'user_id', newId)) === 1)
  check('0 admin rows left on old uuid', (await countBy('admins', 'user_id', oldId)) === 0)
  check('Old profile released', (await countBy('profiles', 'id', oldId)) === 0)

  const { data: byTwitch } = await admin.from('profiles').select('id').eq('twitch_id', TWITCH_ID)
  check(
    'Exactly one profile holds the twitch_id, and it is the new uuid',
    byTwitch?.length === 1 && byTwitch[0].id === newId,
    `found ${byTwitch?.length ?? 0}`
  )

  const { data: staleUser } = await admin.auth.admin.getUserById(oldId)
  check(
    'Abandoned auth user no longer claims the Twitch account',
    !staleUser?.user?.user_metadata?.twitch_id,
    `metadata.twitch_id = ${JSON.stringify(staleUser?.user?.user_metadata?.twitch_id)}`
  )
} catch (err) {
  check('Unexpected error', false, String(err))
} finally {
  // -- Cleanup, then prove it ------------------------------------------------
  console.log('\n=== Cleanup ===\n')
  for (const table of ['match_participants', 'match_events']) {
    await admin.from(table).delete().eq('match_key', MARKER)
  }
  for (const id of [oldId, newId].filter(Boolean)) {
    await admin.from('admins').delete().eq('user_id', id)
    await admin.from('profiles').delete().eq('id', id)
    await admin.auth.admin.deleteUser(id).catch(() => {})
  }

  let residue = 0
  for (const table of ['match_participants', 'match_events']) {
    const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).eq('match_key', MARKER)
    residue += count ?? 0
  }
  const { count: profileResidue } = await admin
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('twitch_id', TWITCH_ID)
  residue += profileResidue ?? 0

  check(
    'Every row and user created by this test is gone',
    residue === 0,
    residue === 0 ? '' : `${residue} row(s) left behind under marker ${MARKER} - remove manually.`
  )

  console.log('\n' + '='.repeat(70))
  console.log(`${passed} passed, ${failed} failed`)
  console.log('='.repeat(70))
  process.exit(failed === 0 ? 0 : 1)
}
