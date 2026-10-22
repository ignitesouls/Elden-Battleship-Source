import type { ShipDefinition } from "../types/battleship.ts";
import { BOT_TIER_SPECS, type BotTier, type BotTierSpec } from "./bot.ts";

/**
 * Where the bot fires next, and when.
 *
 * Pure: everything it knows arrives as arguments, and the only randomness is the `random` it is
 * handed, so scripts/check-bot.ts can play thousands of seeded games against it. The bot edge
 * function is the only caller in production.
 *
 * -- What the bot is allowed to know ---------------------------------------------------------------
 *
 * Its own shots and their verdicts - exactly what a crew sees on its board - and nothing else, with
 * one exception: a Shaker that has hit a ship is handed that defender's ship_index_grid and fires
 * along the real hull. That is the "impossible once he finds you" half of Shaker, and it is scoped to
 * ships already hit on purpose. A bot that could see unfound ships would not be hard, it would be
 * over in twenty shots, and nobody learns anything from that.
 *
 * -- Why a square has to be in reach --------------------------------------------------------------
 *
 * A real crew cannot fire at Malenia five minutes in, and a bot that could would be playing a
 * different game from the people it is meant to be practice for. So each square carries its time
 * cost - bossTimeCost.json, the balancer's own table: the expected seconds into a match before that
 * square is done - and the bot only aims at squares the clock has reached. A set with no cost data
 * passes null and every square is open from the start.
 */

export type Verdict = "pending" | "miss" | "hit" | "sunk";

/** One of the bot's own shots against one defender, as the attacks table holds it. */
export interface BotShot {
  cell: number;
  defender: number;
  result: Verdict;
  /** On a sinking shot, where the ship lay - resolve_attack writes it from the fleet's placements. */
  sunkSize?: number | null;
  sunkStartRow?: number | null;
  sunkStartCol?: number | null;
  sunkHorizontal?: boolean | null;
}

export interface DefenderView {
  team: number;
  /** ship_index_grid, for a Shaker only. Null or absent for every other tier. */
  truth?: number[] | null;
}

export interface BotTurnInput {
  tier: BotTier;
  boardSize: number;
  shipDefs: ShipDefinition[];
  /** Every shot the bot has fired this match, against every defender. */
  shots: BotShot[];
  /** The defenders still afloat. A shot lands on all of them at once, like everybody else's. */
  defenders: DefenderView[];
  /** Seconds of match time each cell's square costs, or null for a set with no cost data. */
  cost: number[] | null;
  /** Match seconds since firing opened, pauses excluded. */
  matchElapsed: number;
  random: () => number;
}

const UNKNOWN = 0;
const MISS = 1;
const HIT = 2;
const SUNK = 3;

/** A defender as the bot sees it: what each square came back as, and which hulls are still out. */
interface Board {
  team: number;
  state: Uint8Array;
  remaining: number[];
  truth: number[] | null;
}

/**
 * Extra reach while finishing a ship, for every tier but Shaker (who ignores reach there entirely).
 * A crew with a hit will go out of its way for the square beside it - twenty minutes out of its way,
 * not an hour.
 */
const FINISH_SLACK_SECONDS = 20 * 60;

/** How often Chud loses interest in a hit and goes back to firing anywhere. */
const CHUD_FORGETS = 0.35;

/** One kill filling two squares - a duo boss, or a kill banked and fired with the next. */
export const DOUBLE_SHOT_CHANCE = 0.06;

/** Shortest gap the bot will ever leave, so a big crew's bot is quick but never a machine gun. */
const MIN_GAP_SECONDS = 20;

function buildBoard(input: BotTurnInput, view: DefenderView): Board {
  const n = input.boardSize;
  const state = new Uint8Array(n * n);
  const remaining = input.shipDefs.map((s) => s.size);

  for (const shot of input.shots) {
    if (shot.defender !== view.team || shot.cell < 0 || shot.cell >= n * n) continue;
    if (shot.result === "miss") state[shot.cell] = Math.max(state[shot.cell], MISS);
    if (shot.result === "hit") state[shot.cell] = Math.max(state[shot.cell], HIT);
  }
  // Sunk hulls second, so a sinking shot's ship is struck out whole rather than leaving its earlier
  // hits reading as an open lead.
  for (const shot of input.shots) {
    if (shot.defender !== view.team || shot.result !== "sunk") continue;
    const size = shot.sunkSize ?? 0;
    const at = remaining.indexOf(size);
    if (at >= 0) remaining.splice(at, 1);
    if (shot.sunkStartRow == null || shot.sunkStartCol == null || shot.sunkHorizontal == null || size <= 0) {
      // A fleet with no stored placements gives no geometry; the shot's own square is all we know.
      state[shot.cell] = SUNK;
      continue;
    }
    for (let i = 0; i < size; i++) {
      const r = shot.sunkStartRow + (shot.sunkHorizontal ? 0 : i);
      const c = shot.sunkStartCol + (shot.sunkHorizontal ? i : 0);
      if (r >= 0 && r < n && c >= 0 && c < n) state[r * n + c] = SUNK;
    }
  }

  return { team: view.team, state, remaining, truth: view.truth ?? null };
}

/**
 * How many ways of laying the unsunk hulls cover each square.
 *
 * `throughHits` counts only layouts that pass through an open hit, weighted steeply by how many -
 * which is what turns two hits in a row into "it runs this way". Without it, it is the hunting
 * score: every layout that fits the water still unaccounted for.
 */
function density(board: Board, n: number, throughHits: boolean): Float64Array {
  const score = new Float64Array(n * n);
  for (const size of board.remaining) {
    for (const horizontal of [true, false]) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (horizontal ? c + size > n : r + size > n) continue;
          let hits = 0;
          let blocked = false;
          for (let i = 0; i < size && !blocked; i++) {
            const s = board.state[(r + (horizontal ? 0 : i)) * n + c + (horizontal ? i : 0)];
            if (s === MISS || s === SUNK) blocked = true;
            else if (s === HIT) hits++;
          }
          if (blocked || (throughHits && hits === 0)) continue;
          const weight = throughHits ? Math.pow(8, hits) : 1;
          for (let i = 0; i < size; i++) {
            const cell = (r + (horizontal ? 0 : i)) * n + c + (horizontal ? i : 0);
            if (board.state[cell] === UNKNOWN) score[cell] += weight;
          }
        }
      }
    }
  }
  return score;
}

function neighbours(cell: number, n: number): number[] {
  const r = Math.floor(cell / n);
  const c = cell % n;
  const out: number[] = [];
  if (r > 0) out.push(cell - n);
  if (r < n - 1) out.push(cell + n);
  if (c > 0) out.push(cell - 1);
  if (c < n - 1) out.push(cell + 1);
  return out;
}

function openHits(board: Board): number[] {
  const out: number[] = [];
  board.state.forEach((s, i) => {
    if (s === HIT) out.push(i);
  });
  return out;
}

/** Unfired squares beside an open hit. */
function besideHits(board: Board, n: number, fired: Set<number>): number[] {
  const out = new Set<number>();
  for (const h of openHits(board)) {
    for (const nb of neighbours(h, n)) if (board.state[nb] === UNKNOWN && !fired.has(nb)) out.add(nb);
  }
  return [...out];
}

/** Two or more hits in a row: the unfired squares at either end of the line. */
function lineEnds(board: Board, n: number, fired: Set<number>): number[] {
  const out = new Set<number>();
  for (const h of openHits(board)) {
    const r = Math.floor(h / n);
    const c = h % n;
    for (const [dr, dc] of [[0, 1], [1, 0]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= n || nc >= n || board.state[nr * n + nc] !== HIT) continue;
      // Walk out both ways past the run of hits; the first square that isn't a hit is the lead.
      for (const sign of [1, -1]) {
        let rr = r;
        let cc = c;
        while (rr >= 0 && rr < n && cc >= 0 && cc < n && board.state[rr * n + cc] === HIT) {
          rr += dr * sign;
          cc += dc * sign;
        }
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const end = rr * n + cc;
        if (board.state[end] === UNKNOWN && !fired.has(end)) out.add(end);
      }
    }
  }
  return [...out];
}

/** Shaker's lead: the unfired squares of a hit ship that touch one of its hits. */
function alongTheHull(board: Board, n: number, fired: Set<number>): number[] {
  if (!board.truth) return [];
  const out = new Set<number>();
  for (const h of openHits(board)) {
    const ship = board.truth[h];
    if (typeof ship !== "number" || ship < 0) continue;
    for (const nb of neighbours(h, n)) {
      if (board.truth[nb] === ship && board.state[nb] === UNKNOWN && !fired.has(nb)) out.add(nb);
    }
  }
  return [...out];
}

/** The 25th-percentile square plus the clock: what the bot can reach right now. */
export function unlockThreshold(cost: number[], matchElapsed: number, reach: number): number {
  const sorted = [...cost].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
  return base + matchElapsed * reach;
}

/**
 * Narrows candidates to the squares in reach. If none are, the cheapest few are - the bot is always
 * working towards SOMETHING, the way a crew with nothing reachable on its list heads for whatever is
 * nearest rather than standing still.
 */
function inReach(candidates: number[], cost: number[] | null, threshold: number): number[] {
  if (!cost || candidates.length === 0) return candidates;
  const reachable = candidates.filter((c) => cost[c] <= threshold);
  if (reachable.length > 0) return reachable;
  const cheapest = Math.min(...candidates.map((c) => cost[c]));
  return candidates.filter((c) => cost[c] <= cheapest + 300);
}

function pickUniform(candidates: number[], random: () => number): number | null {
  if (candidates.length === 0) return null;
  return candidates[Math.floor(random() * candidates.length)];
}

function pickBest(candidates: number[], score: Float64Array, random: () => number): number | null {
  let best = -Infinity;
  let top: number[] = [];
  for (const c of candidates) {
    if (score[c] > best) {
      best = score[c];
      top = [c];
    } else if (score[c] === best) {
      top.push(c);
    }
  }
  return pickUniform(top, random);
}

function hunt(spec: BotTierSpec, input: BotTurnInput, boards: Board[], fired: Set<number>, threshold: number): number | null {
  const n = input.boardSize;
  const unfired: number[] = [];
  for (let c = 0; c < n * n; c++) if (!fired.has(c)) unfired.push(c);
  if (spec.hunt === "random" || boards.length === 0) {
    return pickUniform(inReach(unfired, input.cost, threshold), input.random);
  }

  // Summed over every defender still afloat: one shot lands on all of them.
  const total = new Float64Array(n * n);
  for (const b of boards) density(b, n, false).forEach((v, i) => (total[i] += v));
  const live = unfired.filter((c) => total[c] > 0);
  const pool = inReach(live.length > 0 ? live : unfired, input.cost, threshold);
  return spec.hunt === "fit" ? pickUniform(pool, input.random) : pickBest(pool, total, input.random);
}

function finish(spec: BotTierSpec, input: BotTurnInput, board: Board, fired: Set<number>, threshold: number): number | null {
  const n = input.boardSize;
  const random = input.random;
  const slack = threshold + FINISH_SLACK_SECONDS;

  switch (spec.finish) {
    case "knows": {
      const lead = alongTheHull(board, n, fired);
      if (lead.length > 0) return pickUniform(lead, random);
      break;
    }
    case "density": {
      const score = density(board, n, true);
      const lead = besideHits(board, n, fired).filter((c) => score[c] > 0);
      const pool = inReach(lead.length > 0 ? lead : besideHits(board, n, fired), input.cost, slack);
      if (pool.length > 0) return pickBest(pool, score, random);
      break;
    }
    case "guess": {
      const ends = inReach(lineEnds(board, n, fired), input.cost, slack);
      if (ends.length > 0) return pickUniform(ends, random);
      const beside = inReach(besideHits(board, n, fired), input.cost, slack);
      if (beside.length > 0) return pickUniform(beside, random);
      break;
    }
    case "forgetful": {
      const beside = inReach(besideHits(board, n, fired), input.cost, slack);
      if (beside.length > 0) return pickUniform(beside, random);
      break;
    }
  }
  return null;
}

function chooseOne(input: BotTurnInput, boards: Board[], fired: Set<number>): number | null {
  const spec = BOT_TIER_SPECS[input.tier];
  const threshold = input.cost ? unlockThreshold(input.cost, input.matchElapsed, spec.reach) : Infinity;

  const leading = boards.find((b) => openHits(b).length > 0);
  const forgets = spec.finish === "forgetful" && input.random() < CHUD_FORGETS;
  if (leading && !forgets) {
    const cell = finish(spec, input, leading, fired, threshold);
    if (cell !== null) return cell;
  }
  return hunt(spec, input, boards, fired, threshold);
}

/**
 * The squares the bot fires at this turn - usually one, occasionally two (DOUBLE_SHOT_CHANCE).
 * Empty only when every square has been fired at.
 */
export function chooseShots(input: BotTurnInput): number[] {
  const boards = input.defenders.map((d) => buildBoard(input, d));
  const fired = new Set(input.shots.map((s) => s.cell));
  const out: number[] = [];
  const count = input.random() < DOUBLE_SHOT_CHANCE ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const cell = chooseOne(input, boards, fired);
    if (cell === null) break;
    out.push(cell);
    // The second square is chosen without knowing what the first one found - both fell to the same
    // kill, so neither verdict exists yet when the other is picked.
    fired.add(cell);
  }
  return out;
}

/**
 * What the crew bot's aim makes of the board - see botCrew.ts.
 *
 * chooseShots above lets aim PICK the square, which is what made the first bot gun ships down instead
 * of playing like a crew. Here aim only says how much each square is worth to a hunter, and a captain
 * leans on it as hard as its tier and its role say (botCrew raises `pull` to that power): a Limgrave
 * player barely looks up from its route, a DLC player jumps on a hit, Chud never does.
 */
export interface AimView {
  /**
   * How much each square is worth to someone hunting: 0 already fired, about 1 for "nothing known",
   * less for water no unsunk hull can still fit in, more where hulls likely lie and a lot more beside
   * a hit. On a Shaker's view, more again along a hit ship's real hull.
   */
  pull: Float64Array;
  /** The unfired squares that would finish a found ship - beside a hit, or a Shaker's hull. */
  lead: Set<number>;
  /**
   * Every ship still afloat has been found - hit at least once - on some board. From here a crew stops
   * scouting and goes to finish them, which is the endgame the first bot never played.
   */
  endgame: boolean;
}

/** Separate patches of open hits: a ship found but not yet sunk is (at least) one of these. */
function hitClusters(board: Board, n: number): number {
  const seen = new Set<number>();
  let clusters = 0;
  for (const start of openHits(board)) {
    if (seen.has(start)) continue;
    clusters++;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      for (const nb of neighbours(c, n)) {
        if (board.state[nb] === HIT && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
  }
  return clusters;
}

export function aimView(input: Omit<BotTurnInput, "cost" | "matchElapsed" | "random">): AimView {
  const n = input.boardSize;
  const fired = new Set(input.shots.map((s) => s.cell));
  const pull = new Float64Array(n * n).fill(1);
  for (const c of fired) if (c >= 0 && c < n * n) pull[c] = 0;
  const boards = input.defenders.map((d) => buildBoard({ ...input, cost: null, matchElapsed: 0, random: Math.random }, d));

  // Where unsunk hulls could still lie. Dead water - no hull fits on any board - is shunned rather
  // than banned: the square still has its boss, and a captain on its route may do it anyway.
  const hunt = new Float64Array(n * n);
  for (const b of boards) density(b, n, false).forEach((v, i) => (hunt[i] += v));
  const peak = Math.max(1, ...hunt);
  for (let c = 0; c < n * n; c++) {
    if (pull[c] === 0) continue;
    pull[c] *= hunt[c] === 0 ? 0.15 : 0.6 + 0.8 * (hunt[c] / peak);
  }

  const lead = new Set<number>();
  let endgame = false;
  for (const b of boards) {
    const open = openHits(b);
    if (open.length === 0) continue;
    const through = density(b, n, true);
    const throughPeak = Math.max(1, ...through);
    const hull = b.truth ? alongTheHull(b, n, fired) : [];
    for (const c of besideHits(b, n, fired)) {
      // Knowing which way a hit ship runs (Shaker) means knowing the squares beside it that are NOT
      // on its line are no lead at all - they keep only their worth as somewhere to scout.
      if (b.truth) continue;
      pull[c] *= 2 + 8 * (through[c] / throughPeak);
      if (through[c] > 0) lead.add(c);
    }
    for (const c of hull) {
      pull[c] *= 40;
      lead.add(c);
    }
    if (b.remaining.length > 0 && hitClusters(b, n) >= b.remaining.length) endgame = true;
  }
  return { pull, lead, endgame };
}

/** A standard normal draw (Box-Muller). */
export function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A real captain's first square: seconds after firing opens, median and log-spread.
 *
 * Read off the archive in October 2026 (boss sets, voided matches left out): a player's first square
 * fell at a median of 20:20, with the middle half between 15:32 and 25:16. A run has to get going -
 * a randomized start, the first area, the first boss - before anything can be fired, and a bot that
 * opened at the ordinary three-minute pace was fifteen minutes ahead of every crew it played.
 */
export const OPENING_MEDIAN_SECONDS = 1220;
const OPENING_SPREAD = 0.36;

/**
 * Match seconds at which the bot fires its first square.
 *
 * Each captain the bot stands in for draws their own first kill, and the bot opens with the earliest -
 * which is how a real team's first square arrives: from whichever of them got there first. The
 * archive's team median is 15:08 against the player's 20:20, and this reproduces that without a
 * second number to keep in step.
 */
export function openingSeconds(tier: BotTier, crew: number, random: () => number): number {
  const median = OPENING_MEDIAN_SECONDS * BOT_TIER_SPECS[tier].openingFactor;
  let first = Infinity;
  for (let i = 0; i < Math.max(1, crew); i++) {
    first = Math.min(first, median * Math.exp(OPENING_SPREAD * gaussian(random)));
  }
  return Math.round(first);
}

/**
 * Seconds until the bot's next kill, after its first.
 *
 * Log-normal around the tier's median, because a run of squares is mostly steady with a long tail -
 * the same shape squarePace found in the archive - plus the occasional wall. `crew` is the size of
 * the biggest human fleet in the room: pace is per CAPTAIN, so a solo player faces a bot that fires
 * like one person and a crew of four faces one that fires like four.
 */
export function nextGapSeconds(tier: BotTier, crew: number, random: () => number): number {
  const spec = BOT_TIER_SPECS[tier];
  let gap = spec.gapSeconds * Math.exp(0.35 * gaussian(random));
  if (random() < spec.wallChance) gap += 360 + random() * 720;
  return Math.max(MIN_GAP_SECONDS, Math.round(gap / Math.max(1, crew)));
}
