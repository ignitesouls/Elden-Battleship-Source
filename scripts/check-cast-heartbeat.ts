/**
 * The heartbeat's unchanged-frame shortcut.
 *
 * A beat proves the controller is alive; it is not news. For most of a match there is no news, so
 * an unchanged beat sends a stamp instead of every fleet's placements. The saving is real - it was
 * the largest single line on the Realtime bill - but the failure mode if this logic inverts is the
 * worst one the overlay has: a caster moves a control, a ping goes out instead of a frame, and the
 * board on stream sits there showing the old view looking perfectly healthy. No error, no blank
 * source, nothing to notice until somebody says "why isn't it zooming".
 *
 * So the rule is asserted in both directions, and every field of `view` that a caster can actually
 * move is checked to produce a real frame. Run by `npm run check`.
 */
import { castSendKind, frameKey, DEFAULT_VIEW } from "../src/lib/castFrame.ts";
import type { CastMessage, CastView } from "../src/lib/overlayCast.ts";

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}

const frame = (view: Partial<CastView> = {}, fleets: CastMessage["fleets"] = []): CastMessage => ({
  view: { ...DEFAULT_VIEW, ...view },
  fleets,
  at: 1_000,
});

console.log("\nframeKey - what counts as a change");
ok("an identical frame keys the same", frameKey(frame()) === frameKey(frame()));
ok(
  "a LATER stamp is not a change - the whole point",
  frameKey({ ...frame(), at: 9_999_999 }) === frameKey(frame())
);

// Every control a caster can physically move. A view field that stopped being compared would be a
// control that silently stopped working on stream, so they are enumerated rather than spot-checked.
const moved: [string, Partial<CastView>][] = [
  ["mode", { mode: "all" }],
  ["zoom", { zoom: 1.5 }],
  ["pan x", { cx: 0.25 }],
  ["pan y", { cy: 0.75 }],
  ["names", { names: false }],
  ["coords", { coords: false }],
  ["opacity", { opacity: 0.5 }],
  ["visible", { visible: false }],
  ["markers", { markers: false }],
  ["marker fleets", { markerTeams: [1] }],
  ["spotlight", { spot: [42] }],
  ["spotlight colour", { spotColor: "#ff0000" }],
  ["text size", { text: 0.5 }],
];
for (const [name, patch] of moved) {
  ok(`moving ${name} is a change`, frameKey(frame(patch)) !== frameKey(frame()));
}

console.log("\nframeKey - the ships");
const blue = { team: 1, placements: [{ shipIndex: 0, startRow: 0, startCol: 0, isHorizontal: true }] };
const moved1 = { team: 1, placements: [{ shipIndex: 0, startRow: 1, startCol: 0, isHorizontal: true }] };
ok("revealing a fleet is a change", frameKey(frame({}, [blue])) !== frameKey(frame()));
ok("a hull moving is a change", frameKey(frame({}, [blue])) !== frameKey(frame({}, [moved1])));

console.log("\ncastSendKind - the shortcut");
const key = frameKey(frame());
ok("nothing sent yet always sends a frame", castSendKind(null, key, false) === "state");
ok("an unchanged frame pings", castSendKind(key, key, false) === "ping");
ok("a changed frame sends a frame", castSendKind(key, frameKey(frame({ zoom: 2 })), false) === "state");

console.log("\ncastSendKind - hello outranks the shortcut");
// A source that just announced itself is holding NOTHING. That the OTHER sources already have this
// frame is exactly the wrong reason to answer it with a stamp - it would sit blank until the caster
// happened to touch something.
ok("force sends a frame even when unchanged", castSendKind(key, key, true) === "state");
ok("force sends a frame when changed too", castSendKind(key, frameKey(frame({ zoom: 2 })), true) === "state");

console.log(fails === 0 ? "\nAll cast-heartbeat checks passed." : `\n${fails} cast-heartbeat check(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
