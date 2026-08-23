import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { activeTeams, sunkCellOrientations, attackerTeamsByCell, cellLabel } from "../lib/battleshipLogic";
import { cellVisuals } from "../lib/cellVisuals";
import { challengesForRoom, rowSquareSet, igonAnchor } from "../lib/challenges";
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
import { OVERLAY_MAX_FONT, MIN_TEXT_SIZE } from "../lib/overlayText";
import { markedAttacks, spotSet } from "../lib/overlayMarkers";
import { castPresets, type Preset, PRESET_SLOTS } from "../lib/castPresets";
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

/**
 * How large the 1:1 monitor is DRAWN. The viewport inside it is always SOURCE_SIZE.
 *
 * This was a flat 420, and that one number was the size of the whole desk. It made the monitor a
 * picture to check rather than a board to work on: a 20x20 room arrived as 21px squares, which is
 * too small to point at a single one of, let alone click it. The board is now sized from whatever
 * the window actually leaves it - see `previewPx` in the component, which is the only place these
 * two are read.
 *
 * FALLBACK is the one frame before the ResizeObserver reports, so the first paint is the size the
 * desk used to be rather than a collapsed sliver. MIN is the floor on a window too small to give
 * the board its share: below this it stops being something anyone can aim with, and letting it be
 * clipped is more honest than shrinking it to a postage stamp.
 */
const FALLBACK_PREVIEW = 420;
const MIN_PREVIEW = 320;

/**
 * How far the pointer may travel and still count as a click rather than a drag.
 *
 * The monitor is both a thing you drag and (while spotting) a thing you click, and a mouse never
 * stays perfectly still between press and release. Generous enough to absorb a hand on a trackpad,
 * small enough that a deliberate pan is never mistaken for a point.
 */
const CLICK_SLOP = 4;

/**
 * Which square is under a point on screen, asked of the DOM rather than computed.
 *
 * The arithmetic version of this is available and wrong: the rendered board is never exactly
 * `cells x cellSize` once the coordinate gutters, the grid gaps and the borders are counted, and
 * the monitor is additionally inside a `scale()` transform. Deriving a cell from all that means
 * keeping a second copy of BoardGrid's layout in step with the first, which is the bug the whole
 * file already warns about in `placeBoard`.
 *
 * `getBoundingClientRect` reports the post-transform box the user is actually looking at, so
 * walking the cells and asking which one contains the point is exact by construction and stays
 * exact if the grid's internals ever change. Linear in the number of squares - 400 on the largest
 * board, once per click, which is nothing.
 *
 * Deliberately not `elementFromPoint`: the cells sit under a marker layer and are given
 * `pointer-events: none` on this page so the drag belongs to the preview, and hit-testing would
 * make this depend on both of those staying true.
 */
function cellAtPoint(root: HTMLElement, x: number, y: number): number | null {
  for (const el of root.querySelectorAll<HTMLElement>("[data-cell]")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      const n = Number(el.dataset.cell);
      return Number.isInteger(n) ? n : null;
    }
  }
  return null;
}

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
  /**
   * The space the monitor is allowed to fill, measured rather than assumed.
   *
   * Measured on the DECK - the box the monitor is centred in - and not on the monitor itself, which
   * would be a loop: the monitor's size would come from a measurement of the monitor. The deck's
   * own size comes from the grid track and the viewport height above it, so it is settled before
   * anything inside it is drawn, and .cast-deck carries the `min-*: 0` and `overflow: hidden` that
   * stop its child ever growing it back. See the layout note at the top of CasterControl.css.
   */
  const [deckRef, deck] = useBoxSize<HTMLDivElement>();
  /**
   * Point-at-a-square mode: the monitor stops being only a thing you drag and starts being a thing
   * you click.
   *
   * A mode rather than a modifier because a caster is doing this one-handed while talking, and
   * "hold this key and click" is two things to remember under load. Armed, a CLICK spotlights and a
   * DRAG still pans - see the pointer handlers, which tell them apart by distance travelled.
   */
  const [spotting, setSpotting] = useState(false);
  /** Where the pointer went down, so a click can be told from a drag. Null between gestures. */
  const downAt = useRef<{ x: number; y: number } | null>(null);
  /**
   * Follow the newest shot, off by default.
   *
   * It has to yield the moment the caster touches the aim themselves - see `manual` below. A view
   * that keeps dragging itself back while somebody is trying to aim it is worse than no automation
   * at all, and it fails at exactly the moment they most need control.
   */
  const [follow, setFollow] = useState(false);
  /**
   * Punch-in: a highlight doesn't just light up, it takes the camera.
   *
   * Zoom to the square, hold it there, then put the view back exactly where the caster had it. The
   * hold is what makes it usable on air - a viewer needs a beat to find the square, read the name
   * and hear the call, and a cut that snaps back before they have done all three is worse than no
   * cut at all. Five seconds is about that beat; it is a setting because rooms and casters differ.
   *
   * On by default, because a highlight nobody can see is not a highlight. Off leaves the older
   * behaviour: the square lights up and the framing is the caster's problem.
   */
  const [punchOn, setPunchOn] = useState(true);
  const [punchZoom, setPunchZoom] = useState(1.6);
  const [punchSecs, setPunchSecs] = useState(5);
  /**
   * The framing to go back to, and the timer that will do it. Null when no punch is in flight.
   *
   * A ref rather than state: nothing renders from it, and it is written from a timer callback where
   * a stale closure over state would restore the wrong framing.
   */
  const punchRef = useRef<{ back: Preset; timer: ReturnType<typeof setTimeout> } | null>(null);
  /**
   * The latest view and punch settings, for the callbacks that must not be rebuilt when they change.
   *
   * `punchTo` is called from an effect that fires on every new shot. If it depended on the zoom
   * slider, moving that slider would re-run the effect and punch the view onto the last shot again -
   * so the settings are read through a ref and the callback stays stable.
   */
  const viewRef = useRef(view);
  const punchCfg = useRef({ on: punchOn, zoom: punchZoom, secs: punchSecs });
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    punchCfg.current = { on: punchOn, zoom: punchZoom, secs: punchSecs };
  }, [punchOn, punchZoom, punchSecs]);
  // A page closed mid-hold must not leave a timer trying to setState afterwards.
  useEffect(() => () => clearTimeout(punchRef.current?.timer), []);

  /**
   * Abandon the pending restore, leaving the view and the light exactly where they are.
   *
   * What a caster's own hand does to a punch. It deliberately does NOT put the framing back or put
   * the light out: they have taken the camera, and a view that snapped somewhere else four seconds
   * later would be the automation fighting them at the worst possible moment. The square stays lit
   * because it is still the square being talked about.
   *
   * Declared up here with the rest of the punch machinery because `panBy` and `panTo` below both
   * call it, and they are defined before anything that comes after this block.
   */
  const cancelPunch = useCallback(() => {
    if (!punchRef.current) return;
    clearTimeout(punchRef.current.timer);
    punchRef.current = null;
  }, []);

  /** The four saved framings for this room - see lib/castPresets. */
  const presetStore = useMemo(() => castPresets(code), [code]);
  const [presets, setPresets] = useState<(Preset | null)[]>(() => presetStore.read());
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
        ? deepMarks(deepWater(room, groupIntoShots(state.attacks, state.players), state.deepHides, igonAnchor(room)))
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
    // The caster has taken the aim back. Every manual movement does this - see the note on `follow`
    // and on `cancelPunch`, which drops the pending restore rather than fighting them for the view.
    setFollow(false);
    cancelPunch();
    setView((v) => {
      const step = mode === "jump" ? (1 - 1 / v.zoom) / 4 : 0.06 / v.zoom;
      return {
        ...v,
        cx: Math.min(1, Math.max(0, v.cx + dx * step)),
        cy: Math.min(1, Math.max(0, v.cy + dy * step)),
      };
    });
  }, [cancelPunch]);

  const recentre = useCallback(() => {
    setFollow(false);
    cancelPunch();
    setView((v) => ({ ...v, cx: 0.5, cy: 0.5 }));
  }, [cancelPunch]);

  /**
   * The four framing slots. Saving overwrites, recalling restores zoom and centre together.
   *
   * The write goes out beside the state update rather than inside the updater: React invokes an
   * updater twice in development to catch impure ones, and a localStorage write in there would be
   * exactly the impurity that check exists to find - harmless here, but the kind of thing that
   * stops being harmless the moment somebody puts something less idempotent next to it.
   */
  const savePreset = useCallback(
    (slot: number) => {
      const next = presets.map((p, i) => (i === slot ? { zoom: view.zoom, cx: view.cx, cy: view.cy } : p));
      setPresets(next);
      presetStore.write(next);
    },
    [presets, presetStore, view.zoom, view.cx, view.cy]
  );

  const clearPreset = useCallback(
    (slot: number) => {
      const next = presets.map((p, i) => (i === slot ? null : p));
      setPresets(next);
      presetStore.write(next);
    },
    [presets, presetStore]
  );

  const recallPreset = useCallback(
    (slot: number) => {
      const p = presets[slot];
      if (!p) return;
      // Recalling is the caster aiming, so it takes the view off follow like any other manual move.
      setFollow(false);
      setView((v) => ({ ...v, zoom: p.zoom, cx: p.cx, cy: p.cy }));
    },
    [presets]
  );

  /**
   * Take the camera to these squares, hold, then give it back.
   *
   * The centre is the MEAN of the cells, so a five-square hull frames as a whole object rather than
   * on whichever end happened to be first. For a single square it is simply that square's centre.
   *
   * `back` is captured once per punch and carried across re-triggers: a second shot landing during
   * the hold retargets and restarts the clock, but still returns to where the caster was, not to
   * the previous punch's framing. Without that, a fast exchange would walk the "home" position
   * across the board a shot at a time and never come back.
   */
  const punchTo = useCallback((cells: number[], color: string | null, boardCells: number) => {
    if (cells.length === 0 || boardCells <= 0) return;
    const mean = (of: (cell: number) => number) => cells.reduce((sum, c) => sum + of(c), 0) / cells.length;
    const cx = (mean((c) => c % boardCells) + 0.5) / boardCells;
    const cy = (mean((c) => Math.floor(c / boardCells)) + 0.5) / boardCells;

    const live = punchRef.current;
    const back = live ? live.back : { zoom: viewRef.current.zoom, cx: viewRef.current.cx, cy: viewRef.current.cy };
    if (live) clearTimeout(live.timer);

    const timer = setTimeout(
      () => {
        punchRef.current = null;
        setView((v) => ({ ...v, zoom: back.zoom, cx: back.cx, cy: back.cy, spot: null, spotColor: null }));
      },
      Math.max(1, punchCfg.current.secs) * 1000
    );
    punchRef.current = { back, timer };

    setView((v) => ({
      ...v,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, punchCfg.current.zoom)),
      cx,
      cy,
      spot: cells,
      spotColor: color,
    }));
  }, []);

  /**
   * The newest resolved shot, as a cell index - what "follow the action" follows.
   *
   * Ordered by `created_at` rather than by position in the array: the log arrives from two places -
   * the initial fetch and the realtime stream - and only the timestamp is authoritative about which
   * shot is actually the latest. Pending rows are skipped because a shot that has not resolved has
   * no result to look at yet, and swinging the stream onto a blank square is worse than waiting a
   * beat. Negative indices are the match-start bookkeeping row, not a shot anyone fired.
   */
  const newestShot = useMemo(() => {
    let shot: { cell: number; team: number } | null = null;
    let at = "";
    for (const a of state.attacks) {
      if (a.cell_index < 0 || a.result === "pending") continue;
      if (a.created_at > at) {
        at = a.created_at;
        // The attacker, not the defender: the light is meant to say WHOSE moment this is, and on a
        // composited board the fleet being shot at is the one that didn't do anything.
        shot = { cell: a.cell_index, team: a.attacker_team };
      }
    }
    return shot;
  }, [state.attacks]);

  /**
   * Swing the frame onto that shot, while follow is on.
   *
   * Null when follow is off, which is what stops this effect from having any opinion at all the
   * rest of the time - it is not "follow, but ignore me", it simply has nothing to say.
   *
   * The zoom check lives INSIDE the updater rather than in the dependency list, so changing zoom
   * doesn't re-fire the effect and yank the view back to the last shot while somebody is adjusting
   * it. At 1x the whole board is in frame and there is nowhere to pan, so it correctly does nothing.
   */
  const followCell = follow ? (newestShot?.cell ?? null) : null;
  const followTeam = newestShot?.team ?? null;
  const followBoard = room?.board_size ?? 0;
  useEffect(() => {
    if (followCell === null || followBoard <= 0) return;
    // With punch-in on, the shot takes the camera and the light burns in the firing fleet's colour
    // for the hold. Without it, the older behaviour: slide the frame across and change nothing else.
    if (punchCfg.current.on) {
      punchTo([followCell], followTeam === null ? null : teamHex(followTeam), followBoard);
      return;
    }
    setView((v) =>
      v.zoom <= MIN_ZOOM
        ? v
        : {
            ...v,
            // Centre of the square, not its corner - a shot in the last column would otherwise
            // frame half a square of board and half a square of nothing.
            cx: ((followCell % followBoard) + 0.5) / followBoard,
            cy: (Math.floor(followCell / followBoard) + 0.5) / followBoard,
          }
    );
  }, [followCell, followTeam, followBoard, punchTo]);

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

      /**
       * Shift + 1-4 recalls a saved framing.
       *
       * On a modifier because the bare digits are the aim pad and that mapping is the good thing
       * about this keyboard - a keypad that is a map of the board. Shift is the only free hand
       * position that keeps the recall keys in the same place as the aim keys, which is the whole
       * point of putting them on the number keys rather than on F-keys nobody can find by touch.
       *
       * Checked before the pad so a shifted digit never also steps the view.
       */
      if (e.shiftKey && digit) {
        const slot = Number(digit) - 1;
        if (slot >= 0 && slot < PRESET_SLOTS) {
          e.preventDefault();
          recallPreset(slot);
        }
        return;
      }

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
  }, [panBy, recentre, recallPreset]);

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
  /**
   * The attribution rings - the same derivation the source makes, from the same shots.
   *
   * Built from `relevant` rather than from every attack, so it answers the question the board in
   * front of it is actually asking: on a single-fleet view the rings describe the shots that fleet
   * has taken, not shots at a board nobody is looking at.
   *
   * Deliberately built BEFORE the marker filter below and from the unfiltered set: with the markers
   * off, these rings are the entire board. See lib/overlayMarkers.
   */
  const firedBy = new Map(
    [...attackerTeamsByCell(relevant)].map(([cell, ts]) => [cell, ts.map(teamHex)])
  );
  // Only the shots allowed to draw a result - see lib/overlayMarkers for the two toggles and for
  // why the attacker/defender distinction is the easy one to get backwards.
  const marked = markedAttacks(relevant, view);
  // From `marked`, not `relevant`. A hull sunk by a fleet whose markers are hidden must not leave
  // its wreckage on the board - the sunk cells are a result like any other, and they are also what
  // `cellVisuals` applies last and lets win outright.
  const sunkCells = sunkCellOrientations(marked, boardSize);
  // Resolved in one pass, exactly as the source does it - the monitor and the board it is driving
  // have to merge a square the same way. See lib/cellVisuals.
  const visuals = cellVisuals(marked, sunkCells);
  const cellVisual = (index: number): CellVisual => visuals.get(index) ?? "empty";
  const spotCells = spotSet(view);

  /** Squares carrying a hit, in one pass, for the hull tallies below. */
  const struck = new Set<number>();
  for (const a of relevant) if (a.result === "hit") struck.add(a.cell_index);

  /**
   * Every hull the desk can see, with the squares sitting on it and how many are down.
   *
   * Built from `state.revealedFleets` rather than from `fleets`, so the LIST is readable in every
   * view - including Results only, which deliberately sends no placements at all. A caster wants to
   * know what is on the Carrier before deciding whether to put it on stream, and that decision
   * cannot be made from a list that is empty until after they have made it.
   *
   * Putting one on stream is a different matter entirely - see `canSpotShips`.
   */
  const hulls = state.revealedFleets.flatMap((f) =>
    (f.placements ?? []).map((p, n) => {
      const def = room.ship_defs[p.shipIndex];
      const size = def?.size ?? 1;
      const cells: number[] = [];
      for (let k = 0; k < size; k++) {
        const r = p.isHorizontal ? p.startRow : p.startRow + k;
        const c = p.isHorizontal ? p.startCol + k : p.startCol;
        // Bounds-checked per axis, as lib/shipCells does it - a hull running off the right edge
        // would otherwise wrap onto the start of the next row.
        if (r >= 0 && c >= 0 && r < boardSize && c < boardSize) cells.push(r * boardSize + c);
      }
      return {
        key: `${f.team}-${n}`,
        team: f.team,
        name: def?.name ?? "Destroyer",
        cells,
        // Full names, not the board's shortened forms: this is the line a caster reads out, and the
        // board is the only place the abbreviation is the right call.
        squares: cells.map((i) => challenges[i]?.name ?? cellLabel(i, boardSize)),
        down: cells.filter((i) => struck.has(i)).length,
      };
    })
  );

  /**
   * Whether a hull may be spotlit.
   *
   * A ship spotlight rings every square of a hull, which states its position, its length and its
   * orientation - so it IS a ship reveal, whatever the View buttons say. "Results only" promises no
   * ship positions on stream, and a control that quietly broke that promise would be the worst kind
   * of leak: one the caster believed they had already ruled out.
   */
  const canSpotShips = view.mode !== "results";
  const spotIsHull = (cells: number[]) =>
    (view.spot?.length ?? 0) === cells.length && cells.every((c) => view.spot?.includes(c));

  // Identical to the source's own sizing, because the monitor IS the source at display scale.
  const boardPx = Math.round(SOURCE_SIZE * view.zoom);

  /**
   * The monitor's on-screen side: the largest square the deck will hold.
   *
   * Square because the source is square, so the binding constraint is whichever of the deck's two
   * sides is shorter - in practice the height, on every ordinary monitor, which is why widening
   * this column past what the height allows buys nothing. The slack that leaves beside the board is
   * where .cast-rail lives.
   *
   * Read in exactly three places, all of which have to agree or the drag stops tracking the hand:
   * the box's own size, the scale on .cast-viewport, and `panTo` below. That last one is the reason
   * this is a variable rather than three copies of a constant - see the note there.
   */
  const previewPx =
    deck.w > 0 && deck.h > 0 ? Math.max(MIN_PREVIEW, Math.floor(Math.min(deck.w, deck.h))) : FALLBACK_PREVIEW;

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
    // Dragging is the caster aiming by hand, so it takes the view off follow and drops any pending
    // punch restore - see `follow` and `cancelPunch`.
    setFollow(false);
    cancelPunch();
    // Preview px -> the source's logical px -> a fraction of the whole board.
    //
    // `previewPx`, NOT a constant. This is what converts the pointer's travel in screen pixels into
    // travel across the board, so it has to be the size the monitor is actually drawn at - the same
    // number .cast-viewport is scaled by. While that was a fixed 420 the two could not disagree;
    // now that the monitor is sized from the window, a constant here would mean the board moved a
    // different distance than the hand did, by whatever ratio the window happened to be. That reads
    // as the aim being imprecise rather than as a bug, which is the worst way for it to fail.
    const scale = previewPx / SOURCE_SIZE;
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
          This view can't read any ship positions, so the board shows shots only. Ships appear once
          fleets are placed, and only for someone signed in to the room.
        </div>
      )}

      <div className="cast-body">
        {/* The deck: the box the monitor is centred in, and the one thing here whose size is
            MEASURED. Everything about how large the board is drawn comes from it - see `previewPx`,
            and the layout note at the top of CasterControl.css for why it can't be the monitor
            itself that gets measured. */}
        <div className="cast-deck" ref={deckRef}>
          {/* Drag to slide the stream view around; the wheel zooms. Both act on the same point
              under the cursor, so following a fleet is one gesture rather than a set of decisions. */}
          <div
            className={`cast-preview${dragging ? " cast-dragging" : ""}${spotting ? " cast-spotting" : ""}`}
            style={{ width: previewPx, height: previewPx }}
            onPointerDown={(e) => {
              downAt.current = { x: e.clientX, y: e.clientY };
              drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
              setDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              // While spotting, hold the view perfectly still until the gesture has committed to
              // being a drag. Without this the jitter between press and release on a click pans the
              // board a pixel or two, and the caster's "point at D7" also nudges the stream.
              if (spotting && downAt.current) {
                const dx = Math.abs(e.clientX - downAt.current.x);
                const dy = Math.abs(e.clientY - downAt.current.y);
                if (dx <= CLICK_SLOP && dy <= CLICK_SLOP) return;
              }
              panTo(e);
            }}
            onPointerUp={(e) => {
              const from = downAt.current;
              const root = e.currentTarget;
              drag.current = null;
              downAt.current = null;
              setDragging(false);
              root.releasePointerCapture(e.pointerId);
              if (!spotting || !from) return;
              if (Math.abs(e.clientX - from.x) > CLICK_SLOP || Math.abs(e.clientY - from.y) > CLICK_SLOP) return;
              const cell = cellAtPoint(root, e.clientX, e.clientY);
              setView((v) => {
                // Clicking the lit square again puts the light out, which is the gesture everyone
                // tries first and the only way to clear it without reaching for another control.
                const lit = v.spot?.length === 1 && v.spot[0] === cell;
                return { ...v, spot: cell === null || lit ? null : [cell] };
              });
            }}
            onPointerCancel={() => {
              drag.current = null;
              downAt.current = null;
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
                transform: `scale(${previewPx / SOURCE_SIZE})`,
                ["--ovb-cells" as string]: boardSize,
                // The coordinate labels take the same multiplier the names do. They are plain CSS
                // rather than fitted per square, so this variable is the only way they scale - and
                // without it the monitor's gutters would be a different size from the stream's.
                ["--ovb-text" as string]: view.text ?? 1,
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
                  spotCells={spotCells}
                  spotColor={view.spotColor ?? undefined}
                  // Matches the source exactly - the monitor has to BE the frame, not resemble it.
                  //
                  // These three were missing, and that was a real fault rather than an omission:
                  // the source draws names up to OVERLAY_MAX_FONT and the monitor capped them at
                  // BoardGrid's 17px, so on any board with cells over ~122px - a 6x6 room, or an
                  // 11x11 past 1.7x zoom - the desk showed names visibly smaller than the ones
                  // going out. A preview whose whole claim is "this IS the frame" cannot be wrong
                  // about the size of the only thing anybody reads off it.
                  textBoost={view.text ?? 1}
                  maxCellFont={OVERLAY_MAX_FONT}
                  growText
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
        </div>

        {/*
          The readout, beside the board rather than under it.

          It used to sit below the monitor with 3.3em of height reserved for it, because it ends in
          the full name of whatever square is under the crosshair - which changes on every frame of
          a pan, and ran from "Rick" to "Lurnia Crystalian (Ringblade)". Reserving that space was
          what stopped the column breathing in and out during a drag.

          A square board in a wider column leaves slack at the sides anyway, so the readout goes
          THERE and the height it used to reserve goes back to the board - about 47px, which is the
          difference between 43px squares and 40px ones on a 20x20 room. The twitch it was reserving
          against is gone structurally rather than by arithmetic: this is a column of its own with a
          bounded width, so text growing from one line to five pushes on nothing.
        */}
        <div className="cast-rail">
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
                Ships are on stream during a live match. Your call, but don't leave it up over a
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
          {/*
            Text size, as a fraction of what each square will hold.

            The default is now "as large as it fits", per square - so the size varies with the name,
            which is the point: "Dane" gets a big one and "Consecrated Death Rite Bird" gets a small
            one, and neither leaves the square mostly empty. This slider only comes DOWN from that,
            because there is nothing above filling the square. See lib/textFit.
          */}
          <section>
            <h3>Text size</h3>
            <div className="cast-row">
              <input
                type="range"
                min={MIN_TEXT_SIZE}
                max={1}
                step={0.05}
                value={view.text ?? 1}
                onChange={(e) => set({ text: Number(e.target.value) })}
                title="How much of each square the name fills"
              />
              <span className="cast-zoom-value">{Math.round((view.text ?? 1) * 100)}%</span>
              <button onClick={() => set({ text: 1 })} title="Fill every square">
                Fill
              </button>
            </div>
            <p className="cast-note muted">
              Every square is sized to its own name, so short names come out large. This trims the
              whole board together.
            </p>
          </section>

          {/*
            Framing slots. Save is a separate small button rather than a long-press or a shift-click,
            because the two actions have very different costs: recalling the wrong slot is a
            keypress you undo by pressing the right one, and OVERWRITING the wrong slot loses a
            framing you set up before the match and cannot get back.
          */}
          <section>
            <h3>Framing presets</h3>
            <div className="cast-presets">
              {presets.map((p, i) => (
                <div className="cast-preset" key={i}>
                  <button
                    className={p ? "primary" : ""}
                    disabled={!p}
                    onClick={() => recallPreset(i)}
                    title={
                      p
                        ? `Recall ${p.zoom.toFixed(1)}x - keyboard Shift+${i + 1}`
                        : "Empty - aim the board, then press Save"
                    }
                  >
                    {i + 1}
                    {p && <span className="cast-preset-zoom">{p.zoom.toFixed(1)}x</span>}
                  </button>
                  <button
                    className="cast-preset-set"
                    onClick={() => (p ? clearPreset(i) : savePreset(i))}
                    title={p ? "Forget this framing" : "Save the current framing here"}
                  >
                    {p ? "clear" : "save"}
                  </button>
                </div>
              ))}
            </div>
            <p className="cast-note muted">
              Saves the zoom and centre together. <strong>Shift+1-4</strong> recalls without
              reaching for the mouse.
            </p>
          </section>

          {/*
            Follow the action. Off by default and it yields to the hand - see the note on `follow`.
          */}
          <section>
            <h3>Follow the action</h3>
            <label className="cast-check">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              <span>Swing to the newest shot</span>
            </label>
            <p className="cast-note muted">
              {punchOn
                ? "Each shot takes the camera and holds it, lit in the firing fleet's colour."
                : view.zoom <= MIN_ZOOM
                  ? "Nothing to follow at 1x - the whole board is already in frame. Zoom in first."
                  : "Slides the frame to each new shot without changing the zoom."}
            </p>
          </section>

          {/*
            Punch-in: what a highlight DOES, rather than what it looks like.

            Governs both the shot follow above and the ship buttons below, because they are the same
            gesture - "look at this" - and having one of them take the camera while the other only
            lit a square would read as a bug rather than as two settings.

            Clicking a square by hand is deliberately NOT punched. That is the caster pointing at
            something they are already talking about, at a framing they already chose; moving the
            camera out from under them and then moving it back would be the opposite of helpful.
          */}
          <section>
            <h3>Punch in</h3>
            <label className="cast-check">
              <input type="checkbox" checked={punchOn} onChange={(e) => setPunchOn(e.target.checked)} />
              <span>Zoom to a highlight, then come back</span>
            </label>
            {punchOn && (
              <>
                <div className="cast-row">
                  <input
                    type="range"
                    min={MIN_ZOOM}
                    max={MAX_ZOOM}
                    step={0.1}
                    value={punchZoom}
                    onChange={(e) => setPunchZoom(Number(e.target.value))}
                    title="How far in a highlight zooms"
                  />
                  <span className="cast-zoom-value">{punchZoom.toFixed(1)}x</span>
                </div>
                <div className="cast-row">
                  <input
                    type="range"
                    min={2}
                    max={15}
                    step={1}
                    value={punchSecs}
                    onChange={(e) => setPunchSecs(Number(e.target.value))}
                    title="How long it holds before going back"
                  />
                  <span className="cast-zoom-value">{punchSecs}s</span>
                </div>
                <p className="cast-note muted">
                  Returns to exactly the framing you were on. Touching the aim yourself cancels the
                  return and leaves the square lit.
                </p>
              </>
            )}
          </section>

          {/*
            The spotlight: what the caster is pointing at. A stream viewer cannot follow a finger on
            a monitor, so "the one at D7" otherwise has no picture attached to it.
          */}
          <section>
            <h3>Spotlight</h3>
            <label className="cast-check">
              <input type="checkbox" checked={spotting} onChange={(e) => setSpotting(e.target.checked)} />
              <span>Click the board to point at a square</span>
            </label>
            <div className="cast-buttons">
              <button
                disabled={!view.spot?.length}
                onClick={() => {
                  cancelPunch();
                  set({ spot: null, spotColor: null });
                }}
                title="Put the light out"
              >
                Clear spotlight
              </button>
              {view.spot?.length === 1 && challenges[view.spot[0]] && (
                <span className="cast-spot-name">
                  {cellLabel(view.spot[0], boardSize)} - {challenges[view.spot[0]].name}
                </span>
              )}
            </div>
            <p className="cast-note muted">
              With this on, a click points and a drag still pans. Click the lit square again to
              clear it.
            </p>

            {hulls.length > 0 && (
              <>
                <h3 className="cast-subhead">Ships</h3>
                {!canSpotShips && (
                  <p className="cast-warn">
                    Results only is on, so no ship positions go to stream - including these.
                    Switch the view to a fleet to spotlight a hull.
                  </p>
                )}
                <div className="cast-hulls">
                  {hulls.map((h) => (
                    <button
                      key={h.key}
                      className={`cast-hull${spotIsHull(h.cells) ? " primary" : ""}`}
                      disabled={!canSpotShips || h.cells.length === 0}
                      onClick={() => {
                        if (spotIsHull(h.cells)) {
                          cancelPunch();
                          set({ spot: null, spotColor: null });
                        } else if (punchOn) {
                          // Takes the camera to the whole hull and holds it, in that fleet's colour.
                          punchTo(h.cells, teamHex(h.team), boardSize);
                        } else {
                          set({ spot: h.cells, spotColor: teamHex(h.team) });
                        }
                      }}
                      title={canSpotShips ? "Ring this hull on stream" : "Not while the view is Results only"}
                    >
                      <span className="cast-hull-head" style={{ color: teamHex(h.team) }}>
                        {teamName(h.team)} · {h.name}
                        <span className="cast-hull-tally">
                          {h.down}/{h.cells.length}
                        </span>
                      </span>
                      <span className="cast-hull-squares">{h.squares.join(", ")}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>

          {/*
            Result markers. One switch for the sprite AND the cell fill together: turning off only
            the sprite leaves a fully colour-coded board, which is not what anybody means by taking
            the icons off. What survives either way is the attribution ring, so the board still says
            which squares have been shot at and by whom - see lib/overlayMarkers.
          */}
          <section>
            <h3>Result markers</h3>
            <label className="cast-check">
              <input
                type="checkbox"
                checked={view.markers !== false}
                onChange={(e) => set({ markers: e.target.checked })}
              />
              <span>Show hits, misses and wrecks</span>
            </label>
            {view.markers !== false && teams.length > 1 && (
              <>
                <div className="cast-buttons">
                  <button
                    className={!view.markerTeams?.length ? "primary" : ""}
                    onClick={() => set({ markerTeams: null })}
                    title="Every fleet's shots"
                  >
                    All shots
                  </button>
                  {teams.map((t) => {
                    const only = view.markerTeams?.length === 1 && view.markerTeams[0] === t;
                    return (
                      <button
                        key={t}
                        className={only ? "primary" : ""}
                        onClick={() => set({ markerTeams: only ? null : [t] })}
                        style={{ color: teamHex(t) }}
                        title={`Only ${teamName(t)}'s shots get markers`}
                      >
                        {teamName(t)}
                      </button>
                    );
                  })}
                </div>
                <p className="cast-note muted">
                  Whose <em>shots</em> are marked - separate from whose board is on screen.
                </p>
              </>
            )}
            {view.markers === false && (
              <p className="cast-note muted">
                Squares keep their coloured outline, so the board still shows who has fired where.
                The names get the whole square.
              </p>
            )}
          </section>

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
              The monitor above shows the same fade, over this page's background rather than
              gameplay. Real footage is busier than this.
            </p>
          </section>

          <section>
            <h3>Browser sources</h3>
            <p className="muted cast-note">
              Add each as a Browser Source in OBS. The board follows this page. The timer and the
              colour key run on their own.
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
