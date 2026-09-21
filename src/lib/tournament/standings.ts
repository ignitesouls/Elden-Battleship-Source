import type { TMatch } from "./types";

export interface StandingRow {
  id: string;
  /** Games actually played - a Swiss bye is a win but not a game. */
  played: number;
  wins: number;
  losses: number;
  byes: number;
  /** Games won minus games lost across every series, ignoring byes. */
  gameDiff: number;
  /** Sum of every opponent's win count - how hard the road was. */
  buchholz: number;
  /** 1-based position after all tiebreaks. Always strict: two rows never share a rank. */
  rank: number;
  /**
   * Still level with a neighbour after every tiebreak, so this row's position was settled by seed
   * order alone. The cut line is the place this matters: if rows either side of it are both `tied`,
   * somebody is being eliminated on the draw and the organizer should play it off instead.
   */
  tied: boolean;
}

/**
 * Ranks entrants from their finished matches.
 *
 * Order: wins, then game difference, then Buchholz, then - for exactly two entrants who are level
 * on all of that and have met - the result of that meeting, then original seed. `ids` is in seed
 * order and that order is the last resort, which is what makes the ranking a pure function of the
 * matches: the same results always give the same table.
 *
 * Head-to-head is applied to pairs only. Three teams each beating one of the others is a cycle with
 * no answer in it, and picking one by some arbitrary walk through the results would look like
 * judgement while being nothing of the kind. Those stay `tied` so a human decides.
 */
export function computeStandings(ids: string[], matches: TMatch[]): StandingRow[] {
  const seedOf = new Map(ids.map((id, i) => [id, i] as const));
  const rows = new Map<string, StandingRow>(
    ids.map((id) => [
      id,
      { id, played: 0, wins: 0, losses: 0, byes: 0, gameDiff: 0, buchholz: 0, rank: 0, tied: false },
    ]),
  );
  const opponents = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const m of matches) {
    if (m.status !== "done" || !m.winner || !m.a) continue;
    const ra = rows.get(m.a);
    if (!ra) continue;

    if (m.isBye) {
      ra.wins += 1;
      ra.byes += 1;
      continue;
    }
    if (!m.b) continue;
    const rb = rows.get(m.b);
    if (!rb) continue;

    const aWon = m.winner === m.a;
    (aWon ? ra : rb).wins += 1;
    (aWon ? rb : ra).losses += 1;
    ra.played += 1;
    rb.played += 1;
    ra.gameDiff += m.scoreA - m.scoreB;
    rb.gameDiff += m.scoreB - m.scoreA;
    opponents.get(m.a)!.push(m.b);
    opponents.get(m.b)!.push(m.a);
  }

  for (const row of rows.values()) {
    row.buchholz = opponents.get(row.id)!.reduce((sum, opp) => sum + rows.get(opp)!.wins, 0);
  }

  const sorted = [...rows.values()].sort(
    (x, y) =>
      y.wins - x.wins ||
      y.gameDiff - x.gameDiff ||
      y.buchholz - x.buchholz ||
      seedOf.get(x.id)! - seedOf.get(y.id)!,
  );

  const level = (x: StandingRow, y: StandingRow) =>
    x.wins === y.wins && x.gameDiff === y.gameDiff && x.buchholz === y.buchholz;

  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && level(sorted[i], sorted[j])) j++;
    const runLength = j - i;

    if (runLength === 2) {
      const [x, y] = [sorted[i], sorted[i + 1]];
      const meeting = matches.find(
        (m) =>
          m.status === "done" &&
          !m.isBye &&
          ((m.a === x.id && m.b === y.id) || (m.a === y.id && m.b === x.id)),
      );
      if (meeting) {
        if (meeting.winner === y.id) {
          sorted[i] = y;
          sorted[i + 1] = x;
        }
      } else {
        x.tied = y.tied = true;
      }
    } else if (runLength > 2) {
      for (let k = i; k < j; k++) sorted[k].tied = true;
    }
    i = j;
  }

  sorted.forEach((row, index) => (row.rank = index + 1));
  return sorted;
}

/**
 * Whether the line between the last team in and the first team out is a coin flip.
 *
 * True only when the entrant at position `cut` and the one at `cut + 1` are level on every
 * tiebreak, i.e. both marked `tied` AND the same run. Rows that are tied with each other elsewhere
 * in the table don't count - that's untidy, but nobody's season depends on it.
 */
export function cutLineTied(standings: StandingRow[], cut: number): boolean {
  if (cut <= 0 || cut >= standings.length) return false;
  const last = standings[cut - 1];
  const next = standings[cut];
  return (
    last.tied &&
    next.tied &&
    last.wins === next.wins &&
    last.gameDiff === next.gameDiff &&
    last.buchholz === next.buchholz
  );
}
