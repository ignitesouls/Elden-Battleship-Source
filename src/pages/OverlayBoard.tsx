import { useCallback, useEffect, useRef, useState } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
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
  readEmptyFade,
  type CastView,
} from "../lib/overlayCast";
import { newestMarked, readMotion, type CastMotion } from "../lib/overlayCamera";
import { useBoardCamera } from "../hooks/useBoardCamera";
import { readTextSize, OVERLAY_MAX_FONT } from "../lib/overlayText";
import { squaresRevealed } from "../lib/overlayReveal";
import { markedAttacks, spotSet } from "../lib/overlayMarkers";
import { useBattlePhaseName } from "../hooks/useBattlePhase";
import { useSpectatorCounts, countChips } from "../hooks/useSquareCounts";
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
 *     ?autopan=1&lap=160      aims itself: a slow clockwise lap of the four quadrants
 *     ?spotlight=6            takes the camera to each square as it is marked, for six seconds
 *     ?mini=1                 the small-board treatment - colours instead of names, no text at all
 *
 * `autopan` and `spotlight` are the answer to "framed once" not being enough. A board framed on the
 * whole grid is unreadable at stream resolution and a board framed on a quarter of it is blind to
 * the other three - so it moves, on its own, with nobody at a desk. See lib/overlayCamera.
 *
 * `mini` is the answer to the OTHER way "framed once" fails: a streamer who wants the board in a
 * corner rather than as the stage. See the block on it below.
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
  //
  // `autopan` and `spotlight` ARE in it, unlike `text`, and for the opposite reason: they say where
  // the board is looking, which is exactly the thing a controller would otherwise be deciding. A
  // source that aims itself and also takes a caster's aim would be two hands on one wheel.
  const keys = ["pin", "team", "fire", "zoom", "cx", "cy", "names", "coords", "opacity", "key", "autopan", "spotlight"];
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

export function OverlayBoard(props: OverlaySourceProps = {}) {
  // The room and the query string come from the URL, or from the persistent stream route that has
  // resolved them off an overlay token. See hooks/useOverlaySource for why this page takes props.
  const { code, params } = useOverlaySource(props);
  const debug = params.get("debug") === "1";
  /**
   * The small-board treatment: colours instead of names, and no text on the board at all.
   *
   * -- Why this is a mode of THIS page and not a page of its own ----------------------------------
   *
   * pages/OverlayFleet argues at length that a small board is not the board source in a smaller
   * rectangle, and every word of it still holds - but the thing it was arguing about was the
   * CONTENT. That source shows a different board (the shots landing on you, with your own hulls
   * under them), read out of a credential this page never touches, so it had to be its own page.
   *
   * A small fire board is not a different board. It is this one - the same shots, the same wrecks,
   * the same finds in the water - asked to be legible at a fifth of the area. So the only honest
   * place for it is here, as a way of DRAWING this board, and a second page would have been a
   * duplicate of four hundred lines whose sole difference was which props it left off.
   *
   * What the mode changes is exactly the set of things that stop working when a square is 34px:
   *
   *   * names off, colour on   - a name fitted into 34px is mush; the challenge colour is the part
   *                              of a square's identity that survives, and it is the same trade the
   *                              players' own fleet panel has always made (see cellTint)
   *   * count chips off        - two digits beside a hull sprite in a square this size is text
   *                              pretending to be a picture
   *   * the gutter collapsed   - A-J and 1-10 are text too, and on a board this small they charge
   *                              two edges for it. ?coords=1 puts them back for anyone who wants
   *                              chat to have a vocabulary
   *
   * Everything else is untouched, deliberately: hit, miss and sunk markers, the wrecks of hulls
   * this crew has sunk, and whatever the water has given up are all pictures already, and they are
   * the reason to have this on a stream rather than a coloured grid that never changes.
   */
  const mini = params.get("mini") === "1";
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

  /**
   * Every fleet's square tallies, for the fire board below.
   *
   * Called unconditionally and for every source, including the ones that will never draw a chip -
   * a hook cannot sit behind the `fire` test without breaking the rules of hooks, and it costs one
   * select on a table the spectator page already reads the same way.
   *
   * These are safe to put on a stream because they are not private in the first place: tallies are
   * stored per player and shared with the whole fleet, and `useSpectatorCounts` is what the
   * spectator seat already reads them with. Pencil marks are the opposite and are deliberately
   * absent from this source - see usePencilMarks, which never sends them anywhere.
   */
  const teamCounts = useSpectatorCounts(state.room?.id);

  const room = state.room;
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.attacks, room);

  /**
   * Everything from here to the camera is derived BEFORE the "no room yet" guard, and deliberately.
   *
   * None of it needs a room - it is the view, the fleets on screen and the shots that get to draw a
   * result - and the camera below is a hook, so it cannot sit after a `return null`. The alternative
   * was splitting this page in two purely to satisfy the rules of hooks, which would have moved
   * three hundred lines to hide one guard.
   *
   * The things that DO need a room are still after it, and still say `room.` rather than `room?.`.
   */

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
  /**
   * The coordinate gutter, which a mini board turns around: off unless asked for.
   *
   * Everywhere else on this page the gutter is on by default, because a caster saying "D7" to
   * several thousand people has no other way to say where. A mini board is parked in a corner and
   * nobody is calling squares off it, while the two label tracks cost it a band on all four edges
   * of a board whose squares are already the smallest thing on the stream. So the default flips,
   * and ?coords=1 hands them back - the same bargain pages/OverlayFleet struck for the same reason.
   */
  const showCoords = mini ? params.get("coords") === "1" : view.coords;

  const teams = activeTeams(state.players);
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

  /**
   * The board aiming itself - see lib/overlayCamera.
   *
   * Two ways in, and they cannot both be live. A pinned source reads its own URL; a caster-driven
   * one takes the settings off the frame, which is the desk saying "let go of the wheel". Either
   * way the camera runs HERE, on the source, rather than being published a position at a time.
   *
   * `since` for a pinned source is its own mount. Two sources in one scene will therefore lap
   * slightly out of step if they were added minutes apart, which is fine - they are different
   * boards - and the alternative is inventing a shared origin no URL can carry. A caster's sources
   * DO share one, because the desk sends it.
   */
  const mountedAt = useRef(Date.now());
  const urlMotion = pinned ? readMotion(params, mountedAt.current) : null;
  const motion: CastMotion | null = pinned ? urlMotion : (view.motion ?? null);
  const camera = useBoardCamera({
    motion,
    // Where it rests between spotlights, and what it resets to: the framing this source was set up
    // with, or the one the caster is holding. Never a position this feature chose for itself.
    base: { zoom: view.zoom, cx: view.cx, cy: view.cy },
    boardSize: room?.board_size ?? 0,
    // From `marked`, not the whole log: the camera follows the shots this board is drawing. A
    // caster who has filtered markers to one fleet gets a camera that agrees with the picture.
    newest: newestMarked(marked),
    frame,
    stage,
  });

  /**
   * The stage element, which two things need: useBoxSize measures it, and the camera writes the pan
   * onto it sixty times a second.
   *
   * Composed with useCallback rather than an inline arrow, because React re-attaches a ref whose
   * identity changed - and a fresh function every render would tear down and rebuild the
   * ResizeObserver on every render of the page.
   */
  const { attach: attachCamera } = camera;
  const setStage = useCallback(
    (el: HTMLDivElement | null) => {
      stageRef(el);
      attachCamera(el);
    },
    [stageRef, attachCamera]
  );

  if (!room) return null;
  if (!view.visible) return null;

  const boardSize = room.board_size;
  // Blank water until the shooting starts, exactly as the players' own placement board is - see
  // lib/overlayReveal.ts. A captain must not be able to read the squares off their own source
  // while they still have hulls in hand.
  const revealed = squaresRevealed(room.status, battlePhase);
  const challenges = challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm);
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

  /**
   * The fleet's own square tallies, resolved from player ids into something a square can print.
   *
   * Fire board only. On a defensive board the chips would be one fleet's reasoning drawn over a
   * board somebody else is reading, and on the caster's they would be several fleets' at once,
   * stacked into a square already carrying a name.
   *
   * No `myPlayerId`, so nothing is flagged as mine: a browser source belongs to no player, and the
   * accent that marks your own chip on your own screen would be a lie about whose it is here.
   *
   * Off on a mini board as well, because a tally is a number and a number is text - see the `mini`
   * block above. It is the one thing the mode drops that a viewer might genuinely miss, and it
   * still has to go: three chips crowded beside a hull in a 34px square is not a tally anybody can
   * read, it is a smear that costs the square the colour it was kept for.
   */
  const counts =
    fireTeam !== null && !mini
      ? countChips(teamCounts.get(fireTeam) ?? new Map(), (pid) => {
          const who = state.players.find((pl) => pl.id === pid);
          return who?.nickname ?? "Someone";
        })
      : undefined;

  // One walk of the shown fleets' shots rather than one filter of the whole log per square - which
  // on a source re-rendering off the cast heartbeat was the most expensive thing this page did.
  // See lib/cellVisuals for the precedence, which is the same merge described above.
  const visuals = cellVisuals(marked, sunkCells);
  const cellVisual = (index: number): CellVisual => visuals.get(index) ?? "empty";

  // Square as big as the shorter side of the source, then multiplied by the zoom. A board is
  // square, so a wide source simply leaves margin either side at 1x - see the size note on the
  // control page.
  const fit = frame.w > 0 ? Math.min(frame.w, frame.h) : SOURCE_SIZE;
  // The camera's zoom when it has the wheel. It is the one part of the framing React still owns:
  // zoom here is a real cell size, so it is a re-layout rather than a number in a style.
  const boardPx = Math.round(fit * (camera.running ? camera.zoom : view.zoom));

  return (
    <div
      className={`ovb-frame ovb-board ovl-fade${mini ? " ovb-mini" : ""}${showCoords ? "" : " ovb-no-coords"}`}
      ref={frameRef}
      // Board size as a CSS variable so the stylesheet can recompute the cell font from the real
      // board size - BoardGrid's own figure is capped at 1600px. See OverlayBoard.css.
      // --ovb-text is the text-size slider, and reaches only the square names' FIRST render - the
      // estimate drawn before there is a cell to measure, after which textFit writes a fitted size
      // inline and inline wins. The coordinate gutter deliberately doesn't read it; see the note on
      // .bg-coord in the stylesheet for why the two are different questions.
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
        className={`ovb-stage ovl-fade-stage${camera.running ? " ovb-motion" : ""}`}
        ref={setStage}
        style={{
          // Absent, not merely ignored, while the camera is running. React clears a property it
          // has rendered before, so leaving these in the object would have it wipe the camera's
          // pan on every re-render and snap the board to the corner for a frame. See
          // hooks/useBoardCamera, which writes them straight onto this element instead.
          ...(camera.running
            ? null
            : { left: placeBoard(stage.w, frame.w, view.cx), top: placeBoard(stage.h, frame.h, view.cy) }),
          ["--ovl-a-bg" as string]: view.opacity ?? 1,
          // Thins the squares nobody has fired at, and nothing else - see readEmptyFade. Off the
          // URL rather than the cast frame: it is a player's setting for a player's own source, and
          // a caster's board simply never carries one.
          ["--ovl-a-empty" as string]: readEmptyFade(params),
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
          // What the caster is pointing at - or, when the board is aiming itself, the square that
          // was just marked. Only one of the two can be live: a source running its own camera has
          // taken the wheel, and a desk pointing at one square while the board is holding on
          // another would be the two of them arguing on stream.
          spotCells={camera.running ? new Set(camera.spotCells) : spotSet(view)}
          // Whose shot, or whose hull. Undefined leaves the light white, which is what a caster
          // simply pointing at a square should look like.
          //
          // White for the self-aiming spotlight too, deliberately. A caster's light is a gesture
          // and the colour says whose moment it is; this one fires on EVERY mark, so a ring that
          // changed colour a hundred times a match would be reading as an attribution - a job the
          // firedBy rings already do, underneath it, without moving.
          spotColor={camera.running ? undefined : (view.spotColor ?? undefined)}
          // Drawn the moment any of it is found - see lib/deepWater.ts. This source needs no frame
          // from the desk to know: the finds are in the public log, so it works them out for itself
          // and they appear on stream by themselves.
          deepCells={deepCells}
          // The fleet's own tallies, on their own board and nowhere else. Read-only: with no
          // onCount, a source draws the chips and cannot add to them.
          counts={counts}
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
            view.names && revealed && !mini
              ? (i) => {
                  const c = challenges[i];
                  if (!c) return null;
                  // Region and colour included so the stream tints squares exactly as the players'
                  // own boards do - the key along the bottom of their screen reads true here too.
                  return { label: c.short ?? c.name, region: c.region, color: c.color };
                }
              : undefined
          }
          // What a square wears instead of its name, on a mini board - and only there. Behind the
          // same reveal gate the names are, for the same reason (see lib/overlayReveal): a tint is
          // a weaker read than a name but it is the same KIND of read, and a captain must not be
          // able to see which squares are which off their own source while hulls are still in hand.
          cellTint={
            mini && revealed
              ? (i) => {
                  const c = challenges[i];
                  return c ? { region: c.region, color: c.color } : null;
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
            The camera, when it has the wheel. The offsets on the line above are the RESTING framing
            and stop describing the picture the moment this appears - which is the confusion worth
            naming, because a self-aiming board mid-dwell looks identical to one that was never
            moving. `lap` and `spot` are the settings that actually reached the source, so a control
            that isn't arriving says so here rather than looking like a broken camera.
          */}
          {camera.running && motion && (
            <div>
              camera: {motion.pan ? `lap ${motion.lap}s` : "no lap"} ·{" "}
              {motion.spot > 0 ? `spotlight ${motion.spot}s` : "no spotlight"} · zoom {camera.zoom.toFixed(2)} · lit{" "}
              {camera.spotCells.length}
            </div>
          )}
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
