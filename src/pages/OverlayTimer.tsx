import { useEffect } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { useBattleClock } from "../hooks/useBattlePhase";
import { useVictoryOdds } from "../hooks/useVictoryOdds";
import { activeTeams, sunkHullFlags } from "../lib/battleshipLogic";
import { formatDuration } from "../lib/matchTime";
import { ClockBar } from "../components/ClockBar";
import { readOpacity, MAX_DELAY_MS } from "../lib/overlayCast";
import { readTextSize } from "../lib/overlayText";
import "./Overlay.css";
import "./OverlayTimer.css";

// See MatchClock for why the label and the phase key differ.
const PHASE_LABEL = { starting: "Randomization", preparation: "Preparation", match: "Match" } as const;

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
export function OverlayTimer(props: OverlaySourceProps = {}) {
  // The room and the query string come from the URL, or from the persistent stream route that has
  // resolved them off an overlay token. See hooks/useOverlaySource for why this page takes props.
  const { code, params } = useOverlaySource(props);
  const state = useRoom(code);
  const phase = useBattleClock(state.attacks, state.room);

  /**
   * ?odds=1 - the win-probability band, under the clock.
   *
   * Off by default, and deliberately so. The scorebug is the one element a streamer sets up once
   * and leaves running all match, so it is the wrong place to add ink nobody asked for; a caster
   * who wants the odds permanently attached to the clock opts in, and everybody else's existing
   * source is unchanged by this landing. The fuller treatment is its own source - see OverlayOdds.
   */
  const showOdds = params.get("odds") === "1";
  // Twice, and not by accident: this source uses the snapshot ONLY when the band is on, so `showOdds`
  // is both "draw the history" and "run the model at all". Without the second the scorebug on every
  // player's stream - which never asks for odds - was running ten thousand rollouts per shot to fill
  // a variable it then ignored. See the `enabled` note in useVictoryOdds.
  const { snapshot, timeline } = useVictoryOdds(state.attacks, state.room, state.players, showOdds, showOdds);

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
  const sunkHullsFor = (team: number) => sunkHullFlags(state.attacks, team, room.ship_defs);

  /**
   * ?delay= - hold the clock back to where the players' streams are, in milliseconds.
   *
   * The clock has no controller to hear a delay from (see CastView.delayMs), so a caster copies the
   * same number onto its URL from the desk. A stream running N seconds late should read N seconds
   * further from zero than the live board: the countdown is that much higher, the match clock that
   * much lower. Only the number moves - the hull silhouettes stay live, which is a second-order
   * detail nobody reads a scorebug for.
   */
  const delaySec = Math.max(0, Math.min(MAX_DELAY_MS, Number(params.get("delay")) || 0)) / 1000;
  const shownElapsed = phase ? Math.max(0, Math.round(phase.matchElapsed - delaySec)) : 0;
  const shownCountdown = phase ? Math.round(phase.countdown + delaySec) : 0;

  const clock = phase
    ? phase.phase === "match"
      ? formatDuration(shownElapsed)
      : `-${formatDuration(shownCountdown)}`
    : "--:--";

  /**
   * The bar itself is components/ClockBar, which the OBS box's scene preview mounts too.
   *
   * Everything about filling the source went with it - the natural-size layout, the measurement and
   * the fit - because all of that is the bar's business rather than this page's. What is left here
   * is a page: the room, the query string, and a transparent rectangle for the bar to fill.
   */
  return (
    <div className="ovt">
      <ClockBar
        phaseLabel={phase ? PHASE_LABEL[phase.phase] : "Match"}
        clock={clock}
        fleets={teams.map((t) => ({ team: t, sunkHulls: sunkHullsFor(t) }))}
        shipDefs={room.ship_defs}
        highlightTeam={highlightTeam}
        showFleets={showFleets}
        // Only when asked for, and only a caster is ever told to ask - see OverlayLinkBox on why
        // the odds are not offered to somebody still playing.
        odds={showOdds && snapshot ? { teams: snapshot.teams, odds: snapshot.odds, points: timeline } : null}
        opacity={opacity}
        textSize={textSize}
      />
    </div>
  );
}
