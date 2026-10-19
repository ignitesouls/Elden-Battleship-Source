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
  playerSceneRects,
  playerGameRect,
  playerFireRect,
  playerFleetRect,
  CAST_CANVAS,
  CAST_SEATS,
  type Rect,
} from "../src/lib/castSceneLayout.ts";
import {
  buildCastCollection,
  buildPlayerCollection,
  castSceneParts,
  playerSceneParts,
  CAST_SCENE_MAIN,
  CAST_SCENE_BREAK,
  PLAYER_SCENE,
} from "../src/lib/obsScene.ts";

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

const onCanvas = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= CAST_CANVAS.w && r.y + r.h <= CAST_CANVAS.h;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

console.log("layout - nothing off the canvas");
ok("every box in the match scene is on the canvas", castSceneRects().every(onCanvas));
ok("the break-scene cams are on the canvas", casterCamRects().every(onCanvas));

console.log("\nlayout - the shape holds");
{
  const boxes = screenRects();
  ok("one box per competitor, two fleets of three", boxes.length === CAST_SEATS);
  const leftCol = boxes.slice(0, CAST_SEATS / 2);
  const rightCol = boxes.slice(CAST_SEATS / 2);
  // Left column sits left of centre, right column right of it - so the two crews are on opposite
  // sides of the board rather than stacked in one place.
  ok(
    "the two columns are on opposite sides",
    leftCol.every((r) => r.x + r.w < CAST_CANVAS.w / 2) && rightCol.every((r) => r.x > CAST_CANVAS.w / 2)
  );
  // The rects are the frame art's holes, and holes never overlap - two that did would mean a
  // mis-measured number, and one source drawn over another.
  const all = castSceneRects();
  ok("no two boxes in the match scene overlap", all.every((a, i) => all.every((b, j) => i === j || !overlaps(a, b))));
}

console.log("\nlayout - the channel: clock, board, caster cams top to bottom");
{
  const board = boardRect();
  const clock = clockRect();
  const cams = castCamRects();
  const wide = screenRects();
  const leftEdge = Math.max(...wide.slice(0, CAST_SEATS / 2).map((r) => r.x + r.w));
  const rightEdge = Math.min(...wide.slice(CAST_SEATS / 2).map((r) => r.x));
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
  const file = buildCastCollection({ base: BASE, token: TOKEN, newId: counter() });
  const scenes = file.sources.filter((s) => s.id === "scene");
  const browsers = file.sources.filter((s) => s.id === "browser_source");

  ok("exactly two scenes", scenes.length === 2);
  ok(
    "the scenes are the cast layout and the break",
    scenes.map((s) => s.name).sort().join(",") === [CAST_SCENE_BREAK, CAST_SCENE_MAIN].sort().join(",")
  );
  ok("the collection opens on the cast layout", file.current_scene === CAST_SCENE_MAIN);
  ok("scene_order lists both scenes", file.scene_order.length === 2);
  // EB Cast: 6 screens + board + clock + the match frame + finds + audio. EB Casters: the break frame.
  ok("one browser source per box", browsers.length === 6 + 2 + 1 + 2 + 1);
  ok(
    "only the audio source is routed to the mixer",
    browsers.filter((s) => (s.settings as { reroute_audio: boolean }).reroute_audio).map((s) => s.name).join() === "EB Audio"
  );

  // The match frame's banner is opaque and the clock sits on it, so the clock has to be stacked over
  // the frame - the other way round, the art hides the clock and nothing errors. OBS's file lists
  // items bottom of the stack first, so the clock comes after the frame.
  const main = scenes.find((s) => s.name === CAST_SCENE_MAIN)!;
  const order = (main.settings as { items: { source_uuid: string }[] }).items.map(
    (i) => browsers.find((b) => b.uuid === i.source_uuid)?.name
  );
  ok("the clock is stacked above the frame art", order.indexOf("EB Caster Clock") > order.indexOf("EB Frame"));
  ok("the clock is the top item", order[order.length - 1] === "EB Caster Clock");
  ok(
    "the frame art is stacked above every screen and the board",
    order.filter((n) => n?.startsWith("EB Screen") || n === "EB Board").every((n) => order.indexOf(n) < order.indexOf("EB Frame"))
  );
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
  const file = buildCastCollection({ base: BASE, token: TOKEN, newId: counter() });
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
  ok("two frame sources - the match frame and the break scene", frames.length === 2);
  ok("one frame is the match frame", frames.some((u) => /[?&]layout=cast(&|$)/.test(u)));
  ok("one frame is the break screen", frames.some((u) => /[?&]layout=casters(&|$)/.test(u)));
}
{
  const file = buildCastCollection({
    base: BASE,
    token: TOKEN,
    delayMs: 4200,
    newId: counter(),
  });
  const clock = file.sources
    .filter((s) => s.id === "browser_source")
    .map((s) => (s.settings as { url: string }).url)
    .find((u) => u.includes("#/stream/timer?"))!;
  ok("a delay is written onto the clock's URL", /[?&]delay=4200/.test(clock));
}

console.log("\ncollection - the caster's settings");
{
  const off = buildCastCollection({ base: BASE, token: TOKEN, finds: false, sound: false, newId: counter() });
  const names = off.sources.filter((s) => s.id === "browser_source").map((s) => s.name);
  ok("turning off finds and sound drops those two sources", !names.includes("EB Finds") && !names.includes("EB Audio"));
  ok("and leaves the rest", names.length === 6 + 2 + 1 + 1);

  const tuned = castSceneParts({ base: BASE, token: TOKEN, clockOpacity: 0.8, clockText: 1.25, alertSecs: 10 });
  const clockUrl = tuned.find((p) => p.entry.source.obsName === "EB Caster Clock")!.entry.url;
  ok("clock transparency is written onto the clock", /[?&]opacity=0\.80/.test(clockUrl));
  ok("clock text size is written onto the clock", /[?&]text=1\.25/.test(clockUrl));
  const eggUrl = tuned.find((p) => p.entry.source.obsName === "EB Finds")!.entry.url;
  ok("the alert time is written onto the finds source", /[?&]secs=10/.test(eggUrl));

  const plain = castSceneParts({ base: BASE, token: TOKEN });
  ok(
    "default settings write nothing extra",
    plain.every((p) => !/[?&](opacity|text|secs|delay)=/.test(p.entry.url))
  );
  ok(
    "the find alert sits over the board",
    (() => {
      const egg = plain.find((p) => p.entry.source.obsName === "EB Finds")!;
      const b = boardRect();
      const cx = egg.at.x + egg.entry.source.width / 2;
      const cy = egg.at.y + egg.entry.source.height / 2;
      return Math.abs(cx - (b.x + b.w / 2)) <= 1 && Math.abs(cy - (b.y + b.h / 2)) <= 1;
    })()
  );
}

console.log("\ncollection - deterministic");
{
  const opts = { base: BASE, token: TOKEN, delayMs: 3000 };
  const a = JSON.stringify(buildCastCollection({ ...opts, newId: counter() }));
  const b = JSON.stringify(buildCastCollection({ ...opts, newId: counter() }));
  ok("the same inputs build the same file", a === b);
}

console.log("\nplayer frame - layout");
{
  const holes = playerSceneRects();
  ok("every hole in the player frame is on the canvas", holes.every(onCanvas));
  ok("no two player holes overlap", holes.every((a, i) => holes.every((b, j) => i === j || !overlaps(a, b))));
  const game = playerGameRect();
  ok("the gameplay hole is 16:9 to within a pixel", Math.abs(game.w - (game.h * 16) / 9) <= 1);
}

console.log("\nplayer frame - collection");
{
  const file = buildPlayerCollection({ base: BASE, token: TOKEN, newId: counter() });
  const scenes = file.sources.filter((s) => s.id === "scene");
  const inputs = file.sources.filter((s) => s.id !== "scene");
  const browsers = inputs.filter((s) => s.id === "browser_source");
  ok("exactly one scene, the player scene", scenes.length === 1 && scenes[0].name === PLAYER_SCENE);
  ok("the collection opens on it", file.current_scene === PLAYER_SCENE);
  ok("one game capture and one webcam", inputs.filter((s) => s.id === "game_capture").length === 1 && inputs.filter((s) => s.id === "dshow_input").length === 1);
  const mic = inputs.find((s) => s.id === "wasapi_input_capture");
  const gameAudio = inputs.find((s) => s.id === "wasapi_process_output_capture");
  ok("one mic and one game-audio placeholder", Boolean(mic) && Boolean(gameAudio));
  ok("both audio placeholders arrive muted, so a global mic is never doubled", Boolean(mic?.muted) && Boolean(gameAudio?.muted));
  ok(
    "the game audio is aimed at eldenring.exe",
    String((gameAudio?.settings as { window?: string } | undefined)?.window ?? "").endsWith(":eldenring.exe")
  );
  const names = inputs.map((s) => s.name);
  ok("finds are OFF unless asked for", !names.includes("EB Finds"));
  ok("fleet and sound are on by default", names.includes("EB Your Fleet") && names.includes("EB Audio"));
  ok("every source name is unique", new Set(names).size === names.length);

  const settings = scenes[0].settings as { items: { name: string; source_uuid: string; id: number; bounds_type: number }[]; id_counter: number };
  const uuids = new Set(inputs.map((s) => s.uuid));
  ok("every item points at a source that exists", settings.items.every((i) => uuids.has(i.source_uuid)));
  ok("id_counter is past every item id", settings.id_counter > Math.max(...settings.items.map((i) => i.id)));
  const order = settings.items.map((i) => i.name);
  ok(
    "the frame art is stacked above the game, camera, board and fleet",
    ["ER Gameplay", "Your Webcam", "EB Fire Board", "EB Your Fleet"].every((n) => order.indexOf(n) < order.indexOf("EB Player Frame"))
  );
  ok(
    "the captures get a bounding box and the browser sources don't",
    settings.items.every((i) => (i.name === "ER Gameplay" || i.name === "Your Webcam") === i.bounds_type > 0)
  );

  const game = inputs.find((s) => s.id === "game_capture")!.settings as { capture_mode: string; window: string };
  ok(
    "the game capture is aimed at eldenring.exe in window mode",
    game.capture_mode === "window" && game.window.split(":").length === 3 && game.window.endsWith(":eldenring.exe")
  );

  // The canvas-relative copy must land on the same pixels as the plain one on a 1080p canvas, and
  // scale with the canvas on any other - read back with OBS's own pos_to_absolute (libobs/obs-scene.c).
  type Item = {
    name: string;
    pos: { x: number; y: number };
    pos_rel: { x: number; y: number };
    bounds: { x: number; y: number };
    bounds_rel: { x: number; y: number };
    scale_ref: { x: number; y: number };
  };
  const items = settings.items as unknown as Item[];
  const absolute = (i: Item, w: number, h: number) => ({
    x: (i.pos_rel.x * h + w) / 2,
    y: (i.pos_rel.y * h + h) / 2,
    bw: (i.bounds_rel.x * h) / 2,
    bh: (i.bounds_rel.y * h) / 2,
  });
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  ok(
    "relative placement reads back to the exact pixels on a 1920x1080 canvas",
    items.every((i) => {
      const a = absolute(i, 1920, 1080);
      return near(a.x, i.pos.x) && near(a.y, i.pos.y) && near(a.bw, i.bounds.x) && near(a.bh, i.bounds.y);
    })
  );
  ok(
    "and to the same spot, scaled, on a 2560x1440 canvas",
    items.every((i) => {
      const a = absolute(i, 2560, 1440);
      return near(a.x, (i.pos.x * 2560) / 1920) && near(a.y, (i.pos.y * 1440) / 1080);
    })
  );
  ok("every item names its 1920x1080 reference", items.every((i) => i.scale_ref.x === 1920 && i.scale_ref.y === 1080));

  const urls = browsers.map((s) => (s.settings as { url: string }).url);
  ok("every URL carries the overlay token", urls.every((u) => u.includes(`token=${TOKEN}`)));
  ok("no rejoin code in any URL", urls.every((u) => !/[?&]key=/.test(u)));
  ok("the frame asks for the player layout", urls.some((u) => /#\/stream\/frame\?.*layout=player(&|$)/.test(u)));
  ok("the fire board follows its owner's fleet", urls.some((u) => /#\/stream\/board\?.*me=1/.test(u) && /fire=1/.test(u)));
}
{
  const on = buildPlayerCollection({ base: BASE, token: TOKEN, finds: true, fleet: false, sound: false, newId: counter() });
  const names = on.sources.filter((s) => s.id !== "scene").map((s) => s.name);
  ok("ticking finds adds them; unticking fleet and sound drops them", names.includes("EB Finds") && !names.includes("EB Your Fleet") && !names.includes("EB Audio"));
  const order = (on.sources.find((s) => s.id === "scene")!.settings as { items: { name: string }[] }).items.map((i) => i.name);
  ok("the find alert is stacked above the frame art", order.indexOf("EB Finds") > order.indexOf("EB Player Frame"));

  const egg = playerSceneParts({ base: BASE, token: TOKEN, finds: true }).find((p) => p.name === "EB Finds")!;
  const g = playerGameRect();
  ok(
    "the find alert is centred on the gameplay",
    Math.abs(egg.at.x + 300 - (g.x + g.w / 2)) <= 1 && Math.abs(egg.at.y + 300 - (g.y + g.h / 2)) <= 1
  );
  ok(
    "default settings write nothing extra",
    playerSceneParts({ base: BASE, token: TOKEN }).every((p) => !p.entry || !/[?&](opacity|text|secs|empty)=/.test(p.entry.url))
  );
  // A player building it by hand types the size and the position and nothing else - no rescaling.
  const parts = playerSceneParts({ base: BASE, token: TOKEN });
  const holeSized = (name: string, r: Rect) => {
    const p = parts.find((q) => q.name === name)!;
    return p.at.scale === 1 && p.at.x === r.x && p.at.y === r.y && p.entry!.source.width === r.w && p.entry!.source.height === r.h;
  };
  ok("the fire board's browser source is its hole's size, unscaled", holeSized("EB Fire Board", playerFireRect()));
  ok("the fleet's browser source is its hole's size, unscaled", holeSized("EB Your Fleet", playerFleetRect()));
  ok("no browser source in the player scene is rescaled", parts.every((p) => !p.entry || p.at.scale === 1));
  const a = JSON.stringify(buildPlayerCollection({ base: BASE, token: TOKEN, newId: counter() }));
  const b = JSON.stringify(buildPlayerCollection({ base: BASE, token: TOKEN, newId: counter() }));
  ok("the same inputs build the same file", a === b);
}

console.log(fails === 0 ? "\nAll casting scene checks passed." : `\n${fails} casting scene check(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
