/**
 * Checks square pace (src/lib/squarePace.ts) - the typical time a captain takes over one square.
 *
 * The arithmetic is a median over gaps, which is easy; what is worth pinning down is everything
 * AROUND it. A shot is not a row, so a three-team match writes each trigger-pull three times and a
 * pace built from rows would be a pace over phantom squares. Two squares can fall at the same
 * moment, which is not a fast square. And a gap only means anything inside one match for one
 * player - measuring across a match boundary invents a square that takes a week.
 *
 * The median itself gets its own cases because the reason for choosing it over an average is that
 * one twenty-minute wall should not move the number, and that is a property worth asserting rather
 * than assuming.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-square-pace.ts
 */
import { registerHooks } from 'node:module'
import type { MatchEventRow } from '../src/lib/almanac.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { squarePace, paceLabel, MIN_GAPS_FOR_PACE } = await import('../src/lib/squarePace.ts')
const { MIN_GAP_SECONDS } = await import('../src/lib/recordBook.ts')
const { buildPlayerStats } = await import('../src/lib/matchReport.ts')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

/** One trigger-pull, written once per opposing fleet exactly as the archive stores it. */
function ev(match: string, who: string, cell: number, seconds: number, fleets = 1): MatchEventRow[] {
  return Array.from({ length: fleets }, () => ({
    match_key: match,
    user_id: null,
    nickname: who,
    team: 0,
    cell_index: cell,
    challenge_name: `square ${cell}`,
    result: 'hit',
    match_seconds: seconds,
    board_size: 10,
    finished_at: '2026-08-01T12:00:00.000Z',
  })) as MatchEventRow[]
}

/** Shots for one player at the given times, one square each. */
function run(match: string, who: string, times: number[], fleets = 1): MatchEventRow[] {
  return times.flatMap((t, i) => ev(match, who, i + 1, t, fleets))
}

const key = (who: string) => `name:${who.toLowerCase()}`

// -- 1. the median of the gaps, not the average ---------------------------
{
  // Gaps of 60, 60, 60, 60, 60, 1200: a steady run with one long wall at the end.
  const times = [0, 60, 120, 180, 240, 300, 1500]
  const pace = squarePace(run('m1', 'Ada', times))
  check('pace is the median gap', pace.get(key('Ada')) === 60, `${pace.get(key('Ada'))}s`)
  // The mean of those gaps is 250 - four times the median, on the strength of one boss.
  check('so one long wall does not move it', pace.get(key('Ada')) !== 250)
}

// -- 2. an even number of gaps averages the two middles --------------------
{
  // Six gaps - 30, 60, 90, 120, 150, 180 - so the two middles are 90 and 120.
  const pace = squarePace(run('m1', 'Ada', [0, 30, 90, 180, 300, 450, 630]))
  check('an even count takes the mean of the middle two', pace.get(key('Ada')) === 105, `${pace.get(key('Ada'))}s`)
}

// -- 3. a shot is not a row ------------------------------------------------
{
  const solo = squarePace(run('m1', 'Ada', [0, 60, 120, 180, 240, 300], 1))
  const trio = squarePace(run('m1', 'Ada', [0, 60, 120, 180, 240, 300], 3))
  check(
    'a three-team match gives the same pace as a one-team match',
    solo.get(key('Ada')) === trio.get(key('Ada')),
    `${solo.get(key('Ada'))}s vs ${trio.get(key('Ada'))}s`
  )
}

// -- 4. two squares falling at once is not a fast square -------------------
{
  // A duo fight fills two squares a second apart, then five ordinary 100s squares.
  const events = [
    ...ev('m1', 'Ada', 1, 0),
    ...ev('m1', 'Ada', 2, 1), // the duo's second square
    ...run('m1', 'Ada', [101, 201, 301, 401, 501]).map((e, i) => ({ ...e, cell_index: i + 3 })),
  ]
  const pace = squarePace(events)
  check(
    `a gap under ${MIN_GAP_SECONDS}s is not counted`,
    pace.get(key('Ada')) === 100,
    `${pace.get(key('Ada'))}s - a counted 1s gap would drag this well below 100`
  )
}

// -- 5. gaps belong to one player in one match -----------------------------
{
  const events = [...run('m1', 'Ada', [0, 60, 120, 180, 240, 300]), ...run('m2', 'Ada', [9000, 9060])]
  const pace = squarePace(events)
  check(
    'a gap never spans two matches',
    pace.get(key('Ada')) === 60,
    `${pace.get(key('Ada'))}s - spanning m1 into m2 would inject an 8700s gap`
  )

  // Bo firing in between must not close Ada's gaps or open one of his own from her shots.
  const shared = [...run('m1', 'Ada', [0, 60, 120, 180, 240, 300]), ...run('m1', 'Bo', [30, 90, 150, 210, 270, 330])]
  const both = squarePace(shared)
  check(
    "a crewmate's shots don't close somebody else's gap",
    both.get(key('Ada')) === 60 && both.get(key('Bo')) === 60,
    `Ada ${both.get(key('Ada'))}s, Bo ${both.get(key('Bo'))}s`
  )
}

// -- 6. the floor under how few squares counts -----------------------------
{
  // MIN_GAPS_FOR_PACE gaps needs one more shot than that to produce them.
  const enough = squarePace(run('m1', 'Ada', Array.from({ length: MIN_GAPS_FOR_PACE + 1 }, (_, i) => i * 60)))
  const short = squarePace(run('m1', 'Bo', Array.from({ length: MIN_GAPS_FOR_PACE }, (_, i) => i * 60)))
  check(`${MIN_GAPS_FOR_PACE} gaps is enough for a pace`, enough.get(key('Ada')) === 60, `${enough.get(key('Ada'))}s`)
  check(`${MIN_GAPS_FOR_PACE - 1} is not`, short.get(key('Bo')) === undefined, `${short.get(key('Bo'))}`)
  check('a player with one shot has no pace', squarePace(run('m1', 'Cy', [0])).size === 0)
  check('and an empty archive produces an empty map', squarePace([]).size === 0)
}

// -- 7. rows with no clock cannot be placed in the run ---------------------
{
  const events = run('m1', 'Ada', [0, 60, 120, 180, 240, 300, 360]).map((e, i) =>
    i === 3 ? { ...e, match_seconds: null } : e
  )
  const pace = squarePace(events)
  // Dropping the 180s shot leaves gaps of 60, 60, 120, 60, 60 -> median 60, and crucially not a
  // gap measured to a shot with no clock on it.
  check('an untimed shot is skipped rather than guessed at', pace.get(key('Ada')) === 60, `${pace.get(key('Ada'))}s`)
}

// -- 8. how it reads -------------------------------------------------------
{
  check('a pace reads as a clock', paceLabel(154) === '2:34', paceLabel(154))
  check('under a minute keeps the leading zero', paceLabel(45) === '0:45', paceLabel(45))
  check('and a half second rounds rather than truncating', paceLabel(59.6) === '1:00', paceLabel(59.6))
}

// -- 9. the same rule on the post-match scoreboard --------------------------
//
// The scoreboard measures one night from the live attack log while the leaderboard measures a
// career from the archive, and the two must not be able to drift: a crew reading their own recap
// and then their own leaderboard row has to see the same measurement, not two that happen to
// agree today. Both go through paceFromGaps, and these cases are here so that stays true.
{
  const base = Date.parse('2026-08-27T20:00:00.000Z')
  const at = (min: number) => new Date(base + min * 60_000).toISOString()
  /** One trigger-pull, in the shape groupIntoShots hands over. */
  const shot = (min: number, i: number) => ({
    key: `k${i}`,
    at: at(min),
    attackerTeam: 0,
    who: 'Ada',
    cellIndex: i,
    rows: [{ attacker_player_id: 'ada', attacker_team: 0, cell_index: i, result: 'miss', created_at: at(min) }],
  })
  const players = [{ id: 'ada', nickname: 'Ada', team: 0 }]
  // Newest first, which is the order groupIntoShots produces - and the order that would measure
  // every gap in the match backwards if the scoreboard forgot to sort.
  const fired = (mins: number[]) => mins.map(shot).reverse()
  const paceOf = (mins: number[], room?: unknown) =>
    buildPlayerStats(players as never, fired(mins) as never, room as never)[0].pace

  // Gaps of 2, 3, 2, 4, 2 minutes.
  const steady = [0, 2, 5, 7, 11, 13]
  check('a match pace is the median gap', paceOf(steady) === 120, `${paceOf(steady)}s`)
  check(
    `${MIN_GAPS_FOR_PACE - 1} gaps is still not a pace on the scoreboard`,
    paceOf([0, 2, 5, 7, 11]) === null,
    `${paceOf([0, 2, 5, 7, 11])}`
  )
  // The duo bosses that fill two squares at once, in their live form: same instant, no fast square.
  check(
    'a duo boss does not become the fastest square of the night',
    paceOf([...steady, 13]) === 120,
    `${paceOf([...steady, 13])}s, under a ${MIN_GAP_SECONDS}s floor`
  )

  // A stopped clock is the room waiting, not a captain working. Twelve minutes of wall clock per
  // square here, ten of them paused - the pace is the two minutes that were actually played.
  const paused = {
    pause_at: null,
    resume_at: null,
    pause_log: [[1, 11], [13, 23], [25, 35], [37, 47], [49, 59]].map(([a, u]) => ({ at: at(a), until: at(u) })),
  }
  const walls = [0, 12, 24, 36, 48, 60]
  check('a pause is not billed to the captain', paceOf(walls, paused) === 120, `${paceOf(walls, paused)}s`)
  check('and without one it would be', paceOf(walls) === 720, `${paceOf(walls)}s`)
}

console.log(failures === 0 ? '\nall square pace checks passed' : `\n${failures} square pace check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
