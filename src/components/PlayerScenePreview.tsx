import { FindCard } from "./FindCard";
import { SampleBoard, SampleFleet } from "./OverlaySample";
import {
  PLAYER_ART,
  frac,
  playerCamRect,
  playerFireRect,
  playerFleetRect,
  playerGameRect,
  type Rect,
} from "../lib/castSceneLayout";
import { useT } from "../lib/language";
import type { DeepMark } from "../lib/deepWater";
import "./OverlaySample.css";
import "./CastScenePreview.css";

/** Where a rect sits in the preview, as percentages of the 16:9 frame. */
function place(r: Rect) {
  const f = frac(r);
  return { left: `${f.left * 100}%`, top: `${f.top * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
}

/** A hole's edge as a share of the frame's width, a little inside it - what the sample grids size in. */
const edge = (r: Rect) => `${(r.w / 1920) * 100 * 0.94}cqw`;

/**
 * The player frame scene, as it will look on stream.
 *
 * Stacked the way lib/obsScene playerSceneParts stacks the download: gameplay, webcam, board and
 * fleet underneath, the frame art over them, and the find alert on top. The board and the fleet are
 * the real components with sample data; the gameplay and the webcam are stand-ins. Wears the casting
 * preview's classes, because it is the same kind of picture.
 */
export function PlayerScenePreview({
  textSize,
  fleet,
  alertMark,
}: {
  textSize: number;
  /** Show the fleet in its hole. Off leaves the hole empty, as it would be on stream. */
  fleet: boolean;
  /** A find to hold over the gameplay, or null. */
  alertMark?: DeepMark | null;
}) {
  const t = useT();
  const game = playerGameRect();
  const fire = playerFireRect();
  const fleetHole = playerFleetRect();

  return (
    <div className="csp" role="img" aria-label={t("Preview of your scene", "Aperçu de votre scène")}>
      <div
        className="csp-screen"
        style={{ ...place(game), backgroundImage: `url(${import.meta.env.BASE_URL}preview/footage.jpg)` }}
      />

      <div className="csp-cam" style={place(playerCamRect())}>
        <span>{t("Your webcam", "Votre webcam")}</span>
      </div>

      <div className="csp-board" style={place(fire)}>
        <SampleBoard opacity={1} emptyFade={1} textSize={textSize} size={edge(fire)} />
      </div>

      {fleet && (
        <div className="csp-board" style={place(fleetHole)}>
          <SampleFleet opacity={1} emptyFade={1} size={edge(fleetHole)} />
        </div>
      )}

      <img className="csp-art" src={`${import.meta.env.BASE_URL}${PLAYER_ART.frame}`} alt="" />

      {alertMark ? (
        <div className="csp-alert" style={place(game)}>
          <FindCard mark={alertMark} who={t("Your crew", "Votre équipe")} team={1} where="D7" />
        </div>
      ) : null}
    </div>
  );
}
