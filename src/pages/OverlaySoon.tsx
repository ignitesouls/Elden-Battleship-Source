import { useEffect } from "react";
import { useDeskState } from "../lib/deskLink";
import { useT } from "../lib/language";
import "./OverlaySoon.css";

/** The looping sea under the Starting Soon screen, and the wordmark over it. */
export const SOON_VIDEO = "media/starting-soon.mp4";
const LOGO = "logo.png";

/**
 * "Starting Soon: A vs. B" over a looping sea - the caster's holding screen before a match.
 *
 * One full-canvas source draws all of it - video, wordmark and text - so a caster imports one thing
 * and it is composed. The two names come live from the caster desk (lib/deskLink), keyed on the
 * caster's account rather than a room, because this is on screen before the room exists. Until the
 * desk has said anything the line reads "Starting Soon" alone.
 *
 * `names` is for the setup page's preview, which has no desk: it shows sample names in place of the
 * live ones. The video is muted and loops; OBS restarting the source (shutdown when hidden) just
 * starts it from the top, which is what a holding screen should do.
 */
export function OverlaySoon({ ownerId, names }: { ownerId?: string | null; names?: [string, string] }) {
  const t = useT();
  const desk = useDeskState(names ? null : ownerId);
  const [a, b] = (names ?? desk?.matchup ?? ["", ""]).map((n) => n.trim());

  useEffect(() => {
    if (names) return;
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, [names]);

  return (
    <div className={names ? "ovn ovn-embedded" : "ovn"}>
      <video className="ovn-video" src={`${import.meta.env.BASE_URL}${SOON_VIDEO}`} autoPlay muted loop playsInline />
      <div className="ovn-shade" />
      <div className="ovn-content">
        <img className="ovn-logo" src={`${import.meta.env.BASE_URL}${LOGO}`} alt="Elden Battleship" />
        <div className="ovn-title">{t("Starting Soon", "Bientôt")}</div>
        {(a || b) && (
          <div className="ovn-matchup">
            <span className="ovn-side">{a || "?"}</span>
            <span className="ovn-vs">vs.</span>
            <span className="ovn-side">{b || "?"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
