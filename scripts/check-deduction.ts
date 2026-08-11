/**
 * Checks the "dead water" deduction - the squares the fire board crosses out because nothing still
 * afloat could be sitting on them.
 *
 * Worth its own script because the failure mode is silent and expensive: a square wrongly crossed
 * out is a square a fleet stops considering, and they'd never know why they lost the race to it. So
 * these cases are all about the boundary - a gap exactly as long as the shortest hull must stay
 * open, one square shorter must not.
 *
 * Run with bare Node (deduction.ts imports nothing at runtime):
 *
 *   node --experimental-strip-types scripts/check-deduction.ts
 */
import { ruledOutCells } from '../src/lib/deduction.ts'
import type { Attack, ShipDefinition } from '../src/types/battleship.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

const BOARD = 10
const cell = (r: number, c: number) => r * BOARD + c

let seq = 0
function shot(defender: number, index: number, result: Attack['result'], sunk?: Partial<Attack>): Attack {
  return {
    id: `a${seq++}`,
    room_id: 'r',
    cell_index: index,
    attacker_team: 0,
    defender_team: defender,
    attacker_player_id: null,
    result,
    sunk_ship_name: null,
    sunk_ship_size: null,
    sunk_start_row: null,
    sunk_start_col: null,
    sunk_horizontal: null,
    created_at: '',
    resolved_at: '',
    ...sunk,
  }
}

const ships = (...sizes: number[]): ShipDefinition[] => sizes.map((size, i) => ({ name: `S${i}`, size }))

/** Row 1 missed end to end, so nothing in row 0 can be covered by a vertical hull. */
function sealRow(defender: number, row: number): Attack[] {
  return Array.from({ length: BOARD }, (_, c) => shot(defender, cell(row, c), 'miss'))
}

const same = (a: Set<number>, b: number[]) =>
  a.size === b.length && b.every((x) => a.has(x))

// -- 1. nothing fired, nothing ruled out ----------------------------------
{
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5, 4), outgoing: [], opponentTeams: [1] })
  check('an untouched board rules nothing out', out.size === 0, `${out.size} squares`)
}

// -- 2. a gap shorter than the shortest hull is dead water ----------------
{
  const outgoing = [...sealRow(1, 1), shot(1, cell(0, 3), 'miss')]
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5, 4), outgoing, opponentTeams: [1] })
  check(
    'a 3-square gap is ruled out when the shortest hull left is 4',
    same(out, [cell(0, 0), cell(0, 1), cell(0, 2)]),
    [...out].sort((a, b) => a - b).join(',')
  )
}

// -- 3. a gap exactly as long as the shortest hull stays open -------------
{
  const outgoing = [...sealRow(1, 1), shot(1, cell(0, 4), 'miss')]
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5, 4), outgoing, opponentTeams: [1] })
  check('a gap of exactly 4 is NOT ruled out', out.size === 0, [...out].join(','))
}

// -- 4. sinking the small hulls raises the bar ----------------------------
{
  // A 5 and a 2. The 2 goes down, so nothing shorter than 5 is left to find, and the 4-gap that
  // survived case 3 is now dead.
  const sink = shot(1, cell(9, 1), 'sunk', {
    sunk_ship_name: 'S1',
    sunk_ship_size: 2,
    sunk_start_row: 9,
    sunk_start_col: 0,
    sunk_horizontal: true,
  })
  const outgoing = [...sealRow(1, 1), shot(1, cell(0, 4), 'miss'), sink]
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5, 2), outgoing, opponentTeams: [1] })
  check(
    'once only the 5 is left, the 4-gap is ruled out too',
    [cell(0, 0), cell(0, 1), cell(0, 2), cell(0, 3)].every((c) => out.has(c)),
    [...out].sort((a, b) => a - b).join(',')
  )
  check(
    "the sunk hull's own squares are not crossed out (they show a wreck)",
    !out.has(cell(9, 0)) && !out.has(cell(9, 1)),
    'sunk cells present in the ruled-out set'
  )
}

// -- 5. a square only has to be possible for ONE opponent -----------------
{
  // Same dead gap against team 1, but team 2 has never been fired at - so every square is still
  // live for them, and one shot hits both.
  const outgoing = [...sealRow(1, 1), shot(1, cell(0, 3), 'miss')]
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5, 4), outgoing, opponentTeams: [1, 2] })
  check('nothing is ruled out while another fleet could still be there', out.size === 0, `${out.size} squares`)
}

// -- 6. a fleet with nothing left afloat stops keeping squares open -------
{
  const sunkAll = [0, 1].map((i) =>
    shot(2, cell(8, i * 2), 'sunk', {
      sunk_ship_name: `S${i}`,
      sunk_ship_size: [5, 4][i],
      sunk_start_row: 8,
      sunk_start_col: i * 5,
      sunk_horizontal: true,
    })
  )
  const outgoing = [...sealRow(1, 1), shot(1, cell(0, 3), 'miss'), ...sunkAll]
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5, 4), outgoing, opponentTeams: [1, 2] })
  check(
    'a fleet whose hulls are all sunk no longer keeps the gap open',
    same(out, [cell(0, 0), cell(0, 1), cell(0, 2)]),
    [...out].sort((a, b) => a - b).join(',')
  )
}

// -- 7. a plain hit is not an obstruction ---------------------------------
{
  // The 3-gap from case 2, but the middle square is a HIT rather than open water. It belongs to
  // something still alive, so a hull can run through it - and the gap is 3 either way, so the two
  // squares beside it stay dead. What must NOT happen is the hit square itself being crossed out.
  const outgoing = [...sealRow(1, 1), shot(1, cell(0, 3), 'miss'), shot(1, cell(0, 1), 'hit')]
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5, 4), outgoing, opponentTeams: [1] })
  check(
    'a square already fired at is never crossed out on top of its result',
    !out.has(cell(0, 1)) && !out.has(cell(0, 3)),
    [...out].sort((a, b) => a - b).join(',')
  )
}

// -- 8. the whole board can go dead ---------------------------------------
{
  // Every square of row 0 open, everything else missed, shortest hull 5: row 0 is the only run long
  // enough, so nothing outside it survives - and every unfired square outside row 0 is fired at
  // already, so the answer is empty rather than "everything".
  const outgoing: Attack[] = []
  for (let r = 1; r < BOARD; r++) outgoing.push(...sealRow(1, r))
  const out = ruledOutCells({ boardSize: BOARD, shipDefs: ships(5), outgoing, opponentTeams: [1] })
  check('squares already fired at are excluded even when everything else is dead', out.size === 0, `${out.size}`)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
