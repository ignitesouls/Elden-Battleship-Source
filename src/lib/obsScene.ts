// The pure half, deliberately - this module has to be runnable in Node so scripts/check-obs-scene.ts
// can build a collection and pull it apart. See the note at the top of streamSources.
import type { SceneKind, StreamSource } from "./streamSources";
// Explicit .ts, like roomCode.ts and careerStats.ts elsewhere: this module is run directly by
// scripts/check-obs-scene and scripts/check-cast-scene under Node, which does not resolve an
// extensionless relative import.
import {
  screenRects,
  boardRect,
  clockRect,
  CAST_CANVAS,
} from "./castSceneLayout.ts";

/**
 * An OBS Scene Collection, built in the browser and handed over as a download.
 *
 * -- Why a scene collection and not a list of URLs -----------------------------------------------
 *
 * The site already hands out URLs, and it will keep doing so - see the ADVANCED half of the setup
 * page. But "add seven Browser Sources, set the width and height of each, tick the same three boxes
 * on all of them, then arrange the lot" is a twenty-minute job done wrong at least once by almost
 * everybody, and it is done from scratch by every new streamer. A collection file is that job
 * already finished: one import, and the scene is standing.
 *
 * -- What the file is, and firmly is not ---------------------------------------------------------
 *
 * It is an INITIAL configuration. The moment it is imported it belongs to the streamer: they will
 * move things, resize them, hide half of them, mute one, reorder the rest and hang filters off
 * whatever is left. Nothing in this application ever reaches back into OBS to correct any of that,
 * and nothing here should ever be built to. Elden Battleship owns the data; OBS owns the layout.
 *
 * The corollary is the one thing the setup page has to say out loud: re-importing a regenerated
 * scene does NOT preserve the arrangement. It is a new collection, not a patch.
 *
 * -- Why every element is its own source ---------------------------------------------------------
 *
 * One page drawing all seven would be a single rectangle that the streamer cannot take apart - and
 * taking it apart is the entire thing they want to do with it. Separate sources are what make
 * "move the clock, hide the key, mute the audio, put the board behind my webcam" possible at all.
 */

/** Bumped only if the shape of the generated file has to change. See the note on the scene's private settings. */
export const SCENE_VERSION = 1;

/** The scene OBS makes for you, in the size nearly every stream is composed at. */
const CANVAS = { w: 1920, h: 1080 };

/**
 * OBS's `prev_ver`, which every source in a collection carries.
 *
 * It is a packed OBS version number (31.0.1), and it is what the importer reads to decide whether a
 * source's settings need migrating. Any recent version is fine and this one is deliberately not
 * bumped with each release - it says "these settings are in the modern format", not "this file came
 * from that build".
 */
const PREV_VER = 520093697;

/** Where a source starts life in the scene, and how much of its native size that is. */
export interface SourcePlacement {
  x: number;
  y: number;
  scale: number;
}

/**
 * The opening arrangement, per scene.
 *
 * These are the shares of a 1080p canvas that each source's recommended size actually occupies -
 * the same arithmetic the preview in the setup page draws with, so what a streamer sees before they
 * download is what they get after they import. The board is scaled down because 1000x1000 native is
 * most of the height of a 1080p scene and nobody wants it that big over gameplay.
 *
 * Tuned so that nothing overlaps anything it would obscure: the key runs along the very bottom and
 * everything else clears it, the clock owns the top strip, and the board and the find alert sit on
 * opposite sides of what is left. A streamer will move all of it anyway. The point is only that the
 * scene is USABLE the moment it is imported, rather than being seven sources stacked in one corner.
 */
function placements(kind: SceneKind): Record<string, SourcePlacement> {
  if (kind === "caster") {
    return {
      timer: { x: 360, y: 12, scale: 1 },
      // The two boards are alternatives, so they get the same slot - whichever one the caster
      // ticked is the one standing there.
      board: { x: 660, y: 330, scale: 0.6 },
      "all-fleets": { x: 660, y: 330, scale: 0.6 },
      odds: { x: 30, y: 748, scale: 0.68 },
      egg: { x: 1410, y: 330, scale: 0.8 },
      key: { x: 0, y: 990, scale: 1 },
      audio: { x: 10, y: 10, scale: 1 },
    };
  }
  return {
    timer: { x: 360, y: 16, scale: 1 },
    board: { x: 1160, y: 254, scale: 0.72 },
    // Not the big board's slot, even though the two are alternatives. The caster's pair share one
    // because they are the same board at the same size; these are the same board at a fifth of the
    // area, so a streamer ticking both to compare them wants to see both - and the small one's
    // whole point is that it sits out of the way, above the fleet panel in the left-hand column.
    "fire-mini": { x: 40, y: 230, scale: 0.8 },
    fleet: { x: 40, y: 566, scale: 1 },
    egg: { x: 460, y: 280, scale: 1 },
    key: { x: 0, y: 990, scale: 1 },
    audio: { x: 10, y: 10, scale: 1 },
  };
}

/** One chosen source, with the URL already built for it. */
export interface SceneEntry {
  source: StreamSource;
  url: string;
}

/**
 * The Browser Source settings OBS will import.
 *
 * `shutdown` is the one worth explaining. It stops the page when the source is hidden and restarts
 * it when it is shown, which is what the in-room box has always told people to tick by hand: an
 * overlay left running invisibly is a websocket and a render loop the streamer is paying for, and
 * restarting on show is also the cheapest possible "fix it" gesture. It is safe here precisely
 * because the URL is persistent - a restart re-resolves the token and lands on whatever match its
 * owner is in now, which is exactly what you want from hiding and re-showing a source.
 *
 * `reroute_audio` only on the sources that make a sound. It hands the page's audio to the OBS mixer
 * as its own channel with its own fader and mute button, which is the thing the audio source exists
 * for. Setting it on the silent five would put five permanently dead faders in the mixer.
 *
 * No `css` override is written. OBS's own default already zeroes the margin and makes the body
 * transparent, and every overlay page paints its own background anyway - a custom stylesheet here
 * would be a second place for the scene's appearance to be decided from.
 */
function browserSource(entry: SceneEntry, uuid: string) {
  return {
    prev_ver: PREV_VER,
    name: entry.source.obsName,
    uuid,
    id: "browser_source",
    versioned_id: "browser_source",
    settings: {
      url: entry.url,
      width: entry.source.width,
      height: entry.source.height,
      fps_custom: false,
      // OBS's own default. The overlays are event-driven rather than animated, so nothing here
      // wants a higher rate and a browser source pinned to 60 is a browser source burning a core.
      fps: 30,
      reroute_audio: Boolean(entry.source.audio),
      restart_when_active: false,
      shutdown: true,
      // Full control is OBS's default for a source the user added themselves. Lowering it would
      // silently break nothing today and be a puzzle later.
      webpage_control_level: 1,
      css: "",
    },
    mixers: 255,
    sync: 0,
    flags: 0,
    volume: 1.0,
    balance: 0.5,
    enabled: true,
    muted: false,
    "push-to-mute": false,
    "push-to-mute-delay": 0,
    "push-to-talk": false,
    "push-to-talk-delay": 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {},
  };
}

/**
 * One source's place in the scene.
 *
 * `align: 5` is OBS's top-left, which is what makes `pos` the corner rather than the centre - so the
 * numbers in placements() are read the way anybody looking at them would expect.
 *
 * Both `name` and `source_uuid` are written. Older OBS matches scene items to sources by name and
 * newer ones by uuid, and carrying both is what lets one file import cleanly across the versions
 * people actually have installed.
 */
function sceneItem(entry: SceneEntry, uuid: string, at: SourcePlacement, id: number) {
  return {
    name: entry.source.obsName,
    source_uuid: uuid,
    visible: true,
    locked: false,
    rot: 0.0,
    pos: { x: at.x, y: at.y },
    scale: { x: at.scale, y: at.scale },
    align: 5,
    bounds_type: 0,
    bounds_align: 0,
    bounds: { x: 0.0, y: 0.0 },
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id,
    group_item_backup: false,
    scale_filter: "disable",
    blend_method: "default",
    blend_type: "normal",
    show_transition: { duration: 0 },
    hide_transition: { duration: 0 },
    private_settings: {},
  };
}

export interface BuildSceneOptions {
  kind: SceneKind;
  entries: SceneEntry[];
  /** What the scene and the collection are called in OBS. */
  sceneName: string;
  /** Injectable so a check script can build the same file twice and diff it. */
  newId?: () => string;
}

/**
 * The whole collection, ready to be stringified and downloaded.
 *
 * The scene itself is a source too, which is the one genuinely surprising thing about this format:
 * OBS keeps scenes and inputs in the same `sources` array and tells them apart by `id`. The scene's
 * settings carry the items, and `id_counter` has to be past the highest item id or the next source
 * the streamer adds by hand collides with one of ours.
 *
 * Item order is bottom-of-the-stack first in OBS's own file, which is the reverse of how the source
 * list reads on screen. The entries arrive in reading order - board, fleet, clock, key, finds, audio
 * - so they are reversed here, and the effect is that the small always-on-top things (the find
 * alert, the key) end up above the board rather than behind it.
 */
export function buildObsScene({ kind, entries, sceneName, newId }: BuildSceneOptions) {
  const uuid = newId ?? (() => crypto.randomUUID());
  const where = placements(kind);

  const withIds = entries.map((entry) => ({ entry, uuid: uuid() }));

  const items = [...withIds]
    .reverse()
    .map(({ entry, uuid: id }, i) =>
      sceneItem(entry, id, where[entry.source.id] ?? { x: 0, y: 0, scale: 1 }, i + 1)
    );

  const sceneUuid = uuid();

  const scene = {
    prev_ver: PREV_VER,
    name: sceneName,
    uuid: sceneUuid,
    id: "scene",
    versioned_id: "scene",
    settings: {
      id_counter: items.length + 1,
      custom_size: false,
      items,
    },
    mixers: 0,
    sync: 0,
    flags: 0,
    volume: 1.0,
    balance: 0.5,
    enabled: true,
    muted: false,
    "push-to-mute": false,
    "push-to-mute-delay": 0,
    "push-to-talk": false,
    "push-to-talk-delay": 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    /**
     * Where the version stamp lives.
     *
     * OBS carries `private_settings` through an import and an export untouched and shows it to
     * nobody, so it is the one place a marker can sit without becoming something a streamer has to
     * look at. If the format ever has to change, this is what a future importer reads to know what
     * it is looking at. Deliberately not the start of an automatic scene-update mechanism - see the
     * note at the top of this file about who owns the layout.
     */
    private_settings: { eb_scene_version: SCENE_VERSION, eb_scene_kind: kind },
  };

  return {
    name: sceneName,
    // Only one scene, so it is trivially the current one on both program and preview.
    current_scene: sceneName,
    current_program_scene: sceneName,
    scene_order: [{ name: sceneName }],
    sources: [...withIds.map(({ entry, uuid: id }) => browserSource(entry, id)), scene],
    groups: [],
    // OBS fills in its own defaults for anything omitted here, but a collection with no transition
    // at all imports with an empty transition list and a warning, so the standard pair is written.
    transitions: [],
    current_transition: "Fade",
    transition_duration: 300,
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 0,
    scaling_off_x: 0.0,
    scaling_off_y: 0.0,
    virtual_camera: { type2: 3 },
    modules: {},
    // The scene-collection format version, not ours. 2 is what every OBS since 28 writes.
    version: 2,
  };
}

/** The canvas the placements above were laid out against, for the preview to scale from. */
export const SCENE_CANVAS = CANVAS;

/** Where a source sits in the scene, as fractions of the canvas - what the preview draws with. */
export function previewBox(kind: SceneKind, source: StreamSource) {
  const at = placements(kind)[source.id] ?? { x: 0, y: 0, scale: 1 };
  return {
    left: at.x / CANVAS.w,
    top: at.y / CANVAS.h,
    width: (source.width * at.scale) / CANVAS.w,
    height: (source.height * at.scale) / CANVAS.h,
  };
}

/**
 * A filename OBS will not fight over.
 *
 * Scene collections are matched by their internal `name` on import, so two people importing
 * "Elden Battleship" both get a collection with that name and OBS quietly appends a number to the
 * second. The filename only has to be recognisable in a downloads folder.
 */
export function sceneFilename(kind: SceneKind): string {
  return `elden-battleship-${kind}-overlay.json`;
}

/* ======================================================================================
 *  The casting set scene - a whole broadcast layout, not an element menu.
 *
 *  Everything above builds a scene the streamer arranges: a handful of sources dropped in a
 *  corner, deliberately un-composed, because the caster owns the layout. This is the opposite by
 *  request - a caster who wants THE shot: their players' streams boxed around the board, the clock
 *  on top, and a second scene for the camera break. It is still an initial arrangement they can
 *  move, but it arrives composed rather than stacked.
 *
 *  Two scenes in one collection so a caster hotkeys between "the match" and "the desk on camera"
 *  rather than swapping collections. They share no sources.
 * ==================================================================================== */

export const CAST_SCENE_MAIN = "EB Cast";
export const CAST_SCENE_BREAK = "EB Casters";

/** A minimal StreamSource for a box the source catalogue does not describe - screens, the frame. */
function castSource(id: string, element: StreamSource["element"], obsName: string, w: number, h: number): StreamSource {
  return {
    id,
    element,
    obsName,
    label: obsName,
    note: "",
    width: w,
    height: h,
    query: {},
    honours: {},
    on: true,
  };
}

/** The find alert's hold when nothing else is asked for, in seconds - OverlayEgg's own default. */
const CAST_DEFAULT_ALERT_SECS = 6;

export interface CastSceneOptions {
  /** Origin + path the URLs are built against - `window.location` in the page, a constant in a test. */
  base: string;
  /** The caster's overlay token. Every source in both scenes carries it and nothing else. */
  token: string;
  /**
   * The overlay hold, in milliseconds, written onto the clock's URL as `?delay=` so it sits back
   * where the players' streams are. The driven board reads its hold live from the control page, so
   * it takes nothing here. 0 writes nothing.
   */
  delayMs?: number;
  /** The clock's transparency, 0..1. 1 writes nothing. */
  clockOpacity?: number;
  /** The clock's text size multiplier. 1 writes nothing. */
  clockText?: number;
  /** Add the find alert, over the board. On unless turned off. */
  finds?: boolean;
  /** How long a find holds the screen, in seconds. */
  alertSecs?: number;
  /** Add the board's sound as its own source, for the OBS mixer. On unless turned off. */
  sound?: boolean;
}

export interface CastCollectionOptions extends CastSceneOptions {
  /** Injectable ids, so a check can build the same collection twice and diff it. */
  newId?: () => string;
}

/** One source in the casting collection: which scene it is in, what it is, and where it goes. */
export interface CastPart {
  scene: "main" | "break";
  entry: SceneEntry;
  at: SourcePlacement;
  /** What the setup page says it is, for a caster building the scene by hand. */
  what: string;
}

/**
 * Every source in the casting collection, in stacking order (bottom of each scene first).
 *
 * The one list both halves of the setup page read: the download builds its file from it, and the
 * build-it-yourself list prints it row by row. So a caster wiring the scene up by hand gets exactly
 * the sources, sizes and positions the file would have given them.
 *
 * The screen boxes are one Browser Source each - `EB Screen 1..6`, pinned by `?slot=` - because a
 * caster wants to refresh a hitched stream on its own (see lib/castAux). Native size is the box's
 * own pixels, so the Twitch embed inside renders at the size it is shown rather than being scaled.
 */
export function castSceneParts({
  base,
  token,
  delayMs = 0,
  clockOpacity = 1,
  clockText = 1,
  finds = true,
  alertSecs = CAST_DEFAULT_ALERT_SECS,
  sound = true,
}: CastSceneOptions): CastPart[] {
  const url = (path: string) => `${base}#/stream/${path}`;

  const boxes = screenRects();
  const board = boardRect();
  const clock = clockRect();
  // The clock scales itself to fit its source, so the source is given the banner's own shape at a
  // 1200-wide native size and scaled down onto it.
  const clockNativeH = Math.round((1200 * clock.h) / clock.w);

  // Only settings that are doing something are written - same rule as streamSourceUrl.
  const clockQuery = new URLSearchParams({ token, odds: "1" });
  if (delayMs > 0) clockQuery.set("delay", String(Math.round(delayMs)));
  if (clockOpacity !== 1) clockQuery.set("opacity", clockOpacity.toFixed(2));
  if (clockText !== 1) clockQuery.set("text", String(clockText));
  const eggQuery = new URLSearchParams({ token });
  if (alertSecs !== CAST_DEFAULT_ALERT_SECS) eggQuery.set("secs", String(alertSecs));

  // The find alert, centred over the board so it lands on the thing everyone is watching.
  const EGG = 600;

  const parts: CastPart[] = [];
  const add = (scene: CastPart["scene"], source: StreamSource, path: string, at: SourcePlacement, what: string) =>
    parts.push({ scene, entry: { source, url: url(path) }, at, what });

  // -- EB Cast, bottom up: what shows through the holes, the frame art over it, then the two things
  // that sit on top of the art - the find alert and the clock on the banner. The clock is last on
  // purpose: the banner is opaque, so anything above it in the stack would be hidden.
  if (sound) {
    add(
      "main",
      { ...castSource("audio", "audio", "EB Audio", 100, 100), audio: true },
      `audio?token=${token}`,
      { x: 0, y: 0, scale: 1 },
      "the board's sound, no picture - its own fader in the OBS mixer"
    );
  }
  boxes.forEach((box, i) =>
    add(
      "main",
      castSource(`screen-${i}`, "screen", `EB Screen ${i + 1}`, Math.round(box.w), Math.round(box.h)),
      `screen?token=${token}&slot=${i}`,
      { x: Math.round(box.x), y: Math.round(box.y), scale: 1 },
      `player ${i + 1}'s Twitch stream and live hit / miss / accuracy (${i < 3 ? "left" : "right"} column)`
    )
  );
  add(
    "main",
    castSource("board", "board", "EB Board", 1000, 1000),
    `board?token=${token}`,
    { x: Math.round(board.x), y: Math.round(board.y), scale: board.w / 1000 },
    "the board, driven from your caster desk"
  );
  add(
    "main",
    castSource("cast-cams", "frame", "EB Frame", CAST_CANVAS.w, CAST_CANVAS.h),
    `frame?token=${token}&layout=cast`,
    { x: 0, y: 0, scale: 1 },
    "the match frame art - everything else shows through its holes"
  );
  if (finds) {
    add(
      "main",
      castSource("egg", "egg", "EB Finds", EGG, EGG),
      `egg?${eggQuery.toString()}`,
      { x: Math.round(board.x + (board.w - EGG) / 2), y: Math.round(board.y + (board.h - EGG) / 2), scale: 1 },
      "empty until someone finds something, then the find card over the board"
    );
  }
  add(
    "main",
    castSource("clock", "timer", "EB Caster Clock", 1200, clockNativeH),
    `timer?${clockQuery.toString()}`,
    { x: Math.round(clock.x), y: Math.round(clock.y), scale: clock.w / 1200 },
    "the match clock, fleet hulls and odds, on the banner above the board"
  );

  // -- EB Casters: the break frame, over the webcams the caster adds behind it.
  add(
    "break",
    castSource("frame", "frame", "EB Caster Cams", CAST_CANVAS.w, CAST_CANVAS.h),
    `frame?token=${token}&layout=casters`,
    { x: 0, y: 0, scale: 1 },
    "the break frame art - your webcams go behind its two boxes"
  );

  return parts;
}

/** The two-scene casting collection, built from castSceneParts. */
export function buildCastCollection({ newId, ...options }: CastCollectionOptions) {
  const uuid = newId ?? (() => crypto.randomUUID());
  const parts = castSceneParts(options);
  const mainParts = parts.filter((p) => p.scene === "main");
  const breakParts = parts.filter((p) => p.scene === "break");

  /**
   * Builds one scene object and its browser sources from a list of parts.
   *
   * Not reversed, unlike buildObsScene: OBS's file is bottom-of-the-stack first and the parts are
   * already listed bottom-up, and here the order is load-bearing - the clock sits on the frame art's
   * opaque banner, so it has to be the last item or the art hides it.
   */
  function scene(name: string, parts: Array<{ entry: SceneEntry; at: SourcePlacement }>) {
    const withIds = parts.map((p) => ({ ...p, uuid: uuid() }));
    const items = withIds.map((p, i) => sceneItem(p.entry, p.uuid, p.at, i + 1));
    const sceneObj = {
      prev_ver: PREV_VER,
      name,
      uuid: uuid(),
      id: "scene",
      versioned_id: "scene",
      settings: { id_counter: items.length + 1, custom_size: false, items },
      mixers: 0,
      sync: 0,
      flags: 0,
      volume: 1.0,
      balance: 0.5,
      enabled: true,
      muted: false,
      "push-to-mute": false,
      "push-to-mute-delay": 0,
      "push-to-talk": false,
      "push-to-talk-delay": 0,
      hotkeys: {},
      deinterlace_mode: 0,
      deinterlace_field_order: 0,
      monitoring_type: 0,
      private_settings: { eb_scene_version: SCENE_VERSION, eb_scene_kind: "cast" },
    };
    return { browsers: withIds.map((p) => browserSource(p.entry, p.uuid)), sceneObj };
  }

  const main = scene(CAST_SCENE_MAIN, mainParts);
  const brk = scene(CAST_SCENE_BREAK, breakParts);

  return {
    name: CAST_SCENE_MAIN,
    current_scene: CAST_SCENE_MAIN,
    current_program_scene: CAST_SCENE_MAIN,
    scene_order: [{ name: CAST_SCENE_MAIN }, { name: CAST_SCENE_BREAK }],
    sources: [...main.browsers, ...brk.browsers, main.sceneObj, brk.sceneObj],
    groups: [],
    transitions: [],
    current_transition: "Fade",
    transition_duration: 300,
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 0,
    scaling_off_x: 0.0,
    scaling_off_y: 0.0,
    virtual_camera: { type2: 3 },
    modules: {},
    version: 2,
  };
}

/** Filenames for the casting downloads, recognisable in a downloads folder. */
export function castSceneFilename(): string {
  return "elden-battleship-casting-scene.json";
}
