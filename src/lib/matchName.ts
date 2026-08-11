import { formatRoomCode } from "./roomCode";
import type { Award, PlayerStats } from "./matchReport";

/**
 * What a finished match gets called.
 *
 * The match history was a list of room codes and dates, which is a list of primary keys: nothing in a
 * row told you whether it was worth opening, and the same room code appears a dozen times because the
 * same room gets replayed all evening. A name fixes that for free - every fact one needs is already in
 * `match_reports`, which has been written at the end of every match since the record books existed.
 *
 * Two rules, both borrowed from the honors:
 *
 *   - A name has to be EARNED. Every rule below tests something the log actually says, so "The
 *     Slaughter" really was a rout and "The Waking" really did have four tentacles found in it. None
 *     of it is random, so a match is called the same thing forever and by everybody.
 *   - Rules are ordered by how much they say, and the first one that fits wins. A match where somebody
 *     woke Cthulhu is about that, whatever the shooting looked like.
 *
 * The fallback at the end is the only rule that can't fail, and it names a match after its size -
 * still a fact about it, just the dullest one available.
 *
 * The thresholds are tuned against the record books rather than guessed, because guessing them
 * produced an archive where seventeen matches shared four names and nine of them were slogs. The
 * rules were written for a game nobody turned out to play: "a long match" meant twenty-five
 * minutes when every real one runs past seventy, "a slog" meant ninety total shots when six
 * players fire that many as a matter of course, and a clean sweep needed the losing fleet to sink
 * nothing at all, which has never once happened. Three rules were therefore unreachable and two
 * were nearly unconditional.
 *
 * So the rules below read the things that actually differ between one night and the next - how
 * much better one fleet shot than the other, how fast the firing came, whether anybody could find
 * anything at all - and the ones that read the clock read it at the scale the clock really moves.
 * Anything measured per match (total shots, total time) says more about how many people showed up
 * than about the match, so those are divided through by the roster or the clock before being
 * tested against.
 */

export interface MatchNameInput {
  roomCode: string;
  /** Null for a draw - every fleet went down. */
  winnerTeam: number | null;
  /** "MM:SS" or "H:MM:SS", as archived. */
  duration: string | null;
  totalShots: number;
  stats: PlayerStats[];
  awards: Award[];
}

/** Seconds from an archived duration string, or null if it wasn't recorded. */
export function durationSeconds(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const parts = duration.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

interface Shape {
  players: number;
  /** Hulls the winning fleet put down. */
  sunkByWinner: number;
  /** Hulls the winner LOST, which is to say the hulls everybody else managed to sink. */
  sunkByLosers: number;
  /** How many hulls the win came by. */
  margin: number;
  /** Every hull that went down, both fleets - how bloody the water got, whoever won. */
  totalSunk: number;
  /**
   * The sharpest shooting anybody did, or null when nobody fired enough for the number to mean
   * anything. Null rather than zero: "nobody could shoot" and "nobody shot" are different matches.
   */
  bestAccuracy: number | null;
  /**
   * The winning fleet's accuracy minus the losing fleet's, pooled across each side - the clearest
   * thing separating one match from another, and the thing no rule used to read. A fleet that won
   * by shooting straighter had a different night from one that won by firing more.
   */
  accuracyGap: number;
  /** Shots per player, so a full lobby doesn't read as a grind purely for being full. */
  shotsPerPlayer: number;
  /** Shots per minute of match - pace, which is the difference between a brawl and a stalking. */
  shotsPerMinute: number | null;
  seconds: number | null;
  totalShots: number;
  titles: Set<string>;
  draw: boolean;
}

function shapeOf(m: MatchNameInput): Shape {
  const winners = m.stats.filter((s) => s.team === m.winnerTeam);
  const losers = m.stats.filter((s) => s.team !== m.winnerTeam);
  const sum = (rows: PlayerStats[], pick: (s: PlayerStats) => number) => rows.reduce((n, s) => n + pick(s), 0);

  // Pooled - total hits over total shots, never an average of per-player rates, which would let a
  // crewmate's single lucky shot weigh as much as the gunner who fired thirty.
  const fleetAccuracy = (rows: PlayerStats[]) => {
    const shots = sum(rows, (s) => s.shots);
    return shots > 0 ? sum(rows, (s) => s.hits) / shots : 0;
  };

  const sunkByWinner = sum(winners, (s) => s.sunk);
  const sunkByLosers = sum(losers, (s) => s.sunk);
  const seconds = durationSeconds(m.duration);
  // Eight shots, because a name shouldn't hang on somebody's two lucky hits.
  const eligible = m.stats.filter((s) => s.shots >= 8).map((s) => s.accuracy);

  return {
    players: m.stats.length,
    sunkByWinner,
    sunkByLosers,
    margin: sunkByWinner - sunkByLosers,
    totalSunk: sunkByWinner + sunkByLosers,
    bestAccuracy: eligible.length > 0 ? Math.max(...eligible) : null,
    accuracyGap: fleetAccuracy(winners) - fleetAccuracy(losers),
    shotsPerPlayer: m.stats.length > 0 ? m.totalShots / m.stats.length : 0,
    shotsPerMinute: seconds !== null && seconds > 0 ? m.totalShots / (seconds / 60) : null,
    seconds,
    totalShots: m.totalShots,
    titles: new Set(m.awards.map((a) => a.title)),
    draw: m.winnerTeam === null,
  };
}

/** Ordered by how much the name says. First fit wins; the last one always fits. */
const RULES: Array<{ epithet: (s: Shape) => string; when: (s: Shape) => boolean }> = [
  // -- deeds so rare the rest of the night is a footnote ---------------------

  // A whole enemy fleet put down by one gunner, every killing blow theirs. The hardest thing in the
  // honors to get, so it outranks anything the scoreboard could say.
  { when: (s) => s.titles.has("Shaker's Protégé"), epithet: () => "The Lone Gun" },
  // Somebody found all four tentacles. Nothing else that happened that night matters.
  {
    when: (s) => s.titles.has("Woke the Sleeper") || s.titles.has("High Priest of R'lyeh"),
    epithet: () => "The Waking",
  },
  { when: (s) => s.titles.has("Captain Ahab"), epithet: () => "The Whale Hunt" },
  { when: (s) => s.draw, epithet: () => "Mutual Destruction" },

  // -- how the thing was decided --------------------------------------------

  // The winning fleet came home whole.
  { when: (s) => s.sunkByWinner > 0 && s.sunkByLosers === 0, epithet: () => "The Clean Sweep" },
  { when: (s) => s.margin >= 4, epithet: () => "The Slaughter" },
  // Decided by one hull, but only after both fleets had been taken apart - which is a different
  // match from a close one that stayed cheap, and the archive holds plenty of both.
  { when: (s) => s.margin <= 1 && s.totalSunk >= 9, epithet: () => "The Mauling" },
  { when: (s) => s.sunkByWinner > 0 && s.margin <= 1, epithet: () => "The Knife Fight" },

  // -- the clock ------------------------------------------------------------

  // Short AND frantic. Twenty minutes is the short end of the real distribution, not the five that
  // no match has ever come in under.
  {
    when: (s) => s.seconds !== null && s.seconds <= 1200 && (s.shotsPerMinute ?? 0) >= 1.8,
    epithet: () => "The Squall",
  },
  { when: (s) => s.seconds !== null && s.seconds <= 1200, epithet: () => "The Ambush" },
  // An hour-plus of near silence: the fleets spent the night not finding each other.
  {
    when: (s) => s.seconds !== null && s.seconds >= 2400 && (s.shotsPerMinute ?? 1) <= 0.45,
    epithet: () => "The Doldrums",
  },

  // -- who could actually shoot ---------------------------------------------

  // One fleet was simply better with the guns. The gap runs from a hundredth to a third across the
  // record books, so it separates matches that every other rule reads as identical.
  { when: (s) => s.accuracyGap >= 0.25, epithet: () => "The Gunnery Lesson" },
  { when: (s) => s.accuracyGap >= 0.15, epithet: () => "The Weather Gauge" },
  { when: (s) => s.bestAccuracy !== null && s.bestAccuracy >= 0.6, epithet: () => "The Turkey Shoot" },
  // The sharpest eye on the water still missed two shots in three.
  { when: (s) => s.bestAccuracy !== null && s.bestAccuracy < 0.36, epithet: () => "The Blind Watch" },

  // -- pace and volume ------------------------------------------------------

  { when: (s) => (s.shotsPerMinute ?? 0) >= 1.3, epithet: () => "The Powder Storm" },
  // Named with its own number, because "a long one" is not as good as knowing it took 94 shots.
  // Tested per player: ninety shots between six crews is an evening, between two it is a grind.
  { when: (s) => s.shotsPerPlayer >= 18, epithet: (s) => `The ${s.totalShots}-Shot Slog` },
  { when: (s) => s.seconds !== null && s.seconds >= 5400, epithet: () => "The Long Hunt" },
  // Neither fleet had much left afloat by the end, whatever the margin says.
  { when: (s) => s.totalSunk >= 8, epithet: () => "The War of Attrition" },

  // Nothing remarkable happened, so it is named after its size.
  {
    when: () => true,
    epithet: (s) => (s.players <= 2 ? "The Duel" : s.players <= 4 ? "The Skirmish" : "The Melee"),
  },
];

/** Just the epithet - "The Slaughter", "The 47-Shot Slog". */
export function matchEpithet(m: MatchNameInput): string {
  const shape = shapeOf(m);
  return (RULES.find((r) => r.when(shape)) ?? RULES[RULES.length - 1]).epithet(shape);
}

/** The full name: "The Slaughter at SALTY-KRAKEN". */
export function matchName(m: MatchNameInput): string {
  return `${matchEpithet(m)} at ${formatRoomCode(m.roomCode)}`;
}
