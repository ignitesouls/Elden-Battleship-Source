/**
 * Team power, and the betting-style line on a match between two teams.
 *
 * -- What a player's power is ---------------------------------------------------------------------
 *
 * Two readings of the archive, blended (the organisers chose "both" over either alone):
 *
 *   ELO     from results. Every two-fleet game moves its players' numbers: beat a stronger crew and you
 *           gain more than for beating a weaker one. It is the reading that answers "who wins", and it
 *           covers every kind of game, 1v1s included.
 *   BATTLE  the Hall of Fame battle rating (0-100), averaged over the player's rated games. It reads HOW
 *           a player plays - squares an hour, hard squares, sinks - so it separates two players with the
 *           same record, and it is the only reading a crew game gives each crew member separately.
 *
 * power = elo + BATTLE_WEIGHT x (battle - 50), on Elo's scale, so a gap in power IS a win probability
 * (400 points = 10 to 1). The battle average is shrunk towards 50 by a few phantom average games, so one
 * great night is not a great player; a player with no rated games simply has battle 50.
 *
 * The constants are not guesses: scripts/calibrate-team-power.ts replays the archive in order, predicts
 * every game from only the games before it, and picks the values that predicted best. It also prints how
 * much better than a coin flip that is - which is the number to quote before anyone takes a line too
 * seriously.
 *
 * -- What a team's power is ---------------------------------------------------------------------------
 *
 * The average of its players'. A player with no games at all is counted as average (START), not left
 * out - leaving them out would rate a team on its one veteran.
 *
 * Pure: no database, no React, no build-time environment - the browser, the checks, the calibration
 * script and the battle-ratings Edge Function all run this same file (scripts/build-rating-bundle.mjs
 * refuses to bundle anything browser-only).
 */

/** Where every player starts, and what an unknown player counts as. */
export const START = 1500;

export interface PowerParams {
  /** Elo's K: how far one game moves a rating. */
  k: number;
  /** Power points per battle-rating point above or below 50. */
  battleWeight: number;
  /** Phantom average (50) games mixed into each battle average. */
  battleShrink: number;
}

/**
 * Fitted by scripts/calibrate-team-power.ts - rerun it when the archive has grown, and update these.
 *
 * Fitted 9 Oct 2026 on 165 games, graded on the 110 after them: the favourite won 67% of the time (71%
 * where both sides had history), a Brier score 17% better than a coin flip, and its 85-95% calls came in
 * at 85-93%. A wider search found settings that fitted the older games better and graded no better on the
 * newer ones - at this sample size the differences between nearby settings are noise, so these stay.
 * The archive is mostly casual games; official crew matches may behave differently, so refit once a few
 * events have been played.
 */
export const POWER_PARAMS: PowerParams = { k: 48, battleWeight: 12, battleShrink: 1 };

/** One finished game as the rating reads it: who played, on which fleet, and how it ended. */
export interface PowerGame {
  matchKey: string;
  finishedAt: string;
  players: Array<{ key: string; team: number; won: boolean; draw: boolean }>;
}

export interface EloEntry {
  elo: number;
  games: number;
}

/** Elo's expected score for a side rated `a` against one rated `b`. */
export function expected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

/**
 * The two fleets of a game, if it is a game Elo can read: exactly two fleets, each with a player, and an
 * outcome (a winner, or a draw).
 */
function sides(game: PowerGame) {
  const teams = [...new Set(game.players.map((p) => p.team))];
  if (teams.length !== 2) return null;
  const [x, y] = teams.map((t) => game.players.filter((p) => p.team === t));
  const draw = game.players.some((p) => p.draw);
  const xWon = x.some((p) => p.won);
  const yWon = y.some((p) => p.won);
  if (!draw && xWon === yWon) return null; // no result, or a result that says both won
  return { x, y, scoreX: draw ? 0.5 : xWon ? 1 : 0 };
}

/**
 * Plays the archive forward, oldest game first, and returns everyone's Elo after the last one.
 *
 * Each crew is rated as the average of its players, and every player on it moves by the crew's change -
 * a crew wins or loses together. `before` is called with the table as it stands BEFORE each game it
 * rates, which is what the calibration script grades: a prediction made with the answer already in it
 * would flatter the model. (Read it there and then - it is the live table, updated straight after.)
 */
export function replayElo(
  games: PowerGame[],
  k: number,
  before?: (game: PowerGame, table: ReadonlyMap<string, EloEntry>) => void,
): Map<string, EloEntry> {
  const table = new Map<string, EloEntry>();
  const ordered = [...games].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.matchKey.localeCompare(b.matchKey));
  for (const game of ordered) {
    const s = sides(game);
    if (!s) continue;
    const rate = (crew: typeof s.x) => crew.reduce((sum, p) => sum + (table.get(p.key)?.elo ?? START), 0) / crew.length;
    const ex = rate(s.x);
    const ey = rate(s.y);
    before?.(game, table);
    const delta = k * (s.scoreX - expected(ex, ey));
    for (const [crew, change] of [[s.x, delta], [s.y, -delta]] as const) {
      for (const p of crew) {
        const e = table.get(p.key) ?? { elo: START, games: 0 };
        table.set(p.key, { elo: e.elo + change, games: e.games + 1 });
      }
    }
  }
  return table;
}

/** A battle-rating average, shrunk towards 50 by `shrink` phantom average games. */
export function shrunkBattle(sum: number, count: number, shrink: number): number {
  return (sum + 50 * shrink) / (count + shrink);
}

export interface PlayerPower {
  power: number;
  elo: number;
  /** Games behind the Elo. 0 means unknown: the player counts as average. */
  games: number;
  /** The shrunk battle average, or null with no rated games. */
  battle: number | null;
}

/** One player's power from their Elo entry and their battle ratings (0-100 each). */
export function playerPower(elo: EloEntry | undefined, battles: number[], params: PowerParams = POWER_PARAMS): PlayerPower {
  const battle = battles.length > 0 ? shrunkBattle(battles.reduce((s, b) => s + b, 0), battles.length, params.battleShrink) : null;
  const e = elo?.elo ?? START;
  return { power: e + params.battleWeight * ((battle ?? 50) - 50), elo: e, games: elo?.games ?? 0, battle };
}

/** A team's power: the average of its players', anyone unknown counting as START. Null for an empty roster. */
export function teamPower(players: Array<PlayerPower | undefined>): number | null {
  if (players.length === 0) return null;
  return players.reduce((s, p) => s + (p?.power ?? START), 0) / players.length;
}

/** How many of a team's players the line actually knows anything about. */
export function ratedCount(players: Array<PlayerPower | undefined>): number {
  return players.filter((p) => p && (p.games > 0 || p.battle !== null)).length;
}

// ===========================================================================
//  The line
// ===========================================================================

/** The chance that side A wins ONE game against side B, from their powers. */
export function gameWinProbability(powerA: number, powerB: number): number {
  return expected(powerA, powerB);
}

/** P(exactly `w` wins before the other side reaches `need`), summed - the chance of taking a best-of-n. */
export function seriesWinProbability(p: number, bestOf: number): number {
  const need = Math.floor(bestOf / 2) + 1;
  let total = 0;
  // A wins the series when it reaches `need` wins after the other side has won `j` < need games.
  for (let j = 0; j < need; j++) total += binom(need - 1 + j, j) * Math.pow(p, need) * Math.pow(1 - p, j);
  return total;
}

function binom(n: number, r: number): number {
  let out = 1;
  for (let i = 1; i <= r; i++) out = (out * (n - r + i)) / i;
  return out;
}

/**
 * American odds for a probability: -150 means "stake 150 to win 100" (a favourite), +130 "stake 100 to
 * win 130" (an underdog). No bookmaker's margin - these are fair odds, and a 50/50 is EVEN. Rounded to
 * the nearest 5, the way a board shows them, and capped so a mismatch reads -5000 rather than -48213.
 */
export function moneyline(p: number): string {
  const q = Math.min(0.98, Math.max(0.02, p));
  if (Math.abs(q - 0.5) < 0.0125) return "EVEN";
  const raw = q > 0.5 ? (-100 * q) / (1 - q) : (100 * (1 - q)) / q;
  const r = Math.round(raw / 5) * 5;
  return r > 0 ? `+${r}` : String(r);
}

/**
 * The chance the side with per-game chance `p` wins a best-of-n by MORE than `margin` games - that is,
 * covers a handicap of -margin. Every way the series can end, weighed.
 */
function coverProbability(p: number, bestOf: number, margin: number): number {
  const need = Math.floor(bestOf / 2) + 1;
  let total = 0;
  for (let j = 0; j < need; j++) {
    if (need - j > margin) total += binom(need - 1 + j, j) * Math.pow(p, need) * Math.pow(1 - p, j);
  }
  return total;
}

export interface Handicap {
  /** Which side is giving the games. */
  favourite: "a" | "b";
  /** Games, always a half so it can't tie: 1.5 means "must win by 2". */
  games: number;
  /** The favourite's chance of covering it. */
  cover: number;
}

/**
 * The series handicap - "Krakens -1.5" - for a best-of-3 or longer: the favourite gives the half-game
 * line whose chance of being covered is closest to even, which is how a book picks its spread. A
 * single game has no spread worth showing (the moneyline already says everything), so it returns null.
 */
export function handicap(pA: number, bestOf: number): Handicap | null {
  if (bestOf < 3) return null;
  const favourite = pA >= 0.5 ? "a" : "b";
  const p = favourite === "a" ? pA : 1 - pA;
  const need = Math.floor(bestOf / 2) + 1;
  let best: Handicap | null = null;
  for (let games = 1.5; games < need; games += 1) {
    const cover = coverProbability(p, bestOf, games);
    if (!best || Math.abs(cover - 0.5) < Math.abs(best.cover - 0.5)) best = { favourite, games, cover };
  }
  return best;
}

export interface MatchLine {
  /** A's chance of winning the match (the whole series). */
  pA: number;
  /** Moneylines, A's and B's. */
  a: string;
  b: string;
  handicap: Handicap | null;
}

/** Everything a match card shows, from the two teams' powers and the series length. */
export function matchLine(powerA: number, powerB: number, bestOf: number): MatchLine {
  const game = gameWinProbability(powerA, powerB);
  const pA = seriesWinProbability(game, Math.max(1, bestOf));
  return { pA, a: moneyline(pA), b: moneyline(1 - pA), handicap: handicap(game, bestOf) };
}
