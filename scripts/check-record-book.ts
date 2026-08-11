/**
 * Checks the Record Book (src/lib/recordBook.ts) - the best single game in each category.
 *
 * The counting records are nearly free: they read one number off one archived row. The interesting
 * half is everything derived from `match_events`, because a shot is NOT a row - one trigger-pull
 * writes a row per opposing fleet, and a streak counted off rows instead of shots is inflated by
 * exactly the number of fleets on the board. That is the kind of wrong that renders as a plausible
 * number nobody can disprove, so it gets its own cases here.
 *
 * The rules the book promises also get pinned down: positive records only, a floor under the accuracy
 * record so one lucky shot can't hold it forever, and ties going to whoever got there first.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-record-book.ts
 */
import { registerHooks } from 'node:module'
import type { ParticipantRow } from '../src/lib/careerStats.ts'
import type { MatchEventRow } from '../src/lib/almanac.ts'

// App modules import each other without file extensions, which Vite resolves and Node does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { buildRecordBook, archivedShots, MIN_SHOTS_FOR_ACCURACY, MIN_STREAK, MIN_GAP_SECONDS } = await import(
  '../src/lib/recordBook.ts'
)

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

/** A participation row, with only the fields a record cares about spelled out. */
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
    finished_at: over.finished_at ?? '2026-08-01T12:00:00.000Z',
    square_set: over.square_set ?? null,
  }
}

/** One archived event row - i.e. one shot AGAINST ONE FLEET, which is the distinction that matters. */
function ev(
  matchKey: string,
  nickname: string,
  cell: number,
  seconds: number,
  result: string,
  defenderCount = 1,
  challenge: string | null = null
): MatchEventRow[] {
  return Array.from({ length: defenderCount }, () => ({
    match_key: matchKey,
    user_id: null,
    nickname,
    team: 0,
    cell_index: cell,
    challenge_name: challenge,
    result,
    match_seconds: seconds,
    board_size: 10,
    finished_at: '2026-08-01T12:00:00.000Z',
  }))
}

const find = (book: ReturnType<typeof buildRecordBook>, id: string) => book.find((r) => r.id === id)
const holderOf = (book: ReturnType<typeof buildRecordBook>, id: string) => find(book, id)?.holder ?? null

// -- 1. the counting records ----------------------------------------------
{
  const rows = [
    part({ nickname: 'Ada', match_key: 'm1', shots: 20, hits: 12, sunk: 3, won: true, team_ships_lost: 2 }),
    part({ nickname: 'Bo', match_key: 'm1', shots: 30, hits: 9, sunk: 1, team_ships_lost: 5 }),
    part({ nickname: 'Cy', match_key: 'm2', shots: 14, hits: 11, sunk: 2, won: true, team_ships_lost: 0 }),
  ]
  const book = buildRecordBook(rows)

  check('most hits goes to the biggest single game', holderOf(book, 'hits')?.nickname === 'Ada', holderOf(book, 'hits')?.display)
  check('most ships sunk likewise', holderOf(book, 'sunk')?.nickname === 'Ada', holderOf(book, 'sunk')?.display)
  check('most shots is its own record', holderOf(book, 'shots')?.nickname === 'Bo', holderOf(book, 'shots')?.display)
  check(
    'best accuracy is a rate, not a count',
    holderOf(book, 'accuracy')?.nickname === 'Cy',
    `${holderOf(book, 'accuracy')?.display} (${holderOf(book, 'accuracy')?.detail})`
  )
  check('the runners-up are listed as chasers', (find(book, 'hits')?.chasers.length ?? 0) === 2)
  check('and the holder is not one of them', !find(book, 'hits')?.chasers.some((c) => c.nickname === 'Ada'))
}

// -- 2. nothing negative is ever a record ---------------------------------
{
  const rows = [part({ nickname: 'Ada', match_key: 'm1', shots: 40, hits: 1, misses: 39 })]
  const book = buildRecordBook(rows)
  const ids = book.map((r) => r.id).join(',')
  check(
    'there is no record for missing',
    !/miss|worst|spoon/i.test(ids) && !book.some((r) => /miss|worst/i.test(r.label)),
    ids
  )
}

// -- 3. one lucky shot cannot own the accuracy record ---------------------
{
  const rows = [
    part({ nickname: 'Fluke', match_key: 'm1', shots: 1, hits: 1 }),
    part({ nickname: 'Ada', match_key: 'm2', shots: MIN_SHOTS_FOR_ACCURACY, hits: 6 }),
  ]
  const book = buildRecordBook(rows)
  check(
    'a one-shot 100% does not qualify',
    holderOf(book, 'accuracy')?.nickname === 'Ada',
    holderOf(book, 'accuracy')?.nickname ?? 'nobody'
  )

  const thin = buildRecordBook([part({ nickname: 'Fluke', match_key: 'm1', shots: 1, hits: 1 })])
  check('and with nobody qualifying the record is simply unheld', holderOf(thin, 'accuracy') === null)
}

// -- 4. a tie belongs to whoever did it first -----------------------------
{
  const rows = [
    part({ nickname: 'Later', match_key: 'm2', shots: 10, hits: 8, finished_at: '2026-08-05T12:00:00.000Z' }),
    part({ nickname: 'First', match_key: 'm1', shots: 10, hits: 8, finished_at: '2026-08-01T12:00:00.000Z' }),
  ]
  const book = buildRecordBook(rows)
  check('the earlier match holds the record', holderOf(book, 'hits')?.nickname === 'First', holderOf(book, 'hits')?.nickname)
  check('and the equal score is a chaser', find(book, 'hits')?.chasers[0]?.nickname === 'Later')
}

// -- 5. a shot is not a row -----------------------------------------------
{
  // Three trigger-pulls in a THREE-team room: six event rows, all hits.
  const events = [
    ...ev('m1', 'Ada', 11, 10, 'hit', 2),
    ...ev('m1', 'Ada', 12, 20, 'hit', 2),
    ...ev('m1', 'Ada', 13, 30, 'sunk', 2),
  ]
  check('rows collapse back into shots', archivedShots(events).length === 3, `${archivedShots(events).length} shots from ${events.length} rows`)

  const book = buildRecordBook([part({ nickname: 'Ada', match_key: 'm1', shots: 3, hits: 3 })], events)
  check(
    'so a streak counts shots, not fleets',
    holderOf(book, 'streak')?.value === 3,
    `${holderOf(book, 'streak')?.display}`
  )

  // One shot that missed one fleet and sank another is a HIT: it landed on somebody.
  const mixed = [
    { ...ev('m2', 'Bo', 44, 5, 'miss')[0] },
    { ...ev('m2', 'Bo', 44, 5, 'sunk')[0] },
  ]
  check('a shot that landed on any fleet is a hit', archivedShots(mixed)[0].result === 'sunk')
}

// -- 6. streaks break on a miss, and only count the best run --------------
{
  const events = [
    ...ev('m1', 'Ada', 1, 10, 'hit'),
    ...ev('m1', 'Ada', 2, 20, 'hit'),
    ...ev('m1', 'Ada', 3, 30, 'miss'),
    ...ev('m1', 'Ada', 4, 40, 'hit'),
    ...ev('m1', 'Ada', 5, 50, 'hit'),
    ...ev('m1', 'Ada', 6, 60, 'sunk'),
    ...ev('m1', 'Ada', 7, 70, 'hit'),
    ...ev('m1', 'Ada', 8, 80, 'miss'),
  ]
  const book = buildRecordBook([part({ nickname: 'Ada', match_key: 'm1', shots: 8, hits: 6 })], events)
  check('the longest run wins, not the last one', holderOf(book, 'streak')?.value === 4, holderOf(book, 'streak')?.display)

  // Out-of-order rows must not invent a streak: the archive is ordered by time, not by arrival.
  const shuffled = [...events].reverse()
  const fromShuffled = buildRecordBook([part({ nickname: 'Ada', match_key: 'm1', shots: 8, hits: 6 })], shuffled)
  check('and the order comes from match_seconds, not the row order', holderOf(fromShuffled, 'streak')?.value === 4)

  // Streaks belong to a player in a match, never across two matches or two players.
  const split = [...ev('m1', 'Ada', 1, 10, 'hit'), ...ev('m1', 'Ada', 2, 20, 'hit'), ...ev('m2', 'Ada', 3, 10, 'hit')]
  const across = buildRecordBook(
    [part({ nickname: 'Ada', match_key: 'm1' }), part({ nickname: 'Ada', match_key: 'm2' })],
    split
  )
  check('two hits in one match plus one in another is not a streak of three', holderOf(across, 'streak') === null)

  const shared = [...ev('m1', 'Ada', 1, 10, 'hit'), ...ev('m1', 'Bo', 2, 20, 'hit'), ...ev('m1', 'Ada', 3, 30, 'hit')]
  const twoPlayers = buildRecordBook([part({ nickname: 'Ada', match_key: 'm1' }), part({ nickname: 'Bo', match_key: 'm1' })], shared)
  check("one crew's hits don't extend another's run", holderOf(twoPlayers, 'streak') === null)

  check(`a run of ${MIN_STREAK - 1} is not a record`, MIN_STREAK >= 3)
}

// -- 7. the timing records are smallest-wins ------------------------------
{
  const events = [
    ...ev('m1', 'Ada', 1, 95, 'hit'),
    ...ev('m1', 'Ada', 2, 140, 'sunk'),
    ...ev('m2', 'Bo', 3, 42, 'hit'),
    ...ev('m2', 'Bo', 4, 300, 'sunk'),
    ...ev('m3', 'Cy', 5, 20, 'miss'), // a miss is not first blood
  ]
  const rows = [
    part({ nickname: 'Ada', match_key: 'm1' }),
    part({ nickname: 'Bo', match_key: 'm2' }),
    part({ nickname: 'Cy', match_key: 'm3' }),
  ]
  const book = buildRecordBook(rows, events)

  check('quickest first blood is the earliest hit', holderOf(book, 'first-blood')?.nickname === 'Bo', holderOf(book, 'first-blood')?.display)
  check('and it reads as a clock', holderOf(book, 'first-blood')?.display === '0:42', holderOf(book, 'first-blood')?.display)
  check('quickest sinking is the earliest sinking', holderOf(book, 'first-sinking')?.nickname === 'Ada', holderOf(book, 'first-sinking')?.display)
  check('a match with only misses sets no timing record', !find(book, 'first-blood')?.chasers.some((c) => c.nickname === 'Cy'))
}

// -- 8. the gap record: two squares back to back --------------------------
{
  // Ada takes four in m1 (gaps of 20, 20 and 100); Bo takes two in m2 eleven seconds apart.
  const events = [
    ...ev('m1', 'Ada', 1, 10, 'miss'),
    ...ev('m1', 'Ada', 2, 30, 'hit'),
    ...ev('m1', 'Ada', 3, 50, 'hit'),
    ...ev('m1', 'Ada', 4, 150, 'sunk'),
    ...ev('m2', 'Bo', 5, 5, 'miss'),
    ...ev('m2', 'Bo', 6, 16, 'miss'),
  ]
  const rows = [part({ nickname: 'Ada', match_key: 'm1' }), part({ nickname: 'Bo', match_key: 'm2' })]
  const book = buildRecordBook(rows, events)

  check('the quickest gap wins, not the longest', holderOf(book, 'gap')?.nickname === 'Bo', holderOf(book, 'gap')?.display)
  check('and it reads as a clock', holderOf(book, 'gap')?.display === '0:11', holderOf(book, 'gap')?.display)
  check(
    "a player's own best gap is the one that chases",
    find(book, 'gap')?.chasers[0]?.nickname === 'Ada' && find(book, 'gap')?.chasers[0]?.value === 20,
    find(book, 'gap')?.chasers[0]?.display
  )
  check('one gap per player per match, not one per pair', (find(book, 'gap')?.chasers.length ?? 0) === 1)

  // Misses count throughout: the clock is timing the fight, not what was hiding under the square.
  check('a gap between two misses still counts', holderOf(book, 'gap')?.nickname === 'Bo')

  // A lone shot has nothing to be measured from, and a gap never spans two matches or two players.
  const lone = buildRecordBook([part({ nickname: 'Ada', match_key: 'm1' })], [...ev('m1', 'Ada', 1, 30, 'hit')])
  check('one shot sets no gap', holderOf(lone, 'gap') === null)

  const split = [...ev('m1', 'Ada', 1, 100, 'hit'), ...ev('m2', 'Ada', 2, 130, 'hit')]
  const across = buildRecordBook(
    [part({ nickname: 'Ada', match_key: 'm1' }), part({ nickname: 'Ada', match_key: 'm2' })],
    split
  )
  check('a gap never spans two matches', holderOf(across, 'gap') === null)

  const shared = [...ev('m1', 'Ada', 1, 100, 'hit'), ...ev('m1', 'Bo', 2, 130, 'hit')]
  const twoPlayers = buildRecordBook(
    [part({ nickname: 'Ada', match_key: 'm1' }), part({ nickname: 'Bo', match_key: 'm1' })],
    shared
  )
  check("a crewmate's shot doesn't close somebody else's gap", holderOf(twoPlayers, 'gap') === null)

  // Two squares can finish at the same moment - a duo boss fills both at once, and a banked kill
  // fired next to the following one looks identical. Neither is a fast pair, and either would hold
  // this record forever, so the pair is skipped and the player's next-best gap stands instead.
  const duo = [
    ...ev('m1', 'Ada', 1, 60, 'hit'),
    ...ev('m1', 'Ada', 2, 61, 'hit'),
    ...ev('m1', 'Ada', 3, 90, 'hit'),
  ]
  const duoBook = buildRecordBook([part({ nickname: 'Ada', match_key: 'm1' })], duo)
  check('one fight filling two squares is not a gap', holderOf(duoBook, 'gap')?.value === 29, holderOf(duoBook, 'gap')?.display)
  check(`and the floor is ${MIN_GAP_SECONDS}s, which is inside the empty band in the archive`, MIN_GAP_SECONDS === 10)

  // A player whose only pair is too close sets no record at all rather than a suspicious one.
  const onlyDuo = buildRecordBook(
    [part({ nickname: 'Ada', match_key: 'm1' })],
    [...ev('m1', 'Ada', 1, 60, 'hit'), ...ev('m1', 'Ada', 2, 61, 'hit')]
  )
  check('and a player with nothing else sets no gap', holderOf(onlyDuo, 'gap') === null)

  // The line names both squares, which is the only place in the book that can.
  const named = [
    ...ev('m1', 'Ada', 1, 10, 'hit', 1, 'Margit'),
    ...ev('m1', 'Ada', 2, 25, 'hit', 1, 'Godrick'),
  ]
  const namedBook = buildRecordBook([part({ nickname: 'Ada', match_key: 'm1' })], named)
  check(
    'and it says which two they were',
    holderOf(namedBook, 'gap')?.detail === 'Margit then Godrick',
    holderOf(namedBook, 'gap')?.detail
  )
  check('an unnamed pair simply says nothing', holderOf(book, 'gap')?.detail === undefined)

  // Wording follows the board: the boss set kills bosses, every other set takes squares.
  check('the boss board calls them bosses', find(buildRecordBook(rows, events, 'bosses'), 'gap')?.label === 'Quickest two bosses')
  check(
    'an objectives board calls them squares',
    find(buildRecordBook(rows, events, 'objectives'), 'gap')?.label === 'Quickest two squares',
    find(buildRecordBook(rows, events, 'objectives'), 'gap')?.label
  )
  check('and a match from before sets existed is a boss board', find(book, 'gap')?.label === 'Quickest two bosses')
}

// -- 9. events from matches outside the shown set are ignored -------------
{
  // The page filters by square set before calling in, but events are fetched newest-first up to a cap
  // and can cover matches the rows don't - a streak record must never come from one of those.
  const rows = [part({ nickname: 'Ada', match_key: 'm1', shots: 3, hits: 3 })]
  const strays = [...ev('other', 'Ghost', 1, 10, 'hit'), ...ev('other', 'Ghost', 2, 20, 'hit'), ...ev('other', 'Ghost', 3, 30, 'hit')]
  const book = buildRecordBook(rows, strays)
  check('a match nobody has a row for sets no record', holderOf(book, 'streak') === null)
}

// -- 10. an empty archive is not an error ---------------------------------
{
  const book = buildRecordBook([], [])
  check('an empty book has every category and no holders', book.length > 0 && book.every((r) => r.holder === null), `${book.length} categories`)
}

console.log(failures === 0 ? '\nall record book checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
