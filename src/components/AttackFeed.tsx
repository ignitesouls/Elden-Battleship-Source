import { cellLabel } from "../lib/battleshipLogic";
import { teamHex } from "../lib/teamColors";
import { groupIntoShots, outcomeText } from "../lib/attackFeed";
import { matchStartedAt, matchTimeAt, matchTimings } from "../lib/matchTime";
import type { Challenge } from "../lib/challenges";
import type { DeepMark, IgonEncounter } from "../lib/deepWater";
import type { Attack, Player, Room } from "../types/battleship";
import { useT } from "../lib/language";

interface Props {
  attacks: Attack[];
  players: Player[];
  boardSize: number;
  challenges: Challenge[];
  room?: Room | null;
  maxHeight?: number | string;
  /**
   * What has been found in the water, so those lines read as the finds they are rather than as misses.
   * Build it with `deepMarks`, which decides what this viewer may see - see lib/deepWater.ts.
   */
  deepCells?: ReadonlyMap<number, DeepMark>;
  /**
   * Every crew's dealings with Igon, so the line for the shot that killed Bayle can say so. Separate
   * from `deepCells` because it is the one find with something to say about a square it is not on -
   * see outcomeText.
   */
  igon?: readonly IgonEncounter[] | null;
}

export function AttackFeed({
  attacks,
  players,
  boardSize,
  challenges,
  room,
  maxHeight = "100%",
  deepCells,
  igon,
}: Props) {
  const t = useT();
  const shots = groupIntoShots(attacks, players);
  const startedAt = matchStartedAt(attacks);
  const timings = matchTimings(room);

// Shots can only land once MATCH begins, so this is elapsed MATCH time (matching the clock above
  // the board), not raw time since the STARTING countdown first kicked off - and it discounts any
  // pause, so the log and the clock cannot disagree. See matchTimeAt.
  const gameTimeAt = (iso: string) => matchTimeAt(startedAt, iso, timings, room);

  return (
    <div className="panel stack" style={{ width: "100%", flex: 1, minHeight: 0, gap: "0.4rem" }}>
      <h3 style={{ margin: 0 }}>{t("Battle Log", "Journal de bataille")}</h3>
      {/* On the scroller below: flex + minHeight 0 alongside maxHeight, because a percentage
          max-height only resolves against a parent with a definite height - on its own it silently
          does nothing in a flex column. The flex pair is what holds it to the space left over. */}
      {shots.length === 0 ? (
        <span className="muted" style={{ fontSize: "0.8rem" }}>{t("Nothing slain yet.", "Rien de tué pour l'instant.")}</span>
      ) : (
        <div
          className="stack"
          style={{ gap: "0.45rem", maxHeight, flex: 1, minHeight: 0, overflowY: "auto", fontSize: "0.82rem" }}
        >
          {shots.map((shot) => {
            const outcome = outcomeText(shot, deepCells, room, igon);
            const challenge = challenges[shot.cellIndex];
            return (
              <div key={shot.key} className="stack" style={{ gap: "0.05rem" }}>
                <div className="row" style={{ gap: "0.4rem", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ minWidth: 0, display: "flex", gap: "0.4rem", alignItems: "baseline" }}>
                    <span
                      className="muted"
                      style={{ fontSize: "0.68rem", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
                    >
                      {gameTimeAt(shot.at)}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ color: teamHex(shot.attackerTeam) }}>{shot.who}</strong>
                      <span className="muted"> {t("killed", "a tué")} </span>
                      <strong>{challenge?.name ?? cellLabel(shot.cellIndex, boardSize)}</strong>
                    </span>
                  </span>
                  <span style={{ color: outcome.color, whiteSpace: "nowrap", fontWeight: 600 }}>{outcome.text}</span>
                </div>
                {/* The message itself, under the outcome it belongs to. Its own line because the
                    longest of them is fifty characters and the outcome above is nowrap. */}
                {outcome.note && (
                  <span className="display" style={{ fontSize: "0.76rem", color: outcome.color, textAlign: "right" }}>
                    &ldquo;{outcome.note}&rdquo;
                  </span>
                )}
                {challenge && (
                  <span className="muted" style={{ fontSize: "0.72rem" }}>
                    {/* Objective squares mostly carry no tooltip, so the coordinate stands alone
                        rather than trailing an empty separator. */}
                    {challenge.tooltip ? `${challenge.tooltip} · ` : ""}
                    {cellLabel(shot.cellIndex, boardSize)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
