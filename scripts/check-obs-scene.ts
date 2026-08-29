/**
 * The generated OBS scene collection, and the URLs inside it.
 *
 * Both halves of this are things nobody finds out about until they are live. A malformed collection
 * is refused by OBS with a message that says nothing useful; a well-formed one carrying the wrong
 * credential is worse, because it imports perfectly and works, and the streamer has no way to know
 * that the string now sitting in a file they might send to a co-streamer will fire their shots for
 * them.
 *
 * So the shape is asserted - one source per element, every scene item pointing at a source that
 * exists, nothing off the canvas - and so is the one security property that actually matters: an
 * overlay URL carries the overlay token and NOTHING else. Run by `npm run check`.
 */
import { buildObsScene, previewBox, SCENE_CANVAS } from "../src/lib/obsScene.ts";
import { sourcesFor, streamSourceUrl, type SceneKind, type SceneSettings } from "../src/lib/streamSources.ts";

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}

const DEFAULTS: SceneSettings = { opacity: 1, textSize: 1, emptyFade: 1, alertSecs: 6 };
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = "https://example.test/Elden-Battleship/";

/** Deterministic ids, so a scene can be built twice and compared. */
function counter() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function scene(kind: SceneKind, settings: SceneSettings = DEFAULTS, ids = new Set(sourcesFor(kind).map((s) => s.id))) {
  const entries = sourcesFor(kind)
    .filter((s) => ids.has(s.id))
    .map((source) => ({ source, url: streamSourceUrl(BASE, source, TOKEN, settings, DEFAULTS) }));
  return { entries, file: buildObsScene({ kind, entries, sceneName: "EB", newId: counter() }) };
}

for (const kind of ["player", "caster"] as SceneKind[]) {
  console.log(`\n${kind} scene - shape`);
  const { entries, file } = scene(kind);

  const browsers = file.sources.filter((s) => s.id === "browser_source");
  const scenes = file.sources.filter((s) => s.id === "scene");

  ok("exactly one scene", scenes.length === 1);
  ok("one browser source per chosen element", browsers.length === entries.length);
  // Not a formality: OBS matches by name on older versions, so two sources sharing one would
  // silently collapse into a single item and the streamer would lose an element with no error.
  ok("source names are unique", new Set(browsers.map((s) => s.name)).size === browsers.length);
  ok("nothing is combined - every element is its own source", browsers.length > 1);

  const items = (scenes[0].settings as { items: { source_uuid: string; id: number }[] }).items;
  const uuids = new Set(browsers.map((s) => s.uuid));
  ok("one scene item per source", items.length === browsers.length);
  ok(
    "every item points at a source that exists",
    items.every((i) => uuids.has(i.source_uuid))
  );
  ok("item ids are unique", new Set(items.map((i) => i.id)).size === items.length);
  // A counter at or below a live id means the next source the streamer adds by hand collides with
  // one of ours, and OBS resolves that by quietly renumbering somebody.
  ok(
    "id_counter is past every item id",
    (scenes[0].settings as { id_counter: number }).id_counter > Math.max(...items.map((i) => i.id))
  );

  console.log(`\n${kind} scene - browser sources`);
  ok(
    "every source is transparent (no background CSS written)",
    browsers.every((s) => (s.settings as { css: string }).css === "")
  );
  ok(
    "every source shuts down when hidden",
    browsers.every((s) => (s.settings as { shutdown: boolean }).shutdown === true)
  );
  ok(
    "every source carries the dimensions the element was designed at",
    entries.every((e) => {
      const found = browsers.find((b) => b.name === e.source.obsName);
      const settings = found?.settings as { width: number; height: number } | undefined;
      return settings?.width === e.source.width && settings?.height === e.source.height;
    })
  );
  // Only the sources that make a sound. Rerouting the silent ones would put permanently dead faders
  // in the mixer, which is clutter a streamer has to work out the meaning of.
  ok(
    "audio is rerouted to the OBS mixer for exactly the sources that make sound",
    entries.every((e) => {
      const found = browsers.find((b) => b.name === e.source.obsName);
      const settings = found?.settings as { reroute_audio: boolean } | undefined;
      return settings?.reroute_audio === Boolean(e.source.audio);
    })
  );

  console.log(`\n${kind} scene - the URLs`);
  ok("every URL carries the overlay token", entries.every((e) => e.url.includes(`token=${TOKEN}`)));
  ok(
    "every URL is a persistent /stream/ route, never a room-coded one",
    entries.every((e) => e.url.includes(`#/stream/${e.source.element}?`))
  );
  // The whole reason a third credential exists. `key=` is the rejoin code, which hands over the
  // seat; an ingest token would fire shots. Neither may ever appear in a file that gets exported,
  // traded between co-streamers and pasted into support threads.
  ok(
    "no rejoin code in any URL",
    entries.every((e) => !/[?&]key=/.test(e.url))
  );
  ok(
    "no room code baked into any URL",
    entries.every((e) => !/#\/overlay-/.test(e.url))
  );
  // The team is resolved live by the stream route, so a player who switches crews between matches
  // does not end up with a scene marking the wrong fleet as theirs.
  ok(
    "no team baked into any URL",
    entries.every((e) => !/[?&]team=/.test(e.url))
  );
  ok(
    "only the sources that asked to follow a fleet carry the marker",
    entries.every((e) => /[?&]me=1/.test(e.url) === Boolean(e.source.followsTeam))
  );

  console.log(`\n${kind} scene - the opening layout`);
  ok(
    "nothing starts outside the canvas",
    entries.every((e) => {
      const box = previewBox(kind, e.source);
      return box.left >= 0 && box.top >= 0 && box.left + box.width <= 1.001 && box.top + box.height <= 1.001;
    })
  );
  ok("the canvas is the one the layout was measured against", SCENE_CANVAS.w === 1920 && SCENE_CANVAS.h === 1080);
}

console.log("\nwhat each audience is offered");
const player = sourcesFor("player");
const caster = sourcesFor("caster");
// The odds are an evaluation bar. A player who can watch their own odds swing mid-match is being
// told something about the shape of the board that the match is supposed to make them work out - so
// it is a caster's instrument, and the persistent scene has to agree with the in-room box about that.
ok("the odds are not offered to a crew", player.every((s) => s.element !== "odds"));
ok("the odds are offered at the desk", caster.some((s) => s.element === "odds"));
// The fleet source draws where the streamer's hulls are. Ticked by default it would be a spoiler
// somebody shipped to their own viewers by accepting a default.
ok(
  "any source that draws your own ships is off by default",
  [...player, ...caster].every((s) => !s.spoiler || !s.on)
);
ok("the caster is not offered a source that needs a rejoin code", caster.every((s) => !s.spoiler));

console.log("\nwho may be handed a live ?team=");
// `team` is not a neutral parameter and this is the assertion that keeps saying so. On the board it
// is half of what PINS the source, so a caster's driven board that received one would import looking
// perfect and then refuse to follow the control page - with nothing on screen to explain it. On the
// caster's clock it would put a crew highlight inside an odds band that is deliberately a statement
// about the whole room.
const driven = caster.find((s) => s.id === "board")!;
ok("the caster's driven board never follows a fleet", !driven.followsTeam);
ok(
  "nothing in the caster's scene follows a fleet",
  caster.every((s) => !s.followsTeam)
);
// And the other half: the two sources whose entire job is marking the streamer's own crew have to
// actually ask for it, or a player's scene quietly stops highlighting them.
ok("the crew's own board follows their fleet", player.find((s) => s.id === "board")!.followsTeam === true);
ok("the crew's clock follows their fleet", player.find((s) => s.id === "timer")!.followsTeam === true);

console.log("\nscene settings are written only when they do something");
const quiet = scene("player").entries;
ok("a default scene writes no look settings at all", quiet.every((e) => !/[?&](opacity|text|empty|secs)=/.test(e.url)));

const tuned = scene("player", { opacity: 0.5, textSize: 1.25, emptyFade: 0.3, alertSecs: 9 }).entries;
const board = tuned.find((e) => e.source.id === "board")!;
ok("a faded scene writes opacity onto the board", /[?&]opacity=0\.50/.test(board.url));
ok("a resized scene writes text onto the board", /[?&]text=1\.25/.test(board.url));
ok("a thinned board writes empty onto the board", /[?&]empty=0\.30/.test(board.url));
// The audio source has no picture and draws no text, so both settings are meaningless to it and
// writing them would be a URL that lies about what it does.
const audio = tuned.find((e) => e.source.id === "audio")!;
ok("the audio source takes no look settings", !/[?&](opacity|text|empty|secs)=/.test(audio.url));
const finds = tuned.find((e) => e.source.id === "egg")!;
ok("the find alert takes its hold time", /[?&]secs=9/.test(finds.url));
ok("the find alert takes no text size", !/[?&]text=/.test(finds.url));

console.log("\npicking fewer elements");
const two = scene("player", DEFAULTS, new Set(["timer", "key"]));
ok("only the ticked elements become sources", two.file.sources.filter((s) => s.id === "browser_source").length === 2);
ok(
  "the scene still holds together",
  (two.file.sources.find((s) => s.id === "scene")!.settings as { items: unknown[] }).items.length === 2
);

console.log(fails === 0 ? "\nAll OBS scene checks passed." : `\n${fails} OBS scene check(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
