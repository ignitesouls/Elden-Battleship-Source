import { newMatch } from "./types";
import type { TMatch } from "./types";

/**
 * Deals seeded entrants into groups by snaking: seed 1 to group A, 2 to B, 3 to C, then back the
 * other way - 4 to C, 5 to B, 6 to A - and so on. A straight deal would give group A seeds 1, 4, 7
 * and group C seeds 3, 6, 9, and the difference adds up; the snake keeps every group's total seed
 * within a rank or two of the others.
 */
export function assignGroups(seeded: string[], groupCount: number): string[][] {
  const groups: string[][] = Array.from({ length: groupCount }, () => []);
  seeded.forEach((id, i) => {
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    groups[row % 2 === 0 ? col : groupCount - 1 - col].push(id);
  });
  return groups;
}

/**
 * Deals entrants into groups when the organizer has put some of them in a group by hand - which is how a
 * challenger group of newer teams is filled.
 *
 * A hand-placed team goes where it was put. Everyone else is dealt from the seeding into the MAIN groups
 * only (every group, if all of them are challengers), always to a group that is currently smallest,
 * walking the same snake as assignGroups to choose among those. With nobody placed and no challengers
 * that is exactly assignGroups; with a few placed it tops the other groups up evenly around them.
 *
 * Each group lists its teams best seed first, as assignGroups does.
 */
export function dealGroups(
  seeded: string[],
  groupCount: number,
  { placement = {}, challenger = [] }: { placement?: Readonly<Record<string, number>>; challenger?: readonly boolean[] } = {},
): string[][] {
  if (!Number.isInteger(groupCount) || groupCount < 1) return [];
  const groups: string[][] = Array.from({ length: groupCount }, () => []);
  const free: string[] = [];
  for (const id of seeded) {
    const g = placement[id];
    if (Number.isInteger(g) && g >= 0 && g < groupCount) groups[g].push(id);
    else free.push(id);
  }

  const all = groups.map((_, g) => g);
  const main = all.filter((g) => !challenger[g]);
  const targets = main.length > 0 ? main : all;
  const snake = (turn: number) => {
    const row = Math.floor(turn / targets.length);
    const col = turn % targets.length;
    return targets[row % 2 === 0 ? col : targets.length - 1 - col];
  };
  let turn = 0;
  for (const id of free) {
    const smallest = Math.min(...targets.map((g) => groups[g].length));
    // Every target is visited once per row of the snake, so a smallest one turns up within a row.
    let g = snake(turn++);
    while (groups[g].length !== smallest) g = snake(turn++);
    groups[g].push(id);
  }

  const rank = new Map(seeded.map((id, i) => [id, i]));
  return groups.map((group) => group.sort((x, y) => rank.get(x)! - rank.get(y)!));
}

/**
 * A single round-robin as a list of rounds, each a list of pairings, by the circle method: one
 * entrant stays put and the rest rotate around them. Every entrant meets every other exactly once,
 * and nobody plays twice in a round. An odd field gets a phantom entrant, and whoever draws it
 * simply has the round off.
 */
export function roundRobin(ids: string[]): Array<Array<[string, string]>> {
  const ring: Array<string | null> = [...ids];
  if (ring.length % 2 === 1) ring.push(null);
  const size = ring.length;
  const rounds: Array<Array<[string, string]>> = [];

  for (let r = 0; r < size - 1; r++) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < size / 2; i++) {
      const x = ring[i];
      const y = ring[size - 1 - i];
      if (x && y) pairs.push([x, y]);
    }
    rounds.push(pairs);
    ring.splice(1, 0, ring.pop() as string | null);
  }
  return rounds;
}

/**
 * Every match of every group, fixed up front. With two legs the whole schedule is played again with
 * sides swapped, so a home-and-away style rematch is a second series rather than a coin flip about
 * who is listed first.
 */
export function buildGroupStage(groups: string[][], legs: 1 | 2, bestOf: number): TMatch[] {
  const out: TMatch[] = [];
  groups.forEach((ids, group) => {
    const schedule = roundRobin(ids);
    for (let leg = 0; leg < legs; leg++) {
      schedule.forEach((pairs, r) => {
        const round = leg * schedule.length + r + 1;
        pairs.forEach(([x, y], index) => {
          const [a, b] = leg === 0 ? [x, y] : [y, x];
          out.push(
            newMatch({ key: `G${group + 1}-${round}-${index}`, stage: "group", group, round, index, a, b, bestOf }),
          );
        });
      });
    }
  });
  return out;
}
