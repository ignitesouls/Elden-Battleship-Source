/**
 * Checks the caster desk's talking points (src/lib/talkingPoints.ts), and the world records the
 * battle-ratings function stores for them (squareRecords in src/lib/battleRatingBoards.ts).
 *
 * The thing that can go wrong quietly here is a point that is confidently false on air: a "personal
 * best" timed off a manual click, a "world record" that only equals one, a square called slow because
 * a pause sat in the middle of it, a go-to square that is not on tonight's board. Each gets a check.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-talking-points.ts
 */
import { registerHooks } from 'node:module'
import type { ParticipantRow } from '../src/lib/careerStats.ts'
import type { MatchEventRow } from '../src/lib/almanac.ts'
import type { Attack, Player } from '../src/types/battleship.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
  // squareRecords reaches the square-set data, which Vite imports as bare .json; Node wants it said.
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) return nextLoad(url, { ...context, importAttributes: { type: 'json' } })
    return nextLoad(url, context)
  },
})

const { playerHistory, matchupPoints, livePoints, allTimeRank } = await import('../src/lib/talkingPoints.ts')
const { squareRecords } = await import('../src/lib/battleRatingBoards.ts')
const { groupIntoShots } = await import('../src/lib/attackFeed.ts')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

// -- Archive fixtures ---------------------------------------------------------------------------

/** One archived shot. `at` is seconds on the match clock. */
function ev(user: string, nickname: string, match: string, at: number, challenge: string, auto = true, team = 0): MatchEventRow {
  return {
    match_key: match,
    user_id: user,
    nickname,
    team,
    cell_index: at, // any distinct cell
    challenge_name: challenge,
    result: 'miss',
    match_seconds: at,
    board_size: 10,
    finished_at: `2026-09-${match.padStart(2, '0')}T20:00:00.000Z`,
    square_set: null,
    auto,
  }
}

function part(user: string, nickname: string, match: string, team: number, won: boolean): ParticipantRow {
  return {
    match_key: match,
    user_id: user,
    nickname,
    team,
    won,
    draw: false,
    shots: 0,
    hits: 0,
    misses: 0,
    sunk: 0,
    team_ships_lost: 0,
    awards: [],
    room_code: 'OLD',
    finished_at: `2026-09-${match.padStart(2, '0')}T20:00:00.000Z`,
    square_set: null,
  }
}

// Ada's history: three matches. Margit opens two of them; Malenia timed at 200 and 260 and 240;
// a manual Godrick that must not be timed; a 4-second duo double-fire that must not be timed.
const adaEvents: MatchEventRow[] = [
  ev('u1', 'Ada', '1', 30, 'Margit'),
  ev('u1', 'Ada', '1', 230, 'Malenia'), // 200
  ev('u1', 'Ada', '1', 400, 'Godrick', false), // manual end
  ev('u1', 'Ada', '2', 50, 'Margit'),
  ev('u1', 'Ada', '2', 310, 'Malenia'), // 260
  ev('u1', 'Ada', '2', 314, 'Tree Sentinel'), // 4s - a duo, not a fight
  ev('u1', 'Ada', '3', 20, 'Rennala'),
  ev('u1', 'Ada', '3', 260, 'Malenia'), // 240
]

// -- 1. history --------------------------------------------------------------------------------
{
  const h = playerHistory(adaEvents, 'u1')
  check('counts matches', h.matches === 3, String(h.matches))
  check('counts openers', h.openers.get('Margit') === 2 && h.openers.get('Rennala') === 1)
  check('times auto fights', JSON.stringify(h.gaps.get('Malenia')) === '[200,260,240]', JSON.stringify(h.gaps.get('Malenia')))
  check('a manual end is never timed', !h.gaps.has('Godrick'))
  check('a duo double-fire is never timed', !h.gaps.has('Tree Sentinel'))
  check('a manual square still counts as taken', h.takes.get('Godrick') === 1)
}

// -- 2. world records ----------------------------------------------------------------------------
{
  const bo = [ev('u2', 'Bo', '4', 10, 'Margit'), ev('u2', 'Bo', '4', 200, 'Malenia'), ev('u2', 'Bo', '4', 420, 'Malenia')] // 190, 220
  const recs = squareRecords([...adaEvents, ...bo], 'bosses')
  const malenia = recs['Malenia']?.holders ?? []
  check('the record is the fastest fight', malenia[0]?.nickname === 'Bo' && malenia[0]?.seconds === 190, JSON.stringify(malenia[0]))
  check('each player holds one place per square', malenia.filter((r) => r.key === 'u2').length === 1, malenia.map((r) => r.nickname).join(','))
  check('the runner-up is the next player', malenia[1]?.nickname === 'Ada' && malenia[1]?.seconds === 200)
  // 190, 200, 220, 240, 260: every fight counts for "all time", Bo's two included.
  check('the fastest list counts every fight', JSON.stringify(recs['Malenia']?.top) === '[190,200,220,240,260]', JSON.stringify(recs['Malenia']?.top))
  check('the global average is the middle fight', recs['Malenia']?.median === 220 && recs['Malenia']?.fights === 5)
  check('untimed squares have no record', !('Godrick' in recs))
}

// -- 2b. all-time rank ---------------------------------------------------------------------------
{
  const board = { holders: [], top: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190], median: 300, fights: 40 }
  check('the fastest ever ranks 1st', allTimeRank(board, 90) === 1)
  check('a tie shares the place', allTimeRank(board, 120) === 3)
  check('outside the kept ten is no rank', allTimeRank(board, 195) === null)
  check('a short history ranks everything', allTimeRank({ ...board, top: [100, 200], fights: 2 }, 250) === 3)
}

// -- 3. before the match -------------------------------------------------------------------------
const roster = [
  { playerId: 'p1', key: 'u1', nickname: 'Ada', team: 0 },
  { playerId: 'p2', key: 'u2', nickname: 'Bo', team: 1 },
]
const parts = [
  part('u1', 'Ada', '1', 0, true), part('u2', 'Bo', '1', 1, false),
  part('u1', 'Ada', '2', 0, false), part('u2', 'Bo', '2', 1, true),
  part('u1', 'Ada', '3', 1, true), part('u2', 'Bo', '3', 0, false),
]
const histories = new Map([
  ['u1', playerHistory(adaEvents, 'u1')],
  ['u2', playerHistory([], 'u2')],
])
const holder = (seconds: number, matchKey: string) => ({ key: 'u1', nickname: 'Ada', seconds, matchKey, finishedAt: '' })
const records = {
  Malenia: { holders: [holder(200, '1')], top: [200, 240, 260, 300, 330], median: 260, fights: 5 },
  Rennala: { holders: [holder(90, '3')], top: [90], median: 90, fights: 1 },
  // Bo's square: never fought by Ada, timed by the field at a 5:00 median.
  Mohg: { holders: [{ key: 'u9', nickname: 'Cy', seconds: 150, matchKey: '9', finishedAt: '' }], top: [150, 200, 250, 300, 310, 320], median: 300, fights: 30 },
}
const label = (t: number) => (t === 0 ? 'Green Fleet' : 'Purple Fleet')
{
  const pts = matchupPoints(roster, parts, histories, records, new Set(['Margit', 'Malenia', 'Godrick']), label)
  const text = (id: string) => pts.find((p) => p.id === id)?.text ?? ''
  check('head-to-head record', text('h2h:u1:u2') === 'Ada is 2-1 against Bo', text('h2h:u1:u2'))
  check('the pair is said once', pts.filter((p) => p.id.startsWith('h2h:')).length === 1)
  check('the crews have met three times', text('crews:0:1').includes('met 3 times'), text('crews:0:1'))
  check('the opener notes whether it is on tonight', text('opener:u1').includes("and it's on the board"), text('opener:u1'))
  const goTo = text('goto:u1')
  check('go-to squares are only ones on the board', goTo.includes('Margit') && goTo.includes('Malenia') && !goTo.includes('Rennala'), goTo)
  check('a world record off the board is not mentioned', text('wr-held:u1') === 'Ada holds the world record on Malenia (3:20)', text('wr-held:u1'))
  // Which box a card goes over: a captain's points are theirs, a crew-wide one is nobody's.
  const owner = (id: string) => pts.find((p) => p.id === id)?.playerId
  check("a captain's points go over their box", owner('goto:u1') === 'p1' && owner('career:u2') === 'p2', `${owner('goto:u1')} ${owner('career:u2')}`)
  check('a head-to-head goes over the first named', owner('h2h:u1:u2') === 'p1')
  check('a crew-wide point has no box', owner('crews:0:1') === undefined)
}

// -- 4. live -------------------------------------------------------------------------------------
const players: Player[] = [
  { id: 'p1', room_id: 'r', user_id: 'u1', nickname: 'Ada', team: 0, is_host: true, joined_at: '' },
  { id: 'p2', room_id: 'r', user_id: 'u2', nickname: 'Bo', team: 1, is_host: false, joined_at: '' },
]
const start = Date.parse('2026-10-23T20:00:00.000Z')
let seq = 0
function fire(player: number, cell: number, atSeconds: number, auto = true): Attack {
  const p = players[player]
  const at = new Date(start + atSeconds * 1000).toISOString()
  return {
    id: `a${seq++}`,
    room_id: 'r',
    cell_index: cell,
    attacker_team: p.team!,
    defender_team: p.team === 0 ? 1 : 0,
    attacker_player_id: p.id,
    result: 'miss',
    sunk_ship_name: null,
    sunk_ship_size: null,
    sunk_start_row: null,
    sunk_start_col: null,
    sunk_horizontal: null,
    created_at: at,
    resolved_at: at,
    auto,
  }
}
// Cell -> square on tonight's board.
const board = ['Margit', 'Malenia', 'Godrick', 'Rykard', 'Mohg', 'Radahn']
const squareAt = (cell: number) => board[cell] ?? null
const live = (attacks: Attack[], pause?: Parameters<typeof livePoints>[5]) =>
  livePoints(roster, groupIntoShots(attacks, players), squareAt, histories, records, pause)
{
  const opener = live([fire(0, 0, 40)])
  check('the usual opener is called', opener.some((p) => p.id.endsWith(':opener') && p.text.includes('the usual opener')), opener.map((p) => p.text).join(' | '))

  const wr = live([fire(0, 0, 40), fire(0, 1, 230)]) // Malenia in 190: under Ada's own 200 record
  check('beating a world record is called', wr.some((p) => p.id.endsWith(':wr') && p.big), wr.map((p) => p.text).join(' | '))
  check('and is not also called a personal best', !wr.some((p) => p.id.endsWith(':pb')))
  check('a world record is a happy barnacle', wr.find((p) => p.id.endsWith(':wr'))?.mood === 'happy')
  const card = wr.find((p) => p.id.endsWith(':wr'))
  check('a live point knows its player and its shot time', card?.playerId === 'p1' && card?.shotAt === new Date(start + 230_000).toISOString(), `${card?.playerId} ${card?.shotAt}`)

  const tie = live([fire(0, 0, 40), fire(0, 1, 240)]) // 200: equals the record
  check('equalling a record is not breaking it', !tie.some((p) => p.id.endsWith(':wr')) && tie.some((p) => p.text.includes('ties their own world record')), tie.map((p) => p.text).join(' | '))

  const manual = live([fire(0, 0, 40), fire(0, 1, 230, false)])
  check('a manual click is never timed', !manual.some((p) => /:(wr|pb|near-wr|pace)$/.test(p.id)), manual.map((p) => p.id).join(','))

  const slow = live([fire(0, 0, 40), fire(0, 1, 640)]) // 600 against a usual 240
  check('well off the usual pace is called', slow.some((p) => p.id.endsWith(':pace') && p.text.includes('slower than usual')), slow.map((p) => p.text).join(' | '))
  check('a slow square is a grim barnacle', slow.find((p) => p.id.endsWith(':pace'))?.mood === 'grim')
  check('tying your own record is smug, not angry', tie.find((p) => p.id.endsWith(':near-wr'))?.mood === 'smug')

  // The same 600 seconds, but 400 of them a pause: a 200 fight, which is no news at all against 240...
  // except it ties the record, which is the point - the pause came off.
  const paused = live([fire(0, 0, 40), fire(0, 1, 640)], {
    pause_at: null,
    resume_at: null,
    pause_log: [{ at: new Date(start + 100_000).toISOString(), until: new Date(start + 500_000).toISOString() }],
  } as never)
  check('a pause is not counted as a slow square', !paused.some((p) => p.id.endsWith(':pace')), paused.map((p) => p.text).join(' | '))

  const first = live([fire(0, 3, 40)]) // Rykard: never taken in three matches
  check('a first-ever square is called', first.some((p) => p.id.endsWith(':first')), first.map((p) => p.text).join(' | '))

  const newcomer = live([fire(1, 3, 40)]) // Bo has no history: a first is not news
  check('a newcomer is not told every square is a first', !newcomer.some((p) => p.id.endsWith(':first')))

  const order = live([fire(0, 0, 40), fire(0, 3, 300)])
  check('newest first', (order[0]?.at ?? 0) >= (order[order.length - 1]?.at ?? 0))
}

// -- 5. what the barnacle says -------------------------------------------------------------------
// The three lines the voice was written from, word for word.
{
  const line = (points: ReturnType<typeof livePoints>, kind: string) => points.find((p) => p.id.endsWith(`:${kind}`))?.line ?? ''

  const opener = line(live([fire(0, 0, 40)]), 'opener')
  check('opener line', opener === "Ada loves to open with Margit - that's the 3rd time they've done it (all time)!", opener)

  // Malenia's record is somebody else's 2:30 here, so Ada's 3:10 is a personal best and not a record.
  const others = { ...records, Malenia: { holders: [{ key: 'u9', nickname: 'Cy', seconds: 150, matchKey: '9', finishedAt: '' }], top: [150, 200, 240, 260, 300], median: 240, fights: 5 } }
  const pbPoints = livePoints(roster, groupIntoShots([fire(0, 0, 40), fire(0, 1, 230)], players), squareAt, histories, others)
  const pb = line(pbPoints, 'pb')
  check('personal best line', pb === "That's the fastest Ada has ever killed Malenia! 3:10 (2nd fastest all time)!", pb)

  // Mohg: never timed by Ada, so nothing personal to say - but 4:10 beats the field's 5:00.
  const field = line(live([fire(0, 0, 40), fire(0, 4, 290)]), 'field')
  check('global average line', field === "Ada's kill of Mohg in 4:10 - faster than the global average! (3rd fastest all time)", field)

  const every = [...live([fire(0, 0, 40), fire(0, 1, 230), fire(0, 3, 500)]), ...matchupPoints(roster, parts, histories, records, new Set(board), label)]
  check('every point has a line', every.every((p) => p.line.length > 0), every.filter((p) => !p.line).map((p) => p.id).join(','))
}

// -- 6. en français --------------------------------------------------------------------------------
// The same three lines on a French desk, with the board's French square names.
{
  const fr = { lang: 'fr' as const, square: (name: string) => (name === 'Margit' ? 'Margit, le Présage déchu' : name) }
  const liveFr = (attacks: Attack[], recs = records) => livePoints(roster, groupIntoShots(attacks, players), squareAt, histories, recs, null, fr)
  const line = (points: ReturnType<typeof livePoints>, kind: string) => points.find((p) => p.id.endsWith(`:${kind}`))?.line ?? ''

  const opener = line(liveFr([fire(0, 0, 40)]), 'opener')
  check('French opener line, French square name', opener === "Ada adore ouvrir avec Margit, le Présage déchu - c'est la 3e fois (au total) !", opener)

  const others = { ...records, Malenia: { holders: [{ key: 'u9', nickname: 'Cy', seconds: 150, matchKey: '9', finishedAt: '' }], top: [150, 200, 240, 260, 300], median: 240, fights: 5 } }
  const pb = line(liveFr([fire(0, 0, 40), fire(0, 1, 230)], others), 'pb')
  check('French personal best line', pb === "Jamais Ada n'avait vaincu Malenia aussi vite ! 3:10 (2e plus rapide de tous les temps) !", pb)

  const field = line(liveFr([fire(0, 0, 40), fire(0, 4, 290)]), 'field')
  check('French global average line', field === 'Ada vient à bout de Mohg en 4:10 - plus vite que la moyenne mondiale ! (3e plus rapide de tous les temps)', field)

  // Every French line and desk text: a space before ! and ? - the site's French typography (see "Copié !").
  const all = [
    ...liveFr([fire(0, 0, 40), fire(0, 1, 230), fire(0, 3, 500), fire(0, 1, 1200)]),
    ...matchupPoints(roster, parts, histories, records, new Set(board), label, fr),
  ]
  const tight = all.flatMap((p) => [p.text, p.line]).filter((s) => /[^\s?!][!?]/.test(s))
  check('French puts a space before ! and ?', tight.length === 0, tight.join(' | '))
  const english = all.flatMap((p) => [p.text, p.line]).filter((s) => /\b(the|against|times|matches|usual|fastest|kill)\b/.test(s))
  check('no English left in the French', english.length === 0, english.join(' | '))
}

console.log(failures === 0 ? '\nall talking-point checks passed' : `\n${failures} talking-point check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
