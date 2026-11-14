import type { StandingRow } from "./standings";
import type { TMatch } from "./types";

/**
 * Who has clinched a knockout place, who is out, and what it would take - the playoff picture.
 *
 * -- Wins only, so a verdict is never taken back -------------------------------------------------------
 *
 * Every verdict here is about WINS alone. A team has clinched when, whatever happens in the matches still
 * to play, fewer teams than the cut can finish level with it or above it on wins. It is out when, even
 * winning everything it has left, as many teams as the cut are sure to finish with MORE wins. A team that
 * could end up level on wins at the line is neither: head-to-head, game difference, the game stats and a
 * tiebreaker match decide that, and none of them can be known in advance. So "clinched" and "out" can come
 * later than a cleverer calculation would allow, but once shown they are never wrong.
 *
 * Once a table has nothing left to play, its own order (every tiebreak included) is the verdict, apart
 * from teams still level at the line, who are waiting on a tiebreaker match.
 *
 * -- Groups and Swiss ----------------------------------------------------------------------------------
 *
 * A round-robin group knows every match it has left, so its answers are exact: for "can these k teams all
 * reach W wins?" the matches between them are shared out by a small flow (each match gives one win to one
 * of its two teams). A Swiss qualifier does not know its future pairings, so it can only say that a team
 * gains at most one win per round left; that bound is safe, just slower to settle anything, and there are
 * no next-match scenarios because the next opponent is not drawn yet.
 *
 * Pure: no React, no Supabase. Checked against a brute force in scripts/check-tournament.ts.
 */

export type Fate = "clinched" | "eliminated" | "alive";

/** One result, as "winner beats loser". */
export interface ResultRef {
  key: string;
  winner: string;
  loser: string;
}

/** What one result of the team's next match would leave it facing. */
export interface Branch {
  fate: Fate;
  /** Still alive: single results elsewhere that would, together with this one, clinch it. */
  clinchIf: ResultRef[];
  /** Still alive: single results elsewhere that would, together with this one, knock it out. */
  outIf: ResultRef[];
}

export interface NextMatch {
  key: string;
  opponent: string;
  win: Branch;
  loss: Branch;
}

export interface Outlook {
  id: string;
  fate: Fate;
  /** Matches (Swiss: rounds) the team still has to play. */
  remaining: number;
  /**
   * Waiting on a tiebreaker match: the table is finished and the team is level with another at the line.
   * Always "alive".
   */
  awaitingTiebreak: boolean;
  /** Winning everything left clinches, whatever else happens. */
  ownDestiny: boolean;
  /**
   * The fewest further wins that clinch, whichever of its matches they come from and whatever else
   * happens. Null when decided, or when no number of its own wins is enough (it needs help) - or, in a
   * group with too many matches left to work through (see MAX_SUBSET_MATCHES), when only winning out is
   * known to be enough (then it equals `remaining`).
   */
  clinchWith: number | null;
  /**
   * The fewest further losses that knock it out, whichever matches they are and whatever else happens.
   * Null when decided, or when losing alone can never do it.
   */
  outWith: number | null;
  /** Groups only, while alive: what each result of its next match would mean. */
  next: NextMatch | null;
}

/** Past this many matches left, a group team's "any N wins" is not worked out subset by subset. */
const MAX_SUBSET_MATCHES = 10;

const isOpen = (m: TMatch) => m.status === "pending" || m.status === "ready" || m.status === "in_progress";

/** Every k-element subset of `items`, as index lists. */
function* combinations(n: number, k: number): Generator<number[]> {
  if (k < 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * The most matches that can each be handed to one of their two teams without any team going over its
 * capacity (a team absent from `cap` takes none). Augmenting paths, Kuhn style with capacities - the
 * graphs here are a few dozen matches at most.
 */
function maxAssign(matches: ReadonlyArray<readonly [string, string]>, cap: ReadonlyMap<string, number>): number {
  const owner: (string | null)[] = matches.map(() => null);
  const load = new Map<string, number>();
  const assigned = new Map<string, number[]>();

  const tryAssign = (mi: number, seen: Set<string>): boolean => {
    for (const team of matches[mi]) {
      if ((cap.get(team) ?? 0) <= 0 || seen.has(team)) continue;
      seen.add(team);
      if ((load.get(team) ?? 0) < cap.get(team)!) {
        owner[mi] = team;
        load.set(team, (load.get(team) ?? 0) + 1);
        assigned.set(team, [...(assigned.get(team) ?? []), mi]);
        return true;
      }
      for (const mj of assigned.get(team) ?? []) {
        const other = matches[mj][0] === team ? matches[mj][1] : matches[mj][0];
        if ((cap.get(other) ?? 0) <= 0 || seen.has(other)) continue;
        // Move mj to its other team, freeing a slot here for mi.
        if (tryAssign(mj, seen)) {
          assigned.set(team, assigned.get(team)!.filter((x) => x !== mj));
          load.set(team, load.get(team)! - 1);
          owner[mi] = team;
          load.set(team, load.get(team)! + 1);
          assigned.set(team, [...assigned.get(team)!, mi]);
          return true;
        }
      }
    }
    return false;
  };

  let n = 0;
  for (let i = 0; i < matches.length; i++) if (tryAssign(i, new Set())) n++;
  return n;
}

/**
 * Teams in the table are decided once nothing is left to play: inside the cut is through, outside is
 * out, except a run of teams level on everything that the line passes through.
 */
function settledByTable(table: StandingRow[], cut: number): Map<string, Fate> {
  const out = new Map<string, Fate>();
  let i = 0;
  while (i < table.length) {
    let j = i + 1;
    while (j < table.length && table[i].tied && table[j].tied && table[j].rank === table[i].rank) j++;
    const straddles = cut > i && cut < j;
    for (let x = i; x < j; x++) out.set(table[x].id, straddles ? "alive" : x < cut ? "clinched" : "eliminated");
    i = j;
  }
  return out;
}

const decided = (id: string, fate: Fate, awaitingTiebreak = false): Outlook => ({
  id,
  fate,
  remaining: 0,
  awaitingTiebreak,
  ownDestiny: false,
  clinchWith: null,
  outWith: null,
  next: null,
});

/**
 * The outlook for every team in one round-robin group. `table` is the group's standings with departed
 * teams already left out; `matches` are the group's own matches (not its tiebreakers); `cut` is how many
 * it sends to the knockout.
 */
export function groupOutlook(table: StandingRow[], matches: TMatch[], cut: number): Outlook[] {
  const ids = table.map((row) => row.id);
  const counted = new Set(ids);
  // Results still to come. A match against a team that has left is normally forfeited already; if one is
  // still open it is played out like any other, its departed side just never counted.
  const open = matches.filter((m) => isOpen(m) && m.a && m.b && (counted.has(m.a) || counted.has(m.b)));

  if (open.length === 0) {
    const fates = settledByTable(table, cut);
    return ids.map((id) => decided(id, fates.get(id)!, fates.get(id) === "alive"));
  }

  const baseWins = new Map(table.map((row) => [row.id, row.wins] as const));

  /** Wins after the fixed results, and the matches left once they are taken out. */
  const apply = (fixed: ReadonlyMap<string, string>) => {
    const wins = new Map(baseWins);
    const rest: TMatch[] = [];
    for (const m of open) {
      const w = fixed.get(m.key);
      if (w === undefined) rest.push(m);
      else if (counted.has(w)) wins.set(w, wins.get(w)! + 1);
    }
    return { wins, rest };
  };

  /** Whether `team` is through on wins whatever happens beyond `fixed`. */
  const clinchedGiven = (team: string, fixed: ReadonlyMap<string, string>): boolean => {
    const { wins, rest } = apply(fixed);
    // The worst case for the team: it loses everything else.
    const others: TMatch[] = [];
    for (const m of rest) {
      if (m.a === team || m.b === team) {
        const opp = m.a === team ? m.b! : m.a!;
        if (counted.has(opp)) wins.set(opp, wins.get(opp)! + 1);
      } else others.push(m);
    }
    const target = wins.get(team)!;
    const rivals = ids.filter((id) => id !== team);
    if (rivals.length < cut) return true;
    // Can some `cut` rivals all reach the team's total? Then it is not through.
    for (const pick of combinations(rivals.length, cut)) {
      const S = new Set(pick.map((i) => rivals[i]));
      const need = new Map<string, number>();
      for (const s of S) need.set(s, Math.max(0, target - wins.get(s)!));
      const inner: [string, string][] = [];
      for (const m of others) {
        const inA = S.has(m.a!), inB = S.has(m.b!);
        if (inA && inB) inner.push([m.a!, m.b!]);
        else if (inA) need.set(m.a!, Math.max(0, need.get(m.a!)! - 1));
        else if (inB) need.set(m.b!, Math.max(0, need.get(m.b!)! - 1));
      }
      const total = [...need.values()].reduce((x, y) => x + y, 0);
      if (total === 0 || (total <= inner.length && maxAssign(inner, need) === total)) return false;
    }
    return true;
  };

  /** Whether `team` is out on wins whatever happens beyond `fixed`. */
  const eliminatedGiven = (team: string, fixed: ReadonlyMap<string, string>): boolean => {
    const { wins, rest } = apply(fixed);
    // The best case for the team: it wins everything else.
    const others: TMatch[] = [];
    for (const m of rest) {
      if (m.a === team || m.b === team) wins.set(team, wins.get(team)! + 1);
      else others.push(m);
    }
    const target = wins.get(team)!;
    const rivals = ids.filter((id) => id !== team);
    const allowed = cut - 1; // rivals that may finish above it while it still makes the cut
    if (rivals.length <= allowed) return false;
    // Pick who may finish above; can everyone else be held to the team's total or below?
    for (const pick of combinations(rivals.length, allowed)) {
      const A = new Set(pick.map((i) => rivals[i]));
      const cap = new Map<string, number>();
      let ok = true;
      for (const s of rivals) {
        if (A.has(s)) continue;
        const room = target - wins.get(s)!;
        if (room < 0) ok = false;
        cap.set(s, room);
      }
      if (!ok) continue;
      // A match with a team allowed above (or one not counted) can go to that team at no cost.
      const contested: [string, string][] = others
        .filter((m) => cap.has(m.a!) && cap.has(m.b!))
        .map((m) => [m.a!, m.b!]);
      if (maxAssign(contested, cap) === contested.length) return false;
    }
    return true;
  };

  const fateGiven = (team: string, fixed: ReadonlyMap<string, string>): Fate =>
    clinchedGiven(team, fixed) ? "clinched" : eliminatedGiven(team, fixed) ? "eliminated" : "alive";

  return ids.map((team): Outlook => {
    const fate = fateGiven(team, new Map());
    const mine = open.filter((m) => m.a === team || m.b === team);
    const remaining = mine.length;
    if (fate !== "alive") return { ...decided(team, fate), remaining };

    const opponentOf = (m: TMatch) => (m.a === team ? m.b! : m.a!);
    const fixedFor = (winSet: ReadonlySet<number>) =>
      new Map(mine.map((m, i) => [m.key, winSet.has(i) ? team : opponentOf(m)] as const));
    const allWin = new Map(mine.map((m) => [m.key, team] as const));
    const ownDestiny = clinchedGiven(team, allWin);

    // "Any N wins": every way of winning N of its matches clinches. Monotone in N, so the first N found.
    // Only the chosen wins are fixed; its other matches are left to the worst case.
    let clinchWith: number | null = null;
    let outWith: number | null = null;
    if (remaining <= MAX_SUBSET_MATCHES) {
      for (let n = 0; n <= remaining && clinchWith === null; n++) {
        let every = true;
        for (const pick of combinations(remaining, n)) {
          const fixed = new Map(pick.map((i) => [mine[i].key, team] as const));
          if (!clinchedGiven(team, fixed)) {
            every = false;
            break;
          }
        }
        if (every) clinchWith = n;
      }
      for (let n = 1; n <= remaining && outWith === null; n++) {
        let every = true;
        for (const pick of combinations(remaining, n)) {
          const fixed = new Map(pick.map((i) => [mine[i].key, opponentOf(mine[i])] as const));
          if (!eliminatedGiven(team, fixed)) {
            every = false;
            break;
          }
        }
        if (every) outWith = n;
      }
    } else {
      clinchWith = ownDestiny ? remaining : null;
      outWith = eliminatedGiven(team, fixedFor(new Set())) ? remaining : null;
    }

    // Its next match: the earliest round it has open.
    const nextMatch = [...mine].sort((x, y) => x.round - y.round || x.index - y.index)[0];
    let next: NextMatch | null = null;
    if (nextMatch) {
      const opponent = opponentOf(nextMatch);
      const elsewhere = open.filter((m) => m.a !== team && m.b !== team);
      const branch = (winner: string): Branch => {
        const fixed = new Map([[nextMatch.key, winner]]);
        const f = fateGiven(team, fixed);
        if (f !== "alive") return { fate: f, clinchIf: [], outIf: [] };
        const clinchIf: ResultRef[] = [];
        const outIf: ResultRef[] = [];
        for (const m of elsewhere) {
          for (const [w, l] of [[m.a!, m.b!], [m.b!, m.a!]] as const) {
            const both = new Map(fixed).set(m.key, w);
            if (clinchedGiven(team, both)) clinchIf.push({ key: m.key, winner: w, loser: l });
            else if (eliminatedGiven(team, both)) outIf.push({ key: m.key, winner: w, loser: l });
          }
        }
        return { fate: "alive", clinchIf, outIf };
      };
      next = { key: nextMatch.key, opponent, win: branch(team), loss: branch(opponent) };
    }

    return { id: team, fate, remaining, awaitingTiebreak: false, ownDestiny, clinchWith, outWith, next };
  });
}

/**
 * The outlook for every team in a Swiss qualifier of `rounds` rounds. Future pairings are unknown, so a
 * team is only known to gain at most one win per round it has left (a bye included) - a safe bound.
 */
export function swissOutlook(table: StandingRow[], matches: TMatch[], rounds: number, cut: number): Outlook[] {
  const ids = table.map((row) => row.id);
  const finished = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const m of matches) {
    if (m.stage !== "swiss" || m.status !== "done") continue;
    for (const id of [m.a, m.b]) if (id && finished.has(id)) finished.set(id, finished.get(id)! + 1);
  }
  const left = new Map(ids.map((id) => [id, Math.max(0, rounds - finished.get(id)!)] as const));

  if (ids.every((id) => left.get(id) === 0) && !matches.some((m) => m.stage === "swiss" && isOpen(m))) {
    const fates = settledByTable(table, cut);
    return ids.map((id) => decided(id, fates.get(id)!, fates.get(id) === "alive"));
  }

  const wins = new Map(table.map((row) => [row.id, row.wins] as const));
  const ceiling = (id: string) => wins.get(id)! + left.get(id)!;
  /** Through with `floor` wins: fewer than `cut` others can reach it. */
  const safeAt = (team: string, floor: number) => ids.filter((s) => s !== team && ceiling(s) >= floor).length < cut;
  /** Out with at most `top` wins: at least `cut` others already have more. */
  const outAt = (team: string, top: number) => ids.filter((s) => s !== team && wins.get(s)! > top).length >= cut;

  return ids.map((team): Outlook => {
    const w = wins.get(team)!;
    const r = left.get(team)!;
    if (safeAt(team, w)) return { ...decided(team, "clinched"), remaining: r };
    if (outAt(team, w + r)) return { ...decided(team, "eliminated"), remaining: r };
    let clinchWith: number | null = null;
    for (let n = 1; n <= r && clinchWith === null; n++) if (safeAt(team, w + n)) clinchWith = n;
    let outWith: number | null = null;
    for (let n = 1; n <= r && outWith === null; n++) if (outAt(team, w + r - n)) outWith = n;
    return { id: team, fate: "alive", remaining: r, awaitingTiebreak: false, ownDestiny: clinchWith !== null, clinchWith, outWith, next: null };
  });
}
