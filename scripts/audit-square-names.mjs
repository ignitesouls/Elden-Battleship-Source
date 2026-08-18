/**
 * Finds archived square names that no longer exist, so nothing quietly stops being counted.
 *
 *   node scripts/audit-square-names.mjs
 *
 * `challenge_name` is a square's identity in `match_events`, and it is a plain string with no key
 * behind it. Rename a square in its set file and every row archived before that moment goes on
 * saying the old thing - so the Almanac, the record book and the career pages all see two squares
 * where there is one, each holding half the history.
 *
 * RENAMED_SQUARES (src/lib/squareSetFormat.ts) is what stitches those two halves back together. This
 * script is how you find out an entry is MISSING from it: it reads every distinct name the archive
 * actually holds, folds it through canonicalSquareName, and reports the ones that still don't match
 * any square in the set they were played on.
 *
 * Every orphan it prints is history that is currently uncounted. Add it to RENAMED_SQUARES pointing
 * at whatever the square is called today, and re-run until this is clean.
 *
 * Run it after ANY rename, and before regenerating bossReachability.json - board balancing is
 * measured off this same archive, and a match whose names don't reconcile is thrown out of that
 * measurement whole. See scripts/build-reachability.mjs.
 *
 * Read-only, over the anon key, like the other check-* scripts that touch the live database.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canonicalSquareName, RENAMED_SQUARES } from "../src/lib/squareSetFormat.ts";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(new URL(path, import.meta.url), "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const env = loadEnv("../.env.local");
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const read = (file) => JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url), "utf8"));

/**
 * Every name a set can put on a square, with its `%var%` placeholders expanded.
 *
 * The bingo sets author one square as "Kill %demiNum% Unique Demi-Human Bosses" and archive it as
 * "Kill 4 ..." or "Kill 5 ...", so comparing against the raw name would report every variable square
 * in the archive as an orphan. Expanding every combination is exact and cheap - the sets have a
 * handful of such squares and at most three values each.
 */
function namesOf(file) {
  const raw = read(file);
  const squares = Array.isArray(raw) ? raw : raw.squares;
  const out = new Set();
  for (const square of squares) {
    let forms = [square.name];
    for (const [key, value] of Object.entries(square)) {
      if (!Array.isArray(value) || !square.name.includes(`%${key}%`)) continue;
      forms = forms.flatMap((form) => value.map((v) => form.replaceAll(`%${key}%`, String(v))));
    }
    for (const form of forms) out.add(form);
  }
  return out;
}

// Mirrors SQUARE_SETS. Duplicated rather than imported because squareSets.ts imports a dozen JSON
// files through the bundler's resolver, and this only needs the names. Variants are keyed by their
// own id, because that is what `square_set` holds on their archived rows.
const SETS = {
  bosses: namesOf("battleshipChallenges.json"),
  "bosses-2v2": namesOf("battleshipChallenges2v2.json"),
  objectives: namesOf("incursionSquares.json"),
  "objectives-base": namesOf("rookieRumbleSquares.json"),
  "objectives-dlc": namesOf("scaduLeagueSquares.json"),
  ringus: namesOf("ringusSquares.json"),
};

// PostgREST caps a response at 1000 rows however large the requested limit.
const rows = [];
for (let page = 0; page < 200; page++) {
  const { data, error } = await supabase
    .from("match_events")
    .select("match_key, challenge_name, square_set")
    .order("match_key", { ascending: true })
    .range(page * 1000, page * 1000 + 999);
  if (error) {
    console.log(`FAIL  could not read match_events: ${error.message}`);
    process.exit(1);
  }
  rows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

/** setId -> name -> { rows, matches }. A name on one match is a different problem from one on ten. */
const seen = new Map();
for (const row of rows) {
  if (!row.challenge_name) continue;
  const setId = row.square_set ?? "bosses";
  if (!seen.has(setId)) seen.set(setId, new Map());
  const names = seen.get(setId);
  if (!names.has(row.challenge_name)) names.set(row.challenge_name, { rows: 0, matches: new Set() });
  const entry = names.get(row.challenge_name);
  entry.rows++;
  entry.matches.add(row.match_key);
}

let orphanRows = 0;
const orphans = [];
const folded = [];
let live = 0;

for (const [setId, names] of [...seen].sort()) {
  const known = SETS[setId];
  for (const [name, entry] of [...names].sort()) {
    const canonical = canonicalSquareName(name);
    // A set this build doesn't know about can't be checked against anything, so its rows are
    // reported rather than silently passed - an id that stopped existing orphans a whole set at once.
    if (!known) {
      orphans.push(`${setId} / "${name}" - unknown square set (${entry.rows} rows)`);
      orphanRows += entry.rows;
      continue;
    }
    if (known.has(canonical)) {
      if (canonical !== name) folded.push(`${setId} / "${name}" -> "${canonical}" (${entry.rows} rows, ${entry.matches.size} matches)`);
      live++;
      continue;
    }
    orphans.push(`${setId} / "${name}" (${entry.rows} rows, ${entry.matches.size} matches)`);
    orphanRows += entry.rows;
  }
}

console.log(`\n${rows.length} archived event rows, ${[...seen.values()].reduce((n, m) => n + m.size, 0)} distinct square names\n`);
console.log(`  ${live} resolve to a square that exists today`);
console.log(`  ${folded.length} of those only because RENAMED_SQUARES folded them`);
console.log(`  ${orphans.length} do not (${orphanRows} rows)`);

if (folded.length) {
  console.log("\nfolded by RENAMED_SQUARES:");
  for (const line of folded) console.log(`  ${line}`);
}

// Entries that no longer fold anything are worth knowing about too - either the rows were pruned, or
// the key was never the string the archive actually held. Harmless, but it means the map is fiction.
const usedKeys = new Set(folded.map((line) => line.match(/"(.+?)" ->/)?.[1]));
const unusedKeys = Object.keys(RENAMED_SQUARES).filter((key) => !usedKeys.has(key));
if (unusedKeys.length) {
  console.log(`\nRENAMED_SQUARES entries matching nothing in the archive (${unusedKeys.length}):`);
  for (const key of unusedKeys) console.log(`  "${key}" -> "${RENAMED_SQUARES[key]}"`);
}

if (orphans.length) {
  console.log("\nUNCOUNTED - no square by this name exists, and nothing maps it to one:");
  for (const line of orphans) console.log(`  ${line}`);
  console.log("\nAdd each to RENAMED_SQUARES in src/lib/squareSetFormat.ts, then re-run.");
}

console.log(`\n${orphans.length === 0 ? "PASS" : "FAIL"}  every archived square name still counts toward a square\n`);
process.exit(orphans.length === 0 ? 0 : 1);
