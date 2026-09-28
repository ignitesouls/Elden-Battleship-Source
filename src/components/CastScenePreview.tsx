import { FindCard } from "./FindCard";
import { SampleBoard, SampleClock } from "./OverlaySample";
import {
  CAST_ART,
  boardRect,
  castCamRects,
  casterCamRects,
  clockRect,
  frac,
  screenRects,
  type Rect,
} from "../lib/castSceneLayout";
import { teamHex } from "../lib/teamColors";
import { useT } from "../lib/language";
import type { DeepMark } from "../lib/deepWater";
import "./OverlaySample.css";
import "./CastScenePreview.css";

/** Where a rect sits in the preview, as percentages of the 16:9 frame. */
function place(r: Rect) {
  const f = frac(r);
  return { left: `${f.left * 100}%`, top: `${f.top * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
}

/** Made-up numbers for the six plates - uneven, so the plate reads as live data rather than a template. */
const SAMPLE_STATS = [
  [9, 4],
  [6, 7],
  [11, 3],
  [8, 5],
  [5, 8],
  [10, 6],
];

/**
 * The whole casting scene, as it will look on stream.
 *
 * Built in the same stacking order the downloaded file uses (lib/obsScene castSceneParts): the
 * player streams, the board and the webcams underneath, the frame art over them, and the find alert
 * and the clock on top of the art. The boxes are placed from the same rects as the file, so what the
 * caster sees here is where each source lands in OBS.
 *
 * The streams and webcams are stand-ins - there is no match to show on a setup page. The board and
 * the clock are the real components with sample data, so the sliders move them exactly as they will
 * move the real sources.
 */
export function CastScenePreview({
  scene,
  clockOpacity,
  clockText,
  alertMark,
}: {
  scene: "match" | "break";
  clockOpacity: number;
  clockText: number;
  /** A find to hold over the board, or null. */
  alertMark?: DeepMark | null;
}) {
  const t = useT();
  const footage = `url(${import.meta.env.BASE_URL}preview/footage.jpg)`;

  if (scene === "break") {
    return (
      <div className="csp" role="img" aria-label={t("Preview of the break scene", "Aperçu de la scène de pause")}>
        {casterCamRects().map((r, i) => (
          <div key={i} className="csp-cam" style={place(r)}>
            <span>{i === 0 ? t("Your webcam", "Votre webcam") : t("Co-caster's webcam", "Webcam du co-commentateur")}</span>
          </div>
        ))}
        <img className="csp-art" src={`${import.meta.env.BASE_URL}${CAST_ART.break}`} alt="" />
      </div>
    );
  }

  const board = boardRect();
  // The board source's edge as a share of the frame's width - SampleBoard sizes in container units.
  const boardSize = `${(board.w / 1920) * 100 * 0.94}cqw`;

  return (
    <div className="csp" role="img" aria-label={t("Preview of the match scene", "Aperçu de la scène de match")}>
      {screenRects().map((r, i) => {
        const team = i < 3 ? 0 : 1;
        const [hits, misses] = SAMPLE_STATS[i];
        return (
          <div
            key={i}
            className="csp-screen"
            style={{ ...place(r), backgroundImage: footage, ["--csp-accent" as string]: teamHex(team) }}
          >
            <div className="csp-plate">
              <span className="csp-name">{t("Player", "Joueur")} {i + 1}</span>
              <span className="csp-stats">
                H- {hits} M- {misses} A- {Math.round((hits / (hits + misses)) * 100)}%
              </span>
            </div>
          </div>
        );
      })}

      <div className="csp-board" style={place(board)}>
        <SampleBoard opacity={1} emptyFade={1} textSize={1} size={boardSize} />
      </div>

      {castCamRects().map((r, i) => (
        <div key={i} className="csp-cam" style={place(r)}>
          <span>{i === 0 ? t("Your webcam", "Votre webcam") : t("Co-caster", "Co-commentateur")}</span>
        </div>
      ))}

      <img className="csp-art" src={`${import.meta.env.BASE_URL}${CAST_ART.match}`} alt="" />

      {alertMark ? (
        <div className="csp-alert" style={place(board)}>
          <FindCard mark={alertMark} who={t("Red Fleet", "Flotte rouge")} team={0} where="D7" />
        </div>
      ) : null}

      <div className="csp-clock" style={place(clockRect())}>
        <SampleClock isCaster opacity={clockOpacity} textSize={clockText} />
      </div>
    </div>
  );
}
