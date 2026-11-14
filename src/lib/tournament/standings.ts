import type { TMatch } from "./types";

/**
 * One team's totals over the games it actually played in one bracket match - see tournament_game_stats.
 * A forfeit or an administrator's result has no games, and so no entry at all.
 */
export interface TeamGameStats {
  games: number;
  sinks: number;
  shots: number;
  /** Games won whose length is known. */
  wonGames: number;
  /** Their total length, in seconds. */
  wonSeconds: number;
}

/** Match key -> team id -> that team's game stats in that match. */
export type MatchGameStats = ReadonlyMap<string, ReadonlyMap<string, TeamGameStats>>;

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
  /** Game stats summed over the matches this table is built from. Zero when there are none. */
  stats: TeamGameStats;
  /**
   * 1-based place. Rows still level after every tiebreak SHARE the place of the first of them, so two
   * rows can show the same rank - which is the honest answer until a tiebreaker match settles it.
   */
  rank: number;
  /**
   * Level with at least one neighbour after every tiebreak, numbers and tiebreaker matches alike. The
   * order between them in the array means nothing (it is seed order, so the table is stable), which is
   * why where it matters - see `tiesNeedingPlayoff` - a tiebreaker match is required instead.
   */
  tied: boolean;
}

export interface StandingsOptions {
  /** Use Buchholz as a tiebreak. Swiss only: in a finished round robin it cannot separate anyone. */
  buchholz?: boolean;
  /** Game stats by match key, for the sinks / shots / time tiebreaks. Absent: those steps are skipped. */
  stats?: MatchGameStats;
  /** Tiebreak-stage matches, the last step. Their wins never count in the table itself. */
  tiebreaks?: TMatch[];
  /**
   * Teams an administrator has removed. Their results still count for everyone who played them, but
   * they are ranked below everyone still in the event and never take part in a tie.
   */
  departed?: ReadonlySet<string>;
}

/** A value to compare: num / den, den > 0. Bigger is better. Null means "no data for this team". */
type Ratio = readonly [number, number] | null;

const cmp = (x: readonly [number, number], y: readonly [number, number]) => x[0] * y[1] - y[0] * x[1];

const EMPTY_STATS: TeamGameStats = { games: 0, sinks: 0, shots: 0, wonGames: 0, wonSeconds: 0 };

/**
 * Ranks entrants from their finished matches. Original seed never separates two teams.
 *
 *   1. Wins.
 *   2. Mini-table among only the tied teams: wins, then game difference, in their games against each
 *      other. A three-way tie that the mini-table splits into one team and a pair starts again for the
 *      pair, so the pair is decided by its own meeting.
 *   3. Game difference over the whole table.
 *   4. Buchholz (Swiss only).
 *   5. Most sinks per game played.
 *   6. Fewest shots per game played.
 *   7. Fastest winning game, on average.
 *   8. Tiebreaker matches among the tied teams, once none of them is still open.
 *
 * Steps 5-7 count only games actually played, per game, so a team that won a match by forfeit is
 * measured on the same footing as one that played it. A step a tied team has no data for (no games, or
 * no won game with a known time) is skipped for that tie rather than guessed at.
 *
 * Whenever a step splits a tie, each smaller tie starts again from step 2. Teams level after all eight
 * are `tied` and share a rank; it is up to the caller (see tiesNeedingPlayoff) to say whether that tie
 * matters enough to play off.
 */
export function computeStandings(ids: string[], matches: TMatch[], options: StandingsOptions = {}): StandingRow[] {
  const { buchholz: useBuchholz = true, stats, tiebreaks = [], departed = new Set<string>() } = options;
  const seedOf = new Map(ids.map((id, i) => [id, i] as const));
  const rows = new Map<string, StandingRow>(
    ids.map((id) => [
      id,
      { id, played: 0, wins: 0, losses: 0, byes: 0, gameDiff: 0, buchholz: 0, stats: { ...EMPTY_STATS }, rank: 0, tied: false },
    ]),
  );
  const opponents = new Map<string, string[]>(ids.map((id) => [id, []]));
  const meetings: TMatch[] = [];

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
    meetings.push(m);

    const played = stats?.get(m.key);
    for (const row of [ra, rb]) {
      const s = played?.get(row.id);
      if (!s) continue;
      row.stats.games += s.games;
      row.stats.sinks += s.sinks;
      row.stats.shots += s.shots;
      row.stats.wonGames += s.wonGames;
      row.stats.wonSeconds += s.wonSeconds;
    }
  }

  for (const row of rows.values()) {
    row.buchholz = opponents.get(row.id)!.reduce((sum, opp) => sum + rows.get(opp)!.wins, 0);
  }

  // Results among a set of teams only: the mini-table.
  const among = (set: ReadonlySet<string>, pool: TMatch[]) =>
    pool.filter((m) => m.a && m.b && set.has(m.a) && set.has(m.b));
  const miniTable = (set: ReadonlySet<string>, pool: TMatch[]) => {
    const wins = new Map<string, number>();
    const diff = new Map<string, number>();
    for (const m of among(set, pool)) {
      if (m.status !== "done" || !m.winner) continue;
      wins.set(m.winner, (wins.get(m.winner) ?? 0) + 1);
      diff.set(m.a!, (diff.get(m.a!) ?? 0) + m.scoreA - m.scoreB);
      diff.set(m.b!, (diff.get(m.b!) ?? 0) + m.scoreB - m.scoreA);
    }
    return { wins, diff };
  };

  type Step = (tie: StandingRow[]) => (row: StandingRow) => Ratio;
  const steps: Step[] = [
    (tie) => {
      const { wins } = miniTable(new Set(tie.map((r) => r.id)), meetings);
      return (row) => [wins.get(row.id) ?? 0, 1];
    },
    (tie) => {
      const { diff } = miniTable(new Set(tie.map((r) => r.id)), meetings);
      return (row) => [diff.get(row.id) ?? 0, 1];
    },
    () => (row) => [row.gameDiff, 1],
    ...(useBuchholz ? [(() => (row: StandingRow) => [row.buchholz, 1] as const) as Step] : []),
    () => (row) => (row.stats.games > 0 ? [row.stats.sinks, row.stats.games] : null),
    () => (row) => (row.stats.games > 0 ? [-row.stats.shots, row.stats.games] : null),
    () => (row) => (row.stats.wonGames > 0 ? [-row.stats.wonSeconds, row.stats.wonGames] : null),
    (tie) => {
      const set = new Set(tie.map((r) => r.id));
      const ours = among(set, tiebreaks);
      // Half a tiebreaker round says nothing yet: wait until every one of them is decided.
      if (ours.length === 0 || ours.some((m) => m.status !== "done" && m.status !== "skipped")) return () => null;
      const { wins } = miniTable(set, ours);
      return (row) => [wins.get(row.id) ?? 0, 1];
    },
  ];

  /** Splits `tie` into ordered classes by the first step that tells any of them apart. */
  const resolve = (tie: StandingRow[]): StandingRow[][] => {
    if (tie.length <= 1) return [tie];
    for (const step of steps) {
      const value = step(tie);
      const values = tie.map((row) => ({ row, v: value(row) }));
      if (values.some((x) => x.v === null)) continue;
      const sorted = values.sort((x, y) => cmp(y.v!, x.v!) || seedOf.get(x.row.id)! - seedOf.get(y.row.id)!);
      const classes: StandingRow[][] = [];
      for (let i = 0; i < sorted.length; i++) {
        if (i > 0 && cmp(sorted[i].v!, sorted[i - 1].v!) === 0) classes[classes.length - 1].push(sorted[i].row);
        else classes.push([sorted[i].row]);
      }
      if (classes.length > 1) return classes.flatMap(resolve);
    }
    // Nothing tells them apart. Seed order only so the table reads the same on every refresh.
    return [[...tie].sort((x, y) => seedOf.get(x.id)! - seedOf.get(y.id)!)];
  };

  const bySeed = (x: StandingRow, y: StandingRow) => seedOf.get(x.id)! - seedOf.get(y.id)!;
  const active = [...rows.values()].filter((row) => !departed.has(row.id));
  const gone = [...rows.values()].filter((row) => departed.has(row.id)).sort((x, y) => y.wins - x.wins || bySeed(x, y));

  const winGroups = new Map<number, StandingRow[]>();
  for (const row of active) winGroups.set(row.wins, [...(winGroups.get(row.wins) ?? []), row]);
  const classes = [...winGroups.keys()].sort((x, y) => y - x).flatMap((w) => resolve(winGroups.get(w)!));

  const out: StandingRow[] = [];
  for (const cls of classes) {
    const rank = out.length + 1;
    for (const row of cls) {
      row.rank = rank;
      row.tied = cls.length > 1;
      out.push(row);
    }
  }
  for (const row of gone) {
    row.rank = out.length + 1;
    out.push(row);
  }
  return out;
}

/**
 * The ties in a table that need a tiebreaker match: every run of `tied` rows that a boundary falls
 * inside. `boundaries` are the places that decide something - k means "between place k and place k+1",
 * so a cut to 4 that also seeds the knockout 1-4 is boundaries 1, 2, 3 and 4.
 *
 * A tie that no boundary passes through (two teams level in 6th, both out) is left alone: it changes
 * nothing, and the table just shows them sharing the place.
 */
export function tiesNeedingPlayoff(table: StandingRow[], boundaries: readonly number[]): string[][] {
  const out: string[][] = [];
  let i = 0;
  while (i < table.length) {
    let j = i + 1;
    while (j < table.length && table[i].tied && table[j].tied && table[j].rank === table[i].rank) j++;
    if (j - i > 1 && boundaries.some((k) => k > i && k < j)) out.push(table.slice(i, j).map((row) => row.id));
    i = j;
  }
  return out;
}
