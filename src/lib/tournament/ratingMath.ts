/**
 * A strength number for balancing solo players into teams, from a win-loss record.
 *
 * A raw win rate is a poor rating: one win in one game is a perfect 100%, which would rank a newcomer
 * above someone who has won forty of fifty. So the record is smoothed toward an average player - the
 * rating is (wins + 1) / (games + 2), which is exactly 0.5 with no games, and moves toward the true
 * rate only as evidence piles up. Forty-of-fifty comes out around 0.79 and one-of-one around 0.67.
 *
 * A player with no games at all has no rating (not 0.5), so the pairing can treat "unknown" as its own
 * thing - it deals unrated players out as average rather than guessing.
 *
 * Kept apart from the code that reads the records (ratings.ts) so it can be checked without a browser.
 */
export function ratingFromRecord(wins: number, played: number): number | undefined {
  if (played <= 0) return undefined;
  return (wins + 1) / (played + 2);
}
