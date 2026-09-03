/**
 * The board that aims itself, asserted where it can be.
 *
 * This is the module two machines run independently and expect to agree on - the browser source in
 * OBS and the control page's monitor, from the same settings and the same shot log, with nothing
 * passing between them once the lap is engaged. If they disagree, the desk shows a caster a framing
 * the stream is not on, which is the one failure a monitor exists to make impossible.
 *
 * The arithmetic underneath it is also the kind nobody can eyeball: whether the corners at 2x are
 * the exact points placeBoard stops panning at, whether a lap dwells before it glides or after,
 * whether a spotlight hands the camera back to the quadrant it was holding or to the one the lap
 * would have reached anyway. Every one of those looks fine in a screenshot and wrong on air.
 *
 * Run by `npm run check`.
 */
import { registerHooks } from "node:module";
import type { CameraPoint, CastMotion } from "../src/lib/overlayCamera.ts";
import type { Attack } from "../src/types/battleship.ts";

// App modules import each other without file extensions, which Vite resolves and Node does not.
// Same hook, and the same reason, as check-deep-water.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  cameraAt,
  clampLap,
  clampSpot,
  GLIDE_MS,
  GLIDE_SHARE,
  lapPoint,
  motionRuns,
  newestMarked,
  nextCamera,
  panCorners,
  quadrantOf,
  readMotion,
  startCamera,
  DEFAULT_LAP,
  MAX_LAP,
  MIN_LAP,
  MAX_SPOT,
  MIN_SPOT,
} = await import("../src/lib/overlayCamera.ts");
// The zoom cap and the pan clamp, from the pure module that owns both. Importing them from
// lib/overlayCast - which re-exports them - would drag React and the supabase client in here.
const { MAX_ZOOM, placeBoard } = await import("../src/lib/overlayBoardLayout.ts");

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

const lap = (over: Partial<CastMotion> = {}): CastMotion => ({
  pan: true,
  lap: 160,
  spot: 6,
  since: 0,
  ...over,
});
/** The whole board, which is where a source rests unless its URL says otherwise. */
const WHOLE: CameraPoint = { cx: 0.5, cy: 0.5, zoom: 1 };

console.log("\npanCorners - the four points, and why they are the four points");
const corners = panCorners(MAX_ZOOM);
ok("four of them", corners.length === 4);
ok("at 2x they are the quadrant centres", corners.every((c) => (near(c.cx, 0.25) || near(c.cx, 0.75)) && (near(c.cy, 0.25) || near(c.cy, 0.75))));
ok("clockwise from the north-west", corners[0].cx < corners[1].cx && corners[1].cy < corners[2].cy && corners[2].cx > corners[3].cx);
/**
 * The load-bearing one. A corner past the clamp would look identical on the monitor and dwell on a
 * band of blank space on stream, because placeBoard would refuse to pan that far.
 */
const FRAME = 1000;
const BOARD = FRAME * MAX_ZOOM;
ok(
  "no corner asks for more pan than placeBoard will give",
  corners.every((c) => {
    const want = FRAME / 2 - c.cx * BOARD;
    return near(placeBoard(BOARD, FRAME, c.cx), Math.min(0, Math.max(FRAME - BOARD, want)), 1e-9);
  })
);
ok("...and they sit exactly ON the clamp, so the lap reaches the edges", near(placeBoard(BOARD, FRAME, corners[0].cx), 0) && near(placeBoard(BOARD, FRAME, corners[2].cx), FRAME - BOARD));
ok("at 1x there is nowhere to go", panCorners(1).every((c) => near(c.cx, 0.5) && near(c.cy, 0.5)));

console.log("\nquadrantOf - which corner holds a square");
// A 10x10 board: columns 0-4 west, 5-9 east; rows likewise.
ok("top-left square is the north-west corner", quadrantOf([0], 10) === 0);
ok("top-right is north-east", quadrantOf([9], 10) === 1);
ok("bottom-right is south-east", quadrantOf([99], 10) === 2);
ok("bottom-left is south-west", quadrantOf([90], 10) === 3);
ok("a duo boss's two squares frame as one object", quadrantOf([90, 91], 10) === 3);
// The mean, not the first cell: a hull straddling the middle belongs where its bulk is.
ok("a hull straddling the seam goes with its bulk", quadrantOf([3, 4, 5], 10) === 0);
ok("no cells is a safe answer, not a crash", quadrantOf([], 10) === 0);

console.log("\nlapPoint - dwell first, then glide");
const LAP_MS = 160_000;
const leg = LAP_MS / 4;
const dwell = leg * (1 - GLIDE_SHARE);
ok("starts on the corner it was given", near(lapPoint(0, LAP_MS, corners, 0).cx, corners[0].cx));
ok("still there most of the way through the leg", near(lapPoint(dwell - 1, LAP_MS, corners, 0).cx, corners[0].cx));
ok("...which is the point: a name cannot be read while it slides", near(lapPoint(dwell * 0.5, LAP_MS, corners, 0).cy, corners[0].cy));
const midGlide = lapPoint(dwell + (leg - dwell) / 2, LAP_MS, corners, 0);
ok("halfway through the glide it is between two corners", midGlide.cx > corners[0].cx && midGlide.cx < corners[1].cx);
ok("lands on the next corner", near(lapPoint(leg, LAP_MS, corners, 0).cx, corners[1].cx));
ok("second leg starts from THAT corner", near(lapPoint(leg + dwell - 1, LAP_MS, corners, 0).cx, corners[1].cx));
ok("a full lap comes home", near(lapPoint(LAP_MS, LAP_MS, corners, 0).cx, corners[0].cx) && near(lapPoint(LAP_MS, LAP_MS, corners, 0).cy, corners[0].cy));
ok("and keeps going round", near(lapPoint(LAP_MS * 2.5, LAP_MS, corners, 0).cx, corners[2].cx));
ok("starting from a different corner walks the same circuit", near(lapPoint(leg, LAP_MS, corners, 2).cx, corners[3].cx));
ok("a negative elapsed does not walk backwards", near(lapPoint(-5000, LAP_MS, corners, 0).cx, corners[0].cx));
ok("the lap runs at 2x throughout", lapPoint(leg * 1.5, LAP_MS, corners, 0).zoom === MAX_ZOOM);

console.log("\ncameraAt - the glide in, and what happens with no lap");
const started = startCamera(WHOLE, 0);
ok("a source opens where its URL put it", near(cameraAt(started, lap(), WHOLE, 0).cx, 0.5));
ok("...and moves off it rather than jumping", cameraAt(started, lap(), WHOLE, GLIDE_MS / 2).cx < 0.5);
ok("arrives at the first corner", near(cameraAt(started, lap(), WHOLE, GLIDE_MS).cx, corners[0].cx));
ok("zoom lands at once - it is a re-layout, not a slide", cameraAt(started, lap(), WHOLE, 1).zoom === MAX_ZOOM);
const restOnly = lap({ pan: false });
ok("with no lap it simply rests", near(cameraAt(started, restOnly, WHOLE, 999_999).cx, 0.5) && cameraAt(started, restOnly, WHOLE, 999_999).zoom === 1);

/**
 * The one that would have shipped silently wrong.
 *
 * The lap has to be timed from the stamp on the frame rather than from each machine's own startup,
 * or a monitor that has been open for an hour and a source added a minute ago sit on opposite
 * corners of the board - each perfectly smooth, each certain it is right, and the desk's whole
 * claim to BE the frame quietly false.
 */
console.log("\nthe lap's clock is shared, not local");
const engagedAt = 500_000;
const shared = lap({ since: engagedAt });
const deskOpenedEarly = startCamera(WHOLE, 0);
const sourceAddedLate = startCamera(WHOLE, engagedAt + leg * 2);
const T = engagedAt + leg * 2 + GLIDE_MS;
ok(
  "a machine that started an hour ago and one that just opened agree",
  near(cameraAt(deskOpenedEarly, shared, WHOLE, T).cx, cameraAt(sourceAddedLate, shared, WHOLE, T).cx) &&
    near(cameraAt(deskOpenedEarly, shared, WHOLE, T).cy, cameraAt(sourceAddedLate, shared, WHOLE, T).cy)
);
ok("...and it is the corner the shared clock says", near(cameraAt(sourceAddedLate, shared, WHOLE, T).cx, corners[2].cx));
ok("the lap begins at the north-west when it is engaged", near(cameraAt(deskOpenedEarly, shared, WHOLE, engagedAt + GLIDE_MS).cx, corners[0].cx));

console.log("\nnextCamera - the spotlight takes the camera and hands it back");
const marks = { cells: [99], at: 10_000 };
const running = startCamera(WHOLE, 0);
const lit = nextCamera(running, { motion: lap(), base: WHOLE, boardSize: 10, spot: marks, now: 10_000 });
ok("a new mark starts a spotlight", lit.phase === "spot");
ok("...on the quadrant holding it", lit.corner === 2);
ok("...and remembers the squares, for the ring", lit.cells.length === 1 && lit.cells[0] === 99);
ok("it moves there rather than cutting", cameraAt(lit, lap(), WHOLE, 10_000 + GLIDE_MS / 2).cx < corners[2].cx);
ok("and gets there", near(cameraAt(lit, lap(), WHOLE, 10_000 + GLIDE_MS).cx, corners[2].cx));
ok("holds for the whole setting", nextCamera(lit, { motion: lap(), base: WHOLE, boardSize: 10, spot: marks, now: 15_500 }) === lit);
ok("...returning the SAME state, so nothing re-renders", nextCamera(lit, { motion: lap(), base: WHOLE, boardSize: 10, spot: marks, now: 12_000 }) === lit);

const handedBack = nextCamera(lit, { motion: lap(), base: WHOLE, boardSize: 10, spot: marks, now: 16_000 });
ok("the hold ends", handedBack.phase === "lap");
ok("the light goes out", handedBack.cells.length === 0);
/** The whole of "carry on from there": the lap resumes on the spotlit quadrant, not where it paused. */
ok("the lap resumes on the quadrant it was holding", handedBack.corner === 2);
ok("...standing still, so the viewer gets a full dwell", near(cameraAt(handedBack, lap(), WHOLE, 16_000).cx, corners[2].cx));
ok("...a full one, timed from the handover and not from the lap's own origin", near(cameraAt(handedBack, lap(), WHOLE, 16_000 + dwell - 1).cx, corners[2].cx));
ok("...and moves on to the NEXT corner clockwise", near(cameraAt(handedBack, lap(), WHOLE, 16_000 + leg).cx, corners[3].cx));

console.log("\nnextCamera - retriggers, and the parts that must not fire");
const again = nextCamera(lit, { motion: lap(), base: WHOLE, boardSize: 10, spot: { cells: [0], at: 12_000 }, now: 12_000 });
ok("a second mark during the hold retargets", again.phase === "spot" && again.corner === 0);
ok("...and restarts the clock", nextCamera(again, { motion: lap(), base: WHOLE, boardSize: 10, spot: { cells: [0], at: 12_000 }, now: 17_000 }) === again);
ok(
  "an old mark cannot re-fire a spotlight that already ended",
  nextCamera(handedBack, { motion: lap(), base: WHOLE, boardSize: 10, spot: marks, now: 20_000 }) === handedBack
);
ok(
  "spotlight off means marks are ignored entirely",
  nextCamera(running, { motion: lap({ spot: 0 }), base: WHOLE, boardSize: 10, spot: marks, now: 10_000 }) === running
);
// Spotlight WITHOUT the lap: the same move, and then back to the framing the streamer set up.
const spotOnly = lap({ pan: false });
const litAlone = nextCamera(startCamera(WHOLE, 0), { motion: spotOnly, base: WHOLE, boardSize: 10, spot: marks, now: 10_000 });
ok("with no lap, a mark still takes the camera", litAlone.phase === "spot" && litAlone.corner === 2);
ok("...to the quadrant, not to the square itself", near(cameraAt(litAlone, spotOnly, WHOLE, 10_000 + GLIDE_MS).cx, corners[2].cx));
const reset = nextCamera(litAlone, { motion: spotOnly, base: WHOLE, boardSize: 10, spot: marks, now: 16_000 });
ok("and then resets to the source's own framing", near(cameraAt(reset, spotOnly, WHOLE, 16_000 + GLIDE_MS).cx, 0.5));
ok("...at the zoom that framing asked for", cameraAt(reset, spotOnly, WHOLE, 16_000 + GLIDE_MS).zoom === 1);
const pinned: CameraPoint = { cx: 0.3, cy: 0.7, zoom: 1.4 };
const backToPinned = nextCamera(
  nextCamera(startCamera(pinned, 0), { motion: spotOnly, base: pinned, boardSize: 10, spot: marks, now: 10_000 }),
  { motion: spotOnly, base: pinned, boardSize: 10, spot: marks, now: 16_000 }
);
ok("a pinned board resets to ITS framing, not to the whole board", near(cameraAt(backToPinned, spotOnly, pinned, 99_999).cx, 0.3));

console.log("\nnewestMarked - what the camera follows");
const shot = (cell: number, at: string, result: Attack["result"] = "hit") =>
  ({ cell_index: cell, created_at: at, result }) as Attack;
ok("nothing yet is null", newestMarked([]) === null);
ok("the newest by timestamp, not by position", newestMarked([shot(5, "2026-01-01T00:00:02Z"), shot(9, "2026-01-01T00:00:01Z")])!.cells[0] === 5);
ok("pending rows have nothing to point at", newestMarked([shot(5, "2026-01-01T00:00:01Z"), shot(9, "2026-01-01T00:00:09Z", "pending")])!.cells[0] === 5);
ok("the match-start row is not a shot", newestMarked([shot(-1, "2026-01-01T00:00:09Z"), shot(5, "2026-01-01T00:00:01Z")])!.cells[0] === 5);
ok("one instant, two squares - a duo boss is one event", newestMarked([shot(4, "2026-01-01T00:00:03Z"), shot(5, "2026-01-01T00:00:03Z")])!.cells.length === 2);
ok(
  "one square shot at two fleets is still one square",
  newestMarked([shot(7, "2026-01-01T00:00:03Z"), shot(7, "2026-01-01T00:00:03Z")])!.cells.length === 1
);
const same = newestMarked([shot(5, "2026-01-01T00:00:02Z")])!.key;
ok("the key is stable while the answer is", newestMarked([shot(5, "2026-01-01T00:00:02Z")])!.key === same);
ok("and changes when a new square is marked", newestMarked([shot(5, "2026-01-01T00:00:02Z"), shot(6, "2026-01-01T00:00:03Z")])!.key !== same);

console.log("\nreadMotion - what a URL can ask for");
const q = (s: string) => new URLSearchParams(s);
ok("a URL that asks for nothing gets nothing", readMotion(q(""), 0) === null);
ok("...including one that only names a lap length", readMotion(q("lap=200"), 0) === null);
ok("autopan alone runs a lap with no spotlight", readMotion(q("autopan=1"), 0)!.pan && readMotion(q("autopan=1"), 0)!.spot === 0);
ok("...at the default length", readMotion(q("autopan=1"), 0)!.lap === DEFAULT_LAP);
ok("spotlight alone runs no lap", readMotion(q("spotlight=8"), 0)!.pan === false);
ok("...and holds for what it was told", readMotion(q("spotlight=8"), 0)!.spot === 8);
ok("both together", motionRuns(readMotion(q("autopan=1&lap=240&spotlight=4"), 0)));
ok("a nonsense lap falls back rather than dividing by nothing", readMotion(q("autopan=1&lap=abc"), 0)!.lap === DEFAULT_LAP);
ok("the origin is the caller's", readMotion(q("autopan=1"), 1234)!.since === 1234);

console.log("\nbounds");
ok("a lap cannot be shorter than the glide it is made of", clampLap(1) === MIN_LAP);
ok("...nor longer than an hour of nobody looking", clampLap(99_999) === MAX_LAP);
ok("a hold under two seconds is not a hold", clampSpot(1) === MIN_SPOT);
ok("...and over thirty it is furniture", clampSpot(99) === MAX_SPOT);
ok("zero seconds means off, not clamped up", clampSpot(0) === 0);
ok("nothing running is nothing running", !motionRuns(null) && !motionRuns({ pan: false, lap: 160, spot: 0, since: 0 }));

console.log(fails === 0 ? "\nall overlay camera checks passed\n" : `\n${fails} overlay camera checks FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
