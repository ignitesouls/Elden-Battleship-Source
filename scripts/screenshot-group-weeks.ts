/**
 * Photographs the start page's schedule for a group stage laid out by week: sixteen teams in three
 * groups (5, 5 and 6) over four weeks, with the playoffs on their own date. LOCAL ONLY - it builds the
 * people and the event in the local database and removes them again.
 *
 *   npm run local:up
 *   npm run dev:local -- --port 5199
 *   node --experimental-strip-types scripts/screenshot-group-weeks.ts <output folder>
 */
import { registerHooks } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    // The app's own extensionless imports only - not node_modules, which resolve as usual.
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier) && context.parentURL?.includes('/src/')) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

const { anonClient, finish, person, svc, trackTournament, run } = await import('./support/local-stack.ts')
const { shot } = await import('./support/shot.ts')
const { defaultKnockout } = await import('../src/lib/tournament/formatDefaults.ts')
const { spreadGroupWeeks } = await import('../src/lib/tournament/schedule.ts')

const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: node --experimental-strip-types scripts/screenshot-group-weeks.ts <output folder>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const BASE = process.env.APP_BASE ?? 'http://localhost:5199/Elden-Battleship/'

try {
  const admin = await person('gw_admin', { admin: true })
  const r = await svc.from('tournaments').insert({ name: `Weeks Cup ${run}`, status: 'signup', team_size: 1 }).select('id').single()
  if (r.error) throw new Error(r.error.message)
  const id = r.data.id as string
  trackTournament(id)

  const order: string[] = []
  for (let i = 1; i <= 16; i++) {
    const p = await person(`gw_p${i}`)
    const e = await svc.from('tournament_entrants').insert({ tournament_id: id, name: `Crew ${i}`, captain_user_id: p.id, status: 'approved' }).select('id').single()
    if (e.error) throw new Error(e.error.message)
    order.push(e.data.id as string)
  }

  const start = '2026-11-02T18:00:00.000Z'
  const format = {
    qualifier: { format: 'groups', groupCount: 3, advancePerGroup: 2, legs: 1, bestOf: 3 },
    knockout: { ...defaultKnockout(6), cutTo: 6 },
  }
  const schedule = {
    startsAt: start,
    roundDays: 7,
    stageGapDays: 2,
    overrides: {},
    groupWeeks: spreadGroupWeeks(start, 4),
    weekMoves: {},
    knockoutStartsAt: '2026-12-05T18:00:00.000Z',
    knockoutRoundDays: 4,
  }
  const plan = await svc.from('tournament_plans').upsert({ tournament_id: id, format, schedule, seed_order: order, fit_days: 35 })
  if (plan.error) throw new Error(plan.error.message)

  const { data, error } = await anonClient().auth.signInWithPassword({ email: admin.email, password: admin.password })
  if (error || !data.session) throw new Error(`session: ${error?.message}`)
  await shot({ base: BASE, route: `#/admin/event/${id}/plan`, out: join(outDir, 'group-weeks.png'), session: data.session, width: 1000, settleMs: 6000 })
  console.log(`  shot  ${join(outDir, 'group-weeks.png')}`)

  // Fixed + flex: clean weeks with the rest as flex matches, then two pins that clash (Crew 1 twice in
  // week 3 - Crews 1, 6 and 7 are dealt into group A).
  const { pairingKey } = await import('../src/lib/tournament/schedule.ts')
  const flexPlan = (weekMoves: Record<string, number | 'flex'>) =>
    svc.from('tournament_plans').update({ schedule: { ...schedule, groupWeekMode: 'flex', weekMoves } }).eq('tournament_id', id)
  await flexPlan({})
  await shot({ base: BASE, route: `#/admin/event/${id}/plan`, out: join(outDir, 'group-flex.png'), session: data.session, width: 1000, settleMs: 6000 })
  await flexPlan({ [pairingKey(0, order[0], order[5], 1)]: 2, [pairingKey(0, order[0], order[6], 1)]: 2 })
  await shot({ base: BASE, route: `#/admin/event/${id}/plan`, out: join(outDir, 'group-flex-clash.png'), session: data.session, width: 1000, settleMs: 6000 })
  console.log('  shot  group-flex.png, group-flex-clash.png')
  await flexPlan({})

  // Divisions: the split panel open, then the last six teams split off the way the panel does it.
  const openPanel = `(() => { const d = [...document.querySelectorAll('details')].find((x) => x.textContent.includes('Divisions')); if (!d) throw new Error('nothing to click: divisions'); d.open = true; return true })()`
  await shot({ base: BASE, route: `#/admin/event/${id}/plan`, out: join(outDir, 'split-panel.png'), session: data.session, width: 1000, settleMs: 5000, steps: [openPanel] })
  console.log(`  shot  ${join(outDir, 'split-panel.png')}`)
  const split = await admin.client.rpc('split_division', { p_event: id, p_entrants: order.slice(10), p_name: `Weeks Cup ${run} - Lower Division`, p_this_label: 'Upper Division', p_new_label: 'Lower Division' })
  if (split.error) throw new Error(split.error.message)
  trackTournament(split.data as string)
  await shot({ base: BASE, route: `#/event/${id}`, out: join(outDir, 'divisions-event.png'), session: data.session, width: 900, settleMs: 5000 })
  await shot({ base: BASE, route: `#/admin/event/${split.data}/plan`, out: join(outDir, 'divisions-lower-plan.png'), session: data.session, width: 1000, settleMs: 6000 })
  console.log(`  shot  divisions-event.png, divisions-lower-plan.png`)
} finally {
  await finish()
}
