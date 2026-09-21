/**
 * Photographs the official-match lobby as the people who see it, and clicks through the real controls:
 * the host making a room official, and the other team's captain confirming it - each checked against the
 * database afterwards.
 *
 * Needs the app running against the local stack (see screenshot-tournament-ui.ts), then:
 *
 *   node --experimental-strip-types scripts/screenshot-official-lobby.ts <output folder>
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
const { clickText, shot } = await import('./support/shot.ts')
const { planStart, toMatchRows } = await import('../src/lib/tournament/start.ts')
const { suggestSchedule } = await import('../src/lib/tournament/schedule.ts')
import type { Person } from './support/local-stack.ts'
import type { TournamentFormat } from '../src/lib/tournament/format.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: node --experimental-strip-types scripts/screenshot-official-lobby.ts <output folder>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const BASE = process.env.APP_BASE ?? 'http://localhost:5199/Elden-Battleship/'

async function sessionFor(who: Person) {
  const { data, error } = await anonClient().auth.signInWithPassword({ email: who.email, password: who.password })
  if (error || !data.session) throw new Error(`session for ${who.name}: ${error?.message}`)
  return data.session
}

const rooms: string[] = []
try {
  const admin = await person('ol_admin', { admin: true })
  const host = await person('ol_host')
  const capB = await person('ol_capb')
  const stranger = await person('ol_stranger')

  const t = await svc.from('tournaments').insert({ name: `Lobby Cup ${run}`, status: 'signup', team_size: 1, max_roster: 1, match_settings: { prep_seconds: 120, starting_seconds: 5 } }).select('id').single()
  trackTournament(t.data!.id as string)
  const made = await svc.from('tournament_entrants').insert([
    { tournament_id: t.data!.id, name: 'Alpha', captain_user_id: host.id, status: 'pending' },
    { tournament_id: t.data!.id, name: 'Bravo', captain_user_id: capB.id, status: 'pending' },
  ]).select('id, name')
  const [a, b] = ['Alpha', 'Bravo'].map((n) => made.data!.find((e) => e.name === n)!.id as string)
  await svc.from('tournament_entrants').update({ status: 'approved' }).in('id', [a, b])
  const code = async (id: string) => (await svc.from('tournament_entrant_secrets').select('entry_code').eq('entrant_id', id).single()).data!.entry_code as string
  const [codeA, codeB] = [await code(a), await code(b)]
  const format: TournamentFormat = { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 3, thirdPlace: false, grandFinalReset: false } }
  const schedule = suggestSchedule(format, 2, new Date().toISOString()).schedule
  const plan = planStart(format, [a, b], schedule)
  if (!plan.ok) throw new Error(plan.problems.join(', '))
  const started = await admin.client.rpc('start_tournament', { p_tournament: t.data!.id, p_format: format, p_schedule: schedule, p_seeds: [a, b], p_matches: toMatchRows(plan.plan.matches) })
  if (started.error) throw new Error(started.error.message)

  const roomCode = `OLOBBY${run}`
  const room = await host.client.from('rooms').insert({ code: roomCode }).select('id').single()
  rooms.push(room.data!.id as string)
  const hostRow = await host.client.from('players').insert({ room_id: room.data!.id, user_id: host.id, nickname: 'Alpha captain', is_host: true }).select('id').single()
  const bRow = await capB.client.from('players').insert({ room_id: room.data!.id, user_id: capB.id, nickname: 'Bravo captain' }).select('id').single()
  const store = (playerId: string) => ({ [`eb_player_${roomCode}`]: playerId })
  const look = async (name: string, who: Person | null, playerId: string | null, steps: string[] = []) => {
    await shot({ base: BASE, route: `#/room/${roomCode}`, out: join(outDir, `${name}.png`), session: who ? await sessionFor(who) : undefined, storage: playerId ? store(playerId) : undefined, steps })
    console.log(`  shot  ${name}`)
  }
  const roomRow = async () => (await svc.from('rooms').select('tournament_match_id, official_a_confirmed, official_b_confirmed, prep_seconds').eq('id', room.data!.id).single()).data!

  console.log('Taking screenshots...')
  await look('40_lobby_host_ordinary_room', host, hostRow.data!.id)
  await look('41_lobby_stranger_sees_nothing', stranger, null)

  // The host makes it official in the browser: type the code, press the button.
  await look('42_lobby_host_links', host, hostRow.data!.id, [
    `(() => { const el = [...document.querySelectorAll('input')].find((i) => (i.getAttribute('aria-label') || '').includes('entry code')); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(codeA)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
    clickText('Make this an official match'),
  ])
  const linked = await roomRow()
  check('typing the host\'s code and pressing the button made the room official', !!linked.tournament_match_id && linked.official_a_confirmed === true && linked.official_b_confirmed === false, JSON.stringify(linked))
  check('...and the room took the tournament\'s 120-second preparation time', linked.prep_seconds === 120)

  // The other team's captain confirms from inside the room, in the browser.
  await look('43_lobby_other_team_confirms', capB, bRow.data!.id, [
    `(() => { const el = [...document.querySelectorAll('input')].find((i) => (i.getAttribute('aria-label') || '').includes('other team')); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(codeB)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
    clickText('Confirm'),
  ])
  const confirmed = await roomRow()
  check('the other captain entering THEIR code confirmed the second team', confirmed.official_b_confirmed === true, JSON.stringify(confirmed))
  await look('44_lobby_both_confirmed', host, hostRow.data!.id)

  // The Official record appears on the leaderboard once the first event has gone live.
  await svc.from('match_reports').insert({ match_key: `OLK${run}:1`, room_code: `OLX${run}`, winner_team: 0, duration: '10:00', total_shots: 1, summary: {}, report_text: 'x' })
  await svc.from('match_participants').insert({ match_key: `OLK${run}:1`, user_id: host.id, nickname: 'ol_host', team: 0, won: true })
  // A participant cannot CLAIM to be official - a trigger sets the flag from the archived report, and this
  // demo report is an ordinary one. So flag it afterwards, as an administrator repairing a record would.
  await svc.from('match_participants').update({ official: true }).eq('match_key', `OLK${run}:1`)
  await shot({ base: BASE, route: '#/leaderboard', out: join(outDir, '45_leaderboard_official_record.png') })
  console.log('  shot  45_leaderboard_official_record')
  await svc.from('match_participants').delete().eq('match_key', `OLK${run}:1`)
  await svc.from('match_reports').delete().eq('match_key', `OLK${run}:1`)
} catch (e) {
  console.log(` FAIL  ${(e as Error).message}`)
  tally.failures++
} finally {
  for (const id of rooms) await svc.from('rooms').delete().eq('id', id)
}

await finish()
