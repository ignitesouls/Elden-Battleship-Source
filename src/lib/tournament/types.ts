/**
 * The shape of a tournament match, shared by every format.
 *
 * -- One row shape, three formats --------------------------------------------------------------------
 *
 * Swiss rounds, group round-robins and knockout brackets all reduce to the same thing: two entrants,
 * a best-of, and a running score. What differs is only what happens when a match finishes - a knockout
 * match sends its winner (and, in double elimination, its loser) somewhere, and the others send
 * nobody anywhere. That "somewhere" is stored as a pointer on the match itself (`winnerTo` /
 * `loserTo`), decided once when the bracket is generated.
 *
 * Storing the pointers, rather than recomputing the bracket from its rules every time a result comes
 * in, is what lets the database advance a bracket on its own. A tournament match is finished by
 * archive_match, on the server, when an official game ends - there is no admin's browser in that
 * loop to run this TypeScript. So the part that must run at result time is deliberately tiny (write
 * the score, copy the winner along its pointer) and is mirrored in SQL; everything hard - seeding,
 * byes, the loser-bracket topology, Swiss pairing - happens here, once, in the admin's browser, and
 * is written down as plain rows.
 *
 * Nothing in this folder touches React or Supabase. That is what makes it checkable with bare Node
 * (see scripts/check-tournament.ts) and is why the rules can be pinned down before any UI exists.
 */

export type Side = "a" | "b";

/** Which part of the event a match belongs to. */
export type MatchStage = "swiss" | "group" | "knockout";

/**
 * Which bracket a knockout match sits in.
 *   W  - the main bracket (the only one in single elimination)
 *   L  - the loser bracket (double elimination)
 *   GF - the grand final and, if enabled, its reset
 *   TP - the third-place match
 */
export type BracketId = "W" | "L" | "GF" | "TP";

/**
 * pending      - waiting on a result upstream; at least one entrant is still unknown
 * ready        - both entrants known, nothing played
 * in_progress  - a best-of series with at least one game recorded and no winner yet
 * done         - has a winner
 * skipped      - a grand-final reset that turned out not to be needed
 */
export type MatchStatus = "pending" | "ready" | "in_progress" | "done" | "skipped";

/** Where a finished match sends one of its two entrants. */
export interface Pointer {
  key: string;
  side: Side;
}

export interface TMatch {
  /** Stable within a tournament, e.g. "W2-1", "L3-0", "GF1", "S2-4", "G1-3-0". */
  key: string;
  stage: MatchStage;
  bracket: BracketId | null;
  /** 0-based group number for group-stage matches, else null. */
  group: number | null;
  /** 1-based round within the bracket (or the Swiss round / group matchday). */
  round: number;
  /** 0-based position within the round. */
  index: number;
  /** Entrant ids. Null means "not decided yet". */
  a: string | null;
  b: string | null;
  bestOf: number;
  scoreA: number;
  scoreB: number;
  status: MatchStatus;
  winner: string | null;
  winnerTo: Pointer | null;
  loserTo: Pointer | null;
  /** Set only on a grand-final reset: the key of the grand final it is the rematch of. */
  resetOf: string | null;
  /**
   * A Swiss bye: `a` advances without playing. Counted as a win in the standings but is not a game,
   * so it is left out of game difference and out of everyone's Buchholz.
   */
  isBye: boolean;
  /**
   * The stage's own idea of "round", which is what a deadline attaches to. For Swiss and groups it is
   * just `round`. For a knockout it is how many results deep the match sits, because the winners and
   * loser brackets run side by side and a "round" of one says nothing about when the other can be
   * played - see assignPhases in schedule.ts.
   */
  phase: number;
  /** The window the round is meant to be played in. ISO timestamps, null until a schedule is applied. */
  opensAt: string | null;
  dueAt: string | null;
  /** How a decided match was decided. Standings treat all three alike; the bracket page labels them. */
  resultKind: ResultKind;
}

export type ResultKind = "played" | "admin" | "forfeit";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Game wins needed to take a best-of-N. Best-of-1 needs 1, best-of-3 needs 2, best-of-5 needs 3. */
export function winsNeeded(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

/** What a match's status should be, given its entrants and score. `skipped` is sticky. */
export function statusOf(m: Pick<TMatch, "a" | "b" | "scoreA" | "scoreB" | "winner" | "status">): MatchStatus {
  if (m.status === "skipped") return "skipped";
  if (m.winner) return "done";
  if (!m.a || !m.b) return "pending";
  return m.scoreA + m.scoreB > 0 ? "in_progress" : "ready";
}

export function newMatch(fields: Partial<TMatch> & Pick<TMatch, "key" | "stage" | "round" | "index">): TMatch {
  const m: TMatch = {
    bracket: null,
    group: null,
    a: null,
    b: null,
    bestOf: 1,
    scoreA: 0,
    scoreB: 0,
    status: "pending",
    winner: null,
    winnerTo: null,
    loserTo: null,
    resetOf: null,
    isBye: false,
    phase: fields.round,
    opensAt: null,
    dueAt: null,
    resultKind: "played",
    ...fields,
  };
  m.status = statusOf(m);
  return m;
}

/** Smallest power of two that is >= n (and at least 2). */
export function bracketSize(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}
