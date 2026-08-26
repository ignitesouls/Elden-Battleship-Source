import { DeepMarkIcon } from "./HitMarkers";
import { alertLabel } from "../lib/deepLabels";
import { teamHex } from "../lib/teamColors";
import type { DeepMark } from "../lib/deepWater";
import "./FindCard.css";

/**
 * One find, as it appears on stream: the artwork, what it was, and who turned it up.
 *
 * The artwork is the very same component a board square mounts (see HitMarkers), inside a box that
 * is simply larger - the marks are positioned in percentages against their container, so scaling one
 * is a matter of giving it more room and nothing else. That is why this is not a video, and the long
 * version of the argument is in pages/OverlayEgg.
 *
 * Two callers: the alert source, and the preview in the OBS box. The box previewing a card it drew
 * itself would be a promise it could quietly stop keeping.
 */
export function FindCard({
  mark,
  who,
  team,
  where,
}: {
  mark: DeepMark;
  /** Nickname at the time of the shot, or the team name if they'd already left. */
  who: string;
  team: number;
  /** The square, spelled the way a caster would say it. */
  where: string;
}) {
  return (
    <div className="ove-card">
      <div className="ove-art">
        <DeepMarkIcon mark={mark} />
      </div>
      <div className="ove-words">
        <div className="ove-what">{alertLabel(mark)}</div>
        <div className="ove-who">
          <span style={{ color: teamHex(team) }}>{who}</span>
          <span className="ove-where">{where}</span>
        </div>
      </div>
    </div>
  );
}
