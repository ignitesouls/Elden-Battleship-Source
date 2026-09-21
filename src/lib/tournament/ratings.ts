import { supabase } from "../supabase";
import { withoutVoided } from "../voidedMatches";
import { ratingFromRecord } from "./ratingMath";

/**
 * Ratings for a set of accounts, from their archived matches (see ratingMath for what a rating is).
 *
 * Voided matches - including practice matches, which are voided on purpose - are left out, the same as
 * everywhere else the site counts a career, so a player's rating agrees with the record they see on
 * their own page.
 */
export async function fetchCareerRatings(userIds: string[]): Promise<Map<string, number>> {
  const ratings = new Map<string, number>();
  if (userIds.length === 0) return ratings;

  const { data, error } = await supabase
    .from("match_participants")
    .select("user_id, won, match_key")
    .in("user_id", userIds);
  if (error) throw new Error(error.message);

  const rows = await withoutVoided((data ?? []) as Array<{ user_id: string; won: boolean; match_key: string }>);
  const record = new Map<string, { wins: number; played: number }>();
  for (const row of rows) {
    const r = record.get(row.user_id) ?? { wins: 0, played: 0 };
    r.played += 1;
    if (row.won) r.wins += 1;
    record.set(row.user_id, r);
  }
  for (const [id, { wins, played }] of record) {
    const rating = ratingFromRecord(wins, played);
    if (rating !== undefined) ratings.set(id, rating);
  }
  return ratings;
}
