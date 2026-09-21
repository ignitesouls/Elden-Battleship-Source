import { bracketSize, newMatch, statusOf, winsNeeded } from "./types";
import type { BracketId, Result, ResultKind, Side, TMatch } from "./types";
import { assignPhases } from "./phases";
import { seedOrder } from "./seeding";

export interface KnockoutOptions {
  format: "single" | "double";
  /** Games per series in every round unless overridden below. */
  bestOf: number;
  /** Series length for the last-but-one round (and, in double elimination, the winners' and losers' finals). */
  semifinalBestOf?: number;
  /** Series length for the final - or, in double elimination, the grand final and its reset. */
  finalBestOf?: number;
  /** Single elimination only: play off the two beaten semifinalists. */
  thirdPlace: boolean;
  /**
   * Double elimination only. When the loser-bracket finalist beats the winners-bracket finalist in
   * the grand final, the two have one loss each, so a second grand final decides it. Without the
   * reset the grand final is a single series and the winners-bracket side gets no second life.
   */
  grandFinalReset: boolean;
}

/**
 * Where an entrant slot gets its team from while the bracket is still being drawn.
 * A `bye` is a slot that will never hold anyone.
 */
type Slot =
  | { t: "entrant"; id: string }
  | { t: "bye" }
  | { t: "winner"; of: string }
  | { t: "loser"; of: string };

interface Draft {
  key: string;
  bracket: BracketId;
  round: number;
  index: number;
  a: Slot;
  b: Slot;
}

const winnerOf = (of: string): Slot => ({ t: "winner", of });
const loserOf = (of: string): Slot => ({ t: "loser", of });

/**
 * Draws a knockout bracket for `seeded` (seed 1 first).
 *
 * The bracket is first drawn as if the field were a full power of two, with the missing seeds as
 * byes, and then the byes are collapsed out: any match with a bye on one side is not a match at all,
 * so it is removed and whatever would have fed from it is wired to its real entrant instead. That
 * gives a bracket with no phantom fixtures and, importantly, nothing for the runtime to special-case.
 * Every match that survives has two real entrants or two pointers into matches that also survive.
 *
 * The same pass is what makes double elimination work for any field size. A loser-bracket match that
 * is due to receive one team and one bye collapses exactly like a first-round bye, and the chain
 * reaction is handled by walking the matches in the order they were drawn - every match refers only
 * to earlier ones, so by the time a match is looked at everything upstream of it has been settled.
 */
export function buildKnockout(seeded: string[], opts: KnockoutOptions): TMatch[] {
  const n = seeded.length;
  if (n < 2) throw new Error("A knockout needs at least two entrants");

  const size = bracketSize(n);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const drafts: Draft[] = [];

  const seedSlot = (seed: number): Slot =>
    seed <= n ? { t: "entrant", id: seeded[seed - 1] } : { t: "bye" };

  // -- winners bracket -------------------------------------------------------------------------
  for (let i = 0; i < size / 2; i++) {
    drafts.push({
      key: `W1-${i}`,
      bracket: "W",
      round: 1,
      index: i,
      a: seedSlot(order[2 * i]),
      b: seedSlot(order[2 * i + 1]),
    });
  }
  for (let r = 2; r <= rounds; r++) {
    for (let i = 0; i < size / 2 ** r; i++) {
      drafts.push({
        key: `W${r}-${i}`,
        bracket: "W",
        round: r,
        index: i,
        a: winnerOf(`W${r - 1}-${2 * i}`),
        b: winnerOf(`W${r - 1}-${2 * i + 1}`),
      });
    }
  }

  // -- third place (single elimination) --------------------------------------------------------
  if (opts.format === "single" && opts.thirdPlace && rounds >= 2) {
    drafts.push({
      key: "TP-0",
      bracket: "TP",
      round: 1,
      index: 0,
      a: loserOf(`W${rounds - 1}-0`),
      b: loserOf(`W${rounds - 1}-1`),
    });
  }

  // -- loser bracket and grand final (double elimination) --------------------------------------
  let lastLoserRound = 0;
  if (opts.format === "double") {
    for (let j = 1; j < rounds; j++) {
      const count = size / 2 ** (j + 1);

      // Odd loser round: the survivors of the round before (or, first time round, the winners
      // bracket's first-round losers) play each other.
      for (let i = 0; i < count; i++) {
        drafts.push({
          key: `L${2 * j - 1}-${i}`,
          bracket: "L",
          round: 2 * j - 1,
          index: i,
          a: j === 1 ? loserOf(`W1-${2 * i}`) : winnerOf(`L${2 * j - 2}-${2 * i}`),
          b: j === 1 ? loserOf(`W1-${2 * i + 1}`) : winnerOf(`L${2 * j - 2}-${2 * i + 1}`),
        });
      }
      // Even loser round: those survivors meet the teams just dropped from the winners bracket.
      // On odd `j` the drop-ins are taken in reverse order. Without that, the loser of a
      // winners-bracket match would drop straight back onto the half of the loser bracket holding
      // the teams he has just beaten, and the first thing he'd do after losing is play them again.
      // It has to alternate rather than always reverse: the reversal at `j` also swaps which half
      // the survivors sit in, so reversing again at `j + 1` would undo the separation it just made.
      for (let i = 0; i < count; i++) {
        const dropped = j % 2 === 1 && count > 1 ? count - 1 - i : i;
        drafts.push({
          key: `L${2 * j}-${i}`,
          bracket: "L",
          round: 2 * j,
          index: i,
          a: winnerOf(`L${2 * j - 1}-${i}`),
          b: loserOf(`W${j + 1}-${dropped}`),
        });
      }
      lastLoserRound = 2 * j;
    }

    drafts.push({
      key: "GF1",
      bracket: "GF",
      round: 1,
      index: 0,
      a: winnerOf(`W${rounds}-0`),
      // With two entrants there is no loser bracket at all: the grand final is just the winners
      // final's loser getting the same second chance everyone else in the event got.
      b: lastLoserRound > 0 ? winnerOf(`L${lastLoserRound}-0`) : loserOf(`W${rounds}-0`),
    });
  }

  // -- collapse the byes ------------------------------------------------------------------------
  // replacement[key] is what a reference to that collapsed match's winner/loser means instead.
  const replacement = new Map<string, { winner: Slot; loser: Slot }>();
  const resolve = (slot: Slot): Slot => {
    if (slot.t === "winner" || slot.t === "loser") {
      const collapsed = replacement.get(slot.of);
      if (collapsed) return slot.t === "winner" ? collapsed.winner : collapsed.loser;
    }
    return slot;
  };

  const kept: Draft[] = [];
  for (const draft of drafts) {
    const a = resolve(draft.a);
    const b = resolve(draft.b);
    if (a.t === "bye" || b.t === "bye") {
      const survivor: Slot = a.t === "bye" ? b : a;
      replacement.set(draft.key, { winner: survivor, loser: { t: "bye" } });
    } else {
      kept.push({ ...draft, a, b });
    }
  }

  // -- emit -------------------------------------------------------------------------------------
  const lastRound = (bracket: BracketId) => {
    let max = 0;
    for (const d of drafts) if (d.bracket === bracket) max = Math.max(max, d.round);
    return max;
  };
  const bestOfFor = (d: Draft): number => {
    const final = opts.finalBestOf ?? opts.bestOf;
    const semi = opts.semifinalBestOf ?? opts.bestOf;
    if (d.bracket === "GF") return final;
    if (opts.format === "single") {
      if (d.bracket === "W" && d.round === rounds) return final;
      if (d.bracket === "W" && d.round === rounds - 1) return semi;
      if (d.bracket === "TP") return semi;
      return opts.bestOf;
    }
    if ((d.bracket === "W" && d.round === rounds) || (d.bracket === "L" && d.round === lastRound("L"))) return semi;
    return opts.bestOf;
  };

  const out = kept.map((d) =>
    newMatch({
      key: d.key,
      stage: "knockout",
      bracket: d.bracket,
      round: d.round,
      index: d.index,
      a: d.a.t === "entrant" ? d.a.id : null,
      b: d.b.t === "entrant" ? d.b.id : null,
      bestOf: bestOfFor(d),
    }),
  );
  const byKey = new Map(out.map((m) => [m.key, m]));

  for (const d of kept) {
    for (const side of ["a", "b"] as const) {
      const slot = d[side];
      if (slot.t !== "winner" && slot.t !== "loser") continue;
      const source = byKey.get(slot.of);
      if (!source) throw new Error(`Bracket wiring error: ${d.key} refers to missing match ${slot.of}`);
      const pointer = { key: d.key, side };
      if (slot.t === "winner") source.winnerTo = pointer;
      else source.loserTo = pointer;
    }
  }

  if (opts.format === "double" && opts.grandFinalReset) {
    out.push(
      newMatch({
        key: "GF2",
        stage: "knockout",
        bracket: "GF",
        round: 2,
        index: 0,
        bestOf: opts.finalBestOf ?? opts.bestOf,
        resetOf: "GF1",
      }),
    );
  }
  return assignPhases(out);
}

// ===========================================================================
//  Recording results
// ===========================================================================
// This is the part that is mirrored in SQL (advance_tournament_match). The two must stay in step:
// the TypeScript is what the checks exercise, the SQL is what runs when an official game ends.

const fail = <T>(error: string): Result<T> => ({ ok: false, error });

/**
 * Sets a match's score to `scoreA`-`scoreB` games and applies whatever follows from it: a decided
 * match sends its winner and loser along their pointers, an undecided one sends nobody anywhere.
 *
 * This one operation is deliberately the only way a result changes. Recording a game, correcting a
 * score, and reverting a match are all just calls with different numbers, so there is one set of
 * rules for "is this allowed" rather than three that can disagree.
 *
 * Changing a decided match is refused if anything downstream has already been played, since the
 * teams there are the ones this result put there. Changing the score without changing the winner
 * (2-1 to 2-0) is always fine: the outputs are identical, so nothing downstream can notice.
 */
export function setScore(
  matches: TMatch[],
  key: string,
  scoreA: number,
  scoreB: number,
  kind: ResultKind = "admin",
): Result<TMatch[]> {
  const next = matches.map((m) => ({ ...m }));
  const byKey = new Map(next.map((m) => [m.key, m]));
  const m = byKey.get(key);
  if (!m) return fail(`There is no match ${key}`);
  if (m.status === "skipped") return fail(`${key} is not needed - the grand final was already decisive`);
  if (!m.a || !m.b) return fail(`${key} is still waiting on earlier results`);
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    return fail("A score is a whole number of games, zero or more");
  }

  const need = winsNeeded(m.bestOf);
  if (scoreA > need || scoreB > need || (scoreA === need && scoreB === need)) {
    return fail(`In a best of ${m.bestOf} the winner takes ${need} games and the loser fewer`);
  }

  const decided: Side | null = scoreA === need ? "a" : scoreB === need ? "b" : null;
  const before: Side | null = m.winner ? (m.winner === m.a ? "a" : "b") : null;

  if (before !== decided && before) {
    const problem = retract(byKey, m);
    if (problem) return fail(problem);
  }

  m.scoreA = scoreA;
  m.scoreB = scoreB;
  m.winner = decided ? (decided === "a" ? m.a : m.b) : null;
  // A series left undecided - or cleared - has no "kind" of result, so it falls back to the default.
  m.resultKind = decided ? kind : "played";
  m.status = statusOf(m);

  if (decided && before !== decided) apply(byKey, m, decided);
  return { ok: true, value: next };
}

/** Records one game to `side`. The next game of a series, or the last one that decides it. */
export function recordGame(matches: TMatch[], key: string, side: Side): Result<TMatch[]> {
  const m = matches.find((x) => x.key === key);
  if (!m) return fail(`There is no match ${key}`);
  // setScore would accept a third game here as a "correction" (2-0 becomes 2-1, same winner), which
  // is right for an admin fixing a score and wrong for a game arriving after the series is over.
  if (m.winner) return fail(`${key} is already decided`);
  return setScore(matches, key, m.scoreA + (side === "a" ? 1 : 0), m.scoreB + (side === "b" ? 1 : 0), "played");
}

/**
 * Awards a match to the other side without it being played: the winner gets the full winning total
 * and the loser nothing (2-0 in a best of three), so it advances the bracket through exactly the same
 * path as any result. Mirrors tournament_forfeit_match. A match that already has a winner is refused -
 * changing a played result is a score entry, not a forfeit.
 */
export function forfeitMatch(matches: TMatch[], key: string, loser: Side): Result<TMatch[]> {
  const m = matches.find((x) => x.key === key);
  if (!m) return fail(`There is no match ${key}`);
  if (!m.a || !m.b) return fail(`${key} is still waiting on earlier results`);
  if (m.winner) return fail(`${key} is already decided`);
  const need = winsNeeded(m.bestOf);
  return setScore(matches, key, loser === "a" ? 0 : need, loser === "b" ? 0 : need, "forfeit");
}

/**
 * Forfeits every open match that has a departed team in it, and keeps going until none is left:
 * awarding one match places its winner and loser into the next, which may itself hold a departed team
 * (a team dropping into the loser bracket, say). Mirrors tournament_settle_forfeits.
 *
 * If both sides have departed the first-listed side forfeits - somebody has to advance, and the
 * departed team it meets next forfeits in turn.
 */
export function settleForfeits(matches: TMatch[], departed: ReadonlySet<string>): Result<TMatch[]> {
  let current = matches;
  // Each pass decides one match, so this cannot run longer than the number of matches; the bound is
  // only there so a bug in the wiring fails loudly rather than spinning.
  for (let pass = 0; pass <= matches.length + 1; pass++) {
    const open = current
      .filter((m) => (m.status === "ready" || m.status === "in_progress") && ((m.a && departed.has(m.a)) || (m.b && departed.has(m.b))))
      .sort((x, y) => x.round - y.round || x.index - y.index || (x.key < y.key ? -1 : 1))[0];
    if (!open) return { ok: true, value: current };
    const result = forfeitMatch(current, open.key, open.a && departed.has(open.a) ? "a" : "b");
    if (!result.ok) return result;
    current = result.value;
  }
  return fail("Forfeits did not settle - the bracket wiring loops");
}

/** Clears a match back to unplayed, taking its winner and loser back out of the next matches. */
export function revertMatch(matches: TMatch[], key: string): Result<TMatch[]> {
  const m = matches.find((x) => x.key === key);
  if (!m) return fail(`There is no match ${key}`);
  if (m.scoreA + m.scoreB === 0 && !m.winner) return fail(`${key} has no result to revert`);
  return setScore(matches, key, 0, 0);
}

/** A match downstream of this one that has already started - which is what stops a revert. */
function started(t: TMatch): boolean {
  return t.scoreA + t.scoreB > 0 || t.winner !== null;
}

/** Takes a decided match's outputs back out, or explains why it can't. Mutates the clones it is given. */
function retract(byKey: Map<string, TMatch>, m: TMatch): string | null {
  const targets: Array<{ target: TMatch; side: Side }> = [];
  for (const pointer of [m.winnerTo, m.loserTo]) {
    if (!pointer) continue;
    const target = byKey.get(pointer.key);
    if (target) targets.push({ target, side: pointer.side });
  }
  const reset = [...byKey.values()].find((x) => x.resetOf === m.key);

  for (const { target } of targets) {
    if (started(target)) return `Cannot change ${m.key}: ${target.key} has already been played`;
  }
  if (reset && started(reset)) return `Cannot change ${m.key}: the reset (${reset.key}) has already been played`;

  for (const { target, side } of targets) {
    target[side] = null;
    target.status = statusOf(target);
  }
  if (reset) {
    reset.a = reset.b = null;
    reset.status = "pending";
  }
  return null;
}

/** Sends a decided match's winner and loser along their pointers, and settles a grand-final reset. */
function apply(byKey: Map<string, TMatch>, m: TMatch, decided: Side): void {
  const winner = decided === "a" ? m.a : m.b;
  const loser = decided === "a" ? m.b : m.a;

  const place = (pointer: TMatch["winnerTo"], entrant: string | null) => {
    if (!pointer) return;
    const target = byKey.get(pointer.key);
    if (!target) return;
    target[pointer.side] = entrant;
    target.status = statusOf(target);
  };
  place(m.winnerTo, winner);
  place(m.loserTo, loser);

  const reset = [...byKey.values()].find((x) => x.resetOf === m.key);
  if (reset) {
    if (decided === "b") {
      // The loser-bracket finalist has taken the grand final: one loss apiece, so play it again.
      reset.a = m.a;
      reset.b = m.b;
      // statusOf keeps "skipped" sticky, so shed a stale one before working out the real status.
      reset.status = "pending";
      reset.status = statusOf(reset);
    } else {
      reset.a = reset.b = null;
      reset.status = "skipped";
    }
  }
}

/** The winner of the whole knockout, once it is settled. */
export function knockoutChampion(matches: TMatch[]): string | null {
  const gf1 = matches.find((m) => m.key === "GF1");
  if (gf1) {
    const reset = matches.find((m) => m.resetOf === "GF1");
    if (reset && reset.status !== "skipped") return reset.winner;
    return gf1.winner;
  }
  let final: TMatch | null = null;
  for (const m of matches) {
    if (m.bracket === "W" && (!final || m.round > final.round)) final = m;
  }
  return final?.winner ?? null;
}
