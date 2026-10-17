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
   * A group stage played in weeks rather than one matchday after another. Each week has its own dates,
   * and every group match is dealt into a week by assignGroupWeeks - match by match, not matchday by
   * matchday, so a group of six can play its five matchdays in four weeks with each team playing twice
   * in just one of them. Present (even empty) means the organizer is laying the group stage out by week;
   * absent means the round by round layout above. Only a group stage uses it - Swiss rounds are drawn
   * one at a time from results, so two of them can't share a window.
   */
  groupWeeks?: ScheduleWeek[];
  /**
   * Group matches the organizer put in a week by hand, keyed by pairing (see pairingKey), to a week's
   * index in groupWeeks. Everything else is dealt around them. Keyed by who plays rather than by match
   * key so a move follows the matchup if the seeding changes; a move to a week that no longer exists, or
   * a pairing no longer drawn, is ignored.
   */
  weekMoves?: Record<string, number>;
  /**
   * The playoffs planned on their own, after a qualifier: a fixed date for the knockout's first round
   * (absent: it follows the qualifier's last deadline plus stageGapDays) and its own days per round
   * (absent: roundDays). A per-round override still wins over either.
   */
  knockoutStartsAt?: string;
  knockoutRoundDays?: number;
}

/** One window of a group stage played in weeks. */
export interface ScheduleWeek {
  opensAt: string;
  dueAt: string;
}

/** What the schedule needs to know about the event to lay knockout rounds after the qualifier. */
export interface ScheduleContext {
  qualifierStage: Extract<MatchStage, "swiss" | "group"> | null;
  /** How many rounds the qualifier has in total - all of them, not just those drawn so far. */
  qualifierRounds: number;
}

const DAY_MS = 86_400_000;

export function daysFor(schedule: Schedule, stage: MatchStage, phase: number): number {
  return schedule.overrides[`${stage}:${phase}`] ?? (stage === "knockout" ? (schedule.knockoutRoundDays ?? schedule.roundDays) : schedule.roundDays);
}

/** When the qualifier's last match is due - what the playoffs follow unless they have their own date. */
export function qualifierEnd(schedule: Schedule, ctx: ScheduleContext): string | null {
  if (!ctx.qualifierStage || ctx.qualifierRounds <= 0) return null;
  const weeks = groupWeeksOf(schedule, ctx);
  if (weeks && weeks.length > 0) return new Date(Math.max(...weeks.map((w) => Date.parse(w.dueAt)))).toISOString();
  return windowFor(schedule, ctx, ctx.qualifierStage, ctx.qualifierRounds).dueAt;
}

/** The group stage's weeks, when this event's group stage is laid out by week; null otherwise. */
export function groupWeeksOf(schedule: Schedule, ctx: ScheduleContext): ScheduleWeek[] | null {
  return ctx.qualifierStage === "group" && Array.isArray(schedule.groupWeeks) ? schedule.groupWeeks : null;
}

/** `weeks` back-to-back seven-day weeks from `startsAt`. */
export function spreadGroupWeeks(startsAt: string, weeks: number): ScheduleWeek[] {
  const count = Math.max(1, Math.floor(weeks) || 1);
  const start = Date.parse(startsAt);
  return Array.from({ length: count }, (_, i) => ({
    opensAt: new Date(start + 7 * i * DAY_MS).toISOString(),
    dueAt: new Date(start + 7 * (i + 1) * DAY_MS).toISOString(),
  }));
}

/**
 * Who plays whom, as a weekMoves key: the group, the two teams in a fixed order, and which meeting of
 * theirs it is (#2 is the return leg of a two-legged group).
 */
export function pairingKey(group: number, a: string, b: string, meeting: number): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${group}:${lo}~${hi}#${meeting}`;
}

/** One group match's place in a week layout. */
export interface WeekSlot {
  match: TMatch;
  week: number;
  pairing: string;
  /** Put in its week by hand (weekMoves) rather than dealt. */
  moved: boolean;
}

/**
 * Deals each group's matches into `weekCount` weeks. Each group is dealt on its own:
 *
 *   - Weeks take an even share of the group's matches, earlier weeks taking the extra (fifteen over
 *     four is 4, 4, 4, 3).
 *   - Nobody plays more in a week than they have to: at most ceil(games / weeks) - so twice, for five
 *     games in four weeks - while that is possible at all.
 *   - The extra games are shared out: each team plays twice in as few weeks as it can and about as
 *     often as everyone else in its group, and no single week takes all of the doubles. A group of six
 *     over four weeks comes out with every team playing twice in exactly one week.
 *   - Earlier matchdays stay earlier where the above allows it.
 *
 * Moves (by pairing) are honoured exactly and the rest is dealt around them. It is a deterministic
 * local search - the same matches, weeks and moves always give the same layout, so the preview the
 * organizer approves is the schedule that gets started.
 */
export function assignGroupWeeks(matches: TMatch[], weekCount: number, moves: Record<string, number> = {}): WeekSlot[] {
  const W = Math.max(1, Math.floor(weekCount));
  const out: WeekSlot[] = [];
  const groups = new Map<number, TMatch[]>();
  for (const m of matches) {
    if (m.stage !== "group" || !m.a || !m.b) continue;
    const g = m.group ?? 0;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }

  for (const [g, list] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
    list.sort((x, y) => x.round - y.round || x.index - y.index);
    const M = list.length;
    const meetings = new Map<string, number>();
    const pairings = list.map((m) => {
      const base = pairingKey(g, m.a!, m.b!, 0).replace(/#0$/, "");
      const n = (meetings.get(base) ?? 0) + 1;
      meetings.set(base, n);
      return `${base}#${n}`;
    });
    const pinned = pairings.map((p) => {
      const w = moves[p];
      return Number.isInteger(w) && w >= 0 && w < W ? w : null;
    });

    const teams = [...new Set(list.flatMap((m) => [m.a!, m.b!]))];
    const tix = new Map(teams.map((t, i) => [t, i]));
    const games = teams.map((t) => list.filter((m) => m.a === t || m.b === t).length);
    const cap = Math.max(1, Math.ceil(Math.max(...games) / W));
    const rounds = Math.max(...list.map((m) => m.round));
    const ideal = list.map((m) => ((m.round - 1) * W) / rounds);

    // How many matches each week should take, then the free places once the moved matches are in.
    const size = Array.from({ length: W }, (_, w) => Math.floor(M / W) + (w < M % W ? 1 : 0));
    const free = size.map((s, w) => Math.max(0, s - pinned.filter((p) => p === w).length));
    let short = pinned.filter((p) => p === null).length - free.reduce((a, b) => a + b, 0);
    for (let w = W - 1; short > 0; w = (w + W - 1) % W, short--) free[w]++;

    // Start from the natural order: unmoved matches fill the weeks front to back.
    const week = pinned.map((p) => p ?? -1);
    let w = 0;
    for (let i = 0; i < M; i++) {
      if (week[i] !== -1) continue;
      while (free[w] === 0) w++;
      week[i] = w;
      free[w]--;
    }

    const cost = () => {
      const count = teams.map(() => new Array<number>(W).fill(0));
      week.forEach((wk, i) => {
        count[tix.get(list[i].a!)!][wk]++;
        count[tix.get(list[i].b!)!][wk]++;
      });
      let over = 0;
      let teamSpread = 0;
      const weekDoubles = new Array<number>(W).fill(0);
      for (const row of count) {
        let doubles = 0;
        row.forEach((c, wk) => {
          over += Math.max(0, c - cap);
          doubles += Math.max(0, c - 1);
          weekDoubles[wk] += Math.max(0, c - 1);
        });
        teamSpread += doubles * doubles;
      }
      const weekSpread = weekDoubles.reduce((s, d) => s + d * d, 0);
      const order = week.reduce((s, wk, i) => s + Math.abs(wk - ideal[i]), 0);
      return over * 1e6 + teamSpread * 1e3 + weekSpread * 10 + order;
    };

    // Swap pairs of unmoved matches between weeks (which keeps every week's size) while any swap helps.
    let best = cost();
    for (let pass = 0, improved = true; improved && pass < 200; pass++) {
      improved = false;
      for (let i = 0; i < M; i++) {
        if (pinned[i] !== null) continue;
        for (let j = i + 1; j < M; j++) {
          if (pinned[j] !== null || week[i] === week[j]) continue;
          [week[i], week[j]] = [week[j], week[i]];
          const c = cost();
          if (c < best) {
            best = c;
            improved = true;
          } else {
            [week[i], week[j]] = [week[j], week[i]];
          }
        }
      }
    }

    list.forEach((m, i) => out.push({ match: m, week: week[i], pairing: pairings[i], moved: pinned[i] !== null }));
  }
  return out;
}

/**
 * The window for one round. Rounds are laid end to end from the start date, so a change to one
 * round's length moves every later round with it - which is what an organizer means by "give round 2
 * another week". A group stage laid out by week takes its dates match by match (applySchedule). After a
 * qualifier the knockout opens on its own date if it has one, else after the qualifier's last deadline
 * (the last week's, for a group stage in weeks) plus the break.
 */
export function windowFor(
  schedule: Schedule,
  ctx: ScheduleContext,
  stage: MatchStage,
  phase: number,
): { opensAt: string; dueAt: string } {
  const weeks = groupWeeksOf(schedule, ctx);
  let base = Date.parse(schedule.startsAt);
  let offset = 0;
  if (stage === "knockout" && ctx.qualifierStage && ctx.qualifierRounds > 0) {
    const own = schedule.knockoutStartsAt ? Date.parse(schedule.knockoutStartsAt) : Number.NaN;
    if (!Number.isNaN(own)) base = own;
    else {
      if (weeks && weeks.length > 0) base = Math.max(...weeks.map((w) => Date.parse(w.dueAt)));
      else for (let p = 1; p <= ctx.qualifierRounds; p++) offset += daysFor(schedule, ctx.qualifierStage, p);
      offset += schedule.stageGapDays;
    }
  }
  for (let p = 1; p < phase; p++) offset += daysFor(schedule, stage, p);

  const opens = base + offset * DAY_MS;
  return {
    opensAt: new Date(opens).toISOString(),
    dueAt: new Date(opens + daysFor(schedule, stage, phase) * DAY_MS).toISOString(),
  };
}

/**
 * Stamps every match with its window: its stage and phase's, or for a group stage laid out by week, the
 * week assignGroupWeeks deals it into. Returns new matches.
 */
export function applySchedule(matches: TMatch[], schedule: Schedule, ctx: ScheduleContext): TMatch[] {
  const weeks = groupWeeksOf(schedule, ctx);
  const dealt = weeks && weeks.length > 0 ? new Map(assignGroupWeeks(matches, weeks.length, schedule.weekMoves).map((s) => [s.match.key, s.week])) : null;
  return matches.map((m) => {
    const wk = dealt?.get(m.key);
    if (weeks && wk !== undefined) return { ...m, opensAt: weeks[wk].opensAt, dueAt: weeks[wk].dueAt };
    return { ...m, ...windowFor(schedule, ctx, m.stage, m.phase) };
  });
}

/**
 * Everything wrong with a schedule, in words an organizer can act on. Pass the event's shape so a group
 * stage laid out by week is checked too.
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
    weeks.forEach((week, i) => {
      const opens = Date.parse(week.opensAt);
      const due = Date.parse(week.dueAt);
      if (Number.isNaN(opens) || Number.isNaN(due)) errors.push(`Week ${i + 1} needs an opening and a closing date.`);
      else if (due <= opens) errors.push(`Week ${i + 1} has to close after it opens.`);
    });
  }

  if (schedule.knockoutRoundDays !== undefined && (!Number.isFinite(schedule.knockoutRoundDays) || schedule.knockoutRoundDays <= 0)) {
    errors.push("A playoff round has to stay open for more than zero days.");
  }
  if (schedule.knockoutStartsAt !== undefined) {
    const own = Date.parse(schedule.knockoutStartsAt);
    const end = ctx ? qualifierEnd(schedule, ctx) : null;
    if (Number.isNaN(own)) errors.push("Choose a start date for the playoffs.");
    else if (end && errors.length === 0 && own < Date.parse(end)) errors.push("The playoffs can't start before the qualifier's last deadline.");
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
