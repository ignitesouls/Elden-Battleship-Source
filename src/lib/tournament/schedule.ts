import { buildKnockout } from "./bracket";
import { effectiveCut } from "./format";
import type { TournamentFormat } from "./format";
import { assignGroups, roundRobin } from "./groups";
import type { MatchStage, TMatch } from "./types";

/**
 * When an event's rounds open and close. An event that runs for weeks is played in windows: round 1
 * opens on the start date and is due N days later, round 2 opens as round 1 closes, and so on. Teams
 * play whenever inside the window suits them; the deadline is what the organizers chase.
 *
 * Deadlines are advisory - see 20260921030000_tournament_schedule.sql. Nothing here (or in the
 * database) forfeits anyone; an overdue match is a line on an admin's list.
 */
export interface Schedule {
  /** When the first round opens. ISO timestamp. */
  startsAt: string;
  /** Days each round is open for, unless overridden. */
  roundDays: number;
  /** A breather between the qualifier's last round and the knockout's first. */
  stageGapDays: number;
  /** Days for one specific round, keyed "swiss:3", "group:2" or "knockout:4". */
  overrides: Record<string, number>;
}

/** What the schedule needs to know about the event to lay knockout rounds after the qualifier. */
export interface ScheduleContext {
  qualifierStage: Extract<MatchStage, "swiss" | "group"> | null;
  /** How many rounds the qualifier has in total - all of them, not just those drawn so far. */
  qualifierRounds: number;
}

const DAY_MS = 86_400_000;

export function daysFor(schedule: Schedule, stage: MatchStage, phase: number): number {
  return schedule.overrides[`${stage}:${phase}`] ?? schedule.roundDays;
}

/**
 * The window for one round. Rounds are laid end to end from the start date, so a change to one
 * round's length moves every later round with it - which is what an organizer means by "give round 2
 * another week".
 */
export function windowFor(
  schedule: Schedule,
  ctx: ScheduleContext,
  stage: MatchStage,
  phase: number,
): { opensAt: string; dueAt: string } {
  let offset = 0;
  if (stage === "knockout" && ctx.qualifierStage && ctx.qualifierRounds > 0) {
    for (let p = 1; p <= ctx.qualifierRounds; p++) offset += daysFor(schedule, ctx.qualifierStage, p);
    offset += schedule.stageGapDays;
  }
  for (let p = 1; p < phase; p++) offset += daysFor(schedule, stage, p);

  const opens = Date.parse(schedule.startsAt) + offset * DAY_MS;
  return {
    opensAt: new Date(opens).toISOString(),
    dueAt: new Date(opens + daysFor(schedule, stage, phase) * DAY_MS).toISOString(),
  };
}

/** Stamps every match with the window of its stage and phase. Returns new matches. */
export function applySchedule(matches: TMatch[], schedule: Schedule, ctx: ScheduleContext): TMatch[] {
  return matches.map((m) => ({ ...m, ...windowFor(schedule, ctx, m.stage, m.phase) }));
}

/** Everything wrong with a schedule, in words an organizer can act on. */
export function validateSchedule(schedule: Schedule): string[] {
  const errors: string[] = [];
  if (Number.isNaN(Date.parse(schedule.startsAt))) errors.push("Choose a start date.");
  if (!Number.isFinite(schedule.roundDays) || schedule.roundDays <= 0) errors.push("A round has to stay open for more than zero days.");
  if (!Number.isFinite(schedule.stageGapDays) || schedule.stageGapDays < 0) errors.push("The gap between stages can't be negative.");
  for (const [key, days] of Object.entries(schedule.overrides)) {
    if (!/^(swiss|group|knockout):\d+$/.test(key)) errors.push(`"${key}" is not a round.`);
    else if (!Number.isFinite(days) || days <= 0) errors.push(`${key} has to stay open for more than zero days.`);
  }
  return errors;
}

/** When the whole event is meant to be over: the last round's deadline. */
export function scheduleEnd(schedule: Schedule, ctx: ScheduleContext, knockoutPhases: number): string {
  if (knockoutPhases > 0) return windowFor(schedule, ctx, "knockout", knockoutPhases).dueAt;
  if (ctx.qualifierStage) return windowFor(schedule, ctx, ctx.qualifierStage, ctx.qualifierRounds).dueAt;
  return schedule.startsAt;
}

export interface ScheduleShape {
  ctx: ScheduleContext;
  /** Rounds in the knockout, as phases (0 if there is none). */
  knockoutPhases: number;
}

/** How many rounds each part of a format has for a field of `n`, which is what a schedule is fitted to. */
export function scheduleShape(format: TournamentFormat, n: number): ScheduleShape {
  const q = format.qualifier;
  let qualifierRounds = 0;
  if (q.format === "swiss") {
    qualifierRounds = q.rounds;
  } else if (q.format === "groups") {
    const dummy = Array.from({ length: n }, (_, i) => String(i));
    const longest = Math.max(...assignGroups(dummy, q.groupCount).map((g) => roundRobin(g).length));
    qualifierRounds = longest * q.legs;
  }

  let knockoutPhases = 0;
  if (format.knockout) {
    const cut = effectiveCut(format, n);
    if (cut >= 2) {
      const dummy = Array.from({ length: cut }, (_, i) => String(i));
      knockoutPhases = Math.max(...buildKnockout(dummy, format.knockout).map((m) => m.phase));
    }
  }
  return { ctx: { qualifierStage: q.format === "none" ? null : q.format === "swiss" ? "swiss" : "group", qualifierRounds }, knockoutPhases };
}

/**
 * A schedule that fits the format into about `targetDays` - a month by default. Every round gets an
 * equal share of the time after a short breather between the qualifier and the knockout, with a floor
 * of two days a round so a large bracket doesn't come out with windows too short to arrange a match
 * in. If the format needs more rounds than the target allows, the floor wins and the event runs
 * longer; `days` says by how much.
 */
export function suggestSchedule(
  format: TournamentFormat,
  n: number,
  startsAt: string,
  targetDays = 28,
): { schedule: Schedule; days: number; rounds: number } {
  const { ctx, knockoutPhases } = scheduleShape(format, n);
  const rounds = ctx.qualifierRounds + knockoutPhases;
  const stageGapDays = ctx.qualifierRounds > 0 && knockoutPhases > 0 ? 2 : 0;
  const roundDays = rounds > 0 ? Math.max(2, Math.floor((targetDays - stageGapDays) / rounds)) : 0;
  return {
    schedule: { startsAt, roundDays: roundDays || 7, stageGapDays, overrides: {} },
    days: rounds * roundDays + stageGapDays,
    rounds,
  };
}

/** A match that is open, has a deadline, and is past it. The admin's list is exactly these. */
export function isOverdue(m: Pick<TMatch, "status" | "dueAt">, now: Date): boolean {
  return (m.status === "ready" || m.status === "in_progress") && m.dueAt !== null && Date.parse(m.dueAt) < now.getTime();
}

export function overdueMatches(matches: TMatch[], now: Date): TMatch[] {
  return matches
    .filter((m) => isOverdue(m, now))
    .sort((x, y) => Date.parse(x.dueAt!) - Date.parse(y.dueAt!) || (x.key < y.key ? -1 : 1));
}
