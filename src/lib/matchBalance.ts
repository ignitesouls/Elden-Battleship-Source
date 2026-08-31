import { supabase } from "./supabase";

/**
 * Reading a finished match's fairness record back.
 *
 * Nothing here computes fairness, on purpose. The cost model that prices squares stays on
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
 *
 * -- Written but not rendered ----------------------------------------------------------------------
 *
 * `played` is the only field any player-facing surface reads: BalanceReadout ranks it into a
 * percentile and shows nothing else. Everything below it - `limit`, both gap directions, the
 * long-square counts, the find gap - is written, archived, and read only by the admin sweep or by a
 * person looking at the raw record.
 *
 * That is deliberate and they are NOT dead weight to be trimmed. A stored field costs a line in the
 * writer; deleting one loses the data permanently for every match played afterwards, and it cannot
 * be reconstructed for a board whose cost table has since moved. `limit` is the sharpest case - it
 * is the only thing that says which rule a given record's gap was judged against, so without it an
 * old `played` cannot be read at all once a threshold changes.
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
  /**
   * Which team the gap was in favour of, and which paid for it.
   *
   * The gap itself is a magnitude - it says how wide the edge was and nothing about whose it was -
   * so for as long as this record existed there was no side to name. These are that side: the team
   * holding the cheapest ship at the rank the gap was worst at, and the team holding the dearest.
   *
   * Absent on every record written before the balancer started keeping it, and null on a board with
   * no gap at all. Those two are different: absent means unmeasured, null means measured and even.
   */
  aheadTeam?: number | null;
  behindTeam?: number | null;
  /**
   * Where the direction came from, when it did not come from the same run as the gap.
   *
   * 'sweep' means the sweep worked it out later from the archived placements and today's cost
   * model, and wrote it beside a gap some earlier balancer measured. Ordinarily the two agree,
   * because it is the same board and the same rule; they can disagree if the cost table moved
   * underneath. Absent means the direction was recorded by whatever produced the gap.
   */
  aheadFrom?: "sweep";
  /**
   * The same board on the second fairness test, in WHOLE SQUARES rather than seconds.
   *
   * How many more squares past the long-square line the worst-off fleet held - the measure the rank
   * gap above cannot see, because pricing a ship at its slowest square discards every other cell on
   * it. See LONG_GAP in boardBalance.ts.
   *
   * Optional like everything else here, and for a sharper reason than usual: every match dealt
   * before the second test shipped has a record without these, and a swept record only has them
   * once balance-stats has been re-run. Absent means unmeasured, never zero.
   */
  longDealt?: number;
  longPlayed?: number;
  /** Sweep only, and the counterpart to `rebalanced`. */
  longRebalanced?: number;
  /** The long-square threshold this board was held to, in squares. */
  longLimit?: number;
  /**
   * The same board on the third fairness test, in seconds: how far apart the fleets were on when
   * their ships get FOUND rather than on when they get cleared.
   *
   * A ship is found through its CHEAPEST square and cleared at its dearest, and over the archive
   * those two ends of a hull correlate at r = 0.192 - so this is not a restatement of `played` and
   * regularly disagrees with it about whether a board was even. See FIND_GAP_SECONDS in
   * boardBalance.ts.
   *
   * Optional for the usual reason and one more: every match dealt before the third test shipped has
   * a record without these, and a swept record only gains them once balance-stats has been re-run.
   * Absent means unmeasured, never zero.
   */
  findDealt?: number;
  findPlayed?: number;
  /** Sweep only, and the counterpart to `rebalanced`. */
  findRebalanced?: number;
  /** The find-gap threshold this board was held to, in seconds. */
  findLimit?: number;
  /**
   * Which fleet stayed hidden longest at the worst find rank, and which was found soonest.
   *
   * Not the same pair as aheadTeam/behindTeam, and deliberately stored apart from them: those name
   * the sides of the gap on when ships DIE, and a board very often hands one edge to one team and
   * the other edge to the other.
   */
  findAheadTeam?: number | null;
  findBehindTeam?: number | null;
  /** Layouts drawn. 1 means the first fleet-blind draw passed and nothing was steered. */
  attempts?: number;
  /** False only when no draw in the whole budget met the rules and this was the fairest of them. */
  accepted?: boolean;
  teams?: number;
  clumpBefore?: number;
  clumpAfter?: number;
  regionLow?: number | null;
  /** Per fleet, the slowest square gating its slowest ship. Seconds. */
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
