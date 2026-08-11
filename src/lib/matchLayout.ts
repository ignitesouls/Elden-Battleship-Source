import type { PanelLayout } from "./panelLayout";

/**
 * The match screen's five panels. The box maths they share with the spectator canvas lives in
 * ./panelLayout; this file is only what is specific to a player's own match view.
 */
export type PanelId = "board" | "fleet" | "roster" | "log" | "clock";

export type MatchLayout = PanelLayout<PanelId>;

export const PANEL_TITLES: Record<PanelId, string> = {
  board: "Fire board",
  fleet: "Your fleet",
  roster: "Fleets",
  log: "Battle log",
  clock: "Clock",
};

/** Every panel, in the order they're listed anywhere they need listing. */
export const PANEL_IDS: PanelId[] = ["board", "clock", "fleet", "log", "roster"];

/**
 * The starting arrangement.
 *
 * Five panels, and only five: the regions key, the room codes, the overlay link and the host's
 * buttons all live in the bar below the canvas (see MatchDock), because a column of cards you look
 * at twice a match was spending roughly a fleet roster's worth of width on nothing.
 *
 * That width goes to the board. It's 62% here against the 52% it had when it shared the screen with
 * a controls column - the fire board is what everyone is actually reading, and the boss names in
 * its squares are the thing that most wants the pixels. The middle column and the roster are sized
 * to their contents rather than to a tidy third each: the clock is one number, and a roster is a
 * couple of fleet cards, so neither has ever needed the width it used to get.
 */
export const DEFAULT_LAYOUT: MatchLayout = {
  board: { x: 0.0, y: 0.0, w: 0.62, h: 1.0, z: 1 },
  clock: { x: 0.63, y: 0.0, w: 0.2, h: 0.13, z: 2 },
  fleet: { x: 0.63, y: 0.14, w: 0.2, h: 0.47, z: 3 },
  log: { x: 0.63, y: 0.62, w: 0.2, h: 0.38, z: 4 },
  roster: { x: 0.84, y: 0.0, w: 0.16, h: 1.0, z: 5 },
};

export type { PanelBox } from "./panelLayout";
