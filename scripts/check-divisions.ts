/**
 * Checks split_division against the LOCAL database: splitting some of an event's teams off into a linked
 * event of their own (supabase/migrations/20261019000000_event_divisions.sql).
 *
 *   npm run local:up
 *   node --experimental-strip-types scripts/check-divisions.ts
 *
 * LOCAL ONLY (see scripts/support/local-stack.ts). It creates users and events and removes them again.
 */
import { check, finish, person, svc, trackTournament, run } from './support/local-stack.ts'

try {
  const admin = await person('dv_admin', { admin: true })
  const captains = await Promise.all(Array.from({ length: 6 }, (_, i) => person(`dv_cap${i + 1}`)))
  const solo = await person('dv_solo')

  const r = await svc.from('tournaments').insert({ name: `Division Cup ${run}`, status: 'signup', team_size: 2, max_roster: 2, extra_rules: 'Be kind.' }).select('id').single()
  if (r.error) throw new Error(r.error.message)
  const eventId = r.data.id as string
  trackTournament(eventId)

  // Six teams, approved the way an admin approves them (which is what issues an entry code).
  const teamIds: string[] = []
  for (const [i, cap] of captains.entries()) {
    const e = await svc.from('tournament_entrants').insert({ tournament_id: eventId, name: `Crew ${i + 1}`, captain_user_id: cap.id }).select('id').single()
    if (e.error) throw new Error(e.error.message)
    const a = await svc.from('tournament_entrants').update({ status: 'approved' }).eq('id', e.data.id)
    if (a.error) throw new Error(a.error.message)
    teamIds.push(e.data.id as string)
  }
  // A solo player from the pool, placed on Crew 5.
  const fa = await svc.from('tournament_free_agents').insert({ tournament_id: eventId, user_id: solo.id, display_name: 'dv_solo' })
  if (fa.error) throw new Error(fa.error.message)
  const placed = await svc.from('tournament_roster').insert({ entrant_id: teamIds[4], user_id: solo.id, display_name: 'dv_solo' })
  if (placed.error) throw new Error(placed.error.message)
  // A saved plan, seeded in reverse.
  const plan = await svc.from('tournament_plans').insert({ tournament_id: eventId, format: { qualifier: { format: 'none' } }, schedule: { startsAt: '2026-11-01T00:00:00.000Z' }, seed_order: [...teamIds].reverse(), fit_days: 30 })
  if (plan.error) throw new Error(plan.error.message)

  const lower = teamIds.slice(3) // Crews 4, 5, 6
  const args = { p_event: eventId, p_entrants: lower, p_name: `Division Cup ${run} - Lower`, p_this_label: 'Upper Division', p_new_label: 'Lower Division' }

  console.log('\nWho may split')
  const byPlayer = await captains[0].client.rpc('split_division', args)
  check('a player cannot split an event', !!byPlayer.error, byPlayer.error?.message)

  console.log('\nRefusals')
  const none = await admin.client.rpc('split_division', { ...args, p_entrants: [] })
  check('splitting off no teams is refused', !!none.error)
  const all = await admin.client.rpc('split_division', { ...args, p_entrants: teamIds })
  check('splitting off every team is refused', !!all.error && all.error.message.includes('at least one'), all.error?.message)
  const stranger = await admin.client.rpc('split_division', { ...args, p_entrants: [...lower, '00000000-0000-0000-0000-000000000000'] })
  check('a team from somewhere else is refused', !!stranger.error)
  const nameless = await admin.client.rpc('split_division', { ...args, p_name: ' ' })
  check('a nameless division is refused', !!nameless.error)
  const { count: stillThere } = await svc.from('tournament_entrants').select('id', { count: 'exact', head: true }).eq('tournament_id', eventId)
  check('...and a refused split moves nothing', stillThere === 6, `${stillThere}`)

  console.log('\nThe split')
  const done = await admin.client.rpc('split_division', args)
  check('an administrator can split off a division', !done.error && typeof done.data === 'string', done.error?.message)
  const newId = done.data as string
  if (newId) trackTournament(newId)

  const { data: events } = await svc.from('tournaments').select('id, name, status, team_size, max_roster, extra_rules, division_of, division_name').in('id', [eventId, newId])
  const parent = events?.find((e) => e.id === eventId)
  const child = events?.find((e) => e.id === newId)
  check('the new division is linked to the event it came from', child?.division_of === eventId)
  check('...is the same kind of event, open in the same state', child?.status === 'signup' && child?.team_size === 2 && child?.max_roster === 2 && child?.extra_rules === 'Be kind.')
  check('...and both divisions carry their labels', parent?.division_name === 'Upper Division' && child?.division_name === 'Lower Division', JSON.stringify([parent?.division_name, child?.division_name]))

  const { data: moved } = await svc.from('tournament_entrants').select('id, tournament_id, status').in('id', teamIds)
  check('the picked teams are in the new division', lower.every((id) => moved?.find((m) => m.id === id)?.tournament_id === newId))
  check('...the rest stay, still approved', teamIds.slice(0, 3).every((id) => { const m = moved?.find((x) => x.id === id); return m?.tournament_id === eventId && m?.status === 'approved' }))
  const { data: roster } = await svc.from('tournament_roster').select('entrant_id, user_id').eq('entrant_id', teamIds[4])
  check('a moved team keeps its roster, solo player included', roster?.length === 2 && roster.some((x) => x.user_id === solo.id))
  const { data: secrets } = await svc.from('tournament_entrant_secrets').select('entrant_id, tournament_id, entry_code').in('entrant_id', teamIds)
  check('entry codes go with their teams', lower.every((id) => { const s = secrets?.find((x) => x.entrant_id === id); return s?.tournament_id === newId && !!s.entry_code }))
  const { data: pool } = await svc.from('tournament_free_agents').select('tournament_id, status, placed_entrant_id').eq('user_id', solo.id)
  check('a solo player placed on a moved team moves with it', pool?.[0]?.tournament_id === newId && pool[0].status === 'placed' && pool[0].placed_entrant_id === teamIds[4])

  const { data: plans } = await svc.from('tournament_plans').select('tournament_id, seed_order, fit_days').in('tournament_id', [eventId, newId])
  const parentPlan = plans?.find((p) => p.tournament_id === eventId)
  const childPlan = plans?.find((p) => p.tournament_id === newId)
  check('the new division starts from a copy of the plan, with only its own teams, in the same order',
    JSON.stringify(childPlan?.seed_order) === JSON.stringify([...lower].reverse()) && childPlan?.fit_days === 30, JSON.stringify(childPlan?.seed_order))
  check('...and this event\'s plan keeps the rest', JSON.stringify(parentPlan?.seed_order) === JSON.stringify(teamIds.slice(0, 3).reverse()))

  console.log('\nVisitors')
  const { data: seen } = await captains[0].client.from('tournaments').select('id, division_name').or(`id.eq.${eventId},division_of.eq.${eventId}`)
  check('a player can see both divisions to switch between them', seen?.length === 2)

  console.log('\nA second split')
  const again = await admin.client.rpc('split_division', { ...args, p_event: newId, p_entrants: [lower[2]], p_name: `Division Cup ${run} - Third`, p_this_label: '', p_new_label: 'Third Division' })
  check('a division can be split again', !again.error, again.error?.message)
  if (again.data) trackTournament(again.data as string)
  const { data: third } = await svc.from('tournaments').select('division_of').eq('id', again.data as string).single()
  check('...and the newest still links to the first event, so every division sees the others', third?.division_of === eventId)
  const { data: lowerNow } = await svc.from('tournaments').select('division_name').eq('id', newId).single()
  check('...an empty label leaves the split event\'s own label alone', lowerNow?.division_name === 'Lower Division')

  console.log('\nOnce started')
  await svc.from('tournaments').update({ status: 'live' }).eq('id', eventId)
  const late = await admin.client.rpc('split_division', { ...args, p_entrants: [teamIds[0]] })
  check('a running event cannot be split', !!late.error && late.error.message.includes('before the event starts'), late.error?.message)
} finally {
  await finish()
}
