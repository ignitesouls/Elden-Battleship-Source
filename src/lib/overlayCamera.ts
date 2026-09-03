// From the layout module rather than from overlayCast, which re-exports them: that one imports
// React and the supabase client, so importing it here would make this module unrunnable outside a
// browser - and being runnable outside one is the entire point of keeping it pure. See the note
// below, and scripts/check-overlay-camera.ts.
import { MAX_ZOOM } from "./overlayBoardLayout";
import type { Attack } from "../types/battleship";

/**
 * A board that aims itself: a slow clockwise lap of the four quadrants, interrupted by the square
 * that was just marked.
 *
 * -- Why the source drives this and not the desk ------------------------------------------------
 *
 * The caster's punch-in (see CasterControl) works the other way round: the control page decides
 * where the camera goes and publishes the resulting cx/cy. That is right for a gesture - it happens
 * once, when a caster does something - and wrong for a lap, which is a position that changes
 * continuously for as long as the broadcast runs.
 *
 * Published, a lap would be a full frame every ~110ms for the whole glide (see MIN_SEND_GAP_MS),
 * each one carrying every fleet's placements, forever. That is precisely the traffic PING_EVENT was
 * added to delete. So the wire carries the SETTINGS - four small fields, sent once - and both ends
 * work the position out for themselves from them.
 *
 * That only holds if both ends agree exactly, which is why this is a pure module with no clock and
 * no React in it: the browser source and the control page's monitor call the same two functions
 * with the same inputs and land on the same pixel. Same arrangement, and the same reason, as
 * lib/overlayMarkers and lib/castFrame. See scripts/check-overlay-camera.ts.
 *
 * A pinned player source has no desk at all, so it must be able to do this alone anyway - which
 * settles the question by itself.
 *
 * -- Why the lap is exactly four points ---------------------------------------------------------
 *
 * At 2x the board is twice the frame, so placeBoard clamps the reachable centre to [0.25, 0.75] on
 * both axes: the four corners of that box ARE the four quadrant centres, and a clockwise lap of
 * them shows the whole board in four framings with nothing missed between them.
 *
 * That is also why the motion runs at MAX_ZOOM and takes no zoom setting. At 1.5x the corners frame
 * overlapping thirds and "the quadrant holding that square" stops being a true sentence; past 2x
 * there is no room left (see the cap's note in overlayCast). One zoom is not a limitation here, it
 * is the thing that makes the spotlight and the lap the same four points - so a spotlight can hand
 * the lap back mid-stride instead of the two fighting over the camera.
 */

/** What a camera hands back: where to look, and how close. */
export interface CameraPoint {
  cx: number;
  cy: number;
  zoom: number;
}

/**
 * The settings, as they travel - on a cast frame, or parsed off a source's URL.
 *
 * `since` is the lap's origin: the moment corner 0 (north-west) started its dwell. It is on the
 * wire rather than assumed to be "when the source started", because the control page's monitor and
 * the browser source start at different times and must nonetheless be at the same corner.
 */
export interface CastMotion {
  /** The clockwise lap. Off leaves the board where its URL or its caster put it. */
  pan: boolean;
  /** Seconds for one full lap of all four quadrants. */
  lap: number;
  /** Seconds a marked square holds the camera. 0 turns the spotlight off. */
  spot: number;
  /** Epoch ms the lap counts from. */
  since: number;
}

/**
 * How long the camera takes to move somewhere it has decided to go.
 *
 * Six times the drag glide in OverlayBoard.css, and deliberately: that one exists to fill the gaps
 * between a caster's rate-limited frames and wants to be invisible, while this is a cut somebody is
 * meant to notice and follow. Under half a second the board appears to jump; past a second and a
 * half the spotlight has spent its whole hold travelling.
 */
export const GLIDE_MS = 800;

/**
 * How much of each leg of the lap is spent moving rather than sitting still.
 *
 * The board is mostly text, and text cannot be read while it slides. So the lap dwells on a
 * quadrant for most of its leg and then moves on briskly, rather than crawling continuously: a
 * viewer gets a stationary quarter-board to read, which is the entire reason for zooming in.
 */
export const GLIDE_SHARE = 0.3;

export const MIN_LAP = 40;
export const MAX_LAP = 600;
export const DEFAULT_LAP = 160;

export const MIN_SPOT = 2;
export const MAX_SPOT = 30;
export const DEFAULT_SPOT = 6;

/** Nothing moving: the shape a source holds when neither option is on. */
export const NO_MOTION: CastMotion = { pan: false, lap: DEFAULT_LAP, spot: 0, since: 0 };

/** Whether these settings actually ask for anything. */
export function motionRuns(m: CastMotion | null | undefined): m is CastMotion {
  return Boolean(m && (m.pan || m.spot > 0));
}

export function clampLap(secs: number): number {
  if (!Number.isFinite(secs)) return DEFAULT_LAP;
  return Math.min(MAX_LAP, Math.max(MIN_LAP, secs));
}

export function clampSpot(secs: number): number {
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return Math.min(MAX_SPOT, Math.max(MIN_SPOT, secs));
}

/**
 * `?autopan=`, `?lap=` and `?spotlight=` off a source's URL.
 *
 * Returns null when the URL asks for no motion at all, which is what leaves a pinned board sitting
 * exactly where its `?zoom/?cx/?cy` put it - the behaviour every existing overlay URL has.
 *
 * `since` is the caller's, because a URL cannot carry a timestamp that means anything: two sources
 * pasted into the same scene should lap together, and they will if both are handed the same origin
 * (their room's start, or simply their own mount - see the hook).
 */
export function readMotion(params: URLSearchParams, since: number): CastMotion | null {
  const pan = params.get("autopan") === "1";
  const spotRaw = params.get("spotlight");
  const spot = spotRaw === null || spotRaw === "" ? 0 : clampSpot(Number(spotRaw));
  if (!pan && spot <= 0) return null;
  const lapRaw = params.get("lap");
  return {
    pan,
    lap: lapRaw === null || lapRaw === "" ? DEFAULT_LAP : clampLap(Number(lapRaw)),
    spot,
    since,
  };
}

/**
 * The four quadrant centres, clockwise from the north-west.
 *
 * Derived from the zoom rather than hard-coded to 0.25/0.75 so the arithmetic states its own
 * reason: `1/(2*zoom)` is exactly the point at which placeBoard stops panning and starts clamping,
 * i.e. the closest the frame's centre can get to an edge without pulling blank space into view.
 */
export function panCorners(zoom: number): CameraPoint[] {
  const lo = 1 / (2 * zoom);
  const hi = 1 - lo;
  return [
    { cx: lo, cy: lo, zoom },
    { cx: hi, cy: lo, zoom },
    { cx: hi, cy: hi, zoom },
    { cx: lo, cy: hi, zoom },
  ];
}

/**
 * Which of those four corners holds these squares.
 *
 * The MEAN of the cells rather than the first, for the same reason punchTo takes one: a two-square
 * kill fills both halves of a duo boss at once (see the fire-on-kill rule) and a hull spans up to
 * five, and the frame should be about the whole object rather than about whichever cell the log
 * happened to write first.
 *
 * A board with an odd number of columns has a middle column that belongs to neither half; it is
 * assigned east and south, which is arbitrary and harmless - the quadrants overlap on screen at 2x
 * anyway, so a square on the seam is in frame either way.
 */
export function quadrantOf(cells: number[], boardSize: number): number {
  if (cells.length === 0 || boardSize <= 0) return 0;
  const mean = (of: (cell: number) => number) => cells.reduce((sum, c) => sum + of(c), 0) / cells.length;
  const east = mean((c) => c % boardSize) >= (boardSize - 1) / 2;
  const south = mean((c) => Math.floor(c / boardSize)) >= (boardSize - 1) / 2;
  if (!south) return east ? 1 : 0;
  return east ? 2 : 3;
}

/** Smoothstep: starts still, ends still. Both ends matter - a camera that stops dead reads as a cut. */
function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Somewhere between two framings.
 *
 * The zoom is TAKEN rather than interpolated. Zoom on this board is cell size, not a transform (see
 * the note in OverlayBoard), so a zoom in flight would re-render the whole grid at a new size every
 * frame and re-fit a hundred square names with it. It lands at once and the pan carries the eye.
 */
function blend(from: CameraPoint, to: CameraPoint, t: number): CameraPoint {
  const k = ease(t);
  return { cx: from.cx + (to.cx - from.cx) * k, cy: from.cy + (to.cy - from.cy) * k, zoom: to.zoom };
}

/**
 * Where the lap is, `elapsed` ms after it began dwelling on `fromCorner`.
 *
 * Each leg is a dwell then a glide to the next corner, and the legs are equal - so a lap of 160s
 * spends 28s still on each quadrant and 12s moving between them.
 */
export function lapPoint(elapsed: number, lapMs: number, corners: CameraPoint[], fromCorner: number): CameraPoint {
  const leg = Math.max(1, lapMs) / 4;
  const glide = leg * GLIDE_SHARE;
  const dwell = leg - glide;
  const since = Math.max(0, elapsed);
  const legIndex = Math.floor(since / leg);
  const t = since - legIndex * leg;
  const a = corners[(fromCorner + legIndex) % 4];
  if (t <= dwell) return a;
  const b = corners[(fromCorner + legIndex + 1) % 4];
  return blend(a, b, (t - dwell) / glide);
}

/**
 * What the camera is doing right now, and since when.
 *
 * Two phases and nothing else. `spot` is holding on a marked square; `lap` is everything else -
 * running the circuit, or simply resting where the URL or the caster left it when `pan` is off.
 *
 * `from` is where the camera was when the phase began, which is what every glide starts from. It
 * has to be carried rather than recomputed: a spotlight that lands mid-glide has to move on from
 * where the board actually IS, and asking "where would the lap have been" cannot answer that once
 * an earlier spotlight has already rebased the circuit.
 */
export interface CameraState {
  phase: "lap" | "spot";
  /** Epoch ms this phase began, on this machine. What every glide is measured from. */
  since: number;
  from: CameraPoint;
  /** The corner being held, or the one the lap resumes its dwell on. */
  corner: number;
  /** The squares under the light. Empty outside a spotlight. */
  cells: number[];
  /**
   * When the lap's dwell on `corner` started - or null for "it never restarted".
   *
   * Two clocks, because they answer different questions. `since` is local and personal: this
   * machine began a glide when it noticed something. The lap is neither - the desk and every source
   * have to be on the SAME quadrant, and a lap timed from each machine's own startup would put a
   * monitor opened an hour ago and a source added a minute ago in opposite corners of the board.
   *
   * So while it is null, the lap runs from `motion.since` - a stamp set once, by whoever engaged
   * it, and carried on the frame. Everyone counts from the same instant and lands on the same
   * corner. It is only set to a real time when a SPOTLIGHT rebases the circuit, which is an event
   * both ends see within a few milliseconds of each other because it arrives on the same realtime
   * row that put the mark on the board.
   */
  lapAt: number | null;
}

/** The resting state, for a source that has just started. */
export function startCamera(base: CameraPoint, now: number): CameraState {
  return { phase: "lap", since: now, from: base, corner: 0, cells: [], lapAt: null };
}

/**
 * Where to point, given the state, the settings, and the framing to fall back to.
 *
 * `base` is the source's own framing - a pinned board's `?zoom/?cx/?cy`, or the caster's current
 * aim. With the lap off it is simply where the board sits between spotlights, which is what makes
 * "hold the square, then reset" mean going back to the shot the streamer set up rather than to some
 * position this module invented.
 */
export function cameraAt(state: CameraState, motion: CastMotion, base: CameraPoint, now: number): CameraPoint {
  const corners = panCorners(MAX_ZOOM);
  const t = (now - state.since) / GLIDE_MS;

  if (state.phase === "spot") return blend(state.from, corners[state.corner], t);

  // Resting. The whole board at 1x is the usual `base`, where the glide is invisible anyway -
  // placeBoard centres a board that fits its frame and ignores cx/cy entirely.
  if (!motion.pan) return blend(state.from, base, t);

  /**
   * The circuit. Blended out of `from` over the same glide, so entering the lap - at startup, or
   * when a spotlight hands the camera back - is a move rather than a jump.
   *
   * After a spotlight, `from` IS the corner the lap resumes on, so the blend is between a point and
   * itself and the board simply sits still. That is the whole trick behind "carry on from there":
   * the spotlight leaves the camera parked exactly where the next dwell starts.
   */
  // The lap's own clock, which is shared, not this machine's - see `lapAt`.
  const lapFrom = state.lapAt ?? motion.since;
  return blend(state.from, lapPoint(now - lapFrom, motion.lap * 1000, corners, state.corner), t);
}

/**
 * The newest square to have been marked, out of the shots a board is actually drawing.
 *
 * Ordered by `created_at` rather than by array position, for the reason spelled out on the caster's
 * `newestShot`: the log arrives from two places - an initial fetch and the realtime stream - and
 * only the timestamp is authoritative about which row is last. Pending rows are skipped because
 * they have no result to point at yet, and negative indices are the match-start bookkeeping row.
 *
 * Handed the board's own `marked` set rather than the whole log, so a board follows the shots it
 * draws: a crew's fire board tracks their own hunt, and a caster who has filtered markers down to
 * one fleet gets a camera that agrees with what is on screen.
 *
 * Every cell sharing that timestamp comes back together. Two squares written in one transaction are
 * one event - a duo boss fills both halves at once (see the fire-on-kill rule) - and the camera
 * frames them as one object rather than picking whichever row the log wrote first.
 *
 * The key changes when, and only when, the answer does: it is what tells the hook a NEW square has
 * been marked, and the cells array is rebuilt on every render.
 */
export function newestMarked(attacks: Attack[]): { cells: number[]; key: string } | null {
  let at = "";
  for (const a of attacks) {
    if (a.cell_index < 0 || a.result === "pending") continue;
    if (a.created_at > at) at = a.created_at;
  }
  if (at === "") return null;
  const cells = [
    ...new Set(
      attacks.filter((a) => a.created_at === at && a.cell_index >= 0 && a.result !== "pending").map((a) => a.cell_index)
    ),
  ];
  return { cells, key: `${at}|${cells.join(",")}` };
}

/** A square (or a hull, or a duo kill) that has just been marked, and when this source noticed. */
export interface SpotEvent {
  cells: number[];
  at: number;
}

/**
 * The state one tick later.
 *
 * Returns the SAME object when nothing has changed, so a caller can use identity to decide whether
 * anything needs re-rendering - which matters here, because this is called from an animation frame
 * and the thing it would re-render is a hundred fitted square names.
 *
 * A spotlight landing during a spotlight retargets and restarts the hold, exactly as punchTo does.
 * The hold is measured from the moment the camera started moving, so `spot` seconds is the total
 * the square owns the frame, glide included - the setting says how long the board is about that
 * square, not how long it sits still afterwards.
 */
export function nextCamera(
  prev: CameraState,
  opts: {
    motion: CastMotion;
    base: CameraPoint;
    boardSize: number;
    /** The newest marked square, or null when nothing has been marked yet. */
    spot: SpotEvent | null;
    now: number;
  }
): CameraState {
  const { motion, base, boardSize, spot, now } = opts;

  // A spotlight this state hasn't seen. `at` is when the source noticed the row, not the row's own
  // timestamp: a source that joins mid-match must not open by punching onto a shot from ten minutes
  // ago, and useBoardCamera only raises an event for a shot that arrives while it is watching.
  if (motion.spot > 0 && spot && spot.at > prev.since) {
    return {
      phase: "spot",
      since: now,
      from: cameraAt(prev, motion, base, now),
      corner: quadrantOf(spot.cells, boardSize),
      cells: spot.cells,
      // Carried, not cleared: a spotlight that is interrupted before it hands the camera back must
      // not send the lap all the way round to motion.since's corner.
      lapAt: prev.lapAt,
    };
  }

  if (prev.phase === "spot" && now - prev.since >= motion.spot * 1000) {
    return {
      phase: "lap",
      since: now,
      // Parked on the corner it was holding, which is where the lap picks up its dwell.
      from: cameraAt(prev, motion, base, now),
      corner: prev.corner,
      cells: [],
      // The circuit restarts HERE, on this quadrant, with a full dwell before it moves on. This is
      // the whole of "carry on from there" - and the one moment the lap's clock stops being the
      // shared one, which is safe because both ends leave the spotlight on the same realtime row.
      lapAt: now,
    };
  }

  return prev;
}
