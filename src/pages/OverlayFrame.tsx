import { useEffect } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { casterCamRects, castCamRects, frac, type Rect } from "../lib/castSceneLayout";
import "./OverlayFrame.css";

/**
 * Bordered camera cut-outs for a casting scene - drawn from the same rects the layout module and
 * the OBS scene generator use, so the boxes on screen are exactly where the scene expects the
 * caster to put their webcams.
 *
 * -- Two layouts ----------------------------------------------------------------------------------
 *
 * `?layout=cast`    the two boxes along the bottom of the main EB Cast scene, under the board -
 *                   just borders, transparent, no logo. This is the source that lives in the match
 *                   scene alongside the player boxes and the board.
 *
 * `?layout=casters` the break scene: two big portrait boxes with the wordmark under them, for the
 *                   parts of a broadcast that are not a match. `?bg=deep` adds a sea-tone wash for
 *                   a frame meant to stand on its own rather than over footage.
 *
 * -- The boxes are holes ------------------------------------------------------------------------
 *
 * Each box is a transparent cut-out with a bright border. The cameras go BEHIND this in the scene
 * and show through. Nothing here captures or composites video; it only says where the boxes are.
 * It carries no live data and needs no room - a caster shows the break scene precisely when there
 * is no match.
 */

const LOGO = `${import.meta.env.BASE_URL}logo.png`;

function CamBox({ rect }: { rect: Rect }) {
  const f = frac(rect);
  return (
    <div
      className="ovf-cam"
      style={{
        left: `${f.left * 100}%`,
        top: `${f.top * 100}%`,
        width: `${f.width * 100}%`,
        height: `${f.height * 100}%`,
      }}
    />
  );
}

export function OverlayFrame(props: OverlaySourceProps = {}) {
  const { params } = useOverlaySource(props);
  const layout = params.get("layout") ?? "casters";
  const bg = params.get("bg");
  const isBreak = layout !== "cast";

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const rects = isBreak ? casterCamRects() : castCamRects();

  return (
    <div className={`ovf${isBreak && bg ? ` ovf-bg-${bg}` : ""}`}>
      {rects.map((r, i) => (
        <CamBox key={i} rect={r} />
      ))}
      {isBreak && <img className="ovf-logo" src={LOGO} alt="Elden Battleship" />}
    </div>
  );
}
