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
 * Colorblind-safe alternates. The default palette opens on red vs blue, which is exactly the
 * pair deuteranopia and protanopia collapse; this swaps in a blue/orange-anchored ramp that
 * stays separable, and keeps the *names* unchanged so players can still call out "Red Fleet"
 * and mean the same team as everyone else.
 */
export const TEAM_COLORS_ACCESSIBLE: string[] = [
  "#e66100", // orange   (was red)
  "#1a85ff", // blue
  "#117733", // green
  "#d4a441", // brass
  "#785ef0", // violet
  "#40c8c8", // cyan
  "#ee6fd0", // pink
  "#8a6a3a", // brown
  "#e8d54a", // yellow
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
