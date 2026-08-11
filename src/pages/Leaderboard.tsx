import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchParticipants, fetchProfiles, fetchMatchEvents, profileName, type Profile } from "../lib/profiles";
import { SquareSetTabs } from "../components/SquareSetTabs";
import { rowSquareSet, busiestSquareSet, squareSet, DEFAULT_SQUARE_SET, type SquareSetId } from "../lib/challenges";
import { aggregateCareers, type ParticipantRow } from "../lib/careerStats";
import { buildRecordBook } from "../lib/recordBook";
import { RecordBook } from "../components/RecordBook";
import { fetchRecentMatchReports } from "../lib/rooms";
import { AdminPanel } from "../components/AdminPanel";
import { LoadingScreen } from "../components/BrandMark";
import type { MatchEventRow } from "../lib/almanac";
import type { MatchReportRow } from "../types/battleship";

type SortKey = "wins" | "winRate" | "sunk" | "accuracy" | "matches";

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "wins", label: "Wins" },
  { key: "winRate", label: "Win %" },
  { key: "sunk", label: "Ships sunk" },
  { key: "accuracy", label: "Accuracy" },
  { key: "matches", label: "Matches" },
];

export function Leaderboard() {
  const [rows, setRows] = useState<ParticipantRow[] | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [sort, setSort] = useState<SortKey>("wins");
  const [matches, setMatches] = useState<MatchReportRow[]>([]);
  /**
   * Archived shots, for the streak and timing records only.
   *
   * Fetched after the table has already rendered, because it is by far the biggest read on this page
   * and nothing above it needs to wait: the counting records come off the participation rows, so the
   * book appears with most of itself filled in and the rest arrives a moment later.
   */
  const [events, setEvents] = useState<MatchEventRow[] | null>(null);
  // Bumped after an admin deletes something, to re-read both the careers and the match list.
  const [reload, setReload] = useState(0);

  // Which board's records are on show. Null until the rows arrive, then whichever set has been
  // played most - opening on an empty table for a set nobody has touched helps nobody.
  const [setId, setSetId] = useState<SquareSetId | null>(null);

  useEffect(() => {
    void (async () => {
      const data = await fetchParticipants();
      setRows(data);
      setSetId((current) => current ?? busiestSquareSet(data));
      setProfiles(await fetchProfiles(data.map((r) => r.user_id).filter(Boolean) as string[]));
      setMatches((await fetchRecentMatchReports(200)) as MatchReportRow[]);
      setEvents((await fetchMatchEvents()) as MatchEventRow[]);
    })();
  }, [reload]);

  const shownSet = setId ?? DEFAULT_SQUARE_SET;

  /** Matches recorded per set, for the tab labels. Counted on matches, not participant rows. */
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    const seen = new Set<string>();
    for (const r of rows ?? []) {
      const key = `${rowSquareSet(r)}:${r.match_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[rowSquareSet(r)] = (out[rowSquareSet(r)] ?? 0) + 1;
    }
    return out;
  }, [rows]);

  const careers = useMemo(() => {
    // Careers are aggregated per set, never across: an accuracy averaged over boss kills and
    // "acquire 3 painting rewards" describes neither board.
    const list = aggregateCareers((rows ?? []).filter((r) => rowSquareSet(r) === shownSet));
    // Secondary keys stay meaningful: sorting by accuracy alone would put a 1-shot fluke on top.
    return [...list].sort((a, b) => {
      switch (sort) {
        case "winRate":
          return b.winRate - a.winRate || b.wins - a.wins;
        case "sunk":
          return b.sunk - a.sunk || b.wins - a.wins;
        case "accuracy":
          return b.accuracy - a.accuracy || b.shots - a.shots;
        case "matches":
          return b.matches - a.matches || b.wins - a.wins;
        default:
          return b.wins - a.wins || b.winRate - a.winRate;
      }
    });
  }, [rows, sort, shownSet]);

  /**
   * The record book, for the same board the table is showing.
   *
   * Filtered to this set exactly as the careers are: a best-accuracy game on a board of boss kills and
   * one on a board of "acquire 3 painting rewards" are not the same record.
   */
  const records = useMemo(() => {
    const forSet = (rows ?? []).filter((r) => rowSquareSet(r) === shownSet);
    return buildRecordBook(forSet, (events ?? []).filter((e) => rowSquareSet(e) === shownSet), shownSet);
  }, [rows, events, shownSet]);

  if (rows === null) return <LoadingScreen>Loading the records...</LoadingScreen>;

  return (
    <div className="stack" style={{ width: "min(860px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>Leaderboard</h1>
        <p className="muted">Career records for one board at a time.</p>
      </div>

      {/* Outside the empty check, so a set with no matches yet can still be switched away from. */}
      <div className="panel stack" style={{ gap: "0.4rem" }}>
        <SquareSetTabs value={shownSet} onChange={setSetId} counts={counts} />
        <span className="muted" style={{ fontSize: "0.72rem" }}>{squareSet(shownSet).blurb}</span>
      </div>

      {careers.length === 0 ? (
        <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
          <p className="muted" style={{ margin: 0 }}>
            No finished matches on the {squareSet(shownSet).label} board yet. Play one and the
            records start here.
          </p>
          <Link to="/">Back to the harbor</Link>
        </div>
      ) : (
        <>
        {/* Above the career table on purpose: "the best game anybody has had" is the thing people
            come back to read, and the standings are what they study once they're here. */}
        <RecordBook
          records={records}
          profiles={profiles}
          squareSet={shownSet}
          loadingShots={events === null}
        />

        <div className="panel stack" style={{ gap: "0.6rem" }}>
          <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: "0.78rem" }}>Sort by</span>
            {SORTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.2rem 0.5rem",
                  borderColor: sort === s.key ? "var(--accent)" : undefined,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                  <th style={{ textAlign: "left", fontWeight: 500, padding: "0.25rem 0.4rem" }}>#</th>
                  <th style={{ textAlign: "left", fontWeight: 500, padding: "0.25rem 0.4rem" }}>Captain</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>W-L-D</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>Win %</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>Shots</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>Hits</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>Sunk</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>Acc.</th>
                </tr>
              </thead>
              <tbody>
                {careers.map((c, i) => {
                  const p = c.userId ? profiles.get(c.userId) : undefined;
                  const num = { padding: "0.25rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
                  return (
                    <tr key={c.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                      <td style={{ textAlign: "left", padding: "0.25rem 0.4rem", color: "var(--text-dim)" }}>
                        {i + 1}
                      </td>
                      <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
                        {/* Carries the set through, so a captain's page shows the same board's
                            numbers as the row that was clicked to reach it. */}
                        <Link
                          to={`/player/${encodeURIComponent(c.key)}?set=${encodeURIComponent(shownSet)}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.4rem",
                            textDecoration: "none",
                            color: "var(--text)",
                          }}
                        >
                          {p?.avatar_url && (
                            <img src={p.avatar_url} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />
                          )}
                          <span>{profileName(p) ?? c.nickname}</span>
                          {!c.verified && (
                            <span className="badge" title="Not signed in - grouped by nickname only">
                              guest
                            </span>
                          )}
                        </Link>
                      </td>
                      <td style={num}>
                        {c.wins}-{c.losses}
                        {c.draws > 0 ? `-${c.draws}` : ""}
                      </td>
                      <td style={num}>{Math.round(c.winRate * 100)}%</td>
                      <td style={num}>{c.shots}</td>
                      <td style={{ ...num, color: "var(--hit)" }}>{c.hits}</td>
                      <td style={{ ...num, color: "var(--sunk)" }}>{c.sunk}</td>
                      <td style={num}>{Math.round(c.accuracy * 100)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <span className="muted" style={{ fontSize: "0.7rem" }}>
            Guests are grouped by nickname, so two people using the same name share a row. Signing
            in with Twitch gives you a record only you can add to.
          </span>
        </div>
        </>
      )}

      {/* Renders nothing unless the signed-in account is an admin. */}
      <AdminPanel matches={matches} onChanged={() => setReload((n) => n + 1)} />
    </div>
  );
}
