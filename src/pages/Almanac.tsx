import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchMatchFleets, fetchMatchEvents, fetchParticipants, fetchProfiles, type Profile } from "../lib/profiles";
import { fetchArchivedMatches, type ArchivedMatch } from "../lib/matchArchive";
import { buildScoutingReports } from "../lib/scouting";
import { CaptainCards } from "../components/CaptainCards";
import type { ParticipantRow } from "../lib/careerStats";
import { matchName } from "../lib/matchName";
import { teamName, teamHex } from "../lib/teamColors";
import { challengesForRoom, detectSquareSet, rowSquareSet, busiestSquareSet, squareSet, displaySquareSet, squareSetVariants, DEFAULT_SQUARE_SET, type SquareSetId } from "../lib/challenges";
import { SquareSetTabs } from "../components/SquareSetTabs";
import {
  placementHeatmap,
  shotHeatmap,
  bossStats,
  fastestKills,
  boardSizesPresent,
  playerPace,
  bossFrequency,
  matchShape,
  groupEventsByMatch,
  type MatchFleetRow,
  type MatchEventRow,
  type Heatmap,
} from "../lib/almanac";

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
  const mostMissed = useMemo(
    () => freq.filter((b) => b.appeared >= 2 && b.fired < b.appeared).sort((a, b) => b.missRate - a.missRate || b.appeared - a.appeared).slice(0, 8),
    [freq]
  );
  const openers = useMemo(() => freq.filter((b) => b.opened > 0).sort((a, b) => b.opened - a.opened).slice(0, 8), [freq]);

  const sizes = useMemo(() => boardSizesPresent(shownFleets, events), [shownFleets, events]);
  const boardSize = size ?? sizes[0] ?? 10;

  const map = useMemo(
    () => (mode === "ships" ? placementHeatmap(shownFleets, boardSize) : shotHeatmap(events, boardSize)),
    [mode, shownFleets, events, boardSize]
  );
  const bosses = useMemo(() => bossStats(events), [events]);
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
        <MatchHistory matches={archived.filter((m) => (m.square_set ?? DEFAULT_SQUARE_SET) === shownSet)} />

        {!hasData ? (
          <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
            <p className="muted" style={{ margin: 0 }}>
              Nothing charted yet - finish a match and the almanac starts filling in.
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
                <BigStat
                  label="Back-and-forth"
                  value={shape.avgBackAndForth.toFixed(1)}
                  sub={shape.busiest ? `most in one match: ${shape.busiest.changes}` : ""}
                  hint="Average times the shooting switched from one side to the other"
                />
                <BigStat
                  label="Board coverage"
                  value={`${Math.round(shape.boardCoverage * 100)}%`}
                  sub="of squares ever fired at"
                  hint="Share of the board that typically gets touched before a match ends"
                />
                <BigStat
                  label="Flawless wins"
                  value={shape.flawlessWins}
                  sub="won without losing a ship"
                  hint="Victories where the winning fleet finished completely intact"
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

            {bosses.length > 0 && (
              <div className="panel stack" style={{ gap: "0.4rem" }}>
                <h3 style={{ margin: 0 }}>Bosses</h3>
                <span className="muted" style={{ fontSize: "0.72rem" }}>
                  Times are median seconds after firing opens, counted from every shot - hit or miss, the boss took
                  just as long.
                </span>
                <div style={{ overflowX: "auto", maxHeight: "24rem", overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                        <th style={{ textAlign: "left", fontWeight: 500, padding: "0.2rem 0.4rem" }}>Boss</th>
                        <th style={{ fontWeight: 500, padding: "0.2rem 0.4rem" }}>Shot at</th>
                        <th style={{ fontWeight: 500, padding: "0.2rem 0.4rem" }}>Hit %</th>
                        <th style={{ fontWeight: 500, padding: "0.2rem 0.4rem" }}>Median</th>
                        <th style={{ textAlign: "left", fontWeight: 500, padding: "0.2rem 0.4rem" }}>Fastest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bosses.map((b) => {
                        const num = { padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
                        return (
                          <tr key={b.name} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                            <td style={{ textAlign: "left", padding: "0.2rem 0.4rem" }}>{b.name}</td>
                            <td style={num}>{b.attempts}</td>
                            <td style={num}>{Math.round(b.hitRate * 100)}%</td>
                            <td style={num} title={`${b.timed} timed ${b.timed === 1 ? "shot" : "shots"}`}>
                              {b.medianSeconds !== null ? fmt(b.medianSeconds) : "-"}
                            </td>
                            <td style={{ textAlign: "left", padding: "0.2rem 0.4rem" }} className="muted">
                              {b.fastest ? `${fmt(b.fastest.seconds)} - ${b.fastest.nickname}` : "-"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(pace.length > 0 || mostMissed.length > 0 || openers.length > 0) && (
              <div className="row" style={{ gap: "0.75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                {pace.length > 0 && (
                  <RankList
                    title="Square pace"
                    caption="Mean seconds between a player's own shots. Lower is faster."
                    items={pace.slice(0, 8).map((p) => ({
                      key: p.nickname,
                      primary: p.nickname,
                      secondary: `${p.shots} shots · ${p.matches} matches`,
                      value: fmt(p.secondsPerShot),
                    }))}
                  />
                )}
                {mostMissed.length > 0 && (
                  <RankList
                    title="Most ignored"
                    caption="Appeared on the board but was never fired at."
                    items={mostMissed.map((b) => ({
                      key: b.name,
                      primary: b.name,
                      secondary: `skipped on ${b.appeared - b.fired} of ${b.appeared} boards`,
                      value: `${Math.round(b.missRate * 100)}%`,
                    }))}
                  />
                )}
                {openers.length > 0 && (
                  <RankList
                    title="Opening shots"
                    caption="Most often the very first square of a match."
                    items={openers.map((b) => ({
                      key: b.name,
                      primary: b.name,
                      secondary: `${b.appeared} appearances`,
                      value: `x${b.opened}`,
                    }))}
                  />
                )}
              </div>
            )}

            {records.length > 0 && (
              <div className="panel stack" style={{ gap: "0.25rem" }}>
                <h3 style={{ margin: 0 }}>Quickest squares on record</h3>
                <span className="muted" style={{ fontSize: "0.7rem" }}>
                  How long the fight took - timed from that captain's previous square, whether or not a ship was
                  hiding under this one. Opening squares belong to first blood instead.
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
function MatchHistory({ matches }: { matches: ArchivedMatch[] }) {
  const [showAll, setShowAll] = useState(false);
  if (matches.length === 0) return null;

  const shown = showAll ? matches : matches.slice(0, HISTORY_PREVIEW);

  return (
    <div className="panel stack" style={{ gap: "0.3rem" }}>
      <h3 style={{ margin: 0 }}>Match history</h3>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {matches.length} finished {matches.length === 1 ? "match" : "matches"} - open one for its full recap, then scrub
        the whole match back shot by shot.
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

function BigStat({ label, value, sub, hint }: { label: string; value: string | number; sub?: string; hint?: string }) {
  return (
    <div className="panel stack" style={{ flex: "1 1 10rem", minWidth: "9rem", gap: "0.1rem" }} title={hint}>
      <span className="muted" style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        {label}
      </span>
      <span style={{ fontSize: "1.9rem", fontWeight: 700, lineHeight: 1.1, color: "var(--accent)" }}>{value}</span>
      {sub && <span className="muted" style={{ fontSize: "0.7rem" }}>{sub}</span>}
    </div>
  );
}

function RankList({
  title,
  caption,
  items,
}: {
  title: string;
  caption: string;
  items: Array<{ key: string; primary: string; secondary: string; value: string }>;
}) {
  return (
    <div className="panel stack" style={{ flex: "1 1 15rem", minWidth: "14rem", gap: "0.3rem" }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      <span className="muted" style={{ fontSize: "0.7rem" }}>{caption}</span>
      {items.map((it, i) => (
        <div key={it.key} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.8rem" }}>
          <span style={{ minWidth: 0 }}>
            <span className="muted">{i + 1}. </span>
            <strong>{it.primary}</strong>
            <div className="muted" style={{ fontSize: "0.68rem" }}>{it.secondary}</div>
          </span>
          <strong style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {it.value}
          </strong>
        </div>
      ))}
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
        {Array.from({ length: boardSize }, (_, r) => (
          <>
            <div key={`r${r}`} className="muted" style={{ fontSize: "0.65rem", alignSelf: "center", paddingRight: 4 }}>
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
          </>
        ))}
      </div>
    </div>
  );
}
