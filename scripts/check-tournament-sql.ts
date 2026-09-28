/**
 * Runs the tournament schema (supabase/migrations/20260921000000_tournaments.sql) against a real
 * Postgres and checks two things the pure-engine checks cannot:
 *
 *   1. THE RULES. Who may create an event, sign a team up, see an entry code, approve a team, enter
 *      a result - tried as actual separate users, through the same client and RLS a browser has.
 *      Row-level security is the whole security boundary here, and the only way to know a policy says
 *      what its author meant is to be the person it is supposed to stop.
 *
 *   2. THE MIRROR. tournament_apply_score() is a hand-written SQL copy of setScore() in
 *      src/lib/tournament/bracket.ts, and two copies of a rule drift. So this generates real
 *      brackets, then throws the same random operations - including illegal ones - at both, and
 *      asserts that after every single one the database and the TypeScript hold identical state and
 *      agreed on whether the operation was allowed. A refused operation must leave nothing behind.
 *
 * LOCAL ONLY. It creates users, tournaments and admin rows, and it refuses to start unless the API
 * is on localhost. (The older check-*.mjs scripts read .env.local, which is the cloud project; this
 * one deliberately does not.) Start the stack first:  npm run local:up
 *
 *   node --experimental-strip-types scripts/check-tournament-sql.ts
 */
import { execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { buildKnockout, setScore, revertMatch, forfeitMatch, settleForfeits } = await import('../src/lib/tournament/bracket.ts')
const { winsNeeded } = await import('../src/lib/tournament/types.ts')
const { applySchedule, suggestSchedule } = await import('../src/lib/tournament/schedule.ts')
const { planStart, toMatchRows } = await import('../src/lib/tournament/start.ts')
const { suggestFormat } = await import('../src/lib/tournament/format.ts')
const { matchFromRow } = await import('../src/lib/tournament/start.ts')
const { planNextSwissRound, planKnockout, qualifierStatus } = await import('../src/lib/tournament/stages.ts')
const { tournamentComplete, eventChampion } = await import('../src/lib/tournament/complete.ts')
const { pairSwissRound } = await import('../src/lib/tournament/swiss.ts')
const { buildGroupStage } = await import('../src/lib/tournament/groups.ts')
import type { TournamentFormat } from '../src/lib/tournament/format.ts'
import type { Result, TMatch } from '../src/lib/tournament/types.ts'
import type { KnockoutOptions } from '../src/lib/tournament/bracket.ts'

// -- environment -------------------------------------------------------------------------------

function localEnv(): Record<string, string> {
  const raw = execFileSync('npx', ['--yes', 'supabase@latest', 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const env = localEnv()
const API = env.API_URL
const ANON = env.ANON_KEY
const SERVICE = env.SERVICE_ROLE_KEY
if (!API || !ANON || !SERVICE) {
  console.error('Could not read the local Supabase stack. Is it running? (npm run local:up)')
  process.exit(2)
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API)) {
  console.error(`Refusing to run: ${API} is not a local address. This script creates and deletes data.`)
  process.exit(2)
}

/**
 * Node's fetch reuses keep-alive sockets, and the local gateway now and then closes one just as it
 * is picked up again, which surfaces as "TypeError: fetch failed" before the request has reached
 * the database at all. That is a property of the local stack, not of anything under test, and left
 * alone it made this check fail about one run in three for no reason a person could act on.
 *
 * So network-level failures - and only those; a refusal from the database is a normal response and
 * never comes through here - are retried a few times. The count is printed at the end so a
 * degrading stack shows up as a number rather than being quietly absorbed.
 */
let transportRetries = 0
const retryingFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init)
    } catch (e) {
      // A burst can outlast a couple of quick retries, so back off further each time.
      if (attempt >= 9 || !(e instanceof TypeError)) throw e
      transportRetries++
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

const clientOpts = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: retryingFetch },
}
const svc = createClient(API, SERVICE, clientOpts)

// -- tiny harness ------------------------------------------------------------------------------

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${!ok && detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}
const msg = (e: { message?: string } | null | undefined) => e?.message ?? ''
/** An operation that must be refused - optionally for the reason we expect. */
function refused(label: string, error: { message?: string } | null | undefined, why?: RegExp) {
  check(label, !!error && (!why || why.test(msg(error))), error ? `refused for: ${msg(error)}` : 'it was allowed')
}
function allowed(label: string, error: { message?: string } | null | undefined) {
  check(label, !error, msg(error))
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// -- fixtures ----------------------------------------------------------------------------------

const run = String(Math.floor(Math.random() * 90000) + 10000)
interface Person {
  id: string
  login: string
  client: SupabaseClient
}
const createdUsers: string[] = []
const createdTournaments: string[] = []

async function person(label: string, opts: { twitch?: boolean; admin?: boolean } = {}): Promise<Person> {
  const { twitch = true, admin = false } = opts
  const { data, error } = await svc.auth.admin.createUser({
    email: `t${run}${label}@test.local`,
    password: `pw-${run}-${label}`,
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`)
  const id = data.user.id
  createdUsers.push(id)
  const login = `t${run}${label}`.toLowerCase()
  if (twitch) {
    const r = await svc.from('profiles').insert({ id, twitch_id: `${run}-${label}`, twitch_login: login, display_name: label })
    if (r.error) throw new Error(`profile ${label}: ${r.error.message}`)
  }
  if (admin) {
    const r = await svc.from('admins').insert({ user_id: id, display_name: label, is_owner: false })
    if (r.error) throw new Error(`admin ${label}: ${r.error.message}`)
  }
  const client = createClient(API, ANON, clientOpts)
  const signIn = await client.auth.signInWithPassword({ email: `t${run}${label}@test.local`, password: `pw-${run}-${label}` })
  if (signIn.error) throw new Error(`sign in ${label}: ${signIn.error.message}`)
  return { id, login, client }
}

async function newTournament(over: Record<string, unknown> = {}) {
  const { data, error } = await svc
    .from('tournaments')
    .insert({ name: `Check ${run}`, status: 'signup', team_size: 3, max_roster: 4, ...over })
    .select()
    .single()
  if (error) throw new Error(`tournament: ${error.message}`)
  createdTournaments.push(data.id)
  return data as { id: string }
}

async function cleanup() {
  // Each step is attempted regardless of the others: one failed delete must not strand everything
  // after it, which is how a crashed run used to leave its users and events behind.
  const attempt = async (what: string, step: () => PromiseLike<{ error: { message: string } | null }>) => {
    try {
      const { error } = await step()
      if (error) console.log(`  (cleanup: ${what}: ${error.message})`)
    } catch (e) {
      console.log(`  (cleanup: ${what}: ${(e as Error).message})`)
    }
  }
  for (const id of createdTournaments) await attempt('tournament', () => svc.from('tournaments').delete().eq('id', id))
  for (const id of createdUsers) {
    await attempt('admin row', () => svc.from('admins').delete().eq('user_id', id))
    await attempt('profile', () => svc.from('profiles').delete().eq('id', id))
    await attempt('user', () => svc.auth.admin.deleteUser(id))
  }
}

// ===========================================================================================
async function rules() {
  console.log('\nWho can create and see an event')
  const admin = await person('admin', { admin: true })
  const alice = await person('alice')
  const bob = await person('bob')
  const cat = await person('cat')
  const dan = await person('dan')
  const eve = await person('eve')
  const plain = await person('plain', { twitch: false })

  // A test event goes live first, so the check below also proves that one doesn't count.
  const testId = await testEvents(admin, eve)

  // Before any event has gone live the Official stat category must not exist. This can only be
  // asserted on a database with no live event in it already (a crashed earlier run, say), so it says
  // so rather than failing for a reason that is not the code's.
  const alreadyLive = (await svc.from('tournaments').select('id', { count: 'exact', head: true }).not('went_live_at', 'is', null).eq('is_test', false)).count ?? 0
  if (alreadyLive === 0) {
    check('the Official stat is off until an event has gone live - a live test event does not count', (await eve.client.rpc('official_stats_enabled')).data === false)
  } else {
    console.log(`  skip  the Official stat is off until an event has gone live - ${alreadyLive} event(s) already live in this database`)
  }

  const made = await admin.client
    .from('tournaments')
    .insert({ name: `Check ${run} draft`, status: 'draft', team_size: 3, max_roster: 4 })
    .select()
    .single()
  allowed('an admin can create an event', made.error)
  const draftId = made.data?.id as string
  if (draftId) createdTournaments.push(draftId)

  refused('a Twitch user cannot create an event',
    (await alice.client.from('tournaments').insert({ name: `Nope ${run}`, status: 'signup' })).error)
  refused('an account with no Twitch profile cannot either',
    (await plain.client.from('tournaments').insert({ name: `Nope ${run}`, status: 'signup' })).error)

  const seesDraft = await alice.client.from('tournaments').select('id').eq('id', draftId)
  check('a draft event is invisible to non-admins', (seesDraft.data ?? []).length === 0)
  const adminSeesDraft = await admin.client.from('tournaments').select('id').eq('id', draftId)
  check('...and visible to an admin', (adminSeesDraft.data ?? []).length === 1)

  const opened = await admin.client.from('tournaments').update({ status: 'signup' }).eq('id', draftId)
  allowed('an admin can open signup', opened.error)
  check('an open event is visible to everyone',
    ((await alice.client.from('tournaments').select('id').eq('id', draftId)).data ?? []).length === 1)
  const sneaky = await alice.client.from('tournaments').update({ name: 'hijacked' }).eq('id', draftId).select()
  check('a non-admin cannot edit an event (update touches nothing)', (sneaky.data ?? []).length === 0)
  const sneakyDelete = await alice.client.from('tournaments').delete().eq('id', draftId).select()
  check('...or delete one', (sneakyDelete.data ?? []).length === 0)

  const T = draftId

  console.log('\nSigning a team up')
  refused('an account with no Twitch profile cannot sign a team up',
    (await plain.client.rpc('register_team', { p_tournament: T, p_name: 'Ghosts' })).error, /Twitch/)

  const reg = await alice.client.rpc('register_team', {
    p_tournament: T,
    p_name: 'Alpha',
    p_logins: [bob.login, cat.login],
  })
  allowed('a Twitch user can sign a team up, naming two teammates', reg.error)
  const alpha = reg.data as string

  const own = await alice.client.from('tournament_entrants').select('status, seed, captain_user_id').eq('id', alpha)
  check('the new team is pending, unseeded, and captained by its creator',
    own.data?.[0]?.status === 'pending' && own.data[0].seed === null && own.data[0].captain_user_id === alice.id)
  check('a pending team is invisible to the public',
    ((await dan.client.from('tournament_entrants').select('id').eq('id', alpha)).data ?? []).length === 0)
  check('the captain is on their own roster',
    ((await alice.client.from('tournament_roster').select('user_id, is_captain').eq('entrant_id', alpha)).data ?? [])
      .some((r) => r.user_id === alice.id && r.is_captain))

  refused('the same captain cannot sign a second team up in the same event',
    (await alice.client.rpc('register_team', { p_tournament: T, p_name: 'Alpha Two' })).error, /already/)
  refused('two teams cannot share a name',
    (await dan.client.rpc('register_team', { p_tournament: T, p_name: '  alpha ' })).error)

  console.log('\nCaptains cannot approve themselves')
  refused('a captain cannot approve their own team',
    (await alice.client.from('tournament_entrants').update({ status: 'approved' }).eq('id', alpha)).error, /administrator/)
  refused('a captain cannot seed their own team',
    (await alice.client.from('tournament_entrants').update({ seed: 1 }).eq('id', alpha)).error, /administrator/)
  refused('a captain cannot move their team to another event',
    (await alice.client.from('tournament_entrants').update({ tournament_id: (await newTournament()).id }).eq('id', alpha)).error)
  allowed('a captain can rename their team while signup is open',
    (await alice.client.from('tournament_entrants').update({ name: 'Alpha Wolves' }).eq('id', alpha)).error)
  check('...and the rename stuck',
    (await alice.client.from('tournament_entrants').select('name').eq('id', alpha)).data?.[0]?.name === 'Alpha Wolves')

  console.log('\nInvitations by Twitch name')
  const aliceInvites = await alice.client.from('tournament_invites').select('id, twitch_login, status').eq('entrant_id', alpha)
  check('the captain sees the two invitations they sent', (aliceInvites.data ?? []).length === 2)
  const bobInvites = await bob.client.from('tournament_invites').select('id, twitch_login')
  check('an invitee sees only their own invitation',
    (bobInvites.data ?? []).length === 1 && bobInvites.data?.[0].twitch_login === bob.login)
  check('a stranger sees none', ((await dan.client.from('tournament_invites').select('id')).data ?? []).length === 0)
  const bobInvite = bobInvites.data?.[0]?.id as string
  const catInvite = (aliceInvites.data ?? []).find((i) => i.twitch_login === cat.login)?.id as string

  refused('someone else cannot accept another person\'s invitation',
    (await dan.client.rpc('respond_to_roster_invite', { p_invite: bobInvite, p_accept: true })).error, /not for you/)
  refused('an account with no Twitch profile cannot answer',
    (await plain.client.rpc('respond_to_roster_invite', { p_invite: bobInvite, p_accept: true })).error)
  allowed('the invitee can accept', (await bob.client.rpc('respond_to_roster_invite', { p_invite: bobInvite, p_accept: true })).error)
  check('...and is then on the roster',
    ((await alice.client.from('tournament_roster').select('user_id').eq('entrant_id', alpha)).data ?? []).some((r) => r.user_id === bob.id))
  refused('an answered invitation cannot be answered again',
    (await bob.client.rpc('respond_to_roster_invite', { p_invite: bobInvite, p_accept: true })).error, /already answered/)
  allowed('an invitee can decline', (await cat.client.rpc('respond_to_roster_invite', { p_invite: catInvite, p_accept: false })).error)
  check('...and a decline leaves them off the roster',
    !((await alice.client.from('tournament_roster').select('user_id').eq('entrant_id', alpha)).data ?? []).some((r) => r.user_id === cat.id))

  // team_size 3, max_roster 4: alice and bob are on it. Room for two more, counting pending invites.
  refused('too many invitations are refused',
    (await alice.client.rpc('invite_to_roster', { p_entrant: alpha, p_logins: ['dan_x1', 'dan_x2', 'dan_x3'] })).error, /at most 4/)
  check('...and none of them were left behind (all or nothing)',
    ((await alice.client.from('tournament_invites').select('id').eq('entrant_id', alpha)).data ?? []).length === 2)
  refused('one bad name cancels the whole batch',
    (await alice.client.rpc('invite_to_roster', { p_entrant: alpha, p_logins: ['fine_name', 'not a name!'] })).error, /Twitch username/)
  check('...and the good name was not sent either',
    !((await alice.client.from('tournament_invites').select('twitch_login').eq('entrant_id', alpha)).data ?? []).some((i) => i.twitch_login === 'fine_name'))
  refused('inviting someone already on the team is refused',
    (await alice.client.rpc('invite_to_roster', { p_entrant: alpha, p_logins: [bob.login] })).error, /already on this team/)
  refused('a non-captain cannot invite for someone else\'s team',
    (await dan.client.rpc('invite_to_roster', { p_entrant: alpha, p_logins: ['someone_else'] })).error, /captain/)
  const sent = await alice.client.rpc('invite_to_roster', { p_entrant: alpha, p_logins: [`@${dan.login.toUpperCase()}`, 'never_visited_site'] })
  check('names are normalised (leading @, any case) and an unregistered name can be invited',
    !sent.error && sent.data === 2, msg(sent.error))
  check('...and the person named sees it',
    ((await dan.client.from('tournament_invites').select('id').eq('twitch_login', dan.login)).data ?? []).length === 1)

  console.log('\nOne team per person per event')
  const gus = await person('gus')
  const beta = (await gus.client.rpc('register_team', { p_tournament: T, p_name: 'Beta', p_logins: [bob.login] })).data as string
  check('another team can invite someone who is already on a team', !!beta)
  const betaInvite = ((await bob.client.from('tournament_invites').select('id, entrant_id')).data ?? []).find((i) => i.entrant_id === beta)?.id as string
  refused('...but they cannot accept it',
    (await bob.client.rpc('respond_to_roster_invite', { p_invite: betaInvite, p_accept: true })).error, /already on another team/)
  check('...and the refused invitation stays pending, not burned',
    ((await gus.client.from('tournament_invites').select('status').eq('id', betaInvite)).data ?? [])[0]?.status === 'pending')

  console.log('\nApproval and entry codes')
  allowed('an admin can approve a team', (await admin.client.from('tournament_entrants').update({ status: 'approved' }).eq('id', alpha)).error)
  check('an approved team is visible to the public',
    ((await eve.client.from('tournament_entrants').select('id').eq('id', alpha)).data ?? []).length === 1)
  check('...and so is its roster',
    ((await eve.client.from('tournament_roster').select('user_id').eq('entrant_id', alpha)).data ?? []).length >= 2)
  const code = (await alice.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', alpha)).data?.[0]?.entry_code as string
  check('approval issued a six-character entry code from the unambiguous alphabet', /^[A-HJ-KM-NP-Z2-9]{6}$/.test(code ?? ''), String(code))
  check('the captain can read their code', !!code)
  check('an admin can read it', (await admin.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', alpha)).data?.[0]?.entry_code === code)
  check('a teammate cannot', ((await bob.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', alpha)).data ?? []).length === 0)
  check('a stranger cannot', ((await eve.client.from('tournament_entrant_secrets').select('entry_code')).data ?? []).length === 0)

  const codeAgain = await admin.client.from('tournament_entrants').update({ status: 'pending' }).eq('id', alpha)
  allowed('an admin can send a team back to pending', codeAgain.error)
  await admin.client.from('tournament_entrants').update({ status: 'approved' }).eq('id', alpha)
  check('re-approving does not rotate the code',
    (await alice.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', alpha)).data?.[0]?.entry_code === code)
  const fresh = await admin.client.rpc('regenerate_entry_code', { p_entrant: alpha })
  check('an admin can re-issue a code', !fresh.error && /^[A-HJ-KM-NP-Z2-9]{6}$/.test(fresh.data ?? ''), msg(fresh.error))
  refused('a captain cannot re-issue their own',
    (await alice.client.rpc('regenerate_entry_code', { p_entrant: alpha })).error, /administrator/)
  refused('a pending team has no code to re-issue',
    (await admin.client.rpc('regenerate_entry_code', { p_entrant: beta })).error, /approved/)

  console.log('\nEntry codes are unique within an event')
  const T3 = await newTournament({ team_size: 1, max_roster: 1 })
  const rows = Array.from({ length: 30 }, (_, i) => ({ tournament_id: T3.id, name: `Team ${i + 1}`, captain_user_id: admin.id }))
  const ins = await svc.from('tournament_entrants').insert(rows)
  check('thirty teams inserted', !ins.error, msg(ins.error))
  await svc.from('tournament_entrants').update({ status: 'approved' }).eq('tournament_id', T3.id)
  const codes = ((await svc.from('tournament_entrant_secrets').select('entry_code').eq('tournament_id', T3.id)).data ?? []).map((r) => r.entry_code)
  check('every one got a code, and no two match', codes.length === 30 && new Set(codes).size === 30 && codes.every(Boolean), `${new Set(codes).size} distinct of ${codes.length}`)

  console.log('\nCapacity, and signup closing')
  const T2 = await newTournament({ max_entrants: 2, team_size: 1, max_roster: 1 })
  const c1 = await person('c1')
  const c2 = await person('c2')
  const c3 = await person('c3')
  allowed('first team in', (await c1.client.rpc('register_team', { p_tournament: T2.id, p_name: 'One' })).error)
  allowed('second team in', (await c2.client.rpc('register_team', { p_tournament: T2.id, p_name: 'Two' })).error)
  refused('a third is refused - the event is full', (await c3.client.rpc('register_team', { p_tournament: T2.id, p_name: 'Three' })).error, /full/)

  const c1Team = (await c1.client.from('tournament_entrants').select('id').eq('tournament_id', T2.id)).data?.[0]?.id as string
  await svc.from('tournaments').update({ status: 'live' }).eq('id', T2.id)
  refused('signup is refused once the event is live',
    (await c3.client.rpc('register_team', { p_tournament: T2.id, p_name: 'Late' })).error, /not open/)
  refused('a captain cannot rename once signup has closed',
    (await c1.client.from('tournament_entrants').update({ name: 'Renamed' }).eq('id', c1Team)).error, /closed/)
  refused('...or withdraw from a running event',
    (await c1.client.from('tournament_entrants').update({ status: 'withdrawn' }).eq('id', c1Team)).error, /closed|administrator/)
  refused('an event\'s format is locked once it is live',
    (await admin.client.from('tournaments').update({ format: { qualifier: { format: 'none' } } }).eq('id', T2.id)).error, /already running/)
  allowed('...though its description can still be edited',
    (await admin.client.from('tournaments').update({ description: 'updated' }).eq('id', T2.id)).error)

  const T4 = await newTournament({ team_size: 1, max_roster: 1 })
  const solo = (await c3.client.rpc('register_team', { p_tournament: T4.id, p_name: 'Solo' })).data as string
  allowed('a captain can withdraw while signup is open',
    (await c3.client.from('tournament_entrants').update({ status: 'withdrawn' }).eq('id', solo)).error)
  allowed('...and the name is free again for someone else',
    (await c2.client.rpc('register_team', { p_tournament: T4.id, p_name: 'Solo' })).error)

  console.log('\nRoster changes')
  const T5 = await newTournament({ team_size: 2, max_roster: 3 })
  const h1 = await person('h1')
  const h2 = await person('h2')
  const team = (await h1.client.rpc('register_team', { p_tournament: T5.id, p_name: 'Hex', p_logins: [h2.login] })).data as string
  const inv = (await h2.client.from('tournament_invites').select('id')).data?.[0]?.id as string
  await h2.client.rpc('respond_to_roster_invite', { p_invite: inv, p_accept: true })
  const cut = await h1.client.from('tournament_roster').delete().eq('entrant_id', team).eq('user_id', h1.id).select()
  check('a captain cannot remove themselves from the roster', (cut.data ?? []).length === 0)
  const leave = await h2.client.from('tournament_roster').delete().eq('entrant_id', team).eq('user_id', h2.id).select()
  check('a teammate can leave while signup is open', (leave.data ?? []).length === 1)
  const readd = await h1.client.rpc('invite_to_roster', { p_entrant: team, p_logins: [h2.login] })
  check('...and can be invited again afterwards', !readd.error && readd.data === 1, msg(readd.error))
  const readdId = (await h2.client.from('tournament_invites').select('id').eq('entrant_id', team)).data?.[0]?.id as string
  await h2.client.rpc('respond_to_roster_invite', { p_invite: readdId, p_accept: false })
  check('a declined invitation is recorded as declined',
    (await h1.client.from('tournament_invites').select('status').eq('id', readdId)).data?.[0]?.status === 'declined')
  const third = await h1.client.rpc('invite_to_roster', { p_entrant: team, p_logins: [h2.login] })
  check('...and can be sent again', !third.error && third.data === 1, msg(third.error))
  check('...which puts it back to pending',
    (await h1.client.from('tournament_invites').select('status').eq('id', readdId)).data?.[0]?.status === 'pending')
  const noChange = await h1.client.rpc('invite_to_roster', { p_entrant: team, p_logins: [h2.login] })
  check('inviting someone who is already pending sends nothing new', !noChange.error && noChange.data === 0, `${msg(noChange.error)} ${noChange.data}`)
  allowed('a captain can withdraw a pending invitation',
    (await h1.client.from('tournament_invites').delete().eq('entrant_id', team).eq('status', 'pending')).error)

  console.log('\nBracket rows and scores')
  const T6 = await newTournament({ status: 'live' })
  const ents = await svc.from('tournament_entrants').insert(
    ['Pp', 'Qq'].map((n) => ({ tournament_id: T6.id, name: n, captain_user_id: admin.id })),
  ).select('id')
  if (ents.error) throw new Error(`could not create the two entrants: ${ents.error.message}`)
  const [pId, qId] = (ents.data ?? []).map((e) => e.id)
  const mrow = await svc.from('tournament_matches').insert({
    tournament_id: T6.id, key: 'W1-0', stage: 'knockout', bracket: 'W', round: 1, idx: 0,
    entrant_a: pId, entrant_b: qId, best_of: 3, status: 'ready',
  }).select().single()
  check('a match row can be created (service)', !mrow.error, msg(mrow.error))
  const mid = mrow.data?.id as string
  check('everyone can read a live event\'s matches', ((await eve.client.from('tournament_matches').select('id').eq('id', mid)).data ?? []).length === 1)
  refused('a player cannot create a match', (await eve.client.from('tournament_matches').insert({
    tournament_id: T6.id, key: 'X', stage: 'knockout', round: 1, idx: 0 })).error)
  const forged = await eve.client.from('tournament_matches').update({ winner: pId, status: 'done' }).eq('id', mid).select()
  check('a player cannot write a winner directly', (forged.data ?? []).length === 0)
  refused('a player cannot call the score function', (await eve.client.rpc('tournament_apply_score', { p_match: mid, p_score_a: 2, p_score_b: 0 })).error)
  refused('...nor the game recorder', (await eve.client.rpc('tournament_record_game', { p_match: mid, p_side: 'a' })).error)
  refused('...nor the admin wrapper', (await eve.client.rpc('set_tournament_match_score', { p_match: mid, p_score_a: 2, p_score_b: 0 })).error, /administrator/)
  refused('not even an admin can call the internal function directly',
    (await admin.client.rpc('tournament_apply_score', { p_match: mid, p_score_a: 2, p_score_b: 0 })).error)
  allowed('an admin can enter a result', (await admin.client.rpc('set_tournament_match_score', { p_match: mid, p_score_a: 2, p_score_b: 1 })).error)
  const done = await svc.from('tournament_matches').select('status, winner, score_a, score_b').eq('id', mid).single()
  check('...and it is recorded', done.data?.status === 'done' && done.data.winner === pId && done.data.score_a === 2 && done.data.score_b === 1)

  const draftMatches = await svc.from('tournament_matches').insert({
    tournament_id: T, key: 'W1-0', stage: 'knockout', round: 1, idx: 0 })
  check('(a match in the draft event, for the visibility check)', !draftMatches.error, msg(draftMatches.error))
  await svc.from('tournaments').update({ status: 'draft' }).eq('id', T)
  check('a draft event\'s matches are hidden from players', ((await eve.client.from('tournament_matches').select('id').eq('tournament_id', T)).data ?? []).length === 0)
  check('...and visible to admins', ((await admin.client.from('tournament_matches').select('id').eq('tournament_id', T)).data ?? []).length === 1)

  // -------------------------------------------------------------------------------------------
  console.log('\nCancelling a running event')
  // A live four-team single elimination, one semifinal already played - the situation an admin
  // actually cancels from.
  const cancelled = await newTournament({ status: 'live', team_size: 1, max_roster: 1, name: `Cancel ${run}` })
  const names = ['K1', 'K2', 'K3', 'K4']
  const kEnts = await svc.from('tournament_entrants').insert(
    names.map((n) => ({ tournament_id: cancelled.id, name: n, captain_user_id: admin.id, status: 'approved' })),
  ).select('id, name')
  if (kEnts.error) throw new Error(`could not create entrants: ${kEnts.error.message}`)
  const kId = new Map((kEnts.data ?? []).map((e) => [e.name, e.id]))
  const kState = buildKnockout(names, { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false })
  const kIns = await svc.from('tournament_matches').insert(
    kState.map((m) => ({
      tournament_id: cancelled.id, key: m.key, stage: m.stage, bracket: m.bracket, round: m.round, idx: m.index,
      entrant_a: m.a ? kId.get(m.a) : null, entrant_b: m.b ? kId.get(m.b) : null, best_of: m.bestOf, status: m.status,
      winner_to_key: m.winnerTo?.key ?? null, winner_to_side: m.winnerTo?.side ?? null,
    })),
  )
  if (kIns.error) throw new Error(`could not create the bracket: ${kIns.error.message}`)
  const kMatch = new Map(((await svc.from('tournament_matches').select('id, key').eq('tournament_id', cancelled.id)).data ?? []).map((r) => [r.key, r.id]))
  allowed('(setup) a semifinal is played', (await admin.client.rpc('set_tournament_match_score', { p_match: kMatch.get('W1-0'), p_score_a: 1, p_score_b: 0 })).error)

  refused('a captain cannot cancel an event',
    (await alice.client.rpc('cancel_tournament', { p_tournament: cancelled.id, p_reason: 'nope' })).error, /administrator/)
  await eve.client.from('tournaments').update({ status: 'cancelled' }).eq('id', cancelled.id)
  check('a player cannot cancel one by writing the status directly',
    (await svc.from('tournaments').select('status').eq('id', cancelled.id).single()).data?.status === 'live')
  refused('an event that does not exist cannot be cancelled',
    (await admin.client.rpc('cancel_tournament', { p_tournament: '00000000-0000-0000-0000-000000000000' })).error, /no such event/)

  allowed('an admin can cancel a running event', (await admin.client.rpc('cancel_tournament', { p_tournament: cancelled.id, p_reason: '  Server outage  ' })).error)
  const row = (await svc.from('tournaments').select('status, cancel_reason, cancelled_at').eq('id', cancelled.id).single()).data
  check('it is marked cancelled, with the reason (trimmed) and the time',
    row?.status === 'cancelled' && row.cancel_reason === 'Server outage' && !!row.cancelled_at, JSON.stringify(row))
  check('the cancelled event and its bracket stay visible to the public',
    ((await eve.client.from('tournaments').select('id').eq('id', cancelled.id)).data ?? []).length === 1 &&
      ((await eve.client.from('tournament_matches').select('id').eq('tournament_id', cancelled.id)).data ?? []).length === kState.length)

  const before = (await svc.from('tournament_matches').select('key, status, winner, entrant_a, entrant_b').eq('tournament_id', cancelled.id).order('key')).data
  refused('no result can be entered into it',
    (await admin.client.rpc('set_tournament_match_score', { p_match: kMatch.get('W1-1'), p_score_a: 1, p_score_b: 0 })).error, /cancelled/)
  refused('a result already recorded cannot be reverted',
    (await admin.client.rpc('set_tournament_match_score', { p_match: kMatch.get('W1-0'), p_score_a: 0, p_score_b: 0 })).error, /cancelled/)
  refused('the bracket cannot be edited directly, even by an admin',
    (await admin.client.from('tournament_matches').update({ score_a: 1 }).eq('id', kMatch.get('W1-1'))).error, /frozen/)
  refused('a new match cannot be drawn into it',
    (await admin.client.from('tournament_matches').insert({ tournament_id: cancelled.id, key: 'ZZ', stage: 'swiss', round: 1, idx: 0 })).error, /frozen/)
  const after = (await svc.from('tournament_matches').select('key, status, winner, entrant_a, entrant_b').eq('tournament_id', cancelled.id).order('key')).data
  check('and none of those attempts changed a single row', JSON.stringify(before) === JSON.stringify(after))
  check('the semifinal that was played is still on the record', after?.find((r) => r.key === 'W1-0')?.status === 'done')

  refused('it cannot be cancelled twice',
    (await admin.client.rpc('cancel_tournament', { p_tournament: cancelled.id })).error, /already cancelled/)
  refused('signup for it is closed',
    (await dan.client.rpc('register_team', { p_tournament: cancelled.id, p_name: 'Latecomers' })).error, /not open/)

  // Cancelled during signup: invitations still waiting go nowhere.
  const openEvent = await newTournament({ team_size: 2, max_roster: 2, name: `Open ${run}` })
  const ivy = await person('ivy')
  const jon = await person('jon')
  const ivyTeam = (await ivy.client.rpc('register_team', { p_tournament: openEvent.id, p_name: 'Ivy Team', p_logins: [jon.login] })).data as string
  const jonInvite = (await jon.client.from('tournament_invites').select('id').eq('entrant_id', ivyTeam)).data?.[0]?.id as string
  allowed('(setup) an admin cancels an event that is still taking signups',
    (await admin.client.rpc('cancel_tournament', { p_tournament: openEvent.id })).error)
  refused('an invitee cannot accept into a cancelled event',
    (await jon.client.rpc('respond_to_roster_invite', { p_invite: jonInvite, p_accept: true })).error, /closed/)
  check('...and the reason is optional',
    (await svc.from('tournaments').select('cancel_reason, cancelled_at').eq('id', openEvent.id).single()).data?.cancel_reason === null)

  await freeAgents(admin, alice, eve)
  await scheduling(admin, eve)
  await autoFinish(admin)
  await visibility(admin, eve)
  await eventNames(admin, eve)
  await inviteInbox(admin)
  await startRules(admin)
  await laterStages(admin)
  await officialMatches(admin)
  await concurrentEvents(admin)
  await deleting(admin, eve, testId)

  const draftEvent = await newTournament({ status: 'draft', name: `Draft ${run}` })
  allowed('a draft can be cancelled too', (await admin.client.rpc('cancel_tournament', { p_tournament: draftEvent.id })).error)

  const doneEvent = await newTournament({ status: 'finished', name: `Done ${run}` })
  refused('a finished event cannot be cancelled',
    (await admin.client.rpc('cancel_tournament', { p_tournament: doneEvent.id })).error, /finished/)

  // Maintenance still works, and a cancel can be undone.
  allowed('the service key can still repair a cancelled bracket by hand',
    (await svc.from('tournament_matches').update({ score_a: 0 }).eq('id', kMatch.get('W1-1'))).error)
  allowed('an admin can reopen a cancelled event', (await admin.client.from('tournaments').update({ status: 'live' }).eq('id', cancelled.id)).error)
  const reopened = (await svc.from('tournaments').select('status, cancel_reason, cancelled_at').eq('id', cancelled.id).single()).data
  check('...which clears the cancellation record', reopened?.status === 'live' && reopened.cancel_reason === null && reopened.cancelled_at === null, JSON.stringify(reopened))
  allowed('...and lifts the freeze',
    (await admin.client.rpc('set_tournament_match_score', { p_match: kMatch.get('W1-1'), p_score_a: 1, p_score_b: 0 })).error)
}

// ===========================================================================================
// Solo signups and pairing
// ===========================================================================================
async function freeAgents(admin: Person, outsider: Person, stranger: Person) {
  console.log('\nSigning up solo')
  const p1 = await person('fa1')
  const p2 = await person('fa2')
  const p3 = await person('fa3')
  const p4 = await person('fa4')
  const p5 = await person('fa5')
  const p6 = await person('fa6')
  const noTwitch = await person('fanotwitch', { twitch: false })

  const T = await newTournament({ team_size: 3, max_roster: 4, name: `Solo ${run}` })
  const pool = async (client: SupabaseClient, status = 'waiting') =>
    ((await client.from('tournament_free_agents').select('user_id, status, note, placed_entrant_id').eq('tournament_id', T.id)).data ?? [])
      .filter((r) => r.status === status)

  refused('an account with no Twitch profile cannot sign up solo',
    (await noTwitch.client.rpc('sign_up_solo', { p_tournament: T.id })).error, /Twitch/)
  allowed('a Twitch user can sign up solo, with a note',
    (await p1.client.rpc('sign_up_solo', { p_tournament: T.id, p_note: '  EU evenings, plays support  ' })).error)
  for (const p of [p2, p3, p4, p5, p6]) await p.client.rpc('sign_up_solo', { p_tournament: T.id })

  check('the note is trimmed and saved', (await pool(p1.client))[0]?.note === 'EU evenings, plays support')
  check('a player sees their own row, and only their own', (await pool(p1.client)).length === 1 && (await pool(p1.client))[0].user_id === p1.id)
  check('a stranger sees nobody in the pool', (await pool(stranger.client)).length === 0)
  check('an admin sees all six', (await pool(admin.client)).length === 6)
  refused('too long a note is refused',
    (await p1.client.rpc('sign_up_solo', { p_tournament: T.id, p_note: 'x'.repeat(201) })).error)
  check('signing up twice just edits the note',
    !(await p1.client.rpc('sign_up_solo', { p_tournament: T.id, p_note: 'changed' })).error && (await pool(admin.client)).length === 6 &&
      (await pool(p1.client))[0].note === 'changed')

  const solo = await newTournament({ team_size: 1, max_roster: 1, name: `Individual ${run}` })
  refused('an individual event has no pool - sign up directly',
    (await p1.client.rpc('sign_up_solo', { p_tournament: solo.id })).error, /individual/)
  await svc.from('tournaments').update({ status: 'draft' }).eq('id', solo.id)
  refused('a draft event is not open for signup',
    (await p1.client.rpc('sign_up_solo', { p_tournament: solo.id })).error, /not open/)

  console.log('\nThe pool follows the roster')
  allowed('a waiting player can withdraw', (await p6.client.rpc('withdraw_solo', { p_tournament: T.id })).error)
  check('...and is out of the pool', (await pool(admin.client)).length === 5 && (await pool(admin.client, 'withdrawn')).length === 1)
  refused('withdrawing when not waiting is refused', (await p6.client.rpc('withdraw_solo', { p_tournament: T.id })).error, /not waiting/)
  allowed('they can sign up again', (await p6.client.rpc('sign_up_solo', { p_tournament: T.id })).error)
  check('...and are back in the pool', (await pool(admin.client)).length === 6)

  // A captain invites a waiting player by name, and they accept: they stop being a free agent.
  const outsiderTeam = (await outsider.client.rpc('register_team', { p_tournament: T.id, p_name: 'Recruiters', p_logins: [p5.login] })).data as string
  check('(setup) a captain registered a team and invited a waiting player', !!outsiderTeam)
  const invite = (await p5.client.from('tournament_invites').select('id').eq('entrant_id', outsiderTeam)).data?.[0]?.id as string
  await p5.client.rpc('respond_to_roster_invite', { p_invite: invite, p_accept: true })
  const placed5 = (await pool(admin.client, 'placed')).find((r) => r.user_id === p5.id)
  check('accepting an invitation takes a waiting player out of the pool',
    placed5?.placed_entrant_id === outsiderTeam && (await pool(admin.client)).length === 5)
  refused('a placed player cannot withdraw from the pool',
    (await p5.client.rpc('withdraw_solo', { p_tournament: T.id })).error, /not waiting/)
  refused('...nor sign up solo again while on a team',
    (await p5.client.rpc('sign_up_solo', { p_tournament: T.id })).error, /already on a team/)

  // A waiting player who starts their own team is placed too.
  allowed('a waiting player can start their own team instead',
    (await p4.client.rpc('register_team', { p_tournament: T.id, p_name: 'Self Starters' })).error)
  check('...and leaves the pool', !(await pool(admin.client)).some((r) => r.user_id === p4.id))

  // Now waiting: p1, p2, p3, p6. Recruiters have 2 of a possible 4 and need a third for team_size 3.
  console.log('\nAdmins pairing the pool')
  refused('a player cannot form a team',
    (await p1.client.rpc('form_team_from_free_agents', { p_tournament: T.id, p_name: 'Rogue', p_user_ids: [p1.id, p2.id] })).error, /administrator/)
  refused('a player cannot place a free agent either',
    (await p1.client.rpc('assign_free_agent_to_team', { p_entrant: outsiderTeam, p_user: p2.id })).error, /administrator/)
  refused('a team needs at least one player',
    (await admin.client.rpc('form_team_from_free_agents', { p_tournament: T.id, p_name: 'Empty', p_user_ids: [] })).error, /at least one/)
  refused('a team cannot exceed the roster limit (4)',
    (await admin.client.rpc('form_team_from_free_agents', { p_tournament: T.id, p_name: 'Huge', p_user_ids: [p1.id, p2.id, p3.id, p6.id, p5.id] })).error, /at most 4/)
  refused('the same player cannot be listed twice',
    (await admin.client.rpc('form_team_from_free_agents', { p_tournament: T.id, p_name: 'Twins', p_user_ids: [p1.id, p1.id] })).error, /twice/)
  refused('a player who is already on a team cannot be pulled into another',
    (await admin.client.rpc('form_team_from_free_agents', { p_tournament: T.id, p_name: 'Poachers', p_user_ids: [p1.id, p5.id] })).error, /waiting/)
  refused('the captain has to be one of the players',
    (await admin.client.rpc('form_team_from_free_agents', { p_tournament: T.id, p_name: 'Odd', p_user_ids: [p1.id, p2.id], p_captain: p3.id })).error, /captain/)
  check('...and those refusals left the pool untouched', (await pool(admin.client)).length === 4)

  const formed = await admin.client.rpc('form_team_from_free_agents', {
    p_tournament: T.id, p_name: 'Draftees', p_user_ids: [p1.id, p2.id, p3.id], p_captain: p2.id,
  })
  allowed('an admin can form a team from three waiting players', formed.error)
  const draftees = formed.data as string
  const teamRow = (await svc.from('tournament_entrants').select('status, captain_user_id').eq('id', draftees).single()).data
  check('the team is approved and captained by the chosen player', teamRow?.status === 'approved' && teamRow.captain_user_id === p2.id)
  const roster = ((await svc.from('tournament_roster').select('user_id, is_captain').eq('entrant_id', draftees)).data ?? [])
  check('all three are on the roster, one captain',
    roster.length === 3 && roster.filter((r) => r.is_captain).length === 1 && [p1, p2, p3].every((p) => roster.some((r) => r.user_id === p.id)))
  check('all three left the pool', (await pool(admin.client)).length === 1 && (await pool(admin.client))[0].user_id === p6.id)
  const code = (await p2.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', draftees)).data?.[0]?.entry_code
  check('the new team got an entry code, and its captain can read it', /^[A-HJ-KM-NP-Z2-9]{6}$/.test(code ?? ''), String(code))
  check('the new team is public', ((await stranger.client.from('tournament_entrants').select('id').eq('id', draftees)).data ?? []).length === 1)

  // Placing into an existing team. This event is team_size 3 with room for a substitute (max 4), so
  // Draftees (3) has one place left and Recruiters (2) has two.
  const p7 = await person('fa7')
  await p7.client.rpc('sign_up_solo', { p_tournament: T.id })
  allowed('an admin can add a waiting player to a team that has room',
    (await admin.client.rpc('assign_free_agent_to_team', { p_entrant: draftees, p_user: p6.id })).error)
  refused('...but not to a team that is full (4 of 4)',
    (await admin.client.rpc('assign_free_agent_to_team', { p_entrant: draftees, p_user: p7.id })).error, /full/)
  check('a refused placement leaves the player waiting', (await pool(admin.client)).length === 1 && (await pool(admin.client))[0].user_id === p7.id)
  allowed('they can be placed on a team that is short instead',
    (await admin.client.rpc('assign_free_agent_to_team', { p_entrant: outsiderTeam, p_user: p7.id })).error)
  check('...and the pool is empty', (await pool(admin.client)).length === 0)
  refused('a player who is not waiting cannot be placed',
    (await admin.client.rpc('assign_free_agent_to_team', { p_entrant: outsiderTeam, p_user: p6.id })).error, /not waiting/)

  console.log('\nPlayers going back to the pool')
  allowed('an admin can take a player off a roster',
    (await admin.client.from('tournament_roster').delete().eq('entrant_id', draftees).eq('user_id', p3.id)).error)
  check('...and they are waiting again', (await pool(admin.client)).some((r) => r.user_id === p3.id))
  allowed('an admin can reject a team',
    (await admin.client.from('tournament_entrants').update({ status: 'rejected' }).eq('id', outsiderTeam)).error)
  const waiting = (await pool(admin.client)).map((r) => r.user_id)
  check('its free agents are waiting again (p5 was placed by invitation, p7 by an admin)',
    waiting.includes(p5.id) && waiting.includes(p7.id) && waiting.includes(p3.id) && waiting.length === 3, `${waiting.length} waiting`)
  const reformed = await admin.client.rpc('form_team_from_free_agents', {
    p_tournament: T.id, p_name: 'Second Chance', p_user_ids: [p5.id, p7.id, p3.id] })
  allowed('...and can be paired into a new team', reformed.error)
  check('the pool is empty again', (await pool(admin.client)).length === 0)

  // Pairing closes when the event starts.
  const late = await person('falate')
  await late.client.rpc('sign_up_solo', { p_tournament: T.id })
  await svc.from('tournaments').update({ status: 'live' }).eq('id', T.id)
  refused('teams cannot be formed once the event is live',
    (await admin.client.rpc('form_team_from_free_agents', { p_tournament: T.id, p_name: 'Too Late', p_user_ids: [late.id] })).error, /before the event starts/)
  // A running event still loses players; the pool can top a team up (Draftees has 3 of 4).
  allowed('...but a waiting player can still be placed on a team that has room',
    (await admin.client.rpc('assign_free_agent_to_team', { p_entrant: draftees, p_user: late.id })).error)
  check('...and joins that roster', ((await svc.from('tournament_roster').select('user_id').eq('entrant_id', draftees)).data ?? []).some((r) => r.user_id === late.id))
  await svc.from('tournaments').update({ status: 'cancelled' }).eq('id', T.id)
  const later = await person('falater')
  await svc.from('tournament_free_agents').insert({ tournament_id: T.id, user_id: later.id, display_name: 'later' })
  refused('a cancelled event takes no new players',
    (await admin.client.rpc('assign_free_agent_to_team', { p_entrant: draftees, p_user: later.id })).error, /being set up or running/)
}

// ===========================================================================================
// A month-long event: deadlines, agreed times, forfeits, substitutions
// ===========================================================================================
async function scheduling(admin: Person, outsider: Person) {
  console.log('\nRound deadlines, agreed times and the overdue list')
  const cap1 = await person('sc1')
  const cap2 = await person('sc2')

  // A live, four-team best-of-three knockout. K1 and K2 have real captains; the rest belong to the
  // admin. Round 1 opened 20 days ago and closed 13 days ago, so both first-round matches are late.
  const event = await newTournament({ status: 'live', team_size: 1, max_roster: 1, name: `Month ${run}` })
  const names = ['K1', 'K2', 'K3', 'K4']
  const captains = [cap1.id, cap2.id, admin.id, admin.id]
  const made = await svc.from('tournament_entrants').insert(
    names.map((n, i) => ({ tournament_id: event.id, name: n, captain_user_id: captains[i], status: 'approved' })),
  ).select('id, name')
  if (made.error) throw new Error(`entrants: ${made.error.message}`)
  const team = new Map((made.data ?? []).map((e) => [e.name, e.id]))
  const day = 86_400_000
  const startsAt = new Date(Date.now() - 20 * day).toISOString()
  const bracket = applySchedule(
    buildKnockout(['K1', 'K2', 'K3', 'K4'], { format: 'single', bestOf: 3, thirdPlace: false, grandFinalReset: false }),
    { startsAt, roundDays: 7, stageGapDays: 0, overrides: {} },
    { qualifierStage: null, qualifierRounds: 0 },
  )
  const ins = await svc.from('tournament_matches').insert(bracket.map((m) => ({
    tournament_id: event.id, key: m.key, stage: m.stage, bracket: m.bracket, round: m.round, idx: m.index, phase: m.phase,
    opens_at: m.opensAt, due_at: m.dueAt,
    entrant_a: m.a ? team.get(m.a) : null, entrant_b: m.b ? team.get(m.b) : null, best_of: m.bestOf, status: m.status,
    winner_to_key: m.winnerTo?.key ?? null, winner_to_side: m.winnerTo?.side ?? null,
    loser_to_key: m.loserTo?.key ?? null, loser_to_side: m.loserTo?.side ?? null,
  })))
  if (ins.error) throw new Error(`bracket: ${ins.error.message}`)
  const mid = new Map(((await svc.from('tournament_matches').select('id, key').eq('tournament_id', event.id)).data ?? []).map((r) => [r.key, r.id]))
  const row = async (key: string) =>
    (await svc.from('tournament_matches').select('*').eq('id', mid.get(key)!).single()).data as Record<string, any>

  check('(setup) the bracket carries its phases and windows',
    (await row('W1-0')).phase === 1 && (await row('W2-0')).phase === 2 && !!(await row('W1-0')).due_at)

  refused('a player cannot see the overdue list',
    (await outsider.client.rpc('overdue_tournament_matches', { p_tournament: event.id })).error, /administrator/)
  const late = await admin.client.rpc('overdue_tournament_matches', { p_tournament: event.id })
  const lateKeys = ((late.data ?? []) as Array<{ match_key: string }>).map((r) => r.match_key)
  check('an admin sees the two first-round matches as overdue, and not the pending final',
    !late.error && lateKeys.join() === 'W1-0,W1-1', `${msg(late.error)} ${lateKeys.join()}`)
  check('...with how late they are', ((late.data ?? []) as Array<{ overdue_by: string }>).every((r) => !!r.overdue_by))

  console.log('\nMoving a deadline')
  const soon = new Date(Date.now() + 10 * day).toISOString()
  const yesterday = new Date(Date.now() - 1 * day).toISOString()
  refused('a player cannot move a deadline',
    (await outsider.client.rpc('set_round_window', { p_tournament: event.id, p_stage: 'knockout', p_phase: 1, p_opens: yesterday, p_due: soon })).error, /administrator/)
  refused('a round must close after it opens',
    (await admin.client.rpc('set_round_window', { p_tournament: event.id, p_stage: 'knockout', p_phase: 1, p_opens: soon, p_due: yesterday })).error, /close after/)
  refused('a round that does not exist cannot be moved',
    (await admin.client.rpc('set_round_window', { p_tournament: event.id, p_stage: 'knockout', p_phase: 9, p_opens: yesterday, p_due: soon })).error, /no knockout matches/)
  const moved = await admin.client.rpc('set_round_window', { p_tournament: event.id, p_stage: 'knockout', p_phase: 1, p_opens: yesterday, p_due: soon })
  check('an admin can move it, and it reports how many matches it moved', !moved.error && moved.data === 2, msg(moved.error))
  check('...to both matches of the round, and only that round',
    new Date((await row('W1-0')).due_at).getTime() === new Date(soon).getTime() && new Date((await row('W1-1')).due_at).getTime() === new Date(soon).getTime() &&
      new Date((await row('W2-0')).due_at).getTime() !== new Date(soon).getTime())
  check('and the overdue list is now empty',
    ((await admin.client.rpc('overdue_tournament_matches', { p_tournament: event.id })).data ?? []).length === 0)

  console.log('\nAgreed match times')
  const inWindow = new Date(Date.now() + 3 * day).toISOString()
  refused('a stranger cannot set a match time',
    (await outsider.client.rpc('set_match_time', { p_match: mid.get('W1-0'), p_at: inWindow })).error, /captain/)
  refused('a captain cannot set the time of a match they are not in',
    (await cap1.client.rpc('set_match_time', { p_match: mid.get('W1-1'), p_at: inWindow })).error, /captain/)
  allowed('a captain can set the time of their own match', (await cap1.client.rpc('set_match_time', { p_match: mid.get('W1-0'), p_at: inWindow })).error)
  const set = await row('W1-0')
  check('...and it is recorded, with who set it', new Date(set.agreed_at).getTime() === new Date(inWindow).getTime() && set.agreed_by === cap1.id)
  allowed('the captain of the other match can set theirs',
    (await cap2.client.rpc('set_match_time', { p_match: mid.get('W1-1'), p_at: inWindow })).error)
  check('...and it is recorded against them', (await row('W1-1')).agreed_by === cap2.id)
  refused('a captain cannot pick a time after the deadline',
    (await cap1.client.rpc('set_match_time', { p_match: mid.get('W1-0'), p_at: new Date(Date.now() + 30 * day).toISOString() })).error, /deadline/)
  refused('...or before the round opens',
    (await cap1.client.rpc('set_match_time', { p_match: mid.get('W1-0'), p_at: new Date(Date.now() - 5 * day).toISOString() })).error, /before this round opens/)
  allowed('an admin can record a time outside the window',
    (await admin.client.rpc('set_match_time', { p_match: mid.get('W1-0'), p_at: new Date(Date.now() + 30 * day).toISOString() })).error)
  allowed('a time can be cleared', (await cap1.client.rpc('set_match_time', { p_match: mid.get('W1-0'), p_at: null })).error)
  check('...back to nothing', (await row('W1-0')).agreed_at === null)
  refused('a match still waiting on earlier results has no time to set',
    (await admin.client.rpc('set_match_time', { p_match: mid.get('W2-0'), p_at: inWindow })).error, /not waiting/)

  console.log('\nForfeits')
  refused('a player cannot forfeit a match',
    (await cap1.client.rpc('forfeit_tournament_match', { p_match: mid.get('W1-0'), p_loser: 'a' })).error, /administrator/)
  refused('the forfeiting side has to be a or b',
    (await admin.client.rpc('forfeit_tournament_match', { p_match: mid.get('W1-0'), p_loser: 'c' })).error, /a or b/)
  refused('a match waiting on earlier results cannot be forfeited',
    (await admin.client.rpc('forfeit_tournament_match', { p_match: mid.get('W2-0'), p_loser: 'a' })).error, /waiting/)
  allowed('an admin can forfeit a no-show (K1 forfeits to K4)', (await admin.client.rpc('forfeit_tournament_match', { p_match: mid.get('W1-0'), p_loser: 'a' })).error)
  const ff = await row('W1-0')
  check('the match is a forfeit, 0-2 in a best of three, and K4 won',
    ff.result_kind === 'forfeit' && ff.score_a === 0 && ff.score_b === 2 && ff.winner === team.get('K4') && ff.status === 'done', JSON.stringify(ff))
  check('...and K4 is in the final', (await row('W2-0')).entrant_a === team.get('K4'))
  refused('a decided match cannot be forfeited again',
    (await admin.client.rpc('forfeit_tournament_match', { p_match: mid.get('W1-0'), p_loser: 'b' })).error, /already decided/)
  allowed('an admin can revert a forfeit like any result',
    (await admin.client.rpc('set_tournament_match_score', { p_match: mid.get('W1-0'), p_score_a: 0, p_score_b: 0 })).error)
  check('...which clears its kind', (await row('W1-0')).result_kind === 'played' && (await row('W1-0')).status === 'ready')
  allowed('an entered result is recorded as an admin result',
    (await admin.client.rpc('set_tournament_match_score', { p_match: mid.get('W1-0'), p_score_a: 2, p_score_b: 1 })).error)
  check('...with the kind "admin"', (await row('W1-0')).result_kind === 'admin')

  console.log('\nRemoving a team from a running event')
  refused('a player cannot remove a team', (await cap2.client.rpc('forfeit_team', { p_entrant: team.get('K2') })).error, /administrator/)
  refused('a captain cannot mark their own team as gone by writing the column',
    (await cap2.client.from('tournament_entrants').update({ forfeited_at: new Date().toISOString() }).eq('id', team.get('K2'))).error, /administrator/)
  allowed('an admin can remove K2 from the event', (await admin.client.rpc('forfeit_team', { p_entrant: team.get('K2') })).error)
  const k2 = (await svc.from('tournament_entrants').select('forfeited_at').eq('id', team.get('K2')).single()).data
  check('K2 is marked as removed', !!k2?.forfeited_at)
  const semi = await row('W1-1')
  check('...its open match was forfeited to K3', semi.result_kind === 'forfeit' && semi.winner === team.get('K3') && semi.status === 'done', JSON.stringify(semi))
  check('...so the final is now K4 against K3 and ready', (await row('W2-0')).status === 'ready' && (await row('W2-0')).entrant_b === team.get('K3'))
  refused('removing a team that is not in the bracket is refused',
    (await admin.client.rpc('forfeit_team', { p_entrant: '00000000-0000-0000-0000-000000000000' })).error, /no such team/)
  refused('a captain cannot bring their team back either',
    (await cap2.client.from('tournament_entrants').update({ forfeited_at: null }).eq('id', team.get('K2'))).error, /administrator/)
  allowed('an admin can reinstate it', (await admin.client.from('tournament_entrants').update({ forfeited_at: null }).eq('id', team.get('K2'))).error)
  check('...which does not undo the forfeit already recorded', (await row('W1-1')).result_kind === 'forfeit')

  // A removed team whose next match is still waiting on an opponent. In a double elimination K3 drops
  // into the loser bracket against a team that has not been decided yet; the moment that opponent
  // arrives, the match should settle itself rather than leave them waiting for a team that is gone.
  const bracket2 = buildKnockout(['K1', 'K2', 'K3', 'K4'], { format: 'double', bestOf: 1, thirdPlace: false, grandFinalReset: false })
  const event2 = await newTournament({ status: 'live', team_size: 1, max_roster: 1, name: `Month2 ${run}` })
  const made2 = await svc.from('tournament_entrants').insert(
    names.map((n) => ({ tournament_id: event2.id, name: n, captain_user_id: admin.id, status: 'approved' })),
  ).select('id, name')
  const team2 = new Map((made2.data ?? []).map((e) => [e.name, e.id]))
  await svc.from('tournament_matches').insert(bracket2.map((m) => ({
    tournament_id: event2.id, key: m.key, stage: m.stage, bracket: m.bracket, round: m.round, idx: m.index, phase: m.phase,
    entrant_a: m.a ? team2.get(m.a) : null, entrant_b: m.b ? team2.get(m.b) : null, best_of: m.bestOf, status: m.status,
    winner_to_key: m.winnerTo?.key ?? null, winner_to_side: m.winnerTo?.side ?? null,
    loser_to_key: m.loserTo?.key ?? null, loser_to_side: m.loserTo?.side ?? null,
  })))
  const mid2 = new Map(((await svc.from('tournament_matches').select('id, key').eq('tournament_id', event2.id)).data ?? []).map((r) => [r.key, r.id]))
  const state2 = async (key: string) => (await svc.from('tournament_matches').select('status, winner, result_kind, entrant_a, entrant_b').eq('id', mid2.get(key)!).single()).data
  await admin.client.rpc('forfeit_team', { p_entrant: team2.get('K3') })
  const dropped = await state2('L1-0')
  check('K3 loses its first match by forfeit and drops into the loser bracket, where it waits for an opponent',
    dropped?.status === 'pending' && [dropped.entrant_a, dropped.entrant_b].includes(team2.get('K3')), JSON.stringify(dropped))
  await admin.client.rpc('set_tournament_match_score', { p_match: mid2.get('W1-0'), p_score_a: 1, p_score_b: 0 })
  const settled = await state2('L1-0')
  check('when the opponent (K4, beaten by K1) arrives, the match is forfeited without anyone touching it',
    settled?.status === 'done' && settled.result_kind === 'forfeit' && settled.winner === team2.get('K4'), JSON.stringify(settled))

  const draftEvent = await newTournament({ status: 'signup', name: `NotYet ${run}` })
  const dE = await svc.from('tournament_entrants').insert({ tournament_id: draftEvent.id, name: 'Early', captain_user_id: admin.id, status: 'approved' }).select('id').single()
  refused('an event that has not started has no matches to forfeit',
    (await admin.client.rpc('forfeit_team', { p_entrant: dE.data?.id })).error, /running event/)

  console.log('\nSubstituting players')
  const sc = await person('sub_cap')
  const sm1 = await person('sub_m1')
  const sm2 = await person('sub_m2')
  const sn = await person('sub_new')
  const sx = await person('sub_other')
  const subEvent = await newTournament({ team_size: 3, max_roster: 3, name: `Subs ${run}` })
  const squad = (await sc.client.rpc('register_team', { p_tournament: subEvent.id, p_name: 'Squad', p_logins: [sm1.login, sm2.login] })).data as string
  for (const m of [sm1, sm2]) {
    const inv = (await m.client.from('tournament_invites').select('id').eq('entrant_id', squad)).data?.[0]?.id as string
    await m.client.rpc('respond_to_roster_invite', { p_invite: inv, p_accept: true })
  }
  const other = (await sx.client.rpc('register_team', { p_tournament: subEvent.id, p_name: 'Others' })).data as string
  const onRoster = async (id: string) => ((await svc.from('tournament_roster').select('user_id').eq('entrant_id', id)).data ?? []).map((r) => r.user_id)

  refused('a captain cannot substitute their own players',
    (await sc.client.rpc('substitute_player', { p_entrant: squad, p_out: sm1.id, p_in_login: sn.login })).error, /administrator/)
  refused('the player going out has to be on the team',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sn.id, p_in_login: sx.login })).error, /not on this team/)
  refused('the captain cannot be substituted out',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sc.id, p_in_login: sn.login })).error, /captain/)
  refused('the player coming in has to have signed in on the site',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sm1.id, p_in_login: 'nobody_has_this_name' })).error, /signed in/)
  refused('...and cannot already be on another team in the event',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sm1.id, p_in_login: sx.login })).error, /another team/)
  refused('...or already on this one',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sm1.id, p_in_login: sm2.login })).error, /already on this team/)
  check('(none of those refusals changed the roster)', (await onRoster(squad)).length === 3 && (await onRoster(squad)).includes(sm1.id))

  allowed('an admin can swap a player out for one who has signed in',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sm1.id, p_in_login: `@${sn.login.toUpperCase()}` })).error)
  const after = await onRoster(squad)
  check('...the new player is on the roster and the old one is off it, size unchanged',
    after.length === 3 && after.includes(sn.id) && !after.includes(sm1.id))
  await svc.from('tournaments').update({ status: 'live' }).eq('id', subEvent.id)
  allowed('substitutions still work once the event is running',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sm2.id, p_in_login: sm1.login })).error)
  check('...(the earlier substitute can come back in)', (await onRoster(squad)).includes(sm1.id))
  await svc.from('tournaments').update({ status: 'finished' }).eq('id', subEvent.id)
  refused('a finished event takes no substitutions',
    (await admin.client.rpc('substitute_player', { p_entrant: squad, p_out: sn.id, p_in_login: sm2.login })).error, /signups or running/)
  void other
}

// ===========================================================================================
// An event finishes itself
// ===========================================================================================
/** A live event with approved teams already in it. `team` maps a team's name to its id. */
interface LiveEvent {
  id: string
  team: Map<string, string>
}

async function makeLiveEvent(admin: Person, label: string, format: TournamentFormat, names: string[]): Promise<LiveEvent> {
  const t = await newTournament({ status: 'live', team_size: 1, max_roster: 1, name: `${label} ${run}`, format })
  const made = await svc.from('tournament_entrants').insert(
    names.map((n) => ({ tournament_id: t.id, name: n, captain_user_id: admin.id, status: 'approved' })),
  ).select('id, name')
  if (made.error) throw new Error(`entrants: ${made.error.message}`)
  return { id: t.id, team: new Map((made.data ?? []).map((e) => [e.name, e.id])) }
}

async function addMatches(event: LiveEvent, matches: TMatch[]) {
  const r = await svc.from('tournament_matches').insert(matches.map((m) => ({
    tournament_id: event.id, key: m.key, stage: m.stage, bracket: m.bracket, round: m.round, idx: m.index, phase: m.phase,
    opens_at: m.opensAt, due_at: m.dueAt, best_of: m.bestOf, status: m.status, is_bye: m.isBye,
    entrant_a: m.a ? event.team.get(m.a) : null, entrant_b: m.b ? event.team.get(m.b) : null,
    winner: m.winner ? event.team.get(m.winner) : null,
    winner_to_key: m.winnerTo?.key ?? null, winner_to_side: m.winnerTo?.side ?? null,
    loser_to_key: m.loserTo?.key ?? null, loser_to_side: m.loserTo?.side ?? null,
  })))
  if (r.error) throw new Error(`matches: ${r.error.message}`)
}

async function matchIds(event: { id: string }) {
  return new Map(((await svc.from('tournament_matches').select('id, key').eq('tournament_id', event.id)).data ?? []).map((r) => [r.key, r.id as string]))
}

async function autoFinish(admin: Person) {
  console.log('\nAn event finishes itself')

  const liveEvent = (label: string, format: TournamentFormat, names: string[]) => makeLiveEvent(admin, label, format, names)
  const ids = matchIds
  const state = async (event: { id: string }) =>
    (await svc.from('tournaments').select('status, champion_id, finished_at, finished_by_bracket').eq('id', event.id).single()).data!
  const score = async (m: Map<string, string>, key: string, a: number, b: number) =>
    (await admin.client.rpc('set_tournament_match_score', { p_match: m.get(key), p_score_a: a, p_score_b: b })).error

  // -- knockout only ---------------------------------------------------------------------------
  const koFormat: TournamentFormat = { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false } }
  const ko = await liveEvent('Knockout', koFormat, ['K1', 'K2', 'K3', 'K4'])
  await addMatches(ko, buildKnockout(['K1', 'K2', 'K3', 'K4'], koFormat.knockout!))
  const koIds = await ids(ko)
  await score(koIds, 'W1-0', 1, 0)
  await score(koIds, 'W1-1', 1, 0)
  check('a knockout is still live with only the semifinals played', (await state(ko)).status === 'live')
  await score(koIds, 'W2-0', 1, 0)
  const won = await state(ko)
  check('it finishes itself when the final is decided', won.status === 'finished' && !!won.finished_at && won.finished_by_bracket)
  check('...and records the champion (K1 beat K2 in the final)', won.champion_id === ko.team.get('K1'))
  await score(koIds, 'W2-0', 0, 1)
  check('correcting the final changes the recorded champion, and it stays finished',
    (await state(ko)).status === 'finished' && (await state(ko)).champion_id === ko.team.get('K2'))
  await score(koIds, 'W2-0', 0, 0)
  const reopened = await state(ko)
  check('reverting the final reopens the event, and clears the champion and finish time',
    reopened.status === 'live' && reopened.champion_id === null && reopened.finished_at === null && !reopened.finished_by_bracket)
  await score(koIds, 'W2-0', 1, 0)
  check('replaying it finishes the event again', (await state(ko)).status === 'finished')

  // -- forfeits and removals finish it too -------------------------------------------------------
  const duel = await liveEvent('Duel', koFormat, ['D1', 'D2'])
  await addMatches(duel, buildKnockout(['D1', 'D2'], koFormat.knockout!))
  const duelIds = await ids(duel)
  allowed('(setup) a forfeit is entered', (await admin.client.rpc('forfeit_tournament_match', { p_match: duelIds.get('W1-0'), p_loser: 'a' })).error)
  check('a forfeit can finish an event, with the other team as champion',
    (await state(duel)).status === 'finished' && (await state(duel)).champion_id === duel.team.get('D2'))
  const duel2 = await liveEvent('Duel2', koFormat, ['E1', 'E2'])
  await addMatches(duel2, buildKnockout(['E1', 'E2'], koFormat.knockout!))
  allowed('(setup) a team is removed', (await admin.client.rpc('forfeit_team', { p_entrant: duel2.team.get('E1') })).error)
  check('removing a team can finish an event too', (await state(duel2)).status === 'finished' && (await state(duel2)).champion_id === duel2.team.get('E2'))
  refused('but a team cannot be removed from an event that has already finished',
    (await admin.client.rpc('forfeit_team', { p_entrant: duel2.team.get('E2') })).error, /running event/)

  // -- Swiss: every round has to be drawn ---------------------------------------------------------
  const swissFormat: TournamentFormat = { qualifier: { format: 'swiss', rounds: 2, bestOf: 1 }, knockout: null }
  const names = ['S1', 'S2', 'S3', 'S4']
  const sw = await liveEvent('Swiss', swissFormat, names)
  let played: TMatch[] = []
  const round1 = pairSwissRound(names, played, 1, 1)
  await addMatches(sw, round1)
  const swIds = await ids(sw)
  for (const m of round1) await score(swIds, m.key, 1, 0)
  check('Swiss: with round 1 of 2 played and round 2 not drawn, the event is NOT finished', (await state(sw)).status === 'live')
  played = round1.map((m) => ({ ...m, scoreA: 1, winner: m.a, status: 'done' as const }))
  const round2 = pairSwissRound(names, played, 2, 1)
  await addMatches(sw, round2)
  check('...drawing round 2 does not finish it either', (await state(sw)).status === 'live')
  const swIds2 = await ids(sw)
  await score(swIds2, round2[0].key, 1, 0)
  check('...nor does playing half of it', (await state(sw)).status === 'live')
  await score(swIds2, round2[1].key, 1, 0)
  const swissDone = await state(sw)
  check('Swiss: it finishes once round 2 is played, with no champion recorded (the table decides)',
    swissDone.status === 'finished' && swissDone.champion_id === null)

  // -- a qualifier followed by a knockout ---------------------------------------------------------
  const bothFormat: TournamentFormat = {
    qualifier: { format: 'swiss', rounds: 1, bestOf: 1 },
    knockout: { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false, cutTo: 2 },
  }
  const both = await liveEvent('Both', bothFormat, names)
  const q1 = pairSwissRound(names, [], 1, 1)
  await addMatches(both, q1)
  const bothIds = await ids(both)
  for (const m of q1) await score(bothIds, m.key, 1, 0)
  check('qualifier + knockout: the qualifier ending does NOT finish the event - the knockout is not built yet',
    (await state(both)).status === 'live')
  await addMatches(both, buildKnockout([q1[0].a!, q1[1].a!], bothFormat.knockout!))
  check('...and building the knockout does not finish it', (await state(both)).status === 'live')
  const bothIds2 = await ids(both)
  await score(bothIds2, 'W1-0', 1, 0)
  const bothDone = await state(both)
  check('...it finishes when the knockout does, with that knockout\'s champion',
    bothDone.status === 'finished' && bothDone.champion_id === both.team.get(q1[0].a!))

  // -- groups only -------------------------------------------------------------------------------
  const groupsFormat: TournamentFormat = { qualifier: { format: 'groups', groupCount: 1, legs: 1, bestOf: 1 }, knockout: null }
  const gr = await liveEvent('Groups', groupsFormat, ['G1', 'G2', 'G3'])
  const groupMatches = buildGroupStage([['G1', 'G2', 'G3']], 1, 1)
  await addMatches(gr, groupMatches)
  const grIds = await ids(gr)
  for (const m of groupMatches.slice(0, 2)) await score(grIds, m.key, 1, 0)
  check('groups: two of three matches played is not finished', (await state(gr)).status === 'live')
  await score(grIds, groupMatches[2].key, 1, 0)
  check('groups: it finishes when the last group match is played', (await state(gr)).status === 'finished')

  // -- an administrator's word is final ------------------------------------------------------------
  const early = await liveEvent('Early', koFormat, ['Z1', 'Z2', 'Z3', 'Z4'])
  await addMatches(early, buildKnockout(['Z1', 'Z2', 'Z3', 'Z4'], koFormat.knockout!))
  const earlyIds = await ids(early)
  allowed('an admin can end an event early by hand', (await admin.client.from('tournaments').update({ status: 'finished' }).eq('id', early.id)).error)
  const manual = await state(early)
  check('...and it is recorded as theirs, not the bracket\'s', manual.status === 'finished' && !manual.finished_by_bracket && !!manual.finished_at)
  await score(earlyIds, 'W1-0', 1, 0)
  await score(earlyIds, 'W1-0', 0, 1)
  await score(earlyIds, 'W1-0', 0, 0)
  check('results changing afterwards never reopen an event an admin finished', (await state(early)).status === 'finished')

  allowed('an admin can reopen an event the bracket finished',
    (await admin.client.from('tournaments').update({ status: 'live' }).eq('id', ko.id)).error)
  const manualReopen = await state(ko)
  check('...which clears the finish time and champion, and takes it out of the bracket\'s hands',
    manualReopen.status === 'live' && manualReopen.finished_at === null && manualReopen.champion_id === null && !manualReopen.finished_by_bracket)

  // -- the window is open: teams may play early ----------------------------------------------------
  const future = await liveEvent('Early play', koFormat, ['P1', 'P2', 'P3', 'P4'])
  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString()
  const scheduled = applySchedule(
    buildKnockout(['P1', 'P2', 'P3', 'P4'], koFormat.knockout!),
    { startsAt: nextMonth, roundDays: 7, stageGapDays: 0, overrides: {} },
    { qualifierStage: null, qualifierRounds: 0 },
  )
  await addMatches(future, scheduled)
  const futureIds = await ids(future)
  const window = (await svc.from('tournament_matches').select('opens_at').eq('id', futureIds.get('W1-0')!).single()).data
  check('(setup) round 1 does not open for another month', new Date(window!.opens_at).getTime() > Date.now() + 29 * 86_400_000)
  allowed('a result can be recorded for a round that has not opened yet - the window is open, not gated',
    await score(futureIds, 'W1-0', 1, 0))
  check('...and it counts', (await svc.from('tournament_matches').select('status').eq('id', futureIds.get('W1-0')!).single()).data?.status === 'done')
}

// ===========================================================================================
// What the public sees, and several events at once
// ===========================================================================================
async function visibility(admin: Person, visitor: Person) {
  console.log('\nThe Official stat, and when an event first goes live')
  const stamp = async (id: string) => (await svc.from('tournaments').select('went_live_at, status').eq('id', id).single()).data!

  const draft = await newTournament({ status: 'draft', name: `Stamp ${run}` })
  check('a draft has never gone live', (await stamp(draft.id)).went_live_at === null)
  await svc.from('tournaments').update({ status: 'signup' }).eq('id', draft.id)
  check('...nor has an event taking signups', (await stamp(draft.id)).went_live_at === null)
  await admin.client.from('tournaments').update({ status: 'live' }).eq('id', draft.id)
  const first = (await stamp(draft.id)).went_live_at
  check('going live stamps the moment', !!first)
  await svc.from('tournaments').update({ description: 'edited' }).eq('id', draft.id)
  check('...and later edits do not move it', (await stamp(draft.id)).went_live_at === first)
  allowed('an admin can cancel the running event', (await admin.client.rpc('cancel_tournament', { p_tournament: draft.id })).error)
  check('cancelling does not clear it - the event still went live', (await stamp(draft.id)).went_live_at === first)
  await svc.from('tournaments').update({ status: 'live' }).eq('id', draft.id)
  check('...and reopening does not restamp it', (await stamp(draft.id)).went_live_at === first)

  const bornLive = await newTournament({ status: 'live', name: `Born live ${run}` })
  check('an event created already live is stamped on creation', !!(await stamp(bornLive.id)).went_live_at)
  const bornFinished = await newTournament({ status: 'finished', name: `Never live ${run}` })
  check('one created finished, having never been live, has no stamp', (await stamp(bornFinished.id)).went_live_at === null)

  const anon = createClient(API, ANON, clientOpts)
  const asVisitor = await visitor.client.rpc('official_stats_enabled')
  const asAnon = await anon.rpc('official_stats_enabled')
  check('once any event has gone live the Official stat is on, for a signed-in visitor and an anonymous one',
    asVisitor.data === true && asAnon.data === true, `${msg(asVisitor.error)} ${msg(asAnon.error)}`)
  const asAdmin = await admin.client.rpc('official_stats_enabled')
  check('...and the answer is only a yes or a no, the same for everyone', asAdmin.data === true)
}

async function eventNames(admin: Person, visitor: Person) {
  console.log('\nNaming an event')
  const nameOf = async (id: string) => (await svc.from('tournaments').select('name').eq('id', id).single()).data!.name as string

  const made = await admin.client.from('tournaments')
    .insert({ name: '  Autumn   Cup  ', status: 'signup', team_size: 1, max_roster: 1 }).select('id, name').single()
  allowed('an admin can name an event', made.error)
  const id = made.data!.id as string
  createdTournaments.push(id)
  check('the name is stored tidy - trimmed, with runs of spaces collapsed', made.data!.name === 'Autumn Cup', made.data!.name)

  allowed('an admin can rename it', (await admin.client.from('tournaments').update({ name: 'Autumn\n  Championship' }).eq('id', id)).error)
  check('...and a pasted line break is collapsed to a space', (await nameOf(id)) === 'Autumn Championship', await nameOf(id))
  check('the public sees the new name at once (one stored name, nothing copied)',
    (await visitor.client.from('tournaments').select('name').eq('id', id).single()).data?.name === 'Autumn Championship')

  const attempt = await visitor.client.from('tournaments').update({ name: 'Hijacked' }).eq('id', id).select()
  check('a player cannot rename an event', (attempt.data ?? []).length === 0 && (await nameOf(id)) === 'Autumn Championship')

  refused('a name that is too short once tidied is refused',
    (await admin.client.from('tournaments').update({ name: '  ab  ' }).eq('id', id)).error)
  refused('...as is one that is only whitespace',
    (await admin.client.from('tournaments').update({ name: '      ' }).eq('id', id)).error)
  refused('...and one over 80 characters',
    (await admin.client.from('tournaments').update({ name: 'x'.repeat(81) }).eq('id', id)).error)
  refused('an event cannot be created with no name',
    (await admin.client.from('tournaments').insert({ name: '', status: 'draft' })).error)
  check('none of those refusals changed the name', (await nameOf(id)) === 'Autumn Championship')

  allowed('a name of exactly 80 characters is allowed', (await admin.client.from('tournaments').update({ name: 'y'.repeat(80) }).eq('id', id)).error)
  allowed('accents and other scripts are allowed', (await admin.client.from('tournaments').update({ name: "L'Été des Tarnis 第二回" }).eq('id', id)).error)
  check('...and stored exactly as written', (await nameOf(id)) === "L'Été des Tarnis 第二回")

  // The name stays editable once the event is under way - fixing a typo shouldn't need a new event -
  // although the format is locked.
  await svc.from('tournaments').update({ status: 'live' }).eq('id', id)
  allowed('the name can still be corrected while the event is running',
    (await admin.client.from('tournaments').update({ name: 'Autumn Championship' }).eq('id', id)).error)
  refused('...though the format cannot',
    (await admin.client.from('tournaments').update({ format: { qualifier: { format: 'none' } } }).eq('id', id)).error, /already running/)
  const twin = await svc.from('tournaments').insert({ name: 'Autumn Championship', status: 'draft' }).select('id').single()
  if (twin.data) createdTournaments.push(twin.data.id as string) // tracked, so cleanup removes it
  allowed('two events may share a name (nothing in the schema stops a second "Autumn Championship")', twin.error)
}

interface InboxRow {
  invite_id: string
  tournament_id: string
  tournament_name: string
  team_name: string
  captain_name: string | null
  team_size: number
  roster_count: number
  max_roster: number
}

async function inviteInbox(admin: Person) {
  console.log('\nThe invitation inbox')
  void admin
  const cap = await person('ib_cap')
  const invitee = await person('ib_invitee')
  const other = await person('ib_other')
  const late = await person('ib_late')
  const noProfile = await person('ib_noprofile', { twitch: false })

  // Room for a third player, so a later invitation is not refused for want of space.
  const event = await newTournament({ team_size: 2, max_roster: 3, name: `Inbox ${run}` })
  const inbox = async (p: Person) => (await p.client.rpc('my_roster_invites')).data as InboxRow[] | null

  const team = (await cap.client.rpc('register_team', { p_tournament: event.id, p_name: 'Inbox Team', p_logins: [invitee.login] })).data as string
  check('(setup) a captain invited someone by name', !!team)
  // A second, unrelated pending team that invites somebody else - the invitee must learn nothing of it.
  const decoyCap = await person('ib_decoy')
  await decoyCap.client.rpc('register_team', { p_tournament: event.id, p_name: 'Secret Decoy', p_logins: [other.login] })

  const rows = (await inbox(invitee)) ?? []
  check('the invitee sees exactly one invitation', rows.length === 1, JSON.stringify(rows))
  const row = rows[0]
  check('...naming the event, the team, and who is captaining it',
    row?.tournament_name === `Inbox ${run}` && row.team_name === 'Inbox Team' && row.captain_name === 'ib_cap', JSON.stringify(row))
  check('...and how full the team is (1 of a possible 3, team size 2)', row?.roster_count === 1 && row.max_roster === 3 && row.team_size === 2)
  check('...and nothing about the other pending team', !JSON.stringify(rows).includes('Secret Decoy'))
  // Scoped to this event: approved teams in OTHER events are public by design and would be counted.
  check('but the invitee still cannot read pending teams directly - the policy was not loosened',
    ((await invitee.client.from('tournament_entrants').select('id').eq('tournament_id', event.id)).data ?? []).length === 0)

  check('a stranger\'s inbox is empty', ((await inbox(late)) ?? []).length === 0)
  check('the captain has no invitation of their own', ((await inbox(cap)) ?? []).length === 0)
  check('an account with no Twitch profile has an empty inbox, not an error', ((await inbox(noProfile)) ?? []).length === 0)
  check('the other invitee sees only theirs', ((await inbox(other)) ?? []).map((r) => r.team_name).join() === 'Secret Decoy')
  const anonymous = await createClient(API, ANON, clientOpts).rpc('my_roster_invites')
  check('an anonymous visitor gets an empty inbox, not an error and not anyone else\'s invitations',
    !anonymous.error && ((anonymous.data ?? []) as unknown[]).length === 0, msg(anonymous.error))

  await invitee.client.rpc('respond_to_roster_invite', { p_invite: row.invite_id, p_accept: true })
  check('accepting removes it from the inbox', ((await inbox(invitee)) ?? []).length === 0)

  // A declined one goes too, and one for an event that has since stopped taking signups is dead.
  const declineId = ((await inbox(other)) ?? [])[0]?.invite_id
  await other.client.rpc('respond_to_roster_invite', { p_invite: declineId, p_accept: false })
  check('declining removes it too', ((await inbox(other)) ?? []).length === 0)

  await cap.client.rpc('invite_to_roster', { p_entrant: team, p_logins: [late.login] })
  check('(setup) a new invitation arrives', ((await inbox(late)) ?? []).length === 1)
  await svc.from('tournaments').update({ status: 'live' }).eq('id', event.id)
  check('once the event stops taking signups the invitation drops out - it could only fail', ((await inbox(late)) ?? []).length === 0)
}

async function startRules(admin: Person) {
  console.log('\nStarting an event - administrators only')
  const captain = await person('st_cap')
  const player = await person('st_player')
  const admin2 = await person('st_admin2', { admin: true })

  interface StartEvent {
    id: string
    teams: string[]
  }
  /** An event with `count` approved teams (the first captained by a real user), in the given status. */
  const make = async (label: string, status = 'signup', count = 4): Promise<StartEvent> => {
    const t = await newTournament({ status, team_size: 1, max_roster: 1, name: `${label} ${run}` })
    const made = await svc.from('tournament_entrants').insert(
      Array.from({ length: count }, (_, i) => ({ tournament_id: t.id, name: `T${i + 1}`, captain_user_id: i === 0 ? captain.id : admin.id, status: 'approved' })),
    ).select('id, name')
    if (made.error) throw new Error(`teams: ${made.error.message}`)
    const teams = [...(made.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((e) => e.id as string)
    return { id: t.id, teams }
  }
  const paramsFor = (event: StartEvent, format = suggestFormat(event.teams.length).format) => {
    const schedule = suggestSchedule(format, event.teams.length, new Date().toISOString()).schedule
    const plan = planStart(format, event.teams, schedule)
    if (!plan.ok) throw new Error(`plan: ${plan.problems.join(', ')}`)
    return { p_tournament: event.id, p_format: format, p_schedule: schedule, p_seeds: event.teams, p_matches: toMatchRows(plan.plan.matches) }
  }
  const snapshot = async (event: StartEvent) => {
    const t = (await svc.from('tournaments').select('status, format, schedule, starts_at, went_live_at, champion_id').eq('id', event.id).single()).data!
    const seeds = ((await svc.from('tournament_entrants').select('seed').eq('tournament_id', event.id)).data ?? []).map((e) => e.seed)
    const matches = (await svc.from('tournament_matches').select('id', { count: 'exact', head: true }).eq('tournament_id', event.id)).count ?? 0
    return { ...t, seeds, matches }
  }
  const untouched = async (event: StartEvent) => {
    const s = await snapshot(event)
    return s.status === 'signup' && s.matches === 0 && s.seeds.every((x) => x === null)
  }

  // -- who may not ---------------------------------------------------------------------------------
  const target = await make('Guarded')
  const anon = createClient(API, ANON, clientOpts)
  // The function's OWN message, not merely "administrator": the trigger that guards team seeds also
  // says that word, and would refuse a non-admin even if this function forgot to ask. Matching the
  // exact sentence is what proves the explicit check is there, rather than a neighbour's.
  const ONLY_ADMINS = /Only an administrator can start an event/
  refused('an anonymous visitor cannot start an event', (await anon.rpc('start_tournament', paramsFor(target))).error, ONLY_ADMINS)
  refused('a signed-in player cannot', (await player.client.rpc('start_tournament', paramsFor(target))).error, ONLY_ADMINS)
  refused('the captain of an approved team cannot', (await captain.client.rpc('start_tournament', paramsFor(target))).error, ONLY_ADMINS)
  check('...and none of those attempts changed anything - no seeds, no matches, still taking signups', await untouched(target))

  // -- what state it must be in --------------------------------------------------------------------
  for (const status of ['draft', 'live', 'finished', 'cancelled']) {
    const wrong = await make(`State ${status}`, status)
    refused(`an event that is ${status} cannot be started`, (await admin.client.rpc('start_tournament', paramsFor(wrong))).error, /taking signups/)
  }

  // -- what it must be given -------------------------------------------------------------------------
  const good = paramsFor(target)
  refused('a team left out of the seeds is refused',
    (await admin.client.rpc('start_tournament', { ...good, p_seeds: target.teams.slice(1) })).error, /seeded/)
  refused('a team seeded twice is refused',
    (await admin.client.rpc('start_tournament', { ...good, p_seeds: [...target.teams.slice(0, 3), target.teams[0]] })).error, /seeded/)
  const stranger = (await make('Elsewhere', 'signup', 1)).teams[0]
  refused('a team from another event in the seeds is refused',
    (await admin.client.rpc('start_tournament', { ...good, p_seeds: [...target.teams.slice(0, 3), stranger] })).error, /seeded/)
  refused('a match naming a team that is not in this event is refused',
    (await admin.client.rpc('start_tournament', { ...good, p_matches: good.p_matches.map((m, i) => (i === 0 ? { ...m, entrant_a: stranger } : m)) })).error, /not in this event/)
  check('...and that failure - after seeds were set and matches inserted - left NOTHING behind (all or nothing)', await untouched(target))
  refused('starting with no matches is refused', (await admin.client.rpc('start_tournament', { ...good, p_matches: [] })).error, /no matches/)
  check('...and that left nothing behind either', await untouched(target))
  refused('a format with no qualifier is refused', (await admin.client.rpc('start_tournament', { ...good, p_format: { knockout: null } })).error, /qualifier/)

  const lonely = await make('Lonely', 'signup', 1)
  refused('an event with one approved team cannot start', (await admin.client.rpc('start_tournament', { ...good, p_tournament: lonely.id, p_seeds: lonely.teams, p_matches: [] })).error, /two approved/)

  // Pending and rejected teams are not in the event, so they are neither seeded nor drawn.
  const withPending = await make('Pending', 'signup', 4)
  await svc.from('tournament_entrants').insert({ tournament_id: withPending.id, name: 'Waiting', captain_user_id: admin.id, status: 'pending' })
  refused('a pending team in the seeds is refused',
    (await admin.client.rpc('start_tournament', { ...paramsFor(withPending), p_seeds: [...withPending.teams, (await svc.from('tournament_entrants').select('id').eq('tournament_id', withPending.id).eq('name', 'Waiting').single()).data!.id] })).error, /seeded/)

  // -- the start itself ----------------------------------------------------------------------------
  const started = await admin.client.rpc('start_tournament', good)
  check('an administrator can start it, and is told how many matches were drawn', !started.error && started.data === good.p_matches.length, msg(started.error) + ' ' + started.data)
  const after = await snapshot(target)
  check('the event is live, with its format and schedule saved',
    after.status === 'live' && after.format.qualifier.format === 'none' && after.schedule.roundDays > 0)
  check('...stamped as started, and as having gone live', !!after.starts_at && !!after.went_live_at)
  check('the teams were seeded 1 to 4 in the order given', [...after.seeds].sort().join() === '1,2,3,4')
  const seedOf = new Map(((await svc.from('tournament_entrants').select('id, seed').eq('tournament_id', target.id)).data ?? []).map((e) => [e.id, e.seed]))
  check('...exactly in the order handed over', target.teams.every((id, i) => seedOf.get(id) === i + 1))
  check('the matches are all there, each with its deadline', after.matches === good.p_matches.length &&
    ((await svc.from('tournament_matches').select('due_at').eq('tournament_id', target.id)).data ?? []).every((m) => !!m.due_at))
  refused('starting it a second time is refused - it is live now', (await admin.client.rpc('start_tournament', good)).error, /taking signups/)

  // -- a pending team is left alone -------------------------------------------------------------
  const ok = await admin.client.rpc('start_tournament', paramsFor(withPending))
  check('a team still pending is simply not in the event: the start goes ahead without it', !ok.error, msg(ok.error))
  const waiting = (await svc.from('tournament_entrants').select('status, seed').eq('tournament_id', withPending.id).eq('name', 'Waiting').single()).data
  check('...and stays pending with no seed', waiting?.status === 'pending' && waiting.seed === null)

  // -- two administrators at once ------------------------------------------------------------------
  const race = await make('Race')
  const both = await Promise.all([admin.client.rpc('start_tournament', paramsFor(race)), admin2.client.rpc('start_tournament', paramsFor(race))])
  const wins = both.filter((r) => !r.error).length
  check('two administrators starting the same event at once: exactly one succeeds', wins === 1, both.map((r) => msg(r.error) || 'ok').join(' | '))
  check('...and the event has one set of matches, not two', (await snapshot(race)).matches === paramsFor(race).p_matches.length)

  // -- the lifecycle, start to finish, for each kind of event ----------------------------------------
  const playAll = async (event: StartEvent) => {
    for (let i = 0; i < 60; i++) {
      const next = (await svc.from('tournament_matches').select('id, best_of, status').eq('tournament_id', event.id).in('status', ['ready', 'in_progress']).limit(1)).data?.[0]
      if (!next) return
      const need = Math.floor(next.best_of / 2) + 1
      const r = await admin.client.rpc('set_tournament_match_score', { p_match: next.id, p_score_a: need, p_score_b: 0 })
      if (r.error) throw new Error(r.error.message)
    }
  }
  const bracket = await make('Lifecycle KO')
  await admin.client.rpc('start_tournament', paramsFor(bracket))
  await playAll(bracket)
  const won = await snapshot(bracket)
  check('a started knockout plays through and finishes itself with a champion - the saved format is what tells it it is done',
    won.status === 'finished' && !!won.champion_id, JSON.stringify({ s: won.status, c: won.champion_id }))

  const swissFormat = { qualifier: { format: 'swiss' as const, rounds: 2, bestOf: 1 }, knockout: null }
  const swiss = await make('Lifecycle Swiss')
  const swissStart = await admin.client.rpc('start_tournament', paramsFor(swiss, swissFormat))
  check('a Swiss event starts with round 1 only (2 games for 4 teams)', !swissStart.error && swissStart.data === 2, msg(swissStart.error) + ' ' + swissStart.data)
  await playAll(swiss)
  check('...and is NOT finished when round 1 is played - round 2 has not been drawn', (await snapshot(swiss)).status === 'live')

  const groupsFormat = { qualifier: { format: 'groups' as const, groupCount: 1, legs: 1 as const, bestOf: 1 }, knockout: null }
  const groups = await make('Lifecycle Groups', 'signup', 3)
  const groupStart = await admin.client.rpc('start_tournament', paramsFor(groups, groupsFormat))
  check('a group event draws every group match at once (3 teams: 3 games)', !groupStart.error && groupStart.data === 3, msg(groupStart.error))
  await playAll(groups)
  check('...and finishes when the last one is played', (await snapshot(groups)).status === 'finished')
}

async function laterStages(admin: Person) {
  console.log('\nDrawing later stages - and handing on a captaincy')
  const captain = await person('lt_cap')
  const player = await person('lt_player')
  const ONLY_ADMINS = /Only an administrator can draw matches/

  /** A started event: `n` approved teams and the given format, with round 1 (or the whole first stage) drawn. */
  const started = async (label: string, format: TournamentFormat, n = 4) => {
    const t = await newTournament({ status: 'signup', team_size: 1, max_roster: 1, name: `${label} ${run}` })
    const made = await svc.from('tournament_entrants').insert(
      Array.from({ length: n }, (_, i) => ({ tournament_id: t.id, name: `T${i + 1}`, captain_user_id: i === 0 ? captain.id : admin.id, status: 'approved' })),
    ).select('id, name')
    if (made.error) throw new Error(made.error.message)
    const seeded = [...(made.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((e) => e.id as string)
    const schedule = suggestSchedule(format, n, new Date().toISOString()).schedule
    const plan = planStart(format, seeded, schedule)
    if (!plan.ok) throw new Error(plan.problems.join(', '))
    const r = await admin.client.rpc('start_tournament', { p_tournament: t.id, p_format: format, p_schedule: schedule, p_seeds: seeded, p_matches: toMatchRows(plan.plan.matches) })
    if (r.error) throw new Error(r.error.message)
    return { id: t.id, seeded, schedule }
  }
  const stored = async (id: string) => {
    const rows = ((await svc.from('tournament_matches').select('*').eq('tournament_id', id)).data ?? []) as Array<Record<string, unknown>>
    return { matches: rows.map(matchFromRow), ids: new Map(rows.map((r) => [r.key as string, r.id as string])) }
  }
  const playOpen = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      const open = ((await svc.from('tournament_matches').select('id, best_of').eq('tournament_id', id).in('status', ['ready', 'in_progress']).limit(1)).data ?? [])[0]
      if (!open) return
      const need = Math.floor(open.best_of / 2 + 1)
      const r = await admin.client.rpc('set_tournament_match_score', { p_match: open.id, p_score_a: need, p_score_b: 0 })
      if (r.error) throw new Error(r.error.message)
    }
  }
  const count = async (id: string, stage?: string) => {
    let q = svc.from('tournament_matches').select('id', { count: 'exact', head: true }).eq('tournament_id', id)
    if (stage) q = q.eq('stage', stage)
    return (await q).count ?? 0
  }
  const draw = (who: Person | ReturnType<typeof createClient>, id: string, stage: string, matches: TMatch[]) =>
    ('client' in who ? who.client : who).rpc('add_tournament_matches', { p_tournament: id, p_stage: stage, p_matches: toMatchRows(matches) })

  // -- a Swiss event with a knockout after it ------------------------------------------------------
  const format: TournamentFormat = {
    qualifier: { format: 'swiss', rounds: 2, bestOf: 1 },
    knockout: { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false, cutTo: 2 },
  }
  const ev = await started('Swiss then knockout', format)
  const noDeparted = new Set<string>()

  // Round 2 as the engine would draw it IF round 1 were over - which it is not.
  const imagined = (await stored(ev.id)).matches.map((m) => ({ ...m, status: 'done' as const, scoreA: 1, winner: m.a }))
  const roundTwoEarly = planNextSwissRound(format, ev.seeded, imagined, noDeparted, ev.schedule)
  if (!roundTwoEarly.ok) throw new Error(roundTwoEarly.problems.join(', '))
  refused('round 2 cannot be drawn while round 1 still has open matches', (await draw(admin, ev.id, 'swiss', roundTwoEarly.matches)).error, /not finished/)
  refused('the knockout cannot be built during the Swiss rounds',
    (await draw(admin, ev.id, 'knockout', buildKnockout(ev.seeded.slice(0, 2), format.knockout!))).error, /not all played/)
  check('...and neither attempt drew anything', (await count(ev.id)) === 2)

  await playOpen(ev.id)
  const roundTwo = planNextSwissRound(format, ev.seeded, (await stored(ev.id)).matches, noDeparted, ev.schedule)
  if (!roundTwo.ok) throw new Error(roundTwo.problems.join(', '))

  refused('an anonymous visitor cannot draw a round', (await draw(createClient(API, ANON, clientOpts), ev.id, 'swiss', roundTwo.matches)).error, ONLY_ADMINS)
  refused('a player cannot', (await draw(player, ev.id, 'swiss', roundTwo.matches)).error, ONLY_ADMINS)
  refused('a team captain cannot', (await draw(captain, ev.id, 'swiss', roundTwo.matches)).error, ONLY_ADMINS)
  refused('a round with the wrong number is refused - the next one is round 2',
    (await draw(admin, ev.id, 'swiss', roundTwo.matches.map((m) => ({ ...m, round: 3 })))).error, /next Swiss round is round 2/)
  refused('a stage that does not match its matches is refused', (await draw(admin, ev.id, 'knockout', roundTwo.matches)).error, /not all played|belong to the/)
  const foreign = (await make2('Elsewhere')).id
  refused('a match naming a team from another event is refused',
    (await draw(admin, ev.id, 'swiss', roundTwo.matches.map((m, i) => (i === 0 ? { ...m, a: foreign } : m)))).error, /not in this event/)
  check('...and none of those drew a thing (all or nothing)', (await count(ev.id)) === 2)

  const drawn = await draw(admin, ev.id, 'swiss', roundTwo.matches)
  check('an administrator can draw round 2, and is told how many matches', !drawn.error && drawn.data === 2, msg(drawn.error))
  refused('round 2 cannot be drawn twice', (await draw(admin, ev.id, 'swiss', roundTwo.matches)).error, /not finished/)
  await playOpen(ev.id)
  const roundThree = pairSwissRound(ev.seeded, (await stored(ev.id)).matches, 3, 1)
  refused('there is no round 3 in a two-round event', (await draw(admin, ev.id, 'swiss', roundThree)).error, /All 2 Swiss rounds/)
  check('the event is not finished - the knockout has not been built', ((await svc.from('tournaments').select('status').eq('id', ev.id).single()).data?.status) === 'live')

  const afterQualifier = (await stored(ev.id)).matches
  const status = qualifierStatus(format, ev.seeded, afterQualifier, noDeparted)
  check('the qualifier is complete, and two teams advance', status.complete && status.advancing.length === 2)
  refused('a knockout naming a team from another event is refused',
    (await draw(admin, ev.id, 'knockout', buildKnockout([status.advancing[0], foreign], format.knockout!))).error, /not in this event/)
  const ko = planKnockout(format, ev.seeded, afterQualifier, noDeparted, status.advancing, ev.schedule)
  if (!ko.ok) throw new Error(ko.problems.join(', '))
  const built = await draw(admin, ev.id, 'knockout', ko.matches)
  check('an administrator can build the knockout', !built.error && built.data === ko.matches.length, msg(built.error))
  refused('the knockout cannot be built twice', (await draw(admin, ev.id, 'knockout', ko.matches)).error, /already been built/)
  await playOpen(ev.id)
  const done = (await svc.from('tournaments').select('status, champion_id').eq('id', ev.id).single()).data
  check('played through, the event finishes itself with a champion', done?.status === 'finished' && !!done.champion_id)

  // -- other states and other formats ------------------------------------------------------------------
  const notLive = await newTournament({ status: 'signup', team_size: 1, max_roster: 1, name: `Not live ${run}` })
  refused('a draw for an event that has not started is refused', (await draw(admin, notLive.id, 'swiss', roundTwo.matches)).error, /running event/)
  // Left running on purpose: played out, a one-round Swiss event would finish itself, and the draw would
  // be refused for that instead of for the rule under test.
  const noKnockout = await started('No knockout', { qualifier: { format: 'swiss', rounds: 1, bestOf: 1 }, knockout: null })
  refused('an event with no knockout cannot be given one', (await draw(admin, noKnockout.id, 'knockout', buildKnockout(noKnockout.seeded, { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false }))).error, /no knockout/)
  const groupsOnly = await started('Groups only', { qualifier: { format: 'groups', groupCount: 1, legs: 1, bestOf: 1 }, knockout: null })
  refused('an event with no Swiss rounds cannot be given one', (await draw(admin, groupsOnly.id, 'swiss', pairSwissRound(groupsOnly.seeded, [], 1, 1))).error, /no Swiss rounds/)

  // -- a team removed before the knockout is built --------------------------------------------------------
  const fmt2: TournamentFormat = { qualifier: { format: 'swiss', rounds: 1, bestOf: 1 }, knockout: { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false, cutTo: 4 } }
  const dep = await started('Departed', fmt2)
  await playOpen(dep.id)
  await admin.client.rpc('forfeit_team', { p_entrant: dep.seeded[3] })
  const koWithGone = await draw(admin, dep.id, 'knockout', buildKnockout(dep.seeded, fmt2.knockout!))
  check('a knockout that includes a removed team is accepted (an administrator may know better)...', !koWithGone.error, msg(koWithGone.error))
  const gone = (await stored(dep.id)).matches.filter((m) => m.stage === 'knockout' && (m.a === dep.seeded[3] || m.b === dep.seeded[3]))
  check('...but the removed team is forfeited out of it at once, and never wins', gone.length > 0 && gone.every((m) => m.winner !== dep.seeded[3]) && gone.some((m) => m.resultKind === 'forfeit'))

  // -- handing a captaincy on ------------------------------------------------------------------------------
  const sub = await person('lt_mate')
  const other = await person('lt_other')
  const ce = await newTournament({ team_size: 2, max_roster: 3, name: `Captains ${run}` })
  const team = (await captain.client.rpc('register_team', { p_tournament: ce.id, p_name: 'Handover', p_logins: [sub.login] })).data as string
  await sub.client.rpc('respond_to_roster_invite', { p_invite: (await sub.client.rpc('my_roster_invites')).data[0].invite_id, p_accept: true })
  await svc.from('tournament_entrants').update({ status: 'approved' }).eq('id', team)
  const CAPTAIN_ONLY = /Only an administrator can change a team's captain/
  refused('a captain cannot hand their own team on', (await captain.client.rpc('hand_over_tournament_captaincy', { p_entrant: team, p_new_captain: sub.id })).error, CAPTAIN_ONLY)
  refused('a teammate cannot take it', (await sub.client.rpc('hand_over_tournament_captaincy', { p_entrant: team, p_new_captain: sub.id })).error, CAPTAIN_ONLY)
  refused('the new captain has to be on the team already', (await admin.client.rpc('hand_over_tournament_captaincy', { p_entrant: team, p_new_captain: other.id })).error, /on the team already/)
  refused('the current captain cannot be handed it again', (await admin.client.rpc('hand_over_tournament_captaincy', { p_entrant: team, p_new_captain: captain.id })).error, /already the captain/)
  check('(nothing changed)', ((await svc.from('tournament_entrants').select('captain_user_id').eq('id', team).single()).data?.captain_user_id) === captain.id)
  const codeBefore = (await captain.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', team).maybeSingle()).data?.entry_code
  refused('a substitute cannot take out the captain while they are captain', (await admin.client.rpc('substitute_player', { p_entrant: team, p_out: captain.id, p_in_login: other.login })).error, /hand the captaincy/)
  allowed('an administrator can hand it to a teammate', (await admin.client.rpc('hand_over_tournament_captaincy', { p_entrant: team, p_new_captain: sub.id })).error)
  const roster = ((await svc.from('tournament_roster').select('user_id, is_captain').eq('entrant_id', team)).data ?? [])
  check('exactly one captain, the new one, and the team record agrees',
    roster.filter((r) => r.is_captain).length === 1 && roster.find((r) => r.is_captain)?.user_id === sub.id &&
      ((await svc.from('tournament_entrants').select('captain_user_id').eq('id', team).single()).data?.captain_user_id) === sub.id)
  check('the new captain can read the team\'s entry code - the code stays with the team',
    ((await sub.client.rpc('my_roster_invites')).error === null) && (await sub.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', team).maybeSingle()).data?.entry_code === codeBefore)
  check('the old captain no longer can', (await captain.client.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', team).maybeSingle()).data === null)
  allowed('and the old captain can now be substituted out like anyone else',
    (await admin.client.rpc('substitute_player', { p_entrant: team, p_out: captain.id, p_in_login: other.login })).error)

  /** A throwaway event, only for its id (a team belonging to somewhere else). */
  async function make2(label: string) {
    const t = await newTournament({ status: 'signup', team_size: 1, max_roster: 1, name: `${label} ${run}` })
    const e = await svc.from('tournament_entrants').insert({ tournament_id: t.id, name: 'Stranger', captain_user_id: admin.id, status: 'approved' }).select('id').single()
    return { id: e.data!.id as string }
  }
}

async function officialMatches(admin: Person) {
  console.log('\nOfficial matches')
  const host = await person('om_host')
  const capB = await person('om_capb')
  const outsider = await person('om_out')
  const thrower = await person('om_thrower')
  const createdRooms: string[] = []
  const createdKeys: string[] = []

  try {
    /** A live two-team event. Team A is captained by `host`, team B by `capB`. Returns the ids and codes. */
    const event = async (label: string, bestOf: number) => {
      const t = await newTournament({ status: 'signup', team_size: 1, max_roster: 1, name: `${label} ${run}`, match_settings: { prep_seconds: 120, starting_seconds: 5 } })
      const made = await svc.from('tournament_entrants').insert([
        { tournament_id: t.id, name: 'Alpha', captain_user_id: host.id, status: 'pending' },
        { tournament_id: t.id, name: 'Bravo', captain_user_id: capB.id, status: 'pending' },
      ]).select('id, name')
      if (made.error) throw new Error(made.error.message)
      const [a, b] = ['Alpha', 'Bravo'].map((n) => made.data!.find((e) => e.name === n)!.id as string)
      await svc.from('tournament_entrants').update({ status: 'approved' }).in('id', [a, b])
      const codeOf = async (id: string) => (await svc.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', id).single()).data!.entry_code as string
      const format: TournamentFormat = { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf, thirdPlace: false, grandFinalReset: false } }
      const schedule = suggestSchedule(format, 2, new Date().toISOString()).schedule
      const plan = planStart(format, [a, b], schedule)
      if (!plan.ok) throw new Error(plan.problems.join(', '))
      const r = await admin.client.rpc('start_tournament', { p_tournament: t.id, p_format: format, p_schedule: schedule, p_seeds: [a, b], p_matches: toMatchRows(plan.plan.matches) })
      if (r.error) throw new Error(r.error.message)
      const matchId = (await svc.from('tournament_matches').select('id').eq('tournament_id', t.id).single()).data!.id as string
      return { id: t.id as string, a, b, codeA: await codeOf(a), codeB: await codeOf(b), matchId }
    }
    /** An ordinary room with `owner` as its host, made the way a browser makes one. */
    const room = async (owner: Person, tag: string) => {
      const code = `OM${run}${tag}`
      const made = await owner.client.from('rooms').insert({ code }).select('id, code').single()
      if (made.error) throw new Error(`room: ${made.error.message}`)
      createdRooms.push(made.data.id)
      const p = await owner.client.from('players').insert({ room_id: made.data.id, user_id: owner.id, nickname: owner.login, is_host: true })
      if (p.error) throw new Error(`host: ${p.error.message}`)
      return { id: made.data.id as string, code }
    }
    const join = (who: Person, roomId: string) => who.client.from('players').insert({ room_id: roomId, user_id: who.id, nickname: who.login })
    const seat = (who: Person, roomId: string, team: number | null) => who.client.from('players').update({ team }).eq('room_id', roomId).eq('user_id', who.id)
    const state = async (roomId: string) => (await svc.from('rooms').select('*').eq('id', roomId).single()).data!
    const link = async (who: Person, roomId: string, ev: { id: string }, code: string) =>
      (await who.client.rpc('link_official_room', { p_room: roomId, p_tournament: ev.id, p_code: code })).data as { ok: boolean; error?: string }
    const confirm = async (who: Person, roomId: string, code: string) =>
      (await who.client.rpc('confirm_official_team', { p_room: roomId, p_code: code })).data as { ok: boolean; error?: string }
    /**
     * Archives a finished game the way a real one is archived: as the database's own function running on
     * behalf of an ordinary player. That matters. The service key is deliberately exempt from several
     * guards (a cancelled event's freeze among them), so a report written with it would sail past the
     * very rules this is meant to exercise. Here the row is inserted as the table's owner - which is what
     * archive_match's SECURITY DEFINER makes it - with the request identity of a signed-in player.
     */
    const report = async (roomCode: string, key: string, winner: number | null, extra: { practice?: boolean; voided?: boolean } = {}) => {
      createdKeys.push(key)
      const sql = [
        'begin;',
        `select set_config('request.jwt.claims', '{"role":"authenticated","sub":"${host.id}"}', true);`,
        `insert into match_reports (match_key, room_code, winner_team, duration, total_shots, summary, report_text, practice, voided)`,
        `values ('${key}', '${roomCode}', ${winner === null ? 'null' : winner}, '10:00', 20, '{}'::jsonb, 'x', ${extra.practice ?? false}, ${extra.voided ?? false})`,
        'returning official, tournament_match_id;',
        'commit;',
      ].join('\n')
      try {
        const out = execFileSync('docker', ['exec', '-i', 'supabase_db_web', 'psql', '-U', 'postgres', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' })
        const last = out.trim().split('\n').filter(Boolean).pop() ?? ''
        const [official, matchId] = last.split('|')
        return { error: null as { message: string } | null, data: { official: official === 't', tournament_match_id: matchId || null } }
      } catch (e) {
        return { error: { message: (e as Error).message }, data: null }
      }
    }

    // ---------------------------------------------------------------------------------------------
    console.log('  -- linking a room')
    const e1 = await event('Official one', 1)
    const r1 = await room(host, 'A')
    await join(capB, r1.id)

    const notHost = await link(capB, r1.id, e1, e1.codeB)
    check('only the host can make a room official', !notHost.ok && /Only the host/.test(notHost.error ?? ''), notHost.error)
    const wrong = await link(host, r1.id, e1, 'ZZZZZZ')
    check('a wrong code is refused, in words that do not say what a right one looks like', !wrong.ok && /not right/.test(wrong.error ?? ''), wrong.error)
    check('...and the room is untouched', (await state(r1.id)).tournament_match_id === null)

    // The throttle: eight wrong guesses, then even the right code is refused.
    const rt = await room(thrower, 'T')
    let lastWrong: { ok: boolean; error?: string } = { ok: true }
    for (let i = 0; i < 8; i++) lastWrong = await link(thrower, rt.id, e1, `WRONG${i}`)
    const locked = await link(thrower, rt.id, e1, e1.codeA)
    check('after eight wrong codes even the right one is refused for an hour', !locked.ok && /Too many wrong codes/.test(locked.error ?? ''), `${lastWrong.error} / ${locked.error}`)

    const ok = await link(host, r1.id, e1, e1.codeA)
    check('the host can link with their team\'s code', ok.ok && ok.you_are === 'a', JSON.stringify(ok))
    const linked = await state(r1.id)
    check('...the room now points at the match, with the host\'s team confirmed and the other not',
      linked.tournament_match_id === e1.matchId && linked.official_a_confirmed === true && linked.official_b_confirmed === false)
    check('...and takes the tournament\'s settings (120s prep, 5s countdown)', linked.prep_seconds === 120 && linked.starting_seconds === 5, `${linked.prep_seconds}/${linked.starting_seconds}`)
    const again = await link(host, r1.id, e1, e1.codeA)
    check('a room that is already official cannot be linked again', !again.ok && /already/.test(again.error ?? ''))

    console.log('  -- nobody can fake it')
    refused('a host cannot set the link directly', (await host.client.from('rooms').update({ tournament_match_id: null }).eq('id', r1.id)).error, /official match controls/)
    refused('...nor confirm the other team by hand', (await host.client.from('rooms').update({ official_b_confirmed: true }).eq('id', r1.id)).error, /official match controls/)
    refused('...nor create a room that is already official',
      (await host.client.from('rooms').insert({ code: `OM${run}FAKE`, tournament_match_id: e1.matchId })).error, /official match controls/)
    refused('the tournament\'s settings cannot be changed by the host', (await host.client.from('rooms').update({ prep_seconds: 30 }).eq('id', r1.id)).error, /fixed by the tournament/)
    refused('an official match cannot be a practice match', (await host.client.from('rooms').update({ practice: true }).eq('id', r1.id)).error, /practice/i)
    refused('and it cannot start before both teams have confirmed', (await host.client.from('rooms').update({ status: 'placement' }).eq('id', r1.id)).error, /Both teams have to enter/)

    console.log('  -- the other team confirms')
    const wrongB = await confirm(capB, r1.id, 'ZZZZZZ')
    check('a wrong code does not confirm the other team', !wrongB.ok && /not right for the team you are playing/.test(wrongB.error ?? ''))
    const ownCode = await confirm(capB, r1.id, e1.codeB)
    check('the other team cannot use their OWN code to stand in for the host\'s', ownCode.ok === true, JSON.stringify(ownCode))
    const stillClosed = await state(r1.id)
    check('(entering the correct code for the team you are playing confirms it)', stillClosed.official_b_confirmed === true)

    console.log('  -- who may sit down')
    const outJoin = await join(outsider, r1.id)
    check('anyone can join an official room to watch', !outJoin.error, msg(outJoin.error))
    refused('...but a player who is on neither roster cannot take a seat', (await seat(outsider, r1.id, 0)).error, /only players on one of the two teams/)
    allowed('the host, who is on team A\'s roster, can take a fleet', (await seat(host, r1.id, 0)).error)
    check('...which becomes team A\'s fleet for the match', (await state(r1.id)).official_team_a === 0)
    refused('team B cannot take the same fleet', (await seat(capB, r1.id, 0)).error, /belongs to the other team/)
    allowed('...but can take the other one', (await seat(capB, r1.id, 1)).error)
    check('...which becomes team B\'s', (await state(r1.id)).official_team_b === 1)
    refused('and a team cannot move to the other team\'s fleet', (await seat(host, r1.id, 1)).error, /different fleet|belongs to the other/)
    allowed('once both have confirmed, the match can start', (await host.client.from('rooms').update({ status: 'placement' }).eq('id', r1.id)).error)

    console.log('  -- the result goes into the bracket')
    const rep = await report(r1.code, `OMK${run}:1`, 0)
    check('an archived official game is flagged official and tied to its match', !rep.error && rep.data?.official === true && rep.data.tournament_match_id === e1.matchId, msg(rep.error))
    const after = (await svc.from('tournament_matches').select('status, winner').eq('id', e1.matchId).single()).data
    check('...and Alpha (fleet 0) is recorded as the winner - the fleet number was mapped to the team', after?.status === 'done' && after.winner === e1.a, JSON.stringify(after))
    const done = (await svc.from('tournaments').select('status, champion_id').eq('id', e1.id).single()).data
    check('...so the bracket advanced by itself: the event finished with Alpha as champion', done?.status === 'finished' && done.champion_id === e1.a)
    const freed = await state(r1.id)
    check('...and the room, its series decided, is an ordinary room again', freed.tournament_match_id === null && !freed.official_a_confirmed && freed.official_team_a === null)
    const mp = await svc.from('match_participants').insert({ match_key: `OMK${run}:1`, user_id: host.id, nickname: 'om_host', team: 0, won: true }).select('official').single()
    check('a participant of an official match is flagged official', mp.data?.official === true, msg(mp.error))
    const board = (await svc.rpc('official_leaderboard')).data as Array<{ player_key: string; wins: number }>
    check('...and shows on the Official record with a win', board?.some((b) => b.player_key === host.id && Number(b.wins) >= 1))

    // ---------------------------------------------------------------------------------------------
    console.log('  -- a best of three, with the teams the other way round')
    const e3 = await event('Official three', 3)
    const r3 = await room(host, 'B')
    await join(capB, r3.id)
    await link(host, r3.id, e3, e3.codeA)
    await confirm(capB, r3.id, e3.codeB)
    await seat(capB, r3.id, 0) // Bravo sits first, on fleet 0
    await seat(host, r3.id, 1) // Alpha on fleet 1
    const s = await state(r3.id)
    check('fleets are bound to the team that sat first, not to a fixed order (Bravo on 0, Alpha on 1)', s.official_team_b === 0 && s.official_team_a === 1)
    await report(r3.code, `OMK${run}:2`, 0) // fleet 0 = Bravo wins game 1
    const g1 = (await svc.from('tournament_matches').select('status, score_a, score_b').eq('id', e3.matchId).single()).data
    check('game 1 to Bravo is 0-1 to Alpha-Bravo, and the series is still on', g1?.status === 'in_progress' && g1.score_a === 0 && g1.score_b === 1, JSON.stringify(g1))
    check('...the room stays official for game 2', (await state(r3.id)).tournament_match_id === e3.matchId)
    await report(r3.code, `OMK${run}:3`, 0)
    const g2 = (await svc.from('tournament_matches').select('status, score_b, winner').eq('id', e3.matchId).single()).data
    check('game 2 to Bravo decides it 0-2, and Bravo is the winner', g2?.status === 'done' && g2.score_b === 2 && g2.winner === e3.b, JSON.stringify(g2))
    check('...and the room is released', (await state(r3.id)).tournament_match_id === null)

    console.log('  -- a tournament problem never costs a real game its record')
    const e4 = await event('Official four', 1)
    const r4 = await room(host, 'C')
    await join(capB, r4.id)
    await link(host, r4.id, e4, e4.codeA)
    await confirm(capB, r4.id, e4.codeB)
    await seat(host, r4.id, 0)
    await seat(capB, r4.id, 1)
    await admin.client.rpc('cancel_tournament', { p_tournament: e4.id, p_reason: 'test' })
    const lost = await report(r4.code, `OMK${run}:4`, 0)
    check('a game finishing inside a CANCELLED event is still archived', !lost.error && lost.data?.official === true, msg(lost.error))
    check('...the bracket did not move (it is frozen)', (await svc.from('tournament_matches').select('status').eq('id', e4.matchId).single()).data?.status === 'ready')
    const fails = (await svc.from('official_result_failures').select('error, resolved, match_key').eq('match_key', `OMK${run}:4`)).data ?? []
    check('...and the failure was written down for an administrator, with the reason', fails.length === 1 && /cancelled|frozen/i.test(fails[0].error) && fails[0].resolved === false, JSON.stringify(fails))
    check('an administrator can read the failures list', ((await admin.client.from('official_result_failures').select('id').eq('match_key', `OMK${run}:4`)).data ?? []).length === 1)
    check('a player cannot', ((await host.client.from('official_result_failures').select('id')).data ?? []).length === 0)

    const e5 = await event('Official five', 1)
    const r5 = await room(host, 'D')
    await join(capB, r5.id)
    await link(host, r5.id, e5, e5.codeA)
    await confirm(capB, r5.id, e5.codeB)
    await seat(host, r5.id, 0)
    await seat(capB, r5.id, 1)
    const practiceReport = await report(r5.code, `OMK${run}:5`, 0, { practice: true, voided: true })
    check('a practice report is never treated as official', practiceReport.data?.official === false)
    const noWinner = await report(r5.code, `OMK${run}:6`, null)
    check('a game with no winner records nothing and is not an error', noWinner.data?.official === true &&
      (await svc.from('tournament_matches').select('status').eq('id', e5.matchId).single()).data?.status === 'ready' &&
      ((await svc.from('official_result_failures').select('id').eq('match_key', `OMK${run}:6`)).data ?? []).length === 0)
    const ordinary = await room(outsider, 'E')
    const plain = await report(ordinary.code, `OMK${run}:7`, 0)
    check('an ordinary room\'s game is not official, and nothing changes for it', plain.data?.official === false && plain.data.tournament_match_id === null)

    console.log('  -- unlinking')
    const notMine = (await outsider.client.rpc('unlink_official_room', { p_room: r5.id })).data as { ok: boolean }
    check('...outsiders cannot unlink someone else\'s official room', notMine.ok === false)
    const startedRoom = await state(r5.id)
    check('(setup) the room is still official', startedRoom.tournament_match_id === e5.matchId)
    const hostUnlink = (await host.client.rpc('unlink_official_room', { p_room: r5.id })).data as { ok: boolean }
    check('the host can unlink it while it is in the lobby', hostUnlink.ok === true && (await state(r5.id)).tournament_match_id === null)
    allowed('...after which its settings can be changed again', (await host.client.from('rooms').update({ prep_seconds: 200 }).eq('id', r5.id)).error)

    const r6 = await room(host, 'F')
    await join(capB, r6.id)
    const e6 = await event('Official six', 1)
    await link(host, r6.id, e6, e6.codeA)
    await confirm(capB, r6.id, e6.codeB)
    await seat(host, r6.id, 0)
    await seat(capB, r6.id, 1)
    await host.client.from('rooms').update({ status: 'placement' }).eq('id', r6.id)
    check('once the match has started, the host can no longer unlink', ((await host.client.rpc('unlink_official_room', { p_room: r6.id })).data as { ok: boolean }).ok === false)
    check('an administrator can, at any time', ((await admin.client.rpc('unlink_official_room', { p_room: r6.id })).data as { ok: boolean }).ok === true)

    console.log('  -- other refusals')
    const e7 = await event('Official seven', 1)
    const r7 = await room(host, 'G')
    await host.client.from('rooms').update({ practice: true }).eq('id', r7.id)
    const practiceLink = await link(host, r7.id, e7, e7.codeA)
    check('a practice room cannot be linked', !practiceLink.ok && /practice/i.test(practiceLink.error ?? ''))
    await host.client.from('rooms').update({ practice: false }).eq('id', r7.id)
    const wrongEvent = await link(host, r7.id, e1, e7.codeA)
    check('a code from one event is no use in another (and that event has finished anyway)', !wrongEvent.ok)
    const strangerSeat = await room(outsider, 'H')
    await seat(outsider, strangerSeat.id, 0)
    const e8 = await event('Official eight', 1)
    const seatedWrong = await link(host, strangerSeat.id, e8, e8.codeA)
    check('a room whose host is not the caller cannot be linked by someone else', !seatedWrong.ok && /Only the host/.test(seatedWrong.error ?? ''))

    console.log('  -- rooms: the sweeper and the cap')
    // An official room outlives the hour of silence; an ordinary one does not.
    const oldAt = new Date(Date.now() - 5 * 3_600_000).toISOString()
    const e9 = await event('Official nine', 1)
    const rOfficial = await room(host, 'P')
    await link(host, rOfficial.id, e9, e9.codeA)
    const rPlain = await room(outsider, 'Q')
    for (const id of [rOfficial.id, rPlain.id]) {
      await svc.from('rooms').update({ created_at: oldAt }).eq('id', id)
      await svc.from('players').update({ joined_at: oldAt }).eq('room_id', id)
    }
    await svc.rpc('prune_stale_rooms')
    const survivors = ((await svc.from('rooms').select('id').in('id', [rOfficial.id, rPlain.id])).data ?? []).map((r) => r.id)
    check('after five idle hours the official room survives the sweep', survivors.includes(rOfficial.id))
    check('...and the ordinary room does not', !survivors.includes(rPlain.id))
    const fourDays = new Date(Date.now() - 4 * 86_400_000).toISOString()
    await svc.from('rooms').update({ created_at: fourDays }).eq('id', rOfficial.id)
    await svc.from('players').update({ joined_at: fourDays }).eq('room_id', rOfficial.id)
    await svc.rpc('prune_stale_rooms')
    check('...but a forgotten official room goes after three days', ((await svc.from('rooms').select('id').eq('id', rOfficial.id)).data ?? []).length === 0)

    const unlinkedCount = async () => (await svc.from('rooms').select('id', { count: 'exact', head: true }).is('tournament_match_id', null)).count ?? 0
    const filler: string[] = []
    const existing = await unlinkedCount()
    if (existing <= 13) {
      const rLinked = await room(host, 'R')
      const e10 = await event('Official ten', 1)
      await link(host, rLinked.id, e10, e10.codeA)
      for (let i = existing; i < 14; i++) {
        const made = await svc.from('rooms').insert({ code: `OMFILL${run}${i}` }).select('id').single()
        if (made.error) throw new Error(made.error.message)
        filler.push(made.data.id)
      }
      const total = (await svc.from('rooms').select('id', { count: 'exact', head: true })).count ?? 0
      check('(setup) fourteen ordinary rooms plus an official one', (await unlinkedCount()) === 14 && total >= 15, `${await unlinkedCount()} ordinary, ${total} total`)
      const fifteenth = await svc.from('rooms').insert({ code: `OMFILL${run}X` }).select('id').single()
      if (fifteenth.data) filler.push(fifteenth.data.id)
      check('the official room did not use up a slot: a fifteenth ordinary room is allowed', !fifteenth.error, msg(fifteenth.error))
      const sixteenth = await svc.from('rooms').insert({ code: `OMFILL${run}Y` }).select('id').single()
      if (sixteenth.data) filler.push(sixteenth.data.id)
      check('...and the sixteenth is refused, as before', !!sixteenth.error && /game rooms are currently in use/.test(sixteenth.error.message), msg(sixteenth.error))
    } else {
      console.log(`  skip  the room cap check - ${existing} ordinary rooms already exist in this database`)
    }
    for (const id of filler) await svc.from('rooms').delete().eq('id', id)
  } finally {
    for (const id of createdRooms) await svc.from('rooms').delete().eq('id', id)
    for (const key of createdKeys) {
      await svc.from('match_participants').delete().eq('match_key', key)
      await svc.from('match_reports').delete().eq('match_key', key)
    }
    await svc.from('official_result_failures').delete().like('match_key', `OMK${run}%`)
    await svc.from('official_code_attempts').delete().eq('user_id', thrower.id)
  }
}

async function concurrentEvents(admin: Person) {
  console.log('\nEvents run separately')
  const p = await person('cx1')
  const r = await person('cx2')
  const evA = await newTournament({ status: 'signup', team_size: 2, max_roster: 2, name: `Concurrent A ${run}` })
  const evB = await newTournament({ status: 'signup', team_size: 2, max_roster: 2, name: `Concurrent B ${run}` })

  allowed('a player can captain a team in one event', (await p.client.rpc('register_team', { p_tournament: evA.id, p_name: 'Wolves' })).error)
  allowed('...and another in a second event at the same time (one team per event, not overall)',
    (await p.client.rpc('register_team', { p_tournament: evB.id, p_name: 'Wolves' })).error)
  // Scoped to these two events: a team called "Wolves" elsewhere in the database must not count.
  check('...even under the same team name',
    ((await p.client.from('tournament_entrants').select('id').eq('name', 'Wolves').in('tournament_id', [evA.id, evB.id])).data ?? []).length === 2)
  refused('but not two teams in the same event',
    (await p.client.rpc('register_team', { p_tournament: evA.id, p_name: 'Wolves Two' })).error, /already/)

  allowed('a player can be a free agent in the first event', (await r.client.rpc('sign_up_solo', { p_tournament: evA.id })).error)
  allowed('...and in the second at the same time', (await r.client.rpc('sign_up_solo', { p_tournament: evB.id })).error)
  const wolvesA = (await svc.from('tournament_entrants').select('id').eq('tournament_id', evA.id).single()).data!.id
  allowed('placing them on a team in event A', (await admin.client.rpc('assign_free_agent_to_team', { p_entrant: wolvesA, p_user: r.id })).error)
  const pool = async (eid: string) => (await svc.from('tournament_free_agents').select('status').eq('tournament_id', eid).eq('user_id', r.id).single()).data!.status
  check('...does not place them in event B, where they are still waiting', (await pool(evA.id)) === 'placed' && (await pool(evB.id)) === 'waiting')

  // Entry codes are unique inside an event but not across events.
  const wolvesB = (await svc.from('tournament_entrants').select('id').eq('tournament_id', evB.id).single()).data!.id
  await admin.client.from('tournament_entrants').update({ status: 'approved' }).in('id', [wolvesA, wolvesB])
  const codeA = (await svc.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', wolvesA).single()).data!.entry_code
  allowed('two events can hold the same entry code', (await svc.from('tournament_entrant_secrets').update({ entry_code: codeA }).eq('entrant_id', wolvesB)).error)
  const other = await person('cx3')
  const teamA2 = (await other.client.rpc('register_team', { p_tournament: evA.id, p_name: 'Foxes' })).data as string
  await admin.client.from('tournament_entrants').update({ status: 'approved' }).eq('id', teamA2)
  const dup = await svc.from('tournament_entrant_secrets').update({ entry_code: codeA }).eq('entrant_id', teamA2)
  refused('...but not two teams inside one event', dup.error ?? null, /unique|duplicate/i)

  console.log('\nOne event finishing, cancelling or removing a team leaves the others alone')
  const koFormat: TournamentFormat = { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false } }
  const live: LiveEvent[] = []
  for (const label of ['Live A', 'Live B', 'Live C']) {
    const e = await makeLiveEvent(admin, `${label}`, koFormat, ['X1', 'X2'])
    await addMatches(e, buildKnockout(['X1', 'X2'], koFormat.knockout!))
    live.push(e)
  }
  const [a, b, c] = live
  const [ia, ib, ic] = [await matchIds(a), await matchIds(b), await matchIds(c)]
  const status = async (e: LiveEvent) => (await svc.from('tournaments').select('status').eq('id', e.id).single()).data!.status
  const matchState = async (ids: Map<string, string>) => (await svc.from('tournament_matches').select('status').eq('id', ids.get('W1-0')!).single()).data!.status

  allowed('event A finishes', (await admin.client.rpc('set_tournament_match_score', { p_match: ia.get('W1-0'), p_score_a: 1, p_score_b: 0 })).error)
  check('...and B and C are still live, their matches still waiting',
    (await status(a)) === 'finished' && (await status(b)) === 'live' && (await status(c)) === 'live' &&
      (await matchState(ib)) === 'ready' && (await matchState(ic)) === 'ready')

  allowed('removing a team from event B', (await admin.client.rpc('forfeit_team', { p_entrant: b.team.get('X1') })).error)
  check('...finishes B (its only match was forfeited) and leaves A and C alone',
    (await status(b)) === 'finished' && (await status(c)) === 'live' && (await matchState(ic)) === 'ready')
  check('...whereas event C\'s team of the same name was not removed',
    (await svc.from('tournament_entrants').select('forfeited_at').eq('id', c.team.get('X1')!).single()).data!.forfeited_at === null)

  allowed('cancelling event C', (await admin.client.rpc('cancel_tournament', { p_tournament: c.id })).error)
  check('...freezes C', !!(await admin.client.rpc('set_tournament_match_score', { p_match: ic.get('W1-0'), p_score_a: 1, p_score_b: 0 })).error)
  // Reopen B and A's neighbours to show a cancelled C does not freeze anyone else.
  const fresh = await makeLiveEvent(admin, 'Live D', koFormat, ['X1', 'X2'])
  await addMatches(fresh, buildKnockout(['X1', 'X2'], koFormat.knockout!))
  const idFresh = await matchIds(fresh)
  allowed('an event started after C was cancelled takes results normally',
    (await admin.client.rpc('set_tournament_match_score', { p_match: idFresh.get('W1-0'), p_score_a: 1, p_score_b: 0 })).error)
  check('each event kept its own champion',
    (await svc.from('tournaments').select('champion_id').eq('id', a.id).single()).data!.champion_id === a.team.get('X1') &&
      (await svc.from('tournaments').select('champion_id').eq('id', b.id).single()).data!.champion_id === b.team.get('X2'))
}

// ===========================================================================================
// Test events, and deleting an event
// ===========================================================================================
/** Makes a test event and starts it; returns its id, still live, for deleting() to finish off. */
async function testEvents(admin: Person, visitor: Person): Promise<string> {
  console.log('\nTest events - made-up teams, administrators only')
  const anon = createClient(API, ANON, clientOpts)
  const ONLY = /Only an administrator can make a test event/
  const args = { p_name: `Test ${run}`, p_teams: 4, p_team_size: 2 }
  refused('a player cannot make a test event', (await visitor.client.rpc('create_test_tournament', args)).error, ONLY)
  refused('...nor can an anonymous visitor', (await anon.rpc('create_test_tournament', args)).error, ONLY)
  refused('it needs at least two teams', (await admin.client.rpc('create_test_tournament', { ...args, p_teams: 1 })).error, /between 2 and 64 teams/)
  refused('...and a team size from 1 to 10', (await admin.client.rpc('create_test_tournament', { ...args, p_team_size: 11 })).error, /between 1 and 10 players/)

  const made = await admin.client.rpc('create_test_tournament', { ...args, p_name: `  Test ${run}  ` })
  allowed('an admin can make one', made.error)
  const id = made.data as string
  if (!id) throw new Error('no test event to go on with')
  createdTournaments.push(id)

  const ev = (await svc.from('tournaments').select('name, status, is_test, team_size, max_roster').eq('id', id).single()).data
  check('it is a test event taking signups, with one roster place to spare for a substitution',
    ev?.is_test === true && ev.status === 'signup' && ev.team_size === 2 && ev.max_roster === 3 && ev.name === `Test ${run}`, JSON.stringify(ev))
  const teams = ((await svc
    .from('tournament_entrants')
    .select('id, status, captain_user_id, roster:tournament_roster(user_id, display_name, is_captain), secrets:tournament_entrant_secrets(entry_code)')
    .eq('tournament_id', id)).data ?? []) as Array<{
    id: string
    status: string
    captain_user_id: string
    roster: Array<{ user_id: string; display_name: string; is_captain: boolean }>
    secrets: { entry_code: string | null } | Array<{ entry_code: string | null }> | null
  }>
  check('it has four approved teams', teams.length === 4 && teams.every((t) => t.status === 'approved'), JSON.stringify(teams.map((t) => t.status)))
  check('...each of two made-up players, the captain among them',
    teams.every((t) => t.roster.length === 2 && t.roster.filter((r) => r.is_captain && r.user_id === t.captain_user_id).length === 1 &&
      t.roster.every((r) => r.display_name.startsWith('Tester '))))
  const codes = teams.map((t) => (Array.isArray(t.secrets) ? t.secrets[0]?.entry_code : t.secrets?.entry_code) ?? null)
  check('...and each holding its own entry code, as an approved team does', codes.every(Boolean) && new Set(codes).size === 4, JSON.stringify(codes))
  check('none of the made-up players is a real account',
    ((await svc.from('profiles').select('id').in('id', teams.flatMap((t) => t.roster.map((r) => r.user_id)))).data ?? []).length === 0)

  const sees = async (who: SupabaseClient) => ((await who.from('tournaments').select('id').eq('id', id)).data ?? []).length === 1
  check('a player cannot see it, though it is taking signups', !(await sees(visitor.client)))
  check('...nor can an anonymous visitor', !(await sees(anon)))
  check('...but an admin can', await sees(admin.client))
  const FIXED = /fixed when it is created/
  refused('it cannot be made public', (await admin.client.from('tournaments').update({ is_test: false }).eq('id', id)).error, FIXED)
  const real = await newTournament({ status: 'draft', name: `Real ${run}` })
  refused('...and a real event cannot be turned into a test one', (await admin.client.from('tournaments').update({ is_test: true }).eq('id', real.id)).error, FIXED)

  const seeds = teams.map((t) => t.id)
  const format = suggestFormat(seeds.length).format
  const schedule = suggestSchedule(format, seeds.length, new Date().toISOString()).schedule
  const plan = planStart(format, seeds, schedule)
  if (!plan.ok) throw new Error(`plan: ${plan.problems.join(', ')}`)
  allowed('it starts like any other event',
    (await admin.client.rpc('start_tournament', { p_tournament: id, p_format: format, p_schedule: schedule, p_seeds: seeds, p_matches: toMatchRows(plan.plan.matches) })).error)
  check('...and goes live', (await svc.from('tournaments').select('status, went_live_at').eq('id', id).single()).data?.status === 'live')
  check('its bracket is hidden from players', ((await visitor.client.from('tournament_matches').select('id').eq('tournament_id', id)).data ?? []).length === 0)
  const ready = (await svc.from('tournament_matches').select('id').eq('tournament_id', id).eq('status', 'ready').limit(1)).data?.[0]?.id
  allowed('an admin can enter a result in it', (await admin.client.rpc('set_tournament_match_score', { p_match: ready, p_score_a: 1, p_score_b: 0 })).error)
  return id
}

async function deleting(admin: Person, visitor: Person, testId: string) {
  console.log('\nDeleting an event')
  const ONLY = /Only an administrator can delete an event/
  const NOT_YET = /Only a draft or a cancelled event can be deleted/
  const koFormat: TournamentFormat = { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 1, thirdPlace: false, grandFinalReset: false } }

  /** Everything an event owns, counted - all zero once it is deleted. */
  const leftovers = async (id: string) => {
    const ents = ((await svc.from('tournament_entrants').select('id').eq('tournament_id', id)).data ?? []).map((e) => e.id as string)
    const [t, m, s, r] = await Promise.all([
      svc.from('tournaments').select('id', { count: 'exact', head: true }).eq('id', id),
      svc.from('tournament_matches').select('id', { count: 'exact', head: true }).eq('tournament_id', id),
      svc.from('tournament_entrant_secrets').select('entrant_id', { count: 'exact', head: true }).eq('tournament_id', id),
      svc.from('tournament_roster').select('user_id', { count: 'exact', head: true }).in('entrant_id', ents.length ? ents : ['00000000-0000-0000-0000-000000000000']),
    ])
    return (t.count ?? 0) + ents.length + (m.count ?? 0) + (s.count ?? 0) + (r.count ?? 0)
  }

  // The case that matters: cancelled part-way through, a result already in its (now frozen) bracket.
  const doomed = await makeLiveEvent(admin, 'Doomed', koFormat, ['D1', 'D2', 'D3', 'D4'])
  await addMatches(doomed, buildKnockout(['D1', 'D2', 'D3', 'D4'], koFormat.knockout!))
  const doomedIds = await matchIds(doomed)
  allowed('(setup) a semifinal is played', (await admin.client.rpc('set_tournament_match_score', { p_match: doomedIds.get('W1-0'), p_score_a: 1, p_score_b: 0 })).error)

  refused('a running event cannot be deleted - it has to be cancelled first',
    (await admin.client.rpc('delete_tournament', { p_tournament: doomed.id })).error, NOT_YET)
  const direct = await admin.client.from('tournaments').delete().eq('id', doomed.id).select()
  check('...not even by deleting the row directly', (direct.data ?? []).length === 0 && (await leftovers(doomed.id)) > 0, msg(direct.error))

  allowed('(setup) the event is cancelled', (await admin.client.rpc('cancel_tournament', { p_tournament: doomed.id })).error)
  refused('a player cannot delete it', (await visitor.client.rpc('delete_tournament', { p_tournament: doomed.id })).error, ONLY)
  refused('an event that does not exist cannot be deleted',
    (await admin.client.rpc('delete_tournament', { p_tournament: '00000000-0000-0000-0000-000000000000' })).error, /no such event/)
  allowed('an admin can delete the cancelled event, frozen bracket and all', (await admin.client.rpc('delete_tournament', { p_tournament: doomed.id })).error)
  check('...and nothing of it is left: event, teams, rosters, entry codes, bracket', (await leftovers(doomed.id)) === 0)

  const done = await newTournament({ status: 'finished', name: `Done for good ${run}` })
  refused('a finished event cannot be deleted', (await admin.client.rpc('delete_tournament', { p_tournament: done.id })).error, NOT_YET)
  const draft = await newTournament({ status: 'draft', name: `Unwanted ${run}` })
  allowed('a draft still can be', (await admin.client.rpc('delete_tournament', { p_tournament: draft.id })).error)

  allowed('a test event can be deleted while it is running', (await admin.client.rpc('delete_tournament', { p_tournament: testId })).error)
  check('...and nothing of it is left either', (await leftovers(testId)) === 0)
}

// ===========================================================================================
// The mirror: SQL against TypeScript
// ===========================================================================================
type Snapshot = {
  a: string | null
  b: string | null
  scoreA: number
  scoreB: number
  status: string
  winner: string | null
  kind: string
  phase: number | null
}

async function mirror() {
  console.log('\nSQL against the TypeScript engine (random operations, including illegal ones)')
  const admin = await person('mirroradmin', { admin: true })

  const configs: Array<{ n: number; label: string; opts: KnockoutOptions }> = []
  for (const n of [2, 3, 5, 8, 11]) {
    for (const bestOf of [1, 3]) {
      const base = { bestOf, thirdPlace: false, grandFinalReset: false }
      configs.push({ n, label: `single bo${bestOf}`, opts: { ...base, format: 'single' } })
      if (n >= 4) configs.push({ n, label: `single+3rd bo${bestOf}`, opts: { ...base, format: 'single', thirdPlace: true } })
      configs.push({ n, label: `double bo${bestOf}`, opts: { ...base, format: 'double' } })
      configs.push({ n, label: `double+reset bo${bestOf}`, opts: { ...base, format: 'double', grandFinalReset: true } })
    }
  }

  let totalOps = 0
  let acceptedOps = 0
  let finishedBrackets = 0
  let sawFinished = 0
  let sawReopened = 0
  const problems: string[] = []

  for (const [index, cfg] of configs.entries()) {
    const rand = rng(index * 7919 + 13)
    // The format goes on the tournament so the database knows this is a knockout-only event and can
    // decide for itself when it is over.
    const fmt: TournamentFormat = { qualifier: { format: 'none' }, knockout: { ...cfg.opts } }
    const tournament = await newTournament({ status: 'live', team_size: 1, max_roster: 1, format: fmt })

    const ids = Array.from({ length: cfg.n }, (_, i) => `e${i + 1}`)
    const uuid = new Map<string, string>()
    const entrantRows = await svc
      .from('tournament_entrants')
      .insert(ids.map((id) => ({ tournament_id: tournament.id, name: id, captain_user_id: admin.id, status: 'approved' })))
      .select('id, name')
    for (const e of entrantRows.data ?? []) uuid.set(e.name, e.id)
    const nameOf = new Map([...uuid.entries()].map(([k, v]) => [v, k]))

    let state: TMatch[] = buildKnockout(ids, cfg.opts)
    const insert = await svc.from('tournament_matches').insert(
      state.map((m) => ({
        tournament_id: tournament.id,
        key: m.key, stage: m.stage, bracket: m.bracket, grp: m.group, round: m.round, idx: m.index,
        entrant_a: m.a ? uuid.get(m.a) : null, entrant_b: m.b ? uuid.get(m.b) : null,
        best_of: m.bestOf, score_a: m.scoreA, score_b: m.scoreB, status: m.status,
        winner: m.winner ? uuid.get(m.winner) : null,
        winner_to_key: m.winnerTo?.key ?? null, winner_to_side: m.winnerTo?.side ?? null,
        loser_to_key: m.loserTo?.key ?? null, loser_to_side: m.loserTo?.side ?? null,
        reset_of: m.resetOf, is_bye: m.isBye, phase: m.phase,
      })),
    )
    if (insert.error) {
      problems.push(`${cfg.n}/${cfg.label}: could not insert bracket: ${insert.error.message}`)
      continue
    }
    const matchId = new Map(
      ((await svc.from('tournament_matches').select('id, key').eq('tournament_id', tournament.id)).data ?? []).map((r) => [r.key, r.id]),
    )

    const dbState = async (): Promise<Map<string, Snapshot>> => {
      const { data } = await svc
        .from('tournament_matches')
        .select('key, entrant_a, entrant_b, score_a, score_b, status, winner, result_kind, phase')
        .eq('tournament_id', tournament.id)
      return new Map(
        (data ?? []).map((r) => [
          r.key,
          {
            a: r.entrant_a ? nameOf.get(r.entrant_a) ?? '?' : null,
            b: r.entrant_b ? nameOf.get(r.entrant_b) ?? '?' : null,
            scoreA: r.score_a, scoreB: r.score_b, status: r.status,
            winner: r.winner ? nameOf.get(r.winner) ?? '?' : null,
            kind: r.result_kind, phase: r.phase,
          },
        ]),
      )
    }
    /** Which teams the database considers removed from the event. */
    const dbDeparted = async (): Promise<string> => {
      const { data } = await svc
        .from('tournament_entrants').select('name, forfeited_at').eq('tournament_id', tournament.id).not('forfeited_at', 'is', null)
      return (data ?? []).map((r) => r.name).sort().join(',')
    }
    let departed = new Set<string>()
    let wasFinished = false
    const diff = (db: Map<string, Snapshot>): string | null => {
      for (const m of state) {
        const d = db.get(m.key)
        if (!d) return `${m.key}: missing in the database`
        const t: Snapshot = { a: m.a, b: m.b, scoreA: m.scoreA, scoreB: m.scoreB, status: m.status, winner: m.winner, kind: m.resultKind, phase: m.phase }
        for (const k of Object.keys(t) as Array<keyof Snapshot>) {
          if (t[k] !== d[k]) return `${m.key}.${k}: TypeScript ${JSON.stringify(t[k])}, database ${JSON.stringify(d[k])}`
        }
      }
      return null
    }

    const start = diff(await dbState())
    if (start) {
      problems.push(`${cfg.n}/${cfg.label}: differs before any operation - ${start}`)
      continue
    }

    for (let step = 0; step < 70; step++) {
      // Mostly play the bracket forward, sometimes do something awkward.
      const live = state.filter((m) => m.status === 'ready' || m.status === 'in_progress')
      const roll = rand()
      const pickMatch = () => state[Math.floor(rand() * state.length)]
      let label: string
      let ts: Result<TMatch[]>
      let sql: { error: { message: string } | null }
      let nextDeparted = departed

      // Every score entry is followed by settling forfeits, exactly as the SQL wrapper does.
      const settle = (r: Result<TMatch[]>): Result<TMatch[]> => (r.ok ? settleForfeits(r.value, departed) : r)

      if (roll < 0.5 || roll >= 0.92) {
        // Mostly play forward. (The last slice is reinstating a team, handled below when one exists.)
        if (roll >= 0.92 && departed.size > 0) {
          const name = [...departed][Math.floor(rand() * departed.size)]
          label = `reinstate ${name}`
          nextDeparted = new Set(departed)
          nextDeparted.delete(name)
          ts = { ok: true, value: state }
          sql = await svc.from('tournament_entrants').update({ forfeited_at: null }).eq('id', uuid.get(name)!)
        } else {
          const target = live.length ? live[Math.floor(rand() * live.length)] : pickMatch()
          const need = winsNeeded(target.bestOf)
          const side = rand() < 0.5
          const loserGames = Math.floor(rand() * need)
          const [a, b] = rand() < 0.75 ? (side ? [need, loserGames] : [loserGames, need]) : [Math.floor(rand() * need), Math.floor(rand() * need)]
          label = `${target.key} ${a}-${b}`
          ts = settle(a === 0 && b === 0 ? revertMatch(state, target.key) : setScore(state, target.key, a, b))
          sql = await admin.client.rpc('set_tournament_match_score', { p_match: matchId.get(target.key), p_score_a: a, p_score_b: b })
        }
      } else if (roll < 0.62) {
        const target = pickMatch()
        label = `revert ${target.key}`
        ts = settle(revertMatch(state, target.key))
        sql = await admin.client.rpc('set_tournament_match_score', { p_match: matchId.get(target.key), p_score_a: 0, p_score_b: 0 })
      } else if (roll < 0.72) {
        const target = pickMatch()
        const need = winsNeeded(target.bestOf)
        const [a, b] = [Math.floor(rand() * (need + 2)), Math.floor(rand() * (need + 2))]
        label = `${target.key} ${a}-${b} (arbitrary)`
        ts = settle(a === 0 && b === 0 ? revertMatch(state, target.key) : setScore(state, target.key, a, b))
        sql = await admin.client.rpc('set_tournament_match_score', { p_match: matchId.get(target.key), p_score_a: a, p_score_b: b })
      } else if (roll < 0.82) {
        const target = live.length && rand() < 0.8 ? live[Math.floor(rand() * live.length)] : pickMatch()
        const loser = rand() < 0.5 ? 'a' : 'b'
        label = `forfeit ${target.key} by ${loser}`
        ts = settle(forfeitMatch(state, target.key, loser))
        sql = await admin.client.rpc('forfeit_tournament_match', { p_match: matchId.get(target.key), p_loser: loser })
      } else {
        const name = ids[Math.floor(rand() * ids.length)]
        label = `remove team ${name}`
        if (wasFinished) {
          // The database only removes a team from a RUNNING event; one the bracket has finished has
          // nothing left to forfeit. The TypeScript has no notion of event status, so state the rule.
          ts = { ok: false, error: 'the event is finished' }
        } else {
          nextDeparted = new Set(departed).add(name)
          ts = settleForfeits(state, nextDeparted)
        }
        sql = await admin.client.rpc('forfeit_team', { p_entrant: uuid.get(name) })
      }
      totalOps++

      if (ts.ok === !!sql.error) {
        problems.push(`${cfg.n}/${cfg.label} step ${step}: ${label}: TypeScript ${ts.ok ? 'allowed' : `refused (${ts.error})`}, database ${sql.error ? `refused (${sql.error.message})` : 'allowed'}`)
        break
      }
      if (ts.ok) {
        state = ts.value
        departed = nextDeparted
        acceptedOps++
      }
      const drift = diff(await dbState())
      if (drift) {
        problems.push(`${cfg.n}/${cfg.label} step ${step}: after ${label} (${ts.ok ? 'allowed' : 'refused'}): ${drift}`)
        break
      }
      const dbGone = await dbDeparted()
      if (dbGone !== [...departed].sort().join(',')) {
        problems.push(`${cfg.n}/${cfg.label} step ${step}: after ${label}: removed teams differ - TypeScript [${[...departed].sort()}], database [${dbGone}]`)
        break
      }

      // The event's own status: finished exactly when the bracket is complete, with the right
      // champion, and back to live whenever a correction reopens it.
      const wantFinished = tournamentComplete(fmt, state)
      const wantChampion = eventChampion(fmt, state)
      const t = (await svc.from('tournaments').select('status, champion_id, finished_at, finished_by_bracket').eq('id', tournament.id).single()).data
      const gotChampion = t?.champion_id ? nameOf.get(t.champion_id) ?? '?' : null
      if (t?.status !== (wantFinished ? 'finished' : 'live') || gotChampion !== wantChampion ||
          (wantFinished ? !t.finished_at || !t.finished_by_bracket : !!t?.finished_at || t?.finished_by_bracket)) {
        problems.push(`${cfg.n}/${cfg.label} step ${step}: after ${label}: event should be ${wantFinished ? 'finished' : 'live'} champion ${wantChampion}; database has ${t?.status} champion ${gotChampion} finished_at ${t?.finished_at} by_bracket ${t?.finished_by_bracket}`)
        break
      }
      if (wantFinished) sawFinished++
      if (wasFinished && !wantFinished) sawReopened++
      wasFinished = wantFinished
    }
    if (state.every((m) => m.status === 'done' || m.status === 'skipped')) finishedBrackets++
  }

  check(`${configs.length} bracket configurations, ${totalOps} operations: the database and the TypeScript never disagreed`,
    problems.length === 0, problems.slice(0, 4).join(' | '))
  check(`the operations were not all refusals (${acceptedOps} accepted)`, acceptedOps > totalOps * 0.3, `${acceptedOps}/${totalOps}`)
  check(`some brackets were played all the way to the end (${finishedBrackets})`, finishedBrackets > 0)
  check(`the event was seen finishing itself (${sawFinished} checks) and reopening after a correction (${sawReopened} times)`,
    sawFinished > 0 && sawReopened > 0, `finished ${sawFinished}, reopened ${sawReopened}`)

  // Non-knockout matches have no pointers: scoring one must touch nothing else.
  const T = await newTournament({ status: 'live', team_size: 1, max_roster: 1 })
  const esInsert = await svc.from('tournament_entrants').insert(
    ['S1', 'S2', 'S3', 'S4'].map((n) => ({ tournament_id: T.id, name: n, captain_user_id: admin.id })),
  ).select('id')
  if (esInsert.error) throw new Error(`could not create the Swiss entrants: ${esInsert.error.message}`)
  const es = esInsert.data ?? []
  const swiss = (await svc.from('tournament_matches').insert([
    { tournament_id: T.id, key: 'S1-0', stage: 'swiss', round: 1, idx: 0, entrant_a: es[0].id, entrant_b: es[1].id, status: 'ready' },
    { tournament_id: T.id, key: 'S1-1', stage: 'swiss', round: 1, idx: 1, entrant_a: es[2].id, entrant_b: es[3].id, status: 'ready' },
  ]).select('id, key')).data ?? []
  await admin.client.rpc('set_tournament_match_score', { p_match: swiss[0].id, p_score_a: 1, p_score_b: 0 })
  const after = (await svc.from('tournament_matches').select('key, status, winner').eq('tournament_id', T.id)).data ?? []
  check('a Swiss result records without touching any other match',
    after.find((r) => r.key === 'S1-0')?.status === 'done' && after.find((r) => r.key === 'S1-1')?.status === 'ready')
}

// ===========================================================================================
try {
  await rules()
  await mirror()
} catch (e) {
  console.log(` FAIL  the script itself failed: ${(e as Error).message}`)
  failures++
} finally {
  await cleanup()
}

if (transportRetries > 0) console.log(`\n(${transportRetries} network-level retries against the local stack)`)
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
