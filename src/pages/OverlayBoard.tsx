import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { fetchOverlayFleet, type OverlayFleet } from "../lib/overlayFleet";
import { useBoxSize } from "../hooks/useBoxSize";
import { activeTeams, sunkCellOrientations, attackerTeamsByCell } from "../lib/battleshipLogic";
import { cellVisuals } from "../lib/cellVisuals";
import { challengesForRoom, igonAnchor } from "../lib/challenges";
import { groupIntoShots } from "../lib/attackFeed";
import { deepWater, deepMarks } from "../lib/deepWater";
import { teamHex } from "../lib/teamColors";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../components/BoardGrid";
import {
  useCastReceiver,
  DEFAULT_VIEW,
  STALE_AFTER_MS,
  MIN_ZOOM,
  MAX_ZOOM,
  readOpacity,
  type CastView,
} from "../lib/overlayCast";
import { readTextSize, OVERLAY_MAX_FONT } from "../lib/overlayText";
import { squaresRevealed } from "../lib/overlayReveal";
import { markedAttacks, spotSet } from "../lib/overlayMarkers";
import { useBattlePhaseName } from "../hooks/useBattlePhase";
import { SOURCE_SIZE, placeBoard } from "../lib/overlayBoardLayout";
import "./Overlay.css";
import "./OverlayTiers.css";
import "./OverlayBoard.css";

/**
 * A view fixed by the URL, for a source with nobody driving it.
 *
 * The caster's board is aimed live from their control page, which is the right model for one person
 * running a broadcast. A PLAYER streaming their own match has no second monitor and no desk - they
 * want one board, framed once, that then looks after itself. So the same source can be pinned by
 * query string instead:
 *
 *     ?team=2            just that fleet's board (shots against them)
 *     ?team=2&fire=1     turned around: that fleet's own shots, i.e. the board they play off
 *     ?zoom=1.4&cx=.3&cy=.5   framed on part of it, held there
 *     ?names=0 ?coords=0
 *     ?opacity=0.5       see-through, so gameplay reads underneath it
 *     ?text=1.5          square names and coordinates drawn half again as large
 *     ?key=ABC123        draw the owner's OWN hulls - see the fleet fetch below
 *     ?pin=1             every fleet, but still pinned - see below
 *
 * `pin` exists because "all fleets, unattended" and "whatever the caster is doing" would otherwise
 * be the same URL (no parameters at all), and they are opposite intentions.
 *
 * A pinned source deliberately IGNORES the cast channel. Both kinds of source can be pointed at the
 * same room at once - a caster running board control while a player streams their own fleet - and a
 * URL that states what it wants must not be quietly repainted by somebody else's controller.
 *
 * Returns null when the URL asks for nothing, which is what puts the source back under the
 * caster's control.
 */
function pinnedView(params: URLSearchParams): CastView | null {
  // `text` is deliberately NOT in this list. Every other parameter here says what the board is
  // looking at, which is the thing a controller would otherwise be deciding; text size says how big
  // it is drawn, which no controller sends and nobody else has an opinion about. Including it would
  // mean a caster who typed ?text= onto their own source had silently pinned it and lost their
  // control page - a setting about legibility must not be able to disconnect anything.
  const keys = ["pin", "team", "fire", "zoom", "cx", "cy", "names", "coords", "opacity", "key"];
  if (!keys.some((k) => params.get(k) !== null)) return null;

  const num = (key: string, fallback: number, lo: number, hi: number) => {
    const raw = params.get(key);
    if (raw === null || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };

  const team = params.get("team");
  const teamNum = team !== null && team !== "" ? Number(team) : NaN;

  return {
    ...DEFAULT_VIEW,
    mode: Number.isInteger(teamNum) ? teamNum : "results",
    zoom: num("zoom", 1, MIN_ZOOM, MAX_ZOOM),
    cx: num("cx", 0.5, 0, 1),
    cy: num("cy", 0.5, 0, 1),
    names: params.get("names") !== "0",
    coords: params.get("coords") !== "0",
    opacity: readOpacity(params),
    visible: true,
  };
}

/**
 * The board on its own, as an OBS Browser Source, driven live by a caster's control page.
 *
 * -- Why this draws the REAL board ------------------------------------------------------------
 *
 * Built on BoardGrid - the same component the players are looking at - rather than on OverlayGrid.
 * OverlayGrid is very good at what it was written for: a 12px-a-cell grid tucked in the corner of a
 * streamer's own HUD, where a colour band is all that can survive and square names are refused
 * outright below 48px because they'd be mush. Every one of those decisions is wrong for a caster's
 * main stage, which is a full-size board somebody is pointing at and reading out.
 *
 * Using the players' own board means the stream shows exactly what they see: names fitted per
 * square rather than at one shared size, tinted by region or keyword the same way, hulls as the
 * same sprites, the same hit and sunk markers. A viewer looking at the stream and a player looking
 * at their screen are looking at the same object, which is the whole job.
 *
 * -- Zoom is cell size, not a scale transform -------------------------------------------------
 *
 * The board is genuinely rendered larger and then panned inside the frame, rather than being drawn
 * small and blown up. Transform-scaled text is resampled and a stream encoder finishes it off.
 * BoardGrid sizes itself from maxVh/maxVw, so a zoom is just a bigger number handed to it, and its
 * own per-square fitting recalculates at the new size.
 *
 * The offsets are MEASURED. The rendered board is never exactly `boardSize * cell` - coordinate
 * gutters, gaps and borders all land inside it - and computing it was what put the board in the
 * corner with half of it cropped in the first version.
 */

export function OverlayBoard() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const debug = params.get("debug") === "1";
  /**
   * How large the names are drawn, over what the squares would choose - see lib/overlayText.
   *
   * Read straight from the URL rather than off the cast view, so it works the same on a player's
   * pinned source and on a caster-driven one. It is the only thing about this board that both kinds
   * of source configure the same way, which is the point: it is about the audience, not the match.
   */
  const textSize = readTextSize(params);
  const state = useRoom(code);
  /**
   * A URL-pinned source doesn't join the cast channel at all.
   *
   * Not merely ignoring the frames: not subscribing means a player's own board source can't be
   * repainted by a caster who happens to be running board control on the same room, and doesn't
   * announce itself or report its size to somebody else's desk. useCastReceiver already treats a
   * missing code as "nothing to subscribe to", so passing undefined is the whole mechanism.
   */
  const pinned = pinnedView(params);
  const { message: cast, report, linkEpoch } = useCastReceiver(pinned ? undefined : code);

  /**
   * The owner's own fleet, for a pinned source that asked for it with ?key=.
   *
   * Same credential and same RPC the HUD overlay's spoiler mode uses: this is an anonymous session
   * belonging to no team, so RLS gives it nothing from `fleets` directly, and the rejoin code is
   * what the overlay_fleet function accepts instead. It can only ever return the fleet that code
   * belongs to, which is what makes "show my ships" safe to offer as a plain yes/no - there is no
   * way to point it at somebody else's board.
   *
   * Re-fetched when the room's status changes: placements are replaced wholesale on a rematch, and
   * a source left running overnight would otherwise still be drawing last night's fleet.
   */
  const ownKey = pinned ? (params.get("key") ?? "") : "";
  const [ownFleet, setOwnFleet] = useState<OverlayFleet | null>(null);
  const roomStatus = state.room?.status;
  useEffect(() => {
    if (!code || !ownKey) {
      setOwnFleet(null);
      return;
    }
    let cancelled = false;
    void fetchOverlayFleet(code, ownKey).then((f) => {
      if (!cancelled) setOwnFleet(f);
    });
    return () => {
      cancelled = true;
    };
  }, [code, ownKey, roomStatus]);
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();

  // Same transparency opt-out the other overlay makes - see the note there about :root.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  // Tell the controller how big this source is, so its preview rectangle means something. Re-sent
  // on every (re)join as well as on resize: the first report can easily be made before the channel
  // finishes subscribing, and the size never changes again to trigger a retry.
  //
  // Keyed to the link rather than to the last frame's stamp. Both cover the race, but a frame
  // stamp changes on every heartbeat, so that version sent the controller an unchanged size four
  // times every minute per source, for the whole broadcast.
  useEffect(() => {
    if (frame.w > 0 && frame.h > 0) report({ w: frame.w, h: frame.h });
  }, [frame.w, frame.h, report, linkEpoch]);

  const room = state.room;
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.attacks, room);
  if (!room) return null;

  // A URL that pins the view outranks the channel entirely - see pinnedView. Nothing is "stale"
  // in that case either: there is no controller to have gone quiet.
  const view: CastView = pinned ?? cast?.view ?? DEFAULT_VIEW;
  /**
   * How large the names are drawn, from whichever end is actually in charge.
   *
   * A URL that says `?text=` means it - that is a streamer who has set this source up by hand, and
   * a controller must not override a value somebody typed. Everything else takes the caster's
   * slider, falling back to full fill.
   *
   * `readTextSize` returns 1 for a URL that didn't ask, which is indistinguishable from a URL that
   * asked for 1 - so the raw parameter is tested rather than its parsed value. Otherwise every
   * unconfigured source would look like it was demanding full fill and would ignore the desk.
   */
  const askedText = params.get("text");
  const drawnText = askedText !== null && askedText !== "" ? textSize : (view.text ?? 1);
  const stale = !pinned && cast !== null && Date.now() - cast.at > STALE_AFTER_MS;
  if (!view.visible) return null;

  const boardSize = room.board_size;
  // Blank water until the shooting starts, exactly as the players' own placement board is - see
  // lib/overlayReveal.ts. A captain must not be able to read the squares off their own source
  // while they still have hulls in hand.
  const revealed = squaresRevealed(room.status, battlePhase);
  const teams = activeTeams(state.players);
  const challenges = challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm);
  const shown = typeof view.mode === "number" ? teams.filter((t) => t === view.mode) : teams;

  /**
   * Which end of the shooting this board is drawn from.
   *
   * `?fire=1` alongside `?team=` turns the board around: instead of the shots that landed ON that
   * fleet, it draws the shots that fleet FIRED, wherever they landed - which is the board that
   * fleet's own players are looking at while they play. See room/BattlePhase's fireBoard, which
   * this is deliberately a copy of: a streamer's source should show the board they are playing,
   * and the damage they have TAKEN is what the small fleet panel is for.
   *
   * Needs a fleet to be about, so it is ignored without one. `?team=` already pins the source (see
   * pinnedView), which is what this has to be - it states what it wants, and no caster's control
   * page should be able to repaint a board somebody is playing off.
   */
  const fireTeam = params.get("fire") === "1" && typeof view.mode === "number" ? view.mode : null;

  /**
   * The shots this board is about, from whichever end it is drawn.
   *
   * Defence is every shot aimed at a shown fleet. Attack is every shot ONE fleet fired, wherever it
   * landed - so on a board with three opponents it is still one fleet's hunt, which is exactly what
   * its players see. Everything below is written against `relevant` and does not care which it got.
   */
  const relevant =
    fireTeam !== null
      ? state.attacks.filter((a) => a.attacker_team === fireTeam)
      : state.attacks.filter((a) => shown.includes(a.defender_team));
  // Only the shots the controller is letting draw a result. Shared with the control page's monitor
  // so the two cannot drift - see lib/overlayMarkers, which is also where the attacker/defender
  // distinction is spelled out. A pinned source inherits DEFAULT_VIEW here, i.e. every marker.
  const marked = markedAttacks(relevant, view);
  // From `marked`: wreckage is a result like any other, and a hull sunk by a fleet whose markers
  // are hidden must not leave its ship drawn across the board.
  const sunkCells = sunkCellOrientations(marked, boardSize);

  /**
   * The hulls on the board, which are a different thing at each end.
   *
   * Defending, they are the source owner's OWN fleet, drawn from the one place a pinned board is
   * allowed to read: the fleet its own ?key= unlocked. It never reads the cast channel's fleets, so
   * a caster revealing every fleet in the same room cannot leak an opponent's ships onto a player's
   * stream - the player doesn't have to think about what anyone else is doing.
   *
   * Attacking, they are WRECKS: enemy hulls this fleet has sunk, each in its owner's colour. Those
   * come off the sunk_* fields of the resolved attack row - a public record of a ship that is
   * already gone - and never from reading anybody's private fleet. A fire board that drew live
   * hulls would be a wallhack; one that draws the wreckage is a scoreboard.
   *
   * Both cases put several fleets' hulls on one grid where they cross. Each fleet fires at the same
   * named coordinates, so one grid is the honest picture and two hulls sharing a square is
   * information rather than a collision. They are half-opaque and blend; the square's name sits
   * above them, because the name is the thing being talked about.
   */
  const ships: ShipOverlay[] =
    fireTeam !== null
      ? marked
          .filter((a) => a.result === "sunk" && a.sunk_start_row !== null)
          .map((a) => ({
            row: a.sunk_start_row!,
            col: a.sunk_start_col!,
            size: a.sunk_ship_size!,
            horizontal: a.sunk_horizontal!,
            shipName: a.sunk_ship_name!,
            colorHex: teamHex(a.defender_team),
          }))
      : shown.flatMap((team) => {
          const fleet = pinned
            ? ownFleet?.team === team
              ? ownFleet
              : undefined
            : cast?.fleets.find((f) => f.team === team);
          return (fleet?.placements ?? []).map((p) => ({
            row: p.startRow,
            col: p.startCol,
            size: room.ship_defs[p.shipIndex]?.size ?? 1,
            horizontal: p.isHorizontal,
            shipName: room.ship_defs[p.shipIndex]?.name ?? "Destroyer",
            colorHex: teamHex(team),
          }));
        });

  /**
   * Whose shot each square was, in each fleet's colour - drawn as a ring around the square.
   *
   * Worked out here from the public shot log rather than sent down the cast channel, exactly as the
   * things hiding in the water are: it is derived from rows every spectator can already read, so a
   * pinned source with no controller behind it shows the same rings as a caster-driven one, and the
   * cast protocol gains nothing to go stale.
   *
   * Dropped entirely on a fire board. Every shot on it was fired by the same fleet, so a ring round
   * every square in one colour answers a question nobody asked and costs the square's name the
   * contrast it needs. The players' own board draws none either.
   */
  const firedBy =
    fireTeam !== null
      ? undefined
      : new Map([...attackerTeamsByCell(relevant)].map(([cell, ts]) => [cell, ts.map(teamHex)]));

  /**
   * What is hiding in the water (see lib/deepWater.ts).
   *
   * A caster's board holds nothing back, and is handed every fleet's shots rather than `relevant`:
   * a find belongs to the sea rather than to any one board, and the shot that turned it up may well
   * have been aimed at a fleet this source isn't showing.
   *
   * A fire board is the opposite, and has to be. It is one crew's board, so it gets that crew's
   * team and the squares that crew has fired at - which is the whole visibility rule: they see what
   * they found and nothing anybody else found. Without the fired-cell set, four squares would
   * appear the moment the sleeper wakes, including squares this crew has never shot at, which would
   * hand a streaming player "there is no hull here" for free on their own overlay.
   */
  const deep = deepWater(room, groupIntoShots(state.attacks, state.players), state.deepHides, igonAnchor(room));
  const deepCells =
    fireTeam !== null
      ? deepMarks(deep, fireTeam, new Set(relevant.map((a) => a.cell_index)))
      : deepMarks(deep);

  // One walk of the shown fleets' shots rather than one filter of the whole log per square - which
  // on a source re-rendering off the cast heartbeat was the most expensive thing this page did.
  // See lib/cellVisuals for the precedence, which is the same merge described above.
  const visuals = cellVisuals(marked, sunkCells);
  const cellVisual = (index: number): CellVisual => visuals.get(index) ?? "empty";

  // Square as big as the shorter side of the source, then multiplied by the zoom. A board is
  // square, so a wide source simply leaves margin either side at 1x - see the size note on the
  // control page.
  const fit = frame.w > 0 ? Math.min(frame.w, frame.h) : SOURCE_SIZE;
  const boardPx = Math.round(fit * view.zoom);

  return (
    <div
      className={`ovb-frame ovb-board ovl-fade${view.coords ? "" : " ovb-no-coords"}`}
      ref={frameRef}
      // Board size as a CSS variable so the stylesheet can recompute the cell font from the real
      // board size - BoardGrid's own figure is capped at 1600px. See OverlayBoard.css.
      // --ovb-text carries the same multiplier the names get to the COORDINATE labels, which are
      // plain CSS rather than fitted per square and so can't take it as a prop.
      style={{ ["--ovb-cells" as string]: boardSize, ["--ovb-text" as string]: drawnText }}
    >
      {/* Transparency is THREE alphas off one slider rather than a flat opacity on this element -
          see the tier block in OverlayBoard.css, which derives the other two from this one in CSS so
          the relationship between them lives next to the paint it governs.

          A flat opacity faded the water, the names and the frame at the same rate, which is the one
          thing a faded board must not do: at 25% it still has to be a BOARD, and a viewer still has
          to be able to read the square the caster just called. So the blue takes the slider whole,
          the names and shots fade half as far, and the frame and grid lines barely move at all.

          Still on the STAGE rather than the frame, because the stale badge and the debug readout are
          diagnostics about the source itself - a frozen board must not be hardest to notice exactly
          when it has been left faint and forgotten.

          `?? 1` because a frame from a controller predating this field carries no opacity at all. */}
      <div
        className="ovb-stage ovl-fade-stage"
        ref={stageRef}
        style={{
          left: placeBoard(stage.w, frame.w, view.cx),
          top: placeBoard(stage.h, frame.h, view.cy),
          ["--ovl-a-bg" as string]: view.opacity ?? 1,
        }}
      >
        <BoardGrid
          boardSize={boardSize}
          cellVisual={cellVisual}
          ships={ships}
          sunkOrientation={sunkCells}
          // Who fired at each square, in that fleet's colour. Always on: a composited board that
          // cannot say whose shot a square was is only half a board, and it is not a setting anybody
          // would want to reach for mid-match. See attackerTeamsByCell.
          firedBy={firedBy}
          // What the caster is pointing at. Never set on a pinned source: it arrives on the cast
          // frame only, so a player's own board can't be lit up by somebody else's desk.
          spotCells={spotSet(view)}
          // Whose shot, or whose hull. Undefined leaves the light white, which is what a caster
          // simply pointing at a square should look like.
          spotColor={view.spotColor ?? undefined}
          // Drawn the moment any of it is found - see lib/deepWater.ts. This source needs no frame
          // from the desk to know: the finds are in the public log, so it works them out for itself
          // and they appear on stream by themselves.
          deepCells={deepCells}
          // Top and left only - BoardGrid's default, so there is no prop here.
          //
          // It did draw all four. The argument was that a viewer can't point at the screen and a
          // zoomed board can carry its top-left labels out of frame, so a label near the square
          // beats one in the far corner. What that missed is that the far edges are two more gutter
          // tracks charged to the same square the source was given: they cost cell size on every
          // board to answer a problem only a panned one has, and they put a second copy of every
          // label into a frame already carrying 100+ square names, a clock and a key. Two edges is
          // what a board looks like, and it is what the caster asked for.
          // Both bounds the same, because BoardGrid resolves min(maxVh, maxVw, 1600px) to a square.
          maxVh={`${boardPx}px`}
          maxVw={`${boardPx}px`}
          // Legibility for a viewer, not for the person at the keyboard - see the two notes above.
          textBoost={drawnText}
          maxCellFont={OVERLAY_MAX_FONT}
          // Names grow to fill their square rather than stopping at the app's ratio - the whole
          // reason this source exists is to be read from across a room. See lib/textFit.
          growText
          cellText={
            view.names && revealed
              ? (i) => {
                  const c = challenges[i];
                  if (!c) return null;
                  // Region and colour included so the stream tints squares exactly as the players'
                  // own boards do - the key along the bottom of their screen reads true here too.
                  return { label: c.short ?? c.name, region: c.region, color: c.color };
                }
              : undefined
          }
        />
      </div>

      {/* Deliberately visible ON STREAM rather than only in the control page. A frozen board that
          looks live is the failure that actually costs a caster something, and the person who can
          fix it is the one looking at the stream. */}
      {stale && <div className="ovb-stale">board control disconnected</div>}

      {/*
        ?debug=1 - the numbers this layout is actually built from.
        Sizing here depends on measurements only the browser can make, and reasoning about them from
        the outside has been wrong repeatedly. `frame` is the source, `board` is what the grid really
        rendered as, `want` is what was asked for: if frame isn't the source's real pixel size, or
        board doesn't track want, that says which end is broken without another round of guessing.
      */}
      {debug && (
        <div className="ovb-debug">
          frame {Math.round(frame.w)}x{Math.round(frame.h)} · board {Math.round(stage.w)}x
          {Math.round(stage.h)} · want {boardPx} · zoom {view.zoom.toFixed(2)} · offset{" "}
          {Math.round(placeBoard(stage.w, frame.w, view.cx))},{Math.round(placeBoard(stage.h, frame.h, view.cy))} ·
          centre {view.cx.toFixed(2)},{view.cy.toFixed(2)}
          {/*
            The water, on its own line, because it answers a different question from the sizing
            numbers above it and gets asked when nothing looks wrong at all.

            Three counts, and the gap between any two of them says which end is broken. `hides` is
            rows this source could READ - a row becomes readable when somebody fires at its square,
            so on a match where finds are being called out and this stays 0, the rows are not
            arriving and the problem is the read, not the drawing. `marks` is what deepMarks made of
            them, which is every crew's finds because no team is passed here; `marks` short of the
            finds a caster has seen called means the walk disagrees with the log. And `shots` is what
            both are derived from, so a low figure there explains the other two without either being
            at fault.
          */}
          <div>
            deep: hides {state.deepHides.length} · marks {deepCells.size} · shots{" "}
            {state.attacks.filter((a) => a.cell_index >= 0 && a.result !== "pending").length} · igon anchor{" "}
            {igonAnchor(room) ?? "none"}
          </div>
        </div>
      )}
    </div>
  );
}
