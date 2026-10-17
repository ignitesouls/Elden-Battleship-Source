import type { MatchRow } from "./api";

/**
 * A team's record in one event, read off its matches - shared by Crew Quarters and the tale of the
 * tape, so the two never disagree about a team's numbers.
 */

export interface TeamRecord {
  /** Series won and lost against a real opponent. */
  won: number;
  lost: number;
  /** Series won with no opponent - counted apart, since nothing was played. */
  byes: number;
  /** Games inside those series. Forfeits add none. */
  gamesWon: number;
  gamesLost: number;
  forfeits: number;
}

/** The team's record in this event, from its finished matches. A bye counts as a series won but no games. */
export function teamRecord(matches: MatchRow[], teamId: string): TeamRecord {
  let won = 0, lost = 0, byes = 0, gamesWon = 0, gamesLost = 0, forfeits = 0;
  for (const m of matches) {
    if (m.status !== "done" || (m.entrant_a !== teamId && m.entrant_b !== teamId)) continue;
    const other = m.entrant_a === teamId ? m.entrant_b : m.entrant_a;
    if (!other) {
      if (m.winner === teamId) byes++;
      continue;
    }
    const weAreA = m.entrant_a === teamId;
    if (m.winner === teamId) won++;
    else lost++;
    if (m.result_kind === "forfeit") forfeits++;
    else {
      gamesWon += weAreA ? m.score_a : m.score_b;
      gamesLost += weAreA ? m.score_b : m.score_a;
    }
  }
  return { won, lost, byes, gamesWon, gamesLost, forfeits };
}

/** Every match the two teams have been drawn into against each other in this event, in the order played. */
export function meetings(matches: MatchRow[], a: string, b: string): MatchRow[] {
  return matches
    .filter((m) => (m.entrant_a === a && m.entrant_b === b) || (m.entrant_a === b && m.entrant_b === a))
    .sort(matchOrder);
}

/** Qualifier before knockout, then phase by phase - the order the event was played in. */
export function matchOrder(x: MatchRow, y: MatchRow): number {
  const stageRank = { swiss: 0, group: 1, knockout: 2 } as const;
  return stageRank[x.stage] - stageRank[y.stage] || (x.phase ?? x.round) - (y.phase ?? y.round) || x.idx - y.idx;
}

export function ordinal(n: number, lang: string): string {
  if (lang === "fr") return n === 1 ? "1er" : `${n}e`;
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}
