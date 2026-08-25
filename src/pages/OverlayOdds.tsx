import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useBoxSize } from "../hooks/useBoxSize";
import { useBattleClock } from "../hooks/useBattlePhase";
import { useVictoryOdds } from "../hooks/useVictoryOdds";
import { formatDuration } from "../lib/matchTime";
import { teamName, teamHex } from "../lib/teamColors";
import { oddsLabel } from "../lib/victoryOdds";
import { OddsGraph } from "../components/OddsGraph";
import { fitScale } from "../lib/overlayFit";
import { readOpacity } from "../lib/overlayCast";
import { readTextSize } from "../lib/overlayText";
import "./Overlay.css";
import "./OverlayOdds.css";

/**
 * The odds source: each fleet's chance of winning, and how it got there.
 *
 * Its own browser source rather than part of the scorebug, for the same reason the scorebug is not
 * part of the board - the two want different treatment in a scene. The scorebug is small and parked
 * in a corner all match; this is a thing a caster brings UP during a swing and takes back down, and
 * it wants room for the history line that makes the swing legible. A caster who would rather have
 * it permanently attached to the clock has that too, as `?odds=1` on the scorebug.
 *
 * Entirely public data - the attack log and the room - so like the scorebug it needs no controller
 * and no credential, and follows the match on its own from the moment the URL is pasted in. See
 * lib/victoryOdds for why the model never touches the private `fleets` table, and for how well it
 * actually predicts (well late, barely at all early, and it is built to say so).
 */

/** The panel's natural size. Scaled to whatever source it is dropped into - see OverlayTimer. */
const GRAPH_WIDTH = 880;
const GRAPH_HEIGHT = 150;

export function OverlayOdds() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);
  const phase = useBattleClock(state.attacks, state.room);
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [panelRef, panel] = useBoxSize<HTMLDivElement>();

  // ?graph=0 drops to the bar alone, for a caster who wants this very small.
  const showGraph = params.get("graph") !== "0";
  const { snapshot, timeline } = useVictoryOdds(state.attacks, state.room, state.players, showGraph);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const opacity = readOpacity(params);
  const textSize = readTextSize(params);
  const scale = fitScale(panel, frame, 8, textSize);

  // Nothing to say until there are two fleets and a shot fired between them. Drawn as an empty
  // source rather than an "awaiting match" plate: this one gets left in a scene between matches.
  if (!state.room || !snapshot || snapshot.fleets.every((f) => f.shots === 0)) {
    return <div className="ovo" ref={frameRef} />;
  }

  const { teams, odds } = snapshot;
  const elapsed = phase?.phase === "match" ? formatDuration(phase.matchElapsed) : "--:--";

  return (
    <div className="ovo" ref={frameRef}>
      {/**
       * The panel takes its width from its contents rather than carrying one, because
       * `box-sizing: border-box` is global here: a width on the plate would be the OUTER width and
       * the graph inside it would lose the padding off its right edge. Sizing the children and
       * letting the plate shrink to fit keeps the graph exactly GRAPH_WIDTH whatever the padding
       * is changed to later.
       */}
      <div
        className="ovo-panel"
        ref={panelRef}
        style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}
      >
        <div className="ovo-head">
          <span className="ovo-title">Odds of Victory</span>
          {snapshot.decided && <span className="ovo-decided">Decided</span>}
        </div>

        {/**
         * The bar is the number. Each fleet's slice IS its chance, so the reading is the width
         * rather than the digits - which is what lets somebody glance at it mid-sentence.
         *
         * A slice under a few percent cannot hold its own label, so the text moves outside rather
         * than being clipped to an unreadable sliver. flexGrow rather than a percentage width so
         * the slices always close the row exactly, whatever rounding does to the labels.
         */}
        <div className="ovo-now" style={{ width: GRAPH_WIDTH }}>
          {teams.map((team, i) => (
            <div
              key={team}
              className={`ovo-seg${odds[i] < 0.12 ? " ovo-seg-tight" : ""}`}
              style={{ flexGrow: Math.max(odds[i], 0.008), background: teamHex(team) }}
            >
              <span className="ovo-seg-name">{teamName(team)}</span>
              <span className="ovo-seg-pct">{oddsLabel(odds[i])}</span>
            </div>
          ))}
        </div>

        {showGraph && timeline.length > 1 && (
          <>
            <div className="ovo-graph" style={{ width: GRAPH_WIDTH, height: GRAPH_HEIGHT }}>
              <OddsGraph teams={teams} points={timeline} width={GRAPH_WIDTH} height={GRAPH_HEIGHT} />
            </div>
            {/* The axis is the match clock, which is the only scale this line is meaningful on. */}
            <div className="ovo-axis">
              <span>{formatDuration(timeline[0].seconds)}</span>
              <span className="ovo-axis-now">{elapsed}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
