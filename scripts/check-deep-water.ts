/**
 * Checks what is hiding in the water (src/lib/deepWater.ts) - the white whale, Laboon, Cthulhu's
 * tentacles, the Flying Dutchman, the bottles, Alexander and Patches.
 *
 * The squares are rolled by Postgres the moment the fleets are confirmed, out of the cells no fleet
 * occupies, and they do not move. This file is about what the CLIENT does with those rows: a find
 * must stay found no matter what is fired afterwards, a thing that can be caught must only be caught
 * once, a thing that cannot be caught must be meetable by every crew, and the count of tentacles must
 * be the same for everybody.
 *
 * Two of these sections are about the bug this design exists to kill. A creature used to be placed by
 * inference - it sat on the first square nobody had fired at, and a shot that came back a miss was
 * read as proof the square was open water. It was not: a shot writes one row PER OPPONENT, so a miss
 * says nothing at all about the fleet that fired it, and tentacles turned up on squares the finding
 * crew had a ship on. See "the water is empty for EVERYBODY" below, which reads the migration.
 *
 * The visibility rule gets its own section, because it is the one part that is a decision rather than
 * a derivation: a player sees only their own crew's finds, a caster sees the lot, and Cthulhu awake
 * overrules both.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-deep-water.ts
 */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import type { Attack, AttackResult, Player, Room } from '../src/types/battleship.ts'
import type { DeepCreature, DeepHide } from '../src/lib/deepWater.ts'

// App modules import each other without file extensions, which Vite resolves and Node does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { groupIntoShots, outcomeText } = await import('../src/lib/attackFeed.ts')
const { deepWater, deepMarks, finalMarks, finalFinds, tentacleCount, hidesExtras, bottleNote, BOTTLE_NOTE_COUNT } =
  await import('../src/lib/deepWater.ts')
const { deepForArchive } = await import('../src/lib/deepArchive.ts')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

const BOARD = 10

function room(id = 'room-1', seed: string | null = '123456789', boardSize = BOARD): Room {
  return {
    id,
    code: 'TEST',
    board_size: boardSize,
    ship_defs: [],
    status: 'battle',
    winner_team: null,
    created_at: '2026-08-04T18:00:00.000Z',
    seed,
  }
}

const players: Player[] = [0, 1, 2].map((team) => ({
  id: `p${team}`,
  room_id: 'room-1',
  user_id: `u${team}`,
  nickname: ['Ada', 'Bo', 'Cy'][team],
  team,
  is_host: team === 0,
  joined_at: '2026-08-04T18:00:00.000Z',
}))

let seq = 0
let clock = Date.parse('2026-08-04T18:00:00.000Z')

/** One trigger-pull by one player: a row per defending team, all sharing a created_at. */
function fire(
  playerIndex: number,
  index: number,
  outcomes: Array<{ defender: number; result: AttackResult }>
): Attack[] {
  clock += 5000
  const at = new Date(clock).toISOString()
  return outcomes.map((o) => ({
    id: `a${seq++}`,
    room_id: 'room-1',
    cell_index: index,
    attacker_team: playerIndex,
    defender_team: o.defender,
    attacker_player_id: players[playerIndex].id,
    result: o.result,
    sunk_ship_name: null,
    sunk_ship_size: null,
    sunk_start_row: null,
    sunk_start_col: null,
    sunk_horizontal: null,
    created_at: at,
    resolved_at: o.result === 'pending' ? null : at,
  }))
}

/** A shot that misses every fleet, which is what a shot at one of these squares always is. */
const openWater = (index: number, playerIndex = 0) =>
  fire(playerIndex, index, [
    { defender: 1, result: 'miss' },
    { defender: 2, result: 'miss' },
  ])

/** A shot that connects with somebody. Never possible on a hidden square - see the guard section. */
const strike = (index: number, playerIndex = 0) =>
  fire(playerIndex, index, [
    { defender: 1, result: 'hit' },
    { defender: 2, result: 'miss' },
  ])

const pendingShot = (index: number, playerIndex = 0) =>
  fire(playerIndex, index, [
    { defender: 1, result: 'pending' },
    { defender: 2, result: 'pending' },
  ])

const hide = (cellIndex: number, creature: DeepCreature, decoy = false): DeepHide => ({
  cellIndex,
  creature,
  decoy,
})

const deep = (r: Room, attacks: Attack[], hides: DeepHide[]) =>
  deepWater(r, groupIntoShots(attacks, players), hides)

console.log('\n-- what a client makes of the rows it can read --------------------------\n')

// -- 1. nothing hidden, nothing found -------------------------------------
/**
 * The normal state of a match, and the state of a project that has not run the migration.
 *
 * Worth its own case because the failure it guards against is not "an error" - it is a client that
 * invents finds out of an empty table, which is precisely what the old inference-based version did.
 */
{
  const r = room()
  const swept = Array.from({ length: BOARD * BOARD }, (_, c) => openWater(c)).flat()
  const d = deep(r, swept, [])
  const nothing =
    !d.whale &&
    d.laboon.length === 0 &&
    d.cthulhu.tentacles.length === 0 &&
    d.dutchman.length === 0 &&
    d.bottle.length === 0 &&
    d.alexander.length === 0 &&
    d.patches.length === 0
  check('sweeping the whole board with nothing hidden finds nothing', nothing)
  check('and the board is drawn bare', deepMarks(d).size === 0)
}

// -- 2. firing at a square is what finds the thing on it -------------------
{
  const r = room()
  const hides = [hide(4, 'whale'), hide(11, 'tentacle'), hide(22, 'dutchman'), hide(33, 'bottle'), hide(44, 'alexander')]
  const log = [openWater(4), openWater(11), openWater(22), openWater(33), openWater(44)].flat()
  const d = deep(r, log, hides)

  check('the whale is found by firing at his square', d.whale?.cellIndex === 4)
  check('a tentacle is found by firing at its square', d.cthulhu.tentacles[0]?.cellIndex === 11)
  check('the Dutchman is sighted by firing at his square', d.dutchman[0]?.cellIndex === 22)
  check('a bottle is fished out by firing at its square', d.bottle[0]?.cellIndex === 33)
  check('Alexander is turned up by firing at his square', d.alexander[0]?.found.cellIndex === 44)

  // Nothing on the other 95 squares, however hard they are shot at.
  const swept = deep(r, [...log, ...Array.from({ length: BOARD * BOARD }, (_, c) => openWater(c, 1)).flat()], hides)
  check('and the rest of the board holds nothing', deepMarks(swept).size === hides.length)

  const marks = deepMarks(d)
  check('each square is drawn as what is on it', marks.get(4) === 'whale' && marks.get(22) === 'dutchman')
  check('the finder is credited', d.whale?.who === 'Ada' && d.whale?.attackerTeam === 0)
}

// -- 3. caught once, or met by everybody -----------------------------------
/**
 * The only real distinction left in the model.
 *
 * The whale, a tentacle and a bottle are taken off the board by the crew that gets there first; a
 * second fleet firing at the same square finds an empty square and is told nothing. The Dutchman,
 * Laboon, Patches and Alexander cannot be caught, so every crew gets its own encounter - which is
 * what keeps "sighted him twice" possible now that he no longer moves.
 */
{
  const r = room()
  const both = (cell: number) => [...openWater(cell, 0), ...openWater(cell, 1)]

  const caught = deep(r, both(7), [hide(7, 'whale')])
  check('the whale is caught once, by whoever got there first', caught.whale?.attackerTeam === 0)

  const bottles = deep(r, both(7), [hide(7, 'bottle')])
  check('a bottle is fished out once', bottles.bottle.length === 1)

  const tent = deep(r, both(7), [hide(7, 'tentacle')])
  check('a tentacle is pulled up once', tent.cthulhu.tentacles.length === 1)

  const sail = deep(r, both(7), [hide(7, 'dutchman')])
  check('but every crew that fires sights the Dutchman', sail.dutchman.length === 2)
  check('and they are credited separately', sail.dutchman[0].attackerTeam === 0 && sail.dutchman[1].attackerTeam === 1)

  // A crew firing at the same square twice is not two meetings. The UI prevents it; the model
  // should not depend on the UI for that.
  const twice = deep(r, [...openWater(7, 0), ...openWater(7, 0)], [hide(7, 'dutchman')])
  check('one crew firing twice still only meets him once', twice.dutchman.length === 1)

  const jars = deep(r, both(7), [hide(7, 'alexander')])
  check('and every crew that fires turns up their own jar', jars.alexander.length === 2)
  check(
    'each crew credited with their own find',
    jars.alexander[0].found.attackerTeam === 0 && jars.alexander[1].found.attackerTeam === 1
  )
}

// -- 4. the decoys ---------------------------------------------------------
/**
 * One whale square in five is Laboon, and one tentacle square in five is Patches. The roll makes that
 * choice with the position and keeps it just as secret.
 *
 * The consequence worth pinning down is the cost. Nothing moves one square further on any more: a
 * crew that finds Laboon has found the only thing that was ever on that square, and the whale is
 * simply not in this match. Patches is the same, and he does NOT bring Cthulhu closer to waking.
 */
{
  const r = room()

  const lab = deep(r, openWater(9), [hide(9, 'whale', true)])
  check('a decoy whale square is Laboon', lab.laboon[0]?.cellIndex === 9)
  check('and there is no whale to find', lab.whale === null)
  check('he is drawn as himself', deepMarks(lab).get(9) === 'laboon')

  const pat = deep(r, openWater(9), [hide(9, 'tentacle', true)])
  check('a decoy tentacle square is Patches', pat.patches[0]?.cellIndex === 9)
  check('and no tentacle is counted for him', pat.cthulhu.tentacles.length === 0)
  check('he is drawn as himself', deepMarks(pat).get(9) === 'patches')

  // Met, not caught - both of them.
  const shared = deep(r, [...openWater(9, 0), ...openWater(9, 1)], [hide(9, 'whale', true)])
  check('every crew that fires meets Laboon', shared.laboon.length === 2)
}

// -- 5. Cthulhu ------------------------------------------------------------
/**
 * How many tentacles a board hides is computed from the board size at BOTH ends - here and in the
 * migration - because the client cannot count them: the rows for the ones nobody has found are
 * invisible to it. That duplication is checked against the SQL further down.
 */
{
  check('a 10x10 hides four tentacles', tentacleCount(10) === 4)
  check('a 5x5 hides none, and nothing else either', tentacleCount(5) === 0 && !hidesExtras(5))
  check('an 8x8 is the floor where the rest starts', hidesExtras(8) && tentacleCount(8) === 3)
  check('a 12x12 is capped at six', tentacleCount(12) === 6)

  const r = room()
  const needed = tentacleCount(BOARD)
  const cells = [3, 17, 41, 68].slice(0, needed)
  const hides = cells.map((c) => hide(c, 'tentacle'))

  const partial = deep(r, cells.slice(0, needed - 1).map((c) => openWater(c)).flat(), hides)
  check('he sleeps while one arm is still out there', !partial.cthulhu.awake)
  check('and the found ones are drawn as arms', deepMarks(partial, 0).get(cells[0]) === 'tentacle')

  const all = deep(r, cells.map((c) => openWater(c)).flat(), hides)
  check('the last arm wakes him', all.cthulhu.awake && all.cthulhu.tentacles.length === needed)
  check('and every arm is redrawn as the sleeper', [...deepMarks(all)].every(([, k]) => k === 'sleeper'))

  /**
   * Waking is everyone's business; it is not a free miss.
   *
   * Every one of these squares is open water, so showing one to a crew that has never fired at it
   * would hand them "there is no hull here" for nothing - the single most valuable thing a player can
   * be told.
   */
  const byOthers = deep(r, cells.map((c) => openWater(c, 1)).flat(), hides)
  const blind = deepMarks(byOthers, 0, new Set())
  check('a crew that has fired nowhere sees no sleeper', blind.size === 0)
  const partialView = deepMarks(byOthers, 0, new Set([cells[0]]))
  check('a crew sees him only on squares it has itself fired at', partialView.size === 1 && partialView.get(cells[0]) === 'sleeper')
  check('a caster sees all of them', deepMarks(byOthers).size === needed)
}

// -- 6. Alexander ----------------------------------------------------------
/**
 * The only two-stage thing in the water: found by firing at his square, freed by a LATER miss on one
 * of the four squares orthogonally beside him, from the crew whose jar it is.
 *
 * He is MET, so every crew that reaches his square gets their own jar and their own go at the rescue.
 * That is a visibility rule rather than a flavour one, and it is the reason he is not caught: a crew
 * shown a jar somebody ELSE got out would have been told that one of the four squares beside him is
 * open water for every fleet, off a shot they never fired.
 */
{
  const r = room()
  const home = 44
  const beside = 45
  const away = 66
  const hides = [hide(home, 'alexander')]
  /** The one jar belonging to a crew, which is the only one that crew can see or move. */
  const jarOf = (d: ReturnType<typeof deep>, team: number) =>
    d.alexander.find((j) => j.found.attackerTeam === team)

  const stuck = deep(r, openWater(home), hides)
  check('he is found stuck', jarOf(stuck, 0)?.found.cellIndex === home && jarOf(stuck, 0)?.freed === null)
  check('and drawn stuck', deepMarks(stuck, 0).get(home) === 'jar')

  const loose = deep(r, [...openWater(home), ...openWater(beside)], hides)
  check('a miss beside him shakes him loose', jarOf(loose, 0)?.freed?.cellIndex === beside)
  check('his square is redrawn, not the one that freed him', deepMarks(loose, 0).get(home) === 'jarFree')
  check('the freeing square carries no mark of its own', !deepMarks(loose, 0).has(beside))

  const elsewhere = deep(r, [...openWater(home), ...openWater(away)], hides)
  check('a miss somewhere else does nothing', jarOf(elsewhere, 0)?.freed === null)

  const hitBeside = deep(r, [...openWater(home), ...strike(beside)], hides)
  check('a hit beside him is a hull, not a rescue', jarOf(hitBeside, 0)?.freed === null)

  const before = deep(r, [...openWater(beside), ...openWater(home)], hides)
  check('a miss fired BEFORE he was found does not count', jarOf(before, 0)?.freed === null)

  /**
   * Per-crew, and airtight about it.
   *
   * Every crew has a jar on the SAME square, so the thing to prove is that no crew's shot reaches
   * another crew's - not the find, not the rescue, and not what either of them is drawn as.
   */
  const rival = deep(r, [...openWater(home, 0), ...openWater(home, 1), ...openWater(beside, 1)], hides)
  check('a rescue moves only the rescuing crew\'s jar', jarOf(rival, 1)?.freed?.cellIndex === beside)
  check('  -> the other crew still has him wedged', jarOf(rival, 0)?.freed === null)
  check('  -> and is still shown him wedged', deepMarks(rival, 0).get(home) === 'jar')
  check('  -> while the rescuers see him out', deepMarks(rival, 1).get(home) === 'jarFree')

  // One square, one mark: a viewer who can see both crews' jars is shown the later state of the one
  // object rather than whichever entry happened to come last.
  check('a caster sees him out if ANYBODY got him out', deepMarks(rival).get(home) === 'jarFree')
  const neither = deep(r, [...openWater(home, 0), ...openWater(home, 1)], hides)
  check('and wedged while nobody has', deepMarks(neither).get(home) === 'jar')

  // A crew that never fired at his square has no jar at all, so a miss beside him is just a miss.
  const uninvolved = deep(r, [...openWater(home, 0), ...openWater(beside, 1)], hides)
  check('a crew that never found him cannot free him', jarOf(uninvolved, 1) === undefined)
  check('  -> and the finding crew is unaffected by their shot', jarOf(uninvolved, 0)?.freed === null)
}

// -- 7. shots still in the air ---------------------------------------------
/**
 * An unresolved shot decides nothing - and, unlike the version this replaced, it no longer stops
 * everything behind it. That old rule existed because the log had to be read strictly forwards to
 * stay stable; finds are per-square now, so a shot pending at one end of the board cannot change what
 * was found at the other.
 */
{
  const r = room()
  const hides = [hide(4, 'whale'), hide(60, 'bottle')]

  const inTheAir = deep(r, pendingShot(4), hides)
  check('a shot still in the air finds nothing', inTheAir.whale === null)

  const past = deep(r, [...pendingShot(4), ...openWater(60)], hides)
  check('and does not hold up a find on another square', past.bottle[0]?.cellIndex === 60)

  const resolved = deep(r, [...pendingShot(4), ...openWater(4, 1)], hides)
  check('the shot that resolves is the one that finds him', resolved.whale?.attackerTeam === 1)
}

// -- 8. a find stays found -------------------------------------------------
/**
 * The property the old design had to work hardest for, and the one this design gets nearly free.
 *
 * A hit on a hidden square is now impossible rather than merely unlikely - the roll excluded every
 * hull - so the guard against it is defence in depth, not a rule. It is checked because "impossible"
 * here means "impossible unless somebody re-rolls mid-match", and a find contradicted by a hit on the
 * same square is the exact bug this whole design exists to make unreachable.
 */
{
  const r = room()
  const hides = [hide(4, 'whale')]

  // Built in this order deliberately: `fire` stamps each shot as it is constructed, so the kill has
  // to be made before the sweep that follows it, not merely listed first.
  const kill = openWater(4)
  const then = Array.from({ length: BOARD * BOARD }, (_, c) => openWater(c, 1)).flat()
  const after = deep(r, [...kill, ...then], hides)
  check('a whale killed at C4 stays killed', after.whale?.cellIndex === 4 && after.whale?.attackerTeam === 0)

  const contradicted = deep(r, strike(4), hides)
  check('a hull reported on a hidden square is not a find', contradicted.whale === null)
}

// -- 9. who is told what ---------------------------------------------------
{
  const r = room()
  const hides = [hide(4, 'whale'), hide(22, 'dutchman'), hide(33, 'bottle')]
  const mixed = deep(r, [...openWater(4, 0), ...openWater(22, 1), ...openWater(33, 0)], hides)

  const ada = deepMarks(mixed, 0)
  const bo = deepMarks(mixed, 1)
  const caster = deepMarks(mixed)
  check("a crew sees its own finds", ada.get(4) === 'whale' && ada.get(33) === 'bottle')
  check("and not another crew's", !ada.has(22) && !bo.has(4))
  check('a caster sees the lot', caster.size === 3)
  check('and the recap does too, once it is over', finalMarks(mixed).size === 3)

  /**
   * A crew's view is a SUBSET of the truth, never a variation on it: same square, same creature, just
   * fewer of them. If any team ever disagreed with the caster about what sits on a square, the recap
   * printed above the boards would be contradicting the boards.
   */
  const everywhere = new Set(Array.from({ length: BOARD * BOARD }, (_, c) => c))
  let disagreements = 0
  for (const team of [0, 1, 2]) {
    for (const [cell, kind] of deepMarks(mixed, team, everywhere)) {
      if (caster.get(cell) !== kind) disagreements++
    }
  }
  check('no crew ever disagrees with the truth about a square', disagreements === 0)

  // Who pulled the trigger changes who is credited, never what was there.
  const swept = (team: number) =>
    [...deepMarks(deep(r, Array.from({ length: BOARD * BOARD }, (_, c) => openWater(c, team)).flat(), hides))]
      .map(([c, k]) => `${c}:${k}`)
      .join(',')
  check('the same water is found whichever fleet sweeps it', swept(0) === swept(1), swept(0))
}

// -- 10. the bottles -------------------------------------------------------
/**
 * Four of them, and each says its own thing: the note is seeded off the room AND the square, so one
 * bottle's message cannot be read off another's. It is settled before a ship is placed and depends on
 * nothing about any fleet, which is what makes the ones that make claims about the board safe - "Ship
 * ahead" is in the list, and so is "No ship ahead". Neither is a hint; either can be right by accident.
 */
{
  const r = room()
  const cells = [3, 17, 41, 68]
  const hides = cells.map((c) => hide(c, 'bottle'))
  const d = deep(r, cells.map((c) => openWater(c)).flat(), hides)
  check('all four can be fished out', d.bottle.length === 4)
  check('and they are listed in the order they were found', d.bottle[0].cellIndex === 3 && d.bottle[3].cellIndex === 68)

  const notes = cells.map((c) => bottleNote(r, c))
  check('each bottle carries its own note', new Set(notes).size > 1, notes.join(' | '))
  check('the same bottle always says the same thing', bottleNote(r, 3) === bottleNote(r, 3))
  check('and a different room says something else', bottleNote(room('other'), 3) !== bottleNote(r, 3))

  /**
   * Every note must be reachable. `Math.floor(roll * length)` is exactly the shape that quietly
   * strands the last entry, and a message nobody can ever get is one nobody would notice was missing.
   */
  const seen = new Set<string>()
  for (let i = 0; i < 4000; i++) seen.add(bottleNote(room(`room-${i}`), i % 144))
  check('every note in the list can actually be drawn', seen.size === BOTTLE_NOTE_COUNT, `${seen.size}/${BOTTLE_NOTE_COUNT}`)

  /**
   * And what the battle log makes of one.
   *
   * The note is quoted to the crew that fished the bottle out and to nobody else, which is not a rule
   * this line implements - it is `deepMarks` doing its job one layer down, and the log simply having
   * nothing to print for a crew that has no mark on that square. Checked from the outside anyway,
   * because "the other fleet sees a plain miss" is the property that actually matters and it is worth
   * one test that reads the way a player would describe it.
   */
  const bottleAt = 3
  const shot = groupIntoShots(openWater(bottleAt, 0), players)[0]
  const found = deep(r, openWater(bottleAt, 0), [hide(bottleAt, 'bottle')])

  const finder = outcomeText(shot, deepMarks(found, 0), r)
  check('the crew that fished it out is told what it said', finder.note === bottleNote(r, bottleAt), finder.note ?? '-')
  check('on its own line, under an outcome that still names the bottle', /BOTTLE/.test(finder.text), finder.text)

  const other = outcomeText(shot, deepMarks(found, 1), r)
  check('every other fleet reads it as a plain miss', other.text === 'miss' && other.note === undefined, `${other.text} ${other.note ?? ''}`)

  // The caster's view is the whole room, so the note is theirs too - see deepMarks.
  check('and the caster is told, holding no fleet to protect', outcomeText(shot, deepMarks(found), r).note === bottleNote(r, bottleAt))

  // Without a room there is no seed to draw the note from. The line must still read.
  check('a log with no room to reseed from still prints the find', outcomeText(shot, deepMarks(found, 0)).note === undefined)
}

console.log('\n-- what outlives the match ----------------------------------------------\n')

/**
 * The archive copy (src/lib/deepArchive.ts).
 *
 * `deep_hides` is deleted with the room about an hour after it goes quiet, so whatever is not copied
 * out at the end of the match is gone for good - which is exactly what happened to every find in
 * every match archived before this existed: the honors named the Dutchman and the recap's board had
 * nothing on it.
 *
 * Two things matter here and they pull in opposite directions. Every FIND must survive, or the
 * archive is no better than what it replaced. Nothing that was never found may be written, or the
 * record books become the one place a match's unfound squares live on.
 */
{
  const r = room()
  const whaleAt = 5
  const sailAt = 12
  const bottleAt = 40
  const jarAt = 66
  const tentacles = [21, 34, 55, 77]
  const hides = [
    hide(whaleAt, 'whale'),
    hide(sailAt, 'dutchman'),
    hide(bottleAt, 'bottle'),
    hide(jarAt, 'alexander'),
    ...tentacles.map((c) => hide(c, 'tentacle')),
    // Never fired at: the client could not read this row in a real match, and this proves nothing
    // downstream invents it from the hides list.
    hide(90, 'bottle'),
  ]
  // Both crews out looking, so the copy is not quietly one team's view of the water.
  const attacks = [
    ...openWater(whaleAt, 0),
    ...openWater(sailAt, 1),
    ...openWater(bottleAt, 0),
    ...openWater(jarAt, 1),
    ...tentacles.map((c) => openWater(c, 0)).flat(),
  ]
  const d = deep(r, attacks, hides)
  const rows = finalFinds(d)
  const stored = deepForArchive(d, (cell) => bottleNote(r, cell))

  check('every find is listed once', rows.length === 8, `${rows.length}`)
  check('and the list is in the order they were found', rows[0].find.cellIndex === whaleAt)
  check('and each one carries the mark its square is drawn with', rows.every((row) => finalMarks(d).get(row.find.cellIndex) === row.mark))
  // The tentacles were all found, so they are drawn as the sleeper rather than as arms. Reading the
  // mark back out of finalMarks is what keeps the list and the board agreeing about that.
  check('a woken tentacle is listed as the sleeper', rows.filter((row) => row.mark === 'sleeper').length === tentacles.length)

  check('the archive copy keeps every find', stored.finds.length === rows.length)
  check('with the square, the finder and their fleet', stored.finds.every((f, i) => f.cellIndex === rows[i].find.cellIndex && f.who === rows[i].find.who && f.attackerTeam === rows[i].find.attackerTeam))
  check('and both crews in it', new Set(stored.finds.map((f) => f.attackerTeam)).size === 2)
  // Quoted at write time, because the seed it is drawn from is the room id - and a room id is not
  // something every archived match still has.
  const bottle = stored.finds.find((f) => f.mark === 'bottle')
  check('the bottle keeps what it said', bottle?.note === bottleNote(r, bottleAt), `${bottle?.note}`)
  check('and nothing else carries a note', stored.finds.filter((f) => f.note).length === 1)
  check('the tentacle tally is kept', stored.cthulhu?.found === tentacles.length && stored.cthulhu?.awake === true)

  check('the bottle nobody fished out is not written down', !stored.finds.some((f) => f.cellIndex === 90))
  check('and neither is any square that was never fired at', stored.finds.every((f) => attacks.some((a) => a.cell_index === f.cellIndex)))
}

console.log('\n-- the water is empty for EVERYBODY -------------------------------------\n')

/**
 * The invariant the whole redesign exists for, and the only one this file cannot prove by running
 * code: the placing happens in Postgres, because Postgres is the only participant allowed to see
 * every fleet at once.
 *
 * So it is checked by reading the migration. That is worth doing rather than skipping, because the
 * two halves of this feature are duplicated across two languages ON PURPOSE - the client computes how
 * many tentacles a board has, since it cannot count rows it is not allowed to read - and a formula
 * that drifts would wake Cthulhu at the wrong number with nothing failing anywhere.
 */
{
  const sql = readFileSync(new URL('../supabase/migrations/20260806000000_deep_water_hides.sql', import.meta.url), 'utf8')

  check(
    'the roll only ever picks cells no fleet occupies',
    /where not exists \(\s*select 1 from fleets f/.test(sql) && /f\.ship_grid -> c, 'false'::jsonb\) = 'true'::jsonb/.test(sql)
  )
  check('it refuses to run once a shot has been fired', /cell_index >= 0/.test(sql) && /return \(select count/.test(sql))
  check('and refuses while any fleet can still move a hull', /not f\.placement_confirmed/.test(sql))
  check('a hiding place is unreadable until its square is fired at', /a\.cell_index = deep_hides\.cell_index/.test(sql))
  check('nothing but the roll may write one', !/deep_hides for (insert|update)/.test(sql))

  check('the SQL 64-cell floor matches hidesExtras()', /v_extras := v_cells >= 64/.test(sql))
  check(
    'the SQL tentacle formula matches tentacleCount()',
    /least\(6, greatest\(3, round\(v_cells \* 0\.04\)::int\)\)/.test(sql)
  )
  check('the SQL hides one whale', /\(1, 'whale'::text, 1\)/.test(sql))
  check('three Dutchman squares', /\(3, 'dutchman', case when v_extras then 3 else 0 end\)/.test(sql))
  check('four bottles', /\(4, 'bottle', case when v_extras then 4 else 0 end\)/.test(sql))
  check('and one Alexander', /\(5, 'alexander', case when v_extras then 1 else 0 end\)/.test(sql))
  check('the decoy roll is one in five, on the whale and the tentacles only', /creature in \('whale', 'tentacle'\) and random\(\) < 0\.2/.test(sql))
}

console.log(failures === 0 ? '\nall deep water checks passed\n' : `\n${failures} check(s) failed\n`)
if (failures > 0) process.exitCode = 1
