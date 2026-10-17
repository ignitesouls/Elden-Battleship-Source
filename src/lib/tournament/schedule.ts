import { buildKnockout } from "./bracket";
import { effectiveCut, groupSizes } from "./format";
import type { TournamentFormat } from "./format";
import { groupLetter } from "./groupNames";
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
   * index in groupWeeks - or, in "flex" mode, to "flex". Everything else is dealt around them. Keyed by
   * who plays rather than by match key so a move follows the matchup if the seeding changes; a move to a
   * week that no longer exists, a pairing no longer drawn, or "flex" outside flex mode is ignored.
   */
  weekMoves?: Record<string, number | "flex">;
  /**
   * How group matches are dealt into the weeks. "standard" (the default, and what a schedule saved
   * without this field means): every match goes in a week, and the extra games are shared out as double
   * weeks - assignGroupWeeks. "flex": every week is a clean round where nobody plays twice, and the
   * matches that don't fit are flex matches, playable any week of the group stage - assignFlexWeeks.
   */
  groupWeekMode?: "standard" | "flex";
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

/** Which way group matches are dealt into weeks; a schedule saved before there was a choice is standard. */
export function groupWeekModeOf(schedule: Pick<Schedule, "groupWeekMode">): "standard" | "flex" {
  return schedule.groupWeekMode === "flex" ? "flex" : "standard";
}

/** Each group's played matches (both sides known), by group number, each list in round order. */
function groupLists(matches: TMatch[]): Array<[number, TMatch[]]> {
  const groups = new Map<number, TMatch[]>();
  for (const m of matches) {
    if (m.stage !== "group" || !m.a || !m.b) continue;
    const g = m.group ?? 0;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }
  const out = [...groups.entries()].sort((x, y) => x[0] - y[0]);
  for (const [, list] of out) list.sort((x, y) => x.round - y.round || x.index - y.index);
  return out;
}

/** The weekMoves key of each match in one group's list (see pairingKey), counting repeat meetings. */
function pairingsOf(g: number, list: TMatch[]): string[] {
  const meetings = new Map<string, number>();
  return list.map((m) => {
    const base = pairingKey(g, m.a!, m.b!, 0).replace(/#0$/, "");
    const n = (meetings.get(base) ?? 0) + 1;
    meetings.set(base, n);
    return `${base}#${n}`;
  });
}

/** A pin to a week that exists, or null - for anything else, "flex" included. */
function weekPin(move: number | "flex" | undefined, W: number): number | null {
  return typeof move === "number" && Number.isInteger(move) && move >= 0 && move < W ? move : null;
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
export function assignGroupWeeks(matches: TMatch[], weekCount: number, moves: Record<string, number | "flex"> = {}): WeekSlot[] {
  const W = Math.max(1, Math.floor(weekCount));
  const out: WeekSlot[] = [];

  for (const [g, list] of groupLists(matches)) {
    const M = list.length;
    const pairings = pairingsOf(g, list);
    const pinned = pairings.map((p) => weekPin(moves[p], W));

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

/** One group match's place in a fixed-plus-flex layout. */
export interface FlexSlot {
  match: TMatch;
  /** The week it is fixed in, or null for a flex match - playable in any week of the group stage. */
  week: number | null;
  pairing: string;
  /** Put in its week, or made flex, by hand (weekMoves) rather than dealt. */
  moved: boolean;
  /**
   * Pinned by hand into a week where one of its teams is pinned to play another match too. The layout
   * can't be clean while it stands, so the event can't start (flexWeekProblems) until a pin moves.
   */
  conflict: boolean;
  /** For a flex match: the weeks where one of its teams has no fixed match, which is where it fits best. */
  byeWeeks: number[];
}

/** How many tries the flex search makes per group before keeping the best layout it has found. */
const FLEX_SEARCH_BUDGET = 200_000;

/**
 * Deals each group's matches into `weekCount` clean weeks plus flex. Each group is dealt on its own:
 *
 *   - No team plays twice in a week, so a week holds at most floor(n / 2) matches.
 *   - As many matches as possible are fixed in a week; the rest are flex, playable in any week. Four
 *     weeks fix 12 of a group of six's 15 matches (three a week, nobody idle) and 8 of a group of five's
 *     10 (two a week, one team off each week).
 *   - Among layouts with that few flex matches: no team has more than one flex match where that can be
 *     avoided, then flex matches go to teams that have a week off to play them in, then earlier
 *     matchdays stay in earlier weeks.
 *
 * Pins (weekMoves, by pairing) are honoured exactly: a match pinned to a week stays there, one pinned to
 * "flex" stays flex, and everything else is dealt around them. Two pins that put a team in one week twice
 * can't both be honoured cleanly; both stay where they were pinned, marked `conflict`, and the rest is
 * still dealt. A small exhaustive search - groups are a handful of teams - started from the circle
 * method's own rounds, with weeks no pin tells apart tried only once, and capped at FLEX_SEARCH_BUDGET
 * steps in case of a very large group. Deterministic: the preview is the schedule that gets started.
 */
export function assignFlexWeeks(matches: TMatch[], weekCount: number, moves: Record<string, number | "flex"> = {}): FlexSlot[] {
  const W = Math.max(1, Math.floor(weekCount));
  const out: FlexSlot[] = [];

  for (const [g, list] of groupLists(matches)) {
    const pairings = pairingsOf(g, list);
    const pin = pairings.map((p): number | "flex" | null => (moves[p] === "flex" ? "flex" : weekPin(moves[p], W)));
    const teams = [...new Set(list.flatMap((m) => [m.a!, m.b!]))];
    const tix = new Map(teams.map((t, i) => [t, i]));
    const ta = list.map((m) => tix.get(m.a!)!);
    const tb = list.map((m) => tix.get(m.b!)!);

    // Who is already busy in each week from the pins, and which pinned matches clash.
    const busy = Array.from({ length: W }, () => new Array<number>(teams.length).fill(0));
    pin.forEach((p, i) => {
      if (typeof p === "number") {
        busy[p][ta[i]]++;
        busy[p][tb[i]]++;
      }
    });
    const conflict = pin.map((p, i) => typeof p === "number" && (busy[p][ta[i]] > 1 || busy[p][tb[i]] > 1));
    // A week no pin touches is like any other untouched week, so the search only ever opens the first
    // empty one of those - the rest are the same layout with the weeks relabelled.
    const pinnedWeek = Array.from({ length: W }, (_, w) => pin.some((p) => p === w));

    const free = list.map((_, i) => i).filter((i) => pin[i] === null);
    const ideal = (i: number) => Math.min(W - 1, list[i].round - 1);
    const week = pin.map((p) => (typeof p === "number" ? p : null));
    const used = Array.from({ length: W }, (_, w) => pin.some((p) => p === w));
    let flexCount = pin.filter((p) => p === "flex").length;

    // Layouts are compared on [flex matches, extra flex matches per team, flex matches with no team
    // that has a week off, distance of matchdays from their natural week]; smaller is better.
    let best: { score: number[]; week: Array<number | null> } | null = null;
    const better = (a: number[], b: number[]) => {
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k];
      return false;
    };
    const score = (layout: Array<number | null>): number[] => {
      const fixedCount = new Array<number>(teams.length).fill(0);
      const flexOf = new Array<number>(teams.length).fill(0);
      layout.forEach((w, i) => {
        const bump = w === null ? flexOf : fixedCount;
        bump[ta[i]]++;
        bump[tb[i]]++;
      });
      const flex = layout.filter((w) => w === null).length;
      const extra = flexOf.reduce((s, c) => s + Math.max(0, c - 1), 0);
      const noBye = layout.filter((w, i) => w === null && fixedCount[ta[i]] >= W && fixedCount[tb[i]] >= W).length;
      const order = layout.reduce((s: number, w, i) => s + (w === null ? 0 : Math.abs(w - ideal(i))), 0);
      return [flex, extra, noBye, order];
    };
    /** Relabels the weeks no pin touches so earlier matchdays sit in earlier weeks - same layout otherwise. */
    const tidy = (layout: Array<number | null>): Array<number | null> => {
      const open = Array.from({ length: W }, (_, w) => w).filter((w) => !pinnedWeek[w]);
      const avg = (w: number) => {
        const rs = layout.flatMap((x, i) => (x === w ? [list[i].round] : []));
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Number.POSITIVE_INFINITY;
      };
      const sorted = [...open].sort((x, y) => avg(x) - avg(y) || x - y);
      const relabel = new Map(sorted.map((w, k) => [w, open[k]]));
      return layout.map((w) => (w === null ? null : (relabel.get(w) ?? w)));
    };

    let steps = 0;
    const place = (k: number) => {
      if (++steps > FLEX_SEARCH_BUDGET) return;
      // Every match left could at best be fixed; if that still loses on flex count, stop here.
      if (best && flexCount > best.score[0]) return;
      if (k === free.length) {
        const layout = tidy(week);
        const s = score(layout);
        if (!best || better(s, best.score)) best = { score: s, week: layout };
        return;
      }
      const i = free[k];
      const candidates = Array.from({ length: W }, (_, w) => w).sort((x, y) => Math.abs(x - ideal(i)) - Math.abs(y - ideal(i)) || x - y);
      let openedEmpty = false;
      for (const w of candidates) {
        if (busy[w][ta[i]] || busy[w][tb[i]]) continue;
        if (!used[w] && !pinnedWeek[w]) {
          if (openedEmpty) continue;
          openedEmpty = true;
        }
        const wasUsed = used[w];
        busy[w][ta[i]]++;
        busy[w][tb[i]]++;
        used[w] = true;
        week[i] = w;
        place(k + 1);
        week[i] = null;
        used[w] = wasUsed;
        busy[w][ta[i]]--;
        busy[w][tb[i]]--;
      }
      flexCount++;
      place(k + 1);
      flexCount--;
    };
    place(0);

    const final: Array<number | null> = best ? (best as { week: Array<number | null> }).week : week;
    const fixedIn = Array.from({ length: W }, () => new Set<number>());
    final.forEach((w, i) => {
      if (w !== null) {
        fixedIn[w].add(ta[i]);
        fixedIn[w].add(tb[i]);
      }
    });
    list.forEach((m, i) =>
      out.push({
        match: m,
        week: final[i],
        pairing: pairings[i],
        moved: pin[i] !== null,
        conflict: conflict[i],
        byeWeeks: final[i] === null ? fixedIn.flatMap((s, w) => (!s.has(ta[i]) || !s.has(tb[i]) ? [w] : [])) : [],
      }),
    );
  }
  return out;
}

/**
 * What stops a fixed-plus-flex group stage from starting: pins that put a team in one week twice. One
 * line per clash, for the start page's problem list; the preview marks the matches themselves.
 */
export function flexWeekProblems(matches: TMatch[], schedule: Schedule, ctx: ScheduleContext): string[] {
  const weeks = groupWeeksOf(schedule, ctx);
  if (!weeks || weeks.length === 0 || groupWeekModeOf(schedule) !== "flex") return [];
  const clashes = new Set<string>();
  for (const s of assignFlexWeeks(matches, weeks.length, schedule.weekMoves)) {
    if (s.conflict && s.week !== null) clashes.add(`Group ${groupLetter(s.match.group ?? 0)}, week ${s.week + 1}: a team is pinned to two matches - move one of them.`);
  }
  return [...clashes];
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
  const flex = groupWeekModeOf(schedule) === "flex";
  const dealt =
    weeks && weeks.length > 0
      ? new Map<string, number | null>(
          (flex ? assignFlexWeeks(matches, weeks.length, schedule.weekMoves) : assignGroupWeeks(matches, weeks.length, schedule.weekMoves)).map((s) => [s.match.key, s.week]),
        )
      : null;
  // A flex match is open for the whole group stage: from the first week opening to the last one closing.
  const whole = weeks && weeks.length > 0 ? groupStageWindow(weeks) : null;
  return matches.map((m) => {
    const wk = dealt?.get(m.key);
    if (weeks && wk !== undefined) return wk === null ? { ...m, ...whole! } : { ...m, opensAt: weeks[wk].opensAt, dueAt: weeks[wk].dueAt };
    return { ...m, ...windowFor(schedule, ctx, m.stage, m.phase) };
  });
}

/** The whole group stage laid out by week: the earliest week's opening to the latest week's deadline. */
export function groupStageWindow(weeks: ScheduleWeek[]): { opensAt: string; dueAt: string } {
  return {
    opensAt: new Date(Math.min(...weeks.map((w) => Date.parse(w.opensAt)))).toISOString(),
    dueAt: new Date(Math.max(...weeks.map((w) => Date.parse(w.dueAt)))).toISOString(),
  };
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
