/**
 * The arithmetic behind the byte meter.
 *
 * Worth asserting rather than eyeballing, because every failure mode of this feature is silent. A
 * meter that undercounts realtime by a third still draws a tidy panel with a plausible number on it,
 * and there is nothing to compare it against - the whole reason it exists is that no other source
 * knows the answer. Nobody will notice it is wrong; they will just make a capacity decision on it.
 *
 * Three things are checked, and they are the three that could be quietly wrong:
 *
 *   utf8Len       the hand-rolled encoder, against TextEncoder, which is the thing it replaces
 *   frameOverhead the websocket header boundaries, which are off-by-one country
 *   readRoute     what a URL says a tab is, which decides both whether it reports and how it is
 *                 filed - and a route that falls through to "site" reports nothing at all
 *
 * Plus matchWindow, which turns a match key into the window the billed half asks Supabase about.
 * Getting that wrong points the query at the wrong ninety minutes and answers confidently.
 *
 * Run by `npm run check`.
 */
import {
  utf8Len,
  frameOverhead,
  readRoute,
  matchWindow,
  bytes,
  shouldFlush,
  SIGNIFICANT_DELTA_BYTES,
  MAX_REPORT_AGE_MS,
} from "../src/lib/egressUnits.ts";

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}

console.log("\nutf8Len - against the encoder it replaces");
const encoder = new TextEncoder();
const samples = [
  "",
  "Godrick the Grafted",
  "Astel, Naturalborn of the Void",
  // Non-ASCII of each width, because the whole point of the hand-rolled version is the branches.
  "café",
  "éèê",
  "中文テスト",
  // A surrogate pair: one code point, four bytes. The naive version counts it as two three-byte
  // characters and reports six.
  "\u{1F525}",
  "shot \u{1F525} at C4",
  JSON.stringify({ event: "postgres_changes", payload: { cell_index: 42, result: "sunk" } }),
];
for (const s of samples) {
  const mine = utf8Len(s);
  const theirs = encoder.encode(s).length;
  ok(`${JSON.stringify(s).slice(0, 34)} -> ${theirs}`, mine === theirs);
}

// An unpaired high surrogate is not a code point and must not be counted as four bytes. Matching
// TextEncoder here matters because a truncated frame is exactly where one turns up.
ok(
  "a lone high surrogate matches TextEncoder",
  utf8Len("\ud83d") === encoder.encode("\ud83d").length
);

console.log("\nframeOverhead - the websocket header boundaries");
ok("0 bytes -> 2", frameOverhead(0) === 2);
ok("125 bytes -> 2 (last of the short form)", frameOverhead(125) === 2);
ok("126 bytes -> 4 (first of the 16-bit form)", frameOverhead(126) === 4);
ok("65535 bytes -> 4 (last of the 16-bit form)", frameOverhead(65535) === 4);
ok("65536 bytes -> 10 (first of the 64-bit form)", frameOverhead(65536) === 10);

console.log("\nreadRoute - what a URL says a tab is");
const route = (hash: string) => readRoute(hash);
ok("a room is a player until told otherwise", route("#/room/ab12cd").role === "player");
ok("a room code is upper-cased", route("#/room/ab12cd").code === "AB12CD");
ok("the leading # is optional", route("/room/ab12cd").code === "AB12CD");
ok("a query string is not part of the code", route("#/room/AB12CD?spectate=1").code === "AB12CD");
ok("the bare overlay route is an overlay", route("#/overlay/AB12CD").role === "overlay");
ok("a hyphenated overlay is an overlay", route("#/overlay-board/AB12CD").role === "overlay");
ok("overlay-timer too", route("#/overlay-timer/AB12CD").role === "overlay");
ok("overlay-egg too", route("#/overlay-egg/AB12CD").role === "overlay");
ok("the caster desk is a caster", route("#/cast/AB12CD").role === "caster");
ok("the caster desk carries its room", route("#/cast/AB12CD").code === "AB12CD");
// The persistent source has no room in the URL by design, so it must report none - a code invented
// here would file a whole scene's bytes under a room it was never in.
ok("a stream source is an overlay", route("#/stream/board?token=abc").role === "overlay");
ok("a stream source has no room yet", route("#/stream/board?token=abc").code === null);
ok("the leaderboard is not a room", route("#/leaderboard").code === null);
ok("the leaderboard is site traffic", route("#/leaderboard").role === "site");
ok("the front page is site traffic", route("#/").role === "site");
// Every overlay page renders under BOTH routes, so both have to resolve or a persistent scene and a
// room-coded scene would be counted differently for doing exactly the same thing.
ok("an archived match is site traffic", route("#/match/AB12CD:2026-01-01").role === "site");

console.log("\nmatchWindow - the window the billed half asks about");
const KEY = "ANCIENTARMADA:2026-08-29 16:22:09.674681+00";
const FINISHED = "2026-08-29T17:49:48.239152+00:00";
const w = matchWindow(KEY, FINISHED);
ok("a real match key parses", w !== null);
if (w) {
  // Three minutes before the countdown, because the room, the fleets and the overlays all load
  // first and those bytes belong to this match.
  ok("the window opens 3 minutes before the start", w.startedAt === "2026-08-29T16:19:09.674Z");
  ok("the window closes 3 minutes after the end", w.endedAt === "2026-08-29T17:52:48.239Z");
  ok("the window is ordered", +new Date(w.startedAt) < +new Date(w.endedAt));
}
// The timestamp is full of colons, so splitting on the last one - or on all of them - loses the
// clock and silently produces a window around midnight.
ok("splitting keeps the whole timestamp", matchWindow("A:2026-08-29 16:22:09+00", FINISHED) !== null);
ok("a key with no colon is refused", matchWindow("ANCIENTARMADA", FINISHED) === null);
ok("an unparseable time is refused", matchWindow("A:not-a-date", FINISHED) === null);
ok(
  "a match that finished before it started is refused",
  matchWindow(KEY, "2026-08-29T15:00:00+00:00") === null
);

/**
 * The flush policy is the one piece of this feature that can make the site WORSE.
 *
 * Every flush is a real 204 with about 815 bytes of headers on it, billed like anything else. On a
 * fixed sixty-second timer that came to ~716 KB across ten tabs on a 90-minute match - an instrument
 * costing a material fraction of what it measures. These assertions pin the two rules that stop it:
 * nothing is reported until it is worth a round trip, and an idle tab reports nothing at all.
 */
console.log("\nshouldFlush - the meter paying its own way");
const flush = (delta: number, sinceMs: number, closing = false) =>
  shouldFlush({ delta, sinceMs, closing });

ok("nothing counted, nothing sent", flush(0, 60_000) === false);
ok("a negative delta is not a reason to send", flush(-100, 60_000) === false);
// The idle-overlay case, and the whole reason the policy exists: between shots a source receives
// only heartbeat replies, a couple of hundred bytes a minute. Paying ~950 to report ~200 is how a
// meter ends up being most of the bill.
ok("a trickle does not buy a round trip", flush(300, 60_000) === false);
ok("a trickle still does not, ten minutes in", flush(3_000, 10 * 60_000) === false);
ok("enough new bytes sends immediately", flush(SIGNIFICANT_DELTA_BYTES, 1_000) === true);
ok("one byte under the threshold does not", flush(SIGNIFICANT_DELTA_BYTES - 1, 1_000) === false);
// The OBS case: a browser source is killed with the scene and never fires pagehide, so a quiet
// overlay that never crosses the threshold has to be flushed by age or it reports nothing, ever.
ok("age alone eventually sends", flush(1_000, MAX_REPORT_AGE_MS) === true);
ok("just under the age limit holds", flush(1_000, MAX_REPORT_AGE_MS - 1) === false);
ok("closing sends whatever is held", flush(1, 0, true) === true);
// Closing must not manufacture a report out of nothing - an empty upsert would rotate a row's
// updated_at and make an idle tab look like a live one on the panel.
ok("closing with nothing counted still sends nothing", flush(0, 0, true) === false);

// The overhead this bounds, stated as the ratio it actually produces. A tab cannot flush more than
// once per SIGNIFICANT_DELTA_BYTES, so the meter's own cost is pinned as a fraction of the traffic
// it measures rather than growing with wall-clock time.
const FLUSH_COST = 815;
const worstCaseOverhead = FLUSH_COST / SIGNIFICANT_DELTA_BYTES;
ok(
  `delta-driven overhead stays under 1% (${(worstCaseOverhead * 100).toFixed(2)}%)`,
  worstCaseOverhead < 0.01
);

console.log("\nbytes - the readout");
ok("zero", bytes(0) === "0 B");
ok("negative is not a size", bytes(-5) === "0 B");
ok("under a kilobyte", bytes(512) === "512 B");
ok("kilobytes", bytes(2048) === "2.0 KB");
ok("megabytes", bytes(5 * 1024 * 1024) === "5.0 MB");
ok("gigabytes", bytes(3 * 1024 * 1024 * 1024) === "3.00 GB");
ok("NaN is not a size", bytes(Number.NaN) === "0 B");

console.log(fails === 0 ? "\nAll egress checks passed.\n" : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
