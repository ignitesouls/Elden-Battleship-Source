/**
 * Photographs the tournament screens that only exist for a signed-in player or an administrator, by
 * building real people in the LOCAL database in each state and driving headless Chrome as them.
 *
 * It needs the app running against the local stack:
 *
 *   npm run local:up
 *   npm run dev:local -- --port 5199
 *   node --experimental-strip-types scripts/screenshot-tournament-ui.ts <output folder>
 *
 * LOCAL ONLY (see scripts/support/local-stack.ts). It creates users and events and removes them again.
 */
import { anonClient, check, finish, person, svc, trackTournament, run } from './support/local-stack.ts'
import type { Person } from './support/local-stack.ts'
import { clickIn, clickText, shot } from './support/shot.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: node --experimental-strip-types scripts/screenshot-tournament-ui.ts <output folder>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const BASE = process.env.APP_BASE ?? 'http://localhost:5199/Elden-Battleship/'

/** A real session for `who`, as the browser would hold it after signing in. */
async function sessionFor(who: Person) {
  const { data, error } = await anonClient().auth.signInWithPassword({ email: who.email, password: who.password })
  if (error || !data.session) throw new Error(`session for ${who.name}: ${error?.message}`)
  return data.session
}

async function look(name: string, who: Person | null, route: string, steps: string[] = []) {
  await shot({ base: BASE, route, out: join(outDir, `${name}.png`), session: who ? await sessionFor(who) : undefined, steps })
  console.log(`  shot  ${name}`)
}

try {
  const admin = await person('scr_admin', { admin: true })
  const alice = await person('scr_alice')
  const bob = await person('scr_bob')
  const cara = await person('scr_cara')
  const dave = await person('scr_dave')
  const erin = await person('scr_erin')
  const frank = await person('scr_frank')
  const gina = await person('scr_gina')

  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await svc.from('tournaments').insert({ name: `${name} ${run}`, status: 'signup', team_size: 3, ...extra }).select('id').single()
    if (r.error) throw new Error(r.error.message)
    trackTournament(r.data.id as string)
    return r.data.id as string
  }
  const soon = new Date(Date.now() + 4 * 86_400_000).toISOString()
  const one = await mk('Screen Cup', { signup_closes_at: soon, max_entrants: 12 })
  const two = await mk('Second Cup', { signup_closes_at: soon })
  await mk('Hidden Draft', { status: 'draft' })

  // One: alice's team is awaiting approval and has invited bob and cara; frank has nothing yet; gina is a free agent.
  await alice.client.rpc('register_team', { p_tournament: one, p_name: 'Screen Wolves', p_logins: [bob.login, cara.login] })
  await cara.client.rpc('respond_to_roster_invite', { p_invite: (await cara.client.rpc('my_roster_invites')).data[0].invite_id, p_accept: false })
  await gina.client.rpc('sign_up_solo', { p_tournament: one, p_note: 'Evenings in Europe, happy to play support' })

  // Two: dave's team is complete and approved, so it has an entry code.
  const daveTeam = (await dave.client.rpc('register_team', { p_tournament: two, p_name: 'Approved Herons', p_logins: [erin.login] })).data as string
  await erin.client.rpc('respond_to_roster_invite', { p_invite: (await erin.client.rpc('my_roster_invites')).data[0].invite_id, p_accept: true })
  await svc.from('tournament_entrants').update({ status: 'approved' }).eq('id', daveTeam)

  console.log('Taking screenshots...')
  await look('01_captain_pending', alice, `#/event/${one}`)
  await look('02_captain_approved', dave, `#/event/${two}`)
  await look('03_invitee_event', bob, `#/event/${one}`)
  await look('04_invitee_home', bob, '#/')
  await look('05_signup_forms', frank, `#/event/${one}`)
  await look('06_solo_waiting', gina, `#/event/${one}`)
  // Scoped to this run's own event: the demo events on a dev database repeat every button.
  await look('07_admin_teams', admin, '#/admin', [clickIn(`Screen Cup ${run}`, 'Manage teams')])
  // Approve the pending team in the real UI, then look at the result: the entry code should appear.
  await look('08_admin_approved', admin, '#/admin', [clickIn(`Screen Cup ${run}`, 'Manage teams'), clickIn('Screen Wolves', 'Approve')])

  // -- the start page: administrators only ---------------------------------------------------------
  const startable = await mk('Startable Cup', { team_size: 1, signup_closes_at: soon })
  await svc.from('tournament_entrants').insert(
    ['Anchors', 'Buoys', 'Cutters', 'Drifters', 'Ebbtide', 'Flotsam'].map((name) => ({ tournament_id: startable, name, captain_user_id: admin.id, status: 'approved' })),
  )
  await svc.from('tournament_entrants').insert({ tournament_id: startable, name: 'Late Entry', captain_user_id: admin.id, status: 'pending' })
  const startRoute = `#/admin/event/${startable}/start`
  const status = async () => (await svc.from('tournaments').select('status').eq('id', startable).single()).data?.status

  await look('09_start_as_anonymous', null, startRoute)
  await look('10_start_as_player', frank, startRoute)
  await look('11_start_as_captain', dave, startRoute)
  check('none of the three non-admins could start it - the event is still taking signups', (await status()) === 'signup')

  await look('12_start_as_admin', admin, startRoute)

  // The real thing: accept the confirmation and press Start in the browser, as an administrator.
  await look('13_started', admin, startRoute, ['window.confirm = () => true', clickText('Start the event')])
  const matches = (await svc.from('tournament_matches').select('id', { count: 'exact', head: true }).eq('tournament_id', startable)).count ?? 0
  check('pressing Start in the browser, as an admin, started the event', (await status()) === 'live' && matches > 0, `${await status()} with ${matches} matches`)
  const seeds = ((await svc.from('tournament_entrants').select('seed').eq('tournament_id', startable).eq('status', 'approved')).data ?? []).map((e) => e.seed).sort()
  check('...with the six teams seeded 1 to 6', seeds.join() === '1,2,3,4,5,6', seeds.join())
} catch (e) {
  console.log(` FAIL  ${(e as Error).message}`)
  const { tally } = await import('./support/local-stack.ts')
  tally.failures++
}

await finish()
