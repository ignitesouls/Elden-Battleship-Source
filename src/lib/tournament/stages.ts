import { buildKnockout } from "./bracket";
import type { TournamentFormat } from "./format";
import { effectiveCut, groupPools } from "./format";
import { seedFromGroups, seedFromSwiss } from "./seeding";
import { applySchedule, scheduleShape, validateSchedule, type Schedule } from "./schedule";
import { computeStandings, tiesNeedingPlayoff, type MatchGameStats, type StandingRow } from "./standings";
import { pairSwissRound } from "./swiss";
import { newMatch, type TMatch } from "./types";

/**
 * The stages after the first: the next Swiss round, and the knockout that follows a qualifier.
 *
 * Both are decided by what has happened so far, so both are computed from the matches already played -
 * which is why they cannot be drawn at the start. Everything here is a plan: the desk page shows it to
 * the administrator, and only their confirmation sends it to the database, which independently refuses a
 * draw made at the wrong time (see add_tournament_matches).
 *
 * `seeded` is every team in the event, best seed first, and `departed` is the set an administrator has
 * removed. A departed team's earlier results still count for the teams that played it - beating someone
 * who later left is still a win - but it is never paired again and never advances.
 */

export interface QualifierStatus {
  /** Every qualifier match is decided (and, for Swiss, every round has been drawn). */
  complete: boolean;
  /** Why it isn't, in words for the administrator. Empty when complete. */
  waitingOn: string[];
  /** The teams going through, best seed first. Only meaningful once complete. */
  advancing: string[];
  /**
   * Ties that every tiebreak has failed to separate AND that decide something - who advances to the
   * knockout, or where they are seeded in it. Each needs a tiebreaker match, and the
   * qualifier is not complete until it is played. `group` is null for Swiss. Only filled once every
   * qualifier match is decided: before that the table is still moving.
   */
  playoffs: Playoff[];
  /** The table(s), for showing. One for Swiss, one per group for groups. */
  tables: StandingRow[][];
}

export interface Playoff {
  group: number | null;
  /** The tied teams, in table order. */
  ids: string[];
}

const isOpen = (m: TMatch) => m.status === "pending" || m.status === "ready" || m.status === "in_progress";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** 1..n */
const upTo = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);

/** The groups, recovered from the group matches themselves: everyone who has a match in group g is in it. */
export function groupsFromMatches(matches: TMatch[], seeded: string[]): string[][] {
  const members = new Map<number, Set<string>>();
  for (const m of matches) {
    if (m.stage !== "group" || m.group === null) continue;
    const set = members.get(m.group) ?? new Set<string>();
    if (m.a) set.add(m.a);
    if (m.b) set.add(m.b);
    members.set(m.group, set);
  }
  return [...members.keys()].sort((x, y) => x - y).map((g) => seeded.filter((id) => members.get(g)!.has(id)));
}

/**
 * Where qualifier standings are read, and why: `stats` are the per-game numbers behind the sinks / shots
 * / time tiebreaks (tournament_game_stats). Without them those steps are skipped - the table is still
 * right, a tie just reaches the tiebreaker-match step sooner.
 */
export function qualifierStatus(
  format: TournamentFormat,
  seeded: string[],
  matches: TMatch[],
  departed: ReadonlySet<string> = new Set(),
  stats?: MatchGameStats,
): QualifierStatus {
  const q = format.qualifier;
  const empty: QualifierStatus = { complete: false, waitingOn: [], advancing: [], playoffs: [], tables: [] };
  if (q.format === "none") return { ...empty, complete: true };

  const cut = effectiveCut(format, seeded.length);
  const tiebreaks = matches.filter((m) => m.stage === "tiebreak");
  const openTiebreaks = tiebreaks.filter(isOpen).length;

  // Ties that need playing off, but only once nothing else can move the table; and what is still
  // holding the qualifier open, in words for the administrator.
  const finish = (regularOpen: boolean, tables: StandingRow[][], boundaries: number[][], groupOf: (i: number) => number | null) => {
    const waitingOn: string[] = [];
    if (openTiebreaks > 0) waitingOn.push(`${plural(openTiebreaks, "tiebreaker match is", "tiebreaker matches are")} still open`);
    const playoffs: Playoff[] =
      regularOpen || openTiebreaks > 0
        ? []
        : tables.flatMap((table, i) => tiesNeedingPlayoff(table, boundaries[i] ?? []).map((ids) => ({ group: groupOf(i), ids })));
    if (playoffs.length > 0) waitingOn.push(`${plural(playoffs.length, "tie needs", "ties need")} a tiebreaker match`);
    return { waitingOn, playoffs };
  };

  if (q.format === "swiss") {
    const swiss = matches.filter((m) => m.stage === "swiss");
    const drawn = swiss.reduce((most, m) => Math.max(most, m.round), 0);
    const waitingOn: string[] = [];
    if (drawn < q.rounds) waitingOn.push(`Round ${drawn + 1} of ${q.rounds} has not been drawn`);
    const open = swiss.filter(isOpen).length;
    if (open > 0) waitingOn.push(`${open} match${open === 1 ? " is" : "es are"} still open`);

    const table = computeStandings(seeded, swiss, { stats, tiebreaks, departed }).filter((row) => !departed.has(row.id));
    // Every place inside the cut seeds the knockout. With no knockout nothing rides on a place - the
    // event records no champion and finishes on its own - so a tie there is simply shown shared.
    const boundaries = format.knockout ? upTo(cut) : [];
    const tie = finish(waitingOn.length > 0, [table], [boundaries], () => null);
    waitingOn.push(...tie.waitingOn);
    return {
      complete: waitingOn.length === 0,
      waitingOn,
      advancing: seedFromSwiss(table, cut),
      playoffs: tie.playoffs,
      tables: [table],
    };
  }

  // Groups.
  const groupMatches = matches.filter((m) => m.stage === "group");
  const open = groupMatches.filter(isOpen).length;
  const groups = groupsFromMatches(groupMatches, seeded);
  const tables = groups.map((ids, g) =>
    computeStandings(ids, groupMatches.filter((m) => m.group === g), {
      buchholz: false,
      stats,
      tiebreaks: tiebreaks.filter((m) => m.group === g),
      departed,
    }).filter((row) => !departed.has(row.id)),
  );
  const pools = groupPools(q);
  const takes = pools.map((p) => p.advance);
  // Each place a group sends is its own seeding tier, so every one of them matters, as does the cut.
  const boundaries = tables.map((_, g) => (format.knockout ? upTo(takes[g] ?? 0) : []));
  const waitingOn = open > 0 ? [`${open} match${open === 1 ? " is" : "es are"} still open`] : [];
  const tie = finish(open > 0, tables, boundaries, (g) => g);
  waitingOn.push(...tie.waitingOn);
  return {
    complete: groupMatches.length > 0 && waitingOn.length === 0,
    waitingOn,
    advancing: seedFromGroups(tables, takes, pools.map((p) => p.challenger)),
    playoffs: tie.playoffs,
    tables,
  };
}

/**
 * Tiebreaker matches for every tie the qualifier needs played off (QualifierStatus.playoffs): a
 * single-game round robin among each tied set - one match for a pair, three for three teams, and so on.
 * If a round robin goes round in a circle again, the next call draws another.
 *
 * No deadline is set: a tiebreaker is played as soon as the teams can, and the administrator chases it.
 */
export function planTiebreaks(
  format: TournamentFormat,
  seeded: string[],
  matches: TMatch[],
  departed: ReadonlySet<string>,
  stats?: MatchGameStats,
): StagePlan {
  if (format.qualifier.format === "none") return { ok: false, problems: ["This event has no qualifier standings."] };
  if (matches.some((m) => m.stage === "knockout")) return { ok: false, problems: ["The knockout has already been built."] };
  const status = qualifierStatus(format, seeded, matches, departed, stats);
  if (status.playoffs.length === 0) return { ok: false, problems: ["No tie needs a tiebreaker match."] };

  const round = matches.filter((m) => m.stage === "tiebreak").reduce((most, m) => Math.max(most, m.round), 0) + 1;
  const out: TMatch[] = [];
  for (const playoff of status.playoffs) {
    for (let i = 0; i < playoff.ids.length; i++) {
      for (let j = i + 1; j < playoff.ids.length; j++) {
        out.push(
          newMatch({
            key: `TB${round}-${out.length}`,
            stage: "tiebreak",
            group: playoff.group,
            round,
            index: out.length,
            a: playoff.ids[i],
            b: playoff.ids[j],
            bestOf: 1,
          }),
        );
      }
    }
  }
  return { ok: true, matches: out };
}

export type StagePlan = { ok: true; matches: TMatch[] } | { ok: false; problems: string[] };

/**
 * The next Swiss round, paired from the standings. Refused unless the round before is finished and
 * there is a round left to draw.
 */
export function planNextSwissRound(
  format: TournamentFormat,
  seeded: string[],
  matches: TMatch[],
  departed: ReadonlySet<string>,
  schedule: Schedule,
): StagePlan {
  const q = format.qualifier;
  if (q.format !== "swiss") return { ok: false, problems: ["This event has no Swiss rounds."] };

  const swiss = matches.filter((m) => m.stage === "swiss");
  const drawn = swiss.reduce((most, m) => Math.max(most, m.round), 0);
  const problems = [...validateSchedule(schedule, scheduleShape(format, seeded.length).ctx)];
  if (drawn >= q.rounds) problems.push(`All ${q.rounds} rounds have been drawn.`);
  const open = swiss.filter(isOpen).length;
  if (open > 0) problems.push(`Round ${drawn} is not finished: ${open} match${open === 1 ? " is" : "es are"} still open.`);
  if (seeded.filter((id) => !departed.has(id)).length < 2) problems.push("Fewer than two teams are left to pair.");
  if (problems.length > 0) return { ok: false, problems };

  const paired = pairSwissRound(seeded, swiss, drawn + 1, q.bestOf, departed);
  return { ok: true, matches: applySchedule(paired, schedule, scheduleShape(format, seeded.length).ctx) };
}

/**
 * The knockout, seeded from `advancing` (best first). Refused unless the qualifier is finished; the
 * caller supplies the order so an administrator can settle a tie at the cut line before confirming.
 */
export function planKnockout(
  format: TournamentFormat,
  seeded: string[],
  matches: TMatch[],
  departed: ReadonlySet<string>,
  advancing: string[],
  schedule: Schedule,
  stats?: MatchGameStats,
): StagePlan {
  const problems = [...validateSchedule(schedule, scheduleShape(format, seeded.length).ctx)];
  if (!format.knockout) problems.push("This event has no knockout.");
  if (matches.some((m) => m.stage === "knockout")) problems.push("The knockout has already been built.");

  const status = qualifierStatus(format, seeded, matches, departed, stats);
  if (!status.complete) problems.push(`The qualifier is not finished: ${status.waitingOn.join("; ")}.`);
  if (advancing.length < 2) problems.push("A knockout needs at least two teams.");
  if (new Set(advancing).size !== advancing.length) problems.push("A team is listed twice.");
  if (advancing.some((id) => departed.has(id))) problems.push("A team that has been removed cannot advance.");
  if (advancing.some((id) => !seeded.includes(id))) problems.push("A team that is not in the event cannot advance.");
  if (problems.length > 0 || !format.knockout) return { ok: false, problems };

  const drawn = buildKnockout(advancing, format.knockout);
  return { ok: true, matches: applySchedule(drawn, schedule, scheduleShape(format, seeded.length).ctx) };
}
