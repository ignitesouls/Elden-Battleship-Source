import { bossFrequency, fastestKills, type MatchEventRow } from "./almanac";
import { squareWeights, rateBattles, type BattleRating } from "./battleRating";
import type { ParticipantRow } from "./careerStats";
import { challengesForRoom, rowSquareSet, squareSetVariants, type SquareSetId } from "./challenges";
import { canonicalSquareName } from "./squareSetFormat";

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
  const timed = fastestKills(
    events.filter((e) => rowSquareSet(e) === set),
    Number.POSITIVE_INFINITY
  ).sort((a, b) => a.seconds - b.seconds || a.finishedAt.localeCompare(b.finishedAt));
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
    const mid = Math.floor(kills.length / 2);
    const median = kills.length % 2 === 1 ? kills[mid].seconds : (kills[mid - 1].seconds + kills[mid].seconds) / 2;
    out[square] = { holders, top: kills.slice(0, SQUARE_TOP_DEPTH).map((k) => k.seconds), median, fights: kills.length };
  }
  return out;
}

type QuickKill = ReturnType<typeof fastestKills>[number];

/** rateBoard for every tab the archive holds a game on. What the Edge Function stores. */
export function rateEveryBoard(parts: ParticipantRow[], events: MatchEventRow[]): Map<SquareSetId, BoardRatings> {
  const sets = new Set<SquareSetId>([...parts.map(rowSquareSet), ...events.map(rowSquareSet)]);
  return new Map([...sets].map((set) => [set, rateBoard(parts, events, set)]));
}
