import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AdminPanel } from "../components/AdminPanel";
import { BalanceStats } from "../components/BalanceStats";
import { EgressPanel } from "../components/EgressPanel";
import { LoadingScreen } from "../components/BrandMark";
import { useAdminStatus } from "../lib/admin";
import { fetchRecentMatchReports, countMatchReports } from "../lib/rooms";
import type { MatchReportRow } from "../types/battleship";

/** How many matches the list shows at first, and how many each "Show more" adds. */
const PAGE = 25;

/**
 * The admin's own page.
 *
 * These controls used to hang off the bottom of the Leaderboard, which put record deletion, room
 * pruning and the grant list underneath a table nobody scrolls to the end of - and made the
 * leaderboard two pages wearing one URL depending on who was looking at it. They have a door in
 * the top bar now, and the record book is just a record book again.
 *
 * The match list is read here rather than passed in, since there is no longer a page above this
 * one holding it. Same call the Leaderboard makes, and the panel re-runs it through `onChanged`
 * after anything is deleted.
 *
 * It is read a page at a time. This used to ask for two hundred recaps on every visit, which was
 * both a wall of rows nobody scrolls and a couple of hundred kilobytes spent to reach the handful
 * of recent matches that an admin ever actually acts on. A page is enough to see last night's games
 * and the rest is one click away. The count beside the heading is a HEAD request, so the page can
 * still say how many matches exist without reading them.
 */
export function Admin() {
  const { isAdmin, loading } = useAdminStatus();
  const [matches, setMatches] = useState<MatchReportRow[] | null>(null);
  /** Every archived match, including the ones not loaded - a HEAD count, not a fetch. */
  const [total, setTotal] = useState<number | null>(null);
  /** How many rows the list is currently asking for. Raised by "Show more". */
  const [limit, setLimit] = useState(PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped after a deletion, to re-read the match list the panel is rendering.
  const [reload, setReload] = useState(0);

  // Re-reads the first `limit` rows rather than appending the new page onto what is already here.
  // A deletion shifts every row below it, so an appending fetch would duplicate or skip rows at the
  // seam; a page or two of small rows is a cheap price for a list that is never subtly wrong.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      const rows = (await fetchRecentMatchReports(limit).catch(() => [])) as MatchReportRow[];
      if (cancelled) return;
      setMatches(rows);
      setLoadingMore(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, reload, limit]);

  // Not tied to `limit`: the total is the same number whichever page is showing, and re-asking on
  // every "Show more" would be a round trip to learn something already known.
  useEffect(() => {
    if (!isAdmin) return;
    void (async () => setTotal(await countMatchReports().catch(() => 0)))();
  }, [isAdmin, reload]);

  // The status check is a round trip, so without this the page would show "nothing here" for a
  // moment to an admin who is in fact an admin.
  if (loading) return <LoadingScreen>Checking...</LoadingScreen>;

  /**
   * Anyone can type this URL, so it needs an answer for people who aren't admins. Deliberately not
   * a redirect: bouncing them somewhere else implies the page doesn't exist, and the honest answer
   * is that it does and isn't theirs. Nothing is protected by this - RLS is - it only avoids
   * offering controls the server would refuse.
   */
  if (!isAdmin) {
    return (
      <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
        <p className="muted" style={{ margin: 0 }}>
          Nothing here for you. These controls are for administrators.
        </p>
        <Link to="/">Back to the harbor</Link>
      </div>
    );
  }

  if (matches === null) return <LoadingScreen>Loading the records...</LoadingScreen>;

  return (
    <div className="stack" style={{ width: "min(860px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>Admin</h1>
        <p className="muted">Records, live rooms, administrators, board balance and egress.</p>
      </div>

      <AdminPanel
        matches={matches}
        total={total}
        revision={reload}
        loadingMore={loadingMore}
        onShowMore={
          total !== null && matches.length < total
            ? () => {
                setLoadingMore(true);
                setLimit((n) => n + PAGE);
              }
            : undefined
        }
        onChanged={() => setReload((n) => n + 1)}
      />

      {/* Takes the same match list, because a room's byte count only becomes a match's byte count
          once something can turn its key into a start and an end. */}
      <EgressPanel matches={matches} />

      <BalanceStats />
    </div>
  );
}
