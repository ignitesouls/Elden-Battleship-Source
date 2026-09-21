import type { TMatch } from "./types";

/**
 * Gives every knockout match a `phase`: how many results deep it sits in the bracket.
 *
 * A deadline needs a round to attach to, and "round" is not enough in a knockout. In a double
 * elimination the winners and loser brackets run side by side, and the second round of the loser
 * bracket cannot be played until the second round of the winners bracket has produced its losers - so
 * W2 and L2 are different rounds by number but part of the same stretch of the calendar, while L2 and
 * L3 are the same bracket and must be a stretch apart.
 *
 * The rule that gets all of that right without special-casing any shape is the plain one: a match can
 * be played only once everything that feeds it has been, so it sits one phase after its latest
 * feeder, and a match with no feeders (both teams known from the start) is phase 1. Byes, third-place
 * matches and the grand-final reset all fall out of it: a bye collapses away and the matches around
 * it simply have fewer feeders, the third-place match feeds off the semifinals and so lands beside
 * the final, and a reset feeds off the grand final and lands after it.
 *
 * Swiss and group matches keep their round, which is already the right answer for them.
 */
export function assignPhases(matches: TMatch[]): TMatch[] {
  const knockout = matches.filter((m) => m.stage === "knockout");
  const known = new Set(knockout.map((m) => m.key));

  const feeders = new Map<string, string[]>();
  const feed = (target: string, from: string) => feeders.set(target, [...(feeders.get(target) ?? []), from]);
  for (const m of knockout) {
    for (const pointer of [m.winnerTo, m.loserTo]) {
      if (pointer && known.has(pointer.key)) feed(pointer.key, m.key);
    }
    if (m.resetOf && known.has(m.resetOf)) feed(m.key, m.resetOf);
  }

  const memo = new Map<string, number>();
  const phase = (key: string, depth = 0): number => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (depth > knockout.length) throw new Error(`Bracket wiring loops back on itself at ${key}`);
    const upstream = feeders.get(key) ?? [];
    const value = upstream.length ? 1 + Math.max(...upstream.map((k) => phase(k, depth + 1))) : 1;
    memo.set(key, value);
    return value;
  };

  return matches.map((m) => (m.stage === "knockout" ? { ...m, phase: phase(m.key) } : m));
}
