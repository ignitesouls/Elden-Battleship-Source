import { buildKnockout } from "./bracket";
import { validateFormat, type TournamentFormat } from "./format";
import { assignGroups, buildGroupStage } from "./groups";
import { applySchedule, scheduleShape, validateSchedule, type Schedule } from "./schedule";
import { pairSwissRound } from "./swiss";
import type { MatchStage, Pointer, TMatch } from "./types";

/**
 * What starting an event will do, worked out before anything is written.
 *
 * Starting draws the FIRST stage only - which stage depends on the format:
 *   no qualifier   the whole knockout, every round, since its shape is fixed by the entrants
 *   Swiss          round 1. Each later round is drawn once the one before it is played, because who plays
 *                  whom depends on the results
 *   groups         every group match, the whole round-robin, which is fixed by who is in which group
 * A qualifier followed by a knockout builds the knockout later, from the qualifier's standings.
 *
 * `seeded` is the entrants best seed first, as ids. The seed order is the administrator's decision
 * and is the only input that changes who meets whom.
 *
 * This is a plan, not an action: it is what the start page shows the administrator to confirm, and what
 * is then handed to the database in one call. Nothing here touches a database.
 */
export interface StartPlan {
  /** Which stage the matches belong to. */
  stage: Extract<MatchStage, "swiss" | "group" | "knockout">;
  matches: TMatch[];
}

export type PlanResult = { ok: true; plan: StartPlan } | { ok: false; problems: string[] };

export function planStart(format: TournamentFormat, seeded: string[], schedule: Schedule): PlanResult {
  const problems = [...validateFormat(format, seeded.length), ...validateSchedule(schedule)];
  if (new Set(seeded).size !== seeded.length) problems.push("A team is listed twice.");
  if (problems.length > 0) return { ok: false, problems };

  const q = format.qualifier;
  const { ctx } = scheduleShape(format, seeded.length);

  let stage: StartPlan["stage"];
  let drawn: TMatch[];
  if (q.format === "swiss") {
    stage = "swiss";
    drawn = pairSwissRound(seeded, [], 1, q.bestOf);
  } else if (q.format === "groups") {
    stage = "group";
    drawn = buildGroupStage(assignGroups(seeded, q.groupCount), q.legs, q.bestOf);
  } else {
    stage = "knockout";
    drawn = buildKnockout(seeded, format.knockout!);
  }

  return { ok: true, plan: { stage, matches: applySchedule(drawn, schedule, ctx) } };
}

/**
 * A stored match row, read back as the engine's own match. The inverse of toMatchRows.
 *
 * The planners for later stages work from the matches already played, so the desk has to feed them what
 * the database holds. Timestamps and ids pass through untouched; the only translation is the column
 * names (`grp`, `idx`, `entrant_a` ...) and the two pointers, which are stored as a key and a side.
 */
export function matchFromRow(r: Record<string, unknown>): TMatch {
  const pointer = (key: unknown, side: unknown): Pointer | null =>
    typeof key === "string" && (side === "a" || side === "b") ? { key, side } : null;
  return {
    key: r.key as string,
    stage: r.stage as TMatch["stage"],
    bracket: (r.bracket as TMatch["bracket"]) ?? null,
    group: (r.grp as number | null) ?? null,
    round: r.round as number,
    index: r.idx as number,
    a: (r.entrant_a as string | null) ?? null,
    b: (r.entrant_b as string | null) ?? null,
    bestOf: r.best_of as number,
    scoreA: r.score_a as number,
    scoreB: r.score_b as number,
    status: r.status as TMatch["status"],
    winner: (r.winner as string | null) ?? null,
    winnerTo: pointer(r.winner_to_key, r.winner_to_side),
    loserTo: pointer(r.loser_to_key, r.loser_to_side),
    resetOf: (r.reset_of as string | null) ?? null,
    isBye: Boolean(r.is_bye),
    phase: (r.phase as number | null) ?? (r.round as number),
    opensAt: (r.opens_at as string | null) ?? null,
    dueAt: (r.due_at as string | null) ?? null,
    resultKind: ((r.result_kind as TMatch["resultKind"] | undefined) ?? "played"),
  };
}

/** A match as the start_tournament function wants it: the database's column names. */
export function toMatchRows(matches: TMatch[]): Array<Record<string, unknown>> {
  return matches.map((m) => ({
    key: m.key,
    stage: m.stage,
    bracket: m.bracket,
    grp: m.group,
    round: m.round,
    idx: m.index,
    phase: m.phase,
    entrant_a: m.a,
    entrant_b: m.b,
    best_of: m.bestOf,
    score_a: m.scoreA,
    score_b: m.scoreB,
    status: m.status,
    winner: m.winner,
    winner_to_key: m.winnerTo?.key ?? null,
    winner_to_side: m.winnerTo?.side ?? null,
    loser_to_key: m.loserTo?.key ?? null,
    loser_to_side: m.loserTo?.side ?? null,
    reset_of: m.resetOf,
    is_bye: m.isBye,
    opens_at: m.opensAt,
    due_at: m.dueAt,
    result_kind: m.resultKind,
  }));
}
