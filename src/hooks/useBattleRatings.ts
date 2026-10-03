import { useEffect, useState } from "react";
import { fetchMatchEvents, fetchParticipants } from "../lib/profiles";
import { bossFrequency, type MatchEventRow } from "../lib/almanac";
import { squareWeights, rateBattles, type BattleRating } from "../lib/battleRating";
import { challengesForRoom, rowSquareSet, squareSetVariants, type SquareSetId } from "../lib/challenges";

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
  return (roomId, cells, fired, seed, perm) => {
    for (const setId of squareSetVariants(set)) {
      const board = challengesForRoom(roomId, cells, setId, seed, perm).map((c) => c.name);
      if (fired.slice(0, 3).every(({ cell, name }) => board[cell] === name)) return board;
    }
    return [];
  };
}

/** The scoreboard's join: a recap's stats rows carry the nickname and team, not the account. */
export const ratingKey = (team: number, nickname: string) => `${team}|${nickname.trim().toLowerCase()}`;

/**
 * Battle ratings for one archived match, keyed by ratingKey, or null while they load.
 *
 * A rating is a rank against every game on the board, so it cannot be worked out from the match
 * alone: this reads the same two cached feeds the Almanac and the Leaderboard read, and costs nothing
 * extra after either has been opened in the last five minutes. That is also why it is a hook and not
 * a field on the report - the number moves as the archive grows, and freezing it at archive time
 * would leave the recap disagreeing with the Hall of Fame about the same game.
 */
export function useBattleRatings(matchKey: string | null, set: SquareSetId | null): Map<string, BattleRating> | null {
  const [ratings, setRatings] = useState<Map<string, BattleRating> | null>(null);

  useEffect(() => {
    if (!matchKey || !set) return;
    let cancelled = false;
    void (async () => {
      const [parts, events] = await Promise.all([fetchParticipants(), fetchMatchEvents()]);
      const boardEvents = (events as unknown as MatchEventRow[]).filter((e) => rowSquareSet(e) === set);
      const boardParts = parts.filter((p) => rowSquareSet(p) === set);
      const weights = squareWeights(boardEvents, bossFrequency(boardEvents, boardResolver(set)));
      const mine = rateBattles(boardParts, boardEvents, weights).filter((r) => r.matchKey === matchKey);
      if (!cancelled) setRatings(new Map(mine.map((r) => [ratingKey(r.team, r.nickname), r])));
    })();
    return () => {
      cancelled = true;
    };
  }, [matchKey, set]);

  return ratings;
}
