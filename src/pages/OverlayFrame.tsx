import { useEffect } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { CAST_ART } from "../lib/castSceneLayout";
import "./OverlayFrame.css";

/**
 * The frame art for a casting scene, as a full-canvas source.
 *
 * -- Two layouts ----------------------------------------------------------------------------------
 *
 * `?layout=cast`    the match frame (battleship-overlays.png): holes for the six player streams, the
 *                   board and the two caster cams, and the water banner the clock sits on.
 *
 * `?layout=casters` the break frame (battleship-casters.png): two big camera holes over the sea, with
 *                   the wordmark, for the parts of a broadcast that are not a match.
 *
 * -- The holes ------------------------------------------------------------------------------------
 *
 * The art's holes are transparent. The streams, the board and the webcams go BEHIND this in the scene
 * and show through; lib/castSceneLayout holds the same holes as rects, so the scene puts each source
 * exactly under its hole. Nothing here captures or composites video. It carries no live data and
 * needs no room - a caster shows the break scene precisely when there is no match.
 */

export function OverlayFrame(props: OverlaySourceProps = {}) {
  const { params } = useOverlaySource(props);
  const isBreak = (params.get("layout") ?? "casters") !== "cast";

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const art = `${import.meta.env.BASE_URL}${isBreak ? CAST_ART.break : CAST_ART.match}`;

  return (
    <div className="ovf">
      <img className="ovf-art" src={art} alt="" />
    </div>
  );
}
