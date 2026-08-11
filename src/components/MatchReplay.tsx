import { useEffect, useMemo, useRef, useState } from "react";
import { BoardGrid, type CellVisual, type ShipOverlay } from "./BoardGrid";
import { cellLabel } from "../lib/battleshipLogic";
import { teamHex, teamName } from "../lib/teamColors";
import { replayStateAt, replayDuration, type Replay } from "../lib/replay";
import type { Region } from "../lib/challenges";
import type { DeepMark } from "../lib/deepWater";

interface Props {
  replay: Replay;
  /** Square name for a cell, as the recap already resolves it. */
  cellText?: (index: number) => { label: string; title?: string; region?: Region; color?: string } | null;
  /**
   * What was found hiding in the water, keyed by square (see lib/deepWater.ts).
   *
   * Drawn only where the board being drawn already reads that square as a miss, which is the same
   * rule the live recap uses and does two jobs here: it keeps a find off the board of a fleet that
   * was already sunk when it happened, and it makes the mark appear at the right point in the
   * playback for free - the square isn't a miss until the shot that found it has been played.
   */
  deepCells?: ReadonlyMap<number, DeepMark>;
}

/** Seconds of wall clock per shot at 1x. Slow enough to follow a sinking, quick enough to sit through. */
const STEP_MS = 750;
const SPEEDS = [0.5, 1, 2, 4];

/**
 * A finished match, played back.
 *
 * The scrubber runs over SHOTS rather than seconds. Every shot is then reachable and none can hide
 * inside a quiet stretch of a twenty-minute match, and it keeps working on matches archived before
 * shots were timed at all - those have an order but no clock. The match time is displayed alongside
 * for anyone who wants it.
 *
 * Opens on the final board, so the recap still shows what it always showed and the replay is
 * something you scrub back INTO rather than something you have to sit through first.
 */
export function MatchReplay({ replay, cellText, deepCells }: Props) {
  const total = replay.shots.length;
  const [cursor, setCursor] = useState(total);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [revealFleets, setRevealFleets] = useState(true);

  const state = useMemo(() => replayStateAt(replay, cursor), [replay, cursor]);
  const duration = useMemo(() => replayDuration(replay), [replay]);

  // Playback stops itself at the end rather than looping - a replay that restarts silently makes
  // the final board look like it was never reached.
  useEffect(() => {
    if (!playing) return;
    if (cursor >= total) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setCursor((c) => Math.min(total, c + 1)), STEP_MS / speed);
    return () => window.clearTimeout(timer);
  }, [playing, cursor, total, speed]);

  /** Space plays, arrows step. Skipped while the board grid has focus, which owns the arrow keys
   *  for its own cell cursor, and inside any field where the keys mean something else. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, .bg-grid")) return;
      if (e.key === " ") {
        // Space is how a focused button is pressed, so leave it alone there - stealing it would
        // turn a second press of Next into a play/pause.
        if (el?.closest("button")) return;
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") {
        setPlaying(false);
        setCursor((c) => Math.min(total, c + 1));
      } else if (e.key === "ArrowLeft") {
        setPlaying(false);
        setCursor((c) => Math.max(0, c - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  function jump(to: number) {
    setPlaying(false);
    setCursor(Math.max(0, Math.min(total, to)));
  }

  /** How far this team has got through the fleets it is shooting at. */
  function progressOf(team: number): { destroyed: number; shipsSunk: number; shipsTotal: number } {
    const enemies = state.teams.filter((t) => t.team !== team);
    const hull = enemies.reduce((n, t) => n + t.hullTotal, 0);
    const hit = enemies.reduce((n, t) => n + t.hullHit, 0);
    return {
      destroyed: hull > 0 ? hit / hull : 0,
      shipsSunk: enemies.reduce((n, t) => n + t.shipsSunk, 0),
      shipsTotal: enemies.reduce((n, t) => n + t.shipsTotal, 0),
    };
  }

  function visualFor(team: number): (index: number) => CellVisual {
    const own = state.teams.find((t) => t.team === team);
    return (index) => {
      const r = own?.cells.get(index);
      if (r === "sunk") return "sunk";
      if (r === "hit") return "hit";
      if (r === "miss") return "miss";
      return "empty";
    };
  }

  /** The finds this board can honestly carry at this point in the playback - see the prop. */
  function deepCellsFor(team: number): Map<number, DeepMark> | undefined {
    if (!deepCells) return undefined;
    const visual = visualFor(team);
    return new Map([...deepCells].filter(([cell]) => visual(cell) === "miss"));
  }

  function shipsFor(team: number): ShipOverlay[] {
    if (!revealFleets) return [];
    return replay.ships
      .filter((s) => s.team === team)
      .map((s) => ({
        row: s.startRow,
        col: s.startCol,
        size: s.size,
        horizontal: s.horizontal,
        shipName: s.name,
        colorHex: teamHex(team),
      }));
  }

  const atEnd = cursor >= total;
  const played = replay.shots.slice(0, cursor);

  return (
    <div className="stack" style={{ gap: "0.6rem", width: "100%" }}>
      <div className="panel stack" style={{ gap: "0.5rem" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Replay</h3>
          <span className="row" style={{ gap: "0.6rem", alignItems: "baseline" }}>
            {atEnd && (
              <span
                className="display"
                style={{ fontSize: "0.7rem", letterSpacing: "0.12em", color: "var(--accent)" }}
              >
                FINAL BOARD
              </span>
            )}
            <strong style={{ fontVariantNumeric: "tabular-nums", fontSize: "1.15rem" }}>
              {fmt(state.seconds)}
              {duration !== null && <span className="muted" style={{ fontSize: "0.8rem" }}> / {fmt(duration)}</span>}
            </strong>
          </span>
        </div>

        <span className="muted" style={{ fontSize: "0.72rem" }}>
          Shot {cursor} of {total}
          {!replay.exact && " · outcomes for this match come from the archived result column, which can't tell one defender from another"}
        </span>

        {/* Progress toward winning, straight off the board: a fleet with no hull left has lost.
            Deliberately not a win probability - two archived matches is not a prior, and a bar
            claiming 87% off that would be inventing confidence the record books don't have. */}
        <div className="stack" style={{ gap: "0.3rem" }}>
          {replay.teams.map((team) => {
            const p = progressOf(team);
            const own = state.teams.find((t) => t.team === team);
            return (
              <div key={team} className="stack" style={{ gap: "0.1rem" }}>
                <div className="row" style={{ justifyContent: "space-between", fontSize: "0.76rem", gap: "0.5rem" }}>
                  <span>
                    <strong style={{ color: teamHex(team) }}>{teamName(team)}</strong>
                    {own?.eliminated && <span className="muted"> · fleet lost</span>}
                  </span>
                  <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                    sank {p.shipsSunk}/{p.shipsTotal} · {Math.round(p.destroyed * 100)}% of enemy hull
                  </span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "var(--cell)", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${Math.round(p.destroyed * 100)}%`,
                      height: "100%",
                      background: teamHex(team),
                      transition: "width 120ms linear",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <Scrubber
          total={total}
          cursor={cursor}
          shots={replay.shots}
          onSeek={jump}
        />

        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={() => jump(0)} style={btn} disabled={cursor === 0}>
            Start
          </button>
          <button onClick={() => jump(cursor - 1)} style={btn} disabled={cursor === 0}>
            Prev
          </button>
          <button
            onClick={() => {
              // Pressing play on the final board rewinds first, so the button always does something.
              if (atEnd) setCursor(0);
              setPlaying((p) => !p);
            }}
            style={{ ...btn, borderColor: "var(--accent)", minWidth: "4.5rem" }}
          >
            {playing ? "Pause" : atEnd ? "Replay" : "Play"}
          </button>
          <button onClick={() => jump(cursor + 1)} style={btn} disabled={atEnd}>
            Next
          </button>
          <button onClick={() => jump(total)} style={btn} disabled={atEnd}>
            End
          </button>
          <span className="row" style={{ gap: "0.2rem", marginLeft: "auto", alignItems: "center" }}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                style={{ ...btn, borderColor: speed === s ? "var(--accent)" : undefined }}
              >
                {s}x
              </button>
            ))}
            <button
              onClick={() => setRevealFleets((v) => !v)}
              style={{ ...btn, marginLeft: "0.4rem", borderColor: revealFleets ? "var(--accent)" : undefined }}
              title="Hide the hulls to watch the match the way the attackers saw it"
            >
              Fleets
            </button>
          </span>
        </div>
      </div>

      <div
        className="row"
        style={{ gap: "1.2rem", flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start" }}
      >
        {replay.teams.map((team) => {
          const own = state.teams.find((t) => t.team === team);
          return (
            <BoardGrid
              key={team}
              boardSize={replay.boardSize}
              cellVisual={visualFor(team)}
              label={`${teamName(team)}${own?.shipsTotal ? ` - ${own.shipsTotal - own.shipsSunk}/${own.shipsTotal} afloat` : ""}`}
              ships={shipsFor(team)}
              sunkOrientation={own?.sunkOrientation}
              deepCells={deepCellsFor(team)}
              maxVh={52}
              maxVw={42}
              cellText={cellText}
            />
          );
        })}
      </div>

      <div className="row" style={{ gap: "0.75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="panel stack" style={{ flex: "1 1 18rem", minWidth: "16rem", gap: "0.3rem" }}>
          <h3 style={{ margin: 0 }}>Log</h3>
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            {cursor === 0 ? "Before the first shot." : "Newest first, up to the cursor."}
          </span>
          <ShotLog shots={played} boardSize={replay.boardSize} onPick={jump} />
        </div>

        {state.shooters.length > 0 && (
          <div className="panel stack" style={{ flex: "1 1 14rem", minWidth: "13rem", gap: "0.3rem" }}>
            <h3 style={{ margin: 0 }}>Scoreboard at this point</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                  <th style={{ textAlign: "left", fontWeight: 500, padding: "0.15rem 0.3rem" }}>Player</th>
                  <th style={{ fontWeight: 500, padding: "0.15rem 0.3rem" }}>Shots</th>
                  <th style={{ fontWeight: 500, padding: "0.15rem 0.3rem" }}>Hits</th>
                  <th style={{ fontWeight: 500, padding: "0.15rem 0.3rem" }}>Sunk</th>
                  <th style={{ fontWeight: 500, padding: "0.15rem 0.3rem" }}>Acc.</th>
                </tr>
              </thead>
              <tbody>
                {state.shooters.map((s) => (
                  <tr key={s.nickname} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                    <td style={{ textAlign: "left", padding: "0.15rem 0.3rem", color: teamHex(s.team) }}>{s.nickname}</td>
                    <td style={num}>{s.shots}</td>
                    <td style={{ ...num, color: "var(--hit)" }}>{s.hits}</td>
                    <td style={{ ...num, color: "var(--sunk)" }}>{s.sunk}</td>
                    <td style={num}>{s.shots > 0 ? `${Math.round((s.hits / s.shots) * 100)}%` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const btn = { fontSize: "0.75rem", padding: "0.2rem 0.55rem" } as const;
const num = { padding: "0.15rem 0.3rem", fontVariantNumeric: "tabular-nums" as const };

/**
 * The timeline, with a marker under every shot that sank something.
 *
 * The markers are what make scrubbing useful: they are the moments worth jumping to, and they're
 * placed by shot index so they line up with the slider's own thumb positions.
 */
function Scrubber({
  total,
  cursor,
  shots,
  onSeek,
}: {
  total: number;
  cursor: number;
  shots: Replay["shots"];
  onSeek: (to: number) => void;
}) {
  const sinkings = shots.filter((s) => s.sank.length > 0);

  return (
    <div className="stack" style={{ gap: 0 }}>
      <input
        type="range"
        min={0}
        max={total}
        value={cursor}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Shot"
        style={{ width: "100%", accentColor: "var(--accent)" }}
      />
      {/* Same inset as the slider's travel, so a marker sits under the thumb that reaches it. */}
      <div style={{ position: "relative", height: 10, margin: "0 0.5rem" }}>
        {sinkings.map((s) => (
          <button
            key={s.index}
            type="button"
            onClick={() => onSeek(s.index + 1)}
            title={`${fmt(s.seconds)} - ${s.nickname} sank ${s.sank.map((x) => x.ship).join(", ")}`}
            style={{
              position: "absolute",
              left: `${total > 0 ? ((s.index + 1) / total) * 100 : 0}%`,
              transform: "translateX(-50%)",
              padding: 0,
              width: 7,
              height: 7,
              minWidth: 0,
              borderRadius: "50%",
              border: "none",
              background: teamHex(s.sank[0].team),
              // The marker means "this fleet lost a ship", so it takes the victim's color.
              opacity: s.index + 1 <= cursor ? 1 : 0.45,
              cursor: "pointer",
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** The shots played so far, newest first, each one clickable to jump the cursor there. */
function ShotLog({
  shots,
  boardSize,
  onPick,
}: {
  shots: Replay["shots"];
  boardSize: number;
  onPick: (to: number) => void;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);

  // Newest first means the newest entry is at the top, so following along is a scroll to 0.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [shots.length]);

  if (shots.length === 0) return <span className="muted" style={{ fontSize: "0.8rem" }}>Nothing fired yet.</span>;

  return (
    <div ref={scroller} className="stack" style={{ gap: "0.3rem", maxHeight: "22rem", overflowY: "auto" }}>
      {[...shots].reverse().map((s) => {
        const sank = s.sank.length > 0;
        const hit = s.outcomes.some((o) => o.result !== "miss");
        return (
          <button
            key={s.index}
            type="button"
            onClick={() => onPick(s.index + 1)}
            className="row"
            style={{
              justifyContent: "space-between",
              gap: "0.5rem",
              fontSize: "0.8rem",
              textAlign: "left",
              background: "none",
              border: "none",
              borderTop: "1px solid var(--panel-border)",
              padding: "0.2rem 0",
              cursor: "pointer",
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span className="muted" style={{ fontSize: "0.68rem", fontVariantNumeric: "tabular-nums" }}>
                {fmt(s.seconds)}{" "}
              </span>
              <strong style={{ color: teamHex(s.team) }}>{s.nickname}</strong>
              <span className="muted"> - </span>
              <span>{s.challengeName ?? cellLabel(s.cellIndex, boardSize)}</span>
              <div className="muted" style={{ fontSize: "0.68rem" }}>
                {cellLabel(s.cellIndex, boardSize)}
                {sank && ` · sank the ${s.sank.map((x) => x.ship).join(" and ")}`}
              </div>
            </span>
            <span
              style={{
                whiteSpace: "nowrap",
                fontWeight: 600,
                color: sank ? "var(--sunk)" : hit ? "var(--hit)" : "var(--text-dim)",
              }}
            >
              {sank ? "SANK" : hit ? "HIT" : "miss"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function fmt(seconds: number | null): string {
  if (seconds === null) return "--:--";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
