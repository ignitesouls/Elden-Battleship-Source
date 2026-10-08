import { useEffect, useState } from "react";
import { fetchOfficialMatch, type OfficialMatchInfo } from "../lib/tournament/api";
import { OfficialMatchLine } from "../components/event/OfficialMatchLine";
import "../components/Tournament.css";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { useBattleClock } from "../hooks/useBattlePhase";
import { useVictoryOdds } from "../hooks/useVictoryOdds";
import { formatDuration } from "../lib/matchTime";
import { OddsPanel } from "../components/OddsPanel";
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

export function OverlayOdds(props: OverlaySourceProps = {}) {
  // The room and the query string come from the URL, or from the persistent stream route that has
  // resolved them off an overlay token. See hooks/useOverlaySource for why this page takes props.
  const { code, params } = useOverlaySource(props);
  const state = useRoom(code);
  const phase = useBattleClock(state.attacks, state.room);

  // ?graph=0 drops to the bar alone, for a caster who wants this very small.
  const showGraph = params.get("graph") !== "0";
  const { snapshot, timeline } = useVictoryOdds(state.attacks, state.room, state.players, showGraph);

  // An official tournament match also shows its pre-match line (team power), above the live odds - a
  // caster's "the book had them at -180" before the first shot. ?line=0 hides it.
  const matchId = state.room?.tournament_match_id ?? null;
  const showLine = params.get("line") !== "0";
  const [official, setOfficial] = useState<OfficialMatchInfo | null>(null);
  useEffect(() => {
    if (!matchId || !showLine) {
      setOfficial(null);
      return;
    }
    let cancelled = false;
    fetchOfficialMatch(matchId)
      .then((m) => !cancelled && setOfficial(m))
      .catch(() => undefined); // best effort: the odds must never fail over an extra
    return () => {
      cancelled = true;
    };
  }, [matchId, showLine]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  if (!state.room) return null;

  /**
   * The panel itself is components/OddsPanel, which the spectator page mounts too.
   *
   * Everything about filling the source went with it - the natural-size layout, the measurement and
   * the fit - because all of that is the panel's business rather than this page's. What is left here
   * is a page: the room, the query string, and a transparent rectangle for the panel to fill.
   */
  return (
    <div className="ovo">
      {official && (
        <div className="ovo-line">
          <OfficialMatchLine info={official} small />
        </div>
      )}
      <OddsPanel
        snapshot={snapshot}
        points={timeline}
        elapsed={phase?.phase === "match" ? formatDuration(phase.matchElapsed) : "--:--"}
        showGraph={showGraph}
        opacity={readOpacity(params)}
        textSize={readTextSize(params)}
      />
    </div>
  );
}
