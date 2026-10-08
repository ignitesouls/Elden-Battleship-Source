/**
 * Puts a late-added boss square into play from this moment - or back on hold.
 *
 *   node scripts/release-square.mjs Devonia            in from now
 *   node scripts/release-square.mjs Devonia pending    on hold again
 *
 * A late square carries `dealtFrom` in battleshipChallenges.json and, if it is in the small-crew cut,
 * in battleshipChallenges2v2.json too. Boards dealt before that instant never see it, so nothing
 * already dealt changes - see squareSetFormat.dealtPool. This stamps the current time into both lists,
 * the same value in each, because a square live on one cut and not the other would be two rules for
 * one boss.
 *
 * It edits two files and runs the board checks. It does not commit, push, migrate or deploy: those
 * stay manual, and it prints them in the order they have to happen.
 *
 * -- Run it right before deploying, at a quiet moment --------------------------------------------
 *
 * The stamp is "now", but the code that knows about it only exists once deployed. A board rolled in
 * between - and any board rolled by a tab left open from before the deploy - is dealt by code that
 * still thinks the square is pending, then rebuilt by code that knows it went live: the two disagree
 * and that board reads wrong. So: no live matches, run this, deploy straight after.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LISTS = [
  new URL("../src/data/battleshipChallenges.json", import.meta.url),
  new URL("../src/data/battleshipChallenges2v2.json", import.meta.url),
];
const PROJECT_REF = "zltjdeikpsbohvgtmmsn";

const [name, mode] = process.argv.slice(2);

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!name || (mode !== undefined && mode !== "pending")) {
  fail("Usage: node scripts/release-square.mjs <square name> [pending]\n" +
    "  e.g. node scripts/release-square.mjs Devonia");
}

// Stored in UTC, the form every reader parses the same way.
const value = mode === "pending" ? "pending" : new Date().toISOString();

// Edited as text, one line, so the files keep their exact formatting and diff as a one-line change.
const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOnLine = new RegExp(`"name"\\s*:\\s*"${escaped}"`);
const dealtFromOnLine = /("dealtFrom"\s*:\s*")[^"]*(")/;

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
  if (hits.length > 1) fail(`${short} has ${hits.length} squares named "${name}". Fix that before releasing.`);
  const i = hits[0];
  if (!dealtFromOnLine.test(lines[i])) {
    fail(`"${name}" in ${short} has no dealtFrom, so it is an original square and is always dealt.\n` +
      `Only a square added later can be released - giving an original one a date would re-deal every board.`);
  }
  const before = lines[i].match(dealtFromOnLine)[0].replace(/"dealtFrom"\s*:\s*/, "");
  lines[i] = lines[i].replace(dealtFromOnLine, `$1${value}$2`);
  writeFileSync(file, lines.join(newline));
  // The file must still be valid JSON with the value where it was put.
  const square = JSON.parse(readFileSync(file, "utf8")).find((c) => c.name === name);
  if (square?.dealtFrom !== value) fail(`Wrote ${short} but could not read the new value back. Check it by hand.`);
  console.log(`  ${short}: ${before} -> "${value}"`);
  foundIn++;
}
if (foundIn === 0) fail(`No square named "${name}" in either boss list.`);

console.log("\nRunning the board checks...");
try {
  execFileSync(process.execPath, ["--experimental-strip-types", "scripts/check-boards.ts"], {
    stdio: "pipe",
    cwd: new URL("..", import.meta.url),
  });
  console.log("  check-boards passed - no board dealt before now re-deals.");
} catch (err) {
  console.log(String(err.stdout ?? "").split("\n").filter((l) => l.includes("FAIL")).join("\n"));
  fail(`check-boards FAILED - do not ship this. To undo: node scripts/release-square.mjs ${name} pending`);
}

if (value === "pending") {
  console.log(`\n${name} is on hold again: no board deals it. Ship the change the usual way for it to take effect.\n`);
  process.exit(0);
}

console.log(`
${name} is in from ${value} (UTC): any board rolled from now on can deal it.

Nothing has been deployed. Send it out now, in this order:

  1. The database column the archive needs (skip if already applied):
       npx supabase db push --project-ref ${PROJECT_REF}
  2. The four functions that deal boards:
       npx supabase functions deploy auto-fire balance-board balance-stats battle-ratings --project-ref ${PROJECT_REF}
  3. Commit and push the source, then build and deploy the site (README, "Deploying").

Changed your mind before deploying? node scripts/release-square.mjs ${name} pending
`);
