/**
 * Checks the victory-odds model (src/lib/victoryOdds.ts).
 *
 * A percentage is the easiest thing in the world to ship wrong, because every value it can hold
 * looks plausible. Nothing on the stream would flag a model that had quietly swapped two fleets,
 * or one that was reading a four-way match's duplicated rows as three times the shots - it would
 * just be confidently mistaken all evening. So the properties worth asserting are the ones a
 * reader could never check by eye:
 *
 *   * symmetry - identical fleets must come out even, whatever the board or the fleet count
 *   * ordering - more hull, or a faster crew, must never come out worse
 *   * the per-opponent row fan-out, which is the single easiest thing to get wrong here
 *   * a decided match reporting certainty rather than a very high estimate
 *   * determinism, because two sources drawing the same moment must print the same number
 *   * the cost budget, because this runs inside somebody's live stream
 *
 * What it deliberately does NOT check is whether the model is any GOOD - whether the moments it
 * calls 70% really do win about 70% of the time. That needs the live archive, so it lives in
 * scripts/calibrate-victory-odds.ts instead, and is a thing to run occasionally rather than on
 * every build.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-victory-odds.ts
 */
import { registerHooks } from 'node:module'
import type { Attack, ShipDefinition } from '../src/types/battleship.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { victoryOdds, fleetStates, oddsTimeline, totalHullCells, oddsLabel, oddsBands, oddsWorthShowing, LIVE_ROLLOUTS } =
  await import('../src/lib/victoryOdds.ts')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

const CLASSIC: ShipDefinition[] = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
]

const START = Date.parse('2026-08-01T12:00:00.000Z')

/** A fleet standing, built by hand so a case can say exactly what it means. */
function fleet(team: number, hull: number, fired: number, pace = 50, crew = 3) {
  return { team, hull, totalHull: 17, fired, shots: 20, pace, crew, eliminated: false }
}

/**
 * One trigger-pull, written once per opposing fleet - exactly as `attacks` stores it.
 *
 * The fan-out is the point of this helper. A shot is one row in a duel and three in a four-way,
 * and any count that reads rows rather than squares is wrong by the fleet count.
 */
function shot(
  attacker: number,
  defenders: number[],
  cell: number,
  seconds: number,
  results: Attack['result'][]
): Attack[] {
  return defenders.map((d, i) => ({
    id: `${attacker}-${cell}-${d}`,
    room_id: 'room',
    cell_index: cell,
    attacker_team: attacker,
    defender_team: d,
    attacker_player_id: null,
    result: results[i],
    sunk_ship_name: null,
    sunk_ship_size: null,
    sunk_start_row: null,
    sunk_start_col: null,
    sunk_horizontal: null,
    created_at: new Date(START + seconds * 1000).toISOString(),
    resolved_at: null,
  }))
}

const crewOf = (counts: number[]) =>
  counts.flatMap((n, team) => Array.from({ length: n }, () => ({ team })))

// -- 1. identical fleets come out even ------------------------------------
{
  const even = victoryOdds([fleet(0, 17, 30), fleet(1, 17, 30)], 10)
  const gap = Math.abs(even.odds[0] - even.odds[1])
  check('identical duel is a coin flip', gap < 0.03, `${oddsLabel(even.odds[0])} vs ${oddsLabel(even.odds[1])}`)
  check('and the odds sum to one', Math.abs(even.odds[0] + even.odds[1] + even.draw - 1) < 1e-9)

  // Four identical fleets: 25% each. Worth its own case because a model that resolved a shot
  // against only ONE opponent would still pass the duel above.
  const four = victoryOdds([0, 1, 2, 3].map((t) => fleet(t, 17, 30)), 12)
  const worst = Math.max(...four.odds.map((o) => Math.abs(o - 0.25)))
  check('identical four-way splits evenly', worst < 0.03, four.odds.map(oddsLabel).join(' / '))
}

// -- 2. the number moves the right way ------------------------------------
{
  const ahead = victoryOdds([fleet(0, 14, 30), fleet(1, 4, 30)], 10)
  check('more hull left means better odds', ahead.odds[0] > ahead.odds[1], ahead.odds.map(oddsLabel).join(' / '))
  check('and a big lead is a big number', ahead.odds[0] > 0.8, oddsLabel(ahead.odds[0]))

  // Same hull on both sides, but one crew is firing twice as often. Pace alone has to be able to
  // move the odds, or the model is just the scoreboard with a percent sign on it.
  const faster = victoryOdds([fleet(0, 17, 30, 30), fleet(1, 17, 30, 60)], 10)
  check('a faster fleet is favoured at equal hull', faster.odds[0] > faster.odds[1], faster.odds.map(oddsLabel).join(' / '))

  // And pace has to be able to OUTWEIGH a hull deficit, which is the whole reason a spectator
  // watches the number rather than counting silhouettes.
  const behindButFast = victoryOdds([fleet(0, 12, 30, 20), fleet(1, 17, 30, 90)], 10)
  check('a big pace edge can outweigh a hull deficit', behindButFast.odds[0] > 0.5, behindButFast.odds.map(oddsLabel).join(' / '))
}

// -- 3. a decided match is certain, not merely confident ------------------
{
  const dead = { ...fleet(1, 0, 30), eliminated: true }
  const over = victoryOdds([fleet(0, 9, 30), dead], 10)
  check('last fleet standing reads 100%', over.odds[0] === 1 && over.odds[1] === 0, over.odds.map(oddsLabel).join(' / '))
  check('and says so', over.decided)

  const allDead = victoryOdds([{ ...fleet(0, 0, 30), eliminated: true }, dead], 10)
  check('no fleet standing credits nobody', allDead.odds.every((o) => o === 0) && allDead.draw === 1)
}

// -- 4. one shot is one square, however many opponents it resolves against -
{
  // Team 0 fires three squares in a four-way. Nine rows, three shots, three squares fired.
  const attacks = [
    ...shot(0, [1, 2, 3], 11, 60, ['miss', 'hit', 'miss']),
    ...shot(0, [1, 2, 3], 12, 120, ['hit', 'miss', 'miss']),
    ...shot(0, [1, 2, 3], 13, 180, ['miss', 'miss', 'sunk']),
  ]
  const states = fleetStates(attacks, [0, 1, 2, 3], CLASSIC, crewOf([3, 3, 3, 3]))
  const t0 = states[0]
  check('rows fan out, shots do not', t0.shots === 3 && t0.fired === 3, `${t0.shots} shots, ${t0.fired} squares, from ${attacks.length} rows`)
  check('each opponent counts only its own damage', states[1].hull === 16 && states[2].hull === 16 && states[3].hull === 16,
    states.slice(1).map((s) => s.hull).join('/'))

  // Two DIFFERENT attackers striking the same square of one defender is one hull cell, not two.
  const crossfire = [
    ...shot(0, [1], 40, 60, ['hit']),
    ...shot(2, [1], 40, 90, ['hit']),
  ]
  const hit = fleetStates(crossfire, [0, 1, 2], CLASSIC, crewOf([3, 3, 3]))
  check('two fleets hitting one square is one hull cell', hit[1].hull === 16, `${hit[1].hull}/17`)

  // The match-start marker is not a shot.
  const marked = [...shot(0, [1], -1, 0, ['miss']), ...shot(0, [1], 5, 60, ['hit'])]
  const withMarker = fleetStates(marked, [0, 1], CLASSIC, crewOf([3, 3]))
  check('the start marker is not a square', withMarker[0].fired === 1 && withMarker[0].shots === 1)
}

// -- 5. pace: a fleet's own record, shrunk toward its crew's prior --------
{
  // Six shots a minute apart. Left to itself that is 60s; shrunk over five gaps against a
  // three-crew prior of 50s it should sit between the two, and nearer the evidence.
  const steady = [0, 60, 120, 180, 240, 300].flatMap((t, i) => shot(0, [1], i + 1, t, ['miss']))
  const [fast] = fleetStates(steady, [0, 1], CLASSIC, crewOf([3, 3]))
  check('pace lands between prior and evidence', fast.pace > 50 && fast.pace < 60, `${fast.pace.toFixed(1)}s`)

  // A fleet that has fired once has no gap to measure, so it is the prior exactly - and a bigger
  // crew starts out faster, which is most of why one fleet outpaces another.
  const [lone] = fleetStates(shot(0, [1], 3, 60, ['miss']), [0, 1], CLASSIC, crewOf([1, 1]))
  check('one shot rides entirely on the prior', Math.abs(lone.pace - 150) < 1e-9, `${lone.pace}s`)
  const [trio] = fleetStates(shot(0, [1], 3, 60, ['miss']), [0, 1], CLASSIC, crewOf([3, 3]))
  check('and a bigger crew starts out faster', trio.pace < lone.pace, `${trio.pace}s vs ${lone.pace}s`)
}

// -- 6. the same moment always prints the same number ---------------------
{
  const state = [fleet(0, 11, 44), fleet(1, 7, 51)]
  const a = victoryOdds(state, 10)
  const b = victoryOdds(state, 10)
  check('two readings of one moment agree exactly', a.odds.every((o, i) => o === b.odds[i]),
    `${a.odds.map(oddsLabel).join('/')} vs ${b.odds.map(oddsLabel).join('/')}`)
}

// -- 7. the history line ---------------------------------------------------
{
  const attacks = Array.from({ length: 120 }, (_, i) =>
    shot(i % 2, [(i + 1) % 2], 10 + i, i * 30, [i % 5 === 0 ? 'hit' : 'miss'])
  ).flat()
  const line = oddsTimeline(attacks, [0, 1], CLASSIC, crewOf([3, 3]), 10, new Date(START).toISOString(), null, 20, 200)

  check('the line is sampled, not one point per shot', line.length > 1 && line.length <= 22, `${line.length} points`)
  check('it runs forward in time', line.every((p, i) => i === 0 || p.seconds >= line[i - 1].seconds))
  check('every point sums to one', line.every((p) => Math.abs(p.odds.reduce((s, o) => s + o, 0) - 1) < 0.02))

  // The end of the line is where the eye goes, so it has to be the latest shot rather than
  // wherever the stride happened to stop.
  const last = line[line.length - 1]
  check('the line ends at the last shot', Math.abs(last.seconds - 119 * 30) < 1, `${last.seconds}s`)

  check('no shots means no line', oddsTimeline([], [0, 1], CLASSIC, crewOf([3, 3]), 10, new Date(START).toISOString()).length === 0)
  check('no start marker means no line', oddsTimeline(attacks, [0, 1], CLASSIC, crewOf([3, 3]), 10, null).length === 0)
}

// -- 7b. the bands that get drawn -----------------------------------------
{
  /**
   * Stacking is checked here rather than by eye because every way it fails still looks like a
   * graph. Bands in the wrong order disagree silently with the legend beside them; bands that
   * don't share edges leave hairlines that read as a rendering artefact; a stack that doesn't
   * reach the top leaves a strip of background that looks deliberate.
   */
  const points = [
    { seconds: 0, odds: [0.5, 0.5] },
    { seconds: 60, odds: [0.75, 0.25] },
    { seconds: 120, odds: [1, 0] },
  ]
  const bands = oddsBands([0, 1], points, 300, 100)
  check('one band per fleet', bands.length === 2 && bands[0].team === 0 && bands[1].team === 1)

  // Each band is the top edge left-to-right, then the bottom edge back again.
  check('a band closes on itself', bands.every((b) => b.polygon.length === points.length * 2))

  // Fleet 0 sits on the floor of the box: its lower edge is y = height all the way along.
  const floor = bands[0].polygon.slice(points.length)
  check('the first fleet sits on the floor', floor.every(([, y]) => y === 100), floor.map(([, y]) => y).join(','))

  // Fleet 1's top edge is the ceiling, because the odds sum to one.
  const ceiling = bands[1].polygon.slice(0, points.length)
  check('the stack reaches the ceiling', ceiling.every(([, y]) => Math.abs(y) < 1e-9), ceiling.map(([, y]) => y).join(','))

  // Neighbours share an edge exactly: fleet 0's top is fleet 1's bottom, point for point.
  const upper0 = bands[0].polygon.slice(0, points.length)
  const lower1 = bands[1].polygon.slice(points.length).reverse()
  check('neighbouring bands share an edge exactly',
    upper0.every(([x, y], i) => x === lower1[i][0] && y === lower1[i][1]))

  // Halfway through, the leader holds three quarters of the height.
  check('a band is as tall as the odds it draws', upper0[1][1] === 25, `y=${upper0[1][1]}`)
  // And time runs left to right across the full width.
  check('time fills the width', upper0[0][0] === 0 && upper0[2][0] === 300, `${upper0[0][0]}..${upper0[2][0]}`)

  check('a single point draws nothing', oddsBands([0, 1], points.slice(0, 1), 300, 100).length === 0)
  check('a zero-width box draws nothing', oddsBands([0, 1], points, 0, 100).length === 0)

  // Every shot landing in the same second has no axis, and must not divide by zero.
  const flat = oddsBands([0, 1], [{ seconds: 90, odds: [0.5, 0.5] }, { seconds: 90, odds: [0.5, 0.5] }], 300, 100)
  check('simultaneous shots do not divide by zero', flat.every((b) => b.polygon.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))))
}

// -- 8. hull totals --------------------------------------------------------
{
  check('classic is 17 cells', totalHullCells(CLASSIC) === 17, `${totalHullCells(CLASSIC)}`)
  check('an empty fleet is 0', totalHullCells([]) === 0)
}

// -- 9. it has to be cheap enough to run on a live stream -----------------
{
  /**
   * The budget exists because this runs inside an OBS browser source, next to a game capture,
   * on the machine that is also encoding video. The first cut of this model kept a fired/unfired
   * grid per fleet and scanned it to size each cold shot, which cost 1.2 SECONDS for a four-way -
   * a visible hitch on stream every time somebody landed a kill. Dropping the grid for a counter
   * is what bought the two orders of magnitude, and a budget is how that stays bought.
   */
  const cases: [string, number, ReturnType<typeof fleet>[]][] = [
    ['duel, 10x10', 10, [fleet(0, 17, 30), fleet(1, 17, 30)]],
    ['four-way, 12x12', 12, [0, 1, 2, 3].map((t) => ({ ...fleet(t, 34, 40), totalHull: 34 }))],
    ['nine-way, 14x14', 14, Array.from({ length: 9 }, (_, t) => ({ ...fleet(t, 46, 40), totalHull: 46 }))],
  ]
  for (const [label, size, fleets] of cases) {
    const t0 = performance.now()
    victoryOdds(fleets, size, LIVE_ROLLOUTS)
    const ms = performance.now() - t0
    check(`${label} runs ${LIVE_ROLLOUTS} rollouts under 400ms`, ms < 400, `${ms.toFixed(0)}ms`)
  }
}

console.log('\nwhen the bar is worth drawing at all')
// The eval bar is on two surfaces now - the browser source and the spectator rail - and both have
// to go blank at the same moment. Two surfaces disagreeing about whether the model is ready would
// be two different claims about how much the number is worth.
{
  const untouched = victoryOdds([{ ...fleet(0, 17, 0), shots: 0 }, { ...fleet(1, 17, 0), shots: 0 }], 10)
  check('no shots fired yet is not worth drawing', oddsWorthShowing(untouched) === false)
  check('nothing at all is not worth drawing', oddsWorthShowing(null) === false)

  // One shot between them is the threshold: from there the model has evidence rather than just two
  // fleet sizes, which is the whole distinction the predicate draws.
  const opened = victoryOdds([{ ...fleet(0, 17, 1), shots: 1 }, { ...fleet(1, 17, 0), shots: 0 }], 10)
  check('one shot fired IS worth drawing', oddsWorthShowing(opened) === true)
}

console.log(failures === 0 ? '\nAll victory-odds checks passed.' : `\n${failures} check(s) failed.`)

process.exit(failures === 0 ? 0 : 1)
