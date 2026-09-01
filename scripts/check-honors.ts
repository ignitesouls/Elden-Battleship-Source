/**
 * Checks the Honors panel - which titles a match log earns, and who gets them.
 *
 * Worth its own script because honors are derived from the attack log by reconstruction, not from
 * stored counters: a hull's footprint is rebuilt from the sinking row so that earlier hits can be
 * traced back to it. That machinery is invisible on screen - a wrong answer still renders as a
 * confident, plausible-looking list - so the cases here pin down the rules the panel promises:
 * every title is earned, one per player, ranked titles cascade to the next player who genuinely
 * qualifies, singular titles don't, and a player who did nothing measurable gets nothing.
 *
 * Run with bare Node (nothing in the import graph touches the browser or Supabase):
 *
 *   node --experimental-strip-types scripts/check-honors.ts
 */
import { registerHooks } from 'node:module'
import type { Attack, AttackResult, Player, Room } from '../src/types/battleship.ts'
import type { DeepCreature, DeepHide } from '../src/lib/deepWater.ts'

// App modules import each other without file extensions, which Vite resolves and Node's ESM
// resolver does not. Filling the extension in here keeps the app code written the way the rest of
// src/ is written, rather than bending it to suit one script.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { buildMatchReport: buildReport, honorClaims } = await import('../src/lib/matchReport.ts')
const { tentacleCount, bottleNote } = await import('../src/lib/deepWater.ts')
const { cellLabel } = await import('../src/lib/battleshipLogic.ts')
const { deepFromAwards } = await import('../src/lib/deepArchive.ts')

/**
 * A match report, with nothing hiding in the water unless a case says otherwise.
 *
 * Most of this file is about pattern honors and has no business with the deep, and the default is
 * what makes that true: hiding places are ROWS now, so a section that hides nothing genuinely cannot
 * stumble onto a tentacle. It used to have to go seed-hunting for a room whose secret squares dodged
 * its own shots (see 4a), which was a lot of machinery to buy a guarantee that is now free.
 */
type EarnedMap = Map<string, Array<{ nickname: string; detail: string }>>

/**
 * The report, with the earned-title set carried alongside it.
 *
 * Both come from the same inputs, so nothing here can drift: `awards` is what the draw handed out,
 * `earned` is everything it had to choose from. See the note on `holder` below for which one each
 * case wants.
 */
const buildMatchReport = (r: Room, ps: Player[], attacks: Attack[], hides: DeepHide[] = []) =>
  Object.assign(buildReport(r, ps, attacks, hides), {
    earned: honorClaims(r, ps, attacks, hides) as EarnedMap,
  })

const hide = (cellIndex: number, creature: DeepCreature, decoy = false): DeepHide => ({
  cellIndex,
  creature,
  decoy,
})

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

const BOARD = 10
const cell = (r: number, c: number) => r * BOARD + c

const room = (winner: number | null = 0): Room => ({
  id: 'room',
  code: 'TEST',
  board_size: BOARD,
  ship_defs: [],
  status: 'finished',
  winner_team: winner,
  created_at: '2026-08-04T18:00:00.000Z',
  starting_seconds: 0,
  prep_seconds: 0,
})

function player(id: string, nickname: string, team: number): Player {
  return {
    id,
    room_id: 'room',
    user_id: `u-${id}`,
    nickname,
    team,
    is_host: id === 'p1',
    joined_at: '2026-08-04T18:00:00.000Z',
  }
}

/** Sinking-row columns, so a hull's footprint can be rebuilt from the log. */
interface Hull {
  name: string
  size: number
  row: number
  col: number
  horizontal: boolean
}

/** Builds one match's worth of attack rows, with a clock that advances per shot. */
class Log {
  private rows: Attack[] = []
  private seq = 0
  private ms = Date.parse('2026-08-04T18:00:00.000Z')

  constructor() {
    // The match-start marker the clock reads from; a negative index is never a real square.
    this.rows.push(this.row(-1, 0, 0, null, 'miss'))
  }

  private row(
    index: number,
    attackerTeam: number,
    defenderTeam: number,
    attacker: string | null,
    result: AttackResult,
    hull?: Hull
  ): Attack {
    return {
      id: `a${this.seq++}`,
      room_id: 'room',
      cell_index: index,
      attacker_team: attackerTeam,
      defender_team: defenderTeam,
      attacker_player_id: attacker,
      result,
      sunk_ship_name: hull?.name ?? null,
      sunk_ship_size: hull?.size ?? null,
      sunk_start_row: hull?.row ?? null,
      sunk_start_col: hull?.col ?? null,
      sunk_horizontal: hull?.horizontal ?? null,
      created_at: new Date(this.ms).toISOString(),
      resolved_at: new Date(this.ms).toISOString(),
    }
  }

  /** One trigger-pull: one row per defending team, all sharing a created_at. */
  fire(
    p: Player,
    index: number,
    outcomes: Array<{ defender: number; result: AttackResult; hull?: Hull }>,
    gapSeconds = 30
  ): this {
    this.ms += gapSeconds * 1000
    for (const o of outcomes) {
      this.rows.push(this.row(index, p.team ?? 0, o.defender, p.id, o.result, o.hull))
    }
    return this
  }

  /** Shorthand for the two-team case: one defender, one row. */
  shot(p: Player, defender: number, index: number, result: AttackResult, hull?: Hull, gapSeconds = 30): this {
    return this.fire(p, index, [{ defender, result, hull }], gapSeconds)
  }

  get attacks(): Attack[] {
    return this.rows
  }
}

/*
 * Almost everything in this file asks a question about the RULES - "does sinking the most ships
 * earn Admiral of the Fleet" - and the answer used to be readable straight off report.awards,
 * because the awards were the rules applied in a fixed order.
 *
 * They aren't any more. A player is offered one title drawn at random from everything they earned
 * (see buildAwards), so "did Aljex end up holding Admiral" is a question about the draw and no
 * longer about the rule. These two therefore read the EARNED set - honorClaims - which is the rule
 * with the draw taken back out. Every assertion below kept its original wording because that is
 * what it was always really asserting.
 *
 * The draw has its own cases at the bottom of the file, and they use `awarded` instead.
 */
const titles = (report: { earned: EarnedMap }) => [...report.earned.keys()]
/** Who earns this title - the strongest claim on it, drawn or not. */
const holder = (report: { earned: EarnedMap }, title: string) =>
  report.earned.get(title)?.[0]?.nickname ?? null
/** The detail line on the strongest claim - the wording the RULE produces, draw or no draw. */
const detailOf = (report: { earned: EarnedMap }, title: string) =>
  report.earned.get(title)?.[0]?.detail ?? null
/** Everyone who earned a title, in claim order. */
const earners = (report: { earned: EarnedMap }, title: string) =>
  (report.earned.get(title) ?? []).map((c) => c.nickname)
/** The titles the draw actually handed out. For cases about what a player is TOLD. */
const given = (report: { awards: Array<{ title: string }> }) => report.awards.map((a) => a.title)
/** Who actually WALKED AWAY with it, after the draw. For the award-mechanism cases only. */
const awarded = (report: { awards: Array<{ title: string; nickname: string }> }, title: string) =>
  report.awards.find((a) => a.title === title)?.nickname ?? null

// -- 1. a full 3v3, every ship-level honor in play --------------------------
{
  const aljex = player('p1', 'Aljex', 0)
  const onion = player('p2', 'Onion', 0)
  const kc = player('p3', 'KC', 0)
  const jaff = player('p4', 'JAFF', 1)
  const thomas = player('p5', 'Thomas', 1)
  const anime = player('p6', 'Animetrus', 1)
  const ghost = player('p7', 'Ghost', 0) // never fires a shot
  const players = [aljex, onion, kc, jaff, thomas, anime, ghost]

  const carrier: Hull = { name: 'Carrier', size: 5, row: 0, col: 0, horizontal: true }
  const battleship: Hull = { name: 'Battleship', size: 4, row: 7, col: 0, horizontal: true }
  const submarine: Hull = { name: 'Submarine', size: 3, row: 3, col: 3, horizontal: false }
  const destroyerA: Hull = { name: 'Destroyer', size: 2, row: 9, col: 8, horizontal: true }
  const destroyerB: Hull = { name: 'Destroyer', size: 2, row: 0, col: 9, horizontal: false }

  const log = new Log()
  // Onion softens the Carrier up, Aljex takes the kill: a stolen finish.
  log.shot(onion, 1, cell(0, 0), 'hit')
  log.shot(jaff, 0, cell(4, 0), 'miss')
  log.shot(onion, 1, cell(0, 1), 'hit')
  log.shot(aljex, 1, cell(0, 2), 'hit')
  log.shot(thomas, 0, cell(4, 1), 'miss')
  log.shot(aljex, 1, cell(0, 3), 'hit')
  log.shot(jaff, 0, cell(4, 2), 'miss')
  log.shot(aljex, 1, cell(0, 4), 'sunk', carrier)
  // KC pours three hits into one Battleship and Aljex steals that one too - the Ahab case.
  log.shot(kc, 1, cell(7, 0), 'hit')
  log.shot(jaff, 0, cell(4, 3), 'miss')
  log.shot(kc, 1, cell(7, 1), 'hit')
  log.shot(anime, 0, cell(9, 8), 'hit')
  log.shot(kc, 1, cell(7, 2), 'hit')
  log.shot(jaff, 0, cell(4, 4), 'miss')
  log.shot(aljex, 1, cell(7, 3), 'sunk', battleship)
  // Onion hunts the Submarine down alone.
  log.shot(onion, 1, cell(3, 3), 'hit')
  log.shot(anime, 0, cell(9, 9), 'sunk', destroyerA)
  log.shot(onion, 1, cell(4, 3), 'hit')
  log.shot(thomas, 0, cell(0, 9), 'hit')
  log.shot(onion, 1, cell(5, 3), 'sunk', submarine)
  // Thomas lands the last blow of the match.
  log.shot(thomas, 0, cell(1, 9), 'sunk', destroyerB)
  log.shot(jaff, 0, cell(4, 5), 'miss')

  const report = buildMatchReport(room(), players, log.attacks)
  const list = titles(report)

  check('Admiral of the Fleet goes to the top sinker', holder(report, 'Admiral of the Fleet') === 'Aljex', holder(report, 'Admiral of the Fleet') ?? '-')
  check('Struck the Colors goes to the last killing blow', holder(report, 'Struck the Colors') === 'Thomas', holder(report, 'Struck the Colors') ?? '-')
  // Three players took a hull with no help here - Onion's Submarine, and a Destroyer each for
  // Thomas and Animetrus. The biggest of them wins the title.
  check(
    'Captain Nemo goes to the biggest hull taken alone',
    holder(report, 'Captain Nemo') === 'Onion',
    holder(report, 'Captain Nemo') ?? '-'
  )
  check(
    'The Old Man and the Sea goes to the chase that never landed the kill',
    holder(report, 'The Old Man and the Sea') === 'KC',
    holder(report, 'The Old Man and the Sea') ?? '-'
  )
  check('and nobody is Ahab in a match with no whale in it', !titles(report).includes('Captain Ahab'))
  check('Needle in the Haystack goes to a 2-square kill', holder(report, 'Needle in the Haystack') === 'Animetrus', holder(report, 'Needle in the Haystack') ?? '-')
  check("Davy Jones' Pen Pal goes to the all-miss gunner", holder(report, "Davy Jones' Pen Pal") === 'JAFF', holder(report, "Davy Jones' Pen Pal") ?? '-')

  // The Carrier's only slayer is already the Admiral, and no runner-up sank a hull that big.
  check('a singular honor with no other claimant goes unawarded', !given(report).includes('Slayer of the Leviathan'))

  check('nobody holds two honors', new Set(report.awards.map((a) => a.nickname)).size === report.awards.length)
  check('no title is handed out twice', new Set(list).size === list.length)
  check('a player who never fired earns nothing', !report.awards.some((a) => a.nickname === 'Ghost'))
  check('every shooter is honored', report.awards.length === 6, `${report.awards.length} honors`)

  const again = buildMatchReport(room(), players, log.attacks)
  check(
    'the same log always produces the same honors',
    JSON.stringify(again.awards) === JSON.stringify(report.awards)
  )

  const detail = detailOf(report, 'The Old Man and the Sea')
  check('the Old Man names the hull he hounded', detail === '3 hits into one Battleship and never landed the kill', detail ?? '-')

  const nemo = detailOf(report, 'Captain Nemo')
  check('Nemo names the hull and says it was done alone', nemo === 'ran the Submarine down single-handed - all 3 squares', nemo ?? '-')
}

// -- 1c. any hull counts, not just the Submarine ---------------------------
{
  const ada = player('p1', 'Ada', 0)
  const cid = player('p2', 'Cid', 0)
  const bo = player('p3', 'Bo', 1)

  const carrier: Hull = { name: 'Carrier', size: 5, row: 0, col: 0, horizontal: true }
  const destroyer: Hull = { name: 'Destroyer', size: 2, row: 9, col: 8, horizontal: true }

  const log = new Log()
  // Ada's own two squares, start to finish - and early, so the match's last blow isn't hers and
  // Struck the Colors doesn't claim her before Nemo can.
  log.shot(ada, 1, cell(9, 8), 'hit')
  log.shot(ada, 1, cell(9, 9), 'sunk', destroyer)
  log.shot(bo, 0, cell(2, 2), 'miss')
  // Cid outshoots her on the Carrier and takes the Admiralty, leaving Nemo to cascade to Ada.
  log.shot(ada, 1, cell(0, 0), 'hit')
  for (let c = 1; c < 4; c++) log.shot(cid, 1, cell(0, c), 'hit')
  log.shot(cid, 1, cell(0, 4), 'sunk', carrier)

  const report = buildMatchReport(room(), [ada, cid, bo], log.attacks)
  check('a Destroyer taken alone is Nemo too', holder(report, 'Captain Nemo') === 'Ada', holder(report, 'Captain Nemo') ?? '-')
  check(
    'and the Carrier the crew shared is nobody Nemo',
    detailOf(report, 'Captain Nemo') === 'ran the Destroyer down single-handed - all 2 squares',
    detailOf(report, 'Captain Nemo') ?? '-'
  )
}

// -- 1b. the same Submarine, finished off with help - not Nemo -------------
{
  const a = player('p1', 'Ada', 0)
  const b = player('p2', 'Bo', 0)
  const submarine: Hull = { name: 'Submarine', size: 3, row: 3, col: 3, horizontal: false }

  const log = new Log()
  log.shot(b, 1, cell(3, 3), 'hit') // Bo stumbles into it first
  log.shot(a, 1, cell(4, 3), 'hit')
  log.shot(a, 1, cell(5, 3), 'sunk', submarine)

  const report = buildMatchReport(room(), [a, b], log.attacks)
  check('a Submarine sunk with help is nobody Nemo', !titles(report).includes('Captain Nemo'), titles(report).join(', '))
}

// -- 1d. a whole enemy fleet swept single-handed ---------------------------
{
  const ada = player('p1', 'Ada', 0)
  const cid = player('p2', 'Cid', 0)
  const bo = player('p3', 'Bo', 1)
  // Ada's crew has to be three strong for the title to exist at all - see SHAKER_MIN_CREW. Dot
  // never fires; she is here to be somebody who COULD have taken a finish and didn't.
  const dot = player('p4', 'Dot', 0)

  const cruiser: Hull = { name: 'Cruiser', size: 3, row: 0, col: 0, horizontal: true }
  const submarine: Hull = { name: 'Submarine', size: 3, row: 3, col: 3, horizontal: false }
  const destroyer: Hull = { name: 'Destroyer', size: 2, row: 9, col: 8, horizontal: true }

  // The sweep needs the fleet size, and only the room knows it - a room with no ship_defs recorded
  // can't tell a wiped-out fleet from an unlucky one.
  const fleet = { ...room(), ship_defs: [cruiser, submarine, destroyer].map((h) => ({ name: h.name, size: h.size })) }

  /** Ada takes all three hulls; `last` is whoever lands the final killing blow. */
  const sweep = (last: Player) => {
    const log = new Log()
    log.shot(ada, 1, cell(0, 0), 'hit')
    log.shot(bo, 0, cell(6, 6), 'miss')
    log.shot(ada, 1, cell(0, 1), 'hit')
    log.shot(ada, 1, cell(0, 2), 'sunk', cruiser)
    log.shot(ada, 1, cell(3, 3), 'hit')
    log.shot(bo, 0, cell(6, 7), 'miss')
    log.shot(ada, 1, cell(4, 3), 'hit')
    log.shot(ada, 1, cell(5, 3), 'sunk', submarine)
    log.shot(ada, 1, cell(9, 8), 'hit')
    log.shot(last, 1, cell(9, 9), 'sunk', destroyer)
    return buildMatchReport(fleet, [ada, cid, dot, bo], log.attacks)
  }

  const swept = sweep(ada)
  check("Shaker's Protégé goes to the gunner who took every hull", holder(swept, "Shaker's Protégé") === 'Ada', holder(swept, "Shaker's Protégé") ?? '-')
  check(
    'and its detail names the fleet and the count',
    detailOf(swept, "Shaker's Protégé") === "sank all 3 of Blue Fleet's ships - every killing blow theirs",
    detailOf(swept, "Shaker's Protégé") ?? '-'
  )
  check('it outranks the Admiralty, which cascades on', awarded(swept, 'Admiral of the Fleet') !== 'Ada', awarded(swept, 'Admiral of the Fleet') ?? '-')

  // One crewmate closing out one hull is the whole difficulty of it.
  const stolen = sweep(cid)
  check('a single stolen finish ends the sweep', !titles(stolen).includes("Shaker's Protégé"), titles(stolen).join(', '))

  // The same log in a room that never recorded its fleet: three kills, but no way to know it was all of them.
  const unknown = (() => {
    const log = new Log()
    log.shot(ada, 1, cell(0, 0), 'hit')
    log.shot(ada, 1, cell(0, 1), 'hit')
    log.shot(ada, 1, cell(0, 2), 'sunk', cruiser)
    log.shot(ada, 1, cell(9, 8), 'hit')
    log.shot(ada, 1, cell(9, 9), 'sunk', destroyer)
    return buildMatchReport(room(), [ada, cid, dot, bo], log.attacks)
  })()
  check('and an unrecorded fleet earns nobody the sweep', !titles(unknown).includes("Shaker's Protégé"), titles(unknown).join(', '))

  /**
   * The same clean sweep, by a crew too small for it to be a feat.
   *
   * This is SALTYLANTERN, where a 1v1 handed the rarest title on the list to the only gunner who
   * could ever have earned it - and did it in a match where his own fleet had been wiped off the
   * board by a bug, so he could not lose either. Nobody else on your side taking a finish is only a
   * deed when there is somebody else on your side.
   */
  const twoStrong = (() => {
    const log = new Log()
    log.shot(ada, 1, cell(0, 0), 'hit')
    log.shot(ada, 1, cell(0, 1), 'hit')
    log.shot(ada, 1, cell(0, 2), 'sunk', cruiser)
    log.shot(ada, 1, cell(3, 3), 'hit')
    log.shot(ada, 1, cell(4, 3), 'hit')
    log.shot(ada, 1, cell(5, 3), 'sunk', submarine)
    log.shot(ada, 1, cell(9, 8), 'hit')
    log.shot(ada, 1, cell(9, 9), 'sunk', destroyer)
    return buildMatchReport(fleet, [ada, cid, bo], log.attacks)
  })()
  check(
    'a crew of two never earns the sweep, however clean it was',
    !titles(twoStrong).includes("Shaker's Protégé"),
    titles(twoStrong).join(', ')
  )
  check(
    'and the gunner is still honored for the shooting itself',
    given(twoStrong).length > 0,
    given(twoStrong).join(', ')
  )
}

// -- 1e. Ishmael: the best gun on a fleet that went down with all hands -----
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)
  const cid = player('p3', 'Cid', 1)

  const cruiser: Hull = { name: 'Cruiser', size: 3, row: 0, col: 0, horizontal: true }
  const destroyer: Hull = { name: 'Destroyer', size: 2, row: 9, col: 8, horizontal: true }
  const fleet = { ...room(), ship_defs: [cruiser, destroyer].map((h) => ({ name: h.name, size: h.size })) }

  /** Ada wipes Bo and Cid's fleet out; they get their shots in but lose every hull. */
  const wipe = (blue: (l: Log) => void) => {
    const log = new Log()
    blue(log)
    log.shot(ada, 1, cell(0, 0), 'hit')
    log.shot(ada, 1, cell(0, 1), 'hit')
    log.shot(ada, 1, cell(0, 2), 'sunk', cruiser)
    log.shot(ada, 1, cell(9, 8), 'hit')
    log.shot(ada, 1, cell(9, 9), 'sunk', destroyer)
    return { log, report: buildMatchReport(fleet, [ada, bo, cid], log.attacks) }
  }

  const fought = wipe((l) => {
    l.shot(bo, 0, cell(5, 5), 'hit')
    l.shot(cid, 0, cell(6, 6), 'hit')
    l.shot(bo, 0, cell(5, 6), 'hit')
  })
  check('Ishmael goes to the best gun on the fleet that was wiped out', holder(fought.report, 'Ishmael') === 'Bo', holder(fought.report, 'Ishmael') ?? '-')
  const escaped = detailOf(fought.report, 'Ishmael')
  check(
    'and the detail says they lost anyway',
    escaped === '2 hits landed, and their own fleet still went down with all hands',
    escaped ?? '-'
  )
  // One claim per wreck: a crewmate who did less is a worse survivor than the story deserves.
  check('a crewmate who shot less does not inherit it', holder(fought.report, 'Ishmael') !== 'Cid')
  check('and the fleet still afloat is nobody Ishmael', holder(fought.report, 'Ishmael') !== 'Ada')

  // A wiped fleet nobody on it landed anything with has no survivor worth naming.
  const silent = wipe((l) => {
    l.shot(bo, 0, cell(5, 5), 'miss')
    l.shot(cid, 0, cell(6, 6), 'miss')
  })
  check('a fleet that never landed a shot earns nobody Ishmael', !titles(silent.report).includes('Ishmael'), titles(silent.report).join(', '))

  // Same shooting, but a room that never recorded its fleet can't know the fleet went down at all.
  const unknown = buildMatchReport(room(), [ada, bo, cid], fought.log.attacks)
  check('and an unrecorded fleet earns nobody Ishmael', !titles(unknown).includes('Ishmael'), titles(unknown).join(', '))
}

// -- 1f. the Submarine, hunted by name --------------------------------------
{
  const ada = player('p1', 'Ada', 0)
  const cid = player('p2', 'Cid', 0)
  const bo = player('p3', 'Bo', 1) // never fires

  const carrier: Hull = { name: 'Carrier', size: 5, row: 0, col: 0, horizontal: true }
  const submarine: Hull = { name: 'Submarine', size: 3, row: 3, col: 3, horizontal: false }

  // Cid does most of the damage everywhere and takes the Admiralty; Ada's whole match is the one
  // kill, so nothing above Red October can claim her first.
  const log = new Log()
  log.shot(cid, 1, cell(3, 3), 'hit')
  log.shot(cid, 1, cell(4, 3), 'hit')
  log.shot(ada, 1, cell(5, 3), 'sunk', submarine)
  log.shot(cid, 1, cell(0, 0), 'hit')
  log.shot(cid, 1, cell(0, 1), 'hit')
  log.shot(cid, 1, cell(0, 2), 'hit')
  log.shot(cid, 1, cell(0, 3), 'hit')
  log.shot(cid, 1, cell(0, 4), 'sunk', carrier)

  const report = buildMatchReport(room(), [ada, cid, bo], log.attacks)
  check('The Hunt for Red October goes to whoever sank the Submarine', holder(report, 'The Hunt for Red October') === 'Ada', holder(report, 'The Hunt for Red October') ?? '-')
  const detail = detailOf(report, 'The Hunt for Red October')
  check('and it says what was run down', detail === 'ran the Submarine to ground', detail ?? '-')
  // Two of the three hits were Cid's. The honor is for the kill, not the damage.
  check('the gunner who softened it up does not get it', holder(report, 'The Hunt for Red October') !== 'Cid')

  const noSub = (() => {
    const l = new Log()
    l.shot(cid, 1, cell(0, 0), 'hit')
    l.shot(cid, 1, cell(0, 1), 'hit')
    l.shot(cid, 1, cell(0, 2), 'hit')
    l.shot(cid, 1, cell(0, 3), 'hit')
    l.shot(ada, 1, cell(0, 4), 'sunk', carrier)
    return buildMatchReport(room(), [ada, cid, bo], l.attacks)
  })()
  check('a fleet with no Submarine in it hands out no hunt', !titles(noSub).includes('The Hunt for Red October'), titles(noSub).join(', '))
}

/*
 * 1g was "The Flying Dutchman" - the gunner who landed hits all match and never sent one under.
 * The honor was deleted when a real Dutchman started appearing in the water (see the note in the
 * HONORS list), so there is nothing left here to check. The gunner it described is still covered by
 * Coup de Grace, Master Gunner and Sharpest Eye, all of which have their own sections below.
 */

// -- 1h. opened on target ---------------------------------------------------
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 0)
  const zed = player('p3', 'Zed', 1) // never fires

  const destroyer: Hull = { name: 'Destroyer', size: 2, row: 9, col: 8, horizontal: true }

  /** Ada draws first blood and takes the Admiralty; Bo fires twice, opening with `first`. */
  const opener = (first: AttackResult) => {
    const log = new Log()
    log.shot(ada, 1, cell(9, 8), 'hit')
    log.shot(bo, 1, cell(2, 2), first)
    log.shot(ada, 1, cell(9, 9), 'sunk', destroyer)
    log.shot(bo, 1, cell(4, 4), first === 'hit' ? 'miss' : 'hit')
    return buildMatchReport(room(), [ada, bo, zed], log.attacks)
  }

  const onTarget = opener('hit')
  // Ada opened on a hull too, so both are on the claim list. Bo is the one this case varies.
  check('X Marks the Spot goes to whoever opened on a hull', earners(onTarget, 'X Marks the Spot').includes('Bo'), earners(onTarget, 'X Marks the Spot').join(', '))
  // Same two shots, same accuracy, the other way round - the honor is the opening, not the tally.
  check('a hit that came second does not count', !earners(opener('miss'), 'X Marks the Spot').includes('Bo'), earners(opener('miss'), 'X Marks the Spot').join(', '))
}

// -- 2. ranked honors cascade to the next player who qualifies --------------
{
  const a = player('p1', 'Ada', 0)
  const b = player('p2', 'Bo', 1)
  const carrier: Hull = { name: 'Carrier', size: 5, row: 0, col: 0, horizontal: true }

  const log = new Log()
  for (let c = 0; c < 4; c++) log.shot(a, 1, cell(0, c), 'hit')
  log.shot(a, 1, cell(0, 4), 'sunk', carrier)
  log.shot(b, 0, cell(7, 0), 'hit')
  log.shot(b, 0, cell(7, 1), 'hit')
  log.shot(b, 0, cell(2, 2), 'miss')

  const report = buildMatchReport(room(), [a, b], log.attacks)
  check('the Admiral is the sinker', holder(report, 'Admiral of the Fleet') === 'Ada', holder(report, 'Admiral of the Fleet') ?? '-')
  check(
    'Master Gunner cascades past the Admiral to the runner-up',
    earners(report, 'Master Gunner').join(', ') === 'Ada, Bo',
    earners(report, 'Master Gunner').join(', ') || '-'
  )
  check(
    'Master Gunner reports the runner-up own hit count',
    report.earned.get('Master Gunner')?.[1]?.detail === '2 hits landed',
    report.earned.get('Master Gunner')?.[1]?.detail ?? '-'
  )
}

// -- 3. a match where nothing sank still has an Admiral --------------------
{
  const a = player('p1', 'Ada', 0)
  const b = player('p2', 'Bo', 1)
  const log = new Log()
  log.shot(a, 1, cell(1, 1), 'hit')
  log.shot(b, 0, cell(2, 2), 'hit')
  log.shot(b, 0, cell(2, 3), 'hit')
  log.shot(b, 0, cell(2, 4), 'hit')
  const report = buildMatchReport(room(null), [a, b], log.attacks)
  check(
    'with no sinkings the Admiralty falls to the best gunner',
    holder(report, 'Admiral of the Fleet') === 'Bo',
    holder(report, 'Admiral of the Fleet') ?? '-'
  )
  check('and the first hit still draws first blood', holder(report, 'Opening Broadside') === 'Ada', holder(report, 'Opening Broadside') ?? '-')
}

// -- 4. the shooting-pattern honors, in a match nobody hit anything --------
{
  const p1 = player('p1', 'Scatter', 0)
  const p2 = player('p2', 'Spray', 1)
  const p3 = player('p3', 'Chart', 0)
  const p4 = player('p4', 'Patch', 1)
  const p5 = player('p5', 'Rim', 0)
  const p6 = player('p6', 'Quick', 1)
  const p7 = player('p7', 'Slow', 0)
  const players = [p1, p2, p3, p4, p5, p6, p7]
  const log = new Log()

  // Scatter: 8 shots, nothing distinctive - takes the wooden spoon on scoreboard order.
  for (let c = 1; c < 9; c++) log.shot(p1, 1, cell(2, c), 'miss')
  // Spray: the longest run of empty water in the match.
  for (let c = 0; c < 12; c++) log.shot(p2, 0, cell(3 + (c % 4), 1 + Math.floor(c / 4)), 'miss')
  // Chart: a long diagonal - the widest spread of rows and columns.
  for (let n = 2; n < 8; n++) log.shot(p3, 1, cell(n, n), 'miss')
  // Patch: six shots inside one 3x2 box.
  for (let n = 0; n < 6; n++) log.shot(p4, 0, cell(4 + (n % 3), 4 + Math.floor(n / 3)), 'miss')
  // Rim: every shot along the top edge.
  for (let c = 0; c < 8; c++) log.shot(p5, 1, cell(0, c), 'miss')
  // Quick: five shots a second apart, deliberately strewn so no grouping honor claims them first.
  for (let n = 0; n < 5; n++) log.shot(p6, 0, cell(1 + n * 2, 1 + n), 'miss', undefined, 1)
  // Slow: four shots two minutes apart.
  for (let n = 1; n < 5; n++) log.shot(p7, 1, cell(n, 1), 'miss', undefined, 120)

  // Nothing is hiding in this water, so no deep-water honor can displace a pattern one. That is the
  // default now; it used to take a search through five hundred seeds for a room whose secret squares
  // happened to dodge these forty-odd shots.
  const report = buildMatchReport(room(), players, log.attacks)
  const list = titles(report)
  const expected = [
    "Davy Jones' Pen Pal",
    'Water, Water, Everywhere',
    'Cartographer of the Narrow Sea',
    'Trawler',
    'Hugger of the Shoals',
    'Quickest Powder',
    'Das Boot',
    // Earned, though only one player can be handed it. It was invisible while this list read the
    // awards, because seven crew had already taken everything above it.
    'Powder Monkey',
  ]
  check(
    'a hitless match still earns eight pattern honors',
    expected.every((t) => list.includes(t)) && list.length === expected.length,
    list.join(', ')
  )
  check('one honor each, seven players', new Set(report.awards.map((a) => a.nickname)).size === 7)
  check('no ship-level honor appears when nothing sank', !list.some((t) => t === 'Admiral of the Fleet' || t === 'Captain Nemo'))
}

// -- 4b. the whale, and the one honor it hands out -------------------------
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)
  const r = room()
  const home = cell(4, 4)

  const log = new Log()
  // Bo spends the Admiralty on hulls elsewhere. Nowhere near the whale's square, but that is now
  // flavour rather than care: a hit cannot move him, because nothing moves.
  for (const c of [cell(9, 7), cell(9, 8), cell(9, 9)]) log.shot(bo, 0, c, 'hit')
  log.shot(ada, 1, home, 'miss')

  const report = buildMatchReport(r, [ada, bo], log.attacks, [hide(home, 'whale')])
  check('the Admiralty goes to the gunner, not the whaler', holder(report, 'Admiral of the Fleet') === 'Bo')
  check('Captain Ahab goes to whoever found the whale', holder(report, 'Captain Ahab') === 'Ada', holder(report, 'Captain Ahab') ?? '-')
  const detail = detailOf(report, 'Captain Ahab')
  check('and it says where', detail === `found the white whale at ${cellLabel(home, BOARD)}`, detail ?? '-')

  // The shot was still a miss. Finding the whale costs you accuracy, which is exactly right.
  const ahab = report.stats.find((s) => s.nickname === 'Ada')
  check('the whale shot still counts as a miss', ahab?.misses === 1 && ahab?.hits === 0, `${ahab?.misses} miss`)
}

// -- 4c. Laboon gets his own line in the report ----------------------------
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)
  const home = cell(4, 4)
  const log = new Log()
  log.shot(bo, 0, cell(9, 9), 'hit') // so the Admiralty is spoken for
  log.shot(ada, 1, home, 'miss')

  // A whale square flagged as the decoy. One in five of them are, and it is the whole of what was
  // ever on that square - the whale is not one square further on, he is not in this match.
  const report = buildMatchReport(room(), [ada, bo], log.attacks, [hide(home, 'whale', true)])
  check('Wrong Whale goes to whoever found Laboon', holder(report, 'Wrong Whale') === 'Ada', holder(report, 'Wrong Whale') ?? '-')
  check('and Ahab is not awarded for him', !titles(report).includes('Captain Ahab'))
}

// -- 4d. the tentacle ladder ----------------------------------------------
{
  const needed = tentacleCount(BOARD)
  /**
   * Four squares, four real tentacles, and the rungs counted against `needed`.
   *
   * Every one of them is declared rather than hunted for. It used to take a five-hundred-seed search
   * to find a room where all four seekers opened on distinct squares and none of them turned out to
   * be Patches - both of which broke the counts silently, and neither of which can happen to a row.
   */
  const r = room()
  const homes = [cell(1, 1), cell(3, 6), cell(6, 2), cell(8, 8)].slice(0, needed)
  const hides = homes.map((c) => hide(c, 'tentacle'))
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)

  // One each: the bottom rung, twice, cascading rather than one of them getting nothing.
  {
    const log = new Log()
    log.shot(ada, 1, homes[0], 'miss')
    log.shot(bo, 0, homes[1], 'miss')
    const report = buildMatchReport(r, [ada, bo], log.attacks, hides)
    check('either team can find a tentacle', titles(report).includes('Whispers in the Deep'), titles(report).join(', '))
    // One holder per title, the same rule Master Gunner follows when two gunners tie: the bottom rung
    // has nowhere to cascade to, so the second finder of a single tentacle goes unnamed.
    check('and a tied rung still has one holder', report.awards.filter((a) => a.title === 'Whispers in the Deep').length === 1)
  }

  // Three to one player: the third rung, and no wake.
  {
    const log = new Log()
    for (let i = 0; i < 3; i++) log.shot(ada, 1, homes[i], 'miss')
    const report = buildMatchReport(r, [ada, bo], log.attacks, hides)
    check('three tentacles is the Acolyte', holder(report, 'Acolyte of the Sleeper') === 'Ada', holder(report, 'Acolyte of the Sleeper') ?? '-')
    check('and three of four does not wake him', !titles(report).includes('Woke the Sleeper'))
  }

  // All four, split between the fleets: the last one wakes him and takes the honor.
  {
    const log = new Log()
    log.shot(ada, 1, homes[0], 'miss')
    log.shot(ada, 1, homes[1], 'miss')
    log.shot(ada, 1, homes[2], 'miss')
    log.shot(bo, 0, homes[3], 'miss')
    const report = buildMatchReport(r, [ada, bo], log.attacks, hides)
    check('the last tentacle wakes him', holder(report, 'Woke the Sleeper') === 'Bo', holder(report, 'Woke the Sleeper') ?? '-')
    check('and the crew that found three is the Acolyte', holder(report, 'Acolyte of the Sleeper') === 'Ada')
    check('nobody is High Priest without the full set', !titles(report).includes("High Priest of R'lyeh"))
  }

  // All four alone: the rarest thing in the game.
  {
    const log = new Log()
    for (const c of homes) log.shot(ada, 1, c, 'miss')
    const report = buildMatchReport(r, [ada, bo], log.attacks, hides)
    check('all four alone is the High Priest', holder(report, "High Priest of R'lyeh") === 'Ada', holder(report, "High Priest of R'lyeh") ?? '-')
    check('and he is not also given the lesser rungs', report.awards.filter((a) => a.nickname === 'Ada').length === 1)
  }
}

// -- 4e. the four newer creatures, and the six titles they hand out --------
/**
 * The mechanics of these live in check-deep-water; this is about the awards.
 *
 * Bo's hits are only ever there to spend the Admiralty. They used to have to be aimed off the far end
 * of each creature's search order so they couldn't quietly move the thing Ada was about to find;
 * nothing moves any more, so they can land wherever is convenient.
 */
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)
  const r = room()
  const elsewhere = [cell(9, 7), cell(9, 8), cell(9, 9)]
  const detailOf = (report: ReturnType<typeof buildMatchReport>, title: string) =>
    report.awards.find((a) => a.title === title)?.detail ?? '-'

  // A bottle, and the note it turned out to hold. Four are hidden; the honor is for the first one out.
  {
    const home = cell(2, 3)
    const bottles = [home, cell(5, 5), cell(7, 1), cell(8, 6)].map((c) => hide(c, 'bottle'))
    const log = new Log()
    for (const c of elsewhere) log.shot(bo, 0, c, 'hit')
    log.shot(ada, 1, home, 'miss')

    const report = buildMatchReport(r, [ada, bo], log.attacks, bottles)
    check('Beachcomber goes to whoever fished the bottle out', holder(report, 'Beachcomber') === 'Ada', holder(report, 'Beachcomber') ?? '-')
    const detail = detailOf(report, 'Beachcomber')
    check('and it names the square', detail.includes(cellLabel(home, BOARD)), detail)
    // The note is the find; the bottle is the container it came in.
    check('and quotes what the note said', /It said "[^"]+"/.test(detail), detail)
    // The note belongs to the SQUARE, not the room - four bottles, four different messages.
    check('and it is the note that bottle was holding', detail.includes(bottleNote(r, home)), detail)
  }

  // The Dutchman: one sail is a sighting, three is a curse, and they are different titles.
  {
    const sails = [cell(0, 4), cell(4, 0), cell(6, 7)]
    const hides = sails.map((c) => hide(c, 'dutchman'))
    const once = (() => {
      const log = new Log()
      for (const c of elsewhere) log.shot(bo, 0, c, 'hit')
      log.shot(ada, 1, sails[0], 'miss')
      return buildMatchReport(r, [ada, bo], log.attacks, hides)
    })()
    check('Sighted the Dutchman goes to the first sail', holder(once, 'Sighted the Dutchman') === 'Ada', holder(once, 'Sighted the Dutchman') ?? '-')
    check('and one sighting is not yet a curse', !titles(once).includes('Fates Confirmed'))

    const thrice = (() => {
      const log = new Log()
      for (const c of elsewhere) log.shot(bo, 0, c, 'hit')
      for (const c of sails) log.shot(ada, 1, c, 'miss')
      return buildMatchReport(r, [ada, bo], log.attacks, hides)
    })()
    check('three sightings is Fates Confirmed', holder(thrice, 'Fates Confirmed') === 'Ada', holder(thrice, 'Fates Confirmed') ?? '-')
    check('and it counts them', detailOf(thrice, 'Fates Confirmed').includes('3'), detailOf(thrice, 'Fates Confirmed'))
    // Singular, and its owner already holds the rarer title - so it goes unawarded rather than down.
    check('the lesser sighting does not also go out', !given(thrice).includes('Sighted the Dutchman'), given(thrice).join(', '))
  }

  // Alexander: two titles, and a player who does both takes only the better one.
  {
    const home = cell(3, 3)
    const beside = home + 1
    const hides = [hide(home, 'alexander')]

    const wedged = (() => {
      const log = new Log()
      for (const c of elsewhere) log.shot(bo, 0, c, 'hit')
      log.shot(ada, 1, home, 'miss')
      return buildMatchReport(r, [ada, bo], log.attacks, hides)
    })()
    check('Found the Jar goes to whoever turned him up', holder(wedged, 'Found the Jar') === 'Ada', holder(wedged, 'Found the Jar') ?? '-')
    check('and nobody is a Potfriend while he is still stuck', !titles(wedged).includes('Potfriend'))

    const freed = (() => {
      const log = new Log()
      for (const c of elsewhere) log.shot(bo, 0, c, 'hit')
      log.shot(ada, 1, home, 'miss')
      log.shot(ada, 1, beside, 'miss')
      return buildMatchReport(r, [ada, bo], log.attacks, hides)
    })()
    check('Potfriend goes to whoever shook him loose', holder(freed, 'Potfriend') === 'Ada', holder(freed, 'Potfriend') ?? '-')
    /**
     * The deliberate consequence of both being Singular: one player doing both deeds takes the better
     * title and the lesser one is not awarded at all. Getting him out is the whole deed - being also
     * told you found him is the participation ribbon this list doesn't hand out.
     */
    check('and doing both does not also hand out the lesser title', !given(freed).includes('Found the Jar'), given(freed).join(', '))
  }

  // Patches, who is "sorry".
  {
    const home = cell(2, 7)
    const log = new Log()
    log.shot(bo, 0, cell(9, 9), 'hit') // so the Admiralty is spoken for
    log.shot(ada, 1, home, 'miss')

    // A tentacle square flagged as the decoy - one in five of them is him.
    const report = buildMatchReport(r, [ada, bo], log.attacks, [hide(home, 'tentacle', true)])
    check("Ahh, So It's You goes to whoever got Patches", holder(report, "Ahh, So It's You") === 'Ada', holder(report, "Ahh, So It's You") ?? '-')
    check('and no tentacle rung is handed out for him', !titles(report).includes('Whispers in the Deep'), titles(report).join(', '))
  }
}

// -- 4f. the water outranks the shooting ----------------------------------
/**
 * The ordering rule the whole deep-water tier rests on, pinned because it is load-bearing and
 * invisible when it breaks.
 *
 * One honor per player, so a title ranked above the water does not sit alongside a find - it EATS
 * it. The Admiralty, Captain Nemo and Ishmael used to be ranked above the block, and a real match
 * (GOLDENWHARF) duly turned up the Dutchman and a bottle while its best gunners were handed "sank
 * the most ships". Every one of these checks fails if those three are ever moved back up.
 *
 * Shaker's Protégé is the deliberate exception and is checked as one: sweeping a fleet single-handed
 * is rarer than most of what is down there, so it stays at #1.
 */
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)
  const r = room()
  const home = cell(4, 4)

  // Ada is the only gunner in the match AND the one who finds the whale, so every shooting title in
  // the list is hers for the taking. The find is what she must be given.
  const log = new Log()
  log.shot(ada, 1, cell(9, 7), 'hit')
  log.shot(ada, 1, cell(9, 8), 'hit')
  log.shot(ada, 1, home, 'miss')
  const report = buildMatchReport(r, [ada, bo], log.attacks, [hide(home, 'whale')])
  check('the whale is hers to be told about', holder(report, 'Captain Ahab') === 'Ada', titles(report).join(', '))
  /*
   * She is the only claimant to BOTH titles, so whichever the draw gives her, the other has nobody
   * left to go to. Which one she gets is no longer fixed - that was the old ordering, and replacing
   * it is the point of the draw - but "one title each, and a title with no free claimant goes
   * unawarded" still holds, and that is what this case is really about.
   */
  check(
    'and she is handed exactly one of them',
    given(report).length === 1,
    given(report).join(', ')
  )

  // The exception, and the only one: a fleet swept single-handed still comes first.
  {
    const hull = { name: 'Destroyer', size: 2, row: 0, col: 0, horizontal: true }
    const swept = new Log()
    swept.shot(ada, 1, cell(0, 0), 'hit')
    swept.shot(ada, 1, cell(0, 1), 'sunk', hull)
    swept.shot(ada, 1, home, 'miss')
    // A crew of three, because the title needs one now (SHAKER_MIN_CREW). Neither crewmate fires,
    // so Ada is still the only claimant to every shooting title in the list.
    const sweep = buildMatchReport(
      { ...r, ship_defs: [{ name: 'Destroyer', size: 2 }] },
      [ada, player('p3', 'Cid', 0), player('p4', 'Dot', 0), bo],
      swept.attacks,
      [hide(home, 'whale')]
    )
    check("Shaker's Protégé still outranks the water", holder(sweep, "Shaker's Protégé") === 'Ada', titles(sweep).join(', '))
  }
}

// -- 5. one shot across two fleets, in a three-team room -------------------
{
  const x = player('p1', 'Rake', 0)
  const y = player('p2', 'Yara', 1)
  const players = [x, y, player('p3', 'Zed', 2)]
  const log = new Log()
  // Yara hits first and takes both the Admiralty and first blood.
  log.shot(y, 0, cell(5, 5), 'hit')
  log.shot(y, 0, cell(5, 6), 'hit')
  log.shot(y, 0, cell(5, 7), 'hit')
  // Rake's single shot lands on both opposing fleets at once.
  log.fire(x, cell(1, 1), [
    { defender: 1, result: 'hit' },
    { defender: 2, result: 'hit' },
  ])

  const report = buildMatchReport(room(), players, log.attacks)
  check('Raking Fire goes to the shot that struck two fleets', holder(report, 'Raking Fire') === 'Rake', holder(report, 'Raking Fire') ?? '-')
  check(
    'and its detail counts the fleets',
    detailOf(report, 'Raking Fire') === 'one shot struck 2 fleets at once'
  )
}

// -- 6. what an old recap can still be read for ----------------------------
/**
 * The Almanac's salvage path (src/lib/deepArchive.deepFromAwards).
 *
 * Matches finished before the finds were archived have no record of them anywhere: `deep_hides` goes
 * with the room within the hour, and all that survives is the honors. Four of those name their
 * square, so four finds can be put back on the board of a match played months ago.
 *
 * It is checked HERE, against detail strings this file has just watched `buildAwards` generate,
 * because that is the only version of the test worth having. The salvage reads prose, so the thing
 * that breaks it is somebody rewording an honor - and a copy of the wording pasted into the test
 * would go on passing while the Almanac quietly stopped finding anything.
 */
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)
  const r = room()
  const elsewhere = [cell(9, 7), cell(9, 8), cell(9, 9)]
  const salvage = (report: ReturnType<typeof buildMatchReport>) =>
    deepFromAwards(report.awards, report.stats, BOARD)

  /** Bo spends the Admiralty elsewhere, so Ada is free to hold the find's own title. */
  const found = (home: number, hides: DeepHide[], alsoBeside = false) => {
    const log = new Log()
    for (const c of elsewhere) log.shot(bo, 0, c, 'hit')
    log.shot(ada, 1, home, 'miss')
    if (alsoBeside) log.shot(ada, 1, home + 1, 'miss')
    return buildMatchReport(r, [ada, bo], log.attacks, hides)
  }

  {
    const home = cell(4, 4)
    const finds = salvage(found(home, [hide(home, 'whale')]))
    check('the whale square comes back off an old recap', finds.length === 1 && finds[0].cellIndex === home, JSON.stringify(finds))
    check('as a whale', finds[0]?.mark === 'whale', finds[0]?.mark ?? '-')
    check('and credited to the fleet that found him', finds[0]?.who === 'Ada' && finds[0]?.attackerTeam === 0)
  }

  {
    const home = cell(0, 4)
    const finds = salvage(found(home, [cell(0, 4), cell(4, 0), cell(6, 7)].map((c) => hide(c, 'dutchman'))))
    check('a sail comes back too', finds.some((f) => f.mark === 'dutchman' && f.cellIndex === home), JSON.stringify(finds))
  }

  {
    const home = cell(2, 3)
    const bottles = [home, cell(5, 5), cell(7, 1), cell(8, 6)].map((c) => hide(c, 'bottle'))
    const finds = salvage(found(home, bottles))
    const bottle = finds.find((f) => f.mark === 'bottle')
    check('and the bottle, out of the square in its honor', bottle?.cellIndex === home, JSON.stringify(finds))
    // The note is quoted in the honor, which is the only reason a bottle this old can still say
    // anything at all - nothing else in the archive remembers what was in it.
    check('still saying what it said', bottle?.note === bottleNote(r, home), `${bottle?.note} vs ${bottleNote(r, home)}`)
  }

  {
    const home = cell(3, 3)
    const wedged = salvage(found(home, [hide(home, 'alexander')]))
    check('Alexander comes back stuck', wedged[0]?.mark === 'jar' && wedged[0]?.cellIndex === home, JSON.stringify(wedged))

    /**
     * Out at last, read off two honors at once: his square is only ever named by Found the Jar, and
     * whether he got out is only ever said by Potfriend - which names the square BESIDE him, and is
     * therefore no use as a find on its own.
     *
     * Both titles only appear together when different people did the two deeds (one player doing
     * both takes Potfriend and the lesser title goes unawarded), so the two reports are spliced
     * rather than played out - the strings are still the real ones.
     */
    const freed = found(home, [hide(home, 'alexander')], true)
    const spliced = deepFromAwards(
      [
        ...found(home, [hide(home, 'alexander')]).awards.filter((a) => a.title === 'Found the Jar'),
        ...freed.awards.filter((a) => a.title === 'Potfriend'),
      ],
      freed.stats,
      BOARD
    )
    check('and out, when the other honor says he got out', spliced[0]?.mark === 'jarFree', JSON.stringify(spliced))
    check('on his own square, not the one that freed him', spliced.length === 1 && spliced[0]?.cellIndex === home)
  }

  // Nothing to salvage is the normal case, and it must come back empty rather than guessing.
  {
    const log = new Log()
    log.shot(bo, 0, cell(5, 5), 'hit')
    log.shot(ada, 1, cell(1, 1), 'miss')
    check('a match that found nothing salvages nothing', salvage(buildMatchReport(r, [ada, bo], log.attacks)).length === 0)
  }
}

// -- the draw itself --------------------------------------------------------
//
// Everything above is about which titles a log EARNS. This is about which of them a player is
// actually told, which is now a seeded draw rather than a fixed order - see buildAwards. The
// properties that have to survive being random are the ones a player would notice breaking.
{
  const ada = player('p1', 'Ada', 0)
  const bo = player('p2', 'Bo', 1)
  const cid = player('p3', 'Cid', 1)
  const crew = [ada, bo, cid]

  /** A busy, unremarkable match: plenty earned, nothing guaranteed, so the draw does all the work. */
  const busy = () => {
    const log = new Log()
    const carrier: Hull = { name: 'Carrier', size: 2, row: 0, col: 0, horizontal: true }
    log.shot(ada, 1, cell(0, 0), 'hit')
    log.shot(bo, 0, cell(4, 4), 'miss')
    log.shot(ada, 1, cell(0, 1), 'sunk', carrier)
    log.shot(cid, 0, cell(6, 6), 'miss')
    log.shot(bo, 0, cell(5, 5), 'miss')
    log.shot(ada, 1, cell(8, 8), 'miss')
    log.shot(cid, 0, cell(7, 7), 'miss')
    log.shot(bo, 0, cell(3, 3), 'miss')
    log.shot(cid, 0, cell(9, 9), 'miss')
    return buildMatchReport(room(), crew, log.attacks)
  }

  const first = busy()
  check(
    'the same match always draws the same titles',
    JSON.stringify(busy().awards) === JSON.stringify(first.awards)
  )

  // The whole reason the draw is seeded from the match key rather than Math.random(): every client
  // in the room builds this independently, and the archive writes whichever one saves first.
  const elsewhere = (() => {
    const r = { ...room(), code: 'OTHER' }
    const log = new Log()
    const carrier: Hull = { name: 'Carrier', size: 2, row: 0, col: 0, horizontal: true }
    log.shot(ada, 1, cell(0, 0), 'hit')
    log.shot(bo, 0, cell(4, 4), 'miss')
    log.shot(ada, 1, cell(0, 1), 'sunk', carrier)
    log.shot(cid, 0, cell(6, 6), 'miss')
    log.shot(bo, 0, cell(5, 5), 'miss')
    log.shot(ada, 1, cell(8, 8), 'miss')
    log.shot(cid, 0, cell(7, 7), 'miss')
    log.shot(bo, 0, cell(3, 3), 'miss')
    log.shot(cid, 0, cell(9, 9), 'miss')
    return buildMatchReport(r, crew, log.attacks)
  })()
  check(
    'a different room draws differently from the same shooting',
    JSON.stringify(elsewhere.awards) !== JSON.stringify(first.awards),
    given(first).join(', ') + '  vs  ' + given(elsewhere).join(', ')
  )

  // Nothing invented: a drawn title is always one its holder actually earned.
  check(
    'every title handed out was earned by the player holding it',
    first.awards.every((a) => (first.earned.get(a.title) ?? []).some((c) => c.nickname === a.nickname)),
    first.awards.map((a) => `${a.nickname}:${a.title}`).join(', ')
  )
  check('and no title is handed out twice', new Set(given(first)).size === given(first).length)
  check(
    'and no player is handed two',
    new Set(first.awards.map((a) => a.nickname)).size === first.awards.length
  )

  // A guaranteed title is never left to chance - see Honor.guaranteed.
  {
    const sweep: Hull[] = [
      { name: 'A', size: 1, row: 0, col: 0, horizontal: true },
      { name: 'B', size: 1, row: 1, col: 1, horizontal: true },
    ]
    const r = { ...room(), ship_defs: [{ name: 'A', size: 1 }, { name: 'B', size: 1 }] }
    const log = new Log()
    log.shot(ada, 1, cell(0, 0), 'sunk', sweep[0])
    log.shot(ada, 1, cell(1, 1), 'sunk', sweep[1])
    log.shot(bo, 0, cell(9, 9), 'miss')
    // Three on Ada's fleet, which the title now requires - see SHAKER_MIN_CREW. What is being
    // checked here is that a GUARANTEED title never goes to the draw, not the crew rule.
    const report = buildMatchReport(r, [ada, player('p3', 'Cid', 0), player('p4', 'Dot', 0), bo], log.attacks)
    check(
      "a wiped fleet always earns its taker Shaker's Protégé, draw or no draw",
      awarded(report, "Shaker's Protégé") === 'Ada',
      given(report).join(', ')
    )
  }

  // The ladders collapse: three tentacles is never reported as one - see Honor.supersedes.
  {
    const r = { ...room(), id: 'tentacle-room' }
    const needed = tentacleCount(BOARD * BOARD)
    if (needed >= 3) {
      const cells = Array.from({ length: needed }, (_, i) => cell(0, i))
      const hides = cells.map((c) => hide(c, 'tentacle'))
      const log = new Log()
      // Ada finds three, which is Acolyte - and also Dreamer, and also Whispers.
      for (const c of cells.slice(0, 3)) log.shot(ada, 1, c, 'miss')
      log.shot(bo, 0, cell(9, 9), 'miss')
      const report = buildMatchReport(r, [ada, bo], log.attacks, hides)
      const hers = report.awards.find((a) => a.nickname === 'Ada')?.title ?? '-'
      check(
        'three tentacles is never reported as the one-tentacle title',
        hers !== 'Whispers in the Deep' && hers !== "Dreamer of R'lyeh",
        hers
      )
    }
  }
}

console.log(failures === 0 ? '\nall honors checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
