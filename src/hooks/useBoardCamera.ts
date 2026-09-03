import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  cameraAt,
  motionRuns,
  nextCamera,
  startCamera,
  type CameraPoint,
  type CameraState,
  type CastMotion,
  type SpotEvent,
} from "../lib/overlayCamera";
import { placeBoard } from "../lib/overlayBoardLayout";

/**
 * Runs the self-aiming board: the clockwise lap, and the spotlight that interrupts it.
 *
 * -- Why the pan is written straight onto the element ------------------------------------------
 *
 * The obvious version keeps cx/cy in state and lets React render them. That would re-render this
 * page sixty times a second, and this page's render is not cheap: BoardGrid lays out a hundred-odd
 * squares and lib/textFit measures a name into every one of them. The same cost is why the clock
 * was lifted into its own component (see OverlayClock) - to stop ONE re-render a second.
 *
 * So the loop writes `left` and `top` on the stage itself and React never learns the camera moved.
 * What React is still told about is the two things it genuinely owns: the zoom, which is a real
 * cell size and a real re-layout, and the squares under the light. Both change only when a phase
 * begins - a few times a match rather than a few times a frame.
 *
 * The page must therefore leave `left`/`top` out of the stage's style object entirely while this is
 * running. A style object that carries them would have React clear them on its next render and the
 * board would snap to the corner for a frame. See the `running` check in OverlayBoard.
 *
 * -- Why the CSS glide is turned off --------------------------------------------------------
 *
 * .ovb-stage has a 140ms transition on left/top, and it is there to interpolate between a caster's
 * rate-limited frames. This loop is already producing a position every frame with its own easing,
 * so leaving the transition on would stack a second, lagging smoothing on top of the first. The
 * page hangs .ovb-motion on the stage to switch it off.
 */
export interface BoardCamera {
  /** Attach to the stage element. Stable, so it can be composed with useBoxSize's ref. */
  attach: (el: HTMLElement | null) => void;
  /** True while this hook owns the framing. */
  running: boolean;
  /** The zoom to render the board at - the only part of the camera React has to know about. */
  zoom: number;
  /** Squares under the light, for the ring. Empty except during a spotlight. */
  spotCells: number[];
}

export function useBoardCamera(opts: {
  motion: CastMotion | null;
  /** Where the board rests: the URL's framing, or the caster's own aim. */
  base: CameraPoint;
  boardSize: number;
  /**
   * The newest square to have been marked on THIS board, and a key that changes when it does.
   *
   * A key rather than the cells themselves, because the cells are a fresh array on every render and
   * an effect keyed on them would fire the spotlight continuously.
   */
  newest: { cells: number[]; key: string } | null;
  /** The measured frame and board, which is what placeBoard turns a centre into an offset with. */
  frame: { w: number; h: number };
  stage: { w: number; h: number };
  /**
   * Every position, as it is drawn. Must be stable - it is called on every animation frame.
   *
   * For the caster's desk, which has to be able to hand the camera BACK: taking the wheel while the
   * lap is mid-quadrant should leave the board exactly where it is and let the caster aim on from
   * there. Without this the view would snap to wherever the desk had been resting, on stream, at
   * the moment somebody reached for the controls. A source has no use for it.
   */
  onPoint?: (at: CameraPoint) => void;
}): BoardCamera {
  const { motion, base, boardSize, newest, frame, stage, onPoint } = opts;
  const running = motionRuns(motion);

  const el = useRef<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    el.current = node;
  }, []);

  /**
   * Everything the loop reads, kept in a ref so the loop itself never has to be rebuilt.
   *
   * Written from an effect rather than during render - the same arrangement as `viewRef` on the
   * caster's page. The loop is therefore one paint behind on a resize, which is invisible, and the
   * alternative is a write during render that React is entitled to throw away and re-run.
   */
  const live = useRef({ motion, base, boardSize, frame, stage });
  useEffect(() => {
    live.current = { motion, base, boardSize, frame, stage };
  }, [motion, base, boardSize, frame, stage]);

  const state = useRef<CameraState>(startCamera(base, Date.now()));
  const spot = useRef<SpotEvent | null>(null);
  // Through a ref so a caller can pass an inline arrow without rebuilding the loop each render.
  const onPointRef = useRef(onPoint);
  useEffect(() => {
    onPointRef.current = onPoint;
  }, [onPoint]);

  /**
   * Raise a spotlight for a square that has just been marked.
   *
   * The FIRST value is deliberately swallowed. A source opened mid-match - or reopened after OBS
   * restarted a scene - has a whole log waiting for it, and its newest row is whatever happened
   * before anyone was watching this source. Punching onto that would put the stream on a square
   * nothing is happening at, for a hold, at the worst possible moment.
   */
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!newest) return;
    if (seen.current === null) {
      seen.current = newest.key;
      return;
    }
    if (seen.current === newest.key) return;
    seen.current = newest.key;
    spot.current = { cells: newest.cells, at: Date.now() };
  }, [newest]);

  const [zoom, setZoom] = useState(base.zoom);
  const [spotCells, setSpotCells] = useState<number[]>([]);
  /**
   * The zoom React has been told about.
   *
   * Compared here rather than leaving it to setState's own bail-out, because this is called on
   * every animation frame: React does discard an identical value, but only after scheduling the
   * work to find that out, sixty times a second, forever.
   */
  const drawnZoom = useRef(base.zoom);

  useLayoutEffect(() => {
    if (!running) return;
    let frameId = 0;

    const tick = () => {
      frameId = requestAnimationFrame(tick);
      const now = Date.now();
      const cur = live.current;
      if (!cur.motion) return;

      const before = state.current;
      const after = nextCamera(before, {
        motion: cur.motion,
        base: cur.base,
        boardSize: cur.boardSize,
        spot: spot.current,
        now,
      });
      state.current = after;
      // Identity, not equality: nextCamera returns the same object when nothing has changed, and a
      // phase change is the only thing React needs to hear about.
      if (after !== before) {
        setSpotCells(after.cells);
      }

      const at = cameraAt(after, cur.motion, cur.base, now);
      onPointRef.current?.(at);
      if (drawnZoom.current !== at.zoom) {
        drawnZoom.current = at.zoom;
        setZoom(at.zoom);
      }

      const node = el.current;
      if (!node) return;
      node.style.left = `${placeBoard(cur.stage.w, cur.frame.w, at.cx)}px`;
      node.style.top = `${placeBoard(cur.stage.h, cur.frame.h, at.cy)}px`;
    };

    tick();
    return () => cancelAnimationFrame(frameId);
  }, [running]);

  /**
   * Hand the framing back when the motion is switched off mid-match.
   *
   * The loop stops where it happens to be, and React re-takes `left`/`top` on its next render - but
   * the board would keep the zoom the lap was running at until something else changed it, which is
   * a caster turning the lap off and finding themselves at 2x on a quadrant they didn't choose.
   */
  const baseZoom = base.zoom;
  useEffect(() => {
    if (running) return;
    state.current = startCamera(live.current.base, Date.now());
    // Guarded rather than set unconditionally: this effect re-runs whenever the resting zoom
    // changes, and a fresh [] handed to setState is a new identity every time - which on a source
    // that is NOT running a camera would be a re-render of the whole board for nothing.
    setSpotCells((cells) => (cells.length === 0 ? cells : []));
    drawnZoom.current = baseZoom;
    setZoom(baseZoom);
  }, [running, baseZoom]);

  return { attach, running, zoom, spotCells };
}
