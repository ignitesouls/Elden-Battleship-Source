import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchParticipants, fetchProfiles, fetchMatchEvents, profileName, type Profile } from "../lib/profiles";
import { SquareSetTabs } from "../components/SquareSetTabs";
import { rowSquareSet, busiestSquareSet, squareSet, DEFAULT_SQUARE_SET, type SquareSetId } from "../lib/challenges";
import { aggregateCareers, type CareerStats, type ParticipantRow } from "../lib/careerStats";
import { buildRecordBook } from "../lib/recordBook";
import { squarePace, paceLabel, MIN_GAPS_FOR_PACE } from "../lib/squarePace";
import { RecordBook } from "../components/RecordBook";
import { LoadingScreen } from "../components/BrandMark";
import { SortHeader, useSortColumns, type SortColumn } from "../components/SortHeader";
import type { MatchEventRow } from "../lib/almanac";

type SortKey = "name" | "wins" | "winRate" | "shots" | "hits" | "sunk" | "accuracy" | "pace";

/** A career row with the two things the table needs that aggregation doesn't carry. */
interface Row extends CareerStats {
  /** Median seconds per square, or null when they haven't enough squares to have a pace yet. */
  pace: number | null;
  /** The name as SHOWN, so sorting by captain matches what the reader is looking at. */
  displayName: string;
}

/**
 * Every column carries a `title`, including the ones whose heading looks self-explanatory.
 *
 * "Hits" and "Sunk" read as obvious until you ask whether a hit that sinks a ship counts once or
 * twice, or whether "shots" means squares taken or trigger-pulls. The headings can't answer that in
 * four characters and the answers are not guessable, so the explanation lives one hover away rather
 * than nowhere. Consistency is deliberate too: a tooltip on some headings and not others teaches
 * people that hovering usually does nothing.
 */
const COLUMNS: SortColumn<SortKey>[] = [
  {
    key: "name",
    label: "Captain",
    align: "left",
    firstDirection: "asc",
    title: "Signed-in captains are grouped by account; guests by nickname, so two guests sharing a name share a row. Click a name for their full record on this board.",
  },
  {
    key: "wins",
    label: "W-L",
    align: "right",
    firstDirection: "desc",
    title: "Wins and losses across every finished match on this board. Draws are archived but not shown - no match has ever ended without a winner.",
  },
  {
    key: "winRate",
    label: "Win %",
    align: "right",
    firstDirection: "desc",
    title: "Share of finished matches won. Sorting by this falls back to total wins, so a single lucky match doesn't top the table.",
  },
  {
    key: "shots",
    label: "Shots",
    align: "right",
    firstDirection: "desc",
    title: "Squares taken. One shot per square earned, whether it landed or not - a shot at three enemy fleets still counts once.",
  },
  {
    key: "hits",
    label: "Hits",
    align: "right",
    firstDirection: "desc",
    title: "Shots that landed on an enemy ship. A shot that lands on more than one fleet counts once.",
  },
  {
    key: "sunk",
    label: "Sunk",
    align: "right",
    firstDirection: "desc",
    title: "Enemy ships finished off. The sinking shot counts as a hit as well.",
  },
  {
    key: "accuracy",
    label: "Acc.",
    align: "right",
    firstDirection: "desc",
    title: "Accuracy - hits as a share of shots fired, over this whole board.",
  },
  {
    key: "pace",
    label: "pace",
    sublabel: "median",
    align: "right",
    firstDirection: "asc",
    title: `Square pace - the time from one square falling to the next, taken as a median across every square they have fired on this board. The median rather than the average, so one long boss doesn't stand in for the whole evening. Needs ${MIN_GAPS_FOR_PACE} squares before it shows.`,
  },
];

/**
 * Ascending comparison for one column. The caller flips it for descending.
 *
 * The secondary keys are not decoration. Sorting on a rate alone puts whoever has the smallest
 * sample on top, so every rate falls back to the volume behind it and every count falls back to the
 * rate - which keeps a captain with 9 hits from outranking one with 9 hits at twice the accuracy.
 */
function compare(a: Row, b: Row, key: SortKey): number {
  switch (key) {
    case "name":
      return a.displayName.localeCompare(b.displayName);
    case "wins":
      return a.wins - b.wins || a.winRate - b.winRate;
    case "winRate":
      return a.winRate - b.winRate || a.wins - b.wins;
    case "shots":
      return a.shots - b.shots || a.hits - b.hits;
    case "hits":
      return a.hits - b.hits || a.accuracy - b.accuracy;
    case "sunk":
      return a.sunk - b.sunk || a.hits - b.hits;
    case "accuracy":
      return a.accuracy - b.accuracy || a.hits - b.hits;
    case "pace":
      // Nulls are handled before this is reached - see the sort below.
      return (a.pace ?? 0) - (b.pace ?? 0) || b.shots - a.shots;
  }
}

export function Leaderboard() {
  const [rows, setRows] = useState<ParticipantRow[] | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const { sort, direction, sortBy } = useSortColumns(COLUMNS, "wins");

  /**
   * Archived shots, for the streak and timing records only.
   *
   * Fetched after the table has already rendered, because it is by far the biggest read on this page
   * and nothing above it needs to wait: the counting records come off the participation rows, so the
   * book appears with most of itself filled in and the rest arrives a moment later.
   */
  const [events, setEvents] = useState<MatchEventRow[] | null>(null);

  // Which board's records are on show. Null until the rows arrive, then whichever set has been
  // played most - opening on an empty table for a set nobody has touched helps nobody.
  const [setId, setSetId] = useState<SquareSetId | null>(null);

  useEffect(() => {
    void (async () => {
      const data = await fetchParticipants();
      setRows(data);
      setSetId((current) => current ?? busiestSquareSet(data));
      setProfiles(await fetchProfiles(data.map((r) => r.user_id).filter(Boolean) as string[]));
      setEvents((await fetchMatchEvents()) as MatchEventRow[]);
    })();
  }, []);

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

  /** Median seconds per square, per captain, for the board on show. */
  const paces = useMemo(
    () => squarePace((events ?? []).filter((e) => rowSquareSet(e) === shownSet)),
    [events, shownSet]
  );

  const careers = useMemo<Row[]>(() => {
    // Careers are aggregated per set, never across: an accuracy averaged over boss kills and
    // "acquire 3 painting rewards" describes neither board.
    const list = aggregateCareers((rows ?? []).filter((r) => rowSquareSet(r) === shownSet));
    return list.map((c) => ({
      ...c,
      pace: paces.get(c.key) ?? null,
      displayName: profileName(c.userId ? profiles.get(c.userId) : undefined) ?? c.nickname,
    }));
  }, [rows, shownSet, paces, profiles]);

  const sorted = useMemo(() => {
    return [...careers].sort((a, b) => {
      // A captain without a pace yet sits at the bottom in BOTH directions rather than sorting as
      // zero, which would otherwise read as infinitely fast. Same for any column that can be blank.
      if (sort === "pace" && (a.pace === null || b.pace === null)) {
        if (a.pace === null && b.pace === null) return b.shots - a.shots;
        return a.pace === null ? 1 : -1;
      }
      const cmp = compare(a, b, sort);
      return direction === "asc" ? cmp : -cmp;
    });
  }, [careers, sort, direction]);

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
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
              {/* Not sticky: this table scrolls with the PAGE rather than inside a box, and a
                  header pinned to the viewport would float over the record book above it. */}
              <SortHeader
                columns={COLUMNS}
                sort={sort}
                direction={direction}
                onSort={sortBy}
                leading="#"
                sticky={false}
              />
              <tbody>
                {sorted.map((c, i) => {
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
                          <span>{c.displayName}</span>
                          {!c.verified && (
                            <span className="badge" title="Not signed in - grouped by nickname only">
                              guest
                            </span>
                          )}
                        </Link>
                      </td>
                      {/* Wins and losses only. Draws are archived but never shown here: they need
                          a match to end with no winner at all, which has happened zero times, and a
                          third number that is always 0 is a column of noise. */}
                      <td style={num}>
                        {c.wins}-{c.losses}
                      </td>
                      <td style={num}>{Math.round(c.winRate * 100)}%</td>
                      <td style={num}>{c.shots}</td>
                      <td style={{ ...num, color: "var(--hit)" }}>{c.hits}</td>
                      <td style={{ ...num, color: "var(--sunk)" }}>{c.sunk}</td>
                      <td style={num}>{Math.round(c.accuracy * 100)}%</td>
                      {/* Pace rides on the shot log, which lands after the table has already drawn,
                          so an empty cell means "still reading" for the first moment and "not
                          enough squares yet" after that. They read differently on purpose. */}
                      <td style={{ ...num, color: c.pace === null ? "var(--text-dim)" : undefined }}>
                        {c.pace !== null ? paceLabel(c.pace) : events === null ? "..." : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <span className="muted" style={{ fontSize: "0.7rem" }}>
            Click a heading to sort by it; click it again to flip the order. Hover any heading for
            what the number means - pace is the median time from one square falling to the next, and
            needs {MIN_GAPS_FOR_PACE} squares before it shows.
          </span>
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            Guests are grouped by nickname, so two people using the same name share a row. Signing
            in with Twitch gives you a record only you can add to.
          </span>
        </div>
        </>
      )}
    </div>
  );
}
