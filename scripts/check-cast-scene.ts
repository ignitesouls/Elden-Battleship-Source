/**
 * The casting set scene: the layout arithmetic, and the two-scene collection built from it.
 *
 * Two things nobody finds out about until they are live. A box placed a few pixels off the canvas
 * is a stream with a slice of black down one edge; a malformed collection is refused by OBS with a
 * message that says nothing. So the layout is asserted to stay on the canvas for every roster shape
 * the setup page offers, and the collection is asserted to hold together - two scenes, unique source
 * names, every item pointing at a real source - and to carry the overlay token and nothing else.
 *
 * Run by `npm run check`.
 */
import {
  screenRects,
  boardRect,
  clockRect,
  castCamRects,
  casterCamRects,
  castSceneRects,
  columnCounts,
  CAST_CANVAS,
} from "../src/lib/castSceneLayout.ts";
import { buildCastCollection, CAST_SCENE_MAIN, CAST_SCENE_BREAK } from "../src/lib/obsScene.ts";

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = "https://example.test/Elden-Battleship/";

function counter() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

const CONFIGS = [2, 3, 4].flatMap((teams) => [1, 2, 3, 4].map((perTeam) => ({ teams, perTeam })));

console.log("layout - nothing off the canvas");
for (const cfg of CONFIGS) {
  const rects = castSceneRects(cfg);
  const inside = rects.every(
    (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= CAST_CANVAS.w + 0.5 && r.y + r.h <= CAST_CANVAS.h + 0.5
  );
  ok(`${cfg.teams}x${cfg.perTeam}: every box is on the canvas`, inside);
}
ok(
  "the caster-cam boxes are on the canvas",
  casterCamRects().every(
    (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= CAST_CANVAS.w + 0.5 && r.y + r.h <= CAST_CANVAS.h + 0.5
  )
);

console.log("\nlayout - the shape holds");
for (const cfg of CONFIGS) {
  const boxes = screenRects(cfg);
  ok(`${cfg.teams}x${cfg.perTeam}: one box per competitor`, boxes.length === cfg.teams * cfg.perTeam);
  const { left } = columnCounts(cfg);
  const leftCol = boxes.slice(0, left);
  const rightCol = boxes.slice(left);
  // Left column sits left of centre, right column right of it - so the two crews are on opposite
  // sides of the board rather than stacked in one place.
  ok(
    `${cfg.teams}x${cfg.perTeam}: the two columns are on opposite sides`,
    leftCol.every((r) => r.x + r.w < CAST_CANVAS.w / 2) && rightCol.every((r) => r.x > CAST_CANVAS.w / 2)
  );
  // Boxes in a column do not overlap each other.
  const sorted = [...leftCol].sort((a, b) => a.y - b.y);
  ok(
    `${cfg.teams}x${cfg.perTeam}: stacked boxes do not overlap`,
    sorted.every((r, i) => i === 0 || r.y >= sorted[i - 1].y + sorted[i - 1].h - 0.5)
  );
}

console.log("\nlayout - the channel: clock, board, caster cams top to bottom");
{
  const board = boardRect();
  const clock = clockRect();
  const cams = castCamRects();
  const wide = screenRects({ teams: 2, perTeam: 4 });
  const leftEdge = Math.max(...wide.slice(0, 4).map((r) => r.x + r.w));
  const rightEdge = Math.min(...wide.slice(4).map((r) => r.x));
  ok("the board sits between the columns", board.x >= leftEdge && board.x + board.w <= rightEdge);
  ok("the clock sits between the columns", clock.x >= leftEdge && clock.x + clock.w <= rightEdge);
  ok("the clock is above the board", clock.y + clock.h <= board.y);
  ok("there are two caster cams", cams.length === 2);
  ok(
    "the caster cams are below the board and on the canvas",
    cams.every((r) => r.y >= board.y + board.h && r.y + r.h <= CAST_CANVAS.h + 0.5)
  );
  ok(
    "the caster cams sit centred in the channel, not over the columns",
    cams.every((r) => r.x >= leftEdge && r.x + r.w <= rightEdge)
  );
  ok("the caster cams do not overlap each other", cams[0].x + cams[0].w <= cams[1].x);
}

console.log("\ncollection - shape");
{
  const file = buildCastCollection({ base: BASE, token: TOKEN, config: { teams: 2, perTeam: 3 }, newId: counter() });
  const scenes = file.sources.filter((s) => s.id === "scene");
  const browsers = file.sources.filter((s) => s.id === "browser_source");

  ok("exactly two scenes", scenes.length === 2);
  ok(
    "the scenes are the cast layout and the break",
    scenes.map((s) => s.name).sort().join(",") === [CAST_SCENE_BREAK, CAST_SCENE_MAIN].sort().join(",")
  );
  ok("the collection opens on the cast layout", file.current_scene === CAST_SCENE_MAIN);
  ok("scene_order lists both scenes", file.scene_order.length === 2);
  // EB Cast: 6 screens + board + clock + the bottom caster-box frame. EB Casters: the break frame.
  ok("one browser source per box", browsers.length === 6 + 2 + 1 + 1);
  ok("every source name is unique", new Set(browsers.map((s) => s.name)).size === browsers.length);

  const uuids = new Set(browsers.map((s) => s.uuid));
  for (const scene of scenes) {
    const settings = scene.settings as { items: { source_uuid: string; id: number }[]; id_counter: number };
    ok(
      `${scene.name}: every item points at a source that exists`,
      settings.items.every((i) => uuids.has(i.source_uuid))
    );
    ok(`${scene.name}: item ids are unique`, new Set(settings.items.map((i) => i.id)).size === settings.items.length);
    ok(
      `${scene.name}: id_counter is past every item id`,
      settings.id_counter > Math.max(...settings.items.map((i) => i.id))
    );
  }

  ok(
    "every source shuts down when hidden",
    browsers.every((s) => (s.settings as { shutdown: boolean }).shutdown === true)
  );
}

console.log("\ncollection - the URLs");
{
  const file = buildCastCollection({ base: BASE, token: TOKEN, config: { teams: 2, perTeam: 3 }, newId: counter() });
  const urls = file.sources
    .filter((s) => s.id === "browser_source")
    .map((s) => (s.settings as { url: string }).url);

  ok("every URL carries the overlay token", urls.every((u) => u.includes(`token=${TOKEN}`)));
  ok("every URL is a persistent /stream/ route", urls.every((u) => u.includes("#/stream/")));
  ok("no rejoin code in any URL", urls.every((u) => !/[?&]key=/.test(u)));
  ok("no room code baked into any URL", urls.every((u) => !/#\/overlay-/.test(u)));

  const screens = urls.filter((u) => u.includes("#/stream/screen?"));
  ok("six screen sources", screens.length === 6);
  ok(
    "each screen carries a distinct slot",
    new Set(screens.map((u) => new URL(u.replace("#/", "")).searchParams.get("slot"))).size === 6
  );

  const clock = urls.find((u) => u.includes("#/stream/timer?"))!;
  ok("the clock carries no delay when none was asked for", !/[?&]delay=/.test(clock));

  const frames = urls.filter((u) => u.includes("#/stream/frame?"));
  ok("two frame sources - the bottom caster boxes and the break scene", frames.length === 2);
  ok("one frame is the in-scene caster boxes", frames.some((u) => /[?&]layout=cast(&|$)/.test(u)));
  ok("one frame is the break screen", frames.some((u) => /[?&]layout=casters(&|$)/.test(u)));
}
{
  const file = buildCastCollection({
    base: BASE,
    token: TOKEN,
    config: { teams: 2, perTeam: 3 },
    delayMs: 4200,
    newId: counter(),
  });
  const clock = file.sources
    .filter((s) => s.id === "browser_source")
    .map((s) => (s.settings as { url: string }).url)
    .find((u) => u.includes("#/stream/timer?"))!;
  ok("a delay is written onto the clock's URL", /[?&]delay=4200/.test(clock));
}

console.log("\ncollection - deterministic");
{
  const opts = { base: BASE, token: TOKEN, config: { teams: 2, perTeam: 3 }, delayMs: 3000 };
  const a = JSON.stringify(buildCastCollection({ ...opts, newId: counter() }));
  const b = JSON.stringify(buildCastCollection({ ...opts, newId: counter() }));
  ok("the same inputs build the same file", a === b);
}

console.log(fails === 0 ? "\nAll casting scene checks passed." : `\n${fails} casting scene check(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
