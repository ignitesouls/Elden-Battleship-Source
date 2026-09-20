import { participantKey, type ParticipantRow } from "./careerStats";
import { HONOR_ORDER } from "./matchReport";
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
 *
 * -- What a record is not allowed to be ------------------------------------------------------------
 *
 * Squares are marked BY HAND. A player kills something and clicks it, and the clock on the resulting
 * row is the moment they clicked rather than the moment it died - so a shot's timestamp is only as
 * honest as somebody remembering to mark, and a mismark writes a time nobody earned.
 *
 * That is survivable for most of what is below, and fatal for one shape of record: anything won by a
 * SMALL GAP between two marks. "Quickest two bosses" lived here until it was cut, and it could be
 * taken outright by forgetting to mark for half an hour and then marking twice in a row, which is
 * the opposite of the thing it claimed to measure. No amount of flooring the gap fixes that - the
 * floor only moves the price of the fake.
 *
 * As of 9/20, auto-mark exists and every timing record - first blood and first sinking included -
 * only counts a shot the mod fired off a real kill event (see `earliest()` and the `auto` column on
 * `attacks`/`match_events`). Before that column existed, first blood and first sinking were the two
 * timing records that survived hand-marking anyway: a late manual mark can only ever make somebody
 * look slower, never faster, which is a different failure mode from the gap records above. That
 * reasoning still holds - this isn't undoing it, it's just no longer the thing doing the work, since
 * every timing record now runs on the same auto-only rule instead of half of them needing a reader
 * to remember which half was exempt and why.
 *
 * What survives on marking alone, with no auto requirement, and what a new record should be made of:
 *
 *   - counts and outcomes - shots, hits, sunk, who won - which the server re-derives from the room's
 *     own attack log rather than trusting a client, so no marking habit changes them;
 *   - what a square WAS, and what a match handed out for it.
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
 * Wins in a row before a run counts as a streak.
 *
 * Two, where a run of hits needs three, because the two are not the same currency. A hit is one
 * click and a match is an evening, so back-to-back wins over two separate nights is already a claim
 * worth printing - and holding it to three on an archive this size would leave the record showing
 * nobody for weeks at a time, which teaches a reader that the record does not work rather than that
 * it is hard.
 *
 * Raise it as the archive grows: it is one number and both win records read it.
 */
export const MIN_WIN_STREAK = 2;

/**
 * Shortest gap that counts as two fights rather than one.
 *
 * The rule is that you fire the moment you kill, so a gap is normally a fight start to finish - but
 * two squares can finish at the SAME moment and legitimately produce a gap of nothing. The Haligtree
 * Tree Sentinels are one duo fight filling two squares; a player who banks one kill and fires it
 * next to the following one leaves the same trace. Neither is a fast pair.
 *
 * Ten seconds is not a guess. In the archive at the time of writing, the gaps run 0:01, 0:04, 0:08,
 * then NOTHING until 0:33 - the double-fires and the real runs are separated by a clear empty band,
 * and ten sits inside it. Raise this only if that band moves.
 *
 * No record here rests on it any more; it lives on this side because it belongs with archivedShots,
 * and it is read by lib/squarePace and lib/almanac, which describe a TYPICAL square rather than a
 * best one. That is the difference that lets them keep using shot times at all: a median over a
 * career is barely moved by one bad mark, where a record is decided by the single most extreme row
 * in the archive and is therefore decided by the worst mark in it.
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
  /** Whether the mod fired this off a kill event, rather than a manual click. */
  auto: boolean;
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
      auto: e.auto ?? false,
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
 * Runs of wins, per career: the best anybody has ever put together, and the ones still alive.
 *
 * -- What breaks a run ------------------------------------------------------------------------------
 *
 * Anything that is not a win, draws included. A draw is every fleet going down together, which is a
 * match nobody won - and a streak that survived one would be claiming a run of wins that has a
 * not-a-win in the middle of it. It is the harsher of the two readings and it is the honest one.
 *
 * -- Why "active" is a separate record rather than a flag ---------------------------------------------
 *
 * They answer different questions. The longest is history and it is settled - it can only be taken by
 * somebody beating it. The active one is the standings right now: who walks into tonight's match on a
 * run, and who has one to lose. A player can hold both at once, which is exactly the situation worth
 * putting on a leaderboard.
 *
 * A run counts as active only if this career's LAST match was a win. One defeat ends it, and it drops
 * out of the record entirely rather than lingering at its old length.
 *
 * -- Scope -------------------------------------------------------------------------------------------
 *
 * Per square set, like every record here, because the rows arrive already filtered to one board. A
 * run of wins on the boss board and a run on the objectives board are not the same run, and splicing
 * them would invent streaks nobody actually played.
 *
 * Each career contributes at most ONE candidate to each record, so a player on a long run cannot fill
 * the holder slot and both chaser slots underneath themselves.
 */
function winStreaks(rows: ParticipantRow[]): { longest: Candidate[]; active: Candidate[] } {
  const careers = new Map<string, ParticipantRow[]>();
  for (const row of rows) {
    const key = participantKey(row);
    const list = careers.get(key);
    if (list) list.push(row);
    else careers.set(key, [row]);
  }

  const longest: Candidate[] = [];
  const active: Candidate[] = [];

  for (const played of careers.values()) {
    // Oldest first, so a run reads in the order it happened. match_key breaks a tie between two
    // matches archived in the same second, so the walk is deterministic rather than dependent on
    // whatever order the rows came back in.
    const order = [...played].sort(
      (a, b) => a.finished_at.localeCompare(b.finished_at) || a.match_key.localeCompare(b.match_key)
    );

    let run = 0;
    let best = 0;
    // The match a run ENDED on, which is what the record links through to: for a finished streak
    // that is its last win, and for a live one it is the most recent match played.
    let bestAt: ParticipantRow | null = null;

    for (const row of order) {
      if (!row.won) {
        run = 0;
        continue;
      }
      run++;
      if (run > best) {
        best = run;
        bestAt = row;
      }
    }

    if (best >= MIN_WIN_STREAK && bestAt) longest.push(fromRow(bestAt, best));

    // `run` is whatever survived to the end of the walk, so it is non-zero only when the last match
    // was a win - which is the definition of still being on one.
    const last = order.at(-1);
    if (run >= MIN_WIN_STREAK && last) {
      active.push(fromRow(last, run));
    }
  }

  return { longest, active };
}

/**
 * The earliest shot of a given kind in each match, per player.
 *
 * Restricted to auto-fired shots - see the note at the top of this file. A late manual mark could
 * only ever make somebody look slower, which is why first blood and first sinking used to be the
 * two timing records that survived hand-marking. Auto-mark is the mandatory path for speed as of
 * 9/20 anyway, so this now matches every other timing record instead of being the one exception
 * a reader had to be told about.
 */
function earliest(shots: ArchivedShot[], wanted: (s: ArchivedShot) => boolean): Candidate[] {
  const first = new Map<string, ArchivedShot>();
  for (const shot of shots) {
    if (!shot.auto) continue;
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
 * The rarest honor on an archived row, as a rank from the top of the list.
 *
 * `awards` holds titles, and HONOR_ORDER holds them in the order they are walked, which is the order
 * of how hard they are to earn - so position 0 is the hardest thing on the list and the last position
 * is whatever nobody above it took. Returned as a distance from the BOTTOM, purely so the number
 * sorts the way every other record does, with bigger meaning better.
 *
 * A title the list no longer contains scores nothing rather than scoring worst. The archive holds
 * retired ones - the old Flying Dutchman honor is gone, see HONORS.md - and a retired title is a
 * deed whose difficulty this list can no longer speak to, which is not the same as an easy one.
 *
 * The rule is one honor per player per match, so in practice this reads a single-element array. It
 * takes the best of them anyway, because that rule is enforced where awards are HANDED OUT and this
 * is reading what was written down some months later.
 */
function rarestHonor(titles: readonly string[] | null | undefined): { rank: number; title: string } | null {
  let best: { rank: number; title: string } | null = null;
  for (const title of titles ?? []) {
    const at = HONOR_ORDER.indexOf(title);
    if (at < 0) continue;
    const rank = HONOR_ORDER.length - at;
    if (!best || rank > best.rank) best = { rank, title };
  }
  return best;
}

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
 * @param squareSetId that same set's id, which decides only whether the wooden spoon needs a hit to
 * qualify - see the note on that entry.
 */
export function buildRecordBook(
  rows: ParticipantRow[],
  events: MatchEventRow[] = [],
  squareSetId?: SquareSetId
): RecordEntry[] {
  const keys = new Set(rows.map((r) => r.match_key));
  // Events are fetched newest-first up to a cap, so they cover fewer matches than the rows do. Held to
  // the same matches either way, so a streak record can never come from a match the rest of the book
  // has never heard of.
  const shots = archivedShots(events.filter((e) => keys.has(e.match_key)));

  // Both win records come off one walk of the rows, because they are two readings of the same runs.
  const wins = winStreaks(rows);

  const book: RecordEntry[] = [
    /**
     * The rarest thing anybody has been handed, and the only record here whose value is a deed
     * rather than a number.
     *
     * It leads for that reason. Everything under it is a quantity of shooting, and a book that opens
     * with "most hits" tells a reader what the numbers are before telling them what happened; this
     * opens with the hardest single thing the archive has ever recorded somebody doing, which is the
     * question a record book is for.
     *
     * Read as "the rarest title ever HANDED OUT", which is not quite the rarest deed ever done, and
     * the difference is the draw: the five story honors are allocated in list order, and everything
     * below them is drawn at random from what each player genuinely earned (see buildAwards). So a
     * player who earned three pooled titles holds one of them and the other two are not in the
     * archive at all. Nothing can be done about that from here - only what was awarded was ever
     * written down - and it costs less than it looks like it does, because the rare end of the list
     * is exactly the end that isn't drawn.
     *
     * Unlike every other record in the book this one has a ceiling: #1 is Shaker's Protégé, and the
     * night somebody takes it the record is finished, because a tie goes to whoever got there first.
     * That is deliberate and it is the point - the ceiling is a perfect game, not an artefact of how
     * the number is worked out, and until it falls every rung below it is genuinely beatable.
     */
    {
      id: "honor",
      emoji: "🏅",
      label: "Rarest honor",
      note: "#1 is the hardest title on the honors list",
      ...rank(
        rows.flatMap((r) => {
          const honor = rarestHonor(r.awards);
          if (!honor) return [];
          const c = fromRow(r, honor.rank);
          c.display = honor.title;
          c.detail = `#${HONOR_ORDER.length - honor.rank + 1} of ${HONOR_ORDER.length}`;
          return [c];
        }),
        (c) => ({ display: c.display ?? "", detail: c.detail })
      ),
    },
    /**
     * The two win records, directly under the honor and above everything that counts shooting.
     *
     * Same reasoning that puts the honor first: these say what HAPPENED, and the entries below them
     * say how much shooting there was. A run of wins is also the only record here a reader can be in
     * the middle of - which is what the second one is for.
     */
    {
      id: "win-streak",
      emoji: "👑",
      label: "Longest win streak",
      note: `${MIN_WIN_STREAK} or more wins, back to back`,
      ...rank(wins.longest, (c) => ({ display: `${c.value} in a row` })),
    },
    {
      id: "active-win-streak",
      emoji: "🔥",
      label: "Longest active streak",
      note: "still unbeaten - one loss and it's gone",
      ...rank(wins.active, (c) => ({ display: `${c.value} and counting` })),
    },
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
      note: "measured from the moment firing opened - auto-marked squares only, since 9/20",
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
      note: "auto-marked squares only, since 9/20",
      ...rank(
        earliest(shots, (s) => s.result === "sunk"),
        (c) => ({ display: clock(c.value) }),
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
