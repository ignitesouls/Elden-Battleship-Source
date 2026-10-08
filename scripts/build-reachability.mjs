/**
 * Regenerates src/data/bossReachability.json - how often each boss square actually gets fired at.
 *
 *   node scripts/build-reachability.mjs
 *
 * Reads every archived match out of Supabase with the anon key, rebuilds the board each one was
 * played on, and records, per square, the share of boards it appeared on where somebody fired at it.
 * The output is committed, like bossFlags.json and bossScaling.json, and regenerated deliberately -
 * see "Why this is frozen" below.
 *
 * -- What it measures, and why that turned out to be the thing worth measuring --------------------
 *
 * Board balancing needs a per-square cost, and the obvious candidate was er-overlay's `[N]`
 * progression number - which is a statement about how hard a boss is to KILL. That is not the
 * quantity that decides matches. What decides matches is whether a team can get to a square at all:
 * a fleet parked on Bayle is fired at on 13% of the boards it appears on, so it is close to
 * untouchable, while Starscourge Radahn - a far harder fight, three tiers later - is taken on every
 * single board. Measured against 51 archived matches, `[N]` and reachability correlate at r = -0.46:
 * the right sign, nowhere near tight enough to balance on.
 *
 * Reachability absorbs travel time, boss gating and prerequisite chains at once, without anyone
 * hand-authoring a dependency graph, because it measures the outcome those things produce rather
 * than the causes. It is also the fairness quantity directly: a fleet whose cells are rarely reached
 * is a fleet that rarely gets sunk.
 *
 * Two things it is NOT:
 *
 *   - It is not per-board. Promised Consort Radahn's 25% averages the boards where Messmer and
 *     Romina were also dealt with the boards where they were not; the number cannot express that
 *     split, and no permutation could fix it if it did, because which squares are in play is a
 *     property of the seed and not of the layout.
 *   - It cannot tell "could not reach" from "chose not to bother". Under fire-on-kill on a shared
 *     board those are nearly the same thing, but a square passed over as low-value scores like one
 *     that was out of reach.
 *
 * -- Why this is frozen rather than computed live -------------------------------------------------
 *
 * It is measured behaviour, so balancing on it moves it: even out the boards and teams route
 * differently, which changes the very numbers the balancing was drawn from. A table read live would
 * chase its own tail mid-season and, worse, would silently change how boards were dealt between two
 * matches of the same tournament. Committed and regenerated between seasons, it is a constant that
 * every match in a season shares - and one that can be diffed in review before it takes effect.
 *
 * -- Reading the archive --------------------------------------------------------------------------
 *
 * Boards are never stored, so the denominator has to be reconstructed: each match's (room id, square
 * set, seed, permutation) is replayed through the same seeded shuffle the clients use, exactly as
 * the Almanac replays it. That is what makes the denominator "boards this square was ON" rather than
 * "boards somebody logged it on" - the latter would score every square 100% by construction.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canonicalSquareName } from "../src/lib/squareSetFormat.ts";

const OUT = new URL("../src/data/bossReachability.json", import.meta.url);

/**
 * Minimum boards a square must have appeared on to be trusted.
 *
 * Below this the estimate is mostly noise - one lucky match moves a 5-board square by 20 points -
 * and a square that new is better served by the neutral prior than by its own thin evidence.
 */
const MIN_BOARDS = 8;

/**
 * What a square with too little evidence is worth: the mean over everything that has enough.
 *
 * Deliberately the mean rather than something pessimistic. A new square is not known to be hard to
 * reach, and guessing that it is would park it on the "expensive" side of every board it lands on
 * until the archive caught up.
 */
const PRIOR_LABEL = "board mean";

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

/**
 * Every cut of the boss board, keyed by the id its matches are archived under.
 *
 * Both count toward the same table. Reachability is a property of the SQUARE - how often a team
 * that had it on the board got to it - so a match on the small-crew cut is evidence about the 164
 * squares it shares with the full board, and dropping those matches would measure the balancer off
 * a shrinking share of the archive as small-crew play becomes the common case.
 */
const BOSS_SETS = {
  bosses: JSON.parse(
    readFileSync(new URL("../src/data/battleshipChallenges.json", import.meta.url), "utf8")
  ),
  "bosses-2v2": JSON.parse(
    readFileSync(new URL("../src/data/battleshipChallenges2v2.json", import.meta.url), "utf8")
  ),
};

const DEFAULT_SET = "bosses";

// Mirrors challengesForRoom()'s seeding. Duplicated here rather than imported for the reason
// check-history.mjs duplicates it: the registry binds a dozen JSON files, and this script only ever
// needs the boss branches - the default set from the bare room id, every other from `roomId:setId`.
function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mirrors squareSetFormat.dealtPool: a square added after this board was dealt was never in its pack.
function dealtPool(list, dealtAt) {
  const at = Date.parse(dealtAt ?? "");
  return list.filter((sq) => {
    if (sq.dealtFrom === undefined) return true;
    const from = Date.parse(sq.dealtFrom);
    return Number.isFinite(from) && Number.isFinite(at) && at >= from;
  });
}

function bossBoard(roomId, setId, cells, seed, perm, dealtAt) {
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`;
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base));
  const pool = dealtPool(BOSS_SETS[setId], dealtAt);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let out = [];
  for (let i = 0; i < cells; i++) out.push(pool[i % pool.length]);
  if (Array.isArray(perm) && perm.length === cells) out = perm.map((from) => out[from]);
  return out;
}

// PostgREST caps a response at 1000 rows however large the requested limit, so this pages rather
// than asking once and silently reading a tenth of the archive.
const rows = [];
for (let page = 0; page < 200; page++) {
  const { data, error } = await supabase
    .from("match_events")
    .select("match_key, room_id, cell_index, challenge_name, board_size, square_set, board_seed, board_perm, board_dealt_at")
    .order("match_key", { ascending: true })
    .order("cell_index", { ascending: true })
    .range(page * 1000, page * 1000 + 999);
  if (error) throw new Error(`match_events: ${error.message}`);
  rows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

const byMatch = new Map();
for (const row of rows) {
  if (!row.room_id || row.cell_index < 0) continue;
  if (!BOSS_SETS[row.square_set ?? DEFAULT_SET]) continue;
  if (!byMatch.has(row.match_key)) byMatch.set(row.match_key, []);
  byMatch.get(row.match_key).push(row);
}

const onBoard = new Map();
const firedOn = new Map();
let used = 0;
const rejected = [];

for (const [key, events] of byMatch) {
  const cells = events[0].board_size * events[0].board_size;
  const board = bossBoard(
    events[0].room_id,
    events[0].square_set ?? DEFAULT_SET,
    cells,
    events[0].board_seed,
    events[0].board_perm,
    events[0].board_dealt_at
  );

  // Trust a match only if the names it logged land where the rebuild puts them - a match dealt under
  // genuinely different rules agrees on nothing at all, which is the case worth excluding.
  //
  // Both sides are spoken in today's names. Renames are the one disagreement that is not evidence of
  // anything: "LG BKA" is "LG Black Knife", and an old match saying so is reconstructed perfectly.
  // Left unfolded they used to eat into the 0.8 margin, and the cost of crossing it is not a warning
  // but a match dropped from BOTH the numerator and the denominator of every square on its board -
  // which is a reachability table, and therefore a balancer, quietly measured off less history than
  // it thinks. See RENAMED_SQUARES, and audit-square-names.mjs for finding renames nobody recorded.
  const named = events.filter((e) => e.challenge_name);
  const agree = named.filter((e) => board[e.cell_index]?.name === canonicalSquareName(e.challenge_name)).length;
  if (named.length >= 3 && agree < named.length * 0.8) {
    rejected.push(`${key} (${agree}/${named.length} names agree)`);
    continue;
  }
  used++;

  for (const square of new Set(board.slice(0, cells).map((c) => c.tooltip))) {
    onBoard.set(square, (onBoard.get(square) ?? 0) + 1);
  }
  const fired = new Set();
  for (const e of events) {
    const square = board[e.cell_index];
    if (square) fired.add(square.tooltip);
  }
  for (const square of fired) firedOn.set(square, (firedOn.get(square) ?? 0) + 1);
}

if (used === 0) throw new Error("no archived boss matches could be reconstructed - refusing to write");

// -- the table -------------------------------------------------------------------------------
const measured = [];
for (const square of BOSS_SETS[DEFAULT_SET]) {
  const n = onBoard.get(square.tooltip) ?? 0;
  if (n >= MIN_BOARDS) measured.push((firedOn.get(square.tooltip) ?? 0) / n);
}
const prior = measured.reduce((s, x) => s + x, 0) / measured.length;

const table = {};
const thin = [];
for (const square of BOSS_SETS[DEFAULT_SET]) {
  const n = onBoard.get(square.tooltip) ?? 0;
  if (n < MIN_BOARDS) {
    thin.push(`${square.name} (${n} boards)`);
    table[square.tooltip] = Number(prior.toFixed(3));
    continue;
  }
  // Clamped away from 0 and 1. A square nobody has ever reached is not reached with probability
  // zero, and the balancer takes logs of these downstream; both ends need to stay finite.
  const p = (firedOn.get(square.tooltip) ?? 0) / n;
  table[square.tooltip] = Number(Math.min(0.99, Math.max(0.02, p)).toFixed(3));
}

const output = {
  _comment: [
    "GENERATED by scripts/build-reachability.mjs - do not edit by hand.",
    "Maps a boss square's tooltip to the share of archived boards it appeared on where it was fired at.",
    `Measured over ${used} archived matches; squares seen on fewer than ${MIN_BOARDS} boards fall back to the ${PRIOR_LABEL} (${prior.toFixed(3)}).`,
    "Used only to spot lopsided boards during balancing; it is never shown to players.",
    "Frozen on purpose: it is measured behaviour, so regenerate it BETWEEN seasons and never during one.",
  ],
  ...table,
};

writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);

const values = Object.values(table);
const band = (lo, hi) => values.filter((v) => v >= lo && v < hi).length;
console.log(`matches    ${used} used, ${rejected.length} rejected`);
for (const r of rejected) console.log(`  rejected ${r}`);
console.log(`squares    ${values.length}`);
console.log(`  0-20%  ${band(0, 0.2)}   20-40%  ${band(0.2, 0.4)}   40-60%  ${band(0.4, 0.6)}   60-80%  ${band(0.6, 0.8)}   80-100%  ${band(0.8, 1.01)}`);
console.log(`prior      ${prior.toFixed(3)} over ${measured.length} squares with >= ${MIN_BOARDS} boards`);
if (thin.length) console.log(`thin       ${thin.length} square(s) on the prior: ${thin.join(", ")}`);
console.log(`\nwrote ${OUT.pathname}`);
