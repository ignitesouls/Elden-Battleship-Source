import type { Attack } from "../types/battleship";
import type { CastView } from "./overlayCast";

/**
 * Which shots are allowed to draw a result on a cast board.
 *
 * -- Why this is a module and not four lines in each page --
 *
 * The control page's monitor and the browser source render the same board twice, from the same
 * public shot log, in two files. Every derivation they share already carries a comment saying the
 * two must not disagree - and they must not, because the monitor's entire claim is that it IS the
 * frame. A caster who cannot trust it has to go and look at the stream, which is the thing the
 * monitor exists to save them.
 *
 * Two toggles is where copying that by hand stops being safe. `markers` is easy to mirror; the
 * per-fleet filter is not, because it turns on a distinction the rest of the board doesn't make -
 * see below - and getting it wrong in one file only shows up as a stream that quietly disagrees
 * with the desk.
 *
 * -- The distinction, which is the part that is easy to get backwards --
 *
 * `mode` picks whose BOARD is drawn, and narrows the log by `defender_team` - the shots aimed AT
 * those fleets. This picks whose SHOTS are drawn on it, and narrows by `attacker_team`. They are
 * different fields answering different questions, and on a composited board both are live at once:
 * "Blue's board, showing only Red's hits" is a sentence a caster means literally.
 *
 * -- What is deliberately NOT filtered --
 *
 * The attribution rings. They are built from the unfiltered set by both callers, and that is the
 * whole shape of the feature: with markers off, the ring is what remains - a board that still says
 * every square anyone has shot at, and whose shot it was, without the sprites and fills that were
 * sitting on top of the square's name. Filtering the rings here as well would leave a board with
 * nothing on it at all.
 */
export function markedAttacks(relevant: Attack[], view: Pick<CastView, "markers" | "markerTeams">): Attack[] {
  // Absent means yes. A frame from a controller that predates the field carries no opinion, and the
  // board it was driving drew every marker - so that is what "no opinion" has to keep meaning.
  if (view.markers === false) return [];
  const teams = view.markerTeams;
  if (!teams || teams.length === 0) return relevant;
  return relevant.filter((a) => teams.includes(a.attacker_team));
}

/**
 * The spotlight's cells as a set, for the board to test each square against.
 *
 * Here rather than inline at both call sites for the same reason as above, and because `spot` is
 * optional on the wire in two different ways - absent, or explicitly null - and a board that
 * treated one of those as "an empty spotlight" and the other as a crash would be a bug that only
 * appeared when a source reconnected to an older controller.
 */
export function spotSet(view: Pick<CastView, "spot">): ReadonlySet<number> {
  return new Set(view.spot ?? []);
}
