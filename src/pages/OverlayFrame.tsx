import { useEffect } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { CAST_ART, PLAYER_ART } from "../lib/castSceneLayout";
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
 * `?layout=player`  a crew member's own frame (player-overlay.png): holes for their fire board,
 *                   gameplay, fleet and webcam. See playerSceneParts in lib/obsScene.
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
  const layout = params.get("layout") ?? "casters";

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const file = layout === "player" ? PLAYER_ART.frame : layout === "cast" ? CAST_ART.match : CAST_ART.break;
  const art = `${import.meta.env.BASE_URL}${file}`;

  return (
    <div className="ovf">
      <img className="ovf-art" src={art} alt="" />
    </div>
  );
}
