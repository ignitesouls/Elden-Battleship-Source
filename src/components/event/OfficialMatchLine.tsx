import { useMemo } from "react";
import type { OfficialMatchInfo } from "../../lib/tournament/api";
import { useTeamPowers } from "../../hooks/useTeamPowers";
import { useT } from "../../lib/language";
import { MatchOdds } from "./PowerLine";

/**
 * The line on an official match, for the room it is played in: the lobby's official-match panel, and the
 * odds overlay on stream. The pre-match line, not a live one - the overlay's in-match odds take over once
 * shots land, and they are the better number by then (see lib/victoryOdds).
 *
 * Says "just for fun" in its own small print, because a room or a stream has no event-page footer.
 */
export function OfficialMatchLine({ info, small = false }: { info: OfficialMatchInfo | null; small?: boolean }) {
  const t = useT();
  const rosters = useMemo(
    () => (info ? new Map([["a", info.rosterA], ["b", info.rosterB]]) : new Map<string, string[]>()),
    [info],
  );
  const powers = useTeamPowers(rosters, info ? `${info.scoreA}-${info.scoreB}` : "");
  if (!info || !powers) return null;
  const a = powers.get("a");
  const b = powers.get("b");
  if (!a || !b || (a.rated === 0 && b.rated === 0)) return null;
  return (
    <div className="stack" style={{ gap: "0.15rem", alignItems: "center", fontSize: small ? "0.85em" : undefined }}>
      <MatchOdds a={a} b={b} nameA={info.teamA} nameB={info.teamB} bestOf={info.bestOf} />
      <span className="muted" style={{ fontSize: "0.65rem" }}>
        {t("* The line is just for fun - Elden Battleship is not about real gambling.", "* La cote est juste pour le plaisir - Elden Battleship n'a rien à voir avec les vrais paris.")}
      </span>
    </div>
  );
}
