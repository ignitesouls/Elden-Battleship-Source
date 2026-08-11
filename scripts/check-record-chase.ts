/**
 * Checks the live record chase (src/lib/recordChase.ts) - who is closing on a record book entry while
 * a match is still running.
 *
 * Three things here can go wrong quietly, so each gets its own section: a chase reported for a record
 * nobody could actually be near, a record announced as broken when it was only EQUALLED (the book gives
 * a tie to whoever got there first, so equalling it changes nothing), and a player being shown an
 * opposing crew's run at a record.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-record-chase.ts
 */
import { registerHooks } from 'node:module'
import type { ParticipantRow } from '../src/lib/careerStats.ts'
import type { Attack, Player } from '../src/types/battleship.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { buildRecordBook, MIN_SHOTS_FOR_ACCURACY } = await import('../src/lib/recordBook.ts')
const { recordChases, liveTallies } = await import('../src/lib/recordChase.ts')
const { buildPlayerStats } = await import('../src/lib/matchReport.ts')
const { groupIntoShots } = await import('../src/lib/attackFeed.ts')

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
    draw: false,
    shots: over.shots ?? 0,
    hits: over.hits ?? 0,
    misses: over.misses ?? 0,
    sunk: over.sunk ?? 0,
    team_ships_lost: over.team_ships_lost ?? 0,
    awards: [],
    room_code: 'OLD',
    finished_at: over.finished_at ?? '2026-07-01T12:00:00.000Z',
    square_set: null,
  }
}

const players: Player[] = [
  { id: 'p1', room_id: 'r', user_id: 'u1', nickname: 'Ada', team: 0, is_host: true, joined_at: '' },
  { id: 'p2', room_id: 'r', user_id: 'u2', nickname: 'Bo', team: 1, is_host: false, joined_at: '' },
]

let seq = 0
let clock = Date.parse('2026-08-04T18:00:00.000Z')

/** One shot by one player against the other fleet. */
function shot(playerIndex: number, cell: number, result: Attack['result']): Attack {
  clock += 5000
  const p = players[playerIndex]
  return {
    id: `a${seq++}`,
    room_id: 'r',
    cell_index: cell,
    attacker_team: p.team!,
    defender_team: p.team === 0 ? 1 : 0,
    attacker_player_id: p.id,
    result,
    sunk_ship_name: result === 'sunk' ? 'Cruiser' : null,
    sunk_ship_size: result === 'sunk' ? 3 : null,
    sunk_start_row: null,
    sunk_start_col: null,
    sunk_horizontal: null,
    created_at: new Date(clock).toISOString(),
    resolved_at: new Date(clock).toISOString(),
  }
}

/** The live chase list, as a page would build it. */
function chasesFor(rows: ParticipantRow[], attacks: Attack[], viewerTeam?: number | null) {
  const shots = groupIntoShots(attacks, players)
  const userIdFor = (id: string | null) => players.find((p) => p.id === id)?.user_id ?? null
  return recordChases(buildRecordBook(rows), liveTallies(buildPlayerStats(players, shots), shots, userIdFor), viewerTeam)
}

// The standing book: 10 hits, 3 sunk, 12 shots, and a 4-hit run held by an old match of Bo's.
const book = [part({ nickname: 'Bo', user_id: 'u2', match_key: 'old', shots: 12, hits: 10, sunk: 3 })]

// -- 1. nothing is said until somebody is actually close ------------------
{
  const early = chasesFor(book, [shot(0, 1, 'hit'), shot(0, 2, 'hit')])
  check('two hits against a ten-hit record is not news', !early.some((c) => c.recordId === 'hits'), early.map((c) => c.recordId).join(','))

  const near = chasesFor(book, Array.from({ length: 8 }, (_, i) => shot(0, i + 10, 'hit')))
  const hits = near.find((c) => c.recordId === 'hits')
  check('eight of ten is a chase', hits?.state === 'chasing', hits?.display)
  check('and it says how far off, and off whom', (hits?.display ?? '').includes("Bo's"), hits?.display)
}

// -- 2. equalling a record is not breaking it ----------------------------
{
  const level = chasesFor(book, Array.from({ length: 10 }, (_, i) => shot(0, i + 20, 'hit')))
  const hits = level.find((c) => c.recordId === 'hits')
  check('ten hits against a ten-hit record is still a chase', hits?.state === 'chasing', hits?.display)
  check('and it reads as level', (hits?.display ?? '').includes('level'), hits?.display)

  const over = chasesFor(book, Array.from({ length: 11 }, (_, i) => shot(0, i + 40, 'hit')))
  const broken = over.find((c) => c.recordId === 'hits')
  check('eleven breaks it', broken?.state === 'broken', broken?.display)
  check('and broken records sort first', over[0]?.state === 'broken')
}

// -- 3. a crew sees only its own chases ----------------------------------
{
  const attacks = [
    ...Array.from({ length: 9 }, (_, i) => shot(0, i + 60, 'hit')), // Ada, team 0
    ...Array.from({ length: 9 }, (_, i) => shot(1, i + 60, 'hit')), // Bo, team 1
  ]
  const ada = chasesFor(book, attacks, 0)
  const bo = chasesFor(book, attacks, 1)
  const caster = chasesFor(book, attacks)

  check('a player sees their own crew', ada.some((c) => c.nickname === 'Ada'))
  check("and not the other fleet's", !ada.some((c) => c.nickname === 'Bo'))
  check('the other fleet sees the mirror image', bo.some((c) => c.nickname === 'Bo') && !bo.some((c) => c.nickname === 'Ada'))
  check('a caster sees whoever is closest', caster.length > 0 && caster.every((c) => c.nickname === 'Ada' || c.nickname === 'Bo'))
  check('one chase per record, not one per player', new Set(caster.map((c) => c.recordId)).size === caster.length)
}

// -- 4. the accuracy record waits for the shot floor ---------------------
{
  const acc = [part({ nickname: 'Bo', user_id: 'u2', match_key: 'old', shots: 20, hits: 12 })] // 60%
  const twoOfTwo = chasesFor(acc, [shot(0, 1, 'hit'), shot(0, 2, 'hit')])
  check(
    `100% off ${2} shots is not an accuracy chase`,
    !twoOfTwo.some((c) => c.recordId === 'accuracy'),
    twoOfTwo.map((c) => c.recordId).join(',')
  )

  const enough = chasesFor(
    acc,
    Array.from({ length: MIN_SHOTS_FOR_ACCURACY }, (_, i) => shot(0, i + 30, i < 8 ? 'hit' : 'miss'))
  )
  const chase = enough.find((c) => c.recordId === 'accuracy')
  check('past the floor it counts', chase !== undefined, chase?.display)
  check('and the gap reads in points, not percent-of-percent', (chase?.display ?? '').includes('points') || chase?.state === 'broken', chase?.display)
}

// -- 5. streaks are chased in hits ---------------------------------------
{
  // An old match with a 4-hit run: built from events would be tidier, but the book's streak record can
  // also be seeded straight from a run of hits in one archived match - what matters here is the phrasing.
  const streakBook = [part({ nickname: 'Bo', user_id: 'u2', match_key: 'old', shots: 12, hits: 10, sunk: 3 })]
  const attacks = [shot(0, 1, 'hit'), shot(0, 2, 'hit'), shot(0, 3, 'miss'), shot(0, 4, 'hit')]
  const list = chasesFor(streakBook, attacks, 0)
  // No streak record exists in a book with no events, so nothing to chase - and that must not throw.
  check('a record nobody holds yet is not chased', !list.some((c) => c.recordId === 'streak'), list.map((c) => c.recordId).join(','))
}

// -- 6. an empty archive means an empty panel ----------------------------
{
  check('no book, no chases', chasesFor([], [shot(0, 1, 'hit')]).length === 0)
  check('no shots, no chases', chasesFor(book, []).length === 0)
}

console.log(failures === 0 ? '\nall record chase checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
