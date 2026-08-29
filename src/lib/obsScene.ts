// The pure half, deliberately - this module has to be runnable in Node so scripts/check-obs-scene.ts
// can build a collection and pull it apart. See the note at the top of streamSources.
import type { SceneKind, StreamSource } from "./streamSources";

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
