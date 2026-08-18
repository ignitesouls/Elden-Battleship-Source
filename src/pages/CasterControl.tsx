import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { activeTeams, sunkCellOrientations, attackerTeamsByCell, cellLabel } from "../lib/battleshipLogic";
import { cellVisuals } from "../lib/cellVisuals";
import { challengesForRoom, rowSquareSet } from "../lib/challenges";
import { groupIntoShots } from "../lib/attackFeed";
import { deepWater, deepMarks } from "../lib/deepWater";
import { buildPlayerStats } from "../lib/matchReport";
import { buildRecordBook, type RecordEntry } from "../lib/recordBook";
import { recordChases, liveTallies } from "../lib/recordChase";
import { RecordChases } from "../components/RecordChases";
import { fetchParticipants } from "../lib/profiles";
import { teamName, teamHex } from "../lib/teamColors";
import { formatRoomCode } from "../lib/roomCode";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../components/BoardGrid";
import { useBoxSize } from "../hooks/useBoxSize";
import { SourceRow } from "../components/SourceRow";
import { SOURCE_SIZE, placeBoard } from "../lib/overlayBoardLayout";
import { squaresRevealed } from "../lib/overlayReveal";
import { useBattlePhaseName } from "../hooks/useBattlePhase";
import {
  useCastPublisher,
  DEFAULT_VIEW,
  MIN_ZOOM,
  MAX_ZOOM,
  MIN_OPACITY,
  type CastFleet,
  type CastView,
} from "../lib/overlayCast";
import "./CasterControl.css";
import "./OverlayBoard.css";
import "../components/BoardGrid.css";

/** On-screen size of the 1:1 monitor. The viewport inside it is always SOURCE_SIZE. */
const PREVIEW_PX = 420;

/**
 * The aim pad, in reading order: glyph, x, y, and the key that does the same thing.
 *
 * Kept in keypad order rather than in any other arrangement, because the whole point is that the
 * button under the mouse and the key under the finger are in the same place.
 */
const PAD: Array<[string, number, number, string]> = [
  ["↖", -1, -1, "7"],
  ["↑", 0, -1, "8"],
  ["↗", 1, -1, "9"],
  ["←", -1, 0, "4"],
  ["•", 0, 0, "5"],
  ["->", 1, 0, "6"],
  ["↙", -1, 1, "1"],
  ["↓", 0, 1, "2"],
  ["↘", 1, 1, "3"],
];

/**
 * The caster's desk: drives the /overlay-board browser source live.
 *
 * Everything here is one screen on a second monitor, operated while talking. That shapes it more
 * than anything else does - the view buttons are large and always in the same place, nothing is
 * behind a menu, and the preview is aimed by dragging it, because a caster following a fleet across
 * a board is doing one continuous motion rather than a series of decisions.
 *
 * What it sends, and why it can: this page runs in the caster's own logged-in session, so RLS hands
 * it every fleet exactly as it does the spectator page. The browser sources get their ships from
 * here rather than from the database - see lib/overlayCast.ts.
 */
export function CasterControl() {
  const { code } = useParams<{ code: string }>();
  const state = useRoom(code);
  const { publish, ready } = useCastPublisher(code);

  const [view, setView] = useState<CastView>({ ...DEFAULT_VIEW, names: true });
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();
  /** Where the gesture started, and the centre it started from. Null when nothing is being dragged. */
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  // Only to suppress the board's own glide while a drag is live - see .cast-dragging.
  const [dragging, setDragging] = useState(false);

  const room = state.room;
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.attacks, room);
  const teams = useMemo(() => activeTeams(state.players), [state.players]);

  /**
   * Everything in the water, the moment somebody finds it (see lib/deepWater.ts).
   *
   * No toggle and nothing to remember: it appears on the monitor and on stream by itself, which is the
   * only way any of it can land as the moment it is. A caster mid-sentence is not going to reach for a
   * button, and a reveal that has to be armed in advance isn't a reveal.
   */
  const deepCells = useMemo(
    () =>
      room
        ? deepMarks(deepWater(room, groupIntoShots(state.attacks, state.players), state.deepHides))
        : undefined,
    [room, state.attacks, state.players, state.deepHides]
  );

  /**
   * Records in play, across every fleet (see lib/recordChase).
   *
   * The book is read once on mount: it is built from finished matches, so nothing in it can change
   * while this one is running.
   */
  const [book, setBook] = useState<RecordEntry[]>([]);
  useEffect(() => {
    if (!room) return;
    void (async () => {
      const rows = await fetchParticipants();
      const set = rowSquareSet(room);
      setBook(buildRecordBook(rows.filter((r) => rowSquareSet(r) === set), [], set));
    })();
  }, [room]);

  const chases = useMemo(() => {
    if (!room || book.length === 0) return [];
    const shots = groupIntoShots(state.attacks, state.players);
    const userIdFor = (id: string | null) => state.players.find((p) => p.id === id)?.user_id ?? null;
    return recordChases(book, liveTallies(buildPlayerStats(state.players, shots), shots, userIdFor));
  }, [room, book, state.attacks, state.players]);

  /**
   * The fleets that go down the wire - only the ones actually being shown.
   *
   * A "results" frame carries no placements at all rather than carrying them and trusting the
   * source not to draw them. The board source is the thing on stream; if a bug there ever drew
   * something it shouldn't, the fix is for it never to have been sent.
   */
  const fleets: CastFleet[] = useMemo(() => {
    if (view.mode === "results") return [];
    const wanted = typeof view.mode === "number" ? [view.mode] : teams;
    return state.revealedFleets
      .filter((f) => wanted.includes(f.team) && f.placements && f.placements.length > 0)
      .map((f) => ({ team: f.team, placements: f.placements! }));
  }, [view.mode, teams, state.revealedFleets]);

  useEffect(() => {
    publish({ view, fleets });
  }, [publish, view, fleets]);

  /**
   * Moves the frame, in whole steps or fine nudges. Shared by the keyboard and the on-screen pad.
   *
   * A JUMP is a quarter of everything the zoom can reach: FOUR presses cross from one edge to the
   * opposite one, two from the middle to an edge, at any zoom. `1 - 1/zoom` is that whole pannable
   * span - at 2x the frame holds half the board, so the centre point ranges over the other half -
   * and the step is a quarter of it. At 1x the span is zero and nothing moves, correctly: the whole
   * board is already in frame.
   *
   * It was /8 first, on the reading that four presses meant centre-to-corner. That put a press at
   * an eighth of the pannable range - about two thirds of one square at 2x - which does not read as
   * a step at all. You had to hold the key down to see anything happen, which is the definition of
   * a nudge, and the arrows are already the nudge.
   *
   * A NUDGE is 6% of the FRAME, for following something that shifted a square or two. Measured
   * against the frame so it moves the same visible distance at every zoom; as a flat fraction of
   * the board it was a crawl at 1.2x and a lurch at 2x.
   */
  const panBy = useCallback((dx: number, dy: number, mode: "jump" | "nudge") => {
    setView((v) => {
      const step = mode === "jump" ? (1 - 1 / v.zoom) / 4 : 0.06 / v.zoom;
      return {
        ...v,
        cx: Math.min(1, Math.max(0, v.cx + dx * step)),
        cy: Math.min(1, Math.max(0, v.cy + dy * step)),
      };
    });
  }, []);

  const recentre = useCallback(() => setView((v) => ({ ...v, cx: 0.5, cy: 0.5 })), []);

  /**
   * Two keyboards' worth of aiming, for two different jobs.
   *
   * ARROWS nudge: 6% of the frame, for following something that moved a square or two.
   *
   * NUMBER KEYS step: in all eight directions, laid out the way a keypad is - 8 up, 2 down, 4/6
   * across, 7/9/1/3 diagonal, 5 back to the middle. The keypad stops being a set of directions and
   * becomes a map of the board, which is worth a great deal to somebody aiming it without looking
   * down. Distances are panBy's; see there.
   *
   * BOTH the numpad and the number ROW, by design. The keypad shape is what makes this good, but
   * plenty of casters are on a laptop or a tenkeyless board and have no numpad at all - and nothing
   * else on this page wants the digits, so there is no reason to make owning one a requirement. The
   * on-screen pad beside the zoom does the same job for a mouse.
   *
   * Matched on `e.code`, not `e.key`. With NumLock off the numpad reports Home/PageUp/ArrowLeft and
   * a caster is not going to check their NumLock light mid-match; `code` is the physical key
   * either way. It also means the top row works on layouts where those digits need a modifier.
   *
   * Ignored while typing in the URL boxes.
   */
  useEffect(() => {
    /** Unit vectors, x then y, screen-style (y grows downward). */
    const ARROWS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const KEYPAD: Record<string, [number, number]> = {
      "7": [-1, -1],
      "8": [0, -1],
      "9": [1, -1],
      "4": [-1, 0],
      "6": [1, 0],
      "1": [-1, 1],
      "2": [0, 1],
      "3": [1, 1],
    };
    /** "Numpad7" and "Digit7" both mean 7 here; anything else means nothing. */
    const digitOf = (code: string) =>
      code.startsWith("Numpad") ? code.slice(6) : code.startsWith("Digit") ? code.slice(5) : "";

    /**
     * Is the caster typing, or merely focused on something?
     *
     * This used to bail on ANY input element, which quietly broke the whole keyboard: setting the
     * zoom leaves focus on the slider, so every key pressed after touching it was swallowed - and
     * setting the zoom is precisely what you do immediately before wanting to aim. Only a field
     * that eats text should block the aiming keys; a range slider or a checkbox should not.
     */
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      if (el.tagName === "TEXTAREA") return true;
      if (el.tagName !== "INPUT") return false;
      const type = (el as HTMLInputElement).type;
      return !["range", "checkbox", "radio", "button", "submit", "reset", "color"].includes(type);
    }

    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target)) return;

      const digit = digitOf(e.code);

      // The middle key means the middle of the board. Nothing else it could sensibly do, and it
      // saves reaching for the Fit button when the zoom itself is fine.
      if (digit === "5") {
        e.preventDefault();
        recentre();
        return;
      }

      const jump = KEYPAD[digit];
      const nudge = ARROWS[e.key];
      if (!jump && !nudge) return;
      e.preventDefault();

      const [dx, dy] = jump ?? nudge;
      panBy(dx, dy, jump ? "jump" : "nudge");
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panBy, recentre]);

  if (!room) {
    return (
      <div className="panel stack" style={{ width: "min(460px, 100%)" }}>
        <h2 style={{ margin: 0 }}>No such room</h2>
        <p className="muted" style={{ margin: 0 }}>
          {code ? formatRoomCode(code) : "That room"} isn't open. The control page follows a live
          room, so there's nothing to drive yet.
        </p>
        <Link to="/">Return to harbor</Link>
      </div>
    );
  }

  const boardSize = room.board_size;
  const challenges = challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm);
  /** Whether the squares may be named yet - see lib/overlayReveal.ts. */
  const revealed = squaresRevealed(room.status, battlePhase);

  /**
   * Warn only when it actually bites: a placement view is selected and there is nothing to send.
   *
   * This used to key off revealedFleets alone, so it shouted "you can't read any fleet" the whole
   * time the caster was on Results only - a mode that deliberately sends no ships - and kept
   * shouting at anyone whose fleets simply hadn't loaded yet. A warning that is usually wrong is
   * one nobody reads on the day it is right.
   */
  const shipsMissing = view.mode !== "results" && fleets.length === 0;

  const shownTeams = typeof view.mode === "number" ? teams.filter((t) => t === view.mode) : teams;

  // Exactly the derivation the source makes - see the notes in OverlayBoard for the merge rule.
  const ships: ShipOverlay[] = shownTeams.flatMap((team) => {
    const fleet = fleets.find((f) => f.team === team);
    return (fleet?.placements ?? []).map((p) => ({
      row: p.startRow,
      col: p.startCol,
      size: room!.ship_defs[p.shipIndex]?.size ?? 1,
      horizontal: p.isHorizontal,
      shipName: room!.ship_defs[p.shipIndex]?.name ?? "Destroyer",
      colorHex: teamHex(team),
    }));
  });

  const relevant = state.attacks.filter((a) => shownTeams.includes(a.defender_team));
  const sunkCells = sunkCellOrientations(relevant, boardSize);
  /**
   * The attribution rings - the same derivation the source makes, from the same shots.
   *
   * Built from `relevant` rather than from every attack, so it answers the question the board in
   * front of it is actually asking: on a single-fleet view the rings describe the shots that fleet
   * has taken, not shots at a board nobody is looking at.
   */
  const firedBy = new Map(
    [...attackerTeamsByCell(relevant)].map(([cell, ts]) => [cell, ts.map(teamHex)])
  );
  // Resolved in one pass, exactly as the source does it - the monitor and the board it is driving
  // have to merge a square the same way. See lib/cellVisuals.
  const visuals = cellVisuals(relevant, sunkCells);
  const cellVisual = (index: number): CellVisual => visuals.get(index) ?? "empty";

  // Identical to the source's own sizing, because the monitor IS the source at display scale.
  const boardPx = Math.round(SOURCE_SIZE * view.zoom);

  /**
   * Panning, as grabbing the picture and sliding it.
   *
   * -- Why this replaced "centre on the point under the cursor" --
   *
   * The old version read the pointer's position and made THAT board point the new centre. Held
   * still, it should have been a no-op; in fact it was a feedback loop, because centring on a point
   * moves the board, which puts a different point under the same stationary cursor, which becomes
   * the next centre. At 2x a cursor parked a quarter of the way across walked the view to the far
   * edge in three or four moves - each one a visible jump, and the reason panning read as snapping
   * between quadrants rather than sliding.
   *
   * Measuring the pointer's TRAVEL instead has no such loop: the delta is against a fixed origin
   * captured at pointerdown, so the same cursor position always means the same view. It is also 1:1
   * in board pixels - move the mouse an inch, the board moves an inch - which is the property that
   * makes a pan feel like dragging rather than steering.
   *
   * Direction: the board follows the cursor (drag right, the board goes right and you see what was
   * off to the left), which is what every map does and what "grab" implies.
   */
  function panTo(e: { clientX: number; clientY: number }) {
    const start = drag.current;
    if (!start || stage.w <= 0 || stage.h <= 0) return;
    // Preview px -> the source's logical px -> a fraction of the whole board.
    const scale = PREVIEW_PX / SOURCE_SIZE;
    const dx = (e.clientX - start.x) / scale / stage.w;
    const dy = (e.clientY - start.y) / scale / stage.h;
    setView((v) => ({
      ...v,
      cx: Math.min(1, Math.max(0, start.cx - dx)),
      cy: Math.min(1, Math.max(0, start.cy - dy)),
    }));
  }

  const set = (patch: Partial<CastView>) => setView((v) => ({ ...v, ...patch }));

  const origin = `${window.location.origin}${import.meta.env.BASE_URL}`;
  const boardUrl = `${origin}#/overlay-board/${room.code}`;
  const timerUrl = `${origin}#/overlay-timer/${room.code}`;
  const keyUrl = `${origin}#/overlay-key/${room.code}`;

  // The square under the crosshair, for the readout. Clamped the same way the pan is.
  const framed = (c: number) => Math.min(boardSize - 1, Math.max(0, Math.floor(c * boardSize)));
  const centreCell = framed(view.cy) * boardSize + framed(view.cx);
  const zoomed = view.zoom > 1;

  return (
    <div className="cast">
      <div className="cast-head">
        <h2 style={{ margin: 0 }}>Board control - {formatRoomCode(room.code)}</h2>
        <span className={`cast-status${ready ? " cast-status-live" : ""}`}>
          {ready ? "connected" : "connecting..."}
        </span>
        {/* The monitor below is a true 1:1 of a 1000x1000 source, so there is nothing left to
            report back and nothing to be out of step with. */}
        <span className="cast-status">
          monitor {SOURCE_SIZE}x{SOURCE_SIZE}
        </span>
        <Link to={`/room/${room.code}`} style={{ fontSize: "0.85rem" }}>
          Back to the room
        </Link>
      </div>

      {shipsMissing && (
        <div className="panel" style={{ borderColor: "var(--accent)", fontSize: "0.85rem" }}>
          No ship positions are readable for this view, so the board is showing shots only. Fleets
          become visible once they're placed, and only to a session that's in the room - the ships
          come from your own login, not from the overlay.
        </div>
      )}

      <div className="cast-body">
        {/* Pinned to the monitor's own width, from the same constant that sizes it. Without this the
            column is as wide as its WIDEST child - and one of those children is a line of text that
            changes with every square the crosshair crosses, so panning made this column breathe in
            and out and shoved the controls beside it back and forth. See .cast-hint. */}
        <div className="cast-preview-wrap" style={{ width: PREVIEW_PX }}>
          {/* Drag to slide the stream view around; the wheel zooms. Both act on the same point
              under the cursor, so following a fleet is one gesture rather than a set of decisions. */}
          <div
            className={`cast-preview${dragging ? " cast-dragging" : ""}`}
            style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
              setDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => drag.current && panTo(e)}
            onPointerUp={(e) => {
              drag.current = null;
              setDragging(false);
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
            }}
            onWheel={(e) => {
              // 0.1 a notch over a range that is now only 1x to 2x - a quarter-step would be a
              // quarter of the whole range, which is a jump rather than a zoom.
              const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + (e.deltaY < 0 ? 0.1 : -0.1)));
              set({ zoom: Math.round(next * 100) / 100 });
            }}
            title="Drag to slide the stream view · wheel to zoom · 1-9 to step (4 presses edge to edge) · arrows to nudge"
          >
            {/*
              A 1:1 monitor, not a diagram of one.

              This viewport is exactly the source's 1000x1000, laid out by the same code, and then
              scaled down purely for display. So what a caster drags is literally the broadcast
              frame - no predicted rectangle, no reported source aspect, no second calculation to
              drift out of step with the first. Every one of those existed only to approximate the
              thing we can just show.
            */}
            <div
              className={`ovb-board cast-viewport${view.coords ? "" : " ovb-no-coords"}`}
              style={{
                width: SOURCE_SIZE,
                height: SOURCE_SIZE,
                transform: `scale(${PREVIEW_PX / SOURCE_SIZE})`,
                ["--ovb-cells" as string]: boardSize,
              }}
            >
              <div
                className="ovb-stage"
                ref={stageRef}
                style={{
                  left: placeBoard(stage.w, SOURCE_SIZE, view.cx),
                  top: placeBoard(stage.h, SOURCE_SIZE, view.cy),
                  // The monitor has to show the fade too, or the caster is judging legibility
                  // against a board that is more solid than the one on stream.
                  opacity: view.opacity,
                }}
              >
                <BoardGrid
                  boardSize={boardSize}
                  cellVisual={cellVisual}
                  ships={ships}
                  sunkOrientation={sunkCells}
                  firedBy={firedBy}
                  deepCells={deepCells}
                  // Matches the source exactly - the monitor has to BE the frame, not resemble it.
                  coordEdges="all"
                  maxVh={`${boardPx}px`}
                  maxVw={`${boardPx}px`}
                  cellText={
                    // The monitor has to BE the frame, and the source itself holds the names back
                    // until the match starts - so this does too, or the desk shows a board the
                    // stream isn't. It also keeps /cast from being a way round that rule: the page
                    // is linked publicly from the spectator bar. See lib/overlayReveal.ts.
                    view.names && revealed
                      ? (i) => {
                          const c = challenges[i];
                          if (!c) return null;
                          return { label: c.short ?? c.name, region: c.region, color: c.color };
                        }
                      : undefined
                  }
                />
              </div>
            </div>

            {/*
              What "Hide board" looks like from the desk.

              It used to look like nothing at all: the button changed, the monitor didn't, and the
              only way to know the board had left the stream was to go and look at the stream. A
              board hidden and then forgotten is a scene with a hole in it, so the monitor says so
              plainly.
            */}
            {!view.visible && <div className="cast-hidden-veil">Hidden on stream</div>}
          </div>
          <span className="muted cast-hint">
            Drag to slide · wheel to zoom · <strong>1-9</strong> (numpad or top row) step in 8
            directions, 4 presses edge to edge, 5 recentres · arrows nudge. On stream:{" "}
            <strong>
              {zoomed ? `${view.zoom.toFixed(1)}x around ${cellLabel(centreCell, boardSize)}` : "the whole board"}
            </strong>
            {/* The square under the crosshair, named in full - a caster reads this out, and the
                board itself only ever shows the shortened form. */}
            {zoomed && challenges[centreCell] && <> - {challenges[centreCell].name}</>}
          </span>
        </div>

        <div className="cast-panel">
          <section>
            <h3>View</h3>
            <div className="cast-buttons">
              <button
                className={view.mode === "results" ? "primary" : ""}
                onClick={() => set({ mode: "results" })}
                title="Shots only - no ship positions on stream"
              >
                Results only
              </button>
              <button
                className={view.mode === "all" ? "primary" : ""}
                onClick={() => set({ mode: "all" })}
                title="Every fleet's ships on one board"
              >
                All fleets
              </button>
              {teams.map((t) => (
                <button
                  key={t}
                  className={view.mode === t ? "primary" : ""}
                  onClick={() => set({ mode: t })}
                  style={{ color: teamHex(t) }}
                  title={`Only ${teamName(t)}'s ships`}
                >
                  {teamName(t)}
                </button>
              ))}
            </div>
            {view.mode !== "results" && room.status === "battle" && (
              <p className="cast-warn">
                Ships are on stream during a live match. Your call - just don't leave it up over a
                break.
              </p>
            )}
          </section>

          <section>
            <h3>Zoom</h3>
            <div className="cast-row">
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.1}
                value={view.zoom}
                onChange={(e) => set({ zoom: Number(e.target.value) })}
              />
              <span className="cast-zoom-value">{view.zoom.toFixed(1)}x</span>
              <button onClick={() => set({ zoom: 1, cx: 0.5, cy: 0.5 })} title="Show the whole board">
                Fit
              </button>
            </div>

            {/*
              The keypad, on screen.

              Laid out exactly as the keys are, so it doubles as the documentation for them - and it
              means aiming doesn't depend on owning a numpad, which a laptop or a tenkeyless board
              doesn't have. Disabled at 1x rather than hidden: at that zoom the whole board is in
              frame and there is genuinely nowhere to pan, and a control that greys out says that
              far better than one that silently does nothing.
            */}
            <div className="cast-pad" role="group" aria-label="Aim the stream view">
              {PAD.map(([label, dx, dy, key]) => (
                <button
                  key={key}
                  className="cast-pad-key"
                  disabled={view.zoom <= MIN_ZOOM}
                  onClick={() => (dx === 0 && dy === 0 ? recentre() : panBy(dx, dy, "jump"))}
                  title={
                    view.zoom <= MIN_ZOOM
                      ? "Zoom in first - at 1x the whole board is already in frame"
                      : `${dx === 0 && dy === 0 ? "Recentre" : "Step"} - keyboard ${key}`
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {/*
            Square names and coordinates used to be toggles here and are now simply always on.
            Neither was a decision anybody wanted to make mid-match: the names are the entire reason
            the zoom exists, and the coordinates are how a caster says where something is. Turning
            either off leaves a board that can only be talked about by pointing at it, which is the
            one thing a stream cannot do. (Both remain as ?names=0 / ?coords=0 on a pinned source,
            for a player running the board very small - see pinnedView.)
          */}
          {/* Every fleet's chases, with no team passed to recordChases - a caster is told everything,
              the same as with the things hiding in the water. This is the panel that gives them a
              reason to look up: "Aljex is two hits from the record" is a call they can build on. */}
          {chases.length > 0 && (
            <section>
              <h3>Records in play</h3>
              <RecordChases chases={chases} showTeams title="" />
            </section>
          )}

          <section>
            <h3>Board</h3>
            <div className="cast-buttons">
              <button
                className={view.visible ? "" : "danger"}
                onClick={() => set({ visible: !view.visible })}
                title="Blank the board source without removing it from the scene"
              >
                {view.visible ? "Hide board" : "Board hidden"}
              </button>
            </div>
          </section>

          {/*
            Fading the board is the middle setting between "up" and "gone", and it is the one that
            gets used: a caster wants to leave the board on screen through a boss fight rather than
            pulling it in and out every thirty seconds, and at half strength the squares still read
            while the fight underneath stays watchable. Hiding it outright is still there for the
            moments that need the screen back completely.
          */}
          <section>
            <h3>Transparency</h3>
            <div className="cast-row">
              <input
                type="range"
                min={MIN_OPACITY}
                max={1}
                step={0.05}
                value={view.opacity}
                onChange={(e) => set({ opacity: Number(e.target.value) })}
                title="How solid the board is on stream"
              />
              <span className="cast-zoom-value">{Math.round(view.opacity * 100)}%</span>
              <button onClick={() => set({ opacity: 1 })} title="Back to a solid board">
                Solid
              </button>
            </div>
            <p className="cast-note muted">
              The monitor above shows the same fade. It sits on this page's background rather than
              on gameplay, so judge it generously - footage underneath is busier than this is.
            </p>
          </section>

          <section>
            <h3>Browser sources</h3>
            <p className="muted cast-note">
              Add each as a Browser Source in OBS. The board follows this page; the timer and the
              colour key run on their own and need nothing.
            </p>
            <SourceRow label="Board" url={boardUrl} size="1000 x 1000" note="square - the board fits the shorter side" />
            <SourceRow label="Clock" url={timerUrl} size="1200 x 200" note="the match clock and every fleet's hulls" />
            {/* Sized for the full width of a 1080p canvas, because that is where it goes - a strip
                along the bottom edge. It scales down to whatever it's given, so the number is a
                starting point rather than a requirement. */}
            <SourceRow
              label="Key"
              url={keyUrl}
              size="1920 x 90"
              note="a thin strip for the bottom edge - add ?plate=0 for no backing"
            />
          </section>
        </div>
      </div>
    </div>
  );
}
