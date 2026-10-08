import type { MatchRow } from "../../lib/tournament/api";
import { useT } from "../../lib/language";
import { TeamLabel } from "./TeamLogo";
import type { TeamPowerInfo } from "../../hooks/useTeamPowers";
import { MatchOdds } from "./PowerLine";

interface Props {
  /** The knockout matches only. */
  matches: MatchRow[];
  names: Map<string, string>;
  /** Logo addresses by team id, for the teams that have their own; the rest show the default. */
  logos?: Map<string, string>;
  /** Team power by team id: a match still to be played shows its line under the two teams. */
  powers?: Map<string, TeamPowerInfo> | null;
}

/**
 * A knockout drawn as columns of matches, one column per round, left to right.
 *
 * A double elimination is drawn as its brackets one under the other - winners, losers, then the grand
 * final - each with its own rounds. Drawn as rows of columns rather than as one tangle of connecting
 * lines because it stays readable at any field size and on a phone: it scrolls sideways within a bracket
 * instead of shrinking to nothing, and a team's path is followed by reading its row.
 */

const ORDER = ["W", "L", "GF", "TP"] as const;

export function BracketView({ matches, names, logos, powers }: Props) {
  const t = useT();
  const label: Record<string, string> = {
    W: t("Winners bracket", "Tableau des vainqueurs"),
    L: t("Losers bracket", "Tableau des perdants"),
    GF: t("Grand final", "Grande finale"),
    TP: t("Third place", "Troisième place"),
  };
  const hasLosers = matches.some((m) => m.bracket === "L");

  return (
    <div className="stack" style={{ gap: "1.2rem" }}>
      {ORDER.map((bracket) => {
        const inBracket = matches.filter((m) => m.bracket === bracket);
        if (inBracket.length === 0) return null;
        const rounds = [...new Set(inBracket.map((m) => m.round))].sort((a, b) => a - b);
        return (
          <div key={bracket}>
            {(hasLosers || bracket !== "W") && <div className="muted" style={{ marginBottom: "0.3rem" }}>{label[bracket]}</div>}
            <div style={{ display: "flex", gap: "1rem", overflowX: "auto", paddingBottom: "0.4rem", alignItems: "stretch" }}>
              {rounds.map((round) => (
                <div key={round} style={{ display: "flex", flexDirection: "column", justifyContent: "space-around", gap: "0.6rem", minWidth: "11.5rem" }}>
                  {inBracket
                    .filter((m) => m.round === round)
                    .sort((a, b) => a.idx - b.idx)
                    .map((m) => (
                      <Card key={m.id} match={m} names={names} logos={logos} powers={powers} />
                    ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Card({ match, names, logos, powers }: { match: MatchRow; names: Map<string, string>; logos?: Map<string, string>; powers?: Map<string, TeamPowerInfo> | null }) {
  const t = useT();
  const done = match.status === "done";
  const skipped = match.status === "skipped";
  const line = (id: string | null, score: number) => {
    const won = done && id !== null && match.winner === id;
    return (
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "nowrap", padding: "0.18rem 0.5rem", background: won ? "rgba(217, 164, 65, 0.16)" : undefined }}>
        {id ? (
          <TeamLabel name={names.get(id) ?? "?"} logo={logos?.get(id)} className={won ? "t-winner" : undefined} />
        ) : (
          // No team yet: a blank where the logo goes, not the default - the default means "a team with no logo".
          <TeamLabel name={<span className="muted">{t("TBD", "À déterminer")}</span>} logo={null} empty />
        )}
        <span className="t-score" style={{ minWidth: "1.5ch" }}>{done || match.status === "in_progress" ? score : ""}</span>
      </div>
    );
  };
  return (
    <div
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 6,
        background: "rgba(6, 22, 32, 0.6)",
        opacity: skipped ? 0.4 : 1,
        fontSize: "0.85rem",
      }}
    >
      {line(match.entrant_a, match.score_a)}
      <div style={{ borderTop: "1px solid rgba(30, 65, 87, 0.7)" }} />
      {line(match.entrant_b, match.score_b)}
      {powers && match.entrant_a && match.entrant_b && !done && !skipped && (
        <MatchOdds
          a={powers.get(match.entrant_a)}
          b={powers.get(match.entrant_b)}
          nameA={names.get(match.entrant_a) ?? "?"}
          nameB={names.get(match.entrant_b) ?? "?"}
          bestOf={match.best_of}
          compact
        />
      )}
      {(match.result_kind === "forfeit" || skipped) && (
        <div className="muted" style={{ fontSize: "0.65rem", padding: "0 0.5rem 0.15rem" }}>
          {skipped ? t("not needed", "inutile") : t("forfeit", "forfait")}
        </div>
      )}
    </div>
  );
}
