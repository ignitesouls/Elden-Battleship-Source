import { supabase } from "./supabase";

/**
 * Matches that stay in the archive and count for nothing.
 *
 * A voided match is still a match: its recap page renders, its permalink resolves, and the
 * Almanac's history list still names it. What it no longer does is feed a number. Careers, the
 * leaderboard, square pace, the record book, the boss stats, the heatmaps and the board-fairness
 * sweep all read past it.
 *
 * The flag lives on `match_reports.voided` rather than in a constant here so a match can be struck
 * from the Admin panel without a deploy - see the migration for the case it was built for.
 *
 * -- Why this is a separate read -------------------------------------------------------------------
 *
 * The flag sits on match_reports, and the tables the stats are built from (match_events,
 * match_participants, match_fleets) join to it only by the text `match_key`. There is no column on
 * them to filter by, so the short list of voided keys is fetched once and the rows are dropped
 * client-side. It is the cheapest read on the site: the partial index means it touches only the
 * voided rows, of which there is currently one.
 */

/**
 * The in-flight or settled read, so three fetchers on one page ask the database once.
 *
 * Held as the promise rather than the answer on purpose - Leaderboard and PlayerStats both kick off
 * two stats fetches in the same tick, and caching only the resolved value would let both miss.
 */
let pending: Promise<Set<string>> | null = null;

export function fetchVoidedMatches(): Promise<Set<string>> {
  if (!pending) {
    pending = (async () => {
      const { data, error } = await supabase.from("match_reports").select("match_key").eq("voided", true);
      // An empty set on failure, which fails towards showing a stat rather than hiding one. A
      // network blip should not silently rewrite the leaderboard, and the next page load retries.
      if (error || !data) {
        pending = null;
        return new Set<string>();
      }
      return new Set((data as { match_key: string }[]).map((r) => r.match_key));
    })();
  }
  return pending;
}

/** Forgets the cached list, so an admin who has just voided a match sees the effect on the reload. */
export function clearVoidedCache(): void {
  pending = null;
}

/** Drops every row belonging to a voided match. Rows are matched on `match_key`, as they are joined. */
export async function withoutVoided<T extends { match_key: string }>(rows: T[]): Promise<T[]> {
  const voided = await fetchVoidedMatches();
  if (voided.size === 0) return rows;
  return rows.filter((r) => !voided.has(r.match_key));
}
