import { archivedShots, MIN_GAP_SECONDS } from "./recordBook";
import type { MatchEventRow } from "./almanac";

/**
 * How long a captain typically takes over one square.
 *
 * The house rule is that you fire the moment you kill, so a shot's timestamp IS the moment a square
 * fell and the gap between two of them is one square's work, start to finish. That makes pace the
 * only stat on the leaderboard about how somebody PLAYS rather than how well they shoot: hits,
 * accuracy and sunk are all about aim at the board, and two captains with identical aim can still be
 * an hour apart over a match.
 *
 * -- Why the median and not the average ------------------------------------------------------------
 *
 * Because the average measures the wrong thing here. A run is mostly steady kills with the
 * occasional twenty-minute wall - a boss somebody dies to repeatedly, a break, a disconnect - and one
 * of those drags an average far enough to swamp the hundred ordinary squares around it. On the
 * archive at the time of writing every captain's median sits between 2:18 and 2:58 while their means
 * spread from 2:43 to 4:14, and that spread is almost entirely a ranking of who had the worst single
 * evening, not who plays faster.
 *
 * The median answers "what is a normal square for this person", which is the question, and it is
 * unmoved by the tail. A tight spread across the field is not the stat failing - it is the honest
 * finding that a boss takes about two and a half minutes for most people, and that the differences
 * between them are small and real rather than large and accidental.
 */

/**
 * Gaps needed before a pace is shown at all.
 *
 * A median over two or three squares is not a pace, it is a mood - one hard boss in a three-square
 * sample moves it by minutes. Five is enough for the middle value to mean something while still
 * letting somebody's first evening count.
 */
export const MIN_GAPS_FOR_PACE = 5;

/** The middle value, averaging the two middles on an even count. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median seconds per square, per captain, keyed exactly as careers are.
 *
 * @param events archived shots, ALREADY filtered to one square set - a pace over boss kills and one
 * over "acquire 3 painting rewards" are not the same measurement, the same way accuracy isn't.
 *
 * Gaps shorter than MIN_GAP_SECONDS are dropped for the reason the gap record drops them: two
 * squares can fall at the same moment, either a duo fight filling both or somebody banking a kill
 * and firing it next to the following one. Neither is a fast square, and counting them would drag a
 * median toward zero for whoever met the most duos.
 *
 * Only gaps count, never a player's opening shot - the clock before that is the lobby, the placement
 * phase and whatever the room was doing, not their work on a square.
 *
 * As of 9/20, a gap also needs both ends auto-fired - same rule as almanac.timedSquares, and the same
 * reason: a manually-clicked square's timestamp is whenever the player got around to marking it, not
 * when it actually fell, so a gap with a manual end is timing a click and not a fight.
 */
export function squarePace(events: MatchEventRow[]): Map<string, number> {
  const gaps = new Map<string, number[]>();
  const previous = new Map<string, { seconds: number; auto: boolean }>();

  // archivedShots sorts by match, then by time, which is exactly the order a gap is measured in.
  for (const shot of archivedShots(events)) {
    const run = `${shot.matchKey}|${shot.key}`;
    const before = previous.get(run);
    previous.set(run, { seconds: shot.seconds, auto: shot.auto });
    if (before === undefined) continue;
    if (!before.auto || !shot.auto) continue;

    const list = gaps.get(shot.key);
    if (list) list.push(shot.seconds - before.seconds);
    else gaps.set(shot.key, [shot.seconds - before.seconds]);
  }

  const out = new Map<string, number>();
  for (const [key, list] of gaps) {
    const pace = paceFromGaps(list);
    if (pace !== null) out.set(key, pace);
  }
  return out;
}

/**
 * The rule itself, over raw gaps in seconds: drop the double-fires, insist on enough of what is
 * left, take the middle one.
 *
 * Exported because a career's pace and a single match's pace have to be the same measurement. The
 * post-match scoreboard reads a captain's pace off one night (lib/matchReport) while the leaderboard
 * reads it off their whole archive; if those two ever computed it differently, a crew would watch
 * their own recap disagree with their own leaderboard row and neither number would be trusted again.
 * squarePace() above feeds this an archive, buildPlayerStats() feeds it one match, and the thresholds
 * are applied in exactly one place either way.
 */
export function paceFromGaps(gaps: number[]): number | null {
  // Below MIN_GAP_SECONDS is a duo boss or a banked kill, not a fast square - see recordBook.
  const real = gaps.filter((gap) => gap >= MIN_GAP_SECONDS);
  return real.length < MIN_GAPS_FOR_PACE ? null : median(real);
}

/** "2:34" - the same clock the record book reads timings in. */
export function paceLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
