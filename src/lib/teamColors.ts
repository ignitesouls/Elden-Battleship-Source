export interface TeamColor {
  name: string;
  hex: string;
}

/**
 * The fleet palette, picked for this board: every colour has to hold its own against the navy
 * water (--bg, --cell) and stay clear of the other colours the board already uses for something
 * else - brass for the accent, orange for a hit, deep blue for a miss. That last one is why Blue is
 * brighter than a plain navy would be; a blue fleet's sail should never read as open water.
 *
 * The order is load-bearing. Teams are stored as indices into this list, so moving an entry
 * repaints every archived match and every custom team name, and fleetDraw's DRAW_TEAM_COLORS
 * points into it by position. Change a hex freely; never reorder.
 */
export const TEAM_COLORS: TeamColor[] = [
  { name: "Red", hex: "#c62b22" },
  { name: "Blue", hex: "#2f6fd8" },
  { name: "Green", hex: "#2f9a3f" },
  { name: "Orange", hex: "#dc6b1d" },
  { name: "Purple", hex: "#8b41d2" },
  { name: "Cyan", hex: "#2cbcc2" },
  { name: "Pink", hex: "#df5aa9" },
  { name: "Brown", hex: "#8d5b2c" },
  { name: "Yellow", hex: "#e2ce2b" },
];

/**
 * The fleet palette for colourblind mode.
 *
 * Red against Blue was never the problem - a deutan or protan eye still tells those two apart, and
 * the first version of this list "fixed" that pair by turning Red orange, which only put it next to
 * the hit fill and the brass accent while still calling it "Red Fleet". What colour vision
 * deficiency actually collapses is everything past the first two: Blue/Purple, Green/Brown,
 * Cyan/Pink, Red/Brown all land within a few CIEDE2000 units of each other under simulation.
 *
 * So each colour stays near its own hue (Red is still a red, so the name still fits) and moves in
 * lightness and chroma instead, which is the axis those eyes keep. The first four - the fleets real
 * matches use - were searched on their own first, and hold at least 23 dE2000 apart under simulated
 * deutan and protan vision (the list this replaced managed 8). The other five were then fitted
 * around them, and all nine stay 13 or more apart for deutan and protan, against 2 before. Tritan
 * (blue-yellow, about 1 in 10,000) was weighted lower and sits at 8 for the full nine. Nine colours
 * can't all be far apart for every eye; on the boards where fleets share a square, the shot rings
 * carry a shape per fleet as well (see TeamGlyph).
 */
export const TEAM_COLORS_ACCESSIBLE: string[] = [
  "#bb4444", // red
  "#2277ee", // blue
  "#77eebb", // green (a light mint, so it leaves the dark end to brown)
  "#ff8800", // orange
  "#aa99dd", // purple
  "#008877", // cyan  (a deep teal, so it parts from the light green)
  "#ee4488", // pink
  "#dd9977", // brown (a tan, lighter than the red it used to sit on)
  "#eeee11", // yellow
];

export const MAX_TEAMS = TEAM_COLORS.length;

const CB_KEY = "eb_colorblind";

export function isColorblindMode(): boolean {
  try {
    return localStorage.getItem(CB_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Publishes the active palette as --team0..--teamN on :root. teamHex() returns `var(--teamN)`
 * rather than a literal, so flipping the mode restyles every board, roster and overlay live -
 * no reload, and no call site has to know the preference exists.
 */
export function applyTeamPalette(colorblind = isColorblindMode()): void {
  const root = document.documentElement;
  TEAM_COLORS.forEach((c, i) => {
    root.style.setProperty(`--team${i}`, colorblind ? TEAM_COLORS_ACCESSIBLE[i] ?? c.hex : c.hex);
  });
  root.dataset.colorblind = colorblind ? "1" : "0";
}

export function setColorblindMode(on: boolean): void {
  try {
    localStorage.setItem(CB_KEY, on ? "1" : "0");
  } catch {
    // Preference just won't persist; the live palette still switches.
  }
  applyTeamPalette(on);
}

/**
 * Per-room name overrides, indexed by team number. Module-level for the same reason the palette
 * is: teamName() is called from 30-odd places across boards, rosters, the log, the overlay and the
 * match report, and threading a room object through every one of them to reach a display string
 * would be far more disruptive than one registry that's only ever written when a room loads.
 *
 * Safe against staleness because it's written from useRoom's own update path - outside render, and
 * before React re-renders with the new room - and cleared when a room unmounts, so historical
 * reports on the home page can't inherit the last room's names.
 */
let nameOverrides: (string | null)[] = [];

export function setTeamNameOverrides(names: unknown): void {
  nameOverrides = Array.isArray(names) ? (names as (string | null)[]) : [];
}

/** The stored override for a team, or null when it's on the default color name. */
export function customTeamName(team: number): string | null {
  const raw = nameOverrides[team];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function defaultTeamName(team: number): string {
  return TEAM_COLORS[team] ? `${TEAM_COLORS[team].name} Fleet` : `Team ${team + 1}`;
}

export function teamName(team: number): string {
  return customTeamName(team) ?? defaultTeamName(team);
}

export function teamHex(team: number): string {
  return TEAM_COLORS[team] ? `var(--team${team})` : "#888888";
}
