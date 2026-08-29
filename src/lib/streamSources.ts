/**
 * The persistent overlay's SOURCES: what an OBS scene is made of, and the URL of each.
 *
 * -- Why this is its own module ------------------------------------------------------------------
 *
 * ./streamOverlay owns the token, so it imports the supabase client, and nothing that imports it can
 * be run outside a browser. That is fine for the four functions that talk to the database and
 * useless for the part of this feature that genuinely needs asserting: which credential ends up in a
 * URL, which audience is offered which element, and whether a setting is written at all.
 *
 * Getting any of those wrong fails silently. A scene that carries a rejoin code imports perfectly,
 * looks right, and hands the seat to anybody the streamer sends the file to. Same reason
 * lib/castFrame sits apart from lib/overlayCast - see scripts/check-obs-scene.ts, which is only able
 * to exist because of this split.
 */

/** The `/stream/:element` routes. One per existing overlay page - nothing new renders. */
export type StreamElement = "board" | "fleet" | "timer" | "key" | "odds" | "audio" | "egg";

/** Who a scene is for. The same one question OverlayLinkBox asks, asked once here too. */
export type SceneKind = "player" | "caster";

/** Which of the scene-wide settings a given source actually honours. */
interface Honours {
  opacity?: boolean;
  text?: boolean;
  /** How solid an unfired square is. Only ever means anything on a crew's own board. */
  empty?: boolean;
  /** How long the find alert holds. */
  secs?: boolean;
}

export interface StreamSource {
  /** Stable id. The checkbox key, and what a saved selection stores. */
  id: string;
  element: StreamElement;
  /** The source's name inside OBS. Prefixed so it sorts together in a scene full of other things. */
  obsName: string;
  /** What the setup page calls it, matching the wording in the in-room box. */
  label: string;
  note: string;
  width: number;
  height: number;
  /** Query beyond the token and the scene settings. */
  query: Record<string, string>;
  honours: Honours;
  /**
   * Asks the stream route to fill in `?team=` from whichever fleet its owner is on right now.
   *
   * Opt-in, and it has to be, because `team` is not a neutral parameter. On the board it is half of
   * what PINS the source (see pinnedView in pages/OverlayBoard) - written onto a caster's driven
   * board it would silently disconnect it from the control page the caster is about to drive it
   * from. And on the caster's clock it would put a crew highlight inside an odds band that is
   * deliberately a statement about the whole room.
   *
   * So the sources that want it say so, and the route writes it nowhere else. Live rather than baked
   * into the URL at download time, because switching crews between matches must not cost a
   * re-import - see the note in pages/StreamSource.
   */
  followsTeam?: boolean;
  /** Produces sound, so OBS should give it its own fader rather than mixing it blind. */
  audio?: boolean;
  /** Draws the owner's own ships. Never ticked by default - see the warning on the setup page. */
  spoiler?: boolean;
  /** Ticked when the page first loads. */
  on: boolean;
}

/**
 * The player's scene: the two boards they are already playing off, and nothing they would have to
 * think about.
 *
 * This is the same list the in-room box offers a crew, for the same reasons - see the role-picker
 * note at the top of components/OverlayLinkBox. The odds are absent on purpose and it is not an
 * oversight: the win-probability bar is an evaluation bar, and a player who can watch their own odds
 * swing mid-match is being told something about the shape of the board that the match is supposed to
 * make them work out. It is on the caster's scene instead.
 */
const PLAYER_SOURCES: StreamSource[] = [
  {
    id: "board",
    element: "board",
    obsName: "EB Fire Board",
    label: "Fire board",
    note: "your own shots - the board you're playing off",
    width: 1000,
    height: 1000,
    // `fire=1` is the hunting board. The team is filled in live by the stream route, because it is
    // the one value that can change between matches and must never be baked into a URL.
    query: { fire: "1" },
    honours: { opacity: true, text: true, empty: true },
    followsTeam: true,
    on: true,
  },
  {
    id: "fleet",
    element: "fleet",
    obsName: "EB Your Fleet",
    label: "Your fleet",
    note: "your ships and the damage they've taken - the small board from your screen",
    width: 400,
    height: 400,
    query: {},
    // No text size: this source trades square names for square colours, which is the whole reason it
    // exists rather than being the fire board at 400px.
    honours: { opacity: true, empty: true },
    spoiler: true,
    on: false,
  },
  {
    id: "timer",
    element: "timer",
    obsName: "EB Clock",
    label: "Clock",
    note: "the match clock and every fleet's hulls, with yours marked",
    width: 1200,
    height: 200,
    query: {},
    honours: { opacity: true, text: true },
    // "with yours marked" is the whole difference between this and the caster's clock.
    followsTeam: true,
    on: true,
  },
  {
    id: "key",
    element: "key",
    obsName: "EB Key",
    label: "Key",
    note: "a thin strip for the bottom edge - the colours and what they mean",
    width: 1920,
    height: 90,
    query: {},
    honours: { opacity: true, text: true },
    on: true,
  },
  {
    id: "egg",
    element: "egg",
    obsName: "EB Finds",
    label: "Finds",
    note: "empty until the water gives something up, then the find for a few seconds",
    width: 600,
    height: 600,
    query: {},
    honours: { opacity: true, secs: true },
    on: true,
  },
  {
    id: "audio",
    element: "audio",
    obsName: "EB Audio",
    label: "Audio",
    note: "the board's sound - no picture. Gets its own fader in the OBS mixer",
    width: 100,
    height: 100,
    query: {},
    // Neither setting applies: opacity is about a picture this has not got, and text is about names
    // it never draws. No volume either - the OBS fader is the only volume control worth having, and
    // a number baked into the URL would be a second one that the fader silently overrules.
    honours: {},
    // Only to decide which sting plays at the end - a crew has a side to be cheered for.
    followsTeam: true,
    audio: true,
    on: true,
  },
];

/**
 * The desk's scene: the boards a caster drives and the numbers they read.
 *
 * The board here is the DRIVEN one - no parameters, so it takes its zoom, pan, spotlight,
 * transparency and text size live from the control page. That page is at /stream/cast?token=, which
 * resolves the same room the sources do, so the desk follows the caster between matches exactly as
 * the sources follow the crew. The cast channel is keyed on the room code (see lib/overlayCast), so
 * a token-resolved board and a token-resolved desk meet on it without either knowing the other
 * exists.
 *
 * "All fleets" is the unattended alternative, offered second and unticked: every crew's shots on one
 * board with nobody driving it, for a co-stream or a screen left running at an event.
 */
const CASTER_SOURCES: StreamSource[] = [
  {
    id: "board",
    element: "board",
    obsName: "EB Board",
    label: "Board",
    note: "the board you aim from the control page - zoom, pan and spotlight",
    width: 1000,
    height: 1000,
    query: {},
    // Deliberately none. Writing a transparency or a text size into this URL PINS the board and
    // disconnects the very desk the caster is about to drive it from - see the casterBoardUrl note
    // in components/OverlayLinkBox.
    honours: {},
    on: true,
  },
  {
    id: "all-fleets",
    element: "board",
    obsName: "EB All Fleets",
    label: "All fleets",
    note: "every fleet's shots on one board, with nobody driving it - no control page needed",
    width: 1000,
    height: 1000,
    query: { pin: "1" },
    honours: { opacity: true, text: true },
    on: false,
  },
  {
    id: "timer",
    element: "timer",
    obsName: "EB Caster Clock",
    label: "Caster clock",
    note: "the match clock, every fleet's hulls, and the odds bar under it",
    width: 1200,
    // Taller than the player's 200 because the odds band sits under the clock.
    height: 300,
    query: { odds: "1" },
    honours: { opacity: true, text: true },
    on: true,
  },
  {
    id: "odds",
    element: "odds",
    obsName: "EB Odds",
    label: "Odds",
    note: "each fleet's chance of winning and the line that got them there - bring it up on a swing",
    width: 960,
    height: 320,
    query: {},
    honours: { opacity: true, text: true },
    on: false,
  },
  {
    id: "key",
    element: "key",
    obsName: "EB Key",
    label: "Key",
    note: "a thin strip for the bottom edge - the colours and what they mean",
    width: 1920,
    height: 90,
    query: {},
    honours: { opacity: true, text: true },
    on: true,
  },
  {
    id: "egg",
    element: "egg",
    obsName: "EB Finds",
    label: "Finds",
    note: "empty until the water gives something up, then the find for a few seconds",
    width: 600,
    height: 600,
    query: {},
    honours: { opacity: true, secs: true },
    on: true,
  },
  {
    id: "audio",
    element: "audio",
    obsName: "EB Audio",
    label: "Audio",
    note: "the board's sound - no picture. Gets its own fader in the OBS mixer",
    width: 100,
    height: 100,
    query: {},
    honours: {},
    audio: true,
    on: true,
  },
];

export function sourcesFor(kind: SceneKind): StreamSource[] {
  return kind === "caster" ? CASTER_SOURCES : PLAYER_SOURCES;
}

/** The scene-wide look, written into every source that honours each part of it. */
export interface SceneSettings {
  opacity: number;
  textSize: number;
  emptyFade: number;
  alertSecs: number;
}

/**
 * One source's full URL.
 *
 * Only settings that are actually doing something are written. A URL full of defaults is harder to
 * read and harder to hand-edit afterwards, and hand-editing one source to differ from the rest is
 * the escape hatch this whole feature has to leave open.
 *
 * Built from a caller-supplied origin and path rather than a constant, so the links stay correct on
 * localhost, on GitHub Pages under its /Elden-Battleship/ base, and anywhere else this is hosted.
 * Hardcoding the deployed origin would hand every local tester a scene pointing at production.
 */
export function streamSourceUrl(
  base: string,
  source: StreamSource,
  token: string,
  scene: SceneSettings,
  defaults: SceneSettings
): string {
  const q = new URLSearchParams();
  q.set("token", token);
  // The marker, not the value. The route swaps it for whichever fleet its owner is on when the source
  // actually renders - see followsTeam for why every other source must not be given one.
  if (source.followsTeam) q.set("me", "1");
  for (const [k, v] of Object.entries(source.query)) q.set(k, v);

  if (source.honours.opacity && scene.opacity !== defaults.opacity) q.set("opacity", scene.opacity.toFixed(2));
  if (source.honours.text && scene.textSize !== defaults.textSize) q.set("text", String(scene.textSize));
  if (source.honours.empty && scene.emptyFade !== defaults.emptyFade) q.set("empty", scene.emptyFade.toFixed(2));
  if (source.honours.secs && scene.alertSecs !== defaults.alertSecs) q.set("secs", String(scene.alertSecs));

  return `${base}#/stream/${source.element}?${q.toString()}`;
}

/** The caster's control page, following them by token the same way their sources do. */
export function streamCastUrl(base: string, token: string): string {
  return `${base}#/stream/cast?token=${encodeURIComponent(token)}`;
}
