/**
 * Exercises board generation against the real squaresets, at the board sizes rooms actually use.
 *
 * These sets are authored for a 25-square bingo card and we deal them onto boards of 25 to 196, so
 * the interesting questions aren't "does it run" but: does every cell get filled, does the same
 * room id always produce the same board on every client, are duplicates avoided, and how far do the
 * set author's "only one of these" rules have to bend to fill the biggest boards.
 *
 * Run with bare Node - src/lib/squareSetFormat.ts imports nothing, which is why it's a separate
 * module from the registry that binds the JSON:
 *
 *   node --experimental-strip-types scripts/check-boards.ts
 */
import { readFileSync, readdirSync } from 'node:fs'
import { buildBingoBoard, buildFlatBoard, boardColor, colorLegend, strictFill, relaxedFill, largestBoardFor, REGION_ORDER, type BingoSquareSet, type BingoSquare, type Challenge, type KeywordColor, type Region } from '../src/lib/squareSetFormat.ts'
import { BOARD_SIZES, FLEET_PRESETS, fleetFor, type Attack, type ShipDefinition } from '../src/types/battleship.ts'
import {
  eliminatedTeamsFromAttacks,
  randomPlacements,
  resolveAttack,
  validatePlacements,
} from '../src/lib/battleshipLogic.ts'
import { shipCellIndices } from '../src/lib/shipCells.ts'

// Mirrors challengesForRoom()'s seeding, which can't be imported here (it pulls in the JSON).
function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

function rng(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const objectives = JSON.parse(readFileSync(new URL('../src/data/incursionSquares.json', import.meta.url), 'utf8')) as BingoSquareSet
const bosses = JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges.json', import.meta.url), 'utf8')) as Challenge[]
const shortNames = JSON.parse(
  readFileSync(new URL('../src/data/incursionShortNames.json', import.meta.url), 'utf8')
) as Record<string, string>
const objectiveRegions = JSON.parse(
  readFileSync(new URL('../src/data/incursionRegions.json', import.meta.url), 'utf8')
) as Record<string, string>
const rookie = JSON.parse(readFileSync(new URL('../src/data/rookieRumbleSquares.json', import.meta.url), 'utf8')) as BingoSquareSet
const rookieColors = JSON.parse(readFileSync(new URL('../src/data/rookieRumbleColors.json', import.meta.url), 'utf8')) as KeywordColor[]
const rookieColorNames = JSON.parse(readFileSync(new URL('../src/data/rookieRumbleColorNames.json', import.meta.url), 'utf8')) as Record<string, string>
const scadu = JSON.parse(readFileSync(new URL('../src/data/scaduLeagueSquares.json', import.meta.url), 'utf8')) as BingoSquareSet
const scaduColors = JSON.parse(readFileSync(new URL('../src/data/scaduLeagueColors.json', import.meta.url), 'utf8')) as KeywordColor[]
const scaduColorNames = JSON.parse(readFileSync(new URL('../src/data/scaduLeagueColorNames.json', import.meta.url), 'utf8')) as Record<string, string>
const ringus = JSON.parse(readFileSync(new URL('../src/data/ringusSquares.json', import.meta.url), 'utf8')) as Challenge[]
const bosses2v2 = JSON.parse(readFileSync(new URL('../src/data/battleshipChallenges2v2.json', import.meta.url), 'utf8')) as Challenge[]

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`)
}

const ROOM_IDS = [
  '0b2b3f2a-9d1e-4c58-8f4a-6f1d2e3c4b5a',
  'f7c1a2d3-4e5f-6a7b-8c9d-0e1f2a3b4c5d',
  '11111111-2222-3333-4444-555555555555',
]
const SIZES = [8, 10, 12]

const combinedNames = new Set(
  objectives.squares.filter((s) => (s.categories ?? []).includes('combinedSquare')).map((s) => s.name)
)
/** A resolved name keeps its %var% square's shape, so compare on the un-substituted prefix. */
function isCombined(name: string): boolean {
  return name.endsWith('(C)') || combinedNames.has(name)
}

console.log('\n=== Objectives (Incursion v0.3) ===\n')
console.log(`  ${objectives.squares.length} squares, ${combinedNames.size} of them combined\n`)

for (const size of SIZES) {
  const cells = size * size
  const board = buildBingoBoard(objectives, cells, rng(seedFrom(`${ROOM_IDS[0]}:objectives`)))
  const names = board.map((c) => c.name)
  const unique = new Set(names)
  const combined = names.filter(isCombined).length

  check(`${size}x${size}: every cell filled`, board.length === cells, `got ${board.length} of ${cells}`)
  check(
    `${size}x${size}: no repeated square`,
    unique.size === names.length,
    `${names.length - unique.size} repeat(s)`
  )
  console.log(`        ${combined} combined (${Math.round((combined / cells) * 100)}% of the board)`)
}

console.log('\n=== Same room id, same board on every client ===\n')
for (const roomId of ROOM_IDS) {
  const a = buildBingoBoard(objectives, 100, rng(seedFrom(`${roomId}:objectives`))).map((c) => c.name)
  const b = buildBingoBoard(objectives, 100, rng(seedFrom(`${roomId}:objectives`))).map((c) => c.name)
  check(`${roomId.slice(0, 8)}... reproduces exactly`, a.join('|') === b.join('|'))
}

console.log('\n=== A rematch is a different board ===\n')
// The seed rerolls every time a room returns to the lobby. Before it fed the shuffle, a second
// match in the same room dealt exactly the same squares in exactly the same places.
{
  const roomId = ROOM_IDS[0]
  const boardFor = (seed: string | null) => {
    const base = `${roomId}:objectives`
    const key = seed ? `${base}:${seed}` : base
    return buildBingoBoard(objectives, 100, rng(seedFrom(key)), shortNames).map((c) => c.name).join('|')
  }
  const first = boardFor('123456789')
  const second = boardFor('987654321')
  const third = boardFor('456789123')
  check('Three seeds in one room give three different boards', new Set([first, second, third]).size === 3)
  check('The same seed still reproduces its board exactly', boardFor('123456789') === first)

  // Every client has to agree on THIS match's board, so the seed must be the only thing that moves.
  const bossFor = (seed: string | null) =>
    buildFlatBoard(bosses, 100, rng(seedFrom(seed ? `${roomId}:${seed}` : roomId))).map((c) => c.name).join('|')
  check('Bosses reshuffle on a reroll too', bossFor('111111111') !== bossFor('222222222'))
  check(
    'A room with no seed still deals its original board',
    bossFor(null) === buildFlatBoard(bosses, 100, rng(seedFrom(roomId))).map((c) => c.name).join('|')
  )
}

console.log('\n=== Different rooms get different boards ===\n')
const boardsByRoom = ROOM_IDS.map((id) => buildBingoBoard(objectives, 100, rng(seedFrom(`${id}:objectives`))).map((c) => c.name).join('|'))
check('Three room ids, three distinct boards', new Set(boardsByRoom).size === 3)

console.log('\n=== Exclusivity: how far the rules bend to fill a board ===\n')
const limits = objectives['category limits'] ?? {}

/**
 * Maps a resolved name back to the square it came from.
 *
 * A whole-string regex, not a prefix test: "Kill %demiNum% Unique Demi-Human Bosses (C)" shares the
 * prefix "Kill " with half the set, so prefix matching attributes every kill square to it and
 * reports impossible counts like gaolsObj 50/1.
 */
const matchers = objectives.squares.map((square) => ({
  square,
  pattern: new RegExp(
    '^' +
      square.name
        .split(/%\w+%/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.+') +
      '$'
  ),
}))
function sourceOf(name: string) {
  return (
    objectives.squares.find((s) => s.name === name)?.categories ??
    matchers.find((m) => m.pattern.test(name))?.square.categories ??
    []
  )
}

for (const size of SIZES) {
  const cells = size * size
  const board = buildBingoBoard(objectives, cells, rng(seedFrom(`${ROOM_IDS[1]}:objectives`)))
  const counts: Record<string, number> = {}
  for (const c of board) for (const cat of sourceOf(c.name)) counts[cat] = (counts[cat] ?? 0) + 1

  const broken = Object.entries(counts).filter(([cat, n]) => (limits[cat] ?? Infinity) < 4 && n > limits[cat])
  console.log(
    `  ${size}x${size}: ${broken.length} exclusivity rule(s) exceeded` +
      (broken.length ? ` - ${broken.map(([c, n]) => `${c} ${n}/${limits[c]}`).join(', ')}` : '')
  )
}

console.log('\n=== %variables% resolved ===\n')
const varBoard = buildBingoBoard(objectives, 144, rng(seedFrom(`${ROOM_IDS[2]}:objectives`)))
check('No %placeholder% survives onto a board', !varBoard.some((c) => /%\w+%/.test(c.name)))
const demi = varBoard.find((c) => c.name.includes('Demi-Human Bosses'))
if (demi) console.log(`        e.g. "${demi.name}"`)

console.log('\n=== Bosses (unchanged behavior) ===\n')
// Note the seeding: the default set uses the bare room id, the way it did before square sets
// existed, so every board already dealt stays dealt. See challengesForRoom().
for (const size of SIZES) {
  const cells = size * size
  const board = buildFlatBoard(bosses, cells, rng(seedFrom(ROOM_IDS[0])))
  check(`${size}x${size}: every cell filled`, board.length === cells)
}
const bossA = buildFlatBoard(bosses, 100, rng(seedFrom(ROOM_IDS[0]))).map((c) => c.name)
const bossB = buildFlatBoard(bosses, 100, rng(seedFrom(ROOM_IDS[0]))).map((c) => c.name)
check('Reproduces exactly', bossA.join('|') === bossB.join('|'))

console.log('\n=== The community sets (base game / DLC) ===\n')
{
  /** Both spellings of a square's categories, the way the picker reads them. */
  const catsOf = (s: BingoSquare) =>
    typeof s.category === 'string' ? [...(s.categories ?? []), s.category] : (s.categories ?? [])

  /**
   * Board name -> the set square it came from.
   *
   * Not a plain name lookup: a square called "%pk%" reaches the board as "Kill Putrescent Knight",
   * so keying on the authored name loses exactly the squares these checks care about - "%pk%",
   * "%gaius%" and "%lion%" are three of Scadu League's eleven LEGENDS. Every name a square can
   * resolve to is enumerated instead, which is cheap because the option lists are short.
   */
  function nameIndex(set: BingoSquareSet): Map<string, BingoSquare> {
    const index = new Map<string, BingoSquare>()
    for (const square of set.squares) {
      let names = [square.name]
      for (const [key, value] of Object.entries(square)) {
        if (!Array.isArray(value) || !names.some((n) => n.includes(`%${key}%`))) continue
        names = names.flatMap((n) => value.map((v) => n.replaceAll(`%${key}%`, String(v))))
      }
      for (const n of names) index.set(n, square)
    }
    return index
  }

  for (const [id, set, colors, colorNames] of [
    ['objectives-base', rookie, rookieColors, rookieColorNames],
    ['objectives-dlc', scadu, scaduColors, scaduColorNames],
  ] as Array<[string, BingoSquareSet, KeywordColor[], Record<string, string>]>) {
    console.log(`  - ${id}: ${set.squares.length} squares, ${colors.length} colour rules`)
    for (const size of [5, ...SIZES]) {
      const cells = size * size
      const board = buildBingoBoard(set, cells, rng(seedFrom(`${ROOM_IDS[0]}:${id}`)), {}, {}, colors)
      check(`${id} ${size}x${size}: every cell filled`, board.length === cells, `got ${board.length} of ${cells}`)
      // Repeats are only reachable once the board has more cells than the set has squares, which is
      // a property of the set rather than a fault - the lobby warns via strictFill. So the check is
      // that the picker exhausts the set before it starts reusing, not that it never reuses.
      const unique = new Set(board.map((c) => c.name)).size
      check(
        `${id} ${size}x${size}: no repeat before the set runs out`,
        unique >= Math.min(cells, set.squares.length),
        `${unique} unique from ${set.squares.length} squares over ${cells} cells (strict fill ${strictFill(set, cells)})`
      )
      check(`${id} ${size}x${size}: no %placeholder% survives`, !board.some((c) => /%\w+%/.test(c.name)))
    }

    // Every authored colour has to be legible on the cell, or a whole group of squares is unreadable.
    const authored = [...new Set(colors.map((c) => c.Color))]
    const broken = authored.filter((a) => boardColor(a) === null)
    check(`${id}: every authored colour parses`, broken.length === 0, broken.join(', '))
    console.log(`        ${authored.map((a) => `"${a}"->${boardColor(a)}`).join('  ')}`)

    /**
     * Two authored colours that land close together are one colour to a reader, and the groups they
     * were separating stop being separated.
     *
     * FAILS only on an exact collision, because that is the case the legibility lift can cause and
     * therefore the case this code is answerable for. Merely-close pairs are reported instead: Scadu
     * League genuinely writes both "Blue" and "128, 128, 255", one square using the first, and
     * whether those are two groups or one is a question about that file rather than about the lift.
     */
    const hexes = authored.map((a) => ({ a, hex: boardColor(a)! }))
    const exact: string[] = []
    const near: string[] = []
    for (let i = 0; i < hexes.length; i++)
      for (let j = i + 1; j < hexes.length; j++) {
        const [x, y] = [hexes[i], hexes[j]]
        if (x.hex === y.hex) {
          exact.push(`"${x.a}" and "${y.a}" both became ${x.hex}`)
          continue
        }
        const d = [1, 3, 5].reduce(
          (acc, at) => acc + Math.abs(parseInt(x.hex.slice(at, at + 2), 16) - parseInt(y.hex.slice(at, at + 2), 16)),
          0
        )
        if (d <= 60) near.push(`"${x.a}" ${x.hex} ~ "${y.a}" ${y.hex}`)
      }
    check(`${id}: the legibility lift merges no two colours`, exact.length === 0, exact.join('\n        '))
    if (near.length > 0) console.log(`        NOTE - near-identical in the source file: ${near.join('; ')}`)

    // How much of the board the colour file actually reaches. Informational: these files cover the
    // squares their author wanted grouped and leave the rest to the default, which is a choice.
    let coloured = 0
    let total = 0
    for (let i = 0; i < 100; i++)
      for (const c of buildBingoBoard(set, 100, rng(i * 104729 + 11), {}, {}, colors)) {
        total++
        if (c.color) coloured++
      }
    console.log(`        colour file reaches ${Math.round((coloured / total) * 100)}% of a 100-square board`)

    /**
     * The board's colour key, which is the only thing telling a player what a tint MEANS on these
     * sets - so a colour drawn with no entry behind it is a group the reader cannot look up.
     *
     * Checked across many deals rather than one, because the key is filtered down to the colours a
     * particular board actually carries; a single seed proves nothing about the rest.
     */
    const key = colorLegend(colors, colorNames)
    const keyed = new Set(key.map((e) => e.hex))
    const orphans = new Set<string>()
    for (let i = 0; i < 100; i++)
      for (const c of buildBingoBoard(set, 100, rng(i * 7919 + 3), {}, {}, colors))
        if (c.color && !keyed.has(c.color)) orphans.add(c.color)
    check(`${id}: every colour a board draws is in the key`, orphans.size === 0, [...orphans].join(', '))

    // Which groups we have a name for and which are falling back to listing their own keywords.
    // Informational on purpose: an unnamed group is honest rather than broken (see the notes in
    // scaduLeagueColorNames.json), and this is the checklist for filling one in.
    const named = key.filter((e) => Object.values(colorNames).includes(e.label))
    console.log(`        key: ${named.length} of ${key.length} colours named`)
    for (const e of key) console.log(`          ${e.hex}  ${named.includes(e) ? '' : '(unnamed) '}${e.label}`)
  }

  // Rookie Rumble writes its categories in the singular, which the picker used to not read at all -
  // so every one of its 130 exclusivity rules was silently inert and "Kill 2 Crucible Knights" could
  // sit beside "Kill 3 Crucible Knights". Checked at 10x10, where the set still fills strictly.
  {
    const board = buildBingoBoard(rookie, 100, rng(seedFrom(`${ROOM_IDS[0]}:objectives-base`)), {}, {}, rookieColors)
    const byName = nameIndex(rookie)
    check('objectives-base: every board square maps back to a set square', board.every((c) => byName.has(c.name)))
    const tally = new Map<string, number>()
    for (const c of board) for (const cat of catsOf(byName.get(c.name)!)) tally.set(cat, (tally.get(cat) ?? 0) + 1)
    const over = [...tally].filter(([cat, n]) => n > (rookie['category limits']?.[cat] ?? Infinity))
    check(
      'objectives-base: singular "category" limits are enforced',
      over.length === 0,
      over.map(([c, n]) => `${c}: ${n}`).join(', ')
    )
  }

  // Scadu League's three format extensions, checked on a 5x5 where each one actually binds.
  {
    const byName = nameIndex(scadu)
    const rule = scadu.setRegionLimits![0]
    const endGame = new Set(rule.regionNames)
    let worstEndGame = 0
    let worstLegends = Infinity

    // Every seed, not one: both rules are floors and ceilings that only bind on some draws, and a
    // single board that happens to satisfy them proves nothing about the picker.
    for (let i = 0; i < 400; i++) {
      const board = buildBingoBoard(scadu, 25, rng(i * 31337 + 9), {}, {}, scaduColors)
      const picked = board.map((c) => byName.get(c.name)!)
      if (picked.some((s) => !s)) continue
      worstEndGame = Math.max(
        worstEndGame,
        picked.filter((s) => typeof s.region === 'string' && endGame.has(s.region)).length
      )
      worstLegends = Math.min(worstLegends, picked.filter((s) => catsOf(s).includes('LEGENDS')).length)
    }

    check('objectives-dlc: every board square maps back to a set square', worstLegends !== Infinity)
    check(
      'objectives-dlc: the end-game region cap holds on a 5x5 (400 boards)',
      worstEndGame <= rule.regionLimit,
      `worst board had ${worstEndGame} of an allowed ${rule.regionLimit}`
    )
    check(
      'objectives-dlc: the LEGENDS minimum is met on a 5x5 (400 boards)',
      worstLegends >= (scadu['category minimums']?.LEGENDS ?? 0),
      `leanest board had ${worstLegends}`
    )
  }

  /**
   * Weights decide WHICH of two mutually exclusive variants lands, so a 0.3/0.7 pair has to come out
   * near 3:7 and a 0.5/0.5 pair near even.
   *
   * Measured at 5x5, where the set covers the board strictly. It cannot be measured on a 10x10:
   * Scadu League has 101 squares for 100 cells, so the relax pass at the end waives the very
   * category limit that makes the pair exclusive and lets BOTH onto the board - which is not the
   * picker choosing between them, and averages any weighting toward 50/50. Boards where both
   * appeared are dropped for the same reason.
   */
  {
    const RUNS = 4000
    for (const [label, a, b, expected] of [
      ['0.3/0.7', 'Acquire Verdigris Discus', 'Kill the Divine Bird Warrior by Verdigris Discus', 0.7],
      ['0.5/0.5', 'Defeat Dryleaf Dane in a Duel', 'Kill Ralva The Great Red Bear', 0.5],
    ] as Array<[string, string, string, number]>) {
      let onlyA = 0
      let onlyB = 0
      for (let i = 0; i < RUNS; i++) {
        const names = new Set(buildBingoBoard(scadu, 25, rng(i * 2654435761 + 17)).map((c) => c.name))
        if (names.has(a) === names.has(b)) continue
        if (names.has(a)) onlyA++
        else onlyB++
      }
      const share = onlyB / (onlyA + onlyB)
      check(
        `objectives-dlc: a ${label} pair splits ${(1 - share).toFixed(2)}/${share.toFixed(2)}`,
        Math.abs(share - expected) < 0.04,
        `wanted ${expected} ± 0.04 over ${onlyA + onlyB} decided boards`
      )
    }
  }
}

console.log('\n=== Telling the sets apart from an archived log ===\n')
// What detectSquareSet() does, with the same inputs the Almanac has: a handful of (cell, name)
// pairs off match_events and no room row to consult.
function boardsFor(roomId: string, cells: number): Record<string, string[]> {
  return {
    bosses: buildFlatBoard(bosses, cells, rng(seedFrom(roomId))).map((c) => c.name),
    objectives: buildBingoBoard(objectives, cells, rng(seedFrom(`${roomId}:objectives`)), shortNames, objectiveRegions).map((c) => c.name),
    'objectives-base': buildBingoBoard(rookie, cells, rng(seedFrom(`${roomId}:objectives-base`)), {}, {}, rookieColors).map((c) => c.name),
    'objectives-dlc': buildBingoBoard(scadu, cells, rng(seedFrom(`${roomId}:objectives-dlc`)), {}, {}, scaduColors).map((c) => c.name),
    ringus: buildFlatBoard(ringus, cells, rng(seedFrom(`${roomId}:ringus`))).map((c) => c.name),
  }
}
function detect(roomId: string, cells: number, fired: Array<{ cell: number; name: string }>): string | null {
  for (const [id, board] of Object.entries(boardsFor(roomId, cells))) {
    if (fired.every(({ cell, name }) => board[cell] === name)) return id
  }
  return null
}

for (const roomId of ROOM_IDS) {
  for (const [id, board] of Object.entries(boardsFor(roomId, 100))) {
    const sample = [7, 34, 61].map((cell) => ({ cell, name: board[cell] }))
    check(`${roomId.slice(0, 8)}... played on ${id} is identified as ${id}`, detect(roomId, 100, sample) === id)
  }
}
check(
  'A name that was never on the board identifies nothing',
  detect(ROOM_IDS[0], 100, [{ cell: 3, name: 'Not A Real Square' }]) === null
)

console.log('\n=== Short names are wired to real squares ===\n')
{
  const entries = Object.entries(shortNames).filter(([k]) => !k.startsWith('_'))
  const realNames = new Set(objectives.squares.map((s) => s.name))

  // A key that matches no square is silently ignored at runtime - the square just keeps its full
  // name and nobody finds out. This is the check that catches a typo in the companion file.
  const orphans = entries.filter(([k]) => !realNames.has(k)).map(([k]) => k)
  check(`All ${entries.length} short names key a real square`, orphans.length === 0, orphans.join('\n        '))

  check(
    'Every short name is actually shorter',
    entries.every(([k, v]) => v.length < k.length),
    entries.filter(([k, v]) => v.length >= k.length).map(([k, v]) => `${k} -> ${v}`).join('\n        ')
  )

  // Quantities and qualifiers decide what a square asks of you. "6 'Tree' Bosses" abbreviated to
  // "'Tree' Bosses" would be a different objective, so these must survive shortening.
  const digitsOf = (s: string) => (s.match(/\d+/g) ?? []).join(',')
  const lostNumbers = entries.filter(([k, v]) => digitsOf(k) !== digitsOf(v)).map(([k, v]) => `${k} -> ${v}`)
  check('No short name drops or changes a number', lostNumbers.length === 0, lostNumbers.join('\n        '))

  const lostUnique = entries
    .filter(([k, v]) => /\bUnique\b/i.test(k) && !/\bUnique\b/i.test(v))
    .map(([k, v]) => `${k} -> ${v}`)
  check('No short name drops "Unique"', lostUnique.length === 0, lostUnique.join('\n        '))

  const lostVars = entries.filter(([k, v]) => (k.match(/%\w+%/g) ?? []).some((p) => !v.includes(p)))
  check('Short names keep the %variables% their square defines', lostVars.length === 0)
}

console.log('\n=== Regions are wired to real squares ===\n')
{
  const entries = Object.entries(objectiveRegions).filter(([k]) => !k.startsWith('_'))
  const realNames = new Set(objectives.squares.map((s) => s.name))

  // Same failure mode as the short names above, but quieter: an untagged square doesn't fall back to
  // something obviously wrong, it falls back to a pale default that looks a lot like the "Anywhere"
  // white. So a typo here shows up as a square that is subtly the wrong colour, which nobody reports.
  const orphans = entries.filter(([k]) => !realNames.has(k)).map(([k]) => k)
  check(`All ${entries.length} region tags key a real square`, orphans.length === 0, orphans.join('\n        '))

  // Combined squares are coloured from their category, so they are deliberately absent from the file.
  const untagged = objectives.squares
    .filter((s) => !isCombined(s.name) && objectiveRegions[s.name] === undefined)
    .map((s) => s.name)
  check(
    `Every non-combined square carries a region (${objectives.squares.length - combinedNames.size} of them)`,
    untagged.length === 0,
    untagged.join('\n        ')
  )

  const unknown = entries.filter(([, v]) => !REGION_ORDER.includes(v as Region)).map(([k, v]) => `${k} -> ${v}`)
  check('No region tag names a colour that does not exist', unknown.length === 0, unknown.join('\n        '))

  // The whole point of the tint is that a glance at the board tells you where it sends you, so a
  // board that came out mostly untinted would be a silent regression rather than a visible one.
  const board = buildBingoBoard(objectives, 100, rng(seedFrom(`${ROOM_IDS[0]}:objectives`)), shortNames, objectiveRegions)
  check('Every square on a dealt board is tinted', board.every((c) => !!c.region))
  check(
    'Combined squares take the combined colour, not a region',
    board.filter((c) => isCombined(c.name)).every((c) => c.region === 'combined')
  )

  const spread = new Map<string, number>()
  for (const c of board) spread.set(c.region!, (spread.get(c.region!) ?? 0) + 1)
  console.log(
    `        ${[...spread].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join('  ')}`
  )
}

console.log('\n=== Readable labels ===\n')
{
  const board = buildBingoBoard(objectives, 100, rng(seedFrom(`${ROOM_IDS[0]}:objectives`)), shortNames)
  check('Every square has a short form', board.every((c) => (c.short ?? '').length > 0))
  check('No %placeholder% survives into a short form', !board.some((c) => /%\w+%/.test(c.short ?? '')))
  check('A short form is never longer than the name', board.every((c) => (c.short ?? '').length <= c.name.length))

  const longestName = Math.max(...board.map((c) => c.name.length))
  const longestShort = Math.max(...board.map((c) => (c.short ?? c.name).length))
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  console.log(
    `        longest ${longestName} -> ${longestShort} chars, median ` +
      `${median(board.map((c) => c.name.length))} -> ${median(board.map((c) => (c.short ?? c.name).length))}`
  )

  // The board is the identity used by archiveMatch and the Almanac; only the display form is
  // allowed to change. If shortening ever leaked into `name`, set detection would stop matching
  // every match already in the record books.
  const rebuilt = buildBingoBoard(objectives, 100, rng(seedFrom(`${ROOM_IDS[0]}:objectives`)), shortNames)
  check('Shortening leaves the archived name untouched', board.every((c, i) => c.name === rebuilt[i].name))
  check('Names still carry their (C) marker', board.some((c) => c.name.endsWith('(C)')))
}

// A set author can supply their own short form. Nothing in Incursion v0.3 does yet, so this is
// exercised against a synthetic set - the risk being that name and short draw the same %variable%
// twice and disagree, putting "Kill 4" on the board and "Kill 5" in the match log.
{
  const synthetic: BingoSquareSet = {
    squares: [
      {
        name: 'Kill %n% Unique Demi-Human Bosses and %n% Hippos (C)',
        short: 'Kill %n% Demi-Humans, %n% Hippos',
        n: ['4', '5', '6', '7'],
        categories: [],
      },
    ],
  }
  let agreed = 0
  let sameTwice = 0
  const RUNS = 200
  for (let i = 0; i < RUNS; i++) {
    const [square] = buildBingoBoard(synthetic, 1, rng(seedFrom(`synthetic-${i}`)))
    const inName = square.name.match(/Kill (\d+) /)?.[1]
    const inShort = square.short?.match(/Kill (\d+) /)?.[1]
    const bothInName = square.name.match(/Kill (\d+) .*? (\d+) Hippos/)
    if (inName === inShort) agreed++
    if (bothInName && bothInName[1] === bothInName[2]) sameTwice++
  }
  check(`Authored short form draws the same number as the name (${RUNS} rolls)`, agreed === RUNS)
  check(`A variable used twice in one name says the same thing twice (${RUNS} rolls)`, sameTwice === RUNS)
}

console.log('\n=== Combined squares ===\n')
{
  // A combined square is two objectives in one, so a count below 3 undersells the (C) it carries.
  const combinedWithVars = objectives.squares.filter(
    (s) => (s.categories ?? []).includes('combinedSquare') && /%\w+%/.test(s.name)
  )
  let low = 0
  let noMarker = 0
  const RUNS = 300
  for (let i = 0; i < RUNS; i++) {
    for (const c of buildBingoBoard(objectives, 144, rng(seedFrom(`combined-${i}`)), shortNames)) {
      if (!c.name.endsWith('(C)')) continue
      // The marker has to survive onto the board, not just into the archive: a team needs to see
      // that a square is combined before committing to it.
      if (!(c.short ?? '').includes('(C)')) noMarker++
      for (const n of c.name.match(/\b\d+\b/g) ?? []) if (Number(n) < 3) low++
    }
  }
  console.log(`        ${combinedWithVars.length} combined square(s) carry a %variable%`)

  // Combined squares are PICKED first so the scarce ones survive the category limits, but they
  // must not be PLACED first - laying the picked list onto cells in order put all eight (C)
  // squares in the top two rows of a 5x5. Measured as the average position of a combined square
  // across many boards: clustered at the front reads as ~0.15, spread evenly as ~0.5.
  let positionSum = 0
  let positionCount = 0
  let worstFrontLoad = 0
  const BOARDS = 200
  for (let i = 0; i < BOARDS; i++) {
    const cells = 25
    const board = buildBingoBoard(objectives, cells, rng(seedFrom(`spread-${i}`)), shortNames)
    const spots = board.map((c, idx) => (c.name.endsWith('(C)') ? idx : -1)).filter((x) => x >= 0)
    for (const s of spots) {
      positionSum += s / (cells - 1)
      positionCount++
    }
    // How many of this board's combined squares landed in the first third of it.
    const front = spots.filter((s) => s < cells / 3).length
    worstFrontLoad = Math.max(worstFrontLoad, spots.length ? front / spots.length : 0)
  }
  const meanPosition = positionSum / Math.max(1, positionCount)
  check(
    `Combined squares are spread across the board, not front-loaded (${BOARDS} boards)`,
    meanPosition > 0.4 && meanPosition < 0.6,
    `average position ${meanPosition.toFixed(3)} of 1 (0.5 is evenly spread); worst board put ` +
      `${Math.round(worstFrontLoad * 100)}% of them in the first third`
  )
  check('Every combined square keeps its (C) on the board', noMarker === 0, `${noMarker} without it`)
  check(`No combined square draws a number below 3 (${RUNS} boards)`, low === 0, `${low} occurrence(s)`)
}

console.log('\n=== Ringus (randomizer, flat list) ===\n')
{
  console.log(`  ${ringus.length} squares, longest name ${Math.max(...ringus.map((c) => c.name.length))} characters\n`)

  const names = ringus.map((c) => c.name)
  check('every square has a name', ringus.every((c) => typeof c.name === 'string' && c.name.length > 0))
  check(
    'no two squares share a name',
    new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(', ')
  )
  // A flat set carries no %variables%, and a stray one would reach the board unresolved - the flat
  // path has no resolver to catch it the way buildBingoBoard does.
  check('no %placeholder% anywhere in the set', !names.some((n) => /%\w+%/.test(n)))

  for (const size of [5, ...SIZES]) {
    const cells = size * size
    const board = buildFlatBoard(ringus, cells, rng(seedFrom(`${ROOM_IDS[0]}:ringus`)))
    check(`${size}x${size}: every cell filled`, board.length === cells, `got ${board.length} of ${cells}`)
    check(
      `${size}x${size}: no repeated square`,
      new Set(board.map((c) => c.name)).size === cells,
      `${cells - new Set(board.map((c) => c.name)).size} repeat(s) from ${ringus.length} squares`
    )
  }

  const a = buildFlatBoard(ringus, 100, rng(seedFrom(`${ROOM_IDS[0]}:ringus`))).map((c) => c.name)
  const b = buildFlatBoard(ringus, 100, rng(seedFrom(`${ROOM_IDS[0]}:ringus`))).map((c) => c.name)
  check('the same room reproduces its board exactly', a.join('|') === b.join('|'))
  check(
    'a different room gets a different board',
    a.join('|') !== buildFlatBoard(ringus, 100, rng(seedFrom(`${ROOM_IDS[1]}:ringus`))).map((c) => c.name).join('|')
  )

  /**
   * Short forms, held to the same rules as the Objectives set's.
   *
   * A flat set carries them inline rather than in a companion file - unlike the community
   * squaresets, this file is ours to edit, so there is nothing to keep verbatim. buildFlatBoard
   * hands the objects straight through and every renderer already reads `short ?? name`, so the
   * field needs no code behind it.
   *
   * 55 characters is roughly where a name stops fitting a 10x10 cell; past that the text hits its
   * 7px floor and the overflow is clipped. The full name is always on hover, but a square nobody
   * can read at a glance is a square nobody shoots at.
   */
  const CELL_LIMIT = 55
  const shortened = ringus.filter((c) => c.short !== undefined)
  const stillLong = ringus.filter((c) => (c.short ?? c.name).length > CELL_LIMIT)
  check(
    `every square reads in a cell (${shortened.length} shortened, longest now ${Math.max(...ringus.map((c) => (c.short ?? c.name).length))})`,
    stillLong.length === 0,
    stillLong.map((c) => `${(c.short ?? c.name).length}  ${c.short ?? c.name}`).join('\n        ')
  )
  check(
    'every short form is actually shorter',
    shortened.every((c) => c.short!.length < c.name.length),
    shortened.filter((c) => c.short!.length >= c.name.length).map((c) => c.name).join('\n        ')
  )
  // Quantities and qualifiers decide what a square asks of you: "Acquire 4 Weapons needing 20 Str"
  // shortened to "Acquire Weapons needing Str" is a different objective, not a shorter label.
  const digitsOf = (s: string) => (s.match(/\d+/g) ?? []).join(',')
  const lostNumbers = shortened.filter((c) => digitsOf(c.name) !== digitsOf(c.short!))
  check(
    'no short form drops or changes a number',
    lostNumbers.length === 0,
    lostNumbers.map((c) => `${c.name} -> ${c.short}`).join('\n        ')
  )
  const lostOnly = shortened.filter((c) => /\bonly\b/i.test(c.name) && !/\bonly\b/i.test(c.short!))
  check('no short form drops "only"', lostOnly.length === 0, lostOnly.map((c) => c.name).join('\n        '))
  // The parenthetical exclusions are the whole point of the squares that carry them.
  const lostNot = shortened.filter((c) => /\bnot\b/i.test(c.name) && !/\bnot\b/i.test(c.short!))
  check('no short form drops an exclusion', lostNot.length === 0, lostNot.map((c) => c.name).join('\n        '))

  for (const c of shortened) console.log(`        ${c.name}\n          -> ${c.short}`)
}

console.log('\n=== Elimination read off the public attack log ===\n')
{
  /**
   * eliminatedTeamsFromAttacks() is the client-side safety net for a match whose losing team has
   * closed its tab, and it can only see what every client can see: the attack rows. This drives the
   * real functions - fleetFor, randomPlacements, validatePlacements, resolveAttack - through a whole
   * fleet on every board size and preset, and checks the net catches the elimination on the last
   * hull and not one shot before it.
   */
  const DEFENDER = 3
  function sinkWholeFleet(boardSize: number, defs: ShipDefinition[]) {
    const placements = randomPlacements(boardSize, defs)
    const { shipGrid, shipIndexGrid, valid } = validatePlacements(boardSize, defs, placements)
    if (!valid) return null

    const fleet = {
      shipGrid,
      shipIndexGrid,
      shipHitsRemaining: defs.map((d) => d.size),
      shipSunk: defs.map(() => false),
      placements,
    }

    // Fire at every hull cell in turn, exactly as a player would, and log what came back.
    const log: Attack[] = []
    const early: string[] = []
    const cells = shipCellIndices(placements, defs.map((d) => d.size), boardSize)
    for (const cell of cells) {
      const outcome = resolveAttack(defs, fleet, cell)
      fleet.shipHitsRemaining = outcome.newHitsRemaining
      fleet.shipSunk = outcome.newShipSunk
      log.push({
        id: `a${log.length}`, room_id: 'r', cell_index: cell,
        attacker_team: 0, defender_team: DEFENDER, attacker_player_id: null,
        result: outcome.result,
        sunk_ship_name: outcome.sunkShip?.name ?? null,
        sunk_ship_size: outcome.sunkShip?.size ?? null,
        sunk_start_row: outcome.sunkShip?.startRow ?? null,
        sunk_start_col: outcome.sunkShip?.startCol ?? null,
        sunk_horizontal: outcome.sunkShip?.isHorizontal ?? null,
        created_at: new Date(log.length * 1000).toISOString(), resolved_at: null,
      })
      // Anything before the final hull is still a live fleet, and calling it dead would hand the
      // match to the wrong side - a worse failure than never calling it at all.
      if (log.length < cells.size && eliminatedTeamsFromAttacks(log, defs.length).has(DEFENDER)) {
        early.push(`after ${log.length} of ${cells.size} shots`)
      }
    }
    return { log, early, shots: cells.size, allSunk: fleet.shipSunk.every(Boolean) }
  }

  const RUNS = 25
  const failures: string[] = []
  const premature: string[] = []
  let dupNameFleets = 0
  for (const n of BOARD_SIZES) {
    for (const preset of Object.keys(FLEET_PRESETS)) {
      const defs = fleetFor(n, preset)
      if (new Set(defs.map((d) => d.name)).size < defs.length) dupNameFleets++
      for (let i = 0; i < RUNS; i++) {
        const run = sinkWholeFleet(n, defs)
        if (!run) { failures.push(`${n}x${n} ${preset}: could not place`); break }
        if (!run.allSunk) { failures.push(`${n}x${n} ${preset}: fleet not fully sunk`); break }
        if (!eliminatedTeamsFromAttacks(run.log, defs.length).has(DEFENDER)) {
          failures.push(`${n}x${n} ${preset} (${defs.length} hulls, ${new Set(defs.map((d) => d.name)).size} names)`)
          break
        }
        if (run.early.length > 0) { premature.push(`${n}x${n} ${preset} ${run.early[0]}`); break }
      }
    }
  }

  check(
    `a sunk fleet is recognised on every board and preset (${BOARD_SIZES.length * 3} combinations x ${RUNS} layouts)`,
    failures.length === 0,
    failures.join('\n        ')
  )
  check('and never one shot early', premature.length === 0, premature.join('\n        '))
  // Guards the guard: if fleetFor ever stopped repeating names, the checks above would still pass
  // while testing nothing, so assert the hazard they exist for is actually present.
  check(
    `${dupNameFleets} of ${BOARD_SIZES.length * 3} fleets repeat a hull name, which is what broke this`,
    dupNameFleets > 0
  )

  // The specific shape of the old bug: every hull down, but fewer distinct NAMES than hulls.
  {
    const defs = fleetFor(5, 'Classic')
    const run = sinkWholeFleet(5, defs)!
    const names = new Set(run.log.filter((a) => a.sunk_ship_name).map((a) => a.sunk_ship_name))
    check(
      '5x5 Classic: three hulls sunk but only two distinct names',
      names.size < defs.length && eliminatedTeamsFromAttacks(run.log, defs.length).has(DEFENDER),
      `${names.size} names for ${defs.length} hulls - counting names could never reach the fleet size`
    )
  }

  // A sunk hull shot at again resolves as 'sunk' a second time, because hits are floored at zero.
  // That duplicate must not count as another hull, or a fleet could be declared dead early.
  {
    const defs = fleetFor(10, 'Classic')
    const run = sinkWholeFleet(10, defs)!
    const firstSunk = run.log.find((a) => a.result === 'sunk')!
    const withDupes = [...run.log.slice(0, -1), ...Array(5).fill(firstSunk)]
    check(
      'a hull sunk twice is still one hull',
      !eliminatedTeamsFromAttacks(withDupes, defs.length).has(DEFENDER),
      'five repeats of one sunk row eliminated a team that still had a ship afloat'
    )
  }

  // Two teams' logs share one array, and one team's losses must never count toward another's.
  {
    const defs = fleetFor(8, 'Classic')
    const dead = sinkWholeFleet(8, defs)!
    const other = dead.log.map((a) => ({ ...a, defender_team: 7 }))
    const both = eliminatedTeamsFromAttacks([...dead.log, ...other.slice(0, 2)], defs.length)
    check(
      'one team going down does not sink another',
      both.has(DEFENDER) && !both.has(7),
      `eliminated: [${[...both].join(', ')}]`
    )
  }
}

console.log('\n=== A fleet row cannot outlive the settings it was built for ===\n')
{
  /**
   * The lobby self-heal that rebuilds a team's fleet row when the host changes the settings under
   * it. Mirrors the `misshapen` test in useRoom, and exists as a check because the bug it is
   * guarding against is invisible from the outside: the board looks right, the ships look right,
   * and one hull just dies early.
   */
  function needsRebuild(boardSize: number, defs: ShipDefinition[], row: { grid: number; hits: number[] }): boolean {
    const pristine = defs.map((d) => d.size)
    return (
      row.grid !== boardSize * boardSize ||
      row.hits.length !== pristine.length ||
      pristine.some((n, i) => row.hits[i] !== n)
    )
  }

  // The regression itself. RESTLESSCUTLASS was a 5x5 that ended up on Armada with counters left
  // over from Classic, so its Submarine carried 2 instead of 3 and sank on the second hit.
  const fiveClassic = fleetFor(5, 'Classic')
  const fiveArmada = fleetFor(5, 'Armada')
  check(
    'a 5x5 Classic->Armada swap is caught (the Submarine bug)',
    needsRebuild(5, fiveArmada, { grid: 25, hits: fiveClassic.map((s) => s.size) }),
    `Classic [${fiveClassic.map((s) => s.size)}] vs Armada [${fiveArmada.map((s) => s.size)}]`
  )
  check(
    'the old length-only test would NOT have caught it',
    fiveClassic.length === fiveArmada.length,
    'both presets field three hulls, which is why this shipped'
  )

  // Every direction on every board, so the next preset that happens to match a neighbour's ship
  // count doesn't reopen it.
  const missed: string[] = []
  for (const n of BOARD_SIZES) {
    for (const from of Object.keys(FLEET_PRESETS)) {
      for (const to of Object.keys(FLEET_PRESETS)) {
        const a = fleetFor(n, from)
        const b = fleetFor(n, to)
        const sameFleet = a.map((s) => s.size).join(',') === b.map((s) => s.size).join(',')
        const caught = needsRebuild(n, b, { grid: n * n, hits: a.map((s) => s.size) })
        if (!sameFleet && !caught) missed.push(`${n}x${n} ${from}->${to}`)
      }
    }
  }
  check('every preset swap that changes the fleet forces a rebuild', missed.length === 0, missed.join(', '))

  // And every board-size change, which moves the grid out from under the row as well.
  const missedSize: string[] = []
  for (const from of BOARD_SIZES) {
    for (const to of BOARD_SIZES) {
      if (from === to) continue
      const a = fleetFor(from, 'Classic')
      const b = fleetFor(to, 'Classic')
      if (!needsRebuild(to, b, { grid: from * from, hits: a.map((s) => s.size) })) {
        missedSize.push(`${from}x${from}->${to}x${to}`)
      }
    }
  }
  check('every board-size change forces a rebuild', missedSize.length === 0, missedSize.join(', '))

  // A row that already matches must NOT be rebuilt, or the lobby resets a confirmed layout forever.
  const spurious = BOARD_SIZES.flatMap((n) =>
    Object.keys(FLEET_PRESETS)
      .filter((p) => needsRebuild(n, fleetFor(n, p), { grid: n * n, hits: fleetFor(n, p).map((s) => s.size) }))
      .map((p) => `${n}x${n} ${p}`)
  )
  check('a fleet row that already matches is left alone', spurious.length === 0, spurious.join(', '))
}

console.log('\n=== Fleets scale to the board ===\n')
// The one fixed point: a 10x10 Classic board is the standard game and must deal the standard
// fleet. Everything else is derived, but this is the composition players know by heart.
check(
  '10x10 Classic is the canonical 5-4-3-3-2 (17 squares)',
  fleetFor(10, 'Classic').map((s) => s.size).join(',') === '5,4,3,3,2',
  fleetFor(10, 'Classic').map((s) => `${s.name}(${s.size})`).join(' ')
)

for (const preset of Object.keys(FLEET_PRESETS)) {
  const rows: string[] = []
  let ok = true
  for (const n of BOARD_SIZES) {
    const fleet = fleetFor(n, preset)
    const squares = fleet.reduce((a, s) => a + s.size, 0)
    const longest = Math.max(...fleet.map((s) => s.size))
    const share = squares / (n * n)

    // A ship longer than about half the board gives its own position away, and one that won't fit
    // at all can't be placed; three ships is the floor for a game that isn't a coin toss.
    const sane = fleet.length >= 3 && longest <= Math.max(2, Math.floor(n / 2) + 1) && longest <= n
    // Too sparse is an evening of misses, too dense and there's nowhere to hide a fleet.
    const reasonable = share >= 0.1 && share <= 0.35
    if (!sane || !reasonable) ok = false
    rows.push(`${n}x${n} ${fleet.length}sh ${squares}sq ${Math.round(share * 100)}%`)
  }
  check(`${preset}: every board size gets a placeable, sensibly dense fleet`, ok, rows.join('  |  '))
}

check(
  'Same board and preset always give the same fleet',
  BOARD_SIZES.every((n) =>
    Object.keys(FLEET_PRESETS).every(
      (p) => JSON.stringify(fleetFor(n, p)) === JSON.stringify(fleetFor(n, p))
    )
  )
)
check(
  'An unknown preset falls back rather than dealing an empty fleet',
  fleetFor(10, 'Nonsense').length > 0
)

/**
 * The per-set board-size ceiling: no size a lobby offers may deal a square twice, and the size just
 * past the ceiling must actually be the reason it doesn't.
 *
 * The second half is the part worth having. A cap that is merely SAFE is easy - cap everything at
 * 5x5 - and the failure this guards against is the quiet one where a set grows a few squares and
 * its ceiling stops moving, so hosts keep being denied a board the set could now fill.
 *
 * Counted in distinct SQUARES rather than distinct rendered names, which is not the same thing and
 * is how the first version of this check managed to fail on a set that was fine: a bingo square
 * whose whole name is a %variable% - the Scadu League has six - reads differently in every cell it
 * lands in, so no comparison of names can tell one square dealt three times from three squares. The
 * set's own picker answers it instead: relaxedFill for the bingo sets, the list length for the flat
 * ones, so the number is what the deal actually had to work with.
 */
console.log('\n=== Board sizes each set can carry ===\n')
const SET_POOLS: Array<[string, number, (cells: number) => number]> = [
  ['bosses', bosses.length, (cells) => Math.min(bosses.length, cells)],
  ['bosses-2v2', bosses2v2.length, (cells) => Math.min(bosses2v2.length, cells)],
  ['ringus', ringus.length, (cells) => Math.min(ringus.length, cells)],
  ['objectives', objectives.squares.length, (cells) => relaxedFill(objectives, cells)],
  ['objectives-base', rookie.squares.length, (cells) => relaxedFill(rookie, cells)],
  ['objectives-dlc', scadu.squares.length, (cells) => relaxedFill(scadu, cells)],
]

for (const [id, pool, distinct] of SET_POOLS) {
  const cap = largestBoardFor(pool, BOARD_SIZES)
  const biggest = BOARD_SIZES[BOARD_SIZES.length - 1]

  // Every size the lobby offers fills entirely out of the pool, so no cell has to reuse a square.
  const dirty = BOARD_SIZES.filter((n) => n <= cap && distinct(n * n) < n * n)
  check(
    `${id} (${pool} squares): distinct squares throughout, every size up to ${cap}x${cap}`,
    dirty.length === 0,
    dirty.map((n) => `${n}x${n} fills only ${distinct(n * n)} of ${n * n}`).join(', ')
  )

  if (cap < biggest) {
    const next = BOARD_SIZES[BOARD_SIZES.indexOf(cap) + 1]
    const tooLow = distinct(next * next) === next * next
    check(
      `${id} is capped at ${cap}x${cap} because ${next}x${next} would repeat squares`,
      !tooLow,
      tooLow ? `${next}x${next} fills cleanly from ${pool} squares - the cap is a size too low` : ''
    )
  } else {
    check(`${id} reaches the biggest board offered (${cap}x${cap})`, distinct(cap * cap) === cap * cap)
  }
}

// The sprite is looked up by name, so a hull the art folder doesn't have renders as nothing at
// all - which is how a 5x5 board came to show two ships instead of three.
//
// Extension-agnostic on purpose. This read used to strip '.png' specifically, so the day the hulls were
// redrawn as SVG it reported every ship as artless - a check that fails for a reason that has nothing to
// do with what it is checking. What it actually cares about is that a file exists per hull NAME.
const SHIP_ART = new Set(
  readdirSync(new URL('../public/ships/', import.meta.url)).map((f) => f.replace(/\.[a-z0-9]+$/i, ''))
)
const nameless = new Set<string>()
for (const n of BOARD_SIZES) {
  for (const preset of Object.keys(FLEET_PRESETS)) {
    for (const ship of fleetFor(n, preset)) {
      if (!SHIP_ART.has(ship.name.toLowerCase())) nameless.add(`${ship.name} (${n}x${n} ${preset})`)
    }
  }
}
check(
  `Every ship a fleet can contain has artwork (${[...SHIP_ART].sort().join(', ')})`,
  nameless.size === 0,
  [...nameless].join(', ')
)

console.log('\n' + '='.repeat(70))
console.log(`${passed} passed, ${failed} failed`)
console.log('='.repeat(70))
// exitCode rather than exit(): process.exit() during Node's teardown trips a libuv assertion on
// Windows, which prints an alarming "Assertion failed" line under an otherwise passing run.
process.exitCode = failed === 0 ? 0 : 1
