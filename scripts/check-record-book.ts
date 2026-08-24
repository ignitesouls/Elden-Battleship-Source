/**
 * Checks the Record Book (src/lib/recordBook.ts) - the best single game in each category.
 *
 * The counting records are nearly free: they read one number off one archived row. The interesting
 * half is everything derived from `match_events`, because a shot is NOT a row - one trigger-pull
 * writes a row per opposing fleet, and a streak counted off rows instead of shots is inflated by
 * exactly the number of fleets on the board. That is the kind of wrong that renders as a plausible
 * number nobody can disprove, so it gets its own cases here.
 *
 * The rules the book promises also get pinned down: a floor under both accuracy records so neither a
 * lucky shot nor an unlucky one can hold one forever, and ties going to whoever got there first.
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

const { buildRecordBook, archivedShots, MIN_SHOTS_FOR_ACCURACY, MIN_STREAK, MIN_WIN_STREAK } =
  await import('../src/lib/recordBook.ts')
const { HONOR_ORDER } = await import('../src/lib/matchReport.ts')

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

// -- 2. the wooden spoon ---------------------------------------------------
{
  const rows = [
    part({ nickname: 'Ada', match_key: 'm1', shots: 40, hits: 1, misses: 39 }),
    part({ nickname: 'Bo', match_key: 'm1', shots: 20, hits: 9, misses: 11 }),
    part({ nickname: 'Cy', match_key: 'm2', shots: 10, hits: 8, misses: 2 }),
  ]
  const book = buildRecordBook(rows)

  check(
    'worst accuracy goes to the lowest rate, not the most misses',
    holderOf(book, 'worst-accuracy')?.nickname === 'Ada',
    `${holderOf(book, 'worst-accuracy')?.display} (${holderOf(book, 'worst-accuracy')?.detail})`
  )
  // Bo missed 11 to Cy's 2, so a book counting misses instead of rating them would rank these the
  // other way round. It is the rate that is the record.
  check(
    'and the chasers are ordered by rate too',
    find(book, 'worst-accuracy')?.chasers[0]?.nickname === 'Bo',
    find(book, 'worst-accuracy')?.chasers.map((c) => `${c.nickname} ${c.display}`).join(', ')
  )
  check(
    'the positive accuracy record is untouched by it',
    holderOf(book, 'accuracy')?.nickname === 'Cy',
    holderOf(book, 'accuracy')?.nickname ?? 'nobody'
  )
  check('and it reads last, after every achievement', book.at(-1)?.id === 'worst-accuracy', book.at(-1)?.id)
}

// -- 2b. a hitless game, which the two kinds of board treat differently -----
{
  const rows = [
    part({ nickname: 'Ada', match_key: 'm1', shots: 12, hits: 1 }),
    part({ nickname: 'Blank', match_key: 'm1', shots: MIN_SHOTS_FOR_ACCURACY, hits: 0 }),
  ]

  // Off the boss board a 0% is the record outright: those boards hold a handful of matches, so
  // there is no long run of future ones for an unbeatable record to spoil.
  const quiet = buildRecordBook(rows, [], 'objectives')
  check(
    'on a quiet board a game where nothing landed takes it outright',
    holderOf(quiet, 'worst-accuracy')?.nickname === 'Blank',
    holderOf(quiet, 'worst-accuracy')?.display
  )

  // On the boss board it is excluded, because 0% can only be equalled and a tie goes to whoever got
  // there first - the record would be dead from the day it was set, on the board people read most.
  const bosses = buildRecordBook(rows, [], 'bosses')
  check(
    'on the boss board it is skipped for the worst game that connected',
    holderOf(bosses, 'worst-accuracy')?.nickname === 'Ada',
    `${holderOf(bosses, 'worst-accuracy')?.display} (${holderOf(bosses, 'worst-accuracy')?.detail})`
  )
  check(
    'and the boss board says so in the note',
    /at least one hit/.test(find(bosses, 'worst-accuracy')?.note ?? ''),
    find(bosses, 'worst-accuracy')?.note
  )
  check(
    'while the quiet board does not claim that',
    !/at least one hit/.test(find(quiet, 'worst-accuracy')?.note ?? ''),
    find(quiet, 'worst-accuracy')?.note
  )
  // An omitted set id means the boss board, the same way it does for every other record here.
  check(
    'an unspecified board is treated as the boss board',
    holderOf(buildRecordBook(rows), 'worst-accuracy')?.nickname === 'Ada',
    holderOf(buildRecordBook(rows), 'worst-accuracy')?.nickname ?? 'nobody'
  )
  check(
    'and a boss board with only hitless games leaves it unheld',
    holderOf(buildRecordBook([part({ nickname: 'Blank', match_key: 'm1', shots: 9, hits: 0 })], [], 'bosses'), 'worst-accuracy') === null
  )

  // The floor matters more at this end: one miss and walking away is 0%, and being handed the
  // wooden spoon for a single shot is the version of this nobody finds funny.
  const unlucky = [
    part({ nickname: 'OneMiss', match_key: 'm1', shots: 1, hits: 0 }),
    part({ nickname: 'Ada', match_key: 'm2', shots: 20, hits: 4 }),
  ]
  check(
    'a single unlucky shot does not qualify',
    holderOf(buildRecordBook(unlucky, [], 'objectives'), 'worst-accuracy')?.nickname === 'Ada',
    holderOf(buildRecordBook(unlucky, [], 'objectives'), 'worst-accuracy')?.nickname ?? 'nobody'
  )
  check(
    'and with nobody over the floor it is simply unheld',
    holderOf(buildRecordBook([part({ nickname: 'OneMiss', match_key: 'm1', shots: 1, hits: 0 })], [], 'objectives'), 'worst-accuracy') === null
  )
}

// -- 2c. a withheld player is excused from ONE record, not from the book ---
{
  // The real entry in WITHHELD, so this fails loudly if that id is ever edited or the wiring is
  // dropped. Elymis's own worst boss game was 1 of 20; the numbers here just have to be extreme
  // enough to top every category outright, so nothing can pass by accident.
  const ELYMIS = 'cbe3bcf8-d1d2-4616-bd71-50f81aea57f9'
  const rows = [
    part({ nickname: 'Elymis', user_id: ELYMIS, match_key: 'm1', shots: 40, hits: 1, sunk: 9 }),
    part({ nickname: 'KC', match_key: 'm1', shots: 13, hits: 4 }),
  ]
  const book = buildRecordBook(rows, [], 'bosses')

  check(
    'the withheld player does not hold the wooden spoon',
    holderOf(book, 'worst-accuracy')?.nickname === 'KC',
    `${holderOf(book, 'worst-accuracy')?.nickname} ${holderOf(book, 'worst-accuracy')?.display}`
  )
  check(
    'nor is he listed one line down as chasing it',
    !find(book, 'worst-accuracy')?.chasers.some((c) => c.nickname === 'Elymis'),
    find(book, 'worst-accuracy')?.chasers.map((c) => c.nickname).join(', ') || 'no chasers'
  )
  // The whole point of keying WITHHELD by record: it is one record, not a ban.
  check(
    'but he still holds everything else he earned',
    holderOf(book, 'sunk')?.nickname === 'Elymis' && holderOf(book, 'shots')?.nickname === 'Elymis',
    `sunk: ${holderOf(book, 'sunk')?.nickname}, shots: ${holderOf(book, 'shots')?.nickname}`
  )
  check(
    'and an unwithheld player with the same numbers would hold it',
    holderOf(buildRecordBook([{ ...rows[0], user_id: null }, rows[1]], [], 'bosses'), 'worst-accuracy')?.nickname === 'Elymis'
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

// -- 8. the rarest honor --------------------------------------------------
{
  // Positions rather than titles, so the cases survive the list being reordered - what is under test
  // is that a title EARLIER in the walk order beats a later one, which is what makes the list an
  // ordering by difficulty at all.
  const rare = HONOR_ORDER[2]
  const common = HONOR_ORDER[HONOR_ORDER.length - 1]

  const rows = [
    part({ nickname: 'Ada', match_key: 'm1', awards: [common] }),
    part({ nickname: 'Bo', match_key: 'm2', awards: [rare] }),
    part({ nickname: 'Cy', match_key: 'm3', awards: [] }),
  ]
  const book = buildRecordBook(rows)

  check('the rarer title takes the record', holderOf(book, 'honor')?.nickname === 'Bo', holderOf(book, 'honor')?.display)
  check('and it reads as the title itself', holderOf(book, 'honor')?.display === rare, holderOf(book, 'honor')?.display)
  check(
    'the detail places it in the list',
    holderOf(book, 'honor')?.detail === `#3 of ${HONOR_ORDER.length}`,
    holderOf(book, 'honor')?.detail
  )
  check('a player who was handed nothing is not in it', !find(book, 'honor')?.chasers.some((c) => c.nickname === 'Cy'))
  check('and the commoner title is what chases', find(book, 'honor')?.chasers[0]?.nickname === 'Ada')

  // Real titles, not positions: the join is by the string the archive stored, so a renamed or retired
  // honor has to fall out rather than land somewhere in the middle of the order.
  const named = [
    part({ nickname: 'Dee', match_key: 'm4', awards: ['Powder Monkey'] }),
    part({ nickname: 'Eli', match_key: 'm5', awards: ['Admiral of the Fleet'] }),
  ]
  check(
    'Admiral of the Fleet outranks Powder Monkey',
    holderOf(buildRecordBook(named), 'honor')?.nickname === 'Eli',
    holderOf(buildRecordBook(named), 'honor')?.display
  )
  check(
    'a retired title sets no record',
    holderOf(buildRecordBook([part({ nickname: 'Ghost', match_key: 'm6', awards: ['Flying Dutchman'] })]), 'honor') === null
  )

  // One honor per player is a rule about handing them out, not a promise about a row read back later.
  const both = [part({ nickname: 'Fay', match_key: 'm7', awards: [common, rare] })]
  check('a row carrying two titles is judged on the rarer', holderOf(buildRecordBook(both), 'honor')?.display === rare)

  // Ties go to whoever got there first, exactly as they do everywhere else in the book.
  const tied = [
    part({ nickname: 'Gus', match_key: 'm8', awards: [rare], finished_at: '2026-08-02T12:00:00.000Z' }),
    part({ nickname: 'Hal', match_key: 'm9', awards: [rare], finished_at: '2026-08-01T12:00:00.000Z' }),
  ]
  check('the same title twice belongs to the earlier night', holderOf(buildRecordBook(tied), 'honor')?.nickname === 'Hal')
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

// -- win streaks -----------------------------------------------------------
// Streaks are the only records here built from a career rather than from one match, so what needs
// pinning down is the WALK: the order it reads matches in, what resets it, and the difference
// between the best run ever and the one somebody is standing in right now.
{
  /** A career's results in order, oldest first. 'w' won, 'l' lost, 'd' drawn. */
  const career = (nickname: string, results: string, from = 1) =>
    [...results].map((r, i) =>
      part({
        nickname,
        match_key: `${nickname}-m${from + i}`,
        won: r === 'w',
        draw: r === 'd',
        // Days apart, so finished_at alone fixes the order the walk must read them in.
        finished_at: `2026-08-${String(from + i).padStart(2, '0')}T12:00:00.000Z`,
      })
    )

  {
    // Ada: three in a row, then loses, then wins two. Best is 3, and she is NOT on it any more.
    const book = buildRecordBook(career('Ada', 'wwwlww'))
    check('the longest run is the best anywhere in a career', holderOf(book, 'win-streak')?.value === 3, String(holderOf(book, 'win-streak')?.value))
    check('and it reads as a run', holderOf(book, 'win-streak')?.display === '3 in a row', holderOf(book, 'win-streak')?.display)
    check('the active run is only what survived to the end', holderOf(book, 'active-win-streak')?.value === 2, String(holderOf(book, 'active-win-streak')?.value))
    check('and it reads as unfinished', holderOf(book, 'active-win-streak')?.display === '2 and counting', holderOf(book, 'active-win-streak')?.display)
  }

  {
    // A loss most recently: the run is over, so there is no active record to hold at all.
    const book = buildRecordBook(career('Bo', 'wwwl'))
    check('a defeat ends the active run outright', holderOf(book, 'active-win-streak') === null)
    check('but the history keeps it', holderOf(book, 'win-streak')?.value === 3, String(holderOf(book, 'win-streak')?.value))
  }

  {
    // A draw is every fleet going down together - a match nobody won, so it cannot sit inside a run.
    const book = buildRecordBook(career('Cy', 'wwdww'))
    check('a draw breaks a run like a loss does', holderOf(book, 'win-streak')?.value === 2, String(holderOf(book, 'win-streak')?.value))
    check('and the run after it is the active one', holderOf(book, 'active-win-streak')?.value === 2)
  }

  {
    const book = buildRecordBook(career('Dee', 'w'))
    check(`a single win is under the ${MIN_WIN_STREAK}-match floor`, holderOf(book, 'win-streak') === null)
    check('and holds no active record either', holderOf(book, 'active-win-streak') === null)
  }

  {
    // Rows arriving newest-first, which is how the archive actually hands them over. The walk must
    // sort them itself: read in the given order this career looks like one win, a loss, then wins.
    const inOrder = career('Eli', 'wwww')
    const book = buildRecordBook([...inOrder].reverse())
    check('the walk sorts by finish time rather than trusting row order', holderOf(book, 'win-streak')?.value === 4, String(holderOf(book, 'win-streak')?.value))
  }

  {
    // Two careers, so the holder/chaser split has something to split.
    const book = buildRecordBook([...career('Fay', 'wwww'), ...career('Gus', 'ww', 20)])
    check('the longer run holds it', holderOf(book, 'win-streak')?.nickname === 'Fay')
    check('and the shorter is the chaser', find(book, 'win-streak')?.chasers[0]?.nickname === 'Gus')
    check('one career fills one slot, not three', find(book, 'win-streak')?.chasers.length === 1, `${find(book, 'win-streak')?.chasers.length} chasers`)
  }

  {
    // The record links through to the match the run ended on, so a reader can go and look at it.
    const runs = career('Hal', 'www')
    const book = buildRecordBook(runs)
    check('the record points at the match the run ended on', holderOf(book, 'win-streak')?.matchKey === runs[2].match_key, holderOf(book, 'win-streak')?.matchKey)
  }
}

console.log(failures === 0 ? '\nall record book checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
