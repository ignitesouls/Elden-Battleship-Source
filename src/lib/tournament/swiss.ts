import { newMatch } from "./types";
import type { TMatch } from "./types";
import { computeStandings } from "./standings";

/**
 * How many Swiss rounds it takes to separate a field: enough that one entrant can be unbeaten,
 * which is log2 of the field size, rounded up. Capped at n - 1 because that is how many opponents
 * exist - a round past that is a rematch by construction.
 */
export function recommendedSwissRounds(entrants: number): number {
  return Math.max(1, Math.min(entrants - 1, Math.ceil(Math.log2(Math.max(entrants, 2)))));
}

/**
 * Pairs the next Swiss round.
 *
 * `ids` is the whole field in seed order and `matches` is every Swiss match played so far. Entrants
 * are ranked by the standings, then paired within their score group the Dutch way: the top half of a
 * group plays the bottom half (1 v 3, 2 v 4 in a group of four), so the strongest are not simply
 * handed the weakest of their own record and the pairings stay competitive.
 *
 * Two rules override that preference, in this order of importance:
 *   1. Nobody plays the same opponent twice. Enforced by backtracking - if the natural pairing
 *      strands someone, earlier pairs are undone until a rematch-free set is found.
 *   2. Nobody gets a second bye while anyone is still without one. With an odd field the lowest
 *      ranked entrant who has not had one sits out and is credited a win.
 *
 * If no rematch-free pairing exists at all - which can happen once the rounds outnumber what the
 * field can support - the least-bad one is returned rather than nothing: an organizer needs
 * *a* round to run, and the caller can see the rematch and decide what to do about it.
 *
 * `departed` is the set of teams an administrator has removed from the event. They are left out of
 * the draw - an event that runs for weeks will lose a team or two, and pairing a round around a team
 * that is not coming would just hand its opponent a forfeit.
 */
export function pairSwissRound(
  ids: string[],
  matches: TMatch[],
  round: number,
  bestOf: number,
  departed: ReadonlySet<string> = new Set(),
): TMatch[] {
  // Ranked over the whole field, so a win over a team that has since left still counts for the
  // winner - but only teams still in the event are paired.
  const standings = computeStandings(ids, matches);
  const wins = new Map(standings.map((row) => [row.id, row.wins] as const));
  const ranked = standings.map((row) => row.id).filter((id) => !departed.has(id));

  const met = new Set<string>();
  const hadBye = new Set<string>();
  for (const m of matches) {
    if (m.stage !== "swiss") continue;
    if (m.isBye && m.a) hadBye.add(m.a);
    else if (m.a && m.b) met.add(pairKey(m.a, m.b));
  }

  let byeId: string | null = null;
  let field = ranked;
  if (ranked.length % 2 === 1) {
    byeId =
      [...ranked].reverse().find((id) => !hadBye.has(id)) ?? ranked[ranked.length - 1];
    field = ranked.filter((id) => id !== byeId);
  }

  const pairs = pairUp(field, wins, met, true) ?? pairUp(field, wins, met, false)!;

  const out: TMatch[] = pairs.map(([a, b], index) =>
    newMatch({ key: `S${round}-${index}`, stage: "swiss", round, index, a, b, bestOf }),
  );
  if (byeId) {
    out.push(
      newMatch({
        key: `S${round}-${out.length}`,
        stage: "swiss",
        round,
        index: out.length,
        a: byeId,
        winner: byeId,
        isBye: true,
        bestOf,
      }),
    );
  }
  return out;
}

const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * Backtracking pairing of an already-ranked, even-sized list.
 *
 * `strict` refuses rematches outright; the lenient pass merely tries every fresh pairing before any
 * rematch, so it never needs to backtrack and always finishes. The node budget bounds the strict
 * pass - an infeasible field is the only case that could otherwise search for a very long time.
 */
function pairUp(
  order: string[],
  wins: Map<string, number>,
  met: Set<string>,
  strict: boolean,
): Array<[string, string]> | null {
  let budget = 100_000;
  const chosen: Array<[string, string]> = [];

  const solve = (remaining: string[]): boolean => {
    if (remaining.length === 0) return true;
    if (--budget < 0) return false;

    const p = remaining[0];
    const rest = remaining.slice(1);
    const sameScore = rest.filter((q) => wins.get(q) === wins.get(p));
    const preferredAt = Math.max(0, Math.floor((sameScore.length + 1) / 2) - 1);

    const candidates = [
      ...sameScore
        .map((q, i) => ({ q, distance: Math.abs(i - preferredAt), i }))
        .sort((x, y) => x.distance - y.distance || x.i - y.i)
        .map((entry) => entry.q),
      ...rest.filter((q) => wins.get(q) !== wins.get(p)),
    ];

    const fresh = candidates.filter((q) => !met.has(pairKey(p, q)));
    const rematches = strict ? [] : candidates.filter((q) => met.has(pairKey(p, q)));

    for (const q of [...fresh, ...rematches]) {
      chosen.push([p, q]);
      if (solve(rest.filter((x) => x !== q))) return true;
      chosen.pop();
    }
    return false;
  };

  return solve(order) ? chosen : null;
}

/** Whether every match of a Swiss round has a result, i.e. the next round can be paired. */
export function swissRoundComplete(matches: TMatch[], round: number): boolean {
  const inRound = matches.filter((m) => m.stage === "swiss" && m.round === round);
  return inRound.length > 0 && inRound.every((m) => m.status === "done");
}
