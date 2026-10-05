/**
 * Checks the tournament engine (src/lib/tournament/*).
 *
 * The engine is pure - no React, no Supabase - so the strongest test available is also the simplest:
 * run whole events end to end with random results, for every field size that matters, and assert
 * the properties that DEFINE a correct tournament rather than a handful of hand-picked brackets.
 *
 *   single elimination   n - 1 matches, and nobody plays after they have lost
 *   double elimination   2n - 2 or 2n - 1 matches, and nobody plays after their second loss
 *   swiss                nobody meets twice, nobody gets a second bye before everyone has had one
 *   round robin          every pair meets exactly once, and nobody plays twice in a round
 *
 * If any of those hold across a few hundred random events, the wiring of the bracket - byes, the
 * loser-bracket drops, the reset - is right, because a mistake in any of it breaks one of them.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-tournament.ts
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { seedOrder, seedFromGroups, avoidSameGroupOpeners } = await import('../src/lib/tournament/seeding.ts')
const { buildKnockout, setScore, recordGame, revertMatch, knockoutChampion, forfeitMatch, settleForfeits } = await import('../src/lib/tournament/bracket.ts')
const { assignPhases } = await import('../src/lib/tournament/phases.ts')
const { tournamentComplete, eventChampion } = await import('../src/lib/tournament/complete.ts')
const { planStart, toMatchRows, matchFromRow } = await import('../src/lib/tournament/start.ts')
const { qualifierStatus, planNextSwissRound, planKnockout, groupsFromMatches } = await import('../src/lib/tournament/stages.ts')
const { defaultQualifier, defaultKnockout } = await import('../src/lib/tournament/formatDefaults.ts')
const { frontPageBanners, signupIsOpen, withinChampionWindow, CHAMPION_BANNER_DAYS, signupHeadline, displayName } =
  await import('../src/lib/tournament/frontPage.ts')
const { applySchedule, windowFor, validateSchedule, suggestSchedule, scheduleShape, scheduleEnd, overdueMatches, isOverdue } =
  await import('../src/lib/tournament/schedule.ts')
const { computeStandings, cutLineTied } = await import('../src/lib/tournament/standings.ts')
const { pairSwissRound, recommendedSwissRounds, swissRoundComplete } = await import('../src/lib/tournament/swiss.ts')
const { assignGroups, roundRobin, buildGroupStage } = await import('../src/lib/tournament/groups.ts')
const { validateFormat, suggestFormat, estimateMatches, effectiveCut } = await import('../src/lib/tournament/format.ts')
const { winsNeeded } = await import('../src/lib/tournament/types.ts')
const { suggestPairings, ratingSpread } = await import('../src/lib/tournament/pairing.ts')

import type { TMatch } from '../src/lib/tournament/types.ts'
import type { KnockoutOptions } from '../src/lib/tournament/bracket.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

/** Small deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`)
const seedNo = (id: string) => Number(id.slice(1))
const pairId = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`)

/** Plays every ready match to completion, choosing winners with `pick`. Returns matches in play order. */
function playOut(
  start: TMatch[],
  pick: (m: TMatch) => 'a' | 'b',
): { matches: TMatch[]; order: TMatch[]; error: string | null } {
  let matches = start
  const order: TMatch[] = []
  for (let guard = 0; guard < 10_000; guard++) {
    const next = matches.find((m) => m.status === 'ready' || m.status === 'in_progress')
    if (!next) return { matches, order, error: null }
    const side = pick(next)
    const need = winsNeeded(next.bestOf)
    const res = setScore(matches, next.key, side === 'a' ? need : 0, side === 'b' ? need : 0)
    if (!res.ok) return { matches, order, error: res.error }
    matches = res.value
    order.push(matches.find((m) => m.key === next.key)!)
  }
  return { matches, order, error: 'did not terminate' }
}

const opts = (over: Partial<KnockoutOptions> = {}): KnockoutOptions => ({
  format: 'single',
  bestOf: 1,
  thirdPlace: false,
  grandFinalReset: false,
  ...over,
})

// ---------------------------------------------------------------------------------------------
console.log('\nSeed order')
{
  check('8 slots pair 1v8 4v5 2v7 3v6', seedOrder(8).join(',') === '1,8,4,5,2,7,3,6', seedOrder(8).join(','))
  for (const size of [2, 4, 8, 16, 32, 64]) {
    const o = seedOrder(size)
    let sums = true
    for (let i = 0; i < size; i += 2) if (o[i] + o[i + 1] !== size + 1) sums = false
    check(`${size}: every first-round pair sums to ${size + 1}`, sums)
    check(`${size}: is a permutation of 1..${size}`, new Set(o).size === size && Math.min(...o) === 1 && Math.max(...o) === size)
    if (size >= 4) {
      const half = size / 2
      check(`${size}: seeds 1 and 2 are on opposite halves`, o.indexOf(1) < half && o.indexOf(2) >= half)
    }
  }
}

// ---------------------------------------------------------------------------------------------
console.log('\nSingle elimination')
{
  let allOk = true
  const notes: string[] = []
  for (let n = 2; n <= 40; n++) {
    const seeded = ids(n)
    const bracket = buildKnockout(seeded, opts())
    if (bracket.length !== n - 1) {
      allOk = false
      notes.push(`n=${n}: ${bracket.length} matches, expected ${n - 1}`)
      continue
    }
    const { matches, order, error } = playOut(bracket, (m) => (seedNo(m.a!) < seedNo(m.b!) ? 'a' : 'b'))
    if (error) {
      allOk = false
      notes.push(`n=${n}: ${error}`)
      continue
    }
    if (knockoutChampion(matches) !== 'e1') {
      allOk = false
      notes.push(`n=${n}: chalk champion was ${knockoutChampion(matches)}`)
    }
    if (matches.some((m) => m.status !== 'done')) {
      allOk = false
      notes.push(`n=${n}: unfinished matches remain`)
    }
    // Each entrant's last match is the one they lost (or the final they won).
    const lost = new Set<string>()
    for (const m of order) {
      for (const id of [m.a!, m.b!]) {
        if (lost.has(id)) {
          allOk = false
          notes.push(`n=${n}: ${id} played after losing`)
        }
      }
      lost.add(m.a === m.winner ? m.b! : m.a!)
    }
    if (new Set(order.flatMap((m) => [m.a, m.b])).size !== n) {
      allOk = false
      notes.push(`n=${n}: some entrant never played`)
    }
  }
  check('n=2..40: n-1 matches, chalk winner is seed 1, nobody plays after losing', allOk, notes.slice(0, 3).join('; '))

  const five = buildKnockout(ids(5), opts())
  const firstRound = five.filter((m) => m.round === 1)
  check('5 entrants: one first-round match (seeds 4 v 5), seeds 1-3 get byes',
    firstRound.length === 1 && [firstRound[0].a, firstRound[0].b].sort().join() === 'e4,e5')

  const third = buildKnockout(ids(8), opts({ thirdPlace: true }))
  check('8 entrants + third place: 8 matches, TP takes both semifinal losers',
    third.length === 8 && third.filter((m) => m.bracket === 'TP').length === 1)
  const tpPlayed = playOut(third, (m) => (seedNo(m.a!) < seedNo(m.b!) ? 'a' : 'b'))
  const tp = tpPlayed.matches.find((m) => m.bracket === 'TP')!
  check('third-place match is played between the semifinal losers', tp.status === 'done' && [tp.a, tp.b].sort().join() === 'e3,e4', `${tp.a} v ${tp.b}`)
  check('3 entrants + third place: no phantom third-place match', !buildKnockout(ids(3), opts({ thirdPlace: true })).some((m) => m.bracket === 'TP'))
}

// ---------------------------------------------------------------------------------------------
console.log('\nDouble elimination')
{
  for (const reset of [false, true]) {
    let allOk = true
    const notes: string[] = []
    let resetsPlayed = 0
    let resetsSkipped = 0
    for (let n = 2; n <= 40; n++) {
      for (let trial = 0; trial < 12; trial++) {
        const rand = rng(n * 1000 + trial + (reset ? 7 : 0))
        const bracket = buildKnockout(ids(n), opts({ format: 'double', grandFinalReset: reset }))
        const { matches, order, error } = playOut(bracket, () => (rand() < 0.5 ? 'a' : 'b'))
        const tag = `n=${n} trial=${trial}`
        if (error) {
          allOk = false
          notes.push(`${tag}: ${error}`)
          continue
        }
        const played = order.length
        if (played !== 2 * n - 2 && played !== 2 * n - 1) {
          allOk = false
          notes.push(`${tag}: ${played} matches played, expected ${2 * n - 2} or ${2 * n - 1}`)
        }
        if (!reset && played !== 2 * n - 2 && n > 2) {
          // Without a reset the grand final is a single series: exactly 2n-2 matches, always.
        }
        if (!reset && played !== 2 * n - 2) {
          allOk = false
          notes.push(`${tag}: no reset but ${played} matches`)
        }
        const bad = matches.filter((m) => m.status === 'pending' || m.status === 'ready' || m.status === 'in_progress')
        if (bad.length) {
          allOk = false
          notes.push(`${tag}: left ${bad.map((m) => m.key).join(',')}`)
        }
        const losses = new Map<string, number>()
        for (const m of order) {
          for (const id of [m.a!, m.b!]) {
            if ((losses.get(id) ?? 0) >= 2) {
              allOk = false
              notes.push(`${tag}: ${id} played after 2 losses`)
            }
          }
          const loser = m.a === m.winner ? m.b! : m.a!
          losses.set(loser, (losses.get(loser) ?? 0) + 1)
        }
        const champ = knockoutChampion(matches)
        if (!champ) {
          allOk = false
          notes.push(`${tag}: no champion`)
        } else if ((losses.get(champ) ?? 0) > 1) {
          allOk = false
          notes.push(`${tag}: champion has ${losses.get(champ)} losses`)
        }
        const eliminated = [...losses.entries()].filter(([, l]) => l >= 2).length
        // Without a reset, the loser-bracket side taking the grand final leaves two teams on one
        // loss each - that is what "no reset" means - so one fewer is knocked out.
        const gf1 = matches.find((m) => m.key === 'GF1')!
        const lbTookIt = !reset && gf1.winner === gf1.b
        const expectedOut = lbTookIt ? n - 2 : n - 1
        if (champ && eliminated !== expectedOut) {
          allOk = false
          notes.push(`${tag}: ${eliminated} eliminated, expected ${expectedOut}`)
        }
        const gf2 = matches.find((m) => m.resetOf === 'GF1')
        if (gf2?.status === 'done') resetsPlayed++
        if (gf2?.status === 'skipped') resetsSkipped++
      }
    }
    check(`n=2..40, random results, reset=${reset}: 2n-2/2n-1 matches, ≤2 losses, one champion, n-1 eliminated`, allOk, notes.slice(0, 3).join('; '))
    if (reset) check('the grand-final reset is sometimes played and sometimes skipped', resetsPlayed > 0 && resetsSkipped > 0, `${resetsPlayed} played, ${resetsSkipped} skipped`)
  }

  // Chalk: how early can a rematch happen? Unavoidable ones (the final, and the loser-bracket final
  // where the winners-final loser meets the man who lost to him) are fine; anything earlier means
  // the drop-in reversal is wrong.
  let earlyRematch = ''
  for (const n of [4, 5, 6, 7, 8, 12, 16, 24, 32, 48, 64]) {
    const bracket = buildKnockout(ids(n), opts({ format: 'double', grandFinalReset: true }))
    const lastL = Math.max(...bracket.filter((m) => m.bracket === 'L').map((m) => m.round))
    const { order } = playOut(bracket, (m) => (seedNo(m.a!) < seedNo(m.b!) ? 'a' : 'b'))
    const met = new Set<string>()
    for (const m of order) {
      const key = pairId(m.a!, m.b!)
      if (met.has(key) && m.bracket !== 'GF' && !(m.bracket === 'L' && m.round === lastL)) {
        earlyRematch ||= `n=${n}: ${m.a} v ${m.b} again in ${m.key}`
      }
      met.add(key)
    }
  }
  check('chalk play: no rematch before the loser-bracket final', earlyRematch === '', earlyRematch)

  // n = 2: double elimination is just a final with a second chance.
  const two = buildKnockout(ids(2), opts({ format: 'double', grandFinalReset: true }))
  check('2 entrants: W1, GF1 and a reset', two.map((m) => m.key).join() === 'W1-0,GF1,GF2', two.map((m) => m.key).join())
}

// ---------------------------------------------------------------------------------------------
console.log('\nRecording results')
{
  const bracket = buildKnockout(ids(4), opts({ bestOf: 3 }))
  const need = winsNeeded(3)
  check('best of 3 needs 2 wins', need === 2)

  let r = recordGame(bracket, 'W1-0', 'a')
  check('one game in a bo3 leaves it in progress', r.ok && r.value.find((m) => m.key === 'W1-0')!.status === 'in_progress')
  check('...and sends nobody anywhere yet', r.ok && r.value.find((m) => m.key === 'W2-0')!.a === null)
  if (r.ok) r = recordGame(r.value, 'W1-0', 'a')
  check('second game decides it', r.ok && r.value.find((m) => m.key === 'W1-0')!.status === 'done')
  check('...and the winner reaches the final', r.ok && r.value.find((m) => m.key === 'W2-0')!.a === 'e1')
  check('a decided series refuses a third game', r.ok && !recordGame(r.value, 'W1-0', 'b').ok)

  const bad1 = setScore(bracket, 'W1-0', 3, 0)
  const bad2 = setScore(bracket, 'W1-0', 2, 2)
  const bad3 = setScore(bracket, 'W1-0', -1, 0)
  const bad4 = setScore(bracket, 'W2-0', 1, 0)
  check('scores past the winning total are refused', !bad1.ok && !bad2.ok)
  check('negative scores are refused', !bad3.ok)
  check('a match still waiting on entrants refuses a score', !bad4.ok)

  // Correcting and reverting.
  let m = bracket
  m = (setScore(m, 'W1-0', 2, 0) as { ok: true; value: TMatch[] }).value
  m = (setScore(m, 'W1-1', 2, 1) as { ok: true; value: TMatch[] }).value
  check('the final has both finalists', m.find((x) => x.key === 'W2-0')!.status === 'ready')
  const fixScore = setScore(m, 'W1-0', 2, 1)
  check('changing a score without changing the winner is fine', fixScore.ok)

  let played = (setScore(m, 'W2-0', 2, 0) as { ok: true; value: TMatch[] }).value
  const flip = setScore(played, 'W1-0', 0, 2)
  check('flipping a winner is refused once the next round is played', !flip.ok, flip.ok ? '' : flip.error)
  const sameWinner = setScore(played, 'W1-0', 2, 1)
  check('...but a same-winner score fix is still allowed', sameWinner.ok)
  const revertLate = revertMatch(played, 'W1-0')
  check('reverting is refused while the next match stands', !revertLate.ok)

  const revertFinal = revertMatch(played, 'W2-0')
  check('reverting the final works', revertFinal.ok)
  if (revertFinal.ok) {
    played = revertFinal.value
    const revertSemi = revertMatch(played, 'W1-0')
    check('...then the semifinal can be reverted', revertSemi.ok)
    if (revertSemi.ok) {
      const final = revertSemi.value.find((x) => x.key === 'W2-0')!
      check('...and its winner leaves the final', final.a === null && final.status === 'pending')
      check('nothing to revert on an unplayed match', !revertMatch(revertSemi.value, 'W1-0').ok)
    }
  }

  // Grand final reset.
  const de = buildKnockout(ids(4), opts({ format: 'double', grandFinalReset: true }))
  const toGf = (wbWins: boolean) => {
    const res = playOut(de, (mm) => {
      if (mm.key === 'GF1') return wbWins ? 'a' : 'b'
      return seedNo(mm.a!) < seedNo(mm.b!) ? 'a' : 'b'
    })
    // playOut plays GF2 too if it becomes ready; stop before it.
    return res
  }
  const wbTakes = toGf(true)
  check('WB champion wins GF1: reset skipped, champion crowned', wbTakes.matches.find((x) => x.key === 'GF2')!.status === 'skipped' && knockoutChampion(wbTakes.matches) === 'e1')

  // Stop just after GF1 with the LB side winning.
  let stage = de
  for (let i = 0; i < 100; i++) {
    const next = stage.find((x) => (x.status === 'ready' || x.status === 'in_progress') && x.key !== 'GF2')
    if (!next) break
    const side = next.key === 'GF1' ? 'b' : seedNo(next.a!) < seedNo(next.b!) ? 'a' : 'b'
    stage = (setScore(stage, next.key, side === 'a' ? 1 : 0, side === 'b' ? 1 : 0) as { ok: true; value: TMatch[] }).value
  }
  const gf1 = stage.find((x) => x.key === 'GF1')!
  const gf2 = stage.find((x) => x.key === 'GF2')!
  check('LB champion wins GF1: the reset is ready with the same two teams', gf2.status === 'ready' && gf2.a === gf1.a && gf2.b === gf1.b)
  check('...and there is no champion yet', knockoutChampion(stage) === null)
  const rev = revertMatch(stage, 'GF1')
  check('reverting GF1 puts the reset back to pending', rev.ok && rev.value.find((x) => x.key === 'GF2')!.status === 'pending')
  const playedReset = setScore(stage, 'GF2', 1, 0)
  check('GF1 cannot be reverted once the reset is played', playedReset.ok && !revertMatch(playedReset.value, 'GF1').ok)
  check('the reset winner is champion', playedReset.ok && knockoutChampion(playedReset.value) === gf2.a)

  // Series lengths.
  const varied = buildKnockout(ids(8), opts({ bestOf: 1, semifinalBestOf: 3, finalBestOf: 5 }))
  check('bestOf: quarters 1, semis 3, final 5',
    varied.filter((x) => x.round === 1).every((x) => x.bestOf === 1) &&
      varied.filter((x) => x.round === 2).every((x) => x.bestOf === 3) &&
      varied.find((x) => x.round === 3)!.bestOf === 5)
}

// ---------------------------------------------------------------------------------------------
console.log('\nStandings')
{
  const mk = (a: string, b: string, sa: number, sb: number, key: string): TMatch => ({
    key, stage: 'swiss', bracket: null, group: null, round: 1, index: 0, a, b, bestOf: 3,
    scoreA: sa, scoreB: sb, status: 'done', winner: sa > sb ? a : b, winnerTo: null, loserTo: null, resetOf: null, isBye: false,
  })
  const field = ['a', 'b', 'c', 'd']
  // a beats b, b beats c, c beats a: a cycle, plus d beaten by everyone.
  const cyc = [mk('a', 'b', 2, 0, 'm1'), mk('b', 'c', 2, 0, 'm2'), mk('c', 'a', 2, 0, 'm3'), mk('a', 'd', 2, 0, 'm4'), mk('b', 'd', 2, 0, 'm5'), mk('c', 'd', 2, 0, 'm6')]
  const s = computeStandings(field, cyc)
  check('a three-way cycle stays tied rather than being guessed', s.slice(0, 3).every((r) => r.tied), s.map((r) => `${r.id}:${r.tied}`).join(' '))
  check('...and the last-placed entrant is not tied', s[3].id === 'd' && !s[3].tied)
  check('cut line inside the cycle is flagged', cutLineTied(s, 2))
  check('cut line below the cycle is not', !cutLineTied(s, 3))

  // Two level entrants who have met: head to head decides, and is not flagged.
  const h2h = computeStandings(['x', 'y', 'z'], [mk('x', 'y', 0, 2, 'h1'), mk('x', 'z', 2, 0, 'h2'), mk('y', 'z', 0, 2, 'h3')])
  // x: 1-1 (beat z, lost y). y: 1-1 (beat x, lost z). z: 1-1. Three-way: tied.
  check('three level entrants are tied', h2h.every((r) => r.tied))
  const two = computeStandings(['p', 'q'], [mk('q', 'p', 2, 1, 'k1')])
  check('two entrants, one result: winner first, not tied', two[0].id === 'q' && !two[0].tied)
  const byes = computeStandings(['p', 'q', 'r'], [
    { ...mk('r', 'r', 0, 0, 'bye'), b: null, isBye: true, winner: 'r' },
    mk('p', 'q', 2, 0, 'g'),
  ])
  check('a bye is a win but not a game', byes.find((r) => r.id === 'r')!.wins === 1 && byes.find((r) => r.id === 'r')!.played === 0)
  check('a bye adds nothing to game difference', byes.find((r) => r.id === 'r')!.gameDiff === 0)
}

// ---------------------------------------------------------------------------------------------
console.log('\nSwiss')
{
  const r1 = pairSwissRound(ids(8), [], 1, 1)
  check('round 1 of 8 pairs Dutch: 1v5 2v6 3v7 4v8',
    r1.map((m) => `${m.a}${m.b}`).join() === 'e1e5,e2e6,e3e7,e4e8', r1.map((m) => `${m.a}${m.b}`).join())

  let allOk = true
  const notes: string[] = []
  for (let n = 3; n <= 41; n++) {
    for (let trial = 0; trial < 4; trial++) {
      const rand = rng(n * 77 + trial)
      const field = ids(n)
      const rounds = recommendedSwissRounds(n)
      let matches: TMatch[] = []
      const byes = new Map<string, number>()
      const met = new Set<string>()
      for (let round = 1; round <= rounds; round++) {
        const paired = pairSwissRound(field, matches, round, 1)
        const inRound = paired.flatMap((m) => (m.isBye ? [m.a!] : [m.a!, m.b!]))
        if (new Set(inRound).size !== n) {
          allOk = false
          notes.push(`n=${n} r${round}: ${new Set(inRound).size}/${n} entrants paired`)
        }
        for (const m of paired) {
          if (m.isBye) {
            byes.set(m.a!, (byes.get(m.a!) ?? 0) + 1)
            continue
          }
          const key = pairId(m.a!, m.b!)
          if (met.has(key)) {
            allOk = false
            notes.push(`n=${n} trial=${trial} r${round}: rematch ${m.a} v ${m.b}`)
          }
          met.add(key)
        }
        if (n % 2 === 0 && paired.some((m) => m.isBye)) {
          allOk = false
          notes.push(`n=${n}: bye in an even field`)
        }
        if (n % 2 === 1 && paired.filter((m) => m.isBye).length !== 1) {
          allOk = false
          notes.push(`n=${n}: odd field should have exactly one bye`)
        }
        // Play the round.
        const played = paired.map((m) => {
          if (m.isBye) return m
          const aWins = rand() < 0.5
          return { ...m, scoreA: aWins ? 1 : 0, scoreB: aWins ? 0 : 1, winner: aWins ? m.a : m.b, status: 'done' as const }
        })
        matches = [...matches, ...played]
        if (!swissRoundComplete(matches, round)) {
          allOk = false
          notes.push(`n=${n} r${round}: round not complete after playing it`)
        }
      }
      // A second bye only after everybody has had one.
      const most = Math.max(0, ...byes.values())
      const someoneNone = field.some((id) => !byes.has(id))
      if (most > 1 && someoneNone) {
        allOk = false
        notes.push(`n=${n}: someone had ${most} byes while others had none`)
      }
    }
  }
  check('n=3..41, random results: everyone paired every round, no rematches, byes spread out', allOk, notes.slice(0, 3).join('; '))

  check('recommended rounds: 8→3, 9→4, 16→4, 17→5, 3→2, 2→1',
    [8, 9, 16, 17, 3, 2].map(recommendedSwissRounds).join() === '3,4,4,5,2,1', [8, 9, 16, 17, 3, 2].map(recommendedSwissRounds).join())

  // Once the rounds outrun the field, a rematch is unavoidable - it must still return a round.
  let matches: TMatch[] = []
  for (let round = 1; round <= 4; round++) {
    const paired = pairSwissRound(ids(4), matches, round, 1)
    matches = [...matches, ...paired.map((m) => ({ ...m, scoreA: 1, winner: m.a, status: 'done' as const }))]
  }
  check('4 entrants over 4 rounds still yields a full round 4 (with an unavoidable rematch)',
    matches.filter((m) => m.round === 4).length === 2)
}

// ---------------------------------------------------------------------------------------------
console.log('\nGroups')
{
  const g = assignGroups(ids(12), 4)
  check('12 into 4 groups: three each', g.every((x) => x.length === 3))
  check('snake: A gets seeds 1, 8, 9', g[0].join() === 'e1,e8,e9', g[0].join())
  check('snake: D gets seeds 4, 5, 12', g[3].join() === 'e4,e5,e12', g[3].join())
  const spread = (groups: string[][]) => {
    const sums = groups.map((grp) => grp.reduce((s, id) => s + seedNo(id), 0))
    return Math.max(...sums) - Math.min(...sums)
  }
  // A straight deal (1-4 into A-D, 5-8 into A-D, ...) is the alternative the snake exists to beat.
  const straight: string[][] = [[], [], [], []]
  ids(12).forEach((id, i) => straight[i % 4].push(id))
  check('snake keeps group seed sums closer than a straight deal', spread(g) < spread(straight), `snake ${spread(g)}, straight ${spread(straight)}`)

  let allOk = true
  const notes: string[] = []
  for (let n = 2; n <= 12; n++) {
    const rounds = roundRobin(ids(n))
    const met = new Set<string>()
    for (const round of rounds) {
      const inRound = round.flat()
      if (new Set(inRound).size !== inRound.length) {
        allOk = false
        notes.push(`n=${n}: someone plays twice in a round`)
      }
      for (const [x, y] of round) met.add(pairId(x, y))
    }
    const expected = (n * (n - 1)) / 2
    if (met.size !== expected || rounds.flat().length !== expected) {
      allOk = false
      notes.push(`n=${n}: ${met.size} distinct pairings across ${rounds.flat().length}, expected ${expected}`)
    }
  }
  check('n=2..12: every pair meets exactly once, nobody twice in a round', allOk, notes.join('; '))

  const stage = buildGroupStage(assignGroups(ids(8), 2), 2, 1)
  check('8 into 2 groups, two legs: 2 × (6 × 2) = 24 matches', stage.length === 24, String(stage.length))
  const legOne = stage.find((m) => m.group === 0 && m.round === 1)!
  const legTwo = stage.find((m) => m.group === 0 && m.round === 4 && [m.a, m.b].includes(legOne.a) && [m.a, m.b].includes(legOne.b))
  check('the second leg swaps sides', legTwo !== undefined && legTwo.a === legOne.b, legTwo ? `${legTwo.a}/${legTwo.b} vs ${legOne.a}/${legOne.b}` : 'no rematch found')

  // Advancing from groups without a round-one rematch.
  const tables = assignGroups(ids(8), 2).map((grp, gi) => {
    const matches = buildGroupStage([grp], 1, 1).map((m) => ({ ...m, group: gi }))
    const rand = rng(gi + 5)
    const done = matches.map((m) => {
      const aWins = rand() < 0.5
      return { ...m, scoreA: aWins ? 1 : 0, scoreB: aWins ? 0 : 1, winner: aWins ? m.a : m.b, status: 'done' as const }
    })
    return computeStandings(grp, done)
  })
  const seeded = seedFromGroups(tables, 2)
  const groupOf = new Map<string, number>()
  tables.forEach((t, gi) => t.forEach((r) => groupOf.set(r.id, gi)))
  const bracket = buildKnockout(seeded, opts())
  check('2 groups, top 2 each: 4 advance', seeded.length === 4)
  const firstRound = bracket.filter((m) => m.round === 1)
  check('...and no first-round match is between group-mates',
    firstRound.every((m) => groupOf.get(m.a!) !== groupOf.get(m.b!)),
    firstRound.map((m) => `${m.a}(${groupOf.get(m.a!)}) v ${m.b}(${groupOf.get(m.b!)})`).join(' '))

  // The repair on a deliberately bad draw: 4 groups, 2 each, tier order A1 B1 C1 D1 A2 B2 C2 D2.
  const bad = ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2']
  const grp = new Map(bad.map((id) => [id, id.charCodeAt(0)]))
  const tier = new Map(bad.map((id) => [id, Number(id[1]) - 1]))
  const fixed = avoidSameGroupOpeners(bad, grp, tier)
  const order = seedOrder(8)
  let clash = false
  for (let i = 0; i < 8; i += 2) if (grp.get(fixed[order[i] - 1]) === grp.get(fixed[order[i + 1] - 1])) clash = true
  check('repair: 4 groups × top 2 has no group-mates in round one', !clash, fixed.join())
  check('repair: group winners keep seeds 1-4', fixed.slice(0, 4).join() === 'A1,B1,C1,D1')

  // The worst draw: every single first-round pair is two group-mates (1v8, 4v5, 2v7, 3v6).
  const allClash = ['A1', 'B1', 'C1', 'D1', 'D2', 'C2', 'B2', 'A2']
  const g2 = new Map(allClash.map((id) => [id, id.charCodeAt(0)]))
  const t2 = new Map(allClash.map((id) => [id, Number(id[1]) - 1]))
  const fixed2 = avoidSameGroupOpeners(allClash, g2, t2)
  let clashes2 = 0
  for (let i = 0; i < 8; i += 2) if (g2.get(fixed2[order[i] - 1]) === g2.get(fixed2[order[i + 1] - 1])) clashes2++
  check('repair: a draw where all four openers clash is fully untangled', clashes2 === 0, fixed2.join())
  check('repair: ...without moving anyone across tiers', fixed2.slice(0, 4).every((id) => id[1] === '1') && fixed2.slice(4).every((id) => id[1] === '2'))

  // Two groups, top 3 each: group-mates are unavoidable somewhere; it must still return a full field.
  const six = ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']
  const g3 = new Map(six.map((id) => [id, id.charCodeAt(0)]))
  const t3 = new Map(six.map((id) => [id, Number(id[1]) - 1]))
  const fixed3 = avoidSameGroupOpeners(six, g3, t3)
  check('repair: an unavoidable clash still returns every team exactly once', new Set(fixed3).size === 6 && fixed3.length === 6, fixed3.join())
}

// ---------------------------------------------------------------------------------------------
console.log('\nFormats')
{
  const swiss = { format: 'swiss' as const, rounds: 4, bestOf: 1 }
  const ko = { format: 'single' as const, cutTo: 8, bestOf: 1, thirdPlace: false, grandFinalReset: false }
  check('a sensible format has no errors', validateFormat({ qualifier: swiss, knockout: ko }, 16).length === 0)
  check('cut larger than the field is an error', validateFormat({ qualifier: swiss, knockout: { ...ko, cutTo: 20 } }, 16).length > 0)
  check('more Swiss rounds than opponents is an error', validateFormat({ qualifier: { ...swiss, rounds: 16 }, knockout: ko }, 16).length > 0)
  check('nothing at all is an error', validateFormat({ qualifier: { format: 'none' }, knockout: null }, 16).length > 0)
  check('even-numbered series lengths are an error', validateFormat({ qualifier: swiss, knockout: { ...ko, bestOf: 2 } }, 16).length > 0)
  const groups = (advancePerGroup?: number, groupCount = 4) =>
    ({ format: 'groups' as const, groupCount, advancePerGroup, legs: 1 as const, bestOf: 1 })
  check('groups: top 2 of each of 4 groups is fine', validateFormat({ qualifier: groups(2), knockout: ko }, 16).length === 0)
  check('groups: a knockout needs to know how many advance', validateFormat({ qualifier: groups(undefined), knockout: ko }, 16).length > 0)
  check('groups: no number needed when the groups are the whole event',
    validateFormat({ qualifier: groups(undefined), knockout: null }, 16).length === 0)
  check('groups: cannot take more from a group than it holds', validateFormat({ qualifier: groups(3), knockout: ko }, 9).length > 0)
  check('groups: uneven groups are limited by the smallest (10 into 3 is 4/3/3)',
    validateFormat({ qualifier: groups(3, 3), knockout: ko }, 10).length === 0 && validateFormat({ qualifier: groups(4, 3), knockout: ko }, 10).length > 0)
  check('groups: the total follows from per-group (3 groups × 2 = 6)', effectiveCut({ qualifier: groups(2, 3), knockout: ko }, 12) === 6)
  check('groups: cutTo is ignored, so a stale one cannot disagree', effectiveCut({ qualifier: groups(2, 4), knockout: { ...ko, cutTo: 3 } }, 16) === 8)
  check('swiss still needs a cut', validateFormat({ qualifier: swiss, knockout: { ...ko, cutTo: undefined } }, 16).length > 0)
  check('effectiveCut: no qualifier means everyone', effectiveCut({ qualifier: { format: 'none' }, knockout: ko }, 13) === 13)

  let allValid = true
  const invalid: string[] = []
  for (let n = 2; n <= 200; n++) {
    const s = suggestFormat(n)
    const errs = validateFormat(s.format, n)
    if (errs.length || s.reasons.length === 0) {
      allValid = false
      invalid.push(`n=${n}: ${errs.join(' / ') || 'no reasons'}`)
    }
  }
  check('suggestFormat is valid, and explains itself, for every field from 2 to 200', allValid, invalid.slice(0, 2).join('; '))
  check('suggestion: 6 entrants → double elimination', suggestFormat(6).format.knockout?.format === 'double')
  check('suggestion: 16 entrants → Swiss 4 rounds, cut to 8',
    suggestFormat(16).format.qualifier.format === 'swiss' && suggestFormat(16).format.knockout?.cutTo === 8)

  // The estimate must agree with what the generators actually produce.
  let estimatesOk = true
  const off: string[] = []
  for (let n = 2; n <= 40; n++) {
    const f = suggestFormat(n).format
    const est = estimateMatches(f, n)
    let actualQualifier = 0
    if (f.qualifier.format === 'swiss') {
      let matches: TMatch[] = []
      for (let r = 1; r <= f.qualifier.rounds; r++) {
        const paired = pairSwissRound(ids(n), matches, r, 1)
        actualQualifier += paired.filter((m) => !m.isBye).length
        matches = [...matches, ...paired.map((m) => ({ ...m, scoreA: 1, winner: m.a, status: 'done' as const }))]
      }
    } else if (f.qualifier.format === 'groups') {
      actualQualifier = buildGroupStage(assignGroups(ids(n), f.qualifier.groupCount), f.qualifier.legs, 1).length
    }
    let actualKnockout = 0
    if (f.knockout) actualKnockout = buildKnockout(ids(effectiveCut(f, n)), f.knockout).length
    const inRange = actualKnockout >= est.knockoutMin && actualKnockout <= est.knockoutMax + (f.knockout?.grandFinalReset ? 0 : 0)
    if (est.qualifier !== actualQualifier || (f.knockout && !inRange && actualKnockout !== est.knockoutMax)) {
      estimatesOk = false
      off.push(`n=${n}: est ${est.qualifier}+${est.knockoutMin}-${est.knockoutMax}, actual ${actualQualifier}+${actualKnockout}`)
    }
  }
  check('estimateMatches agrees with the generators for n=2..40', estimatesOk, off.slice(0, 3).join('; '))
}

// ---------------------------------------------------------------------------------------------
console.log('\nWhole event, start to finish')
{
  // 16 entrants: 4 Swiss rounds, cut to 8, single elimination with bo3 semis and final.
  const n = 16
  const field = ids(n)
  const rand = rng(2026)
  const format = suggestFormat(n).format
  let swissMatches: TMatch[] = []
  for (let round = 1; round <= (format.qualifier as { rounds: number }).rounds; round++) {
    const paired = pairSwissRound(field, swissMatches, round, 1)
    swissMatches = [
      ...swissMatches,
      ...paired.map((m) => {
        if (m.isBye) return m
        const aWins = rand() < 0.5
        return { ...m, scoreA: aWins ? 1 : 0, scoreB: aWins ? 0 : 1, winner: aWins ? m.a : m.b, status: 'done' as const }
      }),
    ]
  }
  const table = computeStandings(field, swissMatches)
  check('every entrant played 4 Swiss games', table.every((r) => r.played + r.byes === 4))
  const cut = effectiveCut(format, n)
  const through = table.slice(0, cut).map((r) => r.id)
  const bracket = buildKnockout(through, format.knockout!)
  const { matches, error } = playOut(bracket, () => (rand() < 0.5 ? 'a' : 'b'))
  const champion = knockoutChampion(matches)
  check('the knockout finishes with a champion from the qualified eight', !error && champion !== null && through.includes(champion), error ?? String(champion))
  check('the final is a best of 3', matches.find((m) => m.round === 3)!.bestOf === 3)
}

{
  // 13 entrants (uneven groups) into 4 groups, top 2 of each into a double elimination: the seeding
  // exercise. Groups are only there to seed the bracket, so what matters is the hand-off.
  const n = 13
  const field = ids(n)
  const format = {
    qualifier: { format: 'groups' as const, groupCount: 4, advancePerGroup: 2, legs: 1 as const, bestOf: 1 },
    knockout: { format: 'double' as const, bestOf: 1, thirdPlace: false, grandFinalReset: true },
  }
  check('13 entrants pass validation as 4 groups, top 2 advancing', validateFormat(format, n).length === 0)
  const groupsOf = assignGroups(field, 4)
  check('groups of 4, 3, 3, 3', groupsOf.map((g) => g.length).sort().join() === '3,3,3,4')

  const rand = rng(99)
  const stage = buildGroupStage(groupsOf, 1, 1)
  const played = stage.map((m) => {
    const aWins = rand() < 0.5
    return { ...m, scoreA: aWins ? 1 : 0, scoreB: aWins ? 0 : 1, winner: aWins ? m.a : m.b, status: 'done' as const }
  })
  const tables = groupsOf.map((grp, gi) => computeStandings(grp, played.filter((m) => m.group === gi)))
  const seeded = seedFromGroups(tables, 2)
  const cut = effectiveCut(format, n)
  check('eight go through', seeded.length === 8 && cut === 8)
  check('every group sends exactly its top two', tables.every((t) => t.slice(0, 2).every((r) => seeded.includes(r.id))))
  check('nobody below second place goes through', tables.every((t) => t.slice(2).every((r) => !seeded.includes(r.id))))
  const tier = (id: string) => tables.find((t) => t.some((r) => r.id === id))!.findIndex((r) => r.id === id)
  check('every group winner is seeded above every runner-up',
    seeded.slice(0, 4).every((id) => tier(id) === 0) && seeded.slice(4).every((id) => tier(id) === 1))

  const bracket = buildKnockout(seeded, format.knockout)
  const groupIndex = (id: string) => groupsOf.findIndex((g) => g.includes(id))
  // The winners bracket only: round 1 of the LOSER bracket is where knocked-out group-mates
  // legitimately meet, and it is not what seeding is for.
  check('no group-mates meet in the first round',
    bracket.filter((m) => m.bracket === 'W' && m.round === 1).every((m) => groupIndex(m.a!) !== groupIndex(m.b!)))
  const { matches, error } = playOut(bracket, () => (rand() < 0.5 ? 'a' : 'b'))
  check('the knockout runs to a champion', !error && knockoutChampion(matches) !== null, error ?? '')
}

// ---------------------------------------------------------------------------------------------
console.log('\nPhases (what a deadline attaches to)')
{
  const phases = (ms: TMatch[]) => Object.fromEntries(ms.map((m) => [m.key, m.phase]))
  const single8 = phases(buildKnockout(ids(8), opts({ thirdPlace: true })))
  check('single elimination, 8: round r is phase r, and the third-place match sits beside the final',
    single8['W1-0'] === 1 && single8['W2-0'] === 2 && single8['W3-0'] === 3 && single8['TP-0'] === 3, JSON.stringify(single8))

  const double8 = phases(buildKnockout(ids(8), opts({ format: 'double', grandFinalReset: true })))
  check('double elimination, 8: winners round r is phase r',
    double8['W1-0'] === 1 && double8['W2-0'] === 2 && double8['W3-0'] === 3)
  check('...the loser bracket trails it: L1=2, L2=3, L3=4, L4=5',
    double8['L1-0'] === 2 && double8['L2-0'] === 3 && double8['L3-0'] === 4 && double8['L4-0'] === 5, JSON.stringify(double8))
  check('...W2 and L1 share a stretch of the calendar (phase 2)', double8['W2-0'] === double8['L1-0'])
  check('...then the grand final, then the reset: phases 6 and 7', double8['GF1'] === 6 && double8['GF2'] === 7, `${double8['GF1']} ${double8['GF2']}`)

  const five = phases(buildKnockout(ids(5), opts()))
  check('a bye lets a later match start early: 5 entrants, 2v3 is phase 1, 1 v (4v5) is phase 2',
    five['W1-1'] === 1 && five['W2-1'] === 1 && five['W2-0'] === 2 && five['W3-0'] === 3, JSON.stringify(five))

  let ok = true
  const notes: string[] = []
  for (const format of ['single', 'double'] as const) {
    for (let n = 2; n <= 40; n++) {
      const ms = buildKnockout(ids(n), opts({ format, grandFinalReset: format === 'double', thirdPlace: format === 'single' && n >= 4 }))
      const byKey = new Map(ms.map((m) => [m.key, m]))
      for (const m of ms) {
        for (const p of [m.winnerTo, m.loserTo]) {
          if (p && byKey.get(p.key)!.phase <= m.phase) {
            ok = false
            notes.push(`${format} n=${n}: ${m.key} (phase ${m.phase}) feeds ${p.key} (phase ${byKey.get(p.key)!.phase})`)
          }
        }
      }
      const seen = new Set(ms.map((m) => m.phase))
      const max = Math.max(...seen)
      for (let p = 1; p <= max; p++) if (!seen.has(p)) { ok = false; notes.push(`${format} n=${n}: no phase ${p}`) }
    }
  }
  check('n=2..40, single and double: a match is always later than everything that feeds it, and no phase is empty', ok, notes.slice(0, 3).join('; '))

  const swissRound = pairSwissRound(ids(6), [], 3, 1)
  check('Swiss and group matches keep their round as their phase',
    swissRound.every((m) => m.phase === 3) && buildGroupStage(assignGroups(ids(6), 2), 1, 1).every((m) => m.phase === m.round))
  check('assignPhases leaves non-knockout matches alone', assignPhases(swissRound).every((m, i) => m.phase === swissRound[i].phase))
}

// ---------------------------------------------------------------------------------------------
console.log('\nSchedule')
{
  const schedule = { startsAt: '2026-10-01T00:00:00.000Z', roundDays: 7, stageGapDays: 2, overrides: {} as Record<string, number> }
  const ctx = { qualifierStage: 'swiss' as const, qualifierRounds: 4 }
  const w = (stage: 'swiss' | 'knockout', phase: number, s = schedule) => windowFor(s, ctx, stage, phase)

  check('round 1 opens on the start date and is due a week later',
    w('swiss', 1).opensAt === '2026-10-01T00:00:00.000Z' && w('swiss', 1).dueAt === '2026-10-08T00:00:00.000Z')
  check('rounds are laid end to end', w('swiss', 2).opensAt === w('swiss', 1).dueAt && w('swiss', 4).dueAt === '2026-10-29T00:00:00.000Z')
  check('the knockout starts after the qualifier plus the gap', w('knockout', 1).opensAt === '2026-10-31T00:00:00.000Z', w('knockout', 1).opensAt)
  check('...and its rounds follow on', w('knockout', 2).opensAt === w('knockout', 1).dueAt)

  const longer = { ...schedule, overrides: { 'swiss:2': 14 } }
  check('giving round 2 another week moves every later round by a week',
    w('swiss', 2, longer).dueAt === '2026-10-22T00:00:00.000Z' && w('swiss', 3, longer).opensAt === '2026-10-22T00:00:00.000Z' &&
      w('knockout', 1, longer).opensAt === '2026-11-07T00:00:00.000Z')
  check('...but leaves earlier rounds alone', w('swiss', 1, longer).dueAt === w('swiss', 1).dueAt)

  const ko = buildKnockout(ids(8), opts({ format: 'double', grandFinalReset: true }))
  const stamped = applySchedule(ko, schedule, { qualifierStage: null, qualifierRounds: 0 })
  check('with no qualifier the knockout starts on the start date', stamped.find((m) => m.key === 'W1-0')!.opensAt === schedule.startsAt)
  const w2 = stamped.find((m) => m.key === 'W2-0')!
  const l1 = stamped.find((m) => m.key === 'L1-0')!
  check('matches in the same phase share one window, even across brackets', w2.opensAt === l1.opensAt && w2.dueAt === l1.dueAt)
  check('every match has a window, and each closes after it opens',
    stamped.every((m) => m.opensAt && m.dueAt && Date.parse(m.dueAt) > Date.parse(m.opensAt)))

  check('a good schedule has no errors', validateSchedule(schedule).length === 0)
  check('no start date is an error', validateSchedule({ ...schedule, startsAt: 'soon' }).length > 0)
  check('a round open for zero days is an error', validateSchedule({ ...schedule, roundDays: 0 }).length > 0)
  check('a negative gap is an error', validateSchedule({ ...schedule, stageGapDays: -1 }).length > 0)
  check('a nonsense override key is an error', validateSchedule({ ...schedule, overrides: { 'week:2': 3 } }).length > 0)
  check('a zero-day override is an error', validateSchedule({ ...schedule, overrides: { 'swiss:2': 0 } }).length > 0)

  const format16 = suggestFormat(16).format
  const shape = scheduleShape(format16, 16)
  check('the shape of 16 entrants: 4 Swiss rounds then a 3-round bracket', shape.ctx.qualifierRounds === 4 && shape.knockoutPhases === 3, JSON.stringify(shape))
  const fit = suggestSchedule(format16, 16, schedule.startsAt)
  check('a suggested schedule fits 16 entrants into a month', fit.days <= 28 && fit.rounds === 7 && fit.schedule.roundDays === 3, JSON.stringify(fit))
  check('...and ends when it says it does',
    scheduleEnd(fit.schedule, shape.ctx, shape.knockoutPhases) === new Date(Date.parse(schedule.startsAt) + fit.days * 86_400_000).toISOString())

  let allValid = true
  const bad: string[] = []
  for (let n = 2; n <= 200; n++) {
    const f = suggestFormat(n).format
    const s = suggestSchedule(f, n, schedule.startsAt)
    const errs = validateSchedule(s.schedule)
    const actual = scheduleShape(f, n)
    if (errs.length || s.rounds !== actual.ctx.qualifierRounds + actual.knockoutPhases || s.rounds < 1) {
      allValid = false
      bad.push(`n=${n}: ${errs.join('/')} rounds=${s.rounds}`)
    }
    if (s.rounds * 2 + 2 <= 28 && s.days > 28) {
      allValid = false
      bad.push(`n=${n}: ${s.days} days though ${s.rounds} rounds fit in a month`)
    }
  }
  check('suggested schedules are valid for every field from 2 to 200, and fit a month whenever the rounds allow', allValid, bad.slice(0, 2).join('; '))

  const groupsFormat = { qualifier: { format: 'groups' as const, groupCount: 4, advancePerGroup: 2, legs: 1 as const, bestOf: 1 }, knockout: { ...opts(), format: 'single' as const } }
  const gShape = scheduleShape(groupsFormat, 13)
  const gActual = buildGroupStage(assignGroups(ids(13), 4), 1, 1)
  check('the shape counts the longest group\'s matchdays', gShape.ctx.qualifierRounds === Math.max(...gActual.map((m) => m.round)), `${gShape.ctx.qualifierRounds}`)

  // Overdue.
  const four = applySchedule(buildKnockout(ids(4), opts()), { ...schedule, startsAt: '2026-10-01T00:00:00.000Z' }, { qualifierStage: null, qualifierRounds: 0 })
  const afterRound1 = new Date('2026-10-09T00:00:00.000Z')
  check('after the first deadline, both unplayed semifinals are overdue', overdueMatches(four, afterRound1).map((m) => m.key).join() === 'W1-0,W1-1')
  check('the final is not overdue - it is not open yet, and its deadline is later', !isOverdue(four.find((m) => m.key === 'W2-0')!, new Date('2026-10-20T00:00:00.000Z')))
  const played = (setScore(four, 'W1-0', 1, 0) as { ok: true; value: TMatch[] }).value
  check('a played match stops being overdue', overdueMatches(played, afterRound1).map((m) => m.key).join() === 'W1-1')
  check('before the deadline nothing is overdue', overdueMatches(four, new Date('2026-10-05T00:00:00.000Z')).length === 0)
  check('a match with no deadline is never overdue', overdueMatches(buildKnockout(ids(4), opts()), new Date('2030-01-01')).length === 0)
}

// ---------------------------------------------------------------------------------------------
console.log('\nForfeits')
{
  const bo3 = buildKnockout(ids(4), opts({ bestOf: 3 }))
  const f = forfeitMatch(bo3, 'W1-0', 'a')
  check('a forfeit in a best of three is 2-0 to the other side', f.ok && f.value.find((m) => m.key === 'W1-0')!.scoreB === 2 && f.value.find((m) => m.key === 'W1-0')!.scoreA === 0)
  check('...recorded as a forfeit, and the winner advances',
    f.ok && f.value.find((m) => m.key === 'W1-0')!.resultKind === 'forfeit' && f.value.find((m) => m.key === 'W2-0')!.a === 'e4')
  check('a forfeit cannot be issued to a match that is still waiting', !forfeitMatch(bo3, 'W2-0', 'a').ok)
  check('...or one that already has a winner', f.ok && !forfeitMatch(f.value, 'W1-0', 'b').ok)
  check('an admin score is recorded as admin, a played game as played',
    (setScore(bo3, 'W1-1', 2, 0) as { ok: true; value: TMatch[] }).value.find((m) => m.key === 'W1-1')!.resultKind === 'admin' &&
      (() => { let s = bo3; for (let i = 0; i < 2; i++) s = (recordGame(s, 'W1-1', 'a') as { ok: true; value: TMatch[] }).value; return s.find((m) => m.key === 'W1-1')!.resultKind })() === 'played')
  check('reverting a forfeit clears its kind', f.ok && (revertMatch(f.value, 'W1-0') as { ok: true; value: TMatch[] }).value.find((m) => m.key === 'W1-0')!.resultKind === 'played')

  // A series in progress when a team leaves.
  const midSeries = (recordGame(bo3, 'W1-0', 'a') as { ok: true; value: TMatch[] }).value
  const settled = settleForfeits(midSeries, new Set(['e1']))
  const m = settled.ok ? settled.value.find((x) => x.key === 'W1-0')! : null
  check('a team leaving mid-series while ahead 1-0 forfeits it to their opponent, 0-2',
    !!m && m.winner === 'e4' && m.scoreA === 0 && m.scoreB === 2 && m.resultKind === 'forfeit', JSON.stringify(m))

  // Every format, every size, a team leaving at a random moment: the bracket must always finish.
  let allOk = true
  const notes: string[] = []
  let cases = 0
  for (const [format, reset] of [['single', false], ['double', false], ['double', true]] as const) {
    for (let n = 2; n <= 14; n++) {
      for (let trial = 0; trial < 8; trial++) {
        cases++
        const rand = rng(n * 100 + trial + (reset ? 50 : 0) + (format === 'double' ? 25 : 0))
        const tag = `${format}${reset ? '+reset' : ''} n=${n} trial=${trial}`
        let state = buildKnockout(ids(n), opts({ format, grandFinalReset: reset, bestOf: rand() < 0.5 ? 1 : 3 }))
        const leaver = `e${1 + Math.floor(rand() * n)}`
        const departed = new Set<string>()
        const leaveAfter = Math.floor(rand() * (n + 2))
        let played = 0
        let error: string | null = null

        for (let guard = 0; guard < 500; guard++) {
          if (played === leaveAfter && !departed.has(leaver)) {
            departed.add(leaver)
            const r = settleForfeits(state, departed)
            if (!r.ok) { error = r.error; break }
            state = r.value
          }
          const next = state.find((x) => x.status === 'ready' || x.status === 'in_progress')
          if (!next) break
          const need = winsNeeded(next.bestOf)
          const aWins = rand() < 0.5
          const r = setScore(state, next.key, aWins ? need : 0, aWins ? 0 : need)
          if (!r.ok) { error = r.error; break }
          const s = settleForfeits(r.value, departed)
          if (!s.ok) { error = s.error; break }
          state = s.value
          played++
        }
        if (!departed.has(leaver)) {
          departed.add(leaver)
          const r = settleForfeits(state, departed)
          if (r.ok) state = r.value
        }

        const champ = knockoutChampion(state)
        if (error) { allOk = false; notes.push(`${tag}: ${error}`) }
        else if (state.some((x) => x.status === 'pending' || x.status === 'ready' || x.status === 'in_progress')) {
          allOk = false
          notes.push(`${tag}: left ${state.filter((x) => ['pending', 'ready', 'in_progress'].includes(x.status)).map((x) => x.key).join(',')} open`)
        } else if (!champ) { allOk = false; notes.push(`${tag}: no champion`) }
        // The leaver can win matches they actually played before leaving, but never one by forfeit -
        // unless both sides had left, when somebody has to be handed the match.
        const wonByForfeit = state.filter((x) => x.resultKind === 'forfeit' && x.winner === leaver)
        if (wonByForfeit.length && ![...state].some((x) => x.resultKind === 'forfeit' && x.a && departed.has(x.a) && x.b && departed.has(x.b))) {
          allOk = false
          notes.push(`${tag}: ${leaver} was awarded a forfeit win after leaving`)
        }
      }
    }
  }
  check(`${cases} random events with a team leaving at a random point: every bracket finishes with a champion`, allOk, notes.slice(0, 3).join('; '))

  // A team leaving before anything is played drops out of the whole event.
  const de8 = buildKnockout(ids(8), opts({ format: 'double', grandFinalReset: true }))
  const gone = settleForfeits(de8, new Set(['e1']))
  check('a team removed before play started never wins a match', gone.ok && !gone.value.some((x) => x.winner === 'e1'))
  check('...and has no open matches left', gone.ok && !gone.value.some((x) => (x.status === 'ready' || x.status === 'in_progress') && (x.a === 'e1' || x.b === 'e1')))
  const rest = gone.ok ? playOut(gone.value, () => 'a') : null
  check('...and the rest of the bracket plays out to a champion who is not them', !!rest && !rest.error && knockoutChampion(rest.matches) !== null && knockoutChampion(rest.matches) !== 'e1')

  // Both sides gone.
  const two = settleForfeits(buildKnockout(ids(2), opts()), new Set(['e1', 'e2']))
  check('both teams removed still settles - the first-listed forfeits', two.ok && two.value[0].winner === 'e2' && two.value[0].resultKind === 'forfeit')
  check('nobody removed means nothing to settle', (() => { const b = buildKnockout(ids(8), opts()); const r = settleForfeits(b, new Set()); return r.ok && JSON.stringify(r.value) === JSON.stringify(b) })())

  // Swiss with a departed team.
  let swissMatches: TMatch[] = []
  const field = ids(8)
  for (let round = 1; round <= 2; round++) {
    const paired = pairSwissRound(field, swissMatches, round, 1)
    swissMatches = [...swissMatches, ...paired.map((p) => (p.isBye ? p : { ...p, scoreA: 1, winner: p.a, status: 'done' as const }))]
  }
  const round3 = pairSwissRound(field, swissMatches, 3, 1, new Set(['e3']))
  const inRound3 = round3.flatMap((p) => (p.isBye ? [p.a!] : [p.a!, p.b!]))
  check('Swiss round 3 with e3 gone: e3 is not paired, everyone else is, exactly once',
    !inRound3.includes('e3') && new Set(inRound3).size === 7 && inRound3.length === 7)
  check('...seven teams means one bye', round3.filter((p) => p.isBye).length === 1)
  check('...and the standings still count e3\'s results for the teams who played them',
    computeStandings(field, swissMatches).find((r) => r.id === 'e3') !== undefined)
}

// ---------------------------------------------------------------------------------------------
console.log('\nWhen an event is complete')
{
  const ko = (format: 'single' | 'double', reset = false) => ({ format, bestOf: 1, thirdPlace: false, grandFinalReset: reset })
  const done = (ms: TMatch[]) => ms.map((m) => (m.isBye ? m : { ...m, scoreA: 1, scoreB: 0, winner: m.a, status: 'done' as const }))

  // Knockout only.
  const knockoutOnly = { qualifier: { format: 'none' as const }, knockout: ko('single') }
  const bracket = buildKnockout(ids(4), ko('single'))
  check('a knockout is not complete before it is played', !tournamentComplete(knockoutOnly, bracket))
  const partial = (setScore(bracket, 'W1-0', 1, 0) as { ok: true; value: TMatch[] }).value
  check('...nor with only the semifinals played', !tournamentComplete(knockoutOnly, partial))
  const played = playOut(bracket, () => 'a').matches
  check('...but is once the final is decided', tournamentComplete(knockoutOnly, played))
  check('...and its champion is the final\'s winner', eventChampion(knockoutOnly, played) === knockoutChampion(played) && eventChampion(knockoutOnly, played) !== null)
  check('an event with no matches at all is not complete', !tournamentComplete(knockoutOnly, []))

  // Double elimination with a reset: only complete once the reset is either played or skipped.
  const deReset = { qualifier: { format: 'none' as const }, knockout: ko('double', true) }
  const wbTakes = playOut(buildKnockout(ids(4), ko('double', true)), (m) => (m.key === 'GF1' ? 'a' : seedNo(m.a!) < seedNo(m.b!) ? 'a' : 'b')).matches
  check('double elimination: the winners-bracket side taking the grand final skips the reset, and that completes it',
    wbTakes.find((m) => m.key === 'GF2')!.status === 'skipped' && tournamentComplete(deReset, wbTakes))
  let stage = buildKnockout(ids(4), ko('double', true))
  for (let i = 0; i < 50; i++) {
    const next = stage.find((x) => (x.status === 'ready' || x.status === 'in_progress') && x.key !== 'GF2')
    if (!next) break
    const side = next.key === 'GF1' ? 'b' : seedNo(next.a!) < seedNo(next.b!) ? 'a' : 'b'
    stage = (setScore(stage, next.key, side === 'a' ? 1 : 0, side === 'b' ? 1 : 0) as { ok: true; value: TMatch[] }).value
  }
  check('...but the loser-bracket side taking it leaves the reset open, so it is NOT complete', !tournamentComplete(deReset, stage))
  const afterReset = (setScore(stage, 'GF2', 1, 0) as { ok: true; value: TMatch[] }).value
  check('...until the reset is played', tournamentComplete(deReset, afterReset))
  const reverted = (revertMatch(afterReset, 'GF2') as { ok: true; value: TMatch[] }).value
  check('...and correcting the reset reopens it', !tournamentComplete(deReset, reverted))

  // Swiss only: every round drawn AND every match decided.
  const swissOnly = { qualifier: { format: 'swiss' as const, rounds: 3, bestOf: 1 }, knockout: null }
  let swiss: TMatch[] = []
  const field = ids(8)
  const results: boolean[] = []
  for (let round = 1; round <= 3; round++) {
    const paired = pairSwissRound(field, swiss, round, 1)
    swiss = [...swiss, ...paired]
    results.push(tournamentComplete(swissOnly, swiss)) // drawn but nothing played yet
    swiss = done(swiss)
    results.push(tournamentComplete(swissOnly, swiss)) // round played
  }
  check('Swiss: never complete before the last round - not after drawing one, and not after playing rounds 1 and 2',
    results.slice(0, 5).every((r) => !r), results.join())
  check('Swiss: complete once round 3 is drawn and played', results[5] === true)
  check('Swiss with no knockout has no champion to record', eventChampion(swissOnly, swiss) === null)

  // Groups only.
  const groupsOnly = { qualifier: { format: 'groups' as const, groupCount: 2, legs: 1 as const, bestOf: 1 }, knockout: null }
  const stageMatches = buildGroupStage(assignGroups(ids(6), 2), 1, 1)
  check('groups: not complete before they are played', !tournamentComplete(groupsOnly, stageMatches))
  check('groups: complete once every group match is decided', tournamentComplete(groupsOnly, done(stageMatches)))
  check('groups: not complete with one match left', !tournamentComplete(groupsOnly, [...done(stageMatches).slice(1), stageMatches[0]]))

  // Qualifier then knockout: the moment the qualifier ends is NOT the end of the event.
  const both = { qualifier: { format: 'swiss' as const, rounds: 3, bestOf: 1 }, knockout: { ...ko('single'), cutTo: 4 } }
  check('qualifier + knockout: qualifier finished but knockout not built yet is NOT complete', !tournamentComplete(both, swiss))
  const built = buildKnockout(ids(4), ko('single'))
  check('...nor is it complete once the knockout is built but unplayed', !tournamentComplete(both, [...swiss, ...built]))
  check('...only when the knockout is finished too', tournamentComplete(both, [...swiss, ...playOut(built, () => 'a').matches]))
  check('...whose champion is recorded', eventChampion(both, [...swiss, ...playOut(built, () => 'a').matches]) !== null)
  const finishedKnockout = playOut(built, () => 'a').matches
  const reopenedFinal = (revertMatch(finishedKnockout, 'W2-0') as { ok: true; value: TMatch[] }).value
  check('...and correcting the final reopens it', !tournamentComplete(both, [...swiss, ...reopenedFinal]))

  check('a format with nothing in it is never complete', !tournamentComplete({ qualifier: { format: 'none' }, knockout: null }, swiss))
}

// ---------------------------------------------------------------------------------------------
console.log('\nStarting an event (the plan)')
{
  const startsAt = '2026-10-01T00:00:00.000Z'
  const scheduleFor = (format: Parameters<typeof suggestSchedule>[0], n: number) => suggestSchedule(format, n, startsAt).schedule

  let allOk = true
  const notes: string[] = []
  for (let n = 2; n <= 60; n++) {
    const format = suggestFormat(n).format
    const seeded = ids(n)
    const plan = planStart(format, seeded, scheduleFor(format, n))
    if (!plan.ok) { allOk = false; notes.push(`n=${n}: ${plan.problems.join('/')}`); continue }
    const { stage, matches } = plan.plan
    const q = format.qualifier.format
    const wantStage = q === 'swiss' ? 'swiss' : q === 'groups' ? 'group' : 'knockout'
    if (stage !== wantStage) { allOk = false; notes.push(`n=${n}: stage ${stage}, wanted ${wantStage}`) }
    if (matches.some((m) => m.stage !== stage)) { allOk = false; notes.push(`n=${n}: mixed stages`) }
    if (matches.some((m) => !m.opensAt || !m.dueAt)) { allOk = false; notes.push(`n=${n}: a match has no window`) }
    const named = new Set(matches.flatMap((m) => [m.a, m.b, m.winner]).filter(Boolean) as string[])
    if ([...named].some((id) => !seeded.includes(id))) { allOk = false; notes.push(`n=${n}: names a team that is not entered`) }
    if (new Set(matches.map((m) => m.key)).size !== matches.length) { allOk = false; notes.push(`n=${n}: duplicate keys`) }
    if (stage === 'swiss') {
      const games = matches.filter((m) => !m.isBye).length
      if (games !== Math.floor(n / 2) || matches.some((m) => m.round !== 1)) { allOk = false; notes.push(`n=${n}: swiss round 1 has ${games} games`) }
    }
    if (stage === 'knockout') {
      // Single elimination is n-1 matches and double is about 2n-2 (plus a reset), so compare with the
      // format's own estimate rather than assuming one shape.
      const est = estimateMatches(format, n)
      if (matches.length < est.knockoutMin || matches.length > est.knockoutMax) {
        allOk = false
        notes.push(`n=${n}: ${matches.length} knockout matches, expected ${est.knockoutMin}-${est.knockoutMax}`)
      }
    }
  }
  check('n=2..60 with the suggested format: a valid first stage, in the right shape, every match dated and only naming entered teams',
    allOk, notes.slice(0, 3).join('; '))

  // Each kind of qualifier draws only what is fixed at the start.
  const swissFormat = { qualifier: { format: 'swiss' as const, rounds: 4, bestOf: 1 }, knockout: { ...opts(), cutTo: 4 } }
  const swissPlan = planStart(swissFormat, ids(16), scheduleFor(swissFormat, 16))
  check('Swiss: starting draws round 1 only (8 games), not the four rounds',
    swissPlan.ok && swissPlan.plan.matches.length === 8 && swissPlan.plan.matches.every((m) => m.round === 1))

  const groupsFormat = { qualifier: { format: 'groups' as const, groupCount: 4, advancePerGroup: 2, legs: 1 as const, bestOf: 1 }, knockout: opts() }
  const groupsPlan = planStart(groupsFormat, ids(16), scheduleFor(groupsFormat, 16))
  check('groups: every group match is drawn at once (4 groups of 4 = 24 games)',
    groupsPlan.ok && groupsPlan.plan.stage === 'group' && groupsPlan.plan.matches.length === 24)

  const seeded = ['zz', 'yy', 'xx', 'ww']
  const koFormat = { qualifier: { format: 'none' as const }, knockout: opts() }
  const koPlan = planStart(koFormat, seeded, scheduleFor(koFormat, 4))
  check('the seed order decides the bracket: the top seed is in the first match against the bottom seed',
    koPlan.ok && [koPlan.plan.matches.find((m) => m.key === 'W1-0')!.a, koPlan.plan.matches.find((m) => m.key === 'W1-0')!.b].sort().join() === 'ww,zz')
  const reversed = planStart(koFormat, [...seeded].reverse(), scheduleFor(koFormat, 4))
  check('...so reversing the seeds gives a different bracket', koPlan.ok && reversed.ok && JSON.stringify(koPlan.plan.matches) !== JSON.stringify(reversed.plan.matches))
  check('the same seeds and schedule always give the same plan',
    JSON.stringify(planStart(koFormat, seeded, scheduleFor(koFormat, 4))) === JSON.stringify(koPlan))

  // Refusals: nothing is drawn from a bad request.
  const cutTooBig = planStart({ qualifier: { format: 'swiss', rounds: 3, bestOf: 1 }, knockout: { ...opts(), cutTo: 40 } }, ids(8), scheduleFor(swissFormat, 8))
  check('a cut larger than the field is refused, with the reason and no matches', !cutTooBig.ok && cutTooBig.problems.some((p) => /cut/i.test(p)))
  check('one entrant is refused - there is nobody to play', !planStart(koFormat, ['solo'], scheduleFor(koFormat, 2)).ok)
  check('a team listed twice is refused', !planStart(koFormat, ['a', 'a', 'b'], scheduleFor(koFormat, 3)).ok)
  check('a schedule with no start date is refused', !planStart(koFormat, ids(4), { startsAt: 'soon', roundDays: 7, stageGapDays: 0, overrides: {} }).ok)
  check('nothing at all to run is refused', !planStart({ qualifier: { format: 'none' }, knockout: null }, ids(4), scheduleFor(koFormat, 4)).ok)

  // The rows handed to the database.
  const rows = koPlan.ok ? toMatchRows(koPlan.plan.matches) : []
  check('the database rows use the database\'s column names and carry the pointers',
    rows.length === 3 && rows.every((r) => 'entrant_a' in r && 'winner_to_key' in r && 'due_at' in r && 'idx' in r && 'grp' in r) &&
      rows.find((r) => r.key === 'W1-0')!.winner_to_key === 'W2-0')
  check('...as plain JSON (so it survives being sent over the wire unchanged)', JSON.stringify(JSON.parse(JSON.stringify(rows))) === JSON.stringify(rows))
}

// ---------------------------------------------------------------------------------------------
console.log('\nLater stages: the next Swiss round, and the knockout after a qualifier')
{
  const startsAt = '2026-10-01T00:00:00.000Z'
  const sched = (format: Parameters<typeof suggestSchedule>[0], n: number) => suggestSchedule(format, n, startsAt).schedule

  /** Plays every open match at random, then forfeits anything involving a departed team. */
  const playAll = (matches: TMatch[], departed: Set<string>, rand: () => number): TMatch[] => {
    let state = matches
    for (let guard = 0; guard < 2000; guard++) {
      const next = state.find((m) => m.status === 'ready' || m.status === 'in_progress')
      if (!next) return state
      const need = winsNeeded(next.bestOf)
      const aWins = rand() < 0.5
      const r = setScore(state, next.key, aWins ? need : 0, aWins ? 0 : need)
      if (!r.ok) throw new Error(r.error)
      const s = settleForfeits(r.value, departed)
      if (!s.ok) throw new Error(s.error)
      state = s.value
    }
    throw new Error('did not finish playing')
  }

  const formats: Array<{ label: string; n: number[]; format: (n: number) => Parameters<typeof planStart>[0] }> = [
    { label: 'Swiss 3 rounds, then a single-elimination top 4', n: [6, 8, 9, 12, 16],
      format: () => ({ qualifier: { format: 'swiss', rounds: 3, bestOf: 1 }, knockout: { ...opts(), cutTo: 4 } }) },
    { label: 'Swiss only, 4 rounds', n: [5, 8, 11],
      format: () => ({ qualifier: { format: 'swiss', rounds: 4, bestOf: 1 }, knockout: null }) },
    { label: '2 groups, top 2 each, double elimination', n: [8, 10, 12],
      format: () => ({ qualifier: { format: 'groups', groupCount: 2, advancePerGroup: 2, legs: 1, bestOf: 1 }, knockout: { ...opts({ format: 'double', grandFinalReset: true }) } }) },
    { label: '4 groups, top 2 each, single elimination', n: [12, 16],
      format: () => ({ qualifier: { format: 'groups', groupCount: 4, advancePerGroup: 2, legs: 1, bestOf: 1 }, knockout: { ...opts() } }) },
  ]

  for (const spec of formats) {
    let ok = true
    const notes: string[] = []
    let events = 0
    for (const n of spec.n) {
      for (let trial = 0; trial < 6; trial++) {
        events++
        const rand = rng(n * 131 + trial + spec.label.length)
        const format = spec.format(n)
        const seeded = ids(n)
        const schedule = sched(format, n)
        const tag = `${spec.label} n=${n} trial=${trial}`
        const departed = new Set<string>()
        // Half the events lose a team partway through.
        const leaver = trial % 2 === 1 ? seeded[Math.floor(rand() * n)] : null

        const started = planStart(format, seeded, schedule)
        if (!started.ok) { ok = false; notes.push(`${tag}: cannot start: ${started.problems.join('/')}`); continue }
        let matches = playAll(started.plan.matches, departed, rand)
        if (leaver) {
          departed.add(leaver)
          const s = settleForfeits(matches, departed)
          if (s.ok) matches = s.value
        }

        const rounds = format.qualifier.format === 'swiss' ? format.qualifier.rounds : 0
        for (let r = 2; r <= rounds; r++) {
          // Drawn before the previous round is finished, it must be refused.
          const early = planNextSwissRound(format, seeded, [...matches, ...matches.filter((m) => m.round === r - 1).map((m) => ({ ...m, status: 'ready' as const, winner: null }))], departed, schedule)
          if (early.ok) { ok = false; notes.push(`${tag}: round ${r} was drawn over an unfinished round`) }
          const next = planNextSwissRound(format, seeded, matches, departed, schedule)
          if (!next.ok) { ok = false; notes.push(`${tag}: round ${r}: ${next.problems.join('/')}`); break }
          if (next.matches.some((m) => m.round !== r)) { ok = false; notes.push(`${tag}: round ${r} has the wrong round numbers`) }
          const playersInRound = next.matches.flatMap((m) => (m.isBye ? [m.a!] : [m.a!, m.b!]))
          if (leaver && playersInRound.includes(leaver)) { ok = false; notes.push(`${tag}: the departed team ${leaver} was paired in round ${r}`) }
          matches = playAll([...matches, ...next.matches], departed, rand)
        }
        if (rounds > 0) {
          const extra = planNextSwissRound(format, seeded, matches, departed, schedule)
          if (extra.ok) { ok = false; notes.push(`${tag}: a round beyond ${rounds} was allowed`) }
        }

        if (format.qualifier.format === 'groups') {
          const recovered = groupsFromMatches(matches.filter((m) => m.stage === 'group'), seeded)
          if (recovered.length !== format.qualifier.groupCount || recovered.flat().length !== n) { ok = false; notes.push(`${tag}: groups not recovered from the matches`) }
        }

        const status = qualifierStatus(format, seeded, matches, departed)
        if (!status.complete) { ok = false; notes.push(`${tag}: qualifier not complete: ${status.waitingOn.join('/')}`); continue }

        if (format.knockout) {
          const early = planKnockout(format, seeded, matches.map((m, i) => (i === 0 ? { ...m, status: 'ready' as const, winner: null } : m)), departed, status.advancing, schedule)
          if (early.ok) { ok = false; notes.push(`${tag}: the knockout was built while a qualifier match was open`) }

          const ko = planKnockout(format, seeded, matches, departed, status.advancing, schedule)
          if (!ko.ok) { ok = false; notes.push(`${tag}: cannot build the knockout: ${ko.problems.join('/')}`); continue }
          const want = effectiveCut(format, n)
          const entered = new Set(ko.matches.flatMap((m) => [m.a, m.b]).filter(Boolean) as string[])
          if (entered.size !== status.advancing.length || status.advancing.length > want) { ok = false; notes.push(`${tag}: ${entered.size} in the knockout, ${status.advancing.length} advancing, cut ${want}`) }
          if (leaver && entered.has(leaver)) { ok = false; notes.push(`${tag}: the departed team ${leaver} reached the knockout`) }
          const again = planKnockout(format, seeded, [...matches, ...ko.matches], departed, status.advancing, schedule)
          if (again.ok) { ok = false; notes.push(`${tag}: the knockout could be built twice`) }
          matches = playAll([...matches, ...ko.matches], departed, rand)
        }

        if (!tournamentComplete(format, matches)) { ok = false; notes.push(`${tag}: not complete at the end`) }
        if (format.knockout && !eventChampion(format, matches)) { ok = false; notes.push(`${tag}: no champion`) }
        if (leaver && eventChampion(format, matches) === leaver) { ok = false; notes.push(`${tag}: the departed team ${leaver} won`) }
      }
    }
    check(`${spec.label}: ${events} whole events (half losing a team) run start to finish through the planners, refusing at the wrong moment`,
      ok, notes.slice(0, 3).join('; '))
  }

  // What is stored is what the engine drew: rows in, rows out, for every kind of match.
  let roundTrips = true
  // Compared by value, not by JSON text: property ORDER is not part of what a match is.
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v
  const kinds = [
    buildKnockout(ids(11), opts({ format: 'double', grandFinalReset: true, bestOf: 3 })),
    buildKnockout(ids(8), opts({ thirdPlace: true })),
    pairSwissRound(ids(7), [], 1, 3),
    buildGroupStage(assignGroups(ids(9), 3), 2, 1),
  ]
  for (const matches of kinds) {
    for (const m of applySchedule(matches, { startsAt, roundDays: 5, stageGapDays: 0, overrides: {} }, { qualifierStage: null, qualifierRounds: 0 })) {
      const back = matchFromRow(toMatchRows([m])[0])
      if (JSON.stringify(canon(back)) !== JSON.stringify(canon(m))) { roundTrips = false }
    }
  }
  check('a match survives being written as a database row and read back, for knockout, Swiss and group matches', roundTrips)

  // The tie at the cut line.
  const tieFormat = { qualifier: { format: 'swiss' as const, rounds: 1, bestOf: 1 }, knockout: { ...opts(), cutTo: 1 } }
  const tieMatches = [
    { ...pairSwissRound(ids(4), [], 1, 1)[0], scoreA: 1, winner: 'e1', status: 'done' as const },
    { ...pairSwissRound(ids(4), [], 1, 1)[1], scoreA: 1, winner: 'e2', status: 'done' as const },
  ] as TMatch[]
  const cutOne = qualifierStatus(tieFormat, ids(4), tieMatches, new Set())
  check('a tie exactly at the cut line is flagged, so an administrator looks at it', cutOne.complete && cutOne.cutTied, JSON.stringify(cutOne.advancing))
  const cutTwo = qualifierStatus({ ...tieFormat, knockout: { ...opts(), cutTo: 2 } }, ids(4), tieMatches, new Set())
  check('...and a tie that is NOT at the cut line is not', cutTwo.complete && !cutTwo.cutTied)
  check('a qualifier that has not been played is not complete, and says why',
    (() => { const s = qualifierStatus(tieFormat, ids(4), pairSwissRound(ids(4), [], 1, 1), new Set()); return !s.complete && s.waitingOn.length > 0 })())
}

// ---------------------------------------------------------------------------------------------
console.log('\nOfficial match rules')
{
  const { rulesFrom, DEFAULT_MATCH_RULES } = await import('../src/lib/tournament/matchRules.ts')
  check('an event that never set any rules plays on the room\'s own defaults', JSON.stringify(rulesFrom({})) === JSON.stringify(DEFAULT_MATCH_RULES))
  check('...and so does one holding nothing at all', JSON.stringify(rulesFrom(null)) === JSON.stringify(DEFAULT_MATCH_RULES) && JSON.stringify(rulesFrom(undefined)) === JSON.stringify(DEFAULT_MATCH_RULES))
  check('saved timers are used as they are', rulesFrom({ prep_seconds: 120, starting_seconds: 5 }).prep_seconds === 120 && rulesFrom({ prep_seconds: 120, starting_seconds: 5 }).starting_seconds === 5)
  check('one timer stated leaves the other on its default', rulesFrom({ prep_seconds: 90 }).starting_seconds === DEFAULT_MATCH_RULES.starting_seconds)
  check('a timer of the wrong type is ignored, not passed to a room', rulesFrom({ prep_seconds: 'abc', starting_seconds: null }).prep_seconds === DEFAULT_MATCH_RULES.prep_seconds)
  check('...as are zero, negative and non-finite ones', [0, -5, Infinity, NaN].every((bad) => rulesFrom({ prep_seconds: bad }).prep_seconds === DEFAULT_MATCH_RULES.prep_seconds))
  check('unknown fields are dropped', !('weather' in rulesFrom({ weather: 'rain', prep_seconds: 60 })))
  check('a board size can be fixed on its own, with no square set', rulesFrom({ board_size: 14, prep_seconds: 60 }).board_size === 14)
}

// ---------------------------------------------------------------------------------------------
console.log('\nLocal date-time fields')
{
  const { toLocalInput, fromLocalInput } = await import('../src/lib/tournament/localTime.ts')
  const iso = '2026-10-03T20:15:00.000Z'
  const local = toLocalInput(iso)
  check('a timestamp becomes a "YYYY-MM-DDTHH:mm" field value', /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local), local)
  check('...and reading the field back gives the same instant (round trip, whatever the time zone)', fromLocalInput(local) === iso, `${local} -> ${fromLocalInput(local)}`)
  const d = new Date(iso)
  check('the field shows the viewer\'s LOCAL clock, not UTC', local.endsWith(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`))
  check('empty, missing and garbage all give an empty field', toLocalInput(null) === '' && toLocalInput(undefined) === '' && toLocalInput('not a date') === '')
  check('an empty field gives no timestamp (that is how a time is cleared)', fromLocalInput('') === null)
}

// ---------------------------------------------------------------------------------------------
console.log('\nRating solo players')
{
  const { ratingFromRecord } = await import('../src/lib/tournament/ratingMath.ts')

  check('no games means no rating (unknown, not average)', ratingFromRecord(0, 0) === undefined)
  check('one win in one game is nowhere near a perfect rating', ratingFromRecord(1, 1)! < 0.7 && ratingFromRecord(1, 1)! > 0.5)
  check('forty wins in fifty outranks one win in one', ratingFromRecord(40, 50)! > ratingFromRecord(1, 1)!)
  check('the same rate with more evidence is more extreme (10-of-10 beats 2-of-2)', ratingFromRecord(10, 10)! > ratingFromRecord(2, 2)!)
  check('...and 0-of-10 is below 0-of-2', ratingFromRecord(0, 10)! < ratingFromRecord(0, 2)!)
  check('a .500 record is exactly average', ratingFromRecord(5, 10) === 0.5)
  check('every rating is strictly between 0 and 1', [[0, 1], [1, 1], [0, 100], [100, 100]].every(([w, p]) => { const r = ratingFromRecord(w, p)!; return r > 0 && r < 1 }))
}

// ---------------------------------------------------------------------------------------------
console.log('\nFormat editor defaults')
{
  let ok = true
  const notes: string[] = []
  for (let n = 2; n <= 120; n++) {
    for (const kind of ['none', 'swiss', 'groups'] as const) {
      const format = { qualifier: defaultQualifier(kind, n), knockout: defaultKnockout(n) }
      const errors = validateFormat(format, n)
      if (errors.length) { ok = false; notes.push(`n=${n} ${kind}: ${errors.join(' / ')}`) }
      const start = planStart(format, ids(n), { startsAt: '2026-10-01T00:00:00.000Z', roundDays: 4, stageGapDays: 1, overrides: {} })
      if (!start.ok) { ok = false; notes.push(`n=${n} ${kind}: cannot plan: ${start.problems.join(' / ')}`) }
    }
  }
  check('switching to any kind of qualifier, at any field size from 2 to 120, gives a format that validates AND can be started', ok, notes.slice(0, 3).join('; '))
  check('a group default keeps the most that any group can send through', (() => {
    const q = defaultQualifier('groups', 10)
    return q.format === 'groups' && (q.advancePerGroup ?? 0) <= Math.floor(10 / q.groupCount)
  })())
  check('a Swiss default cuts to a power of two, at most 8', [16, 24, 100].every((n) => { const c = defaultKnockout(n).cutTo!; return c <= 8 && (c & (c - 1)) === 0 }))
}

// ---------------------------------------------------------------------------------------------
console.log('\nWhat the front page shows')
{
  const now = new Date('2026-10-20T12:00:00.000Z')
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString()
  const ev = (over: Record<string, unknown>) => ({
    id: String(Math.random()), name: 'Event', status: 'draft', signupClosesAt: null, startsAt: null, finishedAt: null, championName: null, ...over,
  }) as Parameters<typeof frontPageBanners>[0][number]
  const kinds = (events: ReturnType<typeof ev>[]) => frontPageBanners(events, now).map((b) => `${b.kind}:${b.event.name}`).join()

  check('the champion banner runs for exactly two weeks', CHAMPION_BANNER_DAYS === 14)
  check('a draft shows nothing', frontPageBanners([ev({ status: 'draft' })], now).length === 0)
  check('a cancelled event disappears from the front page', frontPageBanners([ev({ status: 'cancelled' })], now).length === 0)
  check('...even one cancelled a moment ago', frontPageBanners([ev({ status: 'cancelled', finishedAt: at(-0.01) })], now).length === 0)
  check('no events at all: nothing on the page', frontPageBanners([], now).length === 0)

  check('signup open with no closing time offers the sign-up button', kinds([ev({ status: 'signup', name: 'A' })]) === 'signup:A')
  check('signup open with a closing time in the future offers it', kinds([ev({ status: 'signup', name: 'A', signupClosesAt: at(3) })]) === 'signup:A')
  check('signup that has closed but not been started says so, with no button',
    kinds([ev({ status: 'signup', name: 'A', signupClosesAt: at(-1) })]) === 'signup-closed:A')
  check('signup is open right up to the closing instant, and not at it',
    signupIsOpen(ev({ status: 'signup', signupClosesAt: at(0.0001) }), now) && !signupIsOpen(ev({ status: 'signup', signupClosesAt: at(0) }), now))
  check('a live event offers the bracket', kinds([ev({ status: 'live', name: 'L' })]) === 'live:L')

  check('a finished event is congratulated the next day', kinds([ev({ status: 'finished', name: 'F', finishedAt: at(-1) })]) === 'finished:F')
  check('...still on day 13', kinds([ev({ status: 'finished', name: 'F', finishedAt: at(-13.99) })]) === 'finished:F')
  check('...and gone at 14 days', frontPageBanners([ev({ status: 'finished', finishedAt: at(-14) })], now).length === 0)
  check('...and after', frontPageBanners([ev({ status: 'finished', finishedAt: at(-30) })], now).length === 0)
  check('a finished event with no finish time is not congratulated (it cannot be dated)',
    !withinChampionWindow(ev({ status: 'finished', finishedAt: null }), now))
  check('the champion\'s name travels with the banner',
    frontPageBanners([ev({ status: 'finished', finishedAt: at(-2), championName: 'The Wolves' })], now)[0].event.championName === 'The Wolves')

  // Several events at once, each its own banner, ordered by what matters most right now.
  const many = [
    ev({ status: 'finished', name: 'OldFinish', finishedAt: at(-10) }),
    ev({ status: 'signup', name: 'SignupLate', signupClosesAt: at(9) }),
    ev({ status: 'live', name: 'Live' }),
    ev({ status: 'cancelled', name: 'Cancelled' }),
    ev({ status: 'signup', name: 'SignupSoon', signupClosesAt: at(2) }),
    ev({ status: 'finished', name: 'NewFinish', finishedAt: at(-2) }),
    ev({ status: 'finished', name: 'Expired', finishedAt: at(-20) }),
    ev({ status: 'signup', name: 'Closed', signupClosesAt: at(-1) }),
    ev({ status: 'draft', name: 'Draft' }),
  ]
  check('several events at once: each visible one gets its own banner, and cancelled, draft and expired ones get none',
    frontPageBanners(many, now).length === 6, kinds(many))
  check('...live first, then open signups (closing soonest first), then closed signup, then congratulations (newest first)',
    kinds(many) === 'live:Live,signup:SignupSoon,signup:SignupLate,signup-closed:Closed,finished:NewFinish,finished:OldFinish', kinds(many))
  check('the same input in a different order gives the same page', kinds([...many].reverse()) === kinds(many))
  check('two live events are both listed', frontPageBanners([ev({ status: 'live', name: 'One' }), ev({ status: 'live', name: 'Two' })], now).length === 2)

  // The signup headline.
  check('the headline reads "Sign up for <name> now!"', signupHeadline('Autumn Cup', 'en') === 'Sign up for Autumn Cup now!')
  check('...and in French', signupHeadline('Autumn Cup', 'fr') === 'Inscrivez-vous à Autumn Cup dès maintenant !')
  check('stray spacing in the name never reaches the headline', signupHeadline('   Autumn   Cup  ', 'en') === 'Sign up for Autumn Cup now!')
  check('...nor a pasted line break or tab', signupHeadline('Autumn\n\tCup', 'en') === 'Sign up for Autumn Cup now!')
  check('displayName trims and collapses', displayName('  a \t b\n c  ') === 'a b c')
  check('the name is used exactly as the administrator wrote it - accents, punctuation, other scripts',
    signupHeadline("L'Été des Tarnis — 第二回!", 'fr') === "Inscrivez-vous à L'Été des Tarnis — 第二回! dès maintenant !")
  check('a name with markup in it comes through as plain text, unchanged (the page renders text, never HTML)',
    signupHeadline('<b>Cup</b> & "Co"', 'en') === 'Sign up for <b>Cup</b> & "Co" now!')
  check('a maximum-length name still reads as one sentence', signupHeadline('x'.repeat(80), 'en') === `Sign up for ${'x'.repeat(80)} now!`)
}

// ---------------------------------------------------------------------------------------------
console.log('\nPairing solo signups into teams')
{
  const pool = (n: number, rand: () => number, rated = true) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, rating: rated ? Math.round(rand() * 100) : undefined }))

  let allOk = true
  const notes: string[] = []
  for (const mode of ['random', 'balanced'] as const) {
    for (let teamSize = 1; teamSize <= 5; teamSize++) {
      for (let n = 0; n <= 30; n++) {
        for (const withOpen of [false, true]) {
          const rand = rng(n * 31 + teamSize * 7 + (withOpen ? 1 : 0))
          const players = pool(n, rand)
          const openTeams = withOpen ? [{ id: 'o1', needs: 1, strength: 40 }, { id: 'o2', needs: 2, strength: 10 }] : []
          const tag = `${mode} size=${teamSize} n=${n} open=${withOpen}`
          const s = suggestPairings({ players, teamSize, openTeams, mode, seed: tag })

          const placed = [...s.fills.flatMap((f) => f.playerIds), ...s.newTeams.flat(), ...s.leftover]
          if (placed.length !== n || new Set(placed).size !== n || !placed.every((id) => players.some((p) => p.id === id))) {
            allOk = false
            notes.push(`${tag}: players not placed exactly once`)
          }
          if (s.newTeams.some((t) => t.length !== teamSize)) {
            allOk = false
            notes.push(`${tag}: a new team is not full`)
          }
          if (s.leftover.length >= teamSize) {
            allOk = false
            notes.push(`${tag}: ${s.leftover.length} left over, enough for another team of ${teamSize}`)
          }
          for (const f of s.fills) {
            const needs = openTeams.find((t) => t.id === f.teamId)!.needs
            if (f.playerIds.length > needs) {
              allOk = false
              notes.push(`${tag}: ${f.teamId} given ${f.playerIds.length}, needs ${needs}`)
            }
          }
          // Short teams come first: nobody is dealt into a new team while a short team still has room.
          const room = openTeams.reduce((sum, t) => sum + t.needs, 0) - s.fills.reduce((sum, f) => sum + f.playerIds.length, 0)
          if (room > 0 && (s.newTeams.length > 0 || s.leftover.length > 0)) {
            allOk = false
            notes.push(`${tag}: a short team was left with room while others were placed`)
          }
        }
      }
    }
  }
  check('every player is placed exactly once, new teams are full, fewer than a team is left over, short teams fill first',
    allOk, notes.slice(0, 3).join('; '))

  const twelve = pool(12, rng(1))
  const one = suggestPairings({ players: twelve, teamSize: 3, mode: 'random', seed: 'x' })
  const two = suggestPairings({ players: twelve, teamSize: 3, mode: 'random', seed: 'x' })
  const three = suggestPairings({ players: twelve, teamSize: 3, mode: 'random', seed: 'y' })
  check('the same seed gives the same suggestion', JSON.stringify(one) === JSON.stringify(two))
  check('a different seed gives a different one', JSON.stringify(one) !== JSON.stringify(three))
  check('the order players arrive in does not change a random suggestion',
    JSON.stringify(suggestPairings({ players: [...twelve].reverse(), teamSize: 3, mode: 'random', seed: 'x' })) === JSON.stringify(one))

  // Balanced dealing: a snake keeps team totals within one player's range of each other.
  let balancedOk = true
  let beatsStraight = 0
  const trials = 200
  for (let trial = 0; trial < trials; trial++) {
    const rand = rng(trial + 500)
    const teamSize = 2 + (trial % 3)
    const players = pool(teamSize * (2 + (trial % 5)), rand)
    const ratingOf = (id: string) => players.find((p) => p.id === id)!.rating!
    const balanced = suggestPairings({ players, teamSize, mode: 'balanced' })
    const range = Math.max(...players.map((p) => p.rating!)) - Math.min(...players.map((p) => p.rating!))
    const spread = ratingSpread(balanced.newTeams, ratingOf)
    if (spread > range) balancedOk = false
    // A straight deal of the same players, best to worst in consecutive chunks - the thing to beat.
    const sorted = [...players].sort((x, y) => y.rating! - x.rating!).map((p) => p.id)
    const straight = Array.from({ length: balanced.newTeams.length }, (_, i) => sorted.slice(i * teamSize, (i + 1) * teamSize))
    if (spread <= ratingSpread(straight, ratingOf)) beatsStraight++
  }
  check('balanced: no two teams differ by more than one player\'s rating range', balancedOk)
  check('balanced: never worse than dealing the best players together', beatsStraight === trials, `${beatsStraight}/${trials}`)

  const seven = suggestPairings({
    players: [{ id: 'a', rating: 90 }, { id: 'b', rating: 80 }, { id: 'c', rating: 70 }, { id: 'd', rating: 60 }, { id: 'e', rating: 50 }, { id: 'f', rating: 40 }, { id: 'g', rating: 5 }],
    teamSize: 3, mode: 'balanced',
  })
  check('balanced: the lowest rated is the one left waiting', seven.leftover.join() === 'g', seven.leftover.join())
  // 90 80 70 60 50 40 dealt 1-2 / 2-1 / 1-2: team one gets a, d, e and team two gets b, c, f.
  check('balanced: the six are dealt in a snake (a,d,e / b,c,f)',
    seven.newTeams.map((t) => [...t].sort().join('')).sort().join() === 'ade,bcf', JSON.stringify(seven.newTeams))
  const sevenRating = new Map([['a', 90], ['b', 80], ['c', 70], ['d', 60], ['e', 50], ['f', 40]])
  check('...leaving the two teams 10 apart', ratingSpread(seven.newTeams, (id) => sevenRating.get(id)!) === 10)

  const fillFirst = suggestPairings({
    players: [{ id: 'a', rating: 90 }, { id: 'b', rating: 80 }, { id: 'c', rating: 10 }],
    teamSize: 2, mode: 'balanced',
    openTeams: [{ id: 'strong', needs: 1, strength: 95 }, { id: 'weak', needs: 1, strength: 20 }],
  })
  check('balanced: the weakest short team gets the best player', fillFirst.fills[0].teamId === 'weak' && fillFirst.fills[0].playerIds[0] === 'a', JSON.stringify(fillFirst.fills))

  const unrated = suggestPairings({ players: pool(9, rng(3), false), teamSize: 3, mode: 'balanced' })
  check('unrated players still deal out into full teams', unrated.newTeams.length === 3 && unrated.newTeams.every((t) => t.length === 3))
  const mixed = suggestPairings({ players: [{ id: 'a', rating: 100 }, { id: 'b' }, { id: 'c', rating: 0 }, { id: 'd' }], teamSize: 2, mode: 'balanced' })
  check('...and an unrated player is treated as average, not as the worst', mixed.newTeams.flat().length === 4 && !mixed.leftover.length)
  const solo = suggestPairings({ players: pool(5, rng(9)), teamSize: 1, mode: 'balanced' })
  check('team size 1: everybody is their own team, nobody waits', solo.newTeams.length === 5 && solo.leftover.length === 0)
  check('no players: nothing to do', JSON.stringify(suggestPairings({ players: [], teamSize: 3, mode: 'random' })) === '{"fills":[],"newTeams":[],"leftover":[]}')
  let threw = false
  try { suggestPairings({ players: [], teamSize: 0, mode: 'random' }) } catch { threw = true }
  check('a team size below 1 is refused', threw)

  // A pair (2 of 3, partner still deciding) needs ONE solo - the caller counts the pending invitation.
  const pairFill = suggestPairings({
    players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    teamSize: 3, mode: 'random',
    openTeams: [{ id: 'pair', needs: 1 }],
  })
  check('a pair is completed with exactly one solo, and the other two are left for a team of their own (none - too few)',
    pairFill.fills.length === 1 && pairFill.fills[0].playerIds.length === 1 && pairFill.leftover.length === 2, JSON.stringify(pairFill))
}

{
  console.log('\nOfficial match rules (what an event fixes for its rooms)')
  const { rulesFrom, toMatchSettings, withSquareSet, sameRules, rulesProblem, minBoardFor, DEFAULT_MATCH_RULES } = await import('../src/lib/tournament/matchRules.ts')
  const { fleetFor, BOARD_SIZES } = await import('../src/types/battleship.ts')
  // Stand-in ceilings, so this needs none of the square sets' JSON: 'big' fills 14x14, 'small' 9x9.
  const caps = { bosses: 14, big: 14, small: 9 }
  const R = DEFAULT_MATCH_RULES
  const tiny = [{ name: 'Destroyer', size: 2 }]
  const huge = Array.from({ length: 20 }, () => ({ name: 'Carrier', size: 5 })) // 100 squares: needs 15x15, which does not exist

  check('an empty object is the room defaults, everything left to the host',
    sameRules(rulesFrom({}), R) && rulesFrom(null).square_set === null && rulesFrom({}).fleet === null)
  check('a board size can be fixed on its own', rulesFrom({ board_size: 10 }).board_size === 10)
  check('a board size not on the menu is dropped', rulesFrom({ board_size: 15 }).board_size === null && rulesFrom({ board_size: '10' }).board_size === null)
  check('a fleet is read back', JSON.stringify(rulesFrom({ ship_defs: tiny }).fleet) === JSON.stringify(tiny))
  check('a malformed or empty fleet is dropped, not trusted',
    rulesFrom({ ship_defs: [] }).fleet === null && rulesFrom({ ship_defs: [{ name: 'x' }] }).fleet === null && rulesFrom({ ship_defs: 'big' }).fleet === null)

  const timersOnly = toMatchSettings({ ...R, prep_seconds: 120 }, caps)
  check('host\'s choice writes only the clock', JSON.stringify(Object.keys(timersOnly).sort()) === '["prep_seconds","starting_seconds"]', JSON.stringify(timersOnly))
  const setOnly = toMatchSettings({ ...R, square_set: 'small' }, caps)
  check('a set on its own is written alone, with the lookups linking needs',
    setOnly.square_set === 'small' && !('board_size' in setOnly) && !('ship_defs' in setOnly) && !!setOnly.set_caps && !!setOnly.default_fleets, Object.keys(setOnly).join())
  const sizeOnly = toMatchSettings({ ...R, board_size: 8 }, caps)
  check('a size on its own is written alone - no set, and no fleet forced on the host',
    sizeOnly.board_size === 8 && !('square_set' in sizeOnly) && !('ship_defs' in sizeOnly) && !!sizeOnly.default_fleets, Object.keys(sizeOnly).join())
  const fleetOnly = toMatchSettings({ ...R, fleet: tiny }, caps)
  check('a fleet on its own is written alone', JSON.stringify(fleetOnly.ship_defs) === JSON.stringify(tiny) && !('board_size' in fleetOnly) && !('square_set' in fleetOnly))
  const lookups = sizeOnly.default_fleets as Record<string, unknown>
  check('the lookups are every set\'s ceiling and the default fleet for every board size',
    JSON.stringify(sizeOnly.set_caps) === JSON.stringify(caps) &&
      BOARD_SIZES.every((n) => JSON.stringify(lookups[String(n)]) === JSON.stringify(fleetFor(n))))
  const all = { ...R, square_set: 'big', board_size: 8, fleet: tiny }
  check('the stored form reads back as the same rules', sameRules(rulesFrom(toMatchSettings(all, caps)), all))

  check('each setting on its own is always saveable',
    [{ square_set: 'small' }, { board_size: 5 }, { board_size: 14 }, { fleet: tiny }, { fleet: fleetFor(14) }].every((x) => rulesProblem({ ...R, ...x }, caps) === null))
  check('a size the fixed squares cannot fill is a problem', /9x9/.test(rulesProblem({ ...R, square_set: 'small', board_size: 12 }, caps) ?? ''))
  check('a fleet over half the fixed board is a problem', /more than half of a 7x7/.test(rulesProblem({ ...R, board_size: 7, fleet: fleetFor(14) }, caps) ?? ''))
  check('a fleet bigger than the fixed squares can ever hold is a problem',
    /fill 9x9 at most/.test(rulesProblem({ ...R, square_set: 'small', fleet: fleetFor(14) }, caps) ?? ''), String(rulesProblem({ ...R, square_set: 'small', fleet: fleetFor(14) }, caps)))
  check('a fleet too big for any board is a problem', /too big for any board/.test(rulesProblem({ ...R, fleet: huge }, caps) ?? ''))
  check('the smallest board a fleet fits is where it covers at most half', minBoardFor(tiny) === 5 && minBoardFor(fleetFor(10)) === 7 && minBoardFor(huge) === null,
    `${minBoardFor(tiny)} ${minBoardFor(fleetFor(10))} ${minBoardFor(huge)}`)

  const onBig = { ...R, square_set: 'big', board_size: 12 }
  check('moving to a smaller set pulls a fixed size down to its ceiling', withSquareSet(onBig, 'small', caps).board_size === 9)
  check('moving to a set it still fits keeps the size', withSquareSet({ ...onBig, board_size: 8 }, 'small', caps).board_size === 8)
  check('the host\'s choice of set leaves a fixed size alone', withSquareSet(onBig, null, caps).board_size === 12)
  check('...and a size left to the host stays the host\'s', withSquareSet({ ...R }, 'small', caps).board_size === null)
}

{
  console.log('\nThe rulebook says what the event set')
  const { rulebook } = await import('../src/lib/tournament/rulebook.ts')
  const { DEFAULT_MATCH_RULES } = await import('../src/lib/tournament/matchRules.ts')
  const fleet = [{ name: 'Carrier', size: 5 }, { name: 'Destroyer', size: 2 }]
  const book = (over: Record<string, unknown>, teamSize = 3, setLabel: string | null = null, lang: 'en' | 'fr' = 'en') =>
    rulebook({ eventName: 'Cup', teamSize, rules: { ...DEFAULT_MATCH_RULES, ...over }, setLabel, bossBoard: true, format: null }, lang)
  const rule = (sections: ReturnType<typeof book>, n: string) =>
    sections.flatMap((s) => s.rules).find((r) => r.n === n)!.body.filter((b): b is string => typeof b === 'string').join(' ')

  const hosts = rule(book({}), '4.1')
  check('nothing fixed: the host chooses size and fleet, and nothing claims the event set them',
    /host chooses the board size and the fleet/.test(hosts) && !/event sets/.test(hosts), hosts)
  const sizeOnly = rule(book({ board_size: 12 }), '4.1')
  check('a size fixed on its own is in the rules - with no square set', /The board is 12x12\. Each match's host chooses the fleet/.test(sizeOnly), sizeOnly)
  const fleetOnly = rule(book({ fleet }), '4.1')
  check('a fleet fixed on its own is in the rules, ship by ship, and the size is the host\'s',
    /Every fleet is 2 ships: Carrier \(5\), Destroyer \(2\)\. Each match's host chooses the board size/.test(fleetOnly), fleetOnly)
  const everything = rule(book({ board_size: 8, fleet }, 3, 'Bosses - Small crew'), '4.1')
  check('everything fixed: squares, size and fleet all named, and the lock explained',
    /played on Bosses - Small crew\./.test(everything) && /The board is 8x8, and every fleet is 2 ships/.test(everything) && /locked from then on/.test(everything), everything)
  const fr = rule(book({ board_size: 8, fleet }, 3, 'Bosses', 'fr'), '4.1')
  check('...and in French', /Le plateau fait 8x8, et chaque flotte compte 2 navires/.test(fr), fr)

  const threes = rule(book({}, 3), '2.2')
  check('a three-player event: no substitutes, and pairs are an option', /exactly 3 players; there are no substitutes/.test(threes) && /as a pair/.test(threes), threes)
  const fours = rule(book({}, 4), '2.2')
  check('other crew sizes: no substitutes, and no pairs', /exactly 4 players; there are no substitutes/.test(fours) && !/pair/.test(fours), fours)
  check('an individual event says nothing about crews or substitutes', !/substitute/.test(rule(book({}, 1), '2.2')))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
