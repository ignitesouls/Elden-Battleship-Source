// Ported from EldenBingoCommon/BingoConstants.cs TeamColors, so the web version
// matches the desktop app's team identity at a glance.
export interface TeamColor {
  name: string;
  hex: string;
}

export const TEAM_COLORS: TeamColor[] = [
  { name: "Red", hex: "#be1210" },
  { name: "Blue", hex: "#095ca8" },
  { name: "Green", hex: "#05950f" },
  { name: "Orange", hex: "#cd8004" },
  { name: "Purple", hex: "#8723d0" },
  { name: "Cyan", hex: "#4ecccc" },
  { name: "Pink", hex: "#ed73d8" },
  { name: "Brown", hex: "#835016" },
  { name: "Yellow", hex: "#d7c300" },
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
