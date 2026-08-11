/**
 * Checks what finished matches get called (src/lib/matchName.ts).
 *
 * The rule that matters is that a name is EARNED: every one of them tests something the archived report
 * actually says, so "The Slaughter" was a rout and "The Waking" really had four tentacles found in it.
 * Nothing is random, which means a match is called the same thing forever - and these cases are what
 * stop a rule from quietly matching more than it should, since the first fit wins and a greedy rule
 * high in the list would swallow every match below it.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-match-names.ts
 */
import { registerHooks } from 'node:module'
import type { Award, PlayerStats } from '../src/lib/matchReport.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { matchName, matchEpithet, durationSeconds } = await import('../src/lib/matchName.ts')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

function stat(team: number, over: Partial<PlayerStats> = {}): PlayerStats {
  const shots = over.shots ?? 10
  const hits = over.hits ?? 3
  return {
    playerId: `p${team}-${over.nickname ?? hits}`,
    nickname: over.nickname ?? `P${team}`,
    team,
    shots,
    hits,
    misses: over.misses ?? shots - hits,
    sunk: over.sunk ?? 0,
    accuracy: shots > 0 ? hits / shots : 0,
  }
}

const award = (title: string): Award => ({ title, emoji: '', nickname: 'Ada', detail: '' })

interface Match {
  roomCode: string
  winnerTeam: number | null
  duration: string | null
  totalShots: number
  stats: PlayerStats[]
  awards: Award[]
}

/**
 * A perfectly ordinary 1v1, which now has to be ordinary on every axis a rule reads: a win by two
 * hulls, both crews shooting the same middling 40%, an unremarkable pace, and few enough shots each
 * that it isn't a grind. Anything sharper, blinder, faster or slower than this has a name waiting
 * for it, which is the whole point - so this fixture is what "nothing to say" actually looks like.
 */
function ordinary(over: Partial<Match> = {}): Match {
  return {
    roomCode: 'SALTYKRAKEN',
    winnerTeam: 0,
    duration: '30:00',
    totalShots: 34,
    stats: [stat(0, { shots: 20, hits: 8, sunk: 3 }), stat(1, { shots: 20, hits: 8, sunk: 1 })],
    awards: [],
    ...over,
  }
}

/** The same nothing-match with a full crew on each side - six players, still nothing to say. */
function crewed(over: Partial<Match> = {}): Match {
  const side = (team: number, sunk: number) =>
    ['a', 'b', 'c'].map((n, i) => stat(team, { nickname: `${n}${team}`, shots: 10, hits: 4, sunk: i === 0 ? sunk : 0 }))
  return ordinary({
    duration: '60:00',
    totalShots: 60,
    stats: [...side(0, 3), ...side(1, 1)],
    ...over,
  })
}

// -- 1. the duration parser ------------------------------------------------
{
  check('mm:ss parses', durationSeconds('12:34') === 754, String(durationSeconds('12:34')))
  check('h:mm:ss parses', durationSeconds('1:02:03') === 3723, String(durationSeconds('1:02:03')))
  check('an unrecorded duration is null, not zero', durationSeconds(null) === null && durationSeconds('') === null)
  check('and nonsense is null rather than NaN', durationSeconds('soon') === null)
}

// -- 2. the name carries the room ------------------------------------------
{
  const name = matchName(ordinary())
  check('the full name names the room', name.includes('SALTY'), name)
  check('the epithet on its own does not', !matchEpithet(ordinary()).includes('SALTY'), matchEpithet(ordinary()))
}

// -- 3. the rare things win, whatever the shooting looked like -------------
{
  check(
    'a fleet swept by one gunner outranks the lot',
    matchEpithet(ordinary({ awards: [award("Shaker's Protégé")], winnerTeam: null })) === 'The Lone Gun'
  )
  check(
    'waking him beats everything',
    matchEpithet(ordinary({ awards: [award('Woke the Sleeper')], winnerTeam: null })) === 'The Waking'
  )
  check(
    'and so does finding all four alone',
    matchEpithet(ordinary({ awards: [award("High Priest of R'lyeh")] })) === 'The Waking'
  )
  check(
    'the whale comes next',
    matchEpithet(ordinary({ awards: [award('Captain Ahab')], winnerTeam: null })) === 'The Whale Hunt'
  )
  check('then a draw', matchEpithet(ordinary({ winnerTeam: null })) === 'Mutual Destruction')
}

// -- 4. the shape of the fight --------------------------------------------
{
  check(
    'a win that lost nothing is a clean sweep',
    matchEpithet(ordinary({ stats: [stat(0, { sunk: 3 }), stat(1, { sunk: 0 })] })) === 'The Clean Sweep'
  )
  check(
    'four hulls clear is a slaughter',
    matchEpithet(ordinary({ stats: [stat(0, { sunk: 5 }), stat(1, { sunk: 1 })] })) === 'The Slaughter'
  )
  check(
    'one hull apart is a knife fight',
    matchEpithet(ordinary({ stats: [stat(0, { sunk: 4 }), stat(1, { sunk: 3 })] })) === 'The Knife Fight'
  )
  check(
    'a clean sweep is not read as a knife fight',
    matchEpithet(ordinary({ stats: [stat(0, { sunk: 1 }), stat(1, { sunk: 0 })] })) === 'The Clean Sweep'
  )
  // The commonest real result is a win by two or three hulls, which used to match no rule at all
  // and fell through to whatever the shot count said.
  check(
    'one hull apart AFTER both fleets were gutted is a mauling',
    matchEpithet(ordinary({ stats: [stat(0, { sunk: 5 }), stat(1, { sunk: 4 })] })) === 'The Mauling'
  )
  check(
    'and a cheap close one is still only a knife fight',
    matchEpithet(ordinary({ stats: [stat(0, { sunk: 2 }), stat(1, { sunk: 1 })] })) === 'The Knife Fight'
  )
  check(
    'a bloody match with an ordinary margin is attrition, not a shrug',
    matchEpithet(crewed({ stats: [stat(0, { shots: 10, hits: 4, sunk: 5 }), stat(1, { shots: 10, hits: 4, sunk: 3 }), stat(0, { nickname: 'c', shots: 10, hits: 4 }), stat(1, { nickname: 'd', shots: 10, hits: 4 }), stat(0, { nickname: 'e', shots: 10, hits: 4 }), stat(1, { nickname: 'f', shots: 10, hits: 4 })] })) === 'The War of Attrition',
    matchEpithet(crewed({ stats: [stat(0, { shots: 10, hits: 4, sunk: 5 }), stat(1, { shots: 10, hits: 4, sunk: 3 }), stat(0, { nickname: 'c', shots: 10, hits: 4 }), stat(1, { nickname: 'd', shots: 10, hits: 4 }), stat(0, { nickname: 'e', shots: 10, hits: 4 }), stat(1, { nickname: 'f', shots: 10, hits: 4 })] }))
  )
}

// -- 5. the clock ---------------------------------------------------------
//
// Every threshold here is set against the real distribution, not a guess. Matches run 15 to 98
// minutes, so the old rules - ambush under 5, long hunt over 25 - were respectively unreachable
// and unconditional.
{
  check('a short match is an ambush', matchEpithet(ordinary({ duration: '15:00', totalShots: 20 })) === 'The Ambush',
    matchEpithet(ordinary({ duration: '15:00', totalShots: 20 })))
  check(
    'short AND frantic is a squall',
    matchEpithet(ordinary({ duration: '15:00', totalShots: 60 })) === 'The Squall',
    matchEpithet(ordinary({ duration: '15:00', totalShots: 60 }))
  )
  check(
    'an hour of near silence is the doldrums',
    matchEpithet(ordinary({ duration: '60:00', totalShots: 20 })) === 'The Doldrums',
    matchEpithet(ordinary({ duration: '60:00', totalShots: 20 }))
  )
  check(
    'a genuinely long match is a long hunt',
    matchEpithet(crewed({ duration: '1:40:00', totalShots: 60 })) === 'The Long Hunt',
    matchEpithet(crewed({ duration: '1:40:00', totalShots: 60 }))
  )
  check(
    'and eighty minutes alone no longer names a match, since they all run that long',
    matchEpithet(crewed({ duration: '80:00', totalShots: 60 })) !== 'The Long Hunt'
  )
  check(
    'heavy fire in a short window is a powder storm',
    matchEpithet(crewed({ duration: '30:00', totalShots: 60 })) === 'The Powder Storm',
    matchEpithet(crewed({ duration: '30:00', totalShots: 60 }))
  )
}

// -- 6. who could actually shoot ------------------------------------------
{
  check(
    'one fleet far sharper than the other is a gunnery lesson',
    matchEpithet(ordinary({ stats: [stat(0, { shots: 10, hits: 7, sunk: 3 }), stat(1, { shots: 10, hits: 3, sunk: 1 })] })) === 'The Gunnery Lesson'
  )
  check(
    'a smaller edge is the weather gauge',
    matchEpithet(ordinary({ stats: [stat(0, { shots: 10, hits: 6, sunk: 3 }), stat(1, { shots: 10, hits: 4, sunk: 1 })] })) === 'The Weather Gauge'
  )
  check(
    'sharp shooting on BOTH sides is a turkey shoot, not a lesson',
    matchEpithet(ordinary({ stats: [stat(0, { shots: 10, hits: 7, sunk: 3 }), stat(1, { shots: 10, hits: 6, sunk: 1 })] })) === 'The Turkey Shoot'
  )
  check(
    'nobody finding anything is a blind watch',
    matchEpithet(ordinary({ stats: [stat(0, { shots: 10, hits: 3, sunk: 3 }), stat(1, { shots: 10, hits: 3, sunk: 1 })] })) === 'The Blind Watch'
  )
  check(
    'two lucky hits do not make a turkey shoot',
    matchEpithet(ordinary({ stats: [stat(0, { shots: 2, hits: 2, sunk: 3 }), stat(1, { sunk: 1 })] })) !== 'The Turkey Shoot'
  )
  // The sample floor cuts both ways: too few shots to praise is also too few to condemn.
  check(
    'and a match nobody really fired in is not a blind watch either',
    matchEpithet(ordinary({ totalShots: 6, stats: [stat(0, { shots: 4, hits: 1, sunk: 3 }), stat(1, { shots: 2, hits: 0, sunk: 1 })] })) !== 'The Blind Watch'
  )
}

// -- 7. volume is per player, not per match -------------------------------
//
// The rule that broke the archive: ninety total shots is a grind between two crews and a perfectly
// normal evening between six, but the old rule read the total and called nine matches in seventeen
// a slog.
{
  check(
    'a grind is named with its own number',
    matchEpithet(ordinary({ totalShots: 40, duration: '60:00' })) === 'The 40-Shot Slog',
    matchEpithet(ordinary({ totalShots: 40, duration: '60:00' }))
  )
  check(
    'but ninety shots split six ways is not a grind',
    matchEpithet(crewed({ totalShots: 90, duration: '90:00' })) !== 'The 90-Shot Slog',
    matchEpithet(crewed({ totalShots: 90, duration: '90:00' }))
  )
}

// -- 8. every match gets a name -------------------------------------------
{
  check('a 1v1 with nothing to say is a duel', matchEpithet(ordinary()) === 'The Duel', matchEpithet(ordinary()))
  check('a full crew is a melee', matchEpithet(crewed()) === 'The Melee', matchEpithet(crewed()))

  // The empty case: a report with no summary at all still has to produce something.
  const bare = matchEpithet({ roomCode: 'X', winnerTeam: 0, duration: null, totalShots: 0, stats: [], awards: [] })
  check('a report with no scoreboard is still named', bare.length > 0, bare)

  check(
    'and the same match is always called the same thing',
    matchName(ordinary()) === matchName(ordinary())
  )
}

console.log(failures === 0 ? '\nall match name checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
