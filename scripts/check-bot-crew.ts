/**
 * Checks the bot crew (src/lib/botCrew.ts) by playing whole matches on real dealt boss boards.
 *
 * The crew is meant to look like a real crew from the outside, so the checks are about what a
 * spectator would notice: the captains of a three-player crew keep to the lanes real crews keep to,
 * nobody fires into the DLC before they have entry, nobody does a square before what it needs, every
 * kill on the board is fired, the early-value bosses go early, the first shot comes after a real
 * opening, each tier keeps the pace and the accuracy it promises (BOT_TIER_SPECS), and a crew that has
 * found the whole fleet goes and finishes it. Plus the plumbing: no square twice.
 *
 * Plays through scripts/botSim.ts - the same game build-bot-routes.ts calibrated against - and
 * seeded, so a failure is the same failure every run.
 *
 *   node --experimental-strip-types scripts/check-bot-crew.ts
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

const { crewReady, captainNames } = await import('../src/lib/botCrew.ts')
const { stepsTo, hasDlcEntry, BOT_PREREQS, DLC_MAJOR_GATES, DLC_MINOR_GATES, EARLY_VALUE } = await import('../src/lib/botRules.ts')
const { BOT_TIERS, BOT_TIER_SPECS, BOT_CAPTAIN_IDS, isBot } = await import('../src/lib/bot.ts')
const { buildFlatBoard, dealtPool } = await import('../src/lib/squareSetFormat.ts')
const { rng } = await import('../src/lib/seededRandom.ts')
const { simulate, median, paceBy, accuracyOf, SQUARES, SHARED, BY_NAME } = await import('./botSim.ts')
import type { BotTier } from '../src/lib/bot.ts'
import type { BotRoutes } from '../src/lib/botCrew.ts'
import type { SimResult } from './botSim.ts'

const routes = JSON.parse(readFileSync(new URL('../src/data/botRoutes.json', import.meta.url), 'utf8')) as BotRoutes & {
  pace: Record<string, Record<string, number>>
}

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const GAMES = 40
const games = (tier: BotTier, crew: number, tag = 'g') =>
  Promise.all(Array.from({ length: GAMES }, (_, i) => simulate({ tier, crew, routes, seed: `${tag}:${tier}:${crew}:${i}` })))

// -- the data ----------------------------------------------------------------------------------------
{
  const named = [...Object.keys(BOT_PREREQS), ...Object.values(BOT_PREREQS).flat(2), ...DLC_MAJOR_GATES, ...DLC_MINOR_GATES, ...EARLY_VALUE]
  const unknown = named.filter((n) => typeof n === 'string' && !BY_NAME.has(n))
  check('every name in the bot rules is a square', unknown.length === 0, unknown.join(', '))
  check('every square has route data', SQUARES.every((s) => routes.squares[s.name]))
  check('every tier and crew size is calibrated',
    BOT_TIERS.every((t) => typeof routes.calibration?.aim[t] === 'number') && [1, 2, 3, 4].every((s) => typeof routes.calibration?.walk[s] === 'number'))
  check('the crew runs on a dealt boss board', crewReady({ routes, board: buildFlatBoard(dealtPool(SQUARES as never, null), 121, rng(1)) as never }))
  check('every captain has a seat of its own, and they all read as the bot',
    BOT_CAPTAIN_IDS.length >= 6 && new Set(BOT_CAPTAIN_IDS).size === BOT_CAPTAIN_IDS.length && BOT_CAPTAIN_IDS.every((id) => isBot({ user_id: id })))
  const names = captainNames(routes, 'sweat', 3)
  check('a crew of three sits as Limgrave, Flex and DLC', names.join(' | ') === 'Sweat · Limgrave | Sweat · Flex | Sweat · DLC', names.join(' | '))
  check('a solo bot is just its name', captainNames(routes, 'chud', 1).join() === 'Chud')
}

// -- three captains, three lanes ---------------------------------------------------------------------
const three = await games('tarnished', 3, 'three')
{
  const mix = (label: string, regions: string[]) => {
    let n = 0
    let inLane = 0
    for (const g of three) {
      const onBoard = new Set(g.board.map((s) => s.name))
      for (const c of g.captains.filter((x) => x.label === label)) {
        for (const k of c.kills) {
          if (!onBoard.has(k)) continue
          n++
          if (regions.includes(BY_NAME.get(k)!.region)) inLane++
        }
      }
    }
    return inLane / Math.max(1, n)
  }
  check('the Limgrave player keeps to Limgrave, Liurnia and Caelid', mix('limgrave', ['limgrave', 'liurnia', 'caelid']) > 0.6,
    pct(mix('limgrave', ['limgrave', 'liurnia', 'caelid'])))
  check('the flex player keeps to Altus and the Mountaintops', mix('flex', ['altus', 'mountaintops']) > 0.4, pct(mix('flex', ['altus', 'mountaintops'])))
  check('the DLC player spends most of the evening in the DLC', mix('dlc', ['dlc']) > 0.3, pct(mix('dlc', ['dlc'])))
  check('the Limgrave player all but never goes to the DLC', mix('limgrave', ['dlc']) < 0.05, pct(mix('limgrave', ['dlc'])))
}

// -- the rules hold, captain by captain ----------------------------------------------------------------
{
  let broken = 0
  let dlcEarly = 0
  let unfired = 0
  const price = (n: string) => routes.squares[n]?.gap ?? routes.overallGap
  for (const tier of BOT_TIERS) {
    for (const g of await Promise.all(Array.from({ length: 15 }, (_, i) => simulate({ tier, crew: 3, routes, seed: `rules:${tier}:${i}` })))) {
      const firedNames = new Set(g.shots.map((s) => g.board[s.cell].name))
      const onBoard = new Set(g.board.map((s) => s.name))
      for (const c of g.captains) {
        const done = new Set<string>()
        for (const k of c.kills) {
          if (BY_NAME.get(k)?.region === 'dlc' && !hasDlcEntry(done)) dlcEarly++
          if (stepsTo(k, done, (n) => BY_NAME.get(n), SHARED, price).length > 0) broken++
          if (onBoard.has(k) && !firedNames.has(k)) unfired++
          done.add(k)
        }
      }
    }
  }
  check('nobody does a square before what it needs', broken === 0, `${broken} out of order`)
  check('nobody enters the DLC before earning entry', dlcEarly === 0, `${dlcEarly} too early`)
  check('every kill on the board is fired (fire on kill)', unfired === 0, `${unfired} killed without a shot`)
}

// -- the shape of an evening ---------------------------------------------------------------------------
{
  const first = median(three.map((g) => g.shots[0]?.at ?? Infinity))
  check('a crew of three opens about when real crews do (15:08)', first > 11 * 60 && first < 19 * 60, `${Math.round(first / 60)} min`)

  let early = 0
  let dealt = 0
  for (const g of three) {
    for (const name of EARLY_VALUE) {
      const cell = g.board.findIndex((s) => s.name === name)
      if (cell < 0) continue
      dealt++
      const shot = g.shots.find((s) => s.cell === cell)
      if (shot && shot.at <= 40 * 60) early++
    }
  }
  check('the early-value bosses mostly go in the first forty minutes', early / Math.max(1, dealt) > 0.5, `${early}/${dealt}`)
  check('no square is fired at twice', three.every((g) => new Set(g.shots.map((s) => s.cell)).size === g.shots.length))
  check('every shot is credited to one of the crew', three.every((g) => g.shots.every((s) => s.captain >= 0 && s.captain < 3)))
}

// -- pace: each tier against a real crew the same size ------------------------------------------------
// Squares fired by minute 60 against the archive's median crew of that size (botRoutes pace), times
// the tier's promise - over games still running at minute 60 (see paceBy). Within a fifth: a 40-game
// median of a noisy thing.
{
  for (const crew of [1, 2, 3, 4]) {
    const real = routes.pace[crew]?.[60]
    if (!real) continue
    const tiers: BotTier[] = crew === 3 ? BOT_TIERS : ['tarnished']
    for (const tier of tiers) {
      const list: SimResult[] = crew === 3 && tier === 'tarnished' ? three : await games(tier, crew, 'pace')
      const got = paceBy(list, 60)
      const want = real * BOT_TIER_SPECS[tier].pace
      check(`${tier}, crew of ${crew}: ${Math.round(BOT_TIER_SPECS[tier].pace * 100)}% of a real crew's pace`,
        got !== null && Math.abs(got - want) <= Math.max(3, want * 0.2), `${got} by minute 60, want ~${Math.round(want)}`)
    }
  }
}

// -- accuracy and the endgame --------------------------------------------------------------------------
{
  const byTier: Record<string, SimResult[]> = {}
  for (const tier of BOT_TIERS) byTier[tier] = tier === 'tarnished' ? three : await games(tier, 3, 'acc')
  const acc = (t: BotTier) => accuracyOf(byTier[t])
  // Shaker's 45% is the best career accuracy in the archive (46.1% when this was written): he is meant
  // to play like the best player there has been, over every game, not like one lucky evening.
  for (const tier of BOT_TIERS) {
    const want = BOT_TIER_SPECS[tier].accuracy
    check(`${tier} hits about ${pct(want)} of his shots`, Math.abs(acc(tier) - want) <= 0.025, pct(acc(tier)))
  }
  check('Shaker is the sharpest of the four', acc('shaker') > acc('sweat'), pct(acc('shaker')))

  const sunk = (t: BotTier) => byTier[t].filter((g) => g.hits >= 30).length
  check('Sweat finishes the fleets he finds, Chud mostly does not', sunk('sweat') > sunk('chud') + GAMES / 4,
    `fleets sunk in 90 min: sweat ${sunk('sweat')}/${GAMES}, chud ${sunk('chud')}/${GAMES}`)
}

console.log(failures === 0 ? '\nall bot crew checks passed' : `\n${failures} bot crew check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
