/**
 * Runs an event through the administrators' desk in a real browser, and checks the database after each
 * click: draw the next Swiss round, build the knockout, forfeit an overdue match, enter a score, and
 * pair solo players into teams.
 *
 * Needs the app running against the local stack (see screenshot-tournament-ui.ts for how), and:
 *
 *   node --experimental-strip-types scripts/screenshot-tournament-desk.ts <output folder>
 *
 * LOCAL ONLY (see scripts/support/local-stack.ts).
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const ours = !context.parentURL?.includes('/node_modules/')
    if (ours && specifier.startsWith('.') && !/\.\w+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

const { anonClient, check, finish, person, svc, trackTournament, run, tally } = await import('./support/local-stack.ts')
const { clickIn, clickText, setValue, shot } = await import('./support/shot.ts')
const { planStart, toMatchRows } = await import('../src/lib/tournament/start.ts')
const { suggestSchedule } = await import('../src/lib/tournament/schedule.ts')
import type { Person } from './support/local-stack.ts'
import type { TournamentFormat } from '../src/lib/tournament/format.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: node --experimental-strip-types scripts/screenshot-tournament-desk.ts <output folder>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const BASE = process.env.APP_BASE ?? 'http://localhost:5199/Elden-Battleship/'

async function sessionFor(who: Person) {
  const { data, error } = await anonClient().auth.signInWithPassword({ email: who.email, password: who.password })
  if (error || !data.session) throw new Error(`session for ${who.name}: ${error?.message}`)
  return data.session
}
const look = async (name: string, who: Person | null, route: string, steps: string[] = []) => {
  await shot({ base: BASE, route, out: join(outDir, `${name}.png`), session: who ? await sessionFor(who) : undefined, steps })
  console.log(`  shot  ${name}`)
}

try {
  const admin = await person('dk_admin', { admin: true })

  /** A live event, started through the real function, with `n` approved teams. */
  const startEvent = async (label: string, format: TournamentFormat, names: string[]) => {
    const t = await svc.from('tournaments').insert({ name: `${label} ${run}`, status: 'signup', team_size: 1, max_roster: 1 }).select('id').single()
    trackTournament(t.data!.id as string)
    const made = await svc.from('tournament_entrants').insert(names.map((name) => ({ tournament_id: t.data!.id, name, captain_user_id: admin.id, status: 'approved' }))).select('id, name')
    const order = names.map((n) => made.data!.find((e) => e.name === n)!.id as string)
    const schedule = suggestSchedule(format, names.length, new Date(Date.now() - 2 * 86_400_000).toISOString()).schedule
    const plan = planStart(format, order, schedule)
    if (!plan.ok) throw new Error(plan.problems.join(', '))
    const r = await admin.client.rpc('start_tournament', { p_tournament: t.data!.id, p_format: format, p_schedule: schedule, p_seeds: order, p_matches: toMatchRows(plan.plan.matches) })
    if (r.error) throw new Error(r.error.message)
    return { id: t.data!.id as string, order }
  }
  const playOpen = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      const open = ((await svc.from('tournament_matches').select('id, best_of').eq('tournament_id', id).in('status', ['ready', 'in_progress']).limit(1)).data ?? [])[0]
      if (!open) return
      const need = Math.floor(open.best_of / 2 + 1)
      await admin.client.rpc('set_tournament_match_score', { p_match: open.id, p_score_a: need, p_score_b: 0 })
    }
  }
  const countStage = async (id: string, stage: string) =>
    (await svc.from('tournament_matches').select('id', { count: 'exact', head: true }).eq('tournament_id', id).eq('stage', stage)).count ?? 0

  // -- Swiss, then a knockout ----------------------------------------------------------------------
  const format: TournamentFormat = {
    qualifier: { format: 'swiss', rounds: 2, bestOf: 1 },
    knockout: { format: 'single', bestOf: 1, cutTo: 4, thirdPlace: false, grandFinalReset: false },
  }
  const swiss = await startEvent('Desk Swiss', format, ['Anchors', 'Buoys', 'Cutters', 'Drifters', 'Ebbtide', 'Flotsam'])
  await playOpen(swiss.id)
  console.log('Taking screenshots...')
  await look('20_desk_round_two_ready', admin, `#/admin/event/${swiss.id}`)

  await look('21_desk_draw_round_two', admin, `#/admin/event/${swiss.id}`, [clickText('Draw round 2')])
  check('clicking "Draw round 2" in the browser drew round 2 (3 matches)', (await countStage(swiss.id, 'swiss')) === 6, String(await countStage(swiss.id, 'swiss')))

  await playOpen(swiss.id)
  await look('22_desk_build_knockout', admin, `#/admin/event/${swiss.id}`)
  await look('23_desk_knockout_built', admin, `#/admin/event/${swiss.id}`, [clickText('Build the knockout')])
  check('clicking "Build the knockout" built a four-team knockout (3 matches)', (await countStage(swiss.id, 'knockout')) === 3, String(await countStage(swiss.id, 'knockout')))
  await look('24_public_standings_and_bracket', null, `#/event/${swiss.id}`)

  // -- an overdue match, forfeited from the list ---------------------------------------------------
  const late = await startEvent('Desk Overdue', { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 3, cutTo: 4, thirdPlace: false, grandFinalReset: false } }, ['Red', 'Blue', 'Green', 'Gold'])
  await svc.from('tournament_matches').update({ due_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }).eq('tournament_id', late.id).eq('stage', 'knockout')
  await look('25_desk_overdue', admin, `#/admin/event/${late.id}`)
  await look('26_desk_overdue_forfeit', admin, `#/admin/event/${late.id}`, [clickText(' forfeits')])
  const forfeited = (await svc.from('tournament_matches').select('result_kind, score_a, score_b, status').eq('tournament_id', late.id).eq('result_kind', 'forfeit')).data ?? []
  check('forfeiting from the overdue list recorded a forfeit (2-0 in a best of three)', forfeited.length >= 1 && forfeited[0].status === 'done' && Math.max(forfeited[0].score_a, forfeited[0].score_b) === 2, JSON.stringify(forfeited))

  // -- entering a score by hand -------------------------------------------------------------------
  const score = await startEvent('Desk Score', { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 3, cutTo: 4, thirdPlace: false, grandFinalReset: false } }, ['North', 'South', 'East', 'West'])
  await look('27_desk_enter_score', admin, `#/admin/event/${score.id}`, [setValue('North games', '2'), setValue('West games', '1'), clickIn('North', 'Save')])
  const entered = (await svc.from('tournament_matches').select('score_a, score_b, status, result_kind').eq('tournament_id', score.id).eq('status', 'done')).data ?? []
  check('typing 2-1 and pressing Save recorded an administrator\'s result', entered.length === 1 && entered[0].result_kind === 'admin' && entered[0].score_a + entered[0].score_b === 3, JSON.stringify(entered))

  // -- removing a team, and a substitute ------------------------------------------------------------
  const removal = await startEvent('Desk Remove', { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 1, cutTo: 4, thirdPlace: false, grandFinalReset: false } }, ['Ash', 'Birch', 'Cedar', 'Dogwood'])
  // The remove button asks "are you sure?"; the first step accepts it, as a click on OK would.
  await look('28_desk_remove_team', admin, `#/admin/event/${removal.id}`, ['window.confirm = () => true', clickIn('Cedar', 'Remove from the event')])
  const gone = (await svc.from('tournament_entrants').select('forfeited_at').eq('tournament_id', removal.id).eq('name', 'Cedar').single()).data
  check('removing a team in the browser marked it removed and forfeited its match', !!gone?.forfeited_at &&
    ((await svc.from('tournament_matches').select('id', { count: 'exact', head: true }).eq('tournament_id', removal.id).eq('result_kind', 'forfeit')).count ?? 0) >= 1)

  // -- pairing solo players ---------------------------------------------------------------------
  const pairing = await svc.from('tournaments').insert({ name: `Desk Pairing ${run}`, status: 'signup', team_size: 2, max_roster: 3 }).select('id').single()
  trackTournament(pairing.data!.id as string)
  const solos: Person[] = []
  for (const label of ['dk_p1', 'dk_p2', 'dk_p3', 'dk_p4', 'dk_p5']) {
    const p = await person(label)
    await p.client.rpc('sign_up_solo', { p_tournament: pairing.data!.id, p_note: label === 'dk_p1' ? 'Evenings, EU' : null })
    solos.push(p)
  }
  await look('29_desk_pairing', admin, `#/admin/event/${pairing.data!.id}`)
  await look('30_desk_pairing_created', admin, `#/admin/event/${pairing.data!.id}`, [clickText('Create all of these teams')])
  const made = (await svc.from('tournament_entrants').select('status').eq('tournament_id', pairing.data!.id)).data ?? []
  check('"Create all of these teams" created two approved teams from five solo players', made.length === 2 && made.every((e) => e.status === 'approved'), JSON.stringify(made))
  const stillWaiting = (await svc.from('tournament_free_agents').select('id', { count: 'exact', head: true }).eq('tournament_id', pairing.data!.id).eq('status', 'waiting')).count ?? 0
  check('...leaving one player waiting (five do not divide into pairs)', stillWaiting === 1, String(stillWaiting))

  // -- who is turned away ----------------------------------------------------------------------------
  const player = await person('dk_player')
  await look('31_desk_as_player', player, `#/admin/event/${swiss.id}`)
  await look('32_desk_as_anonymous', null, `#/admin/event/${swiss.id}`)
} catch (e) {
  console.log(` FAIL  ${(e as Error).message}`)
  tally.failures++
}

await finish()
