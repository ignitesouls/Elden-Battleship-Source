import type { PanelLayout } from "./panelLayout";

/**
 * The spectator canvas's panels.
 *
 * Unlike the match screen's fixed five, what's on show here depends on the room and on the mode the
 * caster picked: one board per fleet in the overhead views, two boards in "with <fleet>", plus the
 * log and the rosters that otherwise live in the rail. Team boards are keyed by TEAM NUMBER rather
 * than by position, so a caster who has parked Red's board somewhere keeps it there when a fifth
 * fleet joins and the tiling changes underneath.
 */
export type SpectatorPanelId = `team${number}` | "crewFire" | "crewFleet" | "log" | "roster";

export type SpectatorLayout = PanelLayout<SpectatorPanelId>;

export function teamPanelId(team: number): SpectatorPanelId {
  return `team${team}`;
}

/** How much of the canvas width the rail panels take, leaving the rest to the boards. */
const RAIL_X = 0.78;

/**
 * Where the boards and the rail start out, for however many boards are on show.
 *
 * Computed rather than constant because the panel set is: a two-fleet room wants two big boards
 * side by side and a five-fleet room wants a grid, and neither can be written down in advance. The
 * caster's own drags are stored as overrides on top of this (see usePanelLayout), so re-tiling only
 * ever moves panels they never touched.
 *
 * Boards go at most two across for the same reason boardSideFor caps at two columns: three side by
 * side on a 16:9 screen are each shorter than half the height they could have had.
 */
export function defaultSpectatorLayout(boardIds: SpectatorPanelId[], railShown: boolean): SpectatorLayout {
  const out = {} as SpectatorLayout;
  const n = boardIds.length;
  const boardsW = railShown ? RAIL_X : 1;

  if (n > 0) {
    const cols = Math.min(2, n);
    const rows = Math.ceil(n / cols);
    boardIds.forEach((id, i) => {
      out[id] = {
        x: (i % cols) * (boardsW / cols),
        y: Math.floor(i / cols) * (1 / rows),
        w: boardsW / cols,
        h: 1 / rows,
        z: i + 1,
      };
    });
  }

  // The log gets the taller share: it's the thing a caster reads continuously, while the rosters
  // are a glance to check who has hulls left.
  out.log = { x: RAIL_X, y: 0, w: 1 - RAIL_X, h: 0.56, z: n + 1 };
  out.roster = { x: RAIL_X, y: 0.57, w: 1 - RAIL_X, h: 0.43, z: n + 2 };

  return out;
}

/** Every panel id on screen for a given mode, which is what the layout hook is bound to. */
export function spectatorPanelIds(boardIds: SpectatorPanelId[], railShown: boolean): SpectatorPanelId[] {
  return railShown ? [...boardIds, "log", "roster"] : boardIds;
}
