import { buildKnockout } from "./bracket";
import type { TournamentFormat } from "./format";
import { effectiveCut } from "./format";
import { seedFromGroups, seedFromSwiss } from "./seeding";
import { applySchedule, scheduleShape, validateSchedule, type Schedule } from "./schedule";
import { computeStandings, cutLineTied, type StandingRow } from "./standings";
import { pairSwissRound } from "./swiss";
import type { TMatch } from "./types";

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
   * The line between the last team in and the first team out is a genuine tie on every tiebreak, so the
   * order was settled by original seed alone. The administrator should look at it (or play it off)
   * rather than let a coin flip they didn't choose eliminate someone.
   */
  cutTied: boolean;
  /** The table(s), for showing. One for Swiss, one per group for groups. */
  tables: StandingRow[][];
}

const isOpen = (m: TMatch) => m.status === "pending" || m.status === "ready" || m.status === "in_progress";

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

export function qualifierStatus(
  format: TournamentFormat,
  seeded: string[],
  matches: TMatch[],
  departed: ReadonlySet<string> = new Set(),
): QualifierStatus {
  const q = format.qualifier;
  const empty: QualifierStatus = { complete: false, waitingOn: [], advancing: [], cutTied: false, tables: [] };
  if (q.format === "none") return { ...empty, complete: true };

  const cut = effectiveCut(format, seeded.length);

  if (q.format === "swiss") {
    const swiss = matches.filter((m) => m.stage === "swiss");
    const drawn = swiss.reduce((most, m) => Math.max(most, m.round), 0);
    const waitingOn: string[] = [];
    if (drawn < q.rounds) waitingOn.push(`Round ${drawn + 1} of ${q.rounds} has not been drawn`);
    const open = swiss.filter(isOpen).length;
    if (open > 0) waitingOn.push(`${open} match${open === 1 ? " is" : "es are"} still open`);

    const table = computeStandings(seeded, swiss).filter((row) => !departed.has(row.id));
    return {
      complete: waitingOn.length === 0,
      waitingOn,
      advancing: seedFromSwiss(table, cut),
      cutTied: cut > 0 && cutLineTied(table, cut),
      tables: [table],
    };
  }

  // Groups.
  const groupMatches = matches.filter((m) => m.stage === "group");
  const open = groupMatches.filter(isOpen).length;
  const groups = groupsFromMatches(groupMatches, seeded);
  const tables = groups.map((ids, g) =>
    computeStandings(ids, groupMatches.filter((m) => m.group === g)).filter((row) => !departed.has(row.id)),
  );
  const perGroup = q.advancePerGroup ?? 0;
  return {
    complete: groupMatches.length > 0 && open === 0,
    waitingOn: open > 0 ? [`${open} match${open === 1 ? " is" : "es are"} still open`] : [],
    advancing: seedFromGroups(tables, perGroup),
    cutTied: perGroup > 0 && tables.some((table) => cutLineTied(table, perGroup)),
    tables,
  };
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
  const problems = [...validateSchedule(schedule)];
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
): StagePlan {
  const problems = [...validateSchedule(schedule)];
  if (!format.knockout) problems.push("This event has no knockout.");
  if (matches.some((m) => m.stage === "knockout")) problems.push("The knockout has already been built.");

  const status = qualifierStatus(format, seeded, matches, departed);
  if (!status.complete) problems.push(`The qualifier is not finished: ${status.waitingOn.join("; ")}.`);
  if (advancing.length < 2) problems.push("A knockout needs at least two teams.");
  if (new Set(advancing).size !== advancing.length) problems.push("A team is listed twice.");
  if (advancing.some((id) => departed.has(id))) problems.push("A team that has been removed cannot advance.");
  if (advancing.some((id) => !seeded.includes(id))) problems.push("A team that is not in the event cannot advance.");
  if (problems.length > 0 || !format.knockout) return { ok: false, problems };

  const drawn = buildKnockout(advancing, format.knockout);
  return { ok: true, matches: applySchedule(drawn, schedule, scheduleShape(format, seeded.length).ctx) };
}
