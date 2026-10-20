/**
 * Which boss pools an official match may be dealt.
 *
 * The balancer decides where the squares sit; the seed decides which squares are in play at all,
 * and nothing the balancer does can change that. An official match is therefore dealt only from a
 * pool under the cutoff for its board - drawn by the official-seed function, never by a browser.
 *
 * -- What "even" means, and what it does not buy -------------------------------------------------
 *
 * A pool's score is the spread (standard deviation) of its squares' time costs, prerequisites
 * discounted exactly as the balancer discounts them. A tight pool is one with fewer evening-long
 * squares at one end and fewer free ones at the other.
 *
 * It is NOT a fairness test in the balancer's sense, and the survey that chose it says why. Over
 * 1000 11x11 pools against 8000 random fleet pairs, the board the balancer hands back is equally
 * fair whatever the pool: worst clear gap 4:04 on the most even third against 4:03 on the least,
 * find gap 7:46 against 7:55. The pool is the same for both teams, so it cannot favour either.
 * What a tight pool changes is how hard the balancer has to work - 126 draws against 180 - and how
 * often it runs out of them and falls back to the closest layout it saw: 0.23% against 1.24%, and
 * none at all in 240 tries on the most even pools. The win is "the balancer never falls back",
 * plus a somewhat shorter, less lopsided-looking board.
 *
 * -- Why a frozen cutoff and not "best of N" ------------------------------------------------------
 *
 * The cutoff is a low percentile of spread over a large batch of random deals, per square set and
 * board size, written to src/data/officialPoolCutoffs.json by scripts/build-pool-cutoffs.ts.
 * Rejection against a fixed line keeps every official pool a uniform draw from the pools under it,
 * and makes the guarantee true of every one. Best-of-N would only be true on average.
 *
 * It is generated from the cost table, so it is stale the moment that table is regenerated -
 * scripts/check-official-pool.ts fails `npm run check` until the two agree again.
 *
 * Imports nothing, like boardBalance.ts: the official-seed Edge Function runs this under Deno.
 */

/** The share of pools, most even first, that an official match may be dealt from. */
export const OFFICIAL_POOL_PERCENTILE = 0.01;

/**
 * Seeds official-seed may try before settling for the most even one it saw.
 *
 * Far more than the cutoff needs on average - the chance of the whole budget missing is
 * astronomically small - so the fallback is there to make the function total, not because it is
 * expected to run. A try is a deal and a spread, well under a millisecond.
 */
export const OFFICIAL_SEED_BUDGET = 5000;

/** The square sets official pools are vetted on: the two boss cuts, the only sets with costs. */
export const VETTED_SETS = ["bosses", "bosses-2v2"] as const;

/** Spread of a pool's time costs, in seconds: the population standard deviation. */
export function poolSpread(cost: number[]): number {
  if (cost.length === 0) return 0;
  const mean = cost.reduce((a, b) => a + b, 0) / cost.length;
  return Math.sqrt(cost.reduce((a, b) => a + (b - mean) ** 2, 0) / cost.length);
}

/** The src/data files a cutoff depends on, in the order poolSourceHash reads them. */
export const POOL_SOURCE_FILES = [
  "battleshipChallenges.json",
  "battleshipChallenges2v2.json",
  "bossTimeCost.json",
  "bossPrereqs.json",
] as const;

/** The shape of officialPoolCutoffs.json. */
export interface PoolCutoffTable {
  percentile: number;
  samples: number;
  /** Fingerprint of the data files the cutoffs were computed from - see poolSourceHash. */
  source: string;
  /** setId -> board size -> spread in seconds at the percentile. */
  cutoffs: Record<string, Record<string, number>>;
}

/** The cutoff for one set and board size, or null where none was computed. */
export function cutoffFor(table: PoolCutoffTable, setId: string, boardSize: number): number | null {
  const c = table.cutoffs[setId]?.[String(boardSize)];
  return typeof c === "number" ? c : null;
}

/**
 * Fingerprint of the files a cutoff depends on, in a fixed order.
 *
 * FNV-1a over the raw text: not for secrecy, only so the check can tell "these cutoffs were
 * computed from the files on disk" from "somebody regenerated the cost table since".
 */
export function poolSourceHash(texts: string[]): string {
  let h = 0x811c9dc5;
  for (const text of texts) {
    // Line endings normalised, so a checkout on Windows fingerprints the same as one on Linux.
    const s = text.replace(/\r\n/g, "\n");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}
