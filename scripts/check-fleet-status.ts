/**
 * Checks the one answer to "what has this fleet lost" - lib/battleshipLogic.sunkHullFlags.
 *
 * Worth its own script because this exact bug has now been written three times and fixed three
 * times, in three different files, and the third one shipped. Ship names are not unique within a
 * fleet: fleetFor() draws from the five hulls that have sprite art and repeats the pattern until it
 * fills the board, so fifteen of the thirty board/preset combinations field a duplicate name. Any
 * code that identifies a hull by what it was CALLED gets those fleets wrong.
 *
 * What it cost the last time: a player's own roster read "0/7 afloat" while two of their seven
 * ships were still alive and firing, because five sinkings - one per distinct name - had struck out
 * all seven entries. That went unnoticed long enough for a player to report the whole panel as
 * broken, and half of every match in the archive is on a fleet that can hit it.
 *
 * The two traps, which want opposite handling and are why one shared function exists:
 *
 *   - duplicate NAMES within a fleet. Two Destroyers, one sunk, must strike out exactly one.
 *   - duplicate REPORTS for one hull. A second shot at a settled square copies the first verdict,
 *     geometry and all (see the 20260803 migration), so the same hull can produce two 'sunk' rows.
 *     Those must strike out one hull between them, not two.
 *
 * Run with bare Node (battleshipLogic imports only types):
 *
 *   node --experimental-strip-types scripts/check-fleet-status.ts
 */
import { sunkHullFlags } from '../src/lib/battleshipLogic.ts'
import { fleetFor, FLEET_PRESETS, BOARD_SIZES } from '../src/types/battleship.ts'
import type { Attack, ShipDefinition } from '../src/types/battleship.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

let seq = 0
/** A resolved 'sunk' row against `defender`, carrying the geometry resolve_attack() records. */
function sunk(defender: number, def: ShipDefinition, startRow: number, startCol: number): Attack {
  return {
    id: `a${seq++}`,
    room_id: 'r',
    cell_index: startRow * 10 + startCol,
    attacker_team: 0,
    defender_team: defender,
    attacker_player_id: null,
    result: 'sunk',
    sunk_ship_name: def.name,
    sunk_ship_size: def.size,
    sunk_start_row: startRow,
    sunk_start_col: startCol,
    sunk_horizontal: true,
    created_at: '',
    resolved_at: '',
  }
}

const afloat = (flags: boolean[]) => flags.filter((f) => !f).length
const shown = (flags: boolean[], defs: ShipDefinition[]) =>
  defs.map((d, i) => `${d.name}${flags[i] ? '(sunk)' : ''}`).join(',')

// -- 1. an untouched fleet is wholly afloat -------------------------------
{
  const defs = fleetFor(10, 'Armada')
  const flags = sunkHullFlags([], 1, defs)
  check('nothing sunk leaves every hull afloat', afloat(flags) === defs.length, `${afloat(flags)}/${defs.length}`)
}

// -- 2. duplicate names: one Destroyer down must not take the other -------
{
  // 10x10 Armada is the seven-hull fleet the bug was reported on: two Carriers, two Destroyers.
  const defs = fleetFor(10, 'Armada')
  const dupe = defs.findIndex((d, i) => defs.findIndex((o) => o.name === d.name) !== i)
  check('the reported fleet really does repeat a name', dupe > 0, shown(defs.map(() => false), defs))

  const twin = defs[dupe]
  const flags = sunkHullFlags([sunk(1, twin, 0, 0)], 1, defs)
  check(
    `sinking one ${twin.name} strikes out exactly one hull`,
    flags.filter(Boolean).length === 1,
    shown(flags, defs)
  )
  check(
    `sinking one ${twin.name} leaves ${defs.length - 1} afloat`,
    afloat(flags) === defs.length - 1,
    `${afloat(flags)}/${defs.length}`
  )
}

// -- 3. the exact failure a player reported: 0/7 with ships still alive ---
{
  const defs = fleetFor(10, 'Armada')
  // One hull of each distinct name, which is what the old name-Set counted as the whole fleet.
  const first = new Map<string, ShipDefinition>()
  for (const d of defs) if (!first.has(d.name)) first.set(d.name, d)
  const log = [...first.values()].map((d, i) => sunk(1, d, i, 0))

  const flags = sunkHullFlags(log, 1, defs)
  const expected = defs.length - first.size
  check(
    `${first.size} sinkings across ${defs.length} hulls leaves ${expected} afloat, not 0`,
    afloat(flags) === expected,
    `${afloat(flags)}/${defs.length} - ${shown(flags, defs)}`
  )
  check('and the fleet is therefore NOT eliminated', afloat(flags) > 0)
}

// -- 4. duplicate reports for one hull count once -------------------------
{
  const defs = fleetFor(10, 'Armada')
  const hull = defs[0]
  // Same hull, same geometry, reported twice - a second crew firing at a square already settled.
  const log = [sunk(1, hull, 3, 4), sunk(1, hull, 3, 4)]
  const flags = sunkHullFlags(log, 1, defs)
  check(
    'one hull reported sunk twice strikes out one hull',
    flags.filter(Boolean).length === 1,
    shown(flags, defs)
  )
}

// -- 5. two DIFFERENT hulls sharing a name both count ---------------------
{
  const defs = fleetFor(10, 'Armada')
  const name = defs.find((d, i) => defs.findIndex((o) => o.name === d.name) !== i)!
  const both = defs.filter((d) => d.name === name.name)
  const log = both.map((d, i) => sunk(1, d, i, 7))
  const flags = sunkHullFlags(log, 1, defs)
  check(
    `both ${name.name}s down strikes out ${both.length} hulls`,
    flags.filter(Boolean).length === both.length,
    shown(flags, defs)
  )
}

// -- 6. one team's losses never leak into another's -----------------------
{
  const defs = fleetFor(10, 'Armada')
  const log = [sunk(1, defs[0], 0, 0), sunk(2, defs[1], 5, 5)]
  const mine = sunkHullFlags(log, 1, defs)
  const theirs = sunkHullFlags(log, 2, defs)
  check('team 1 is charged only its own loss', mine.filter(Boolean).length === 1, shown(mine, defs))
  check('team 2 is charged only its own loss', theirs.filter(Boolean).length === 1, shown(theirs, defs))
  check('and they are different hulls', mine.findIndex(Boolean) !== theirs.findIndex(Boolean))
}

// -- 7. rows with no geometry still count, one per report -----------------
{
  // resolve_attack() only writes geometry when the fleet had placements to read. A row from before
  // that column existed has nothing to key on, so it is trusted as-is rather than de-duplicated.
  const defs = fleetFor(10, 'Armada')
  const bare = { ...sunk(1, defs[0], 0, 0), sunk_start_row: null, sunk_start_col: null }
  const flags = sunkHullFlags([bare], 1, defs)
  check('a geometry-less sunk row still strikes out a hull', flags.filter(Boolean).length === 1)
}

// -- 8. a full sweep of the fleet reads as eliminated ----------------------
{
  const defs = fleetFor(12, 'Armada') // ten hulls, five names - the worst case in the table
  const log = defs.map((d, i) => sunk(1, d, i, 0))
  const flags = sunkHullFlags(log, 1, defs)
  check('every hull sunk leaves nothing afloat', afloat(flags) === 0, `${afloat(flags)}/${defs.length}`)
}

// -- 9. every board and preset the game can deal --------------------------
//
// The sweep that would have caught this in the first place. For each fleet the game can actually
// build, sink one hull at a time and assert the count falls by exactly one each time - which is the
// property the name-Set broke and the only one that matters on screen.
{
  let worst = ''
  let bad = 0
  let combos = 0
  for (const board of BOARD_SIZES as unknown as number[]) {
    for (const preset of Object.keys(FLEET_PRESETS)) {
      const defs = fleetFor(board, preset)
      combos++
      const log: Attack[] = []
      for (let i = 0; i < defs.length; i++) {
        log.push(sunk(1, defs[i], i, 0))
        const left = afloat(sunkHullFlags(log, 1, defs))
        if (left !== defs.length - (i + 1)) {
          bad++
          if (!worst) worst = `${board}x${board} ${preset}: after ${i + 1} sinkings, ${left} afloat of ${defs.length}`
          break
        }
      }
    }
  }
  check(`every hull sunk drops the count by one, across all ${combos} board/preset fleets`, bad === 0, worst)
}

console.log(failures === 0 ? '\nall fleet status checks passed' : `\n${failures} fleet status check(s) failed`)
if (failures > 0) process.exit(1)
