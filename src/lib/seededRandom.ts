/**
 * Deterministic randomness, seeded from a string.
 *
 * Lifted out of challenges.ts so more than one feature can share it. The property both callers
 * depend on is that nothing is stored: every client seeds from the same public strings - a room id,
 * a match seed - and independently computes an identical result, so there is nothing to sync and
 * nothing that can drift between players mid-match.
 */

/** Hash a string to a 32-bit seed (xmur3). */
export function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
