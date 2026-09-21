/**
 * Runs the tournament API layer (src/lib/tournament/api.ts) - the functions the pages call - against
 * the real local database, as real users.
 *
 * TypeScript cannot check a query string. A wrong relationship hint in an embedded select, a filter
 * PostgREST parses differently from how it reads, a column a policy hides: all of these compile and
 * then fail on the first request. So this executes every read and write the screens depend on, as the
 * person who will actually make it - an administrator, a captain, an invitee, a stranger, an anonymous
 * visitor - and checks the answers are the ones a page needs.
 *
 * LOCAL ONLY (see scripts/support/local-stack.ts). Start the stack first:  npm run local:up
 *
 *   node --experimental-strip-types scripts/check-tournament-api.ts
 */
import { registerHooks } from 'node:module'

// api.ts imports the Vite-built client; under Node it gets the shim, which lets us act as anyone.
const shimUrl = new URL('./support/api-supabase-shim.ts', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../supabase' && context.parentURL?.endsWith('/tournament/api.ts')) {
      return { url: shimUrl, shortCircuit: true }
    }
    // Only our own sources are extensionless TypeScript; a library's relative imports must be left alone.
    const ours = !context.parentURL?.includes('/node_modules/')
    if (ours && specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { actAs } = await import('./support/api-supabase-shim.ts')
const { anonClient, svc, check, person, trackTournament, finish, run } = await import('./support/local-stack.ts')
const api = await import('../src/lib/tournament/api.ts')
const { frontPageBanners } = await import('../src/lib/tournament/frontPage.ts')
import type { Person } from './support/local-stack.ts'

const day = 86_400_000
/** Runs `fn` as `who` (a person, or null for an anonymous visitor) and returns what it returned or threw. */
async function as<T>(who: Person | null, fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  actAs(who ? who.client : anonClient())
  try {
    return { value: await fn() }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

try {
  const admin = await person('apiadmin', { admin: true })
  const captain = await person('apicap')
  const invitee = await person('apiinv')
  const soloist = await person('apisolo')
  const stranger = await person('apistranger')

  console.log('\nParsing a box of Twitch names')
  check('splits on lines, commas, spaces and semicolons, drops @, lower-cases, removes duplicates',
    JSON.stringify(api.parseLogins('@Foo, bar  baz\nQUX;foo\n\n  @Bar ')) === '["foo","bar","baz","qux"]',
    JSON.stringify(api.parseLogins('@Foo, bar  baz\nQUX;foo\n\n  @Bar ')))
  check('empty and whitespace-only input give nothing', api.parseLogins('').length === 0 && api.parseLogins('  \n , ').length === 0)

  console.log('\nCreating and opening an event')
  const created = await as(admin, () => api.createEvent({
    name: `API Cup ${run}`, description: 'Fall league', team_size: 2, max_roster: 3, max_entrants: 8,
    signup_closes_at: new Date(Date.now() + 7 * day).toISOString(),
  }))
  check('an admin can create an event', !!created.value, created.error)
  const eventId = created.value!
  trackTournament(eventId)

  check('a draft is not on the front page for an anonymous visitor',
    !(await as(null, () => api.fetchFrontPageEvents(Date.now()))).value!.some((e) => e.id === eventId))
  check('...nor for a signed-in player', !(await as(stranger, () => api.fetchFrontPageEvents(Date.now()))).value!.some((e) => e.id === eventId))
  check('...and fetching it directly finds nothing', (await as(stranger, () => api.fetchEvent(eventId))).value === null)
  check('...but an admin can fetch it', (await as(admin, () => api.fetchEvent(eventId))).value?.status === 'draft')
  check('a player cannot create an event', !!(await as(stranger, () => api.createEvent({ name: 'Nope Cup', description: '', team_size: 1, max_roster: 1, max_entrants: null, signup_closes_at: null }))).error)

  await as(admin, () => api.setEventStatus(eventId, 'signup'))
  const front = (await as(null, () => api.fetchFrontPageEvents(Date.now()))).value!
  const mine = front.find((e) => e.id === eventId)
  check('once signup is open the event is on the front page, for a visitor with no account', !!mine)
  check('...with its name, status and closing time', mine?.name === `API Cup ${run}` && mine.status === 'signup' && !!mine.signupClosesAt)
  check('...and the banner logic turns it into an open-signup banner',
    frontPageBanners(front, new Date()).find((b) => b.event.id === eventId)?.kind === 'signup')
  const detail = (await as(null, () => api.fetchEvent(eventId))).value
  check('an anonymous visitor can read the event page data',
    detail?.name === `API Cup ${run}` && detail.team_size === 2 && detail.max_roster === 3 && detail.description === 'Fall league')

  console.log('\nSigning a team up')
  const noTeam = await as(stranger, () => api.registerTeam(eventId, 'X', []))
  check('the server\'s own words come through when something is refused - here, a team name that is too short',
    /violates check constraint/i.test(noTeam.error ?? ''), noTeam.error)
  const team = await as(captain, () => api.registerTeam(eventId, 'Api Team', api.parseLogins(`@${invitee.login}`)))
  check('a captain can sign a team up and name a teammate', !!team.value, team.error)
  const teamId = team.value!

  const teamsAsCaptain = (await as(captain, () => api.fetchTeams(eventId))).value!
  const mineAsCaptain = teamsAsCaptain.find((t) => t.id === teamId)
  check('the captain sees their pending team, with themselves on the roster',
    mineAsCaptain?.status === 'pending' && mineAsCaptain.roster.length === 1 && mineAsCaptain.roster[0].is_captain, JSON.stringify(mineAsCaptain))
  check('a stranger does not see the pending team', !(await as(stranger, () => api.fetchTeams(eventId))).value!.some((t) => t.id === teamId))
  check('the captain can read their invitations',
    (await as(captain, () => api.fetchTeamInvites(teamId))).value!.map((i) => i.twitch_login).join() === invitee.login)

  const inbox = (await as(invitee, () => api.fetchMyInbox())).value!
  check('the invitee\'s inbox names the team and event', inbox.length === 1 && inbox[0].team_name === 'Api Team' && inbox[0].tournament_id === eventId, JSON.stringify(inbox))
  check('a stranger\'s inbox is empty', (await as(stranger, () => api.fetchMyInbox())).value!.length === 0)
  check('an anonymous visitor\'s inbox is empty, without an error', (await as(null, () => api.fetchMyInbox())).value?.length === 0)
  const accepted = await as(invitee, () => api.respondToInvite(inbox[0].invite_id, true))
  check('the invitee can accept', !accepted.error, accepted.error)
  const after = (await as(captain, () => api.fetchTeams(eventId))).value!.find((t) => t.id === teamId)
  check('...and is on the roster', after?.roster.length === 2 && after.roster.some((m) => m.user_id === invitee.id))
  check('...and as a member they can now see the pending team', (await as(invitee, () => api.fetchTeams(eventId))).value!.some((t) => t.id === teamId))

  console.log('\nInvitations and the roster')
  check('the captain can invite another player by name', ((await as(captain, () => api.inviteToTeam(teamId, [stranger.login]))).value ?? 0) === 1)
  const strangerInvite = (await as(captain, () => api.fetchTeamInvites(teamId))).value!.find((i) => i.twitch_login === stranger.login)
  check('...and can withdraw it', !(await as(captain, () => api.cancelInvite(strangerInvite!.id))).error)
  check('...after which it is gone', !(await as(captain, () => api.fetchTeamInvites(teamId))).value!.some((i) => i.twitch_login === stranger.login))
  const rename = await as(captain, () => api.renameTeam(teamId, 'Api Wolves'))
  check('the captain can rename the team while signup is open', !rename.error && (await as(captain, () => api.fetchTeams(eventId))).value!.find((t) => t.id === teamId)?.name === 'Api Wolves', rename.error)
  check('a stranger cannot rename it', (await as(stranger, () => api.renameTeam(teamId, 'Hijacked'))).error === undefined
    && (await as(captain, () => api.fetchTeams(eventId))).value!.find((t) => t.id === teamId)?.name === 'Api Wolves')

  console.log('\nApproving a team, and the entry code')
  const adminView = (await as(admin, () => api.adminTeams(eventId))).value!
  check('an admin sees the pending team with no entry code yet', adminView.find((t) => t.id === teamId)?.entry_code === null && adminView.find((t) => t.id === teamId)?.status === 'pending')
  check('a player cannot use the admin listing to see other teams', ((await as(stranger, () => api.adminTeams(eventId))).value ?? []).length === 0)
  check('the captain has no entry code before approval', (await as(captain, () => api.fetchEntryCode(teamId))).value === null)
  await as(admin, () => api.setTeamStatus(teamId, 'approved'))
  const code = (await as(captain, () => api.fetchEntryCode(teamId))).value
  check('approval issues a six-character code the captain can read', /^[A-HJ-KM-NP-Z2-9]{6}$/.test(code ?? ''), String(code))
  check('...that the admin sees against the team', (await as(admin, () => api.adminTeams(eventId))).value!.find((t) => t.id === teamId)?.entry_code === code)
  check('...and that a teammate cannot read', (await as(invitee, () => api.fetchEntryCode(teamId))).value === null)
  const reissued = await as(admin, () => api.regenerateEntryCode(teamId))
  check('an admin can issue a new one', /^[A-HJ-KM-NP-Z2-9]{6}$/.test(reissued.value ?? ''), reissued.error)
  check('an approved team is public, roster and all',
    (await as(stranger, () => api.fetchTeams(eventId))).value!.find((t) => t.id === teamId)?.roster.length === 2)

  console.log('\nSigning up solo')
  const solo = await as(soloist, () => api.signUpSolo(eventId, '  EU evenings  '))
  check('a player can sign up solo with a note', !solo.error, solo.error)
  const mineSolo = (await as(soloist, () => api.fetchMyFreeAgent(eventId, soloist.id))).value
  check('...and sees their own place in the pool, note tidied', mineSolo?.status === 'waiting' && mineSolo.note === 'EU evenings', JSON.stringify(mineSolo))
  check('a stranger cannot see it', (await as(stranger, () => api.fetchMyFreeAgent(eventId, soloist.id))).value === null)
  check('an admin sees the pool', (await as(admin, () => api.adminFreeAgents(eventId))).value!.some((f) => f.user_id === soloist.id))
  check('the admin event list counts the waiting player',
    (await as(admin, () => api.adminListEvents())).value!.find((e) => e.id === eventId)?.waiting_count === 1)
  check('a player can withdraw', !(await as(soloist, () => api.withdrawSolo(eventId))).error
    && (await as(soloist, () => api.fetchMyFreeAgent(eventId, soloist.id))).value?.status === 'withdrawn')

  console.log('\nAdmin overview')
  const listed = (await as(admin, () => api.adminListEvents())).value!.find((e) => e.id === eventId)
  check('the admin list carries the event with its counts', listed?.team_count === 1 && listed.pending_count === 0 && listed.status === 'signup', JSON.stringify(listed))
  check('a player gets no admin list (drafts and counts stay hidden)',
    !(await as(stranger, () => api.adminListEvents())).value?.some((e) => e.status === 'draft'))

  console.log('\nThe front page across every status')
  const mk = async (label: string, status: string, extra: Record<string, unknown> = {}) => {
    const r = await svc.from('tournaments').insert({ name: `${label} ${run}`, status, ...extra }).select('id').single()
    if (r.error) throw new Error(`${label}: ${r.error.message}`)
    trackTournament(r.data.id as string)
    return r.data.id as string
  }
  const liveId = await mk('Live event', 'live')
  const cancelledId = await mk('Cancelled event', 'cancelled')
  const draftId = await mk('Draft event', 'draft')
  const recentId = await mk('Recent champion', 'finished')
  const oldId = await mk('Old champion', 'finished')
  const winner = await svc.from('tournament_entrants').insert({ tournament_id: recentId, name: 'The Winners', captain_user_id: admin.id, status: 'approved' }).select('id').single()
  await svc.from('tournaments').update({ champion_id: winner.data!.id, finished_at: new Date(Date.now() - 3 * day).toISOString() }).eq('id', recentId)
  await svc.from('tournaments').update({ finished_at: new Date(Date.now() - 15 * day).toISOString() }).eq('id', oldId)

  const page = (await as(null, () => api.fetchFrontPageEvents(Date.now()))).value!
  const ids = new Set(page.map((e) => e.id))
  check('a live event is on the front page', ids.has(liveId))
  check('a finished event from 3 days ago is', ids.has(recentId))
  check('...carrying the champion\'s name', page.find((e) => e.id === recentId)?.championName === 'The Winners')
  check('a finished event from 15 days ago is not (the two weeks are up)', !ids.has(oldId))
  check('a cancelled event is not', !ids.has(cancelledId))
  check('a draft is not', !ids.has(draftId))
  const banners = frontPageBanners(page, new Date()).filter((b) => [liveId, recentId, eventId].includes(b.event.id))
  check('the banners for them: live, then signup, then the congratulations',
    banners.map((b) => b.kind).join() === 'live,signup,finished', banners.map((b) => b.kind).join())
  check('a champion banner for an event with no recorded champion still works (name is null)',
    frontPageBanners([{ ...page.find((e) => e.id === recentId)!, championName: null }], new Date())[0]?.event.championName === null)

  console.log('\nMatches')
  const koEvent = await mk('Bracket event', 'live')
  const pair = await svc.from('tournament_entrants').insert(['Alpha', 'Bravo'].map((name) => ({ tournament_id: koEvent, name, captain_user_id: admin.id, status: 'approved' }))).select('id, name')
  const [a, b] = pair.data!
  await svc.from('tournament_matches').insert({ tournament_id: koEvent, key: 'W1-0', stage: 'knockout', bracket: 'W', round: 1, idx: 0, phase: 1, entrant_a: a.id, entrant_b: b.id, best_of: 3, status: 'ready', due_at: new Date(Date.now() + 5 * day).toISOString() })
  const matches = (await as(stranger, () => api.fetchMatches(koEvent))).value!
  check('anyone can read a live event\'s matches', matches.length === 1 && matches[0].key === 'W1-0' && matches[0].best_of === 3 && matches[0].status === 'ready' && !!matches[0].due_at)
  check('a draft event\'s matches are hidden from a player',
    ((await as(stranger, () => api.fetchMatches(draftId))).value ?? []).length === 0)

  console.log('\nStarting an event')
  const { planStart } = await import('../src/lib/tournament/start.ts')
  const { suggestFormat } = await import('../src/lib/tournament/format.ts')
  const { suggestSchedule } = await import('../src/lib/tournament/schedule.ts')
  const startable = await mk('Startable', 'signup')
  const made = await svc.from('tournament_entrants').insert(['Ada', 'Bea', 'Cyd', 'Dov'].map((name) => ({ tournament_id: startable, name, captain_user_id: admin.id, status: 'approved' }))).select('id, name')
  const seeded = [...(made.data ?? [])].sort((x, y) => x.name.localeCompare(y.name)).map((e) => e.id as string)
  const startFormat = suggestFormat(seeded.length).format
  const startSchedule = suggestSchedule(startFormat, seeded.length, new Date().toISOString()).schedule
  const startPlan = planStart(startFormat, seeded, startSchedule)
  if (!startPlan.ok) throw new Error(startPlan.problems.join(', '))

  const refusedStart = await as(stranger, () => api.startEvent(startable, startFormat, startSchedule, seeded, startPlan.plan.matches))
  check('a player calling the page\'s own startEvent is refused, in the function\'s own words', /Only an administrator can start an event/.test(refusedStart.error ?? ''), refusedStart.error)
  const anonStart = await as(null, () => api.startEvent(startable, startFormat, startSchedule, seeded, startPlan.plan.matches))
  check('an anonymous visitor is refused too', /Only an administrator can start an event/.test(anonStart.error ?? ''), anonStart.error)
  check('...and the event is untouched', (await as(admin, () => api.fetchEvent(startable))).value?.status === 'signup' && (await as(admin, () => api.fetchMatches(startable))).value!.length === 0)
  const okStart = await as(admin, () => api.startEvent(startable, startFormat, startSchedule, seeded, startPlan.plan.matches))
  check('an admin can start it, and is told how many matches were drawn', okStart.value === startPlan.plan.matches.length, okStart.error)
  const startedEvent = (await as(null, () => api.fetchEvent(startable))).value
  const startedMatches = (await as(null, () => api.fetchMatches(startable))).value!
  check('it is now running, and its matches are public', startedEvent?.status === 'live' && startedMatches.length === startPlan.plan.matches.length)
  check('...each with its deadline', startedMatches.every((m) => !!m.due_at))
  check('...and it is on the front page as an event underway',
    frontPageBanners((await as(null, () => api.fetchFrontPageEvents(Date.now()))).value!, new Date()).some((b) => b.event.id === startable && b.kind === 'live'))

  console.log('\nAn event that has not started has no format')
  const unstarted = await mk('Unstarted', 'signup')
  const cfg = await as(admin, () => api.fetchEventConfig(unstarted))
  check('reading the config of an unstarted event gives "no format yet" (null), not an empty object - callers must handle it',
    !cfg.error && cfg.value?.format === null, JSON.stringify(cfg))
  const cfgLive = await as(admin, () => api.fetchEventConfig(startable))
  check('...while a started event returns its real format', cfgLive.value?.format?.qualifier.format === startFormat.qualifier.format && !!cfgLive.value?.schedule.roundDays)

  console.log('\nWhen something is refused')
  await as(admin, () => api.setEventStatus(eventId, 'live'))
  const late = await as(stranger, () => api.registerTeam(eventId, 'Latecomers', []))
  check('signing up after the event has started is refused, with the server\'s own words', /not open/i.test(late.error ?? ''), late.error)
  const lateSolo = await as(stranger, () => api.signUpSolo(eventId, ''))
  check('...as is signing up solo', /not open/i.test(lateSolo.error ?? ''), lateSolo.error)
  const cancel = await as(admin, () => api.cancelEvent(eventId, '  Server outage  '))
  check('an admin can cancel a running event', !cancel.error, cancel.error)
  const cancelled = (await as(stranger, () => api.fetchEvent(eventId))).value
  check('...and the event page still reads, now with its reason', cancelled?.status === 'cancelled' && cancelled.cancel_reason === 'Server outage' && !!cancelled.cancelled_at, JSON.stringify(cancelled))
  check('...but it is off the front page', !(await as(null, () => api.fetchFrontPageEvents(Date.now()))).value!.some((e) => e.id === eventId))
  check('a player cannot cancel an event', !!(await as(stranger, () => api.cancelEvent(liveId, ''))).error)
  check('an admin can delete an event', !(await as(admin, () => api.deleteEvent(draftId))).error)
} catch (e) {
  console.log(` FAIL  the script itself failed: ${(e as Error).message}`)
  const { tally } = await import('./support/local-stack.ts')
  tally.failures++
}

await finish()
