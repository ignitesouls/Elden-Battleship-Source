import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchMatchFleets, fetchMatchEvents, fetchParticipants, fetchProfiles, profileName, type Profile } from "../lib/profiles";
import { fetchArchivedMatches, ARCHIVE_LIST_LIMIT, type ArchivedMatch } from "../lib/matchArchive";
import { buildScoutingReports } from "../lib/scouting";
import { CaptainCards } from "../components/CaptainCards";
import type { ParticipantRow } from "../lib/careerStats";
import { matchName } from "../lib/matchName";
import { teamName, teamHex } from "../lib/teamColors";
import { challengesForRoom, detectSquareSet, rowSquareSet, busiestSquareSet, squareSet, displaySquareSet, squareSetVariants, DEFAULT_SQUARE_SET, type SquareSetId } from "../lib/challenges";
import { SquareSetTabs } from "../components/SquareSetTabs";
import { SiteFooter } from "../components/SiteFooter";
import {
  placementHeatmap,
  shotHeatmap,
  bossStats,
  fastestKills,
  boardSizesPresent,
  playerPace,
  bossFrequency,
  mergeSquareStats,
  matchShape,
  groupEventsByMatch,
  type MatchFleetRow,
  type MatchEventRow,
  type Heatmap,
  type SquareRow,
  type PlayerPace,
} from "../lib/almanac";
import { SortHeader, useSortColumns, type SortColumn } from "../components/SortHeader";
import { squarePace, MIN_GAPS_FOR_PACE } from "../lib/squarePace";

const COL_LETTERS = "ABCDEFGHIJKLMNOPQR";

export function Almanac() {
  const [fleets, setFleets] = useState<MatchFleetRow[] | null>(null);
  const [allEvents, setAllEvents] = useState<MatchEventRow[]>([]);
  const [allParts, setAllParts] = useState<ParticipantRow[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [mode, setMode] = useState<"ships" | "shots">("ships");
  const [size, setSize] = useState<number | null>(null);
  const [setId, setSetId] = useState<SquareSetId | null>(null);
  const [archived, setArchived] = useState<ArchivedMatch[]>([]);
  const [view, setView] = useState<"patterns" | "captains">("patterns");

  useEffect(() => {
    void (async () => {
      const [f, e, p, m] = await Promise.all([
        fetchMatchFleets(),
        fetchMatchEvents(),
        fetchParticipants(),
        fetchArchivedMatches(),
      ]);
      setFleets(f as unknown as MatchFleetRow[]);
      setAllEvents(e as unknown as MatchEventRow[]);
      setAllParts(p);
      setArchived(m);
      setSetId((current) => current ?? busiestSquareSet(e as unknown as MatchEventRow[]));
      // Avatars and chosen names for the captain cards. Signed-in players only - a guest record has
      // no profile row to read.
      setProfiles(await fetchProfiles(p.map((r) => r.user_id).filter(Boolean) as string[]));
    })();
  }, []);

  const shownSet = setId ?? DEFAULT_SQUARE_SET;

  /**
   * Which set each archived match was played on.
   *
   * The stored column is the answer for anything archived since square sets existed. Rows without
   * one are reconstructed instead - rebuild the board with each set and see which puts the logged
   * names in the logged places - which covers both matches that predate the column and any archived
   * by a client running ahead of the migration.
   */
  const setByMatch = useMemo(() => {
    const out = new Map<string, SquareSetId>();
    for (const [key, evs] of groupEventsByMatch(allEvents)) {
      const stored = evs.find((e) => e.square_set)?.square_set;
      if (stored) {
        // Folded, because this map decides which TAB a match sits under. The board it was actually
        // dealt from is recovered in `freq` below, which is the only reader here that needs it.
        out.set(key, displaySquareSet(stored));
        continue;
      }
      const roomId = evs.find((e) => e.room_id)?.room_id;
      const fired = evs
        .filter((e) => e.challenge_name && e.cell_index >= 0)
        .map((e) => ({ cell: e.cell_index, name: e.challenge_name as string }));
      const cells = evs[0].board_size * evs[0].board_size;
      const perm = evs.find((e) => e.board_perm)?.board_perm ?? null;
      out.set(key, displaySquareSet((roomId ? detectSquareSet(roomId, cells, fired, null, perm) : null) ?? DEFAULT_SQUARE_SET));
    }
    return out;
  }, [allEvents]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of setByMatch.values()) out[id] = (out[id] ?? 0) + 1;
    return out;
  }, [setByMatch]);

  const events = useMemo(
    () => allEvents.filter((e) => (setByMatch.get(e.match_key) ?? DEFAULT_SQUARE_SET) === shownSet),
    [allEvents, setByMatch, shownSet]
  );
  const parts = useMemo(
    () => allParts.filter((p) => (setByMatch.get(p.match_key) ?? rowSquareSet(p)) === shownSet),
    [allParts, setByMatch, shownSet]
  );
  // Fleets feed the "where ships hide" heatmap. Filtered too: hiding places on a 5x5 objectives
  // board have nothing to say about a 10x10 boss board.
  const shownFleets = useMemo(
    () => (fleets ?? []).filter((f) => (setByMatch.get(f.match_key) ?? rowSquareSet(f)) === shownSet),
    [fleets, setByMatch, shownSet]
  );

  const reports = useMemo(() => buildScoutingReports(parts, events), [parts, events]);

  const pace = useMemo(() => playerPace(events), [events]);
  // The leaderboard's measure of the same thing, shown beside this page's. See the pace table.
  const paceMedians = useMemo(() => squarePace(events), [events]);
  const shape = useMemo(() => matchShape(events, parts), [events, parts]);
  const freq = useMemo(
    // Rebuilds each board's full challenge list from its room id, which is what reveals squares
    // nobody ever fired at. Everything here is one TAB's matches, which can be more than one stored
    // set: the boss tab holds both cuts of the boss board. So each candidate is tried and the one
    // that reproduces the log is the board - a board that cannot is the wrong board, and counting
    // only the squares actually shot beats inventing a denominator.
    () =>
      bossFrequency(events, (roomId, cells, fired, seed, perm) => {
        for (const setId of squareSetVariants(shownSet)) {
          const board = challengesForRoom(roomId, cells, setId, seed, perm).map((c) => c.name)
          if (fired.slice(0, 3).every(({ cell, name }) => board[cell] === name)) return board
        }
        return []
      }),
    [events, shownSet]
  );

  const sizes = useMemo(() => boardSizesPresent(shownFleets, events), [shownFleets, events]);
  const boardSize = size ?? sizes[0] ?? 10;

  const map = useMemo(
    () => (mode === "ships" ? placementHeatmap(shownFleets, boardSize) : shotHeatmap(events, boardSize)),
    [mode, shownFleets, events, boardSize]
  );
  // Every square on the board in one row, not just the ones somebody shot at - see mergeSquareStats.
  const squares = useMemo(() => mergeSquareStats(bossStats(events), freq), [events, freq]);
  const records = useMemo(() => fastestKills(events, 8), [events]);

  if (fleets === null) return <p className="muted">Consulting the almanac...</p>;

  const hasData = shownFleets.length > 0 || events.length > 0;

  return (
    <div className="stack" style={{ width: "min(900px, 100%)", gap: "0.9rem" }}>
      <div style={{ textAlign: "center" }}>
        <h1>Almanac</h1>
        <p className="muted">Patterns across every match on one board.</p>
      </div>

      {/* Outside the empty check, so a set with nothing charted can still be switched away from. */}
      <div className="panel stack" style={{ gap: "0.4rem" }}>
        <SquareSetTabs value={shownSet} onChange={setSetId} counts={counts} />
        <span className="muted" style={{ fontSize: "0.72rem" }}>{squareSet(shownSet).blurb}</span>
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          <button
            onClick={() => setView("patterns")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "patterns" ? "var(--accent)" : undefined }}
          >
            Patterns
          </button>
          <button
            onClick={() => setView("captains")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "captains" ? "var(--accent)" : undefined }}
          >
            Captains
          </button>
        </div>
      </div>

      {view === "captains" ? (
        <CaptainCards reports={reports} profiles={profiles} setId={shownSet} />
      ) : (
        <>
        {/* Folded, like every other reader that groups by board: a variant - the trimmed boss cut
            dealt to small crews - has no tab of its own, so matching its stored id raw dropped
            those matches out of the list and out of the count above every aggregate they feed. */}
        <MatchHistory
          matches={archived.filter((m) => displaySquareSet(m.square_set) === shownSet)}
          // Against the ceiling, so the count is a window rather than a total - see ARCHIVE_LIST_LIMIT.
          capped={archived.length >= ARCHIVE_LIST_LIMIT}
        />

        {!hasData ? (
          <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
            <p className="muted" style={{ margin: 0 }}>
              Nothing charted yet. Finish a match and the almanac starts filling in.
            </p>
            <Link to="/">Back to the harbor</Link>
          </div>
        ) : (
          <>
            {shape.matches > 0 && (
              <div className="row" style={{ gap: "0.75rem", alignItems: "stretch", flexWrap: "wrap" }}>
                <BigStat
                  label="First-blood win rate"
                  value={`${Math.round(shape.firstBloodWinRate * 100)}%`}
                  sub={`${shape.firstBloodSample} decided matches`}
                  hint="How often the side that lands the opening hit goes on to win"
                />
                {shape.bloodiest && (
                  <BigStat
                    label="Bloodiest square"
                    value={shape.bloodiest.name}
                    sub={`${shape.bloodiest.sinkings} ${shape.bloodiest.sinkings === 1 ? "ship" : "ships"} sunk on it`}
                    hint="The square that has finished off the most ships"
                  />
                )}
                {shape.medianMatchSeconds !== null && (
                  <BigStat
                    label="Typical match"
                    value={fmt(shape.medianMatchSeconds)}
                    sub={`median of ${shape.timedMatches} ${shape.timedMatches === 1 ? "match" : "matches"}`}
                    hint="How long a match on this board usually runs"
                  />
                )}
                <BigStat
                  label="Flawless wins"
                  value={shape.flawlessWins}
                  sub="won without losing a ship"
                  hint="Victories where the winning fleet finished intact"
                />
              </div>
            )}

            <div className="panel stack" style={{ gap: "0.6rem" }}>
              <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                <h3 style={{ margin: 0 }}>Heatmap</h3>
                <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                  <button
                    onClick={() => setMode("ships")}
                    style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: mode === "ships" ? "var(--accent)" : undefined }}
                  >
                    Where ships hide
                  </button>
                  <button
                    onClick={() => setMode("shots")}
                    style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: mode === "shots" ? "var(--accent)" : undefined }}
                  >
                    Where people shoot
                  </button>
                  {sizes.length > 1 &&
                    sizes.map((s) => (
                      <button
                        key={s}
                        onClick={() => setSize(s)}
                        style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: boardSize === s ? "var(--accent)" : undefined }}
                      >
                        {s}x{s}
                      </button>
                    ))}
                </div>
              </div>

              <span className="muted" style={{ fontSize: "0.75rem" }}>
                {mode === "ships"
                  ? `Cells most often occupied by a ship - ${map.samples} fleets, ${map.total} ship squares.`
                  : `Cells most often fired at - ${map.total} shots across ${map.samples} matches.`}
              </span>

              <HeatGrid map={map} />
            </div>

            <SquaresTable rows={squares} />

            {pace.length > 0 && (
              <PaceTable rows={pace} medians={paceMedians} profiles={profiles} setId={shownSet} />
            )}

            {records.length > 0 && (
              <div className="panel stack" style={{ gap: "0.25rem" }}>
                <h3 style={{ margin: 0 }}>Quickest squares on record</h3>
                <span className="muted" style={{ fontSize: "0.7rem" }}>
                  Timed from the captain's previous square. Misses count.
                </span>
                {records.map((r, i) => (
                  <div
                    key={`${r.matchKey}-${r.challenge}-${i}`}
                    className="row"
                    style={{ justifyContent: "space-between", fontSize: "0.82rem", gap: "0.5rem" }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="muted">{i + 1}. </span>
                      <strong>{r.challenge ?? "Unknown"}</strong>
                      <span className="muted"> - {r.nickname}</span>
                      {/* Which square it was timed from: the pair IS the record, the same way the
                          record book's gap entry reads "X then Y". */}
                      {r.previous && <span className="muted"> · after {r.previous}</span>}
                      {r.result === "sunk" && <span style={{ color: "var(--sunk)" }}> · sank a ship</span>}
                      {r.result === "hit" && <span style={{ color: "var(--hit)" }}> · hit</span>}
                    </span>
                    <strong style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{fmt(r.seconds)}</strong>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        </>
      )}
      {/* Page level, and outside the tab switch: it used to live inside the pace table's panel, so
          it drew halfway down the page above "Quickest squares", and vanished entirely on the
          Captains tab or whenever no captain had a pace yet. */}
      <SiteFooter />
    </div>
  );
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How many matches to list before the rest go behind "Show all". */
const HISTORY_PREVIEW = 12;

/**
 * Every finished match, each one a link to its own permanent recap.
 *
 * The Almanac is otherwise entirely aggregate - it tells you that people hug the edges without
 * ever letting you look at a single game. This is the way back down to one match.
 *
 * Costs no storage: match_reports has been written at the end of every match since the record
 * books existed, and this reads rows that were already sitting there.
 */
function MatchHistory({ matches, capped }: { matches: ArchivedMatch[]; capped?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  if (matches.length === 0) return null;

  const shown = showAll ? matches : matches.slice(0, HISTORY_PREVIEW);

  return (
    <div className="panel stack" style={{ gap: "0.3rem" }}>
      <h3 style={{ margin: 0 }}>Match history</h3>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {capped ? "The newest " : ""}
        {matches.length} finished {matches.length === 1 ? "match" : "matches"}
        {capped ? ` of the last ${ARCHIVE_LIST_LIMIT} played` : ""}. Open one for its recap and replay.
      </span>
      {shown.map((m) => {
        const when = new Date(m.finished_at);
        return (
          <Link
            key={m.match_key}
            to={`/match/${encodeURIComponent(m.match_key)}`}
            className="row"
            style={{
              justifyContent: "space-between",
              gap: "0.5rem",
              fontSize: "0.8rem",
              padding: "0.25rem 0",
              borderTop: "1px solid var(--panel-border)",
              textDecoration: "none",
            }}
          >
            <span style={{ minWidth: 0 }}>
              {/* The name leads. A row headed by a room code is a primary key, and the same room is
                  replayed all evening - "The Knife Fight" is what tells you which night this was. */}
              <strong>
                {matchName({
                  roomCode: m.room_code,
                  winnerTeam: m.winner_team,
                  duration: m.duration,
                  totalShots: m.total_shots,
                  stats: m.summary?.stats ?? [],
                  awards: m.summary?.awards ?? [],
                })}
              </strong>
              <span className="muted"> · </span>
              {m.winner_team === null ? (
                <span className="muted">draw</span>
              ) : (
                <span style={{ color: teamHex(m.winner_team) }}>{teamName(m.winner_team)} won</span>
              )}
              <div className="muted" style={{ fontSize: "0.68rem" }}>
                {when.toLocaleDateString()} {when.toLocaleTimeString()}
              </div>
            </span>
            <span className="muted" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {m.total_shots} shots
              <div style={{ fontSize: "0.68rem" }}>{m.duration ?? ""}</div>
            </span>
          </Link>
        );
      })}
      {matches.length > HISTORY_PREVIEW && (
        <button
          onClick={() => setShowAll((v) => !v)}
          style={{ alignSelf: "flex-start", fontSize: "0.72rem", marginTop: "0.3rem" }}
        >
          {showAll ? "Show fewer" : `Show all ${matches.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * One headline number, or one headline name.
 *
 * The size steps down for a value that is a name rather than a figure. "71%" and "Astel,
 * Naturalborn of the Void" are both values here, and the boss names run to thirty characters
 * against a tile nine rems wide - at the figure size a long one would either spill out of the
 * panel or drag the whole row taller than the three beside it.
 */
function BigStat({ label, value, sub, hint }: { label: string; value: string | number; sub?: string; hint?: string }) {
  const text = String(value);
  const size = typeof value === "number" || text.length <= 12 ? "1.9rem" : text.length <= 20 ? "1.15rem" : "1rem";

  return (
    <div className="panel stack" style={{ flex: "1 1 10rem", minWidth: "9rem", gap: "0.1rem" }} title={hint}>
      <span className="muted" style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        {label}
      </span>
      <span
        style={{
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1.15,
          color: "var(--accent)",
          // A long name breaks across lines rather than out of the panel.
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </span>
      {sub && <span className="muted" style={{ fontSize: "0.7rem" }}>{sub}</span>}
    </div>
  );
}

/**
 * Grid where each cell's brightness is its share of the busiest cell.
 *
 * Normalized against the max rather than the total, because with 100 cells every absolute share
 * is tiny - scaling to the hottest cell is what makes the pattern legible at all.
 */
function HeatGrid({ map }: { map: Heatmap }) {
  const { boardSize, counts, max } = map;

  return (
    <div style={{ overflowX: "auto" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `auto repeat(${boardSize}, minmax(1.5rem, 1fr))`,
          gap: 2,
          maxWidth: "34rem",
        }}
      >
        <div />
        {Array.from({ length: boardSize }, (_, c) => (
          <div key={`h${c}`} className="muted" style={{ textAlign: "center", fontSize: "0.65rem" }}>
            {COL_LETTERS[c] ?? c + 1}
          </div>
        ))}
        {/* Fragment with a key, not `<>`: the rows are a list, and the shorthand cannot carry one -
            keying the children inside it instead left React warning on every render. */}
        {Array.from({ length: boardSize }, (_, r) => (
          <Fragment key={`row${r}`}>
            <div className="muted" style={{ fontSize: "0.65rem", alignSelf: "center", paddingRight: 4 }}>
              {r + 1}
            </div>
            {Array.from({ length: boardSize }, (_, c) => {
              const n = counts[r * boardSize + c] ?? 0;
              const ratio = max > 0 ? n / max : 0;
              return (
                <div
                  key={`c${r}-${c}`}
                  title={`${COL_LETTERS[c] ?? c + 1}${r + 1} - ${n}`}
                  style={{
                    aspectRatio: "1",
                    borderRadius: 2,
                    // Brass at full intensity, fading to the board's own water color.
                    background: `color-mix(in srgb, var(--accent) ${Math.round(ratio * 100)}%, var(--cell))`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.6rem",
                    color: ratio > 0.55 ? "#241703" : "var(--text-dim)",
                  }}
                >
                  {n > 0 ? n : ""}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

type SquareSortKey = "name" | "attempts" | "hitRate" | "median" | "appeared" | "ignored" | "opened" | "fastest";

/**
 * Every number the almanac holds about a square, in one sortable table.
 *
 * This replaced three separate boards - the boss table, "most ignored" and "opening shots" - which
 * were three top-eight cuts of the same rows. A cut of eight is a headline, and headlines are what
 * the panels above are for; the question people actually bring to this table is about one square
 * they care about, and that square is almost never in anybody's top eight. Sorting answers both:
 * click Ignored and the old "most ignored" board is the top of the column, only it keeps going.
 */
const SQUARE_COLUMNS: SortColumn<SquareSortKey>[] = [
  {
    key: "name",
    label: "Square",
    align: "left",
    firstDirection: "asc",
    title: "The square as it reads on the board.",
  },
  {
    key: "attempts",
    label: "Shot at",
    align: "right",
    firstDirection: "desc",
    title: "Times this square has been taken, across every match on this board. One per trigger-pull, hit or miss.",
  },
  {
    key: "hitRate",
    label: "Hit %",
    align: "right",
    firstDirection: "desc",
    title: "Share of those shots that landed on an enemy ship. Says where people hide ships, not how hard the square is.",
  },
  {
    key: "median",
    label: "Median",
    sublabel: "on the clock",
    align: "right",
    firstDirection: "asc",
    title: "Median time into the match when this square falls. When people take it, not how long it takes to beat.",
  },
  {
    key: "appeared",
    label: "Seen",
    align: "right",
    firstDirection: "desc",
    title: "Boards this square has appeared on, whether or not anybody shot at it.",
  },
  {
    key: "ignored",
    label: "Ignored",
    align: "right",
    firstDirection: "desc",
    title: "Share of the boards it appeared on where nobody fired at it. 100% means it has never been taken.",
  },
  {
    key: "opened",
    label: "Opened",
    align: "right",
    firstDirection: "desc",
    title: "Times this square was the very first shot of a match.",
  },
  {
    // "Fastest" was a lie, and an expensive one: this is a position on the match clock, and the
    // panel directly below it ranks squares by how long the FIGHT took, in the same m:ss format.
    // Two numbers that look identical and mean opposite things. The heading now says which it is,
    // the way the Median column's "on the clock" already did.
    key: "fastest",
    label: "Earliest",
    sublabel: "on the clock",
    align: "left",
    firstDirection: "asc",
    title:
      "The earliest point in a match this square has ever fallen, and who took it. When it was reached, not how long the fight lasted.",
  },
];

/**
 * Ascending comparison for one column. The caller flips it for descending.
 *
 * The secondary keys are not decoration. Sorting on a rate alone puts whoever has the smallest
 * sample on top, so every rate falls back to the volume behind it - which keeps a square seen once
 * and skipped from outranking one skipped on thirty boards out of thirty.
 */
function compareSquares(a: SquareRow, b: SquareRow, key: SquareSortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "attempts":
      return a.attempts - b.attempts || (a.hitRate ?? 0) - (b.hitRate ?? 0);
    case "hitRate":
      return (a.hitRate ?? 0) - (b.hitRate ?? 0) || a.attempts - b.attempts;
    case "median":
      return (a.medianSeconds ?? 0) - (b.medianSeconds ?? 0) || b.timed - a.timed;
    case "appeared":
      return a.appeared - b.appeared || a.attempts - b.attempts;
    case "ignored":
      return a.missRate - b.missRate || a.appeared - b.appeared;
    case "opened":
      return a.opened - b.opened || a.appeared - b.appeared;
    case "fastest":
      return (a.fastest?.seconds ?? 0) - (b.fastest?.seconds ?? 0) || a.attempts - b.attempts;
  }
}

/** Columns where a square can simply have no number yet, which is not the same as having a low one. */
function squareMissing(row: SquareRow, key: SquareSortKey): boolean {
  if (key === "hitRate") return row.hitRate === null;
  if (key === "median") return row.medianSeconds === null;
  if (key === "fastest") return row.fastest === null;
  return false;
}

function SquaresTable({ rows }: { rows: SquareRow[] }) {
  const { sort, direction, sortBy } = useSortColumns(SQUARE_COLUMNS, "attempts");

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      // A square nobody has fired at yet sits at the bottom in BOTH directions rather than sorting
      // as though its time were zero - it would otherwise top every timing column it cannot answer.
      const am = squareMissing(a, sort);
      const bm = squareMissing(b, sort);
      if (am !== bm) return am ? 1 : -1;
      const cmp = compareSquares(a, b, sort);
      return direction === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, direction]);

  if (rows.length === 0) return null;

  const untouched = rows.filter((r) => r.fired === 0).length;

  return (
    <div className="panel stack" style={{ gap: "0.4rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Squares</h3>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {rows.length} squares seen{untouched > 0 ? ` · ${untouched} never taken` : ""}
        </span>
      </div>
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        Every square the board deals, shot at or not. Times are medians from when firing opens.
      </span>
      <div style={{ overflowX: "auto", maxHeight: "30rem", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <SortHeader columns={SQUARE_COLUMNS} sort={sort} direction={direction} onSort={sortBy} leading="#" />
          <tbody>
            {sorted.map((r, i) => {
              const num = { padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
              // Never taken on any board it appeared on. Dimmed rather than flagged: at the top of
              // the Ignored column it is the whole point, and everywhere else it is just context.
              const untaken = r.appeared > 0 && r.fired === 0;
              return (
                <tr key={r.name} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem", color: "var(--text-dim)" }}>{i + 1}</td>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem", color: untaken ? "var(--text-dim)" : undefined }}>
                    {r.name}
                  </td>
                  <td style={{ ...num, color: r.attempts === 0 ? "var(--text-dim)" : undefined }}>{r.attempts}</td>
                  <td style={num}>{r.hitRate !== null ? `${Math.round(r.hitRate * 100)}%` : "-"}</td>
                  <td style={num} title={r.timed > 0 ? `${r.timed} timed ${r.timed === 1 ? "shot" : "shots"}` : undefined}>
                    {r.medianSeconds !== null ? fmt(r.medianSeconds) : "-"}
                  </td>
                  {/* A dash rather than 0 when the board could not be rebuilt: the match's room row
                      is gone, so "seen 0 times" would be a claim the data cannot make. */}
                  <td style={{ ...num, color: r.appeared === 0 ? "var(--text-dim)" : undefined }}>
                    {r.appeared > 0 ? r.appeared : "-"}
                  </td>
                  <td style={{ ...num, color: untaken ? "var(--accent)" : r.missRate === 0 ? "var(--text-dim)" : undefined }}>
                    {r.appeared > 0 ? `${Math.round(r.missRate * 100)}%` : "-"}
                  </td>
                  <td style={{ ...num, color: r.opened === 0 ? "var(--text-dim)" : undefined }}>{r.opened}</td>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem" }} className="muted">
                    {r.fastest ? `${fmt(r.fastest.seconds)} - ${r.fastest.nickname}` : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        Click a heading to sort; click again to flip. Hover a heading for what the number means.
      </span>
    </div>
  );
}

type PaceSortKey = "name" | "matches" | "shots" | "median" | "average" | "best";

const PACE_COLUMNS: SortColumn<PaceSortKey>[] = [
  {
    key: "name",
    label: "Captain",
    align: "left",
    firstDirection: "asc",
    title: "Signed-in captains are grouped by account; guests by nickname, so two guests sharing a name share a row. Click a name for their full record on this board.",
  },
  {
    key: "matches",
    label: "Matches",
    align: "right",
    firstDirection: "desc",
    title: "Finished matches they have fired in on this board.",
  },
  {
    key: "shots",
    label: "Shots",
    align: "right",
    firstDirection: "desc",
    title: "Squares taken across all of them.",
  },
  {
    key: "median",
    label: "Pace",
    sublabel: "median",
    align: "right",
    firstDirection: "asc",
    title: `Square pace - the time from one square falling to the next, as a median across every square they have fired on this board. The same number the leaderboard shows. Needs ${MIN_GAPS_FOR_PACE} squares before it appears.`,
  },
  {
    key: "average",
    label: "Pace",
    sublabel: "average",
    align: "right",
    firstDirection: "asc",
    title: "The same figure as a mean, worked out inside each match and then averaged across matches, so time between sessions never counts. Every gap counts, including the pair a duo boss fills at once.",
  },
  {
    key: "best",
    label: "Best match",
    align: "right",
    firstDirection: "asc",
    title: "Their fastest single match by that average. Click it to open the match.",
  },
];

/** A pace row: the page's own average, plus the leaderboard's median where there is enough for one. */
interface PaceRow extends PlayerPace {
  median: number | null;
}

function comparePace(a: PaceRow, b: PaceRow, key: PaceSortKey): number {
  switch (key) {
    case "name":
      return a.nickname.localeCompare(b.nickname);
    case "matches":
      return a.matches - b.matches || a.shots - b.shots;
    case "shots":
      return a.shots - b.shots || a.matches - b.matches;
    case "median":
      // Nulls are handled before this is reached - see the sort below.
      return (a.median ?? 0) - (b.median ?? 0) || b.shots - a.shots;
    case "average":
      return a.secondsPerShot - b.secondsPerShot || b.shots - a.shots;
    case "best":
      return (a.bestMatch?.seconds ?? 0) - (b.bestMatch?.seconds ?? 0) || b.shots - a.shots;
  }
}

/**
 * Every captain's pace, both ways of measuring it.
 *
 * Two columns because they are genuinely different numbers and the gap between them is itself
 * readable: the median asks what a normal square looks like for someone, the average asks how their
 * whole evening went, and one twenty-minute wall moves the second and leaves the first alone. A
 * captain whose average sits far above their median met a bad boss; they did not have a slow night.
 */
function PaceTable({
  rows,
  medians,
  profiles,
  setId,
}: {
  rows: PlayerPace[];
  medians: Map<string, number>;
  profiles: Map<string, Profile>;
  setId: SquareSetId;
}) {
  const { sort, direction, sortBy } = useSortColumns(PACE_COLUMNS, "median");

  const sorted = useMemo(() => {
    const withMedian: PaceRow[] = rows.map((r) => ({ ...r, median: medians.get(r.key) ?? null }));
    return withMedian.sort((a, b) => {
      // A captain without a median yet sits at the bottom in BOTH directions rather than sorting as
      // though they were infinitely fast.
      if (sort === "median" && a.median !== b.median && (a.median === null || b.median === null)) {
        return a.median === null ? 1 : -1;
      }
      const cmp = comparePace(a, b, sort);
      return direction === "asc" ? cmp : -cmp;
    });
  }, [rows, medians, sort, direction]);

  if (rows.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.4rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Square pace</h3>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {sorted.length} {sorted.length === 1 ? "captain" : "captains"}
        </span>
      </div>
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        Time from one square falling to the next.
      </span>
      <div style={{ overflowX: "auto", maxHeight: "26rem", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <SortHeader columns={PACE_COLUMNS} sort={sort} direction={direction} onSort={sortBy} leading="#" />
          <tbody>
            {sorted.map((r, i) => {
              const num = { padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
              const p = profiles.get(r.key);
              return (
                <tr key={r.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem", color: "var(--text-dim)" }}>{i + 1}</td>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem" }}>
                    {/* Carries the set through, so a captain's page shows the same board's numbers
                        as the row that was clicked to reach it. */}
                    <Link
                      to={`/player/${encodeURIComponent(r.key)}?set=${encodeURIComponent(setId)}`}
                      style={{ display: "flex", alignItems: "center", gap: "0.4rem", textDecoration: "none", color: "var(--text)" }}
                    >
                      {p?.avatar_url && (
                        <img src={p.avatar_url} alt="" width={18} height={18} style={{ borderRadius: "50%" }} />
                      )}
                      <span>{profileName(p) ?? r.nickname}</span>
                    </Link>
                  </td>
                  <td style={num}>{r.matches}</td>
                  <td style={num}>{r.shots}</td>
                  <td style={{ ...num, color: r.median === null ? "var(--text-dim)" : undefined }}>
                    {r.median !== null ? fmt(r.median) : "-"}
                  </td>
                  <td style={num}>{fmt(r.secondsPerShot)}</td>
                  <td style={num}>
                    {r.bestMatch ? (
                      <Link to={`/match/${encodeURIComponent(r.bestMatch.matchKey)}`} style={{ textDecoration: "none" }}>
                        {fmt(r.bestMatch.seconds)}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        A median needs {MIN_GAPS_FOR_PACE} squares before it shows; the average appears from the
        first match. Guests are grouped by nickname, so two people using the same name share a row.
      </span>
    </div>
  );
}
