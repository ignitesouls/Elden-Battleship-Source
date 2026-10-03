/**
 * Checks the battle rating (src/lib/battleRating.ts) - the Hall of Fame's 0-100 per game.
 *
 * The case the whole design exists for comes first: a DLC specialist who takes five long, rarely-taken
 * squares has to out-rate an early-game captain who takes twelve quick ones, even with fewer hits.
 * Rate raw volume and the specialist loses every time, which is exactly what the rating must not do.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-battle-rating.ts
 */
import { registerHooks } from 'node:module'
import type { ParticipantRow } from '../src/lib/careerStats.ts'
import type { MatchEventRow, BossFrequency } from '../src/lib/almanac.ts'

// App modules import each other without file extensions, which Vite resolves and Node does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { squareWeights, rateBattles, WEIGHT_MIN, WEIGHT_MAX, MIN_MATCH_SECONDS } = await import(
  '../src/lib/battleRating.ts'
)

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

function part(over: Partial<ParticipantRow> & { nickname: string; match_key: string }): ParticipantRow {
  return {
    match_key: over.match_key,
    user_id: over.user_id ?? null,
    nickname: over.nickname,
    team: over.team ?? 0,
    won: over.won ?? false,
    draw: over.draw ?? false,
    shots: over.shots ?? 0,
    hits: over.hits ?? 0,
    misses: over.misses ?? 0,
    sunk: over.sunk ?? 0,
    team_ships_lost: over.team_ships_lost ?? 0,
    awards: over.awards ?? [],
    room_code: over.room_code ?? 'TEST',
    finished_at: over.finished_at ?? '2026-09-01T12:00:00.000Z',
    square_set: over.square_set ?? null,
  }
}

/** One shot by `nickname` at `seconds`, auto-fired. */
function ev(
  matchKey: string,
  nickname: string,
  cell: number,
  seconds: number,
  challenge: string,
  result = 'miss',
  team = 0
): MatchEventRow {
  return {
    match_key: matchKey,
    user_id: null,
    nickname,
    team,
    cell_index: cell,
    challenge_name: challenge,
    result,
    match_seconds: seconds,
    board_size: 10,
    finished_at: '2026-09-01T12:00:00.000Z',
    square_set: null,
    auto: true,
  }
}

/** A captain's run of squares, one every `gap` seconds from `start`. */
function run(matchKey: string, nickname: string, names: string[], gap: number, firstCell: number, start = 0) {
  return names.map((name, i) => ev(matchKey, nickname, firstCell + i, start + gap * (i + 1), name))
}

/* --- square weights ---------------------------------------------------------------------------- */

{
  // Ten matches of history: Quick is fought in 60s and taken whenever it is dealt; Slog takes 600s
  // and is only taken one time in five.
  const events: MatchEventRow[] = []
  for (let m = 0; m < 10; m++) {
    events.push(...run(`h${m}`, `p${m}`, ['Opener', 'Quick', 'Quick2', 'Quick3'], 60, 0))
    if (m % 5 === 0) events.push(ev(`h${m}`, `p${m}`, 9, 240 + 600, 'Slog'))
  }
  const freq: BossFrequency[] = [
    { name: 'Quick', appeared: 10, fired: 10, opened: 0, missRate: 1 },
    { name: 'Quick2', appeared: 10, fired: 10, opened: 0, missRate: 1 },
    { name: 'Quick3', appeared: 10, fired: 10, opened: 0, missRate: 1 },
    { name: 'Slog', appeared: 10, fired: 2, opened: 0, missRate: 1 },
  ]
  const w = squareWeights(events, freq)
  const slog = w.get('Slog') ?? 1
  const quick = w.get('Quick') ?? 1
  check('a long, rarely-taken square weighs more than a typical one', slog > 1.5, `Slog ${slog.toFixed(2)}`)
  check('a quick, always-taken square weighs at most a typical one', quick <= 1, `Quick ${quick.toFixed(2)}`)
  check(
    'every weight stays inside the band',
    [...w.values()].every((x) => x >= WEIGHT_MIN && x <= WEIGHT_MAX),
    [...w.entries()].map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')
  )

  // One fight, ten times the board's: shrinkage keeps that single sample from deciding the weight.
  const lone = squareWeights([...events, ev('h0', 'p0', 50, 840 + 600, 'Once')], freq).get('Once') ?? 1
  check('one long fight moves a weight only part of the way', lone > 1 && lone < WEIGHT_MAX, lone.toFixed(2))
}

/* --- the specialist and the offense ------------------------------------------------------------ */

{
  const early = Array.from({ length: 12 }, (_, i) => `Early${i}`)
  const dlc = Array.from({ length: 5 }, (_, i) => `Dlc${i}`)
  const weights = new Map<string, number>([
    ...early.map((n) => [n, 0.8] as [string, number]),
    ...dlc.map((n) => [n, 2.2] as [string, number]),
  ])
  const events = [
    ...run('m1', 'Offense', early, 240, 0),
    ...run('m1', 'Specialist', dlc, 576, 20),
  ]
  const rows = [
    // More hits for the early captain, and only a hair better accuracy: they win both of those.
    part({ match_key: 'm1', nickname: 'Offense', shots: 12, hits: 5, won: true }),
    part({ match_key: 'm1', nickname: 'Specialist', shots: 5, hits: 2, won: true }),
    // The other fleet, who fired nothing: makes this a two-fleet match without a third rated captain.
    part({ match_key: 'm1', nickname: 'Opponent', team: 1, shots: 0 }),
  ]
  const rated = rateBattles(rows, events, weights)
  const off = rated.find((r) => r.nickname === 'Offense')!
  const spec = rated.find((r) => r.nickname === 'Specialist')!

  check(
    'five DLC squares out-work twelve early ones',
    spec.workload > off.workload,
    `${spec.workload.toFixed(1)} vs ${off.workload.toFixed(1)}`
  )
  check('and the specialist out-rates the offense, despite fewer hits', spec.rating > off.rating, `${spec.rating} vs ${off.rating}`)
  check('the specialist is tagged as one', spec.role === 'specialist', String(spec.role))
  check('the early captain is tagged offense', off.role === 'offense', String(off.role))
  check('exactly one MVP in the match, and it is the specialist', spec.mvp && !off.mvp)
  check('ratings stay in 0-100', rated.every((r) => r.rating >= 0 && r.rating <= 100))
}

/* --- smaller rules ----------------------------------------------------------------------------- */

{
  // A crewmate who fired nothing: makes each match below a crew game (1v1s are not rated at all)
  // without adding a second rated captain.
  // A crewmate and an opponent who fired nothing: makes each match below a two-fleet crew game, the
  // only kind that is rated, without adding a second rated captain.
  const mate = (matchKey: string) => part({ match_key: matchKey, nickname: `${matchKey}-mate`, shots: 0 })
  const foe = (matchKey: string) => part({ match_key: matchKey, nickname: `${matchKey}-foe`, team: 1, shots: 0 })
  const crew = (matchKey: string) => [mate(matchKey), foe(matchKey)]

  // All misses: still a game's worth of fights, so the workload is not zero.
  const events = run('m2', 'Unlucky', ['A', 'B', 'C'], 300, 0)
  const rated = rateBattles([part({ match_key: 'm2', nickname: 'Unlucky', shots: 3, hits: 0 }), ...crew('m2')], events, new Map())
  check('misses count towards workload', rated[0]?.workload === 3, String(rated[0]?.workload))
  check('a match with one rated captain has no MVP', rated[0]?.mvp === false)

  // A two-minute match is rated as though it ran MIN_MATCH_SECONDS.
  const short = rateBattles(
    [part({ match_key: 'm3', nickname: 'Quick', shots: 2, hits: 1 }), ...crew('m3')],
    run('m3', 'Quick', ['A', 'B'], 60, 0),
    new Map()
  )
  const owed = 2 / (MIN_MATCH_SECONDS / 3600)
  check('a very short match is floored before the per-hour rate', Math.abs((short[0]?.perHour ?? 0) - owed) < 1e-9, `${short[0]?.perHour} vs ${owed}`)

  // Two identical games: the earlier one ranks first.
  const twin = (key: string, at: string) => ({
    row: part({ match_key: key, nickname: key, shots: 3, hits: 1, finished_at: at }),
    events: run(key, key, ['A', 'B', 'C'], 300, 0),
  })
  const a = twin('later', '2026-09-02T00:00:00.000Z')
  const b = twin('earlier', '2026-09-01T00:00:00.000Z')
  const tied = rateBattles([a.row, ...crew('later'), b.row, ...crew('earlier')], [...a.events, ...b.events], new Map())
  check('a tie goes to the earlier game', tied[0]?.matchKey === 'earlier', tied.map((r) => r.matchKey).join(', '))

  // No shot log for a row: it cannot be rated, and is left out rather than guessed at.
  const none = rateBattles([part({ match_key: 'm9', nickname: 'Ghost', shots: 4, hits: 2 }), ...crew('m9')], [], new Map())
  check('a game with no shot log is not rated', none.length === 0)

  // A 1v1 is never rated - and stays out of the field, so it cannot move a crew game's rating either.
  const duel = [
    part({ match_key: 'd1', nickname: 'Solo A', team: 0, shots: 30, hits: 20, sunk: 5, won: true }),
    part({ match_key: 'd1', nickname: 'Solo B', team: 1, shots: 30, hits: 10 }),
  ]
  const duelEvents = [...run('d1', 'Solo A', ['A', 'B', 'C', 'D'], 60, 0, 0), ...run('d1', 'Solo B', ['E', 'F'], 60, 10).map((e) => ({ ...e, team: 1 }))]
  const crewOnly = rateBattles([part({ match_key: 'm2', nickname: 'Unlucky', shots: 3, hits: 0 }), ...crew('m2')], events, new Map())
  const withDuel = rateBattles(
    [...duel, part({ match_key: 'm2', nickname: 'Unlucky', shots: 3, hits: 0 }), ...crew('m2')],
    [...duelEvents, ...events],
    new Map()
  )
  check('a 1v1 is not rated', withDuel.every((r) => r.matchKey !== 'd1'), withDuel.map((r) => r.matchKey).join(', '))
  check(
    'and does not move anybody else\'s rating',
    withDuel[0]?.rating === crewOnly[0]?.rating,
    `${crewOnly[0]?.rating} -> ${withDuel[0]?.rating}`
  )

  // Three fleets: not rated either, crews and all, and kept out of the field the same way.
  const threeWay = [0, 1, 2].flatMap((team) => [
    part({ match_key: 't1', nickname: `T${team}a`, team, shots: 20, hits: 15, sunk: 6, won: team === 0 }),
    part({ match_key: 't1', nickname: `T${team}b`, team, shots: 0 }),
  ])
  const threeWayEvents = [0, 1, 2].flatMap((team) =>
    run('t1', `T${team}a`, ['A', 'B', 'C', 'D'], 60, team * 10).map((e) => ({ ...e, team }))
  )
  const withThree = rateBattles(
    [...threeWay, part({ match_key: 'm2', nickname: 'Unlucky', shots: 3, hits: 0 }), ...crew('m2')],
    [...threeWayEvents, ...events],
    new Map()
  )
  check('a three-fleet match is not rated', withThree.every((r) => r.matchKey !== 't1'), withThree.map((r) => r.matchKey).join(', '))
  check(
    'and does not move anybody else\'s rating',
    withThree[0]?.rating === crewOnly[0]?.rating,
    `${crewOnly[0]?.rating} -> ${withThree[0]?.rating}`
  )
}

if (failures > 0) {
  console.log(`\n${failures} battle rating check(s) failed`)
  process.exit(1)
}
console.log('\nall battle rating checks passed')
