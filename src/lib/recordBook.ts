import { participantKey, type ParticipantRow } from "./careerStats";
import type { SquareSetId } from "./squareSets";
import type { MatchEventRow } from "./almanac";

/**
 * The record book: the best single game anybody has had, per category.
 *
 * Careers answer "who is good"; this answers "what is the best that has ever happened here", which is
 * a different and more re-readable question - a record stands until somebody beats it, and beating one
 * is a thing that happens in a specific match on a specific night.
 *
 * Everything here is derived from rows that have been archived since the Almanac shipped. No new
 * column, no migration, nothing to start collecting first:
 *
 *   - `match_participants` already holds one row per player per match with shots, hits, sunk and the
 *     fleet's losses, which covers every counting record outright.
 *   - `match_events` already holds one row per shot with its result and `match_seconds`, which is what
 *     makes the timing and streak records possible at all - they were never stored as numbers, but the
 *     shots they are made of were.
 *
 * Ties go to whoever did it FIRST - a record is held until it is beaten, not shared with whoever
 * equalled it later.
 *
 * The book used to be positive-only, on the reasoning that one people enjoy reading is one nobody is
 * afraid of appearing in. That rule has been lifted for exactly one entry, "Worst accuracy", which is
 * a deliberate wooden spoon rather than the first of a set. If more get added, the thing to keep an
 * eye on is the ratio: a book that is mostly celebration can carry a joke at somebody's expense, and
 * one that is mostly pillory stops being fun to appear in at all.
 *
 * The negative records stay out of lib/recordChase - see the note on TRACKS there.
 */

export interface RecordHolder {
  /** Grouping key, also the /player/:key link target. */
  key: string;
  nickname: string;
  userId: string | null;
  /** The raw number, for sorting and for beating. */
  value: number;
  /** The number as it should be read: "19 hits", "83%", "1:24". */
  display: string;
  /** Context that makes the number mean something: "of 23 shots". */
  detail?: string;
  matchKey: string;
  roomCode: string | null;
  finishedAt: string;
}

export interface RecordEntry {
  id: string;
  emoji: string;
  label: string;
  /** What it takes to qualify, when that isn't obvious. */
  note?: string;
  holder: RecordHolder | null;
  /** The next best, for something to chase. */
  chasers: RecordHolder[];
}

/**
 * Minimum shots before an accuracy counts, at either end of the book.
 *
 * Not a judgement about how much shooting is impressive - accuracy is accuracy. It exists so the
 * records stay beatable: without a floor the best is permanently held by whoever once fired a single
 * lucky shot, and 100% can only be equalled, which the first-holder tie-break then refuses. The
 * worst has the same shape upside down, and it matters more there - one player opening with a single
 * miss and never firing again is a 0% nobody can ever beat, and being handed the wooden spoon for
 * one shot is not a joke anyone finds funny. Five is low enough that a short match on a small board
 * still qualifies at both ends.
 */
export const MIN_SHOTS_FOR_ACCURACY = 5;

/** A streak record shorter than this is noise; two hits in a row is a Tuesday. */
export const MIN_STREAK = 3;

/**
 * Shortest gap that counts as two fights rather than one.
 *
 * The rule is that you fire the moment you kill, so a gap is normally a fight start to finish - but
 * two squares can finish at the SAME moment and legitimately produce a gap of nothing. The Haligtree
 * Tree Sentinels are one duo fight filling two squares; a player who banks one kill and fires it
 * next to the following one leaves the same trace. Neither is a fast pair, and either would hold
 * this record permanently, since a tie goes to whoever set it first.
 *
 * Ten seconds is not a guess. In the archive at the time of writing, the gaps run 0:01, 0:04, 0:08,
 * then NOTHING until 0:33 - the double-fires and the real runs are separated by a clear empty band,
 * and ten sits inside it. Raise this only if that band moves.
 */
export const MIN_GAP_SECONDS = 10;

/** How many names sit under the holder as something to chase. */
const CHASERS = 2;

/**
 * Whether this is the boss board.
 *
 * Compared against the id rather than looked up through squareSets, which binds the .json files:
 * this module is import-free on purpose so scripts/check-record-book.ts can exercise it under bare
 * Node. Unknown and null ids mean the boss board, exactly as squareSets.rowSquareSet has it - which
 * also makes the archive's pre-square-set rows, all of them boss matches, come out right.
 *
 * Every cut of the boss board counts, listed out for the same reason: callers hand this whatever
 * they have, and a caller passing a stored id rather than a folded one would otherwise be told its
 * squares were not bosses. Keep in step with the variants in squareSets.ts.
 */
const BOSS_BOARDS = new Set(["bosses", "bosses-2v2"]);

function isBossBoard(id: SquareSetId | null | undefined): boolean {
  return id === undefined || id === null || BOSS_BOARDS.has(id);
}

/**
 * What one square on this set's board IS, in words.
 *
 * The boss board's squares are bosses; every other set's are errands, collectables and multi-part
 * goals that no single noun covers, so they stay "squares". Only prose needs this and nothing
 * branches on it - but "quickest two bosses" on a board of "acquire 3 painting rewards" is simply a
 * lie, and the gap record reads that line out loud on every set.
 */
function squareNoun(id: SquareSetId | null | undefined): { one: string; many: string } {
  return isBossBoard(id)
    ? { one: "boss", many: "bosses" }
    : { one: "square", many: "squares" };
}

interface Candidate extends Omit<RecordHolder, "display" | "detail"> {
  display?: string;
  detail?: string;
}

/**
 * Ranks candidates and splits off the holder.
 *
 * `higherIsBetter` is false for the timing records, where the record is the SMALLEST number - and the
 * tie-break stays "earliest match wins" in both directions, because the rule is about who got there
 * first, not about the number.
 */
function rank(
  candidates: Candidate[],
  format: (c: Candidate) => { display: string; detail?: string },
  higherIsBetter = true
): { holder: RecordHolder | null; chasers: RecordHolder[] } {
  const sorted = [...candidates].sort(
    (a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value) || a.finishedAt.localeCompare(b.finishedAt)
  );
  const shaped = sorted.map((c) => ({ ...c, ...format(c) }));
  return { holder: shaped[0] ?? null, chasers: shaped.slice(1, 1 + CHASERS) };
}

/** A participant row as a candidate, with the value under measurement. */
function fromRow(row: ParticipantRow, value: number): Candidate {
  return {
    key: participantKey(row),
    nickname: row.nickname,
    userId: row.user_id,
    value,
    matchKey: row.match_key,
    roomCode: row.room_code,
    finishedAt: row.finished_at,
  };
}

/** One trigger-pull, rebuilt from the per-defender rows the archive stores it as. */
interface ArchivedShot {
  matchKey: string;
  key: string;
  nickname: string;
  userId: string | null;
  roomCode: string | null;
  finishedAt: string;
  seconds: number;
  cellIndex: number;
  /** The square that was taken to earn this shot, when the archive recorded its name. */
  challenge: string | null;
  /** The best outcome across every fleet this one shot landed on. */
  result: "miss" | "hit" | "sunk";
}

/**
 * Collapses `match_events` back into shots, in the order they were fired.
 *
 * A single trigger-pull writes one row per opposing fleet, all sharing a timestamp - so counting rows
 * would count a shot twice in a three-team match, and a streak built from them would be nonsense. The
 * grouping is the same one the live feed uses (see attackFeed.groupIntoShots), keyed on who fired,
 * which square, and when.
 *
 * Rows with no `match_seconds` are dropped rather than guessed at: everything below is about order,
 * and a shot that cannot be placed in the sequence cannot contribute to it.
 */
export function archivedShots(events: MatchEventRow[]): ArchivedShot[] {
  const byShot = new Map<string, ArchivedShot>();
  const better = { miss: 0, hit: 1, sunk: 2 } as const;

  for (const e of events) {
    if (e.match_seconds === null || e.match_seconds === undefined) continue;
    if (e.cell_index < 0) continue; // bookkeeping rows, not shots
    const key = participantKey(e);
    const id = `${e.match_key}|${key}|${e.cell_index}|${e.match_seconds}`;
    const result = e.result === "sunk" ? "sunk" : e.result === "hit" ? "hit" : "miss";

    const existing = byShot.get(id);
    if (existing) {
      if (better[result] > better[existing.result]) existing.result = result;
      existing.challenge ??= e.challenge_name ?? null;
      continue;
    }
    byShot.set(id, {
      matchKey: e.match_key,
      key,
      nickname: e.nickname,
      userId: e.user_id,
      roomCode: null, // events don't carry it; the record links by match key instead
      finishedAt: e.finished_at,
      seconds: e.match_seconds,
      cellIndex: e.cell_index,
      challenge: e.challenge_name ?? null,
      result,
    });
  }

  return [...byShot.values()].sort(
    (a, b) => a.matchKey.localeCompare(b.matchKey) || a.seconds - b.seconds || a.cellIndex - b.cellIndex
  );
}

/** Every player's longest run of consecutive hits, per match. */
function hitStreaks(shots: ArchivedShot[]): Candidate[] {
  const out: Candidate[] = [];
  const running = new Map<string, number>();
  const best = new Map<string, { streak: number; shot: ArchivedShot }>();

  for (const shot of shots) {
    const id = `${shot.matchKey}|${shot.key}`;
    const run = shot.result === "miss" ? 0 : (running.get(id) ?? 0) + 1;
    running.set(id, run);
    const top = best.get(id);
    if (!top || run > top.streak) best.set(id, { streak: run, shot });
  }

  for (const { streak, shot } of best.values()) {
    if (streak < MIN_STREAK) continue;
    out.push({
      key: shot.key,
      nickname: shot.nickname,
      userId: shot.userId,
      value: streak,
      matchKey: shot.matchKey,
      roomCode: shot.roomCode,
      finishedAt: shot.finishedAt,
    });
  }
  return out;
}

/**
 * Every player's quickest back-to-back pair, per match.
 *
 * The house rule is that you fire the moment you kill, so a shot's timestamp IS a kill time and the
 * gap between two of them is the fight in between, start to finish. Nothing else in the archive
 * measures that: every other record here is about aim, and this one is about pace. What it will not
 * count is a pair too close together to have been two fights - see MIN_GAP_SECONDS.
 *
 * Consecutive means consecutive for that player - it does not matter who else fired in between -
 * and hit or miss is irrelevant throughout, for the reason almanac.bossStats sets out: what was
 * hiding under the square is the opponent's doing, not a fact about the run.
 *
 * Relies on `shots` arriving in fired order, which archivedShots guarantees.
 */
function quickestGaps(shots: ArchivedShot[]): Candidate[] {
  const last = new Map<string, ArchivedShot>();
  const best = new Map<string, { gap: number; from: ArchivedShot; to: ArchivedShot }>();

  for (const shot of shots) {
    const id = `${shot.matchKey}|${shot.key}`;
    const previous = last.get(id);
    last.set(id, shot);
    // A player's opening shot has nothing to be measured from - it belongs to first blood instead.
    if (!previous) continue;

    const gap = shot.seconds - previous.seconds;
    if (gap < MIN_GAP_SECONDS) continue;
    const top = best.get(id);
    if (!top || gap < top.gap) best.set(id, { gap, from: previous, to: shot });
  }

  return [...best.values()].map(({ gap, from, to }) => ({
    key: to.key,
    nickname: to.nickname,
    userId: to.userId,
    value: gap,
    // Which two they were, when the archive kept the names - half the fun of this record is seeing
    // what somebody strung together, and it is the only line in the book that can say so.
    detail: from.challenge && to.challenge ? `${from.challenge} then ${to.challenge}` : undefined,
    matchKey: to.matchKey,
    roomCode: to.roomCode,
    finishedAt: to.finishedAt,
  }));
}

/** The earliest shot of a given kind in each match, per player. */
function earliest(shots: ArchivedShot[], wanted: (s: ArchivedShot) => boolean): Candidate[] {
  const first = new Map<string, ArchivedShot>();
  for (const shot of shots) {
    if (!wanted(shot)) continue;
    const id = `${shot.matchKey}|${shot.key}`;
    const held = first.get(id);
    if (!held || shot.seconds < held.seconds) first.set(id, shot);
  }
  return [...first.values()].map((shot) => ({
    key: shot.key,
    nickname: shot.nickname,
    userId: shot.userId,
    value: shot.seconds,
    matchKey: shot.matchKey,
    roomCode: shot.roomCode,
    finishedAt: shot.finishedAt,
  }));
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Players held out of one particular record, by record id.
 *
 * This is an EDITORIAL OVERRIDE and not a data fix, which is worth being blunt about in the one
 * place it lives. The games listed here happened, the numbers are real, and nothing below changes
 * the archive, the career table, the Almanac, or any other record - the excused player still holds
 * everything they earned and still appears everywhere else on the site. All this does is decline to
 * print one name against one record.
 *
 * It exists because one of the nine is a wooden spoon, and nobody volunteers for that. Being named
 * the worst on a public board is the sort of thing that should be undoable without deleting
 * somebody's match history to do it, and this is the small door for that.
 *
 * Scoped per record rather than per person on purpose. Keep the list short, and prefer taking an
 * entry OUT of here to putting one in: a record book carrying a long list of exceptions has stopped
 * recording anything, and at that point the honest move is to drop the record instead.
 */
const WITHHELD: Readonly<Record<string, readonly string[]>> = {
  "worst-accuracy": [
    // Elymis, whose 5% (1 of 20, RUSTYCORSAIR) would otherwise stand on the boss board. Withheld at
    // the board owner's request; KC's 8% carries it in the meantime. Remove this line to hand it back.
    "cbe3bcf8-d1d2-4616-bd71-50f81aea57f9",
  ],
};

/**
 * Whether a row may hold `recordId` at all - see WITHHELD.
 *
 * Applied to the CANDIDATES rather than to the finished entry, so an excused player drops out of the
 * chasers too. Filtering only the holder would leave them listed one line below as "chased by", which
 * is the same name on the same record for the same game, and would defeat the point entirely.
 */
function eligibleFor(recordId: string, row: ParticipantRow): boolean {
  return !WITHHELD[recordId]?.includes(participantKey(row));
}

/**
 * Builds the whole book.
 *
 * @param rows participation rows, already filtered to one square set - an accuracy record set on a
 * board of boss kills and one set on "acquire 3 painting rewards" are not the same record.
 * @param events archived shots for those same matches. Optional: the counting records stand on the
 * participation rows alone, so the book still works on a page that hasn't loaded events.
 * @param squareSetId that same set's id, used only to name what a square is - see squareNoun.
 */
export function buildRecordBook(
  rows: ParticipantRow[],
  events: MatchEventRow[] = [],
  squareSetId?: SquareSetId
): RecordEntry[] {
  const noun = squareNoun(squareSetId);
  const keys = new Set(rows.map((r) => r.match_key));
  // Events are fetched newest-first up to a cap, so they cover fewer matches than the rows do. Held to
  // the same matches either way, so a streak record can never come from a match the rest of the book
  // has never heard of.
  const shots = archivedShots(events.filter((e) => keys.has(e.match_key)));

  const book: RecordEntry[] = [
    {
      id: "hits",
      emoji: "💥",
      label: "Most hits",
      ...rank(
        rows.filter((r) => r.hits > 0).map((r) => fromRow(r, r.hits)),
        (c) => ({ display: plural(c.value, "hit") })
      ),
    },
    {
      id: "sunk",
      emoji: "⚓",
      label: "Most ships sunk",
      ...rank(
        rows.filter((r) => r.sunk > 0).map((r) => fromRow(r, r.sunk)),
        (c) => ({ display: plural(c.value, "ship") })
      ),
    },
    {
      id: "accuracy",
      emoji: "🔭",
      label: "Best accuracy",
      note: `${MIN_SHOTS_FOR_ACCURACY} shots or more`,
      ...rank(
        rows
          .filter((r) => r.shots >= MIN_SHOTS_FOR_ACCURACY && r.hits > 0)
          .map((r) => {
            const c = fromRow(r, r.hits / r.shots);
            c.detail = `${r.hits} of ${r.shots} shots`;
            return c;
          }),
        (c) => ({ display: `${Math.round(c.value * 100)}%`, detail: c.detail })
      ),
    },
    {
      id: "streak",
      emoji: "🎯",
      label: "Longest run of hits",
      note: `${MIN_STREAK} or more, back to back`,
      ...rank(hitStreaks(shots), (c) => ({ display: `${c.value} in a row` })),
    },
    {
      id: "shots",
      emoji: "🐒",
      label: "Most shots fired",
      ...rank(
        rows.filter((r) => r.shots > 0).map((r) => fromRow(r, r.shots)),
        (c) => ({ display: plural(c.value, "shot") })
      ),
    },
    {
      id: "first-blood",
      emoji: "🧨",
      label: "Quickest first blood",
      note: "measured from the moment firing opened",
      ...rank(
        earliest(shots, (s) => s.result !== "miss"),
        (c) => ({ display: clock(c.value) }),
        false
      ),
    },
    {
      id: "first-sinking",
      emoji: "🗡️",
      label: "Quickest sinking",
      ...rank(
        earliest(shots, (s) => s.result === "sunk"),
        (c) => ({ display: clock(c.value) }),
        false
      ),
    },
    {
      id: "gap",
      emoji: "⚡",
      label: `Quickest two ${noun.many}`,
      note: `shortest gap between back-to-back ${noun.many}`,
      ...rank(
        quickestGaps(shots),
        (c) => ({ display: clock(c.value), detail: c.detail }),
        false
      ),
    },
    /**
     * The wooden spoon, and the one entry in the book that isn't an achievement.
     *
     * Last on purpose. The book is read top to bottom, so everything above this is somebody's best
     * night and this is the punchline at the end of it - putting it up next to "Best accuracy",
     * where it would sort naturally, turns a joke into a scoreboard of shame two lines long.
     *
     * On the BOSS BOARD it requires a hit, and everywhere else it does not. The reason is that a 0%
     * game ends the record permanently: zero cannot be beaten, only equalled, and a tie goes to
     * whoever got there first - so the line is dead from the day it is set, on the board people
     * actually read. Requiring a hit puts the floor at one hit in n shots instead, which every
     * longer game can beat, so the record stays alive. The quieter boards keep the honest version:
     * they hold a handful of matches, a 0% there is a rarity worth crediting, and there is no long
     * run of future matches for a dead record to spoil.
     *
     * The `note` carries the difference, because a reader on the boss board seeing 3% needs to know
     * why the 0% game they remember isn't the one on the board.
     */
    {
      id: "worst-accuracy",
      emoji: "🌊",
      label: "Worst accuracy",
      note: isBossBoard(squareSetId)
        ? `${MIN_SHOTS_FOR_ACCURACY} shots or more, and at least one hit`
        : `${MIN_SHOTS_FOR_ACCURACY} shots or more`,
      ...rank(
        rows
          .filter(
            (r) =>
              eligibleFor("worst-accuracy", r) &&
              r.shots >= MIN_SHOTS_FOR_ACCURACY &&
              (r.hits > 0 || !isBossBoard(squareSetId))
          )
          .map((r) => {
            const c = fromRow(r, r.hits / r.shots);
            c.detail = `${r.hits} of ${r.shots} shots`;
            return c;
          }),
        (c) => ({ display: `${Math.round(c.value * 100)}%`, detail: c.detail }),
        false
      ),
    },
  ];

  return book;
}
