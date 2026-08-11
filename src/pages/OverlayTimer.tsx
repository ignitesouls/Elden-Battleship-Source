import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useBoxSize } from "../hooks/useBoxSize";
import { useBattlePhase } from "../hooks/useBattlePhase";
import { activeTeams } from "../lib/battleshipLogic";
import { formatDuration } from "../lib/matchTime";
import { teamName, teamHex } from "../lib/teamColors";
import { OverlayFleetStatus } from "../components/OverlayFleetStatus";
import { fitScale } from "../lib/overlayFit";
import { readOpacity } from "../lib/overlayCast";
import { readTextSize } from "../lib/overlayText";
import "./Overlay.css";
import "./OverlayTimer.css";

const PHASE_LABEL = { starting: "Starting", preparation: "Preparation", match: "Match" } as const;

/**
 * The scorebug: the match clock, with each fleet's surviving hulls drawn either side of it.
 *
 * Its own browser source rather than part of the board's, because the two want opposite treatment
 * in a scene. The board is big, moves, and gets pointed at; this is small, parked in a corner or
 * along the bottom, and never moves once placed. One source each means the caster can put them
 * where they like and hide one without losing the other.
 *
 * Entirely public data - shots and the room - so it needs no controller and no credential. It
 * follows the match on its own from the moment the URL is pasted in, which is the right behaviour
 * for the one element nobody should have to remember to drive.
 *
 * Fleets are drawn as silhouettes rather than "3/5" for the reason OverlayFleetStatus exists:
 * "they've lost the Carrier" is a better thing to read off a stream than a fraction. With more than
 * two fleets in the room they split evenly around the clock rather than crowding one side.
 */
export function OverlayTimer() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);
  const phase = useBattlePhase(state.attacks, state.room);
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [barRef, bar] = useBoxSize<HTMLDivElement>();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const room = state.room;
  if (!room) return null;

  const teams = activeTeams(state.players);
  // ?team=N marks the streamer's own fleet, same as the HUD overlay does.
  const rawTeam = params.get("team");
  const highlightTeam = rawTeam !== null && rawTeam !== "" ? Number(rawTeam) : null;
  // Ships are the point of this element, but a caster running it very small can drop to the clock.
  const showFleets = params.get("fleets") !== "0";
  // ?opacity= - the same setting the board takes, so a scene can be faded as one thing rather than
  // ending up with a ghost board under a solid scorebug. See readOpacity.
  const opacity = readOpacity(params);
  // ?text= - how far past its natural size the bar may be drawn to fill the source. See overlayText.
  const textSize = readTextSize(params);

  /** Hulls of `team` confirmed sunk, from the public log - never from reading their fleet. */
  const sunkNamesFor = (team: number) =>
    state.attacks
      .filter((a) => a.defender_team === team && a.result === "sunk" && a.sunk_ship_name)
      .map((a) => a.sunk_ship_name as string);

  // Split around the clock: with two fleets that is one each, which is the case this is shaped for.
  const half = Math.ceil(teams.length / 2);
  const left = teams.slice(0, half);
  const right = teams.slice(half);

  const clock = phase
    ? phase.phase === "match"
      ? formatDuration(phase.matchElapsed)
      : `-${formatDuration(phase.countdown)}`
    : "--:--";

  const side = (group: number[]) =>
    group.map((t) => (
      <OverlayFleetStatus
        key={t}
        teamLabel={teamName(t)}
        colorHex={teamHex(t)}
        shipDefs={room.ship_defs}
        sunkNames={sunkNamesFor(t)}
        isMine={highlightTeam === t}
      />
    ));

  /**
   * Fill whatever source the streamer made, without them having to guess a size.
   *
   * The bar is laid out at its natural size and then scaled to fit, rather than being authored
   * against a fixed design width. That way one source works at 800px or 2400px, a four-fleet room
   * scales down instead of overflowing, and the recommended size in the control page is a
   * suggestion rather than a requirement.
   *
   * ResizeObserver reports LAYOUT size, which a transform doesn't affect - so measuring the bar
   * while scaling it cannot feed back into itself.
   *
   * See fitScale for why it leaves a margin rather than fitting exactly - the clock's plate has a
   * border on it too, and an exact fit is what clips it.
   *
   * The streamer's text size is the CEILING handed to that fit, not a multiplier applied after it:
   * the source is still the boundary, so asking for larger text on a bar that already fills its
   * source does nothing rather than pushing the clock's ends off the edge of the scene.
   */
  const scale = fitScale(bar, frame, 8, textSize);

  return (
    <div className="ovt" ref={frameRef}>
      <div className="ovt-bar" ref={barRef} style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}>
        {showFleets && <div className="ovt-side ovt-left">{side(left)}</div>}

        <div className="ovt-clock">
          <span className="ovt-phase">{phase ? PHASE_LABEL[phase.phase] : "Match"}</span>
          <span className="ovt-time">{clock}</span>
        </div>

        {showFleets && <div className="ovt-side ovt-right">{side(right)}</div>}
      </div>
    </div>
  );
}
