import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { fetchMatchEvents, fetchParticipants } from "../lib/profiles";
import type { MatchEventRow } from "../lib/almanac";
import type { BattleRating } from "../lib/battleRating";
import { rateBoard } from "../lib/battleRatingBoards";
import type { SquareSetId } from "../lib/challenges";

/** The scoreboard's join: a recap's stats rows carry the nickname and team, not the account. */
export const ratingKey = (team: number, nickname: string) => `${team}|${nickname.trim().toLowerCase()}`;

/** What the recap's scoreboard reads: the match's ratings, and the board's square weights behind them. */
export interface MatchRatings {
  /** Keyed by ratingKey. A captain missing from it was not rated - see ratedMatch. */
  ratings: Map<string, BattleRating>;
  /** Square name -> weight. A square missing from it counts as 1, exactly as rateBattles reads it. */
  weights: Map<string, number>;
}

function toMatchRatings(mine: BattleRating[], weights: Map<string, number>): MatchRatings {
  return { ratings: new Map(mine.map((r) => [ratingKey(r.team, r.nickname), r])), weights };
}

/**
 * The stored answer, from the battle-ratings Edge Function: one request.
 *
 * Null when the function cannot answer - not deployed yet, or a failure - so the caller can fall back.
 * An empty `ratings` is NOT a failure: it is a match that was not rated, and must not trigger the
 * fallback's full download to find out the same thing.
 */
async function fromSnapshot(matchKey: string, set: SquareSetId): Promise<MatchRatings | null> {
  const { data, error } = await supabase.functions.invoke("battle-ratings", { body: { matchKey, set } });
  if (error || !data || !Array.isArray(data.ratings) || typeof data.weights !== "object") return null;
  return toMatchRatings(data.ratings as BattleRating[], new Map(Object.entries(data.weights as Record<string, number>)));
}

/** The old way: the whole archive, rated here. Kept only as the fallback - it is ~40 requests. */
async function fromArchive(matchKey: string, set: SquareSetId): Promise<MatchRatings> {
  const [parts, events] = await Promise.all([fetchParticipants(), fetchMatchEvents()]);
  const { weights, ratings } = rateBoard(parts, events as unknown as MatchEventRow[], set);
  return toMatchRatings(
    ratings.filter((r) => r.matchKey === matchKey),
    weights
  );
}

/**
 * Battle ratings for one archived match, and the square weights they were built on, or null while
 * they load.
 *
 * A rating is a rank against every game on the board, so it cannot be worked out from the match
 * alone, and the number moves as the archive grows - which is why it is not a field on the report.
 * The battle-ratings function keeps a snapshot that recomputes whenever the archive changes and hands
 * back just this match, built by the same code as the Almanac's Hall of Fame (lib/battleRatingBoards),
 * so the two agree about the same game. If the function cannot answer, the recap rates the match
 * itself the old, expensive way rather than showing nothing.
 */
export function useBattleRatings(matchKey: string | null, set: SquareSetId | null): MatchRatings | null {
  const [ratings, setRatings] = useState<MatchRatings | null>(null);

  useEffect(() => {
    if (!matchKey || !set) return;
    let cancelled = false;
    void (async () => {
      let result = await fromSnapshot(matchKey, set).catch(() => null);
      if (!result) {
        console.warn("battle-ratings function unavailable; rating this match from the full archive");
        result = await fromArchive(matchKey, set);
      }
      if (!cancelled) setRatings(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [matchKey, set]);

  return ratings;
}
