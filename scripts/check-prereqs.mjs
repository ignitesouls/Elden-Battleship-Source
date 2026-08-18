/**
 * Validates src/data/bossPrereqs.json - the hand-authored table of what gates what.
 *
 *   node scripts/check-prereqs.mjs
 *
 * That file is the one input the archive cannot produce: timings say how long a fight takes, never
 * what has to be done before it can be attempted. It is therefore typed by hand, and a typo in it is
 * silent - a prerequisite naming a square that does not exist simply never matches, and the square it
 * was meant to protect goes on being priced as though nothing gated it.
 *
 * So this checks the two things that can go wrong without anyone noticing: a name that resolves to
 * nothing, and a location rule that catches nothing.
 */
import { readFileSync } from "node:fs";

const bosses = JSON.parse(
  readFileSync(new URL("../src/data/battleshipChallenges.json", import.meta.url), "utf8")
);
const prereqs = JSON.parse(readFileSync(new URL("../src/data/bossPrereqs.json", import.meta.url), "utf8"));

const names = new Set(bosses.map((b) => b.name));
/** The location half of a tooltip: everything after the last " - ". */
const placeOf = (tip) => (tip ?? "").split(" - ").slice(1).join(" - ");

/**
 * Placeholders that deliberately match no square. See the file's own notes.
 *
 * "long fight" is the one to be careful with: how long a fight takes is ALREADY measured, in
 * bossTimeCost.json, so charging it again here would double-count. It earns its place as an
 * annotation - a human saying "this square is expensive because of the fight, not the trip" - which
 * is exactly the sort of claim worth being able to check the measured number against.
 */
const PSEUDO = new Set(["long run", "long fight", "restore a great rune"]);

let problems = 0;
const warn = (msg) => {
  problems++;
  console.log(`  ${msg}`);
};

/** Every leaf of an AND/OR tree, flattened - nesting is about meaning, not about validity. */
function leaves(node) {
  return Array.isArray(node) ? node.flatMap(leaves) : [node];
}

console.log("\n-- square names on the left-hand side ------------------------------------------");
const keys = Object.keys(prereqs).filter((k) => !k.startsWith("_"));
for (const k of keys) if (!names.has(k)) warn(`"${k}" is not a square in battleshipChallenges.json`);
console.log(`  ${keys.length} squares carry an entry${problems === 0 ? ", all resolve" : ""}`);

console.log("\n-- prerequisites -------------------------------------------------------------");
const before = problems;
const unresolved = new Map();
for (const [k, v] of Object.entries(prereqs)) {
  if (k.startsWith("_")) continue;
  for (const leaf of leaves(v)) {
    if (names.has(leaf) || PSEUDO.has(leaf)) continue;
    if (!unresolved.has(leaf)) unresolved.set(leaf, []);
    unresolved.get(leaf).push(k);
  }
}
for (const [leaf, users] of unresolved) {
  warn(`"${leaf}" matches no square and is not a known placeholder - needed by ${users.join(", ")}`);
}
if (problems === before) console.log("  every prerequisite resolves to a square or a placeholder");

console.log("\n-- location rules ------------------------------------------------------------");
for (const [place, rule] of Object.entries(prereqs._locations ?? {})) {
  const hits = bosses.filter((b) => placeOf(b.tooltip).includes(place));
  if (hits.length === 0) {
    warn(`"${place}" matches no square's location - check the spelling against a tooltip`);
    continue;
  }
  for (const leaf of leaves(rule)) {
    if (!names.has(leaf) && !PSEUDO.has(leaf)) {
      warn(`location "${place}" requires "${leaf}", which matches no square`);
    }
  }
  console.log(`  ${String(hits.length).padStart(3)} squares  ${place.padEnd(24)} -> ${leaves(rule).join(", ")}`);
}

console.log("\n-- coverage ------------------------------------------------------------------");
const covered = new Set(keys);
for (const place of Object.keys(prereqs._locations ?? {})) {
  for (const b of bosses) if (placeOf(b.tooltip).includes(place)) covered.add(b.name);
}
console.log(`  ${covered.size} of ${bosses.length} squares now carry a prerequisite`);
console.log(`  ${bosses.length - covered.size} have none, and are priced on their fight time alone`);

console.log(
  problems === 0
    ? "\nPASS  bossPrereqs.json resolves cleanly\n"
    : `\nFAIL  ${problems} problem(s) above\n`
);
process.exitCode = problems === 0 ? 0 : 1;
