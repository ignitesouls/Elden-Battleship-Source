import { useEffect } from "react";
import "./OverlayTrailer.css";

/** The Elden Battleship trailer, served from the site. */
export const TRAILER_VIDEO = "media/battleship-trailer.mp4";

/**
 * The trailer, full canvas, with its sound - the "EB Trailer" scene in the caster's download.
 *
 * Plays once from the top each time the scene is shown: the source has "shutdown when hidden" on
 * (see browserSource in lib/obsScene), so switching to the scene restarts it, and it holds on the
 * last frame when it ends rather than looping. Its sound goes to its own fader in the OBS mixer
 * (reroute_audio), so a caster can sit it under their voice. Nothing here plays unless the scene is
 * on - a hidden source is a stopped page.
 */
export function OverlayTrailer() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  return (
    <div className="ovtr">
      <video className="ovtr-video" src={`${import.meta.env.BASE_URL}${TRAILER_VIDEO}`} autoPlay playsInline />
    </div>
  );
}
