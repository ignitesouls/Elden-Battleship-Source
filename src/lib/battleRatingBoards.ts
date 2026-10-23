import { bossFrequency, fastestKills, type MatchEventRow } from "./almanac";
import { squareWeights, rateBattles, type BattleRating } from "./battleRating";
import type { ParticipantRow } from "./careerStats";
import { challengesForRoom, rowSquareSet, squareSetVariants, type SquareSetId } from "./challenges";
import { canonicalSquareName } from "./squareSetFormat";
import { archivedShots, TEMPO_MILESTONES } from "./recordBook";

/**
 * Battle ratings for a whole board, from the raw archive rows - the part the browser and the
 * battle-ratings Edge Function have to do identically.
 *
 * -- Why this is its own module -------------------------------------------------------------------
 *
 * A recap used to rate its match by downloading the entire shot log, about forty requests a page, so
 * the function now does it once per archive change and every recap reads the stored answer. That only
 * works if the stored answer is the one the Hall of Fame would give, so the server does not get a copy
 * of this code: scripts/build-rating-bundle.mjs bundles THIS file for it, and `npm run check` fails if
 * the bundle is stale. Nothing here may import the Supabase client, React or anything that reads
 * `import.meta.env` - it has to run under Deno as well.
 *
 * The prepare* functions are the second half of that promise. They are what profiles.ts does to the
 * rows between the database and the stats, so the server applies exactly the same folds.
 */

/** The room, seed and balancer permutation one match's squares were dealt from. */
export interface BoardSource {
  match_key: string;
  room_id: string | null;
  board_seed: string | null;
  board_perm: number[] | null;
  /** When the board was dealt. Optional so a source read before the column existed still fits. */
  board_dealt_at?: string | null;
}

/**
 * Shot rows as the stats read them: square renames folded, and each match's board source put back.
 *
 * Rows archived before a square was renamed still carry its old name, hence the fold - see
 * canonicalSquareName. The board source is attached per row because the row is where every consumer
 * looks for it; all ~120 rows of a match share ONE perm array by reference, so holding it is free.
 * Voided matches must already be gone - each caller drops them its own way.
 */
export function prepareEvents<T extends { match_key: string; challenge_name?: string | null }>(
  rows: T[],
  sources: Map<string, BoardSource>
) {
  return rows.map((r) => {
    const source = sources.get(r.match_key);
    return {
      ...r,
      challenge_name: canonicalSquareName(r.challenge_name),
      room_id: source?.room_id ?? null,
      board_seed: source?.board_seed ?? null,
      board_perm: source?.board_perm ?? null,
      board_dealt_at: source?.board_dealt_at ?? null,
    };
  });
}

/** Participation rows as the stats read them. `awards` is jsonb and comes back null on old rows. */
export function prepareParticipants(rows: ParticipantRow[]): ParticipantRow[] {
  return rows.map((r) => ({ ...r, awards: Array.isArray(r.awards) ? r.awards : [] }));
}

/**
 * How bossFrequency rebuilds an archived match's full board, for one tab's worth of matches.
 *
 * A tab can hold more than one stored set - the boss tab holds both cuts of the boss board - so each
 * candidate is tried and the one that puts the logged names in the logged cells is the board. One that
 * cannot is the wrong board, and returning nothing makes bossFrequency count only the squares actually
 * shot rather than invent a denominator. Shared by the Almanac and the recap's scoreboard so the two
 * weigh squares identically.
 */
export function boardResolver(set: SquareSetId): Parameters<typeof bossFrequency>[1] {
  return (roomId, cells, fired, seed, perm, dealtAt) => {
    for (const setId of squareSetVariants(set)) {
      const board = challengesForRoom(roomId, cells, setId, seed, perm, dealtAt).map((c) => c.name);
      if (fired.slice(0, 3).every(({ cell, name }) => board[cell] === name)) return board;
    }
    return [];
  };
}

/** One tab's ratings, best first, and the square weights behind them. */
export interface BoardRatings {
  /** Square name -> weight. A square missing from it counts as 1, exactly as rateBattles reads it. */
  weights: Map<string, number>;
  ratings: BattleRating[];
}

/** Rates every game on one tab - what the Almanac's Hall of Fame shows for it. */
export function rateBoard(parts: ParticipantRow[], events: MatchEventRow[], set: SquareSetId): BoardRatings {
  const boardEvents = events.filter((e) => rowSquareSet(e) === set);
  const boardParts = parts.filter((p) => rowSquareSet(p) === set);
  const weights = squareWeights(boardEvents, bossFrequency(boardEvents, boardResolver(set)));
  return { weights, ratings: rateBattles(boardParts, boardEvents, weights) };
}

/** One place on a square's record board: the fight's length, and whose it was. */
export interface SquareRecord {
  key: string;
  nickname: string;
  seconds: number;
  matchKey: string;
  finishedAt: string;
}

/** Holders kept per square: the record, and the two names chasing it. */
export const SQUARE_RECORD_DEPTH = 3;
/** Fastest fights kept per square, anybody's, for "3rd fastest all time". Past this, no rank is said. */
export const SQUARE_TOP_DEPTH = 10;

/**
 * WHEN a square falls, in match time - "how early", where the rest of SquareBoard is "how fast".
 *
 * Counted over every kill the mod fired, opening shots included: an opener has no fight to time, but
 * the moment it landed is exactly what this asks about. Manual clicks are left out, as they are from
 * every record - a click lands whenever the player got round to it, not when the boss fell.
 */
export interface SquareClock {
  /** The earliest it has ever fallen. `seconds` is match time here, not a fight's length. */
  earliest: SquareRecord;
  /** The middle match time it falls at - when it usually goes. */
  median: number;
  /** Every auto-fired kill of it. */
  kills: number;
}

/** One square's standing times, as the caster desk reads them. */
export interface SquareBoard {
  /** The record and its chasers, one place per player, fastest first. */
  holders: SquareRecord[];
  /** The fastest fights ever on it, in seconds, whoever had them - repeats by one player included. */
  top: number[];
  /** The middle fight, in seconds - the house "typical", as squarePace reads a captain's. */
  median: number;
  /** Every timed fight on it. */
  fights: number;
  /** When it falls in a match. Absent on a snapshot made before this was kept. */
  at?: SquareClock;
}

/** How soon into a match captains reach one kill count. */
export interface KillTempo {
  /** The earliest anyone has reached it. `seconds` is match time. */
  earliest: SquareRecord;
  /** The middle time it is reached at. */
  median: number;
  /** Matches in which a captain reached it. */
  runs: number;
}

type ClockedShot = { key: string; nickname: string; seconds: number; matchKey: string; finishedAt: string };

const middle = (sorted: number[]) => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Earliest first; a tie goes to whoever got there first, as everywhere in the record book. */
const byClock = (a: ClockedShot, b: ClockedShot) => a.seconds - b.seconds || a.finishedAt.localeCompare(b.finishedAt);

const asRecord = (s: ClockedShot): SquareRecord => ({
  key: s.key,
  nickname: s.nickname,
  seconds: s.seconds,
  matchKey: s.matchKey,
  finishedAt: s.finishedAt,
});

/**
 * How soon into a match captains reach each of TEMPO_MILESTONES kills, on one tab.
 *
 * A captain's Nth kill is their Nth shot of the match - every shot is a square taken, under the
 * fire-on-kill rule. It counts only when that Nth shot was auto-fired, for the reason SquareClock gives.
 */
export function killTempo(events: MatchEventRow[], set: SquareSetId): Record<string, KillTempo> {
  const runs = new Map<string, ClockedShot[]>();
  const autos = new Map<string, boolean[]>();
  // archivedShots orders by match, then by time - the order kills are counted in.
  for (const shot of archivedShots(events.filter((e) => rowSquareSet(e) === set))) {
    const run = `${shot.matchKey}|${shot.key}`;
    const list = runs.get(run) ?? [];
    list.push(shot);
    runs.set(run, list);
    const auto = autos.get(run) ?? [];
    auto.push(shot.auto);
    autos.set(run, auto);
  }
  const out: Record<string, KillTempo> = {};
  for (const n of TEMPO_MILESTONES) {
    const reached: ClockedShot[] = [];
    for (const [run, shots] of runs) if (shots.length >= n && autos.get(run)![n - 1]) reached.push(shots[n - 1]);
    if (reached.length === 0) continue;
    reached.sort(byClock);
    out[String(n)] = { earliest: asRecord(reached[0]), median: middle(reached.map((s) => s.seconds)), runs: reached.length };
  }
  return out;
}

/**
 * Every square's standing times on one tab, for the caster desk's talking points.
 *
 * Timed by fastestKills, so a square's record is exactly what the Almanac's record board would say
 * about it - same fire-on-kill gap, same auto-only rule, same duo-fight floor. Ties go to whoever got
 * there first, as everywhere in the record book, and each player holds at most one place among the
 * holders: a runner-up list that is the holder again twice is not something to chase. `top` is the
 * other question - "how fast is this kill, all time" - and counts every fight, whoever had it.
 *
 * Built here rather than on the desk because it is a scan of the whole shot log - the biggest read on
 * the site - and the Edge Function already has that log in hand every time it rates.
 */
export function squareRecords(events: MatchEventRow[], set: SquareSetId): Record<string, SquareBoard> {
  const bySquare = new Map<string, QuickKill[]>();
  const onBoard = events.filter((e) => rowSquareSet(e) === set);
  const timed = fastestKills(onBoard, Number.POSITIVE_INFINITY).sort(
    (a, b) => a.seconds - b.seconds || a.finishedAt.localeCompare(b.finishedAt)
  );
  for (const k of timed) {
    if (!k.challenge) continue;
    const list = bySquare.get(k.challenge);
    if (list) list.push(k);
    else bySquare.set(k.challenge, [k]);
  }

  const out: Record<string, SquareBoard> = {};
  for (const [square, kills] of bySquare) {
    const holders: SquareRecord[] = [];
    for (const k of kills) {
      if (holders.length >= SQUARE_RECORD_DEPTH) break;
      if (holders.some((r) => r.key === k.key)) continue;
      holders.push({ key: k.key, nickname: k.nickname, seconds: k.seconds, matchKey: k.matchKey, finishedAt: k.finishedAt });
    }
    // Already fastest first, so the middle one is the median.
    out[square] = {
      holders,
      top: kills.slice(0, SQUARE_TOP_DEPTH).map((k) => k.seconds),
      median: middle(kills.map((k) => k.seconds)),
      fights: kills.length,
    };
  }

  // When each square falls - every auto-fired kill, so a square only ever taken as an opener (no fight
  // to time) still gets an entry, with no holders and no fights.
  const clocked = new Map<string, ClockedShot[]>();
  for (const shot of archivedShots(onBoard)) {
    if (!shot.challenge || !shot.auto) continue;
    const list = clocked.get(shot.challenge) ?? [];
    list.push(shot);
    clocked.set(shot.challenge, list);
  }
  for (const [square, shots] of clocked) {
    shots.sort(byClock);
    const at: SquareClock = { earliest: asRecord(shots[0]), median: middle(shots.map((s) => s.seconds).sort((a, b) => a - b)), kills: shots.length };
    out[square] = { ...(out[square] ?? { holders: [], top: [], median: 0, fights: 0 }), at };
  }
  return out;
}

type QuickKill = ReturnType<typeof fastestKills>[number];

/** rateBoard for every tab the archive holds a game on. What the Edge Function stores. */
export function rateEveryBoard(parts: ParticipantRow[], events: MatchEventRow[]): Map<SquareSetId, BoardRatings> {
  const sets = new Set<SquareSetId>([...parts.map(rowSquareSet), ...events.map(rowSquareSet)]);
  return new Map([...sets].map((set) => [set, rateBoard(parts, events, set)]));
}
