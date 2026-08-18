import { supabase } from "./supabase";

/**
 * Reading a finished match's fairness record back.
 *
 * Nothing here computes fairness, and that is the point. The cost model that prices squares stays on
 * the server - see the header of the balance-stats function for why a Vite chunk is not a safe place
 * for it - so every number below was worked out by the balancer at deal time, stored on the room, and
 * copied onto the match by archive_match. This module reads jsonb and does arithmetic on it.
 *
 * That is also why the percentile is cheap enough to put on a recap page. It is a rank against one
 * small column of already-computed numbers, not a re-scoring of the archive.
 */

/**
 * What the balancer knew about one board.
 *
 * Two sources write it and they mean slightly different things:
 *
 *   `deal`   the balancer of the day, measured on the board as it was actually played. Written by
 *            balance-board at the moment it finished dealing, so it is a record rather than a
 *            reconstruction.
 *   `sweep`  today's cost model re-applied to an old board by balance-stats, to backfill matches
 *            that finished before any of this existed. Honest, but a reconstruction - and it carries
 *            `rebalanced`, which has no meaning at deal time.
 *
 * Everything optional is optional because one source has it and the other does not. Nothing here is
 * ever assumed present.
 */
export interface MatchBalance {
  v: number;
  source: "deal" | "sweep";
  /** Seconds. The widest same-rank gap between two fleets in the raw seeded deal. */
  dealt: number;
  /** Seconds. The same gap on the board the match was actually played on. */
  played: number;
  /** Sweep only: what today's balancer would produce from that same deal. */
  rebalanced?: number;
  /** The threshold this board was held to, in seconds. */
  limit?: number;
  /** Layouts drawn. 1 means the first fleet-blind draw passed and nothing was steered. */
  attempts?: number;
  /** False only when no draw in the whole budget met the rules and this was the fairest of them. */
  accepted?: boolean;
  teams?: number;
  clumpBefore?: number;
  clumpAfter?: number;
  regionLow?: number | null;
  /** Per fleet, the slowest square gating its slowest ship. Seconds. See strandedFleets. */
  topCost?: number[];
  /** Sweep only: fleets already found to be stranded, against that match's real duration. */
  stranded?: number;
  hadPerm?: boolean;
  at?: string;
}

/** Whatever a row of match_reports carries, narrowed to a balance record or nothing. */
export function asMatchBalance(value: unknown): MatchBalance | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Partial<MatchBalance>;
  if (typeof b.dealt !== "number" || typeof b.played !== "number") return null;
  return b as MatchBalance;
}

/**
 * How many fleets were holding a ship that could not have been sunk in the time the match ran.
 *
 * The asymmetry that makes a match unwinnable rather than merely long: one fleet stranded and the
 * other not means one side was never going to finish the job, whatever they did. Worth more than the
 * gap on its own, because a wide gap between two fleets who both had time is only a wide gap.
 *
 * Computed here rather than stored, because it needs the match duration and the duration does not
 * exist yet when the board is dealt. A swept record already carries the answer and is trusted.
 */
export function strandedFleets(balance: MatchBalance, durationSeconds: number | null): number | null {
  if (typeof balance.stranded === "number") return balance.stranded;
  if (!balance.topCost?.length || durationSeconds === null || durationSeconds <= 0) return null;
  return balance.topCost.filter((c) => c > durationSeconds).length;
}

/**
 * Every fairness number on record, for ranking one match against the rest.
 *
 * One narrow read of a world-readable table. Matches with no record - anything from before the
 * balancer, and every board on a square set with no cost data - are simply absent, which is the
 * honest denominator: a percentile against matches nobody ever scored would be made up.
 */
export async function fetchFairnessGaps(): Promise<number[]> {
  const { data, error } = await supabase
    .from("match_reports")
    .select("balance")
    .not("balance", "is", null)
    .limit(1000);
  if (error || !data) return [];
  const out: number[] = [];
  for (const row of data as Array<{ balance: unknown }>) {
    const b = asMatchBalance(row.balance);
    if (b) out.push(b.played);
  }
  return out;
}

export interface Fairness {
  /** 0-100. The share of matches on record this one was FAIRER than. */
  percentile: number;
  /** How many matches that share was measured against, this one included. */
  sample: number;
}

/**
 * Where one board's gap ranks among every board on record. Lower gap is fairer, so a small gap is a
 * high percentile.
 *
 * Ties split down the middle - the standard percentile rank - so a board that matches the most
 * common gap exactly does not get credit for beating its own twins. With a handful of matches on
 * record this number moves around a lot, which is why the sample is returned with it and printed
 * beside it rather than left implied.
 */
export function fairnessOf(played: number, all: number[]): Fairness | null {
  if (all.length === 0) return null;
  const fairer = all.filter((g) => g > played).length;
  const same = all.filter((g) => g === played).length;
  return {
    percentile: Math.round(((fairer + same / 2) / all.length) * 100),
    sample: all.length,
  };
}

/** "88th", "3rd", "1st" - for a sentence rather than a table. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * What to call a gap in words, against the threshold the balancer holds boards to.
 *
 * The bands are the balancer's own limit and half of it, not round numbers picked to read well: the
 * limit is the line a board has to be under to be accepted at all, so "over the line" means exactly
 * that and not "worse than I would like".
 */
export function fairnessBand(played: number, limit: number | undefined): {
  label: string;
  color: string;
} {
  const line = limit && limit > 0 ? limit : 300;
  if (played <= line / 2) return { label: "Even", color: "var(--hit)" };
  if (played <= line) return { label: "Slight edge", color: "var(--accent)" };
  return { label: "Lopsided", color: "var(--sunk)" };
}

/**
 * Seconds out of an archived duration string.
 *
 * The archive writes `mm:ss` below an hour and `h:mm:ss` above it - see duration_text in the
 * duration_past_an_hour migration - and `--:--` for a match whose start marker never landed.
 */
export function durationSeconds(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const parts = duration.split(":");
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

/** "6:20" - the same clock every other duration on the site is written in. */
export function gapLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
