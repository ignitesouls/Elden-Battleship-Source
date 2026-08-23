/**
 * The two marker toggles, and the one distinction in them that is easy to get backwards.
 *
 * `mode` narrows the board by `defender_team` - whose board is drawn. The marker filter narrows by
 * `attacker_team` - whose shots are drawn on it. They are different fields answering different
 * questions, and on a composited board both are live at once. Getting them the wrong way round
 * produces a board that still looks plausible: squares are marked, just the wrong squares, and
 * nobody notices until a caster says "those are all Red's hits" over a picture of Blue's.
 *
 * Cheap to assert and impossible to eyeball, which is what this file is for. Run by `npm run check`.
 */
import { markedAttacks, spotSet } from "../src/lib/overlayMarkers.ts";
import type { Attack } from "../src/types/battleship.ts";

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}

/** Only the four fields the filter reads; the rest of an Attack is irrelevant here. */
const shot = (attacker: number, defender: number, cell: number, result: Attack["result"] = "hit") =>
  ({ attacker_team: attacker, defender_team: defender, cell_index: cell, result }) as Attack;

// Blue (1) and Red (2), each firing at the other. Deliberately symmetric, so a filter that used the
// wrong field would still return two rows and still look right by count alone.
const log = [shot(1, 2, 10), shot(2, 1, 11), shot(1, 2, 12), shot(2, 1, 13)];

console.log("\nmarkedAttacks - the on/off switch");
ok("an absent flag draws every marker", markedAttacks(log, {}).length === 4);
ok("markers:true draws every marker", markedAttacks(log, { markers: true }).length === 4);
ok("markers:false draws none", markedAttacks(log, { markers: false }).length === 0);

console.log("\nmarkedAttacks - the fleet filter");
ok("null means every fleet", markedAttacks(log, { markerTeams: null }).length === 4);
ok("an EMPTY list means every fleet, not none", markedAttacks(log, { markerTeams: [] }).length === 4);

const onlyBlue = markedAttacks(log, { markerTeams: [1] });
ok("filters by ATTACKER, not defender", onlyBlue.length === 2 && onlyBlue.every((a) => a.attacker_team === 1));
ok("...so no row is kept for being fired AT that fleet", !onlyBlue.some((a) => a.defender_team === 1));
ok("two fleets listed keeps both", markedAttacks(log, { markerTeams: [1, 2] }).length === 4);
ok("off beats a fleet filter", markedAttacks(log, { markers: false, markerTeams: [1] }).length === 0);

console.log("\nspotSet - optional two different ways on the wire");
ok("absent is an empty spotlight", spotSet({}).size === 0);
ok("null is an empty spotlight", spotSet({ spot: null }).size === 0);
ok("a list becomes a set", spotSet({ spot: [3, 4, 5] }).size === 3);
ok("...containing what it was given", spotSet({ spot: [3, 4, 5] }).has(4));
ok("a hull and a square are the same shape", spotSet({ spot: [7] }).size === 1);

console.log(fails === 0 ? "\nall overlay marker checks passed\n" : `\n${fails} overlay marker checks FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
