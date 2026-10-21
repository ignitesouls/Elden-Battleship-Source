/**
 * Takes a boss square out of the deal from this moment, with a note on why - or puts it back.
 *
 *   node scripts/hold-square.mjs Romina "a Dionysus bug related to her interactions with PCR."    out from now
 *   node scripts/hold-square.mjs Romina "a Dionysus bug..." --fr "d'un bug de Dionysus..."       with French
 *   node scripts/hold-square.mjs Romina return                                                   back from now
 *
 * The note finishes a sentence: the lobby says "<name> is out for now, due to <note>" (French:
 * "<name> est retiré pour l'instant, en raison <noteFr>", so the French note brings its own "de"/"d'").
 *
 * For a square that can't be finished through no fault of the players - a boss the tracker can't see
 * die. It is a hold, not a cut: the square stays in the list, gains a `holds` entry, and comes back
 * with `return`. Boards dealt before the hold keep it, boards dealt during it never have it, and
 * boards dealt after the return have it again - see squareSetFormat.dealtPool. So nothing already
 * dealt changes, live or archived.
 *
 * The hold goes on both boss lists wherever the square is in them, with the same stamp, because a
 * boss out of one cut and in the other would be two rules for one boss.
 *
 * Changing a boss list makes two generated files stale, so this rebuilds them too: the official pool
 * cutoffs (official boards are vetted against the pool as it now stands) and the battle-ratings
 * bundle (which carries the lists). Then it runs the board and pool checks. It does not commit, push
 * or deploy: those stay manual, and it prints them in the order they have to happen.
 *
 * -- Run it right before deploying, at a quiet moment --------------------------------------------
 *
 * Same reason as release-square.mjs: the stamp is "now", but only the deployed code knows about it.
 * A board rolled in between is dealt by code that still has the square, then rebuilt by code that
 * says it was held, and that board reads wrong. So: no live matches, run this, deploy straight after.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LISTS = [
  new URL("../src/data/battleshipChallenges.json", import.meta.url),
  new URL("../src/data/battleshipChallenges2v2.json", import.meta.url),
];
const PROJECT_REF = "zltjdeikpsbohvgtmmsn";
const ROOT = new URL("..", import.meta.url);

const args = process.argv.slice(2);
const frAt = args.indexOf("--fr");
const noteFr = frAt >= 0 ? args[frAt + 1] : undefined;
const [name, noteOrReturn] = frAt >= 0 ? args.filter((_, i) => i !== frAt && i !== frAt + 1) : args;
const returning = noteOrReturn === "return";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!name || !noteOrReturn || (frAt >= 0 && !noteFr)) {
  fail('Usage: node scripts/hold-square.mjs <square name> "<finishes: is out for now, due to ...>" [--fr "<finit : en raison ...>"]\n' +
    "       node scripts/hold-square.mjs <square name> return");
}

// Stored in UTC, the form every reader parses the same way.
const now = new Date().toISOString();

/** The lists' own one-line style - `{"name": "X", "region": "dlc"}` - so the change diffs as one line. */
function oneLine(value) {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOnLine = new RegExp(`"name"\\s*:\\s*"${escaped}"`);

let foundIn = 0;
for (const file of LISTS) {
  const text = readFileSync(file, "utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(newline);
  const hits = lines.map((line, i) => (nameOnLine.test(line) ? i : -1)).filter((i) => i >= 0);
  const short = file.pathname.split("/").pop();
  if (hits.length === 0) {
    console.log(`  ${short}: no "${name}" square - left alone`);
    continue;
  }
  if (hits.length > 1) fail(`${short} has ${hits.length} squares named "${name}". Fix that before holding it.`);
  const i = hits[0];
  const [, indent, body, comma] = lines[i].match(/^(\s*)(\{.*\})(,?)\s*$/) ?? [];
  if (!body) fail(`"${name}" in ${short} is not on one line of its own. Edit it by hand.`);
  const square = JSON.parse(body);
  const holds = square.holds ?? [];
  const open = holds.find((h) => h.until === undefined);
  if (returning) {
    if (!open) fail(`"${name}" in ${short} is not on hold, so there is nothing to return.`);
    open.until = now;
  } else {
    if (open) fail(`"${name}" in ${short} is already on hold since ${open.from} ("${open.note}").`);
    holds.push({ from: now, note: noteOrReturn, ...(noteFr ? { noteFr } : {}) });
  }
  square.holds = holds;
  lines[i] = `${indent}${oneLine(square)}${comma}`;
  writeFileSync(file, lines.join(newline));
  // The file must still be valid JSON with the hold where it was put.
  const back = JSON.parse(readFileSync(file, "utf8")).find((c) => c.name === name);
  if (JSON.stringify(back?.holds) !== JSON.stringify(holds)) fail(`Wrote ${short} but could not read the hold back. Check it by hand.`);
  console.log(`  ${short}: ${returning ? `back in from ${now}` : `held from ${now} - ${noteOrReturn}`}`);
  foundIn++;
}
if (foundIn === 0) fail(`No square named "${name}" in either boss list.`);

// Every file this script writes, back to the last commit.
const undo =
  "git checkout -- src/data/battleshipChallenges.json src/data/battleshipChallenges2v2.json " +
  "src/data/officialPoolCutoffs.json supabase/functions/battle-ratings/ratingCode.generated.js";

function run(label, file, ...rest) {
  console.log(`  ${label}...`);
  try {
    return execFileSync(process.execPath, [...(file.endsWith(".ts") ? ["--experimental-strip-types"] : []), file, ...rest], {
      stdio: "pipe",
      cwd: ROOT,
    }).toString();
  } catch (err) {
    console.log(String(err.stdout ?? "").split("\n").filter((l) => l.includes("FAIL")).join("\n"));
    fail(`${label} FAILED - do not ship this. To back out: ${undo}`);
  }
}

console.log("\nRebuilding what the boss lists feed...");
run("official pool cutoffs", "scripts/build-pool-cutoffs.ts");
run("battle-ratings bundle", "scripts/build-rating-bundle.mjs");
console.log("\nRunning the checks...");
run("check-boards", "scripts/check-boards.ts");
run("check-official-pool", "scripts/check-official-pool.ts");
console.log("  all passed - no board dealt before now re-deals.");

console.log(`
${name} is ${returning ? "back in" : "on hold"} from ${now} (UTC): ${
  returning ? "any board rolled from now on can deal it again" : "no board rolled from now on deals it"
}.

Nothing has been deployed. Send it out now, in this order:

  1. The six functions that deal boards:
       npx supabase functions deploy auto-fire balance-board balance-stats battle-ratings official-seed bot --project-ref ${PROJECT_REF}
  2. Commit and push the source, then build and deploy the site (README, "Deploying").

Changed your mind before deploying? ${undo}
`);
