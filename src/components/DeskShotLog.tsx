import { memo, useMemo } from "react";
import { cellLabel } from "../lib/battleshipLogic";
import { challengesForRoom } from "../lib/challenges";
import { outcomeText, type FeedShot } from "../lib/attackFeed";
import { matchStartedAt, matchTimeAt, matchTimings } from "../lib/matchTime";
import { teamHex } from "../lib/teamColors";
import { useLanguage, useT } from "../lib/language";
import { TeamGlyph } from "./TeamGlyph";
import type { DeepMark, IgonEncounter } from "../lib/deepWater";
import type { Attack, Room } from "../types/battleship";

interface Props {
  /** Newest first, as groupIntoShots returns them. */
  shots: FeedShot[];
  attacks: Attack[];
  room: Room;
  deepCells?: ReadonlyMap<number, DeepMark>;
  igon?: readonly IgonEncounter[] | null;
}

/**
 * Who did what, for the caster's eyes only - nothing here goes down the cast channel.
 *
 * The room's Battle Log (components/AttackFeed) cut down to something readable at a glance: the name
 * and the result on one line, the square under it, a fleet-coloured edge, and misses turned down so
 * the hits stand out. Same wording as that log, because it comes from the same outcomeText.
 *
 * Memoised, and works out the squares itself rather than taking them as a prop: the desk re-renders on
 * every frame of a drag, and a log of a few hundred rows should not be rebuilt each time. Everything it
 * is passed only changes when a shot lands.
 */
export const DeskShotLog = memo(function DeskShotLog({ shots, attacks, room, deepCells, igon }: Props) {
  const t = useT();
  const lang = useLanguage();
  const challenges = useMemo(
    () => challengesForRoom(room.id, room.board_size * room.board_size, room.square_set, room.seed, room.board_perm, room.seed_set_at),
    [room]
  );
  const startedAt = matchStartedAt(attacks);
  const timings = matchTimings(room);

  return (
    <div className="cast-log">
      <h3>
        {t("Shot log", "Journal des tirs")}
        {shots.length > 0 && ` (${shots.length})`}
      </h3>
      {shots.length === 0 ? (
        <span className="muted cast-note">{t("No shots yet.", "Aucun tir pour l'instant.")}</span>
      ) : (
        <div className="cast-log-list">
          {shots.map((shot) => {
            const outcome = outcomeText(shot, deepCells, room, igon);
            const c = challenges[shot.cellIndex];
            const coord = cellLabel(shot.cellIndex, room.board_size);
            const name = c ? ((lang === "fr" ? c.nameFr : undefined) ?? c.name) : null;
            const miss = outcome.text === "miss";
            return (
              <div
                key={shot.key}
                className={`cast-log-row${miss ? " cast-log-miss" : ""}`}
                style={{ borderLeftColor: teamHex(shot.attackerTeam) }}
              >
                <div className="cast-log-top">
                  <span className="cast-log-time">{matchTimeAt(startedAt, shot.at, timings, room)}</span>
                  <strong className="cast-log-who" style={{ color: teamHex(shot.attackerTeam) }}>
                    <TeamGlyph team={shot.attackerTeam} /> {shot.who}
                  </strong>
                  <span className="cast-log-result" style={{ color: outcome.color }}>
                    {outcome.text}
                  </span>
                </div>
                <div className="cast-log-square">{name ? `${name} · ${coord}` : coord}</div>
                {outcome.note && <div className="cast-log-note" style={{ color: outcome.color }}>&ldquo;{outcome.note}&rdquo;</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
