import { participantKey, type ParticipantRow } from "./careerStats";
import { archivedShots } from "./recordBook";
import { fastestKills, type BossFrequency, type MatchEventRow } from "./almanac";

/**
 * Battle ratings: one number, 0-100, for one captain's game.
 *
 * The record book answers "what is the most anybody has done of X". This answers "whose game was the
 * best game", which needs every stat at once - and needs it without punishing the captain whose job
 * that night was the hard squares.
 *
 * -- The two roles a crew splits into --------------------------------------------------------------
 *
 * An early-game captain is a crew's offense: a run of quick, close squares, lots of shots. A DLC
 * captain is its specialist - fewer squares, but the long fights and the far-flung ones nobody else
 * on the crew could take in time. Counting raw squares rates the first and buries the second, and
 * the second is often the one who won the match.
 *
 * So the heaviest component is WEIGHTED squares: each square a captain took counts for how long its
 * fight usually runs and how rarely it gets taken at all, compared with the board's typical square.
 * Five DLC squares at 2.2 each out-work twelve early ones at 0.8, which is the comparison the rating
 * has to get right.
 *
 * Misses count as fully as hits. Under fire-on-kill a miss is a boss beaten all the same - whether a
 * ship was under the square is the other crew's doing. It is the only component here that credits the
 * fight rather than where the shot landed, which is why it carries half the rating.
 *
 * -- Why per hour ------------------------------------------------------------------------------------
 *
 * Every captain plays their own run, so squares are not shared out between crewmates the way hits on
 * one board would be: a 3v3 captain and a 1v1 captain clear squares at the same rate. What does vary is
 * the match length, and per hour is what takes it out - a four-hour match is not a better game for
 * having more squares in it.
 *
 * -- Why percentiles ----------------------------------------------------------------------------------
 *
 * Each component is ranked against every rated game on the same board and the ranks are blended,
 * rather than adding up raw numbers under hand-tuned multipliers. It calibrates itself as the archive
 * grows, and it means "3 ships sunk" and "40 weighted squares an hour" can sit in one sum without one
 * of them deciding everything by being the bigger number.
 *
 * -- What it is built from ----------------------------------------------------------------------------
 *
 * The same public archive the rest of the Almanac reads. Deliberately NOT bossTimeCost.json - that is
 * the balancer's cost model and must never reach a browser (see lib/balanceStats). Square weights only
 * ever feed the number; nothing on the site lists them.
 */

/** How much of the rating each component carries. Sums to 1. */
export const RATING_WEIGHTS = {
  workload: 0.5,
  sunk: 0.2,
  hits: 0.15,
  win: 0.1,
  accuracy: 0.05,
} as const;

/**
 * How many observations a square needs before its own numbers outweigh the board's.
 *
 * A square fought twice has a median made of two fights, and one of them could be a captain who went
 * to make tea. Each square's figures are pulled towards the board-wide figure as if it had this many
 * extra typical observations, so a thin sample moves the weight a little rather than all the way.
 * The same pull is applied to accuracy, so a two-shot game cannot read as a perfect one.
 */
export const SHRINK = 5;

/** A square's weight is held to this band, so one outlier boss cannot decide every game it is in. */
export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 3;

/** Rarity alone moves a weight by at most this much in either direction. */
const RARITY_MIN = 0.67;
const RARITY_MAX = 1.5;

/**
 * The shortest match the per-hour rate is worked out over.
 *
 * A match that ended four minutes in would otherwise turn one square into fifteen an hour. Ten minutes
 * is shorter than any real match and long enough that nobody gets a rate they did not earn.
 */
export const MIN_MATCH_SECONDS = 600;

/**
 * Average square weight at which a captain reads as the specialist, or the offense.
 *
 * Only a tag on the Hall of Fame line - it changes nothing about the number. Needs a few squares,
 * since one heavy square is a square, not a role.
 */
export const SPECIALIST_AT = 1.25;
export const OFFENSE_AT = 0.85;
const MIN_SQUARES_FOR_ROLE = 3;

export type BattleRole = "specialist" | "offense";

export interface BattleRating {
  key: string;
  nickname: string;
  userId: string | null;
  matchKey: string;
  roomCode: string | null;
  finishedAt: string;
  team: number;
  /** 0-100. */
  rating: number;
  /** Squares taken, hit or miss. */
  squares: number;
  /** Those squares, each counted at its weight. */
  workload: number;
  /** `workload` per hour of match. */
  perHour: number;
  /** workload / squares - what the role tag reads. */
  avgWeight: number;
  shots: number;
  hits: number;
  sunk: number;
  /** Raw hits / shots, for display. The rating reads a shrunk version - see SHRINK. */
  accuracy: number;
  won: boolean;
  draw: boolean;
  role: BattleRole | null;
  /** Best-rated captain in this match, when it had two or more rated. */
  mvp: boolean;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * What each square is worth, by name. A square missing from the map is worth 1, a typical square.
 *
 * Two readings, multiplied:
 *
 *   - LENGTH: the square's median fight - the gap back to that captain's previous square, auto-fired
 *     at both ends, the same timing the Almanac's quickest-squares board uses - over the board's.
 *   - RARITY: how often the square is taken when it is dealt, against the board's average. A square
 *     that is usually left standing is usually left standing for a reason.
 *
 * Both are shrunk towards the board figure (see SHRINK), so a square seen twice gets a cautious weight
 * rather than a wild one, and a square never timed at all is weighted on rarity alone.
 *
 * @param events one board's shot log.
 * @param freq that board's bossFrequency - every square dealt, shot at or not.
 */
export function squareWeights(events: MatchEventRow[], freq: BossFrequency[]): Map<string, number> {
  const gaps = new Map<string, number[]>();
  const all: number[] = [];
  for (const k of fastestKills(events, Number.POSITIVE_INFINITY)) {
    if (!k.challenge) continue;
    const list = gaps.get(k.challenge);
    if (list) list.push(k.seconds);
    else gaps.set(k.challenge, [k.seconds]);
    all.push(k.seconds);
  }
  const boardFight = median(all);

  let appeared = 0;
  let fired = 0;
  const freqBy = new Map<string, BossFrequency>();
  for (const f of freq) {
    freqBy.set(f.name, f);
    appeared += f.appeared;
    fired += f.fired;
  }
  const boardRate = appeared > 0 ? fired / appeared : null;

  const weights = new Map<string, number>();
  for (const name of new Set([...gaps.keys(), ...freqBy.keys()])) {
    let length = 1;
    if (boardFight !== null && boardFight > 0) {
      const own = gaps.get(name) ?? [];
      const mid = median(own) ?? boardFight;
      length = (own.length * mid + SHRINK * boardFight) / (own.length + SHRINK) / boardFight;
    }

    let rarity = 1;
    const f = freqBy.get(name);
    if (f && boardRate !== null && boardRate > 0) {
      const rate = (f.fired + SHRINK * boardRate) / (f.appeared + SHRINK);
      rarity = clamp(boardRate / rate, RARITY_MIN, RARITY_MAX);
    }

    weights.set(name, clamp(length * rarity, WEIGHT_MIN, WEIGHT_MAX));
  }
  return weights;
}

/**
 * Whether a match is the kind of game the rating describes, from its captains per fleet.
 *
 *   - EXACTLY TWO FLEETS. With three or more, one shot lands on every opposing board at once, so
 *     hits and sinks come two and three at a time and the board is fought over three ways - those
 *     numbers are not the same currency as a two-fleet game's, and ranking them in one field put
 *     three-fleet captains at the top of the Hall of Fame for being in a bigger match.
 *   - NOT A 1V1. A duel has nobody to split the board with and no crew to be the best of.
 *
 * A match failing either is not rated at all and stays out of the field, so it cannot move anybody
 * else's number either. Careers, the leaderboard and the record book are unaffected - this is the
 * rating's rule, not a void.
 */
export function ratedMatch(crews: Map<number, number> | undefined): boolean {
  if (!crews || crews.size !== 2) return false;
  return [...crews.values()].some((n) => n >= 2);
}

/**
 * Where `value` sits in `sorted`, 0-1, with ties sharing the middle of their run.
 *
 * Mid-rank rather than "share below", because most games sink nothing: with share-below every
 * zero-sink game would score 0 on sinking and the first sink would look like a leap from the floor
 * to the middle, when really it is a step up from a crowd.
 */
function percentile(sorted: number[], value: number): number {
  if (sorted.length <= 1) return 0.5;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  const below = lo;
  hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  const equal = lo - below;
  return (below + equal / 2) / sorted.length;
}

/**
 * Rates every game on one board, best first. Ties go to the earlier game, as in the record book.
 *
 * Only games with a shot log can be rated: the weighted squares and the match length both come from
 * it. That is every game since the Almanac shipped; older rows simply sit outside the Hall of Fame.
 * Only two-fleet crew games are rated: no 1v1s, and nothing with three fleets or more - see ratedMatch.
 *
 * @param rows participation rows, one board's.
 * @param events the same board's shot log.
 * @param weights from squareWeights, for the same board.
 */
export function rateBattles(
  rows: ParticipantRow[],
  events: MatchEventRow[],
  weights: Map<string, number>
): BattleRating[] {
  const matchEnd = new Map<string, number>();
  const work = new Map<string, { squares: number; workload: number }>();
  for (const shot of archivedShots(events)) {
    matchEnd.set(shot.matchKey, Math.max(matchEnd.get(shot.matchKey) ?? 0, shot.seconds));
    const id = `${shot.matchKey}|${shot.key}`;
    const w = work.get(id) ?? { squares: 0, workload: 0 };
    w.squares++;
    w.workload += (shot.challenge ? weights.get(shot.challenge) : undefined) ?? 1;
    work.set(id, w);
  }

  // Crew sizes per match, for the solo rule below.
  const crews = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const teams = crews.get(row.match_key) ?? new Map<number, number>();
    teams.set(row.team, (teams.get(row.team) ?? 0) + 1);
    crews.set(row.match_key, teams);
  }

  const games = rows.flatMap((row) => {
    // Only two-fleet crew games are rated, and only they make up the field the rest are ranked
    // against - see ratedMatch.
    if (!ratedMatch(crews.get(row.match_key))) return [];
    const key = participantKey(row);
    const w = work.get(`${row.match_key}|${key}`);
    const end = matchEnd.get(row.match_key);
    if (!w || end === undefined || row.shots <= 0) return [];
    const hours = Math.max(end, MIN_MATCH_SECONDS) / 3600;
    return [{ row, key, ...w, perHour: w.workload / hours }];
  });
  if (games.length === 0) return [];

  const shotsAll = games.reduce((n, g) => n + g.row.shots, 0);
  const hitsAll = games.reduce((n, g) => n + g.row.hits, 0);
  const fieldAcc = shotsAll > 0 ? hitsAll / shotsAll : 0;
  const shrunkAcc = (g: (typeof games)[number]) => (g.row.hits + SHRINK * fieldAcc) / (g.row.shots + SHRINK);

  const sorted = (f: (g: (typeof games)[number]) => number) => games.map(f).sort((a, b) => a - b);
  const byWork = sorted((g) => g.perHour);
  const bySunk = sorted((g) => g.row.sunk);
  const byHits = sorted((g) => g.row.hits);
  const byAcc = sorted(shrunkAcc);

  const rated: BattleRating[] = games.map((g) => {
    const win = g.row.won ? 1 : g.row.draw ? 0.5 : 0;
    const score =
      RATING_WEIGHTS.workload * percentile(byWork, g.perHour) +
      RATING_WEIGHTS.sunk * percentile(bySunk, g.row.sunk) +
      RATING_WEIGHTS.hits * percentile(byHits, g.row.hits) +
      RATING_WEIGHTS.win * win +
      RATING_WEIGHTS.accuracy * percentile(byAcc, shrunkAcc(g));
    const avgWeight = g.workload / g.squares;
    const role: BattleRole | null =
      g.squares < MIN_SQUARES_FOR_ROLE
        ? null
        : avgWeight >= SPECIALIST_AT
          ? "specialist"
          : avgWeight <= OFFENSE_AT
            ? "offense"
            : null;
    return {
      key: g.key,
      nickname: g.row.nickname,
      userId: g.row.user_id,
      matchKey: g.row.match_key,
      roomCode: g.row.room_code,
      finishedAt: g.row.finished_at,
      team: g.row.team,
      rating: Math.round(score * 100),
      squares: g.squares,
      workload: g.workload,
      perHour: g.perHour,
      avgWeight,
      shots: g.row.shots,
      hits: g.row.hits,
      sunk: g.row.sunk,
      accuracy: g.row.shots > 0 ? g.row.hits / g.row.shots : 0,
      won: g.row.won,
      draw: g.row.draw,
      role,
      mvp: false,
    };
  });

  // Best first; a tie goes to the earlier game, and within one match to the heavier workload.
  rated.sort(
    (a, b) => b.rating - a.rating || a.finishedAt.localeCompare(b.finishedAt) || b.workload - a.workload
  );

  // The first of each match in that order is its MVP - but only where there was somebody to beat.
  const perMatch = new Map<string, number>();
  for (const r of rated) perMatch.set(r.matchKey, (perMatch.get(r.matchKey) ?? 0) + 1);
  const crowned = new Set<string>();
  for (const r of rated) {
    if (crowned.has(r.matchKey) || (perMatch.get(r.matchKey) ?? 0) < 2) continue;
    r.mvp = true;
    crowned.add(r.matchKey);
  }
  return rated;
}
