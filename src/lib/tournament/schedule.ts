import { buildKnockout } from "./bracket";
import { effectiveCut, groupSizes } from "./format";
import type { TournamentFormat } from "./format";
import { roundRobin } from "./groups";
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
  /**
   * A group stage played in weeks rather than one matchday after another: each week has its own dates
   * and the matchdays played in it, so "five matchdays over three weeks" is two, two and one. Present
   * (even empty) means the organizer is laying the group stage out by week; absent means the round by
   * round layout above. Only a group stage uses it - Swiss rounds are drawn one at a time from results,
   * so two of them can't share a window.
   */
  groupWeeks?: ScheduleWeek[];
}

/** One window of a group stage played in weeks. Every matchday in it shares its dates. */
export interface ScheduleWeek {
  opensAt: string;
  dueAt: string;
  /** Group matchdays (phases) played this week. */
  matchdays: number[];
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

/** The group stage's weeks, when this event's group stage is laid out by week; null otherwise. */
export function groupWeeksOf(schedule: Schedule, ctx: ScheduleContext): ScheduleWeek[] | null {
  return ctx.qualifierStage === "group" && Array.isArray(schedule.groupWeeks) ? schedule.groupWeeks : null;
}

/**
 * `matchdays` group matchdays spread over `weeks` back-to-back weeks from `startsAt`, as evenly as they
 * go, earlier weeks taking the extra: five over three is 1-2, 3-4, 5. Never more weeks than matchdays -
 * a week with nothing in it would be an error.
 */
export function spreadGroupWeeks(startsAt: string, matchdays: number, weeks: number): ScheduleWeek[] {
  if (matchdays <= 0) return [];
  const count = Math.max(1, Math.min(Math.floor(weeks) || 1, matchdays));
  const start = Date.parse(startsAt);
  const out: ScheduleWeek[] = [];
  let next = 1;
  for (let i = 0; i < count; i++) {
    const take = Math.floor(matchdays / count) + (i < matchdays % count ? 1 : 0);
    out.push({
      opensAt: new Date(start + 7 * i * DAY_MS).toISOString(),
      dueAt: new Date(start + 7 * (i + 1) * DAY_MS).toISOString(),
      matchdays: Array.from({ length: take }, (_, k) => next + k),
    });
    next += take;
  }
  return out;
}

/**
 * The window for one round. Rounds are laid end to end from the start date, so a change to one
 * round's length moves every later round with it - which is what an organizer means by "give round 2
 * another week". A group stage laid out by week takes each matchday's dates from its week instead, and
 * the knockout then follows the last week to close.
 */
export function windowFor(
  schedule: Schedule,
  ctx: ScheduleContext,
  stage: MatchStage,
  phase: number,
): { opensAt: string; dueAt: string } {
  const weeks = groupWeeksOf(schedule, ctx);
  if (stage === "group" && weeks) {
    const week = weeks.find((w) => w.matchdays.includes(phase));
    // A matchday in no week is refused by validateSchedule; the round-by-round dates below are only a fallback.
    if (week) return { opensAt: week.opensAt, dueAt: week.dueAt };
  }

  let base = Date.parse(schedule.startsAt);
  let offset = 0;
  if (stage === "knockout" && ctx.qualifierStage && ctx.qualifierRounds > 0) {
    if (weeks && weeks.length > 0) base = Math.max(...weeks.map((w) => Date.parse(w.dueAt)));
    else for (let p = 1; p <= ctx.qualifierRounds; p++) offset += daysFor(schedule, ctx.qualifierStage, p);
    offset += schedule.stageGapDays;
  }
  for (let p = 1; p < phase; p++) offset += daysFor(schedule, stage, p);

  const opens = base + offset * DAY_MS;
  return {
    opensAt: new Date(opens).toISOString(),
    dueAt: new Date(opens + daysFor(schedule, stage, phase) * DAY_MS).toISOString(),
  };
}

/** Stamps every match with the window of its stage and phase. Returns new matches. */
export function applySchedule(matches: TMatch[], schedule: Schedule, ctx: ScheduleContext): TMatch[] {
  return matches.map((m) => ({ ...m, ...windowFor(schedule, ctx, m.stage, m.phase) }));
}

/**
 * Everything wrong with a schedule, in words an organizer can act on. Pass the event's shape so a group
 * stage laid out by week can be checked against the matchdays it actually has.
 */
export function validateSchedule(schedule: Schedule, ctx?: ScheduleContext): string[] {
  const errors: string[] = [];
  if (Number.isNaN(Date.parse(schedule.startsAt))) errors.push("Choose a start date.");
  if (!Number.isFinite(schedule.roundDays) || schedule.roundDays <= 0) errors.push("A round has to stay open for more than zero days.");
  if (!Number.isFinite(schedule.stageGapDays) || schedule.stageGapDays < 0) errors.push("The gap between stages can't be negative.");
  for (const [key, days] of Object.entries(schedule.overrides)) {
    if (!/^(swiss|group|knockout):\d+$/.test(key)) errors.push(`"${key}" is not a round.`);
    else if (!Number.isFinite(days) || days <= 0) errors.push(`${key} has to stay open for more than zero days.`);
  }

  const weeks = ctx ? groupWeeksOf(schedule, ctx) : null;
  if (ctx && weeks) {
    if (weeks.length === 0) errors.push("Add at least one week to the group stage.");
    const seen = new Map<number, number>();
    weeks.forEach((week, i) => {
      const opens = Date.parse(week.opensAt);
      const due = Date.parse(week.dueAt);
      if (Number.isNaN(opens) || Number.isNaN(due)) errors.push(`Week ${i + 1} needs an opening and a closing date.`);
      else if (due <= opens) errors.push(`Week ${i + 1} has to close after it opens.`);
      if (week.matchdays.length === 0) errors.push(`Week ${i + 1} has no matchdays in it.`);
      for (const p of week.matchdays) {
        if (!Number.isInteger(p) || p < 1 || p > ctx.qualifierRounds) errors.push(`Week ${i + 1} has matchday ${p}, but the groups only have ${ctx.qualifierRounds}.`);
        else if (seen.has(p)) errors.push(`Matchday ${p} is in both week ${seen.get(p)! + 1} and week ${i + 1}.`);
        else seen.set(p, i);
      }
    });
    const missing = Array.from({ length: ctx.qualifierRounds }, (_, i) => i + 1).filter((p) => !seen.has(p));
    if (weeks.length > 0 && missing.length > 0) {
      errors.push(`${missing.length === 1 ? "Matchday" : "Matchdays"} ${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in any week yet.`);
    }
  }
  return errors;
}

/** When the whole event is meant to be over: the last round's deadline. */
export function scheduleEnd(schedule: Schedule, ctx: ScheduleContext, knockoutPhases: number): string {
  if (knockoutPhases > 0) return windowFor(schedule, ctx, "knockout", knockoutPhases).dueAt;
  const weeks = groupWeeksOf(schedule, ctx);
  if (weeks && weeks.length > 0) return new Date(Math.max(...weeks.map((w) => Date.parse(w.dueAt)))).toISOString();
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
    const dummy = (size: number) => Array.from({ length: size }, (_, i) => String(i));
    const longest = Math.max(0, ...groupSizes(q, n).map((size) => roundRobin(dummy(size)).length));
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
