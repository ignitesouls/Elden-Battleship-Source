import { type ComponentProps } from "react";
import { useBoxSize } from "../hooks/useBoxSize";
import { fitScale } from "../lib/overlayFit";
import { teamName, teamHex } from "../lib/teamColors";
import { oddsLabel } from "../lib/victoryOdds";
import { OverlayFleetStatus } from "./OverlayFleetStatus";
import { OddsGraph } from "./OddsGraph";
import type { ShipDefinition } from "../types/battleship";
// The bar's own styling still lives with the source it was written for. Imported rather than moved
// so the split costs no risk: nothing about how the scorebug looks changes here.
import "../pages/OverlayTimer.css";

/** One fleet's hulls, as the public log knows them - never read from anybody's private fleet. */
export interface ClockFleet {
  team: number;
  sunkHulls: boolean[];
}

/**
 * The scorebug: every fleet's hulls with the clock between them, and the odds band under it.
 *
 * Split out of pages/OverlayTimer when the OBS box started previewing a whole scene. Two callers
 * now - the browser source, and the preview in the box - and a preview that drew its own scorebug
 * would be a second one to keep in step with the first, which is the argument FindCard already
 * settled for the find alert.
 *
 * It fills whatever box it is given rather than being authored against a fixed width. That is why
 * the fit lives HERE rather than at either call site: the bar is laid out at its natural size and
 * scaled to fit, so one source works at 800px or 2400px, a four-fleet room scales down instead of
 * overflowing, and the recommended size in the control page is a suggestion rather than a
 * requirement. A caller only has to say how big the box is, by being that big.
 *
 * ResizeObserver reports LAYOUT size, which a transform doesn't affect - so measuring the bar while
 * scaling it cannot feed back into itself.
 */
export function ClockBar({
  phaseLabel,
  clock,
  fleets,
  shipDefs,
  highlightTeam,
  showFleets,
  odds,
  opacity,
  textSize,
}: {
  /** "Match", "Randomization", "Preparation" - see the PHASE_LABEL note in OverlayTimer. */
  phaseLabel: string;
  /** Already formatted, because only the caller knows whether it is counting up or down. */
  clock: string;
  fleets: ClockFleet[];
  shipDefs: ShipDefinition[];
  /** The streamer's own fleet, marked out among the rest. Null at the desk, which has no side. */
  highlightTeam: number | null;
  /** A caster running this very small can drop to the clock alone. */
  showFleets: boolean;
  /** The win-probability band. Absent for a crew - it is a caster's instrument. See OverlayLinkBox. */
  odds?: {
    teams: number[];
    odds: number[];
    points: ComponentProps<typeof OddsGraph>["points"];
  } | null;
  opacity: number;
  /** The CEILING on the fit, not a multiplier after it - see fitScale and lib/overlayText. */
  textSize: number;
}) {
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [barRef, bar] = useBoxSize<HTMLDivElement>();
  const [rowRef, row] = useBoxSize<HTMLDivElement>();

  // See fitScale for why it leaves a margin rather than fitting exactly - the clock's plate has a
  // border on it too, and an exact fit is what clips it.
  const scale = fitScale(bar, frame, 8, textSize);

  // Split around the clock: with two fleets that is one each, which is the case this is shaped for.
  const half = Math.ceil(fleets.length / 2);
  const side = (group: ClockFleet[]) =>
    group.map((f) => (
      <OverlayFleetStatus
        key={f.team}
        teamLabel={teamName(f.team)}
        colorHex={teamHex(f.team)}
        shipDefs={shipDefs}
        sunkHulls={f.sunkHulls}
        isMine={highlightTeam === f.team}
      />
    ));

  return (
    <div className="ovt-fit" ref={frameRef}>
      <div className="ovt-bar" ref={barRef} style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}>
        <div className="ovt-row" ref={rowRef}>
          {showFleets && <div className="ovt-side ovt-left">{side(fleets.slice(0, half))}</div>}

          <div className="ovt-clock">
            <span className="ovt-phase">{phaseLabel}</span>
            <span className="ovt-time">{clock}</span>
          </div>

          {showFleets && <div className="ovt-side ovt-right">{side(fleets.slice(half))}</div>}
        </div>

        {/**
         * The band runs the width of the row above it, so the odds share the clock's axis - a swing
         * lines up with the minute it happened on. Width comes from measuring that row rather than
         * from a constant, because a four-fleet scorebug is wider than a duel's and a band that
         * guessed would either fall short or push the bug wider than its own contents.
         */}
        {odds && odds.points.length > 1 && row.w > 0 && (
          <div className="ovt-odds">
            <OddsGraph teams={odds.teams} points={odds.points} width={row.w} height={26} rule={false} />
            <div className="ovt-odds-keys">
              {odds.teams.map((t, i) => (
                <span className="ovt-odds-key" key={t}>
                  <i style={{ background: teamHex(t) }} />
                  {teamName(t)} {oddsLabel(odds.odds[i])}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
