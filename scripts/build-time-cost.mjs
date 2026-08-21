/**
 * Regenerates src/data/bossTimeCost.json - how many minutes of a match each boss square costs.
 *
 *   node scripts/build-time-cost.mjs             regenerate the table
 *   node scripts/build-time-cost.mjs --dry-run   score the archive and report, write nothing
 *
 * The dry run exists because of the freeze below: the useful question between seasons is "has enough
 * post-Dionysus data arrived to change the prices yet", and that should be answerable without
 * actually restating the cost model in the middle of a season to find out.
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
 *
 * -- Why recent matches count for more ------------------------------------------------------------
 *
 * Dionysus shipped alongside the changes that made boards faster, and a square's cost is measured
 * BEHAVIOUR rather than a property of the boss - so a match played before it is evidence about a game
 * that no longer exists. Throwing that evidence out is not an option either: the whole archive
 * predates the cutoff, so a filter would leave nothing to price 206 squares with.
 *
 * So the estimator is weighted rather than filtered. Every observation carries a weight instead of
 * counting as one head, and old ones are discounted - per square, by how much new evidence THAT
 * square has of its own. A square that has come up on thirty post-Dionysus boards barely listens to
 * the old archive; one that has come up on two still leans on it, because two boards is not a
 * measurement. See RECENT_TARGET.
 *
 * The useful property of weighting is that uniform weights change nothing: with no post-cutoff
 * matches yet, every observation is discounted by the same factor, the ratios inside the estimator
 * are untouched, and this writes the table it would have written anyway. The bias switches itself on
 * as the new data arrives, not on the day the constant was added.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const OUT = new URL("../src/data/bossTimeCost.json", import.meta.url);

const DRY_RUN = process.argv.includes("--dry-run");

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

/**
 * When Dionysus went out, and with it the changes that made boards faster.
 *
 * 10:00 on 21 Aug 2026, Taipei - written in UTC because that is what `finished_at` is stored in, and
 * a local-time string here would quietly move the line the next time it was read from anywhere else.
 * Matches finished at or after this count in full; everything before is discounted by the fade below.
 */
const RECENT_FROM = Date.parse("2026-08-21T02:00:00Z");

/**
 * How many post-cutoff boards a square needs before an old observation is worth half a new one.
 *
 * The weight on a pre-cutoff observation is RECENT_TARGET / (RECENT_TARGET + n), where n is how many
 * post-cutoff boards THIS square has appeared on:
 *
 *     n = 0  ->  1.00     n = 12  ->  0.50     n = 40  ->  0.23     n >= 68  ->  0.15
 *
 * Twelve because that is about where a square's own new evidence stops being an anecdote - a little
 * above MIN_BOARDS, which is already the line this script draws between "measured" and "too thin to
 * price". Per square rather than per archive because squares do not arrive at the same rate: on a
 * 10x10 any given square lands on about half of boards, and the rare ones would sit on three
 * observations for weeks if one global counter decided when to stop listening to the old data.
 */
const RECENT_TARGET = 12;

/**
 * The least an old observation can ever be worth.
 *
 * Not zero. A square that has gone quiet - unlucky, or simply not dealt lately - would otherwise have
 * its entire history erased the moment a dozen new boards turned up somewhere else, and the floor
 * keeps the shape of the old curve visible underneath. It also means this can never quietly become
 * "new data only" without somebody deciding that on purpose.
 */
const OLD_FLOOR = 0.15;

/** What one pre-cutoff observation is worth, for a square with `nRecent` post-cutoff boards. */
function oldWeight(nRecent) {
  return Math.max(OLD_FLOOR, RECENT_TARGET / (RECENT_TARGET + nRecent));
}

/** One square's observations with the era fade applied. A post-cutoff board always weighs 1. */
function weigh(obs) {
  const w = oldWeight(obs.filter((o) => o.recent).length);
  return obs.map((o) => ({ ...o, w: o.recent ? 1 : w }));
}

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
 * Weighted Kaplan-Meier restricted mean over one square's observations.
 *
 * Each observation is either a completion at time t, or a censoring at time t - the match ended with
 * the square still undone. The survival curve steps down only at completions, and censored entries
 * leave the risk set without ever counting against the square, which is the whole point.
 *
 * Weighted only in the sense that the risk set is a sum of `w` rather than a count of rows: an
 * observation worth 0.15 takes 0.15 out of the risk set and 0.15 of a step out of the survival curve.
 * Weights of 1 therefore reproduce the unweighted estimator exactly, and - the reason this is safe to
 * switch on over an archive that is entirely pre-cutoff - so does any set of weights that are all
 * equal, since nothing here reads a weight except as a ratio against the others.
 */
function restrictedMean(obs) {
  const pts = [...obs].sort((a, b) => a.t - b.t);
  let atRisk = pts.reduce((sum, p) => sum + p.w, 0);
  let survival = 1;
  let prev = 0;
  let area = 0;
  for (let i = 0; i < pts.length; ) {
    const t = pts[i].t;
    let done = 0;
    let censored = 0;
    while (i < pts.length && pts[i].t === t) {
      if (pts[i].done) done += pts[i].w;
      else censored += pts[i].w;
      i++;
    }
    if (t > HORIZON) break;
    area += survival * (t - prev);
    prev = t;
    if (done > 0 && atRisk > 0) survival *= 1 - done / atRisk;
    atRisk -= done + censored;
    // Weights are fractional, so the risk set empties at 1e-16 where counting heads landed on 0.
    if (atRisk <= 1e-9) break;
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
const recentDurations = [];
let used = 0;
let recentUsed = 0;
const rejected = [];
let undated = 0;

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

  // Which side of the cutoff this match sits on. A match with no finished_at is treated as old:
  // every dated row in the archive predates the cutoff, so an undated one is far likelier to be an
  // early record than a new one, and guessing "new" would hand it full weight on no evidence.
  const finishedAt = evs.find((e) => e.finished_at)?.finished_at ?? null;
  if (!finishedAt) undated++;
  const recent = finishedAt != null && Date.parse(finishedAt) >= RECENT_FROM;
  if (recent) {
    recentUsed++;
    recentDurations.push(end);
  }

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
      .push(
        doneAt.has(tip)
          ? { t: doneAt.get(tip), done: true, recent }
          : { t: end, done: false, recent }
      );
  }
}

if (used === 0) throw new Error("no archived boss matches could be reconstructed - refusing to write");

// -- the table -------------------------------------------------------------------------------
// MIN_BOARDS still counts raw boards, not weight. It asks whether a square has been SEEN enough to
// say anything about it, which discounting old evidence does not change - and thresholding on weight
// instead would drop squares onto the fallback prior for no reason other than that the archive aged.
const measured = [];
for (const [, obs] of observations) {
  if (obs.length >= MIN_BOARDS) measured.push(restrictedMean(weigh(obs)));
}
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
  table[square.tooltip] = Math.round(restrictedMean(weigh(obs)));
}

// -- how far along the changeover is -------------------------------------------------------------
//
// The fade is per square, so "is there enough new data yet" is not one number - it is 206 of them.
// This is the answer for the squares that have crossed MIN_BOARDS on post-Dionysus boards alone: how
// far today's blended price sits from the price their new evidence would give on its own. While the
// two agree there is nothing to decide; when they part company and the gap stops moving between
// runs, the old archive is holding the table back and RECENT_TARGET or OLD_FLOOR should come down.
const changeover = [];
let mostFresh = 0;
for (const square of BOSS_SETS[DEFAULT_SET]) {
  const obs = observations.get(square.tooltip) ?? [];
  const fresh = obs.filter((o) => o.recent);
  mostFresh = Math.max(mostFresh, fresh.length);
  if (fresh.length < MIN_BOARDS) continue;
  const newOnly = restrictedMean(fresh.map((o) => ({ ...o, w: 1 })));
  changeover.push({
    name: square.name,
    boards: fresh.length,
    weight: oldWeight(fresh.length),
    blended: table[square.tooltip],
    newOnly,
    drift: newOnly - table[square.tooltip],
  });
}
changeover.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const output = {
  _comment: [
    "GENERATED by scripts/build-time-cost.mjs - do not edit by hand.",
    "Maps a boss square's tooltip to the expected SECONDS of a match before that square is done.",
    "Kaplan-Meier restricted mean: matches that ended with the square undone are censored, not failures.",
    `Measured over ${used} archived matches (median length ${mmss(median(durations))}), capped at a ${HORIZON / 60}-minute horizon.`,
    `Squares seen on fewer than ${MIN_BOARDS} boards fall back to the board mean (${mmss(prior)}).`,
    `Recency-weighted: ${recentUsed} of those matches were played since Dionysus (${new Date(RECENT_FROM).toISOString()}) and count in full;`,
    `earlier ones are discounted per square to ${RECENT_TARGET}/(${RECENT_TARGET}+new boards), floored at ${OLD_FLOOR}.`,
    "Frozen on purpose: it is measured behaviour, so regenerate it BETWEEN seasons and never during one.",
  ],
  ...table,
};

if (!DRY_RUN) writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");

const sorted = Object.entries(table).sort((a, b) => b[1] - a[1]);
const nameOf = (tip) => BOSS_SETS[DEFAULT_SET].find((c) => c.tooltip === tip)?.name ?? tip;
console.log(`\n${used} matches used, ${rejected.length} rejected. Median match ${mmss(median(durations))}.`);
console.log(`${Object.keys(table).length} squares priced, ${thin.length} on the ${mmss(prior)} fallback.`);

const sinceDionysus = new Date(RECENT_FROM).toISOString().replace("T", " ").slice(0, 16);
console.log(
  `\nera: ${recentUsed} matches since Dionysus (${sinceDionysus}Z), ${used - recentUsed} before` +
    (undated > 0 ? `, ${undated} undated and counted as before` : "")
);
if (recentUsed > 0) {
  console.log(`     median match ${mmss(median(recentDurations))} since, ${mmss(median(durations))} across all.`);
}
if (changeover.length === 0) {
  console.log(
    `     no square has ${MIN_BOARDS} post-Dionysus boards yet - the best has ${mostFresh}, which puts the` +
      ` fade at ${oldWeight(mostFresh).toFixed(2)} on old data at its lightest.`
  );
} else {
  const drifts = changeover.map((c) => Math.abs(c.drift));
  console.log(
    `     ${changeover.length} squares now have >= ${MIN_BOARDS} post-Dionysus boards of their own;` +
      ` old data weighs ${changeover[changeover.length - 1].weight.toFixed(2)}-${changeover[0].weight.toFixed(2)} on them.`
  );
  console.log(
    `     new-data-only would move them by a median of ${mmss(median(drifts))}, at most ${mmss(Math.max(...drifts))}:`
  );
  for (const c of changeover.slice(0, 6)) {
    const sign = c.drift >= 0 ? "+" : "-";
    console.log(
      `       ${mmss(c.blended).padStart(6)} -> ${mmss(c.newOnly).padStart(6)}  ${sign}${mmss(Math.abs(c.drift))}` +
        `  ${c.name} (${c.boards} new boards)`
    );
  }
}
console.log("");
console.log("most expensive:");
for (const [tip, v] of sorted.slice(0, 6)) console.log(`  ${mmss(v).padStart(6)}  ${nameOf(tip)}`);
console.log("cheapest:");
for (const [tip, v] of sorted.slice(-6)) console.log(`  ${mmss(v).padStart(6)}  ${nameOf(tip)}`);
console.log(
  DRY_RUN
    ? "dry run - nothing written."
    : `wrote ${OUT.pathname.split("/").pop()}`
);
