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
export type SpectatorPanelId = `team${number}` | "crewFire" | "crewFleet" | "log" | "roster" | "odds";

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
export function defaultSpectatorLayout(
  boardIds: SpectatorPanelId[],
  railShown: boolean,
  oddsShown: boolean
): SpectatorLayout {
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

  /**
   * The rail, top to bottom: odds, log, rosters.
   *
   * The eval bar goes at the TOP and gets the smallest share, and both halves of that are
   * deliberate. It is a glance rather than a read - the bar IS the number, so a caster takes it in
   * without stopping - and a glance belongs where the eye lands first. The log gets the tall share
   * because it is the thing being read continuously, and the rosters the rest, being a check on who
   * still has hulls.
   *
   * When the odds are off the other two expand into the space rather than leaving a gap, which is
   * what makes the toggle worth having on a screen where every pixel is already spoken for.
   */
  const oddsH = 0.18;
  const top = oddsShown ? oddsH + 0.01 : 0;
  if (oddsShown) out.odds = { x: RAIL_X, y: 0, w: 1 - RAIL_X, h: oddsH, z: n + 1 };

  const rest = 1 - top;
  out.log = { x: RAIL_X, y: top, w: 1 - RAIL_X, h: rest * 0.56, z: n + 2 };
  out.roster = { x: RAIL_X, y: top + rest * 0.57, w: 1 - RAIL_X, h: rest * 0.43, z: n + 3 };

  return out;
}

/**
 * Every panel id on screen for a given mode, which is what the layout hook is bound to.
 *
 * The odds ride with the rail rather than having their own switch here: they are part of the same
 * "what a caster has beside the boards" decision, and a rail that is hidden has nothing to hang them
 * off. Their own toggle sits inside that, so hiding the rail hides them and showing it restores
 * whatever the caster last chose.
 */
export function spectatorPanelIds(
  boardIds: SpectatorPanelId[],
  railShown: boolean,
  oddsShown: boolean
): SpectatorPanelId[] {
  if (!railShown) return boardIds;
  return oddsShown ? [...boardIds, "odds", "log", "roster"] : [...boardIds, "log", "roster"];
}
