import { supabase } from "./supabase";

/**
 * Driving the balance-stats function, and adding up what it returns.
 *
 * Deliberately holding no cost data of its own. The whole reason the scoring lives in an edge
 * function is that bossTimeCost.json must not reach a browser: an Admin chunk is a static file on
 * Pages that anyone can fetch without signing in, so importing the table here would publish the
 * balancer's cost model to every player. See the header of the function itself.
 *
 * What arrives is one row per match - gaps in seconds - and the aggregation below is pure arithmetic
 * over those rows. It sits on this side because it needs no secret, and because the function is paged:
 * totalling on the server would mean either recomputing everything on every slice or keeping state
 * between invocations.
 */

/** One archived match, scored. Seconds throughout. */
export interface ScoredMatch {
  matchKey: string;
  boardSize: number;
  setId: string;
  teams: number;
  durationSec: number;
  /** Whether a permutation was archived, i.e. whether the balancer of the day actually ran. */
  hadPerm: boolean;
  dealt: number;
  played: number;
  rebalanced: number;
  /**
   * The same three boards on the find test: how far apart the fleets were on when their ships get
   * FOUND rather than on when they get cleared. Seconds. See FIND_GAP_SECONDS in boardBalance.ts.
   */
  findDealt: number;
  findPlayed: number;
  findRebalanced: number;
  strandedFleets: number;
}

/** Distribution of one measure across a set of matches. Seconds, except `overLimit`. */
export interface Summary {
  n: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
  /** Share of these boards a 5:00 rank gap would have rejected, 0-1. */
  overLimit: number;
}

export interface GapSet {
  matches: number;
  dealt: Summary | null;
  played: Summary | null;
  rebalanced: Summary | null;
}

export interface BalanceStats {
  generatedAt: string;
  rankLimitSeconds: number;
  /**
   * The find test's own threshold, which is NOT the rank limit and must not be printed as it.
   *
   * Ten minutes against the rank gap's five, because a hull's cheapest square spreads wider than its
   * slowest and the same seconds are a harsher test on that end - see FIND_GAP_SECONDS. Sent from
   * the function like the rank limit rather than hardcoded here, for the same reason: the browser
   * holds no part of the cost model.
   */
  findLimitSeconds: number;
  counts: {
    matchesInArchive: number;
    scored: number;
    /** Why the rest were skipped, keyed by reason. */
    rejected: Record<string, number>;
  };
  duration: Summary | null;
  overall: { dealt: Summary | null; played: Summary | null; rebalanced: Summary | null };
  /** The same three, on the find test. Summarised against findLimitSeconds, not the rank limit. */
  overallFind: { dealt: Summary | null; played: Summary | null; rebalanced: Summary | null };
  balancerOfTheDay: {
    balanced: { matches: number; played: Summary | null };
    unbalanced: { matches: number; played: Summary | null };
  };
  stranded: { none: number; oneSided: number; both: number };
  byBoardSize: Record<string, GapSet>;
  byTeamCount: Record<string, GapSet>;
  bySquareSet: Record<string, GapSet>;
  worstPlayed: ScoredMatch[];
}

/**
 * Matches asked for per request.
 *
 * Scoring one match is a full rejection-sampling run - the most expensive thing in the codebase, and
 * Supabase allows about two seconds of CPU per invocation. One now, down from three: the balancer's
 * draw budget tripled when the find test shipped, so a single hard board can spend about 1.5s of
 * that allowance by itself and asking for three is asking to be killed. The first version of this
 * asked for all seventy at once and was killed with a 546; three was killed rather less often, and
 * one is the honest number now. See MAX_SLICE in the function, which refuses more than two.
 */
const SLICE = 1;

/** A slice that still fails after backing off all the way to one match is a real failure. */
const MIN_SLICE = 1;

const CALL_TIMEOUT_MS = 60_000;

interface InvokeFailure {
  ok: false;
  reason: string;
  /** Set when the platform answered rather than our code - 546 is the CPU-budget kill. */
  status?: number;
}

async function invoke<T>(
  body: Record<string, unknown>
): Promise<{ ok: true; data: T } | InvokeFailure> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), CALL_TIMEOUT_MS)
    );
    const { data, error } = await Promise.race([
      supabase.functions.invoke("balance-stats", { body }),
      timeout,
    ]);
    // A non-2xx refusal arrives as an error rather than as data, so the reason has to be dug out of
    // the response before it is lost.
    //
    // The status is read as well as the body, and that matters more than it looks. Our own refusals
    // are JSON with an `error`; the ones that come from the PLATFORM are not JSON at all - a worker
    // killed for exceeding its CPU budget answers 546 with a plain-text body, and reporting only
    // `error.message` turns that into "returned a non-2xx status code", which says nothing and sends
    // you looking in the wrong place. `error.context` is the Response, so the status is right there.
    if (error) {
      const ctx = (error as { context?: Response }).context;
      const status = ctx?.status;
      const raw = ctx ? await ctx.clone().text().catch(() => "") : "";
      let reason = "";
      try {
        reason = (JSON.parse(raw) as { error?: string })?.error ?? "";
      } catch {
        reason = raw.slice(0, 200); // not JSON: a platform error, so show it verbatim
      }
      return {
        ok: false,
        status,
        reason: [status ? `HTTP ${status}` : null, reason || (error as Error).message]
          .filter(Boolean)
          .join(" - "),
      };
    }
    if (!data) return { ok: false, reason: "no data" };
    const asError = (data as { error?: string }).error;
    if (asError) return { ok: false, reason: asError };
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export interface SweepProgress {
  done: number;
  total: number;
  /** Set once a slice has been killed for CPU and the walk has narrowed its requests. */
  slice: number;
  /** Archived matches given a fairness record they did not have. See sweepBalanceStats. */
  persisted: number;
  /** Existing records that gained only a direction. See the merge pass in balance-stats. */
  directed: number;
}

/**
 * Walks the whole archive in slices and returns the totals.
 *
 * On a 546 the slice is halved and retried rather than abandoned, down to one match at a time. A
 * single match that cannot be scored inside the budget is reported as a rejection and the walk goes
 * on: one pathological board should not cost you the other seventy.
 */
export async function sweepBalanceStats(
  onProgress?: (p: SweepProgress) => void,
  persist = true
): Promise<
  | { ok: true; stats: BalanceStats; persisted: number; directed: number }
  | { ok: false; reason: string }
> {
  const index = await invoke<{
    matchKeys: string[];
    rankLimitSeconds: number;
    findLimitSeconds?: number;
  }>({ mode: "index" });
  if (!index.ok) return { ok: false, reason: index.reason };

  const keys = index.data.matchKeys;
  const rankLimitSeconds = index.data.rankLimitSeconds;
  // Falls back to the rank limit only so an older deployed function does not blank the column. The
  // two are different numbers and a reader who sees them equal should suspect a stale function.
  const findLimitSeconds = index.data.findLimitSeconds ?? rankLimitSeconds;
  const scored: ScoredMatch[] = [];
  const rejected: Record<string, number> = {};

  let slice = SLICE;
  let at = 0;
  let persisted = 0;
  let directed = 0;
  while (at < keys.length) {
    const take = keys.slice(at, at + slice);
    const res = await invoke<{
      scored: ScoredMatch[];
      rejected: Record<string, number>;
      persisted?: number;
      directed?: number;
    }>({ matchKeys: take, persist });

    if (!res.ok) {
      // 546 is the CPU kill. Narrowing is the only useful response; anything else is a real error.
      if (res.status === 546 && slice > MIN_SLICE) {
        slice = Math.max(MIN_SLICE, Math.floor(slice / 2));
        onProgress?.({ done: at, total: keys.length, slice, persisted, directed });
        continue;
      }
      if (res.status === 546) {
        // Already down to one and still over budget: record it and move past.
        rejected.too_expensive_to_score = (rejected.too_expensive_to_score ?? 0) + take.length;
        at += take.length;
        onProgress?.({ done: at, total: keys.length, slice, persisted, directed });
        continue;
      }
      return { ok: false, reason: res.reason };
    }

    scored.push(...res.data.scored);
    persisted += res.data.persisted ?? 0;
    directed += res.data.directed ?? 0;
    for (const [why, n] of Object.entries(res.data.rejected ?? {})) {
      rejected[why] = (rejected[why] ?? 0) + n;
    }
    at += take.length;
    onProgress?.({ done: at, total: keys.length, slice, persisted, directed });
  }

  return {
    ok: true,
    stats: aggregate(scored, rejected, keys.length, rankLimitSeconds, findLimitSeconds),
    persisted,
    directed,
  };
}

// -- aggregation -----------------------------------------------------------------------------------

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function describe(xs: number[], limit: number): Summary | null {
  if (xs.length === 0) return null;
  return {
    n: xs.length,
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    median: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    max: Math.max(...xs),
    overLimit: xs.filter((x) => x > limit).length / xs.length,
  };
}

function aggregate(
  scored: ScoredMatch[],
  rejected: Record<string, number>,
  matchesInArchive: number,
  limit: number,
  findLimit: number
): BalanceStats {
  const gaps = (pick: (m: ScoredMatch) => number, rows: ScoredMatch[] = scored) =>
    describe(rows.map(pick), limit);
  // Its own limit, not the rank one. `overLimit` means "share of boards this test would have
  // rejected", so summarising find gaps against a 5:00 line would report a rejection rate for a
  // rule that does not exist and make the find test look four times as interventionist as it is.
  const findGaps = (pick: (m: ScoredMatch) => number, rows: ScoredMatch[] = scored) =>
    describe(rows.map(pick), findLimit);

  const groupBy = (keyOf: (m: ScoredMatch) => string | number): Record<string, GapSet> => {
    const buckets = new Map<string, ScoredMatch[]>();
    for (const m of scored) {
      const k = String(keyOf(m));
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(m);
    }
    const out: Record<string, GapSet> = {};
    for (const [k, rows] of buckets) {
      out[k] = {
        matches: rows.length,
        dealt: gaps((m) => m.dealt, rows),
        played: gaps((m) => m.played, rows),
        rebalanced: gaps((m) => m.rebalanced, rows),
      };
    }
    return out;
  };

  const withPerm = scored.filter((m) => m.hadPerm);
  const withoutPerm = scored.filter((m) => !m.hadPerm);

  return {
    generatedAt: new Date().toISOString(),
    rankLimitSeconds: limit,
    findLimitSeconds: findLimit,
    counts: { matchesInArchive, scored: scored.length, rejected },
    duration: describe(
      scored.map((m) => m.durationSec),
      limit
    ),
    overall: {
      dealt: gaps((m) => m.dealt),
      played: gaps((m) => m.played),
      rebalanced: gaps((m) => m.rebalanced),
    },
    overallFind: {
      dealt: findGaps((m) => m.findDealt),
      played: findGaps((m) => m.findPlayed),
      rebalanced: findGaps((m) => m.findRebalanced),
    },
    balancerOfTheDay: {
      balanced: { matches: withPerm.length, played: gaps((m) => m.played, withPerm) },
      unbalanced: { matches: withoutPerm.length, played: gaps((m) => m.played, withoutPerm) },
    },
    stranded: {
      none: scored.filter((m) => m.strandedFleets === 0).length,
      oneSided: scored.filter((m) => m.strandedFleets === 1).length,
      both: scored.filter((m) => m.strandedFleets > 1).length,
    },
    byBoardSize: groupBy((m) => m.boardSize),
    byTeamCount: groupBy((m) => m.teams),
    bySquareSet: groupBy((m) => m.setId),
    worstPlayed: [...scored].sort((a, b) => b.played - a.played).slice(0, 15),
  };
}

/** Seconds as m:ss, the way every other duration in the app is written. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
