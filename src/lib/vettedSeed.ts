/**
 * Seeds whose boss pool passes the vetted cutoff for their board, rolled in the host's browser.
 *
 * Official matches have been dealt only vetted pools since October (supabase/functions/official-seed),
 * because a tight pool is one the balancer can always find fair layouts in: it never has to fall
 * back, and it reaches the fairest of BEST_OF passers in fewer draws. Every boss match gets the same
 * pool now. See src/lib/officialPool.ts for what the cutoff does and does not buy.
 *
 * In the browser rather than on a server, unlike the official draw. The official seed is locked so
 * nobody can fish for a pool that suits them; in a casual lobby the host can reroll as often as they
 * like anyway, and every pool this hands out is one under the cutoff, so there is nothing to fish
 * for. A server round trip per reroll would buy nothing and cost a log line each.
 *
 * Mirrors official-seed's poolCost, which mirrors challengesForRoom's seeding - the same duplication
 * balance-board carries, for the same reason (Deno imports its JSON differently).
 */
import bossData from "../data/battleshipChallenges.json";
import bossData2v2 from "../data/battleshipChallenges2v2.json";
import bossCost from "../data/bossTimeCost.json";
import bossPrereqs from "../data/bossPrereqs.json";
import { cutoffs } from "../data/officialPoolCutoffs.json";
import { rng, seedFrom } from "./seededRandom";
import { buildFlatBoard, dealtPool, type Challenge } from "./squareSetFormat";
import { effectiveCosts } from "./prereqCost";
import { generateSeed } from "./roomCode";
import { OFFICIAL_SEED_BUDGET, cutoffFor, poolSpread, type PoolCutoffTable } from "./officialPool";

const BOSS_SETS: Record<string, Challenge[]> = {
  bosses: bossData as Challenge[],
  "bosses-2v2": bossData2v2 as Challenge[],
};
const DEFAULT_SET = "bosses";

const costFor = new Map<string, number>();
for (const [tooltip, r] of Object.entries(bossCost as Record<string, unknown>)) {
  if (!tooltip.startsWith("_")) costFor.set(tooltip, r as number);
}
const costByName: Record<string, number> = {};
for (const set of Object.values(BOSS_SETS)) {
  for (const square of set) {
    const c = costFor.get(square.tooltip ?? "");
    if (c !== undefined) costByName[square.name] = c;
  }
}

/** Only the cutoffs are read, so only the cutoffs are bundled. */
const table = { cutoffs } as Pick<PoolCutoffTable, "cutoffs"> as PoolCutoffTable;

/** One seed's pool as time cost per cell, or null if a square has no cost. */
function poolCost(roomId: string, setId: string, cells: number, seed: string, dealtAt: string): number[] | null {
  const base = setId === DEFAULT_SET ? roomId : `${roomId}:${setId}`;
  const board = buildFlatBoard(dealtPool(BOSS_SETS[setId], dealtAt), cells, rng(seedFrom(`${base}:${seed}`)));
  const cost: number[] = [];
  for (const square of board) {
    const r = costFor.get(square?.tooltip ?? "");
    if (r === undefined) return null;
    cost.push(r);
  }
  return effectiveCosts(board, cost, bossPrereqs as Record<string, unknown>, costByName);
}

/** Whether this room, on this set and board, is vetted at all. Null set is the default boss board. */
export function isVettedSet(squareSet: string | null | undefined): boolean {
  return Boolean(BOSS_SETS[squareSet ?? DEFAULT_SET]);
}

/**
 * Whether a seed's pool is under the cutoff for this room's set and board.
 *
 * True for every set without a cutoff - the objective sets have no costs and are never vetted, so
 * any seed is as good as any other there.
 */
export function seedPasses(roomId: string, squareSet: string | null | undefined, boardSize: number, seed: string): boolean {
  const setId = squareSet ?? DEFAULT_SET;
  const cutoff = isVettedSet(setId) ? cutoffFor(table, setId, boardSize) : null;
  if (cutoff === null) return true;
  const cost = poolCost(roomId, setId, boardSize * boardSize, seed, new Date().toISOString());
  return cost === null || poolSpread(cost) <= cutoff;
}

/**
 * A fresh seed for this room, set and board, vetted where the set has a cutoff.
 *
 * A plain random seed everywhere else. Settles for the most even pool of the budget if none passes,
 * which official-seed says is astronomically unlikely and is there only so this always returns.
 */
export function vettedSeed(roomId: string, squareSet: string | null | undefined, boardSize: number): string {
  const setId = squareSet ?? DEFAULT_SET;
  const cutoff = isVettedSet(setId) ? cutoffFor(table, setId, boardSize) : null;
  if (cutoff === null) return generateSeed();

  // The deal date the trigger is about to stamp, give or take the write - see official-seed.
  const dealtAt = new Date().toISOString();
  const cells = boardSize * boardSize;
  let best: { seed: string; spread: number } | null = null;
  for (let i = 0; i < OFFICIAL_SEED_BUDGET; i++) {
    const seed = generateSeed();
    const cost = poolCost(roomId, setId, cells, seed, dealtAt);
    if (!cost) return seed;
    const spread = poolSpread(cost);
    if (spread <= cutoff) return seed;
    if (!best || spread < best.spread) best = { seed, spread };
  }
  return best!.seed;
}
