/**
 * Finds - and optionally removes - the email addresses the built-in Twitch provider collected.
 *
 * The scope-free flow cannot collect an email, but it does not retroactively erase the ones already
 * stored. Those live on auth user records created by the old provider, in two quite different
 * situations:
 *
 *   ORPHAN  The player has since signed in through the new flow. reclaim() moved their profile,
 *           career and admin standing to a fresh anonymous uuid, leaving the old record referenced
 *           by nothing at all. Deleting it removes the stored email and costs nothing.
 *
 *   LIVE    The player has not signed in since the switch. The old record is still their identity -
 *           it owns their profile row. Deleting it would take their display name, avatar and any
 *           admin grant with it. These can only be cleaned AFTER they sign in once more, at which
 *           point they become orphans and this script will say so.
 *
 * Reports by default and deletes nothing. Pass --delete to remove the orphans it has classified as
 * clean; anything it cannot vouch for is listed for review and left alone either way.
 *
 *   node scripts/cleanup-legacy-emails.mjs            # report
 *   node scripts/cleanup-legacy-emails.mjs --delete   # act
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

const DELETE = process.argv.includes('--delete')
const env = loadEnv('../.env.local')
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// -- Every auth user holding an email -----------------------------------------
// Anonymous users have none, so an email is itself the marker of a built-in-provider account.
const withEmail = []
let total = 0
for (let page = 1; page <= 50; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
  if (error) {
    console.error(`Could not list users: ${error.message}`)
    process.exit(1)
  }
  const users = data?.users ?? []
  total += users.length
  withEmail.push(...users.filter((u) => u.email))
  if (users.length < 1000) break
}

console.log(`\n${total} auth users, ${withEmail.length} holding an email address\n${'='.repeat(72)}\n`)

// -- Classify -----------------------------------------------------------------
const clean = []
const referenced = []
const live = []

for (const user of withEmail) {
  const { data: profile } = await admin
    .from('profiles')
    .select('id, display_name, twitch_id')
    .eq('id', user.id)
    .maybeSingle()

  const counts = {}
  for (const [table, column] of [
    ['match_participants', 'user_id'],
    ['match_events', 'user_id'],
    ['admins', 'user_id'],
    ['players', 'user_id'],
  ]) {
    const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).eq(column, user.id)
    counts[table] = count ?? 0
  }

  const referencedBy = Object.entries(counts).filter(([, n]) => n > 0)
  const label = user.user_metadata?.nickname ?? user.user_metadata?.name ?? '(unknown)'
  const entry = { user, label, profile, counts, referencedBy }

  if (profile) live.push(entry)
  else if (referencedBy.length) referenced.push(entry)
  else clean.push(entry)
}

function show(entry) {
  console.log(`  ${entry.label}  <${entry.user.email}>`)
  console.log(`    uuid     ${entry.user.id}`)
  console.log(`    profile  ${entry.profile ? `yes - ${entry.profile.display_name}` : 'none'}`)
  console.log(
    `    refs     ${entry.referencedBy.length ? entry.referencedBy.map(([t, n]) => `${t}=${n}`).join(', ') : 'none'}`
  )
  console.log(`    created  ${entry.user.created_at}`)
  console.log()
}

if (clean.length) {
  console.log(`SAFE TO DELETE - orphaned, referenced by nothing (${clean.length})\n`)
  clean.forEach(show)
}

if (referenced.length) {
  console.log(`REVIEW - no profile, but rows still point at them (${referenced.length})\n`)
  console.log('  Career rows survive deletion (no foreign keys), but they would show under a')
  console.log('  nickname rather than a profile. Usually means a reclaim did not complete.\n')
  referenced.forEach(show)
}

if (live.length) {
  console.log(`KEEP - still the player's identity (${live.length})\n`)
  console.log("  Deleting these takes their profile, avatar and admin grant with them. They clear")
  console.log('  themselves once each player signs in again through the new flow.\n')
  live.forEach(show)
}

// -- Act ----------------------------------------------------------------------
console.log('='.repeat(72))
if (!DELETE) {
  console.log(`Report only - nothing was changed.`)
  if (clean.length) console.log(`Re-run with --delete to remove the ${clean.length} orphaned account(s) above.`)
  else console.log('No orphaned accounts to remove.')
} else if (!clean.length) {
  console.log('Nothing to delete.')
} else {
  console.log(`Deleting ${clean.length} orphaned account(s)...\n`)
  let removed = 0
  for (const entry of clean) {
    const { error } = await admin.auth.admin.deleteUser(entry.user.id)
    if (error) {
      console.log(`  FAILED  ${entry.label} <${entry.user.email}>: ${error.message}`)
    } else {
      removed++
      console.log(`  gone    ${entry.label} <${entry.user.email}>`)
    }
  }

  // Confirm rather than assume.
  let stillThere = 0
  for (const entry of clean) {
    const { data } = await admin.auth.admin.getUserById(entry.user.id)
    if (data?.user) stillThere++
  }
  console.log(`\n${removed} deleted, ${stillThere} still present.`)
}
console.log('='.repeat(72))
