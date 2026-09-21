/**
 * Puts demo tournaments into the LOCAL database so the screens can be looked at.
 *
 * One event in each state the front page has an opinion about - including the ones that must NOT
 * appear (a draft, a cancelled event, a champion whose two weeks are up) - so a glance at the page
 * doubles as a check that the hiding rules work. The running event has a real bracket, drawn by the
 * real engine and half played, with an agreed time on the match still to come.
 *
 * LOCAL ONLY (see scripts/support/local-stack.ts). Everything it makes carries DEMO_MARK in its
 * description, which is how --clear finds it; it never touches an event it did not create.
 *
 *   node --experimental-strip-types scripts/seed-tournaments-local.ts          # add the demo events
 *   node --experimental-strip-types scripts/seed-tournaments-local.ts --clear  # remove them again
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const ours = !context.parentURL?.includes('/node_modules/')
    if (ours && specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { svc } = await import('./support/local-stack.ts')
const { buildKnockout, setScore } = await import('../src/lib/tournament/bracket.ts')
const { applySchedule } = await import('../src/lib/tournament/schedule.ts')
import type { TMatch } from '../src/lib/tournament/types.ts'

const DEMO_MARK = 'Demo data for looking at the screens - safe to delete.'
const day = 86_400_000

const cleared = await svc.from('tournaments').delete().eq('description', DEMO_MARK).select('id')
if (cleared.error) throw new Error(cleared.error.message)
console.log(`Removed ${cleared.data?.length ?? 0} demo event(s).`)

/** The stand-in captain this script makes only when the database has no user to borrow. */
const SEED_USER_EMAIL = 'demo-seed@test.local'

if (process.argv.includes('--clear')) {
  const users = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const mine = users.data.users.find((u) => u.email === SEED_USER_EMAIL)
  if (mine) {
    await svc.auth.admin.deleteUser(mine.id)
    console.log('Removed the seed script\'s stand-in user.')
  }
  process.exit(0)
}

async function event(name: string, status: string, extra: Record<string, unknown> = {}) {
  const r = await svc
    .from('tournaments')
    .insert({ name, status, description: DEMO_MARK, team_size: 2, max_roster: 3, ...extra })
    .select('id')
    .single()
  if (r.error) throw new Error(`${name}: ${r.error.message}`)
  return r.data.id as string
}

/** A captain has to be a real auth user for the roster row; borrow whoever exists, else make one. */
async function anyUser(): Promise<string> {
  const users = await svc.auth.admin.listUsers({ page: 1, perPage: 1 })
  const existing = users.data.users[0]
  if (existing) return existing.id
  const made = await svc.auth.admin.createUser({ email: SEED_USER_EMAIL, password: 'demo-seed-pw', email_confirm: true })
  if (made.error || !made.data.user) throw new Error(made.error?.message ?? 'no user')
  return made.data.user.id
}

const captain = await anyUser()

/** Approved teams with two named players each; returns their ids by team name. */
async function teams(eventId: string, roster: Array<[string, string, string]>) {
  const ids = new Map<string, string>()
  for (const [name, a, b] of roster) {
    const t = await svc
      .from('tournament_entrants')
      .insert({ tournament_id: eventId, name, captain_user_id: captain, status: 'approved' })
      .select('id')
      .single()
    if (t.error) throw new Error(`${name}: ${t.error.message}`)
    ids.set(name, t.data.id as string)
    // The trigger put the captain on the roster; name them, and add a second player.
    await svc.from('tournament_roster').update({ display_name: a }).eq('entrant_id', t.data.id)
    await svc.from('tournament_roster').insert({ entrant_id: t.data.id, user_id: crypto.randomUUID(), display_name: b })
  }
  return ids
}

// -- signup ------------------------------------------------------------------------------------------
const autumn = await event('Autumn Cup', 'signup', { signup_closes_at: new Date(Date.now() + 5 * day).toISOString(), max_entrants: 16 })
await teams(autumn, [
  ['The Salty Krakens', 'Ahab', 'Ishmael'],
  ['Blackwater Foxes', 'Reynard', 'Vixen'],
  ['Lantern Herons', 'Mira', 'Sol'],
])
await event('Winter Classic', 'signup', { signup_closes_at: new Date(Date.now() - 1 * day).toISOString() })

// -- a running event with a half-played bracket ------------------------------------------------------
const ember = await event('Ember League', 'live', {
  description: DEMO_MARK,
  max_entrants: 8,
  format: { qualifier: { format: 'none' }, knockout: { format: 'single', bestOf: 3, thirdPlace: false, grandFinalReset: false } },
})
const emberTeams = await teams(ember, [
  ['Wolves', 'Fenrir', 'Skoll'],
  ['Krakens', 'Ahab', 'Ishmael'],
  ['Foxes', 'Reynard', 'Vixen'],
  ['Herons', 'Mira', 'Sol'],
])
let bracket: TMatch[] = buildKnockout(['Wolves', 'Krakens', 'Foxes', 'Herons'], {
  format: 'single', bestOf: 3, semifinalBestOf: 3, finalBestOf: 5, thirdPlace: false, grandFinalReset: false,
})
bracket = applySchedule(bracket, { startsAt: new Date(Date.now() - 6 * day).toISOString(), roundDays: 7, stageGapDays: 0, overrides: {} }, { qualifierStage: null, qualifierRounds: 0 })
const played = setScore(bracket, 'W1-0', 2, 1)
if (!played.ok) throw new Error(played.error)
bracket = played.value

const rows = bracket.map((m) => ({
  tournament_id: ember, key: m.key, stage: m.stage, bracket: m.bracket, round: m.round, idx: m.index, phase: m.phase,
  opens_at: m.opensAt, due_at: m.dueAt, best_of: m.bestOf, score_a: m.scoreA, score_b: m.scoreB, status: m.status,
  entrant_a: m.a ? emberTeams.get(m.a) : null, entrant_b: m.b ? emberTeams.get(m.b) : null,
  winner: m.winner ? emberTeams.get(m.winner) : null, result_kind: m.resultKind,
  winner_to_key: m.winnerTo?.key ?? null, winner_to_side: m.winnerTo?.side ?? null,
  loser_to_key: m.loserTo?.key ?? null, loser_to_side: m.loserTo?.side ?? null,
  agreed_at: m.key === 'W1-1' ? new Date(Date.now() + 2 * day).toISOString() : null,
}))
const inserted = await svc.from('tournament_matches').insert(rows)
if (inserted.error) throw new Error(`bracket: ${inserted.error.message}`)

// -- finished, hidden, and gone ------------------------------------------------------------------------
const recent = await event('Harbor Open', 'finished')
const winners = await svc
  .from('tournament_entrants')
  .insert({ tournament_id: recent, name: 'The Wolves', captain_user_id: captain, status: 'approved' })
  .select('id')
  .single()
await svc.from('tournaments').update({ champion_id: winners.data!.id, finished_at: new Date(Date.now() - 3 * day).toISOString() }).eq('id', recent)

const old = await event('Spring Open', 'finished')
await svc.from('tournaments').update({ finished_at: new Date(Date.now() - 20 * day).toISOString() }).eq('id', old)
await event('Cancelled Cup', 'cancelled')
await event('Draft Cup', 'draft')

console.log('Seeded: Autumn Cup (signup, 3 teams), Winter Classic (signup closed), Ember League (live, half-played bracket),')
console.log('        Harbor Open (finished 3 days ago, champion The Wolves).')
console.log('Hidden on purpose: Spring Open (finished 20 days ago), Cancelled Cup, Draft Cup.')
