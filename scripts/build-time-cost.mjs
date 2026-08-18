/**
 * Regenerates src/data/bossTimeCost.json - how many minutes of a match each boss square costs.
 *
 *   node scripts/build-time-cost.mjs
 *
 * Replaces bossReachability.json as the balancer's cost model. Same provenance rules: read out of
 * the archive, committed, and regenerated deliberately between seasons rather than computed live.
 *
 * -- Why minutes rather than a probability --------------------------------------------------------
 *
 * Reachability asked "what share of boards does this square get fired at on", which turned out to
 * answer a subtly wrong question and to answer it with contaminated data.
 *
 * Wrong question, because a square is not improbable - it is EXPENSIVE. Bayle was priced at 0.133,
 * which reads as "almost nobody gets there". What the timings actually say is that Bayle takes a
 * median of 83:45 in a format whose median match is 81:45. It is not out of reach; it costs slightly
 * more than a whole match. That is a quantity a caster can say out loud and a player can argue with,
 * and - unlike a share - it can be compared against how long a game actually lasts.
 *
 * Contaminated data, because a share counts a match that ENDED before the square came up as evidence
 * that the square is unreachable. Matches end early when a team is losing, and a team loses faster on
 * a lopsided board - so the old table learned from unfair games and then encoded their symptoms as
 * the cost model meant to prevent them. Squares were partly expensive BECAUSE previous boards were
 * bad.
 *
 * -- How the censoring is handled -----------------------------------------------------------------
 *
 * A match that ends before a square is done is a right-censored observation, not a failure: all it
 * says is "this took longer than N minutes". Kaplan-Meier is the standard estimator for exactly that
 * shape, and the number taken from it is the restricted mean - the expected minutes before a square
 * is done, capped at HORIZON.
 *
 * Capping is what keeps it honest. Without a horizon the estimator has to extrapolate past the
 * longest match anyone has played, which is inventing data; with one, a square nobody finishes
 * simply costs the horizon, which is the true statement "at least this long, and we have not
 * measured further".
 *
 * -- What it still cannot tell you ----------------------------------------------------------------
 *
 * A square skipped because the team ruled it out - deduced there was no ship there, so never bothered
 * - is indistinguishable here from one skipped because it was far. Worth knowing, though it appears
 * not to matter much in practice: no square in the archive is quick when it IS done and also
 * frequently skipped, which is the signature that behaviour would leave.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const OUT = new URL("../src/data/bossTimeCost.json", import.meta.url);

/**
 * How far the estimator is allowed to look, and therefore what a square nobody finishes costs.
 *
 * 90 minutes, a little above the archive's median match of about 82. Beyond this there is too little
 * data to say anything: only a handful of matches run past it, so an estimate out there would be
 * three or four games wearing a decimal point.
 */
const HORIZON = 90 * 60;

/** Squares seen on fewer boards than this are too thin to price and fall back to the board mean. */
const MIN_BOARDS = 8;

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(new URL(path, import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv("../.env.local");
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const BOSS_SETS = {
  bosses: JSON.parse(readFileSync(new URL("../src/data/battleshipChallenges.json", import.meta.url), "utf8")),
  "bosses-2v2": JSON.parse(readFileSync(new URL("../src/data/battleshipChallenges2v2.json", import.meta.url), "utf8")),
};
const DEFAULT_SET = "bosses";

// Mirrors challengesForRoom()'s seeding, for the reason build-reachability.mjs does.
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
function bossBoard(roomId, setId, cells, seed, perm) {
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`;
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base));
  const pool = [...BOSS_SETS[setId]];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let out = [];
  for (let i = 0; i < cells; i++) out.push(pool[i % pool.length]);
  if (Array.isArray(perm) && perm.length === cells) out = perm.map((from) => out[from]);
  return out;
}

/**
 * Kaplan-Meier restricted mean over one square's observations.
 *
 * Each observation is either a completion at time t, or a censoring at time t - the match ended with
 * the square still undone. The survival curve steps down only at completions, and censored entries
 * leave the risk set without ever counting against the square, which is the whole point.
 */
function restrictedMean(obs) {
  const pts = [...obs].sort((a, b) => a.t - b.t);
  let atRisk = pts.length;
  let survival = 1;
  let prev = 0;
  let area = 0;
  for (let i = 0; i < pts.length; ) {
    const t = pts[i].t;
    let done = 0;
    let censored = 0;
    while (i < pts.length && pts[i].t === t) {
      if (pts[i].done) done++;
      else censored++;
      i++;
    }
    if (t > HORIZON) break;
    area += survival * (t - prev);
    prev = t;
    if (done > 0 && atRisk > 0) survival *= 1 - done / atRisk;
    atRisk -= done + censored;
    if (atRisk <= 0) break;
  }
  return area + survival * Math.max(0, HORIZON - prev);
}

// -- read the archive ------------------------------------------------------------------------
const rows = [];
for (let page = 0; page < 40; page++) {
  const { data, error } = await supabase
    .from("match_events")
    .select("match_key, room_id, cell_index, challenge_name, match_seconds, board_size, board_seed, board_perm, square_set, finished_at")
    .order("finished_at", { ascending: false })
    .range(page * 1000, page * 1000 + 999);
  if (error) throw new Error(`match_events: ${error.message}`);
  rows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

const byMatch = new Map();
for (const r of rows) {
  if (!byMatch.has(r.match_key)) byMatch.set(r.match_key, []);
  byMatch.get(r.match_key).push(r);
}

const observations = new Map();
const durations = [];
let used = 0;
const rejected = [];

for (const [key, evs] of byMatch) {
  const first = evs.find((e) => e.room_id) ?? evs[0];
  if (!first?.room_id) continue;
  const setId = first.square_set ?? DEFAULT_SET;
  if (!BOSS_SETS[setId]) continue;

  const cells = first.board_size * first.board_size;
  const board = bossBoard(
    first.room_id,
    setId,
    cells,
    evs.find((e) => e.board_seed)?.board_seed ?? null,
    evs.find((e) => e.board_perm)?.board_perm ?? null
  );

  const fired = evs.filter((e) => e.cell_index >= 0 && e.challenge_name);
  if (fired.length < 3) continue;
  // Trust a match only if the names it logged land where the rebuild puts them - the same guard
  // build-reachability.mjs uses, and for the same reason.
  const agree = fired.filter((e) => board[e.cell_index]?.name === e.challenge_name).length;
  if (agree < fired.length * 0.8) {
    rejected.push(`${key} (${agree}/${fired.length} names agree)`);
    continue;
  }

  const end = Math.max(...evs.map((e) => e.match_seconds ?? 0));
  if (end <= 0) continue;
  durations.push(end);
  used++;

  // Earliest shot at each square. A square fired at by two teams was still first done once.
  const doneAt = new Map();
  for (const e of fired) {
    const tip = board[e.cell_index]?.tooltip;
    const s = e.match_seconds;
    if (!tip || s == null) continue;
    if (!doneAt.has(tip) || s < doneAt.get(tip)) doneAt.set(tip, s);
  }

  for (let c = 0; c < cells; c++) {
    const tip = board[c]?.tooltip;
    if (!tip) continue;
    if (!observations.has(tip)) observations.set(tip, []);
    observations
      .get(tip)
      .push(doneAt.has(tip) ? { t: doneAt.get(tip), done: true } : { t: end, done: false });
  }
}

if (used === 0) throw new Error("no archived boss matches could be reconstructed - refusing to write");

// -- the table -------------------------------------------------------------------------------
const measured = [];
for (const [, obs] of observations) if (obs.length >= MIN_BOARDS) measured.push(restrictedMean(obs));
const prior = measured.reduce((s, x) => s + x, 0) / measured.length;

const table = {};
const thin = [];
for (const square of BOSS_SETS[DEFAULT_SET]) {
  const obs = observations.get(square.tooltip) ?? [];
  if (obs.length < MIN_BOARDS) {
    thin.push(`${square.name} (${obs.length} boards)`);
    table[square.tooltip] = Math.round(prior);
    continue;
  }
  table[square.tooltip] = Math.round(restrictedMean(obs));
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const output = {
  _comment: [
    "GENERATED by scripts/build-time-cost.mjs - do not edit by hand.",
    "Maps a boss square's tooltip to the expected SECONDS of a match before that square is done.",
    "Kaplan-Meier restricted mean: matches that ended with the square undone are censored, not failures.",
    `Measured over ${used} archived matches (median length ${mmss(median(durations))}), capped at a ${HORIZON / 60}-minute horizon.`,
    `Squares seen on fewer than ${MIN_BOARDS} boards fall back to the board mean (${mmss(prior)}).`,
    "Frozen on purpose: it is measured behaviour, so regenerate it BETWEEN seasons and never during one.",
  ],
  ...table,
};

writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");

const sorted = Object.entries(table).sort((a, b) => b[1] - a[1]);
const nameOf = (tip) => BOSS_SETS[DEFAULT_SET].find((c) => c.tooltip === tip)?.name ?? tip;
console.log(`\n${used} matches used, ${rejected.length} rejected. Median match ${mmss(median(durations))}.`);
console.log(`${Object.keys(table).length} squares priced, ${thin.length} on the ${mmss(prior)} fallback.\n`);
console.log("most expensive:");
for (const [tip, v] of sorted.slice(0, 6)) console.log(`  ${mmss(v).padStart(6)}  ${nameOf(tip)}`);
console.log("cheapest:");
for (const [tip, v] of sorted.slice(-6)) console.log(`  ${mmss(v).padStart(6)}  ${nameOf(tip)}`);
console.log(`\nwrote ${OUT.pathname.split("/").pop()}`);
