import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AdminPanel } from "../components/AdminPanel";
import { BalanceStats } from "../components/BalanceStats";
import { LoadingScreen } from "../components/BrandMark";
import { useAdminStatus } from "../lib/admin";
import { fetchRecentMatchReports } from "../lib/rooms";
import type { MatchReportRow } from "../types/battleship";

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
 */
export function Admin() {
  const { isAdmin, loading } = useAdminStatus();
  const [matches, setMatches] = useState<MatchReportRow[] | null>(null);
  // Bumped after a deletion, to re-read the match list the panel is rendering.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    void (async () => {
      setMatches((await fetchRecentMatchReports(200).catch(() => [])) as MatchReportRow[]);
    })();
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
        <p className="muted">Records, live rooms, administrators and board balance.</p>
      </div>

      <AdminPanel matches={matches} onChanged={() => setReload((n) => n + 1)} />

      <BalanceStats />
    </div>
  );
}
