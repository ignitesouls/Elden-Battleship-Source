import { bracketSize } from "./types";
import type { StandingRow } from "./standings";

/**
 * Seeds in bracket order for a bracket of `size` slots (a power of two): position 0 faces position
 * 1, position 2 faces position 3, and so on, with seed 1 and seed 2 on opposite halves so they can
 * only meet in the final.
 *
 *   8  ->  1 8 | 4 5 | 2 7 | 3 6
 *
 * Built by repeated folding: each seed is joined by the one that makes the pair sum to size + 1.
 * That is what keeps the strongest seed facing the weakest in round one, the next strongest facing
 * the next weakest, and so on all the way up.
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const s = order.length * 2;
    order = order.flatMap((seed) => [seed, s + 1 - seed]);
  }
  return order;
}

/** The entrants a knockout takes from a Swiss standing: the top `cut`, best first. */
export function seedFromSwiss(standings: StandingRow[], cut: number): string[] {
  return standings.slice(0, cut).map((row) => row.id);
}

/**
 * The entrants a knockout takes from group tables, best first.
 *
 * Seeded in tiers - every group winner before any runner-up - so that finishing first in a group
 * always earns a better bracket position than finishing second in any group. Within a tier the
 * order is by record, with group number as the last resort.
 *
 * Tiering alone would happily draw the winner of group A against the runner-up of group A in round
 * one, which is a rematch of a match they played a week ago and a bad look for a format whose
 * selling point is that everyone has met once. `avoidSameGroupOpeners` untangles that by swapping
 * teams inside a tier, which never costs anyone a better tier.
 *
 * `take` is how many each group sends - one number for all of them, or one per group. Challenger groups
 * (see GroupPool) are their own band BELOW the main groups: the winner of a challenger group, having
 * beaten only newer teams, is seeded after the last main-group qualifier, and so meets a main group
 * winner first. Within the challenger band the tiers work the same way.
 */
export function seedFromGroups(groupTables: StandingRow[][], take: number | readonly number[], challenger: readonly boolean[] = []): string[] {
  const groupOf = new Map<string, number>();
  const tierOf = new Map<string, number>();
  const ordered: string[] = [];
  const takes = groupTables.map((_, g) => (typeof take === "number" ? take : (take[g] ?? 0)));
  const depth = (band: boolean) => Math.max(0, ...takes.filter((_, g) => !!challenger[g] === band));
  const mainDepth = depth(false);

  for (const band of [false, true]) {
    for (let tier = 0; tier < depth(band); tier++) {
      const rows = groupTables
        .map((table, group) => ({ row: tier < takes[group] && !!challenger[group] === band ? table[tier] : undefined, group }))
        .filter((entry): entry is { row: StandingRow; group: number } => entry.row !== undefined)
        .sort(
          (x, y) =>
            y.row.wins - x.row.wins ||
            y.row.gameDiff - x.row.gameDiff ||
            y.row.buchholz - x.row.buchholz ||
            x.group - y.group,
        );
      for (const { row, group } of rows) {
        groupOf.set(row.id, group);
        // Offset so that no swap in avoidSameGroupOpeners can trade a challenger for a main-group team.
        tierOf.set(row.id, band ? mainDepth + tier : tier);
        ordered.push(row.id);
      }
    }
  }
  return avoidSameGroupOpeners(ordered, groupOf, tierOf);
}

/**
 * Rearranges seeds so that no first-round match is between two teams from the same group, where
 * that can be done by swapping teams of the same tier.
 *
 * Nobody's tier ever changes - a runner-up stays a runner-up - so the only thing that moves is
 * where a team sits among its own tier. Slots are filled best seed first and each keeps its
 * original occupant unless that would put it against a group-mate, so the search disturbs the
 * lowest seeds it can and the top seeds keep the slots they earned.
 *
 * Found by depth-first search, because a greedy pair-swap cannot do it: fixing four group winners
 * against four runners-up needs a rotation of the runners-up, and no single swap of two of them
 * makes progress. If no clash-free arrangement exists (two groups, a lone group) the search gives
 * up and a greedy pass improves what it can, since a forced early meeting is a fact of the format
 * and not a fault in the draw.
 */
export function avoidSameGroupOpeners(
  seeded: string[],
  groupOf: Map<string, number>,
  tierOf: Map<string, number>,
): string[] {
  const n = seeded.length;
  const size = bracketSize(n);
  const order = seedOrder(size);

  const partner: number[] = new Array(size);
  const pairs: Array<[number, number]> = [];
  for (let p = 0; p < size / 2; p++) {
    const x = order[2 * p] - 1;
    const y = order[2 * p + 1] - 1;
    partner[x] = y;
    partner[y] = x;
    pairs.push([x, y]);
  }

  const byTier = new Map<number, string[]>();
  for (const id of seeded) {
    const tier = tierOf.get(id) ?? 0;
    byTier.set(tier, [...(byTier.get(tier) ?? []), id]);
  }

  const placed: string[] = new Array(n);
  const used = new Set<string>();
  let budget = 200_000;
  const fill = (i: number): boolean => {
    if (i === n) return true;
    if (--budget < 0) return false;
    const pool = byTier.get(tierOf.get(seeded[i]) ?? 0)!;
    for (const candidate of [seeded[i], ...pool.filter((id) => id !== seeded[i])]) {
      if (used.has(candidate)) continue;
      // The partner is only decided if it is a better seed (or a bye, which is never < i).
      const p = partner[i];
      if (p < i && groupOf.get(placed[p]) === groupOf.get(candidate)) continue;
      used.add(candidate);
      placed[i] = candidate;
      if (fill(i + 1)) return true;
      used.delete(candidate);
    }
    return false;
  };
  if (fill(0)) return placed;

  const out = [...seeded];

  const clash = (i: number, j: number) =>
    i < n && j < n && groupOf.get(out[i]) === groupOf.get(out[j]);

  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const [x, y] of pairs) {
      if (!clash(x, y)) continue;
      // The pair is listed better seed first, so y is the one that may move.
      for (let z = 0; z < n; z++) {
        if (z === x || z === y) continue;
        if (tierOf.get(out[z]) !== tierOf.get(out[y])) continue;
        const swapped = out.slice();
        [swapped[y], swapped[z]] = [swapped[z], swapped[y]];
        const stillClash = (i: number, j: number) =>
          i < n && j < n && groupOf.get(swapped[i]) === groupOf.get(swapped[j]);
        if (stillClash(x, y) || stillClash(z, partner[z])) continue;
        out[y] = swapped[y];
        out[z] = swapped[z];
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return out;
}
