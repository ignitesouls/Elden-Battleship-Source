import { teamName, teamHex } from "../lib/teamColors";
import { paceLabel } from "../lib/squarePace";
import type { PlayerStats } from "../lib/matchReport";
import type { Player, ShipDefinition } from "../types/battleship";
import { useT } from "../lib/language";
import { HullStrip } from "./TeamBox";

interface Props {
  /** Fleets in the order they are drawn. A player's screen puts their own first. */
  teams: number[];
  players: Player[];
  /** From buildPlayerStats over the live attack log - one row per competitor. */
  stats: PlayerStats[];
  shipDefs: ShipDefinition[];
  /** One flag per hull in `shipDefs`, true where it is down. See TeamBox for why by position. */
  sunkHullsFor: (team: number) => boolean[];
  isEliminated: (team: number) => boolean;
  /** The viewer's own fleet, if they have one. Spectators have none. */
  myTeam?: number;
  myPlayerId?: string;
}

/**
 * Every competitor's live numbers in one panel: hits, misses, accuracy, pace.
 *
 * Replaces one bordered box per fleet with a single table the whole crew reads at a glance - the
 * question a roster gets asked mid-match is "who is hot", and that is a comparison, which a stack of
 * separate boxes makes you do by scrolling. The fleet header, hull strip and "afloat" count that the
 * boxes carried are kept under each team, because "they are down to a Destroyer" is still the other
 * thing this panel is read for.
 *
 * -- Rows never re-sort ------------------------------------------------------------------------
 *
 * Players stay in roster order. A leaderboard that reorders itself on every shot is unreadable while
 * it is happening - the row you were tracking jumps under your eyes - and the post-match scoreboard
 * exists to do the ranking once the shooting has stopped.
 *
 * -- Pace is a dash for anyone not on auto-fire ------------------------------------------------
 *
 * Deliberately, and it is the same dash the leaderboard shows: a pace needs at least five real gaps
 * between squares, and a gap only counts when both ends were auto-fired, since a clicked square is
 * stamped with the moment somebody clicked it. See lib/squarePace and buildPlayerStats.
 */
export function RosterScoreboard({
  teams,
  players,
  stats,
  shipDefs,
  sunkHullsFor,
  isEliminated,
  myTeam,
  myPlayerId,
}: Props) {
  const t = useT();
  const byPlayer = new Map<string, PlayerStats>();
  for (const s of stats) if (s.playerId) byPlayer.set(s.playerId, s);

  return (
    <div className="panel stack" style={{ width: "100%", gap: "0.55rem" }}>
      <div style={{ ...grid, ...head }}>
        <span />
        <span title={t("Shots that hit", "Tirs qui ont touché")}>{t("Hit", "Tou.")}</span>
        <span title={t("Shots that missed", "Tirs manqués")}>{t("Miss", "Raté")}</span>
        <span title={t("Hits out of shots fired", "Touchés sur tirs effectués")}>{t("Acc", "Préc.")}</span>
        <span
          title={t(
            "Typical time per square (median). Needs 5 auto-fired squares, so a dash until then.",
            "Temps typique par case (médiane). Demande 5 cases marquées automatiquement, donc un tiret d'ici là."
          )}
        >
          {t("Pace", "Rythme")}
        </span>
      </div>

      {teams.map((team) => {
        const members = players.filter((p) => p.team === team);
        const sunkHulls = sunkHullsFor(team);
        const afloat = shipDefs.filter((_, i) => !sunkHulls[i]).length;
        const mine = team === myTeam;

        return (
          <section
            key={team}
            className="stack"
            style={{ gap: "0.2rem", borderLeft: `3px solid ${teamHex(team)}`, paddingLeft: "0.5rem" }}
          >
            <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
              <strong style={{ color: teamHex(team), fontSize: "0.85rem" }}>
                {teamName(team)}
                {mine && <span className="badge" style={{ marginLeft: "0.35rem" }}>{t("you", "vous")}</span>}
              </strong>
              {isEliminated(team) ? (
                <span className="badge">{t("eliminated", "éliminé")}</span>
              ) : (
                <span className="muted" style={{ fontSize: "0.72rem" }}>
                  {afloat}/{shipDefs.length} {t("afloat", "à flot")}
                </span>
              )}
            </div>

            {members.length === 0 && <span className="muted" style={{ fontSize: "0.78rem" }}>{t("empty", "vide")}</span>}
            {members.map((p) => {
              const s = byPlayer.get(p.id);
              const shots = s?.shots ?? 0;
              return (
                <div key={p.id} style={{ ...grid, fontSize: "0.78rem", color: shots === 0 ? "var(--text-dim)" : undefined }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                    {p.nickname}
                    {p.is_host && <span className="badge" style={{ marginLeft: "0.3rem" }}>{t("host", "hôte")}</span>}
                    {p.id === myPlayerId && !mine && (
                      <span className="badge" style={{ marginLeft: "0.3rem" }}>{t("you", "vous")}</span>
                    )}
                  </span>
                  <span>{s?.hits ?? 0}</span>
                  <span>{s?.misses ?? 0}</span>
                  <span>{shots > 0 ? `${Math.round((s?.accuracy ?? 0) * 100)}%` : "-"}</span>
                  <span>{s?.pace != null ? paceLabel(s.pace) : "-"}</span>
                </div>
              );
            })}

            <HullStrip shipDefs={shipDefs} sunkHulls={sunkHulls} />
          </section>
        );
      })}
    </div>
  );
}

/**
 * One row's columns. Fixed widths rather than `auto`, because every row is its own grid and `auto`
 * would size each one to its own contents - the numbers would drift out from under their headings
 * from one player to the next.
 */
const grid = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 1.9rem 1.9rem 2.5rem 2.9rem",
  columnGap: "0.3rem",
  alignItems: "baseline",
  fontVariantNumeric: "tabular-nums",
  // Everything but the name is a number, and numbers line up on their right edge.
  textAlign: "right",
} as const;

const head = {
  fontSize: "0.66rem",
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
} as const;
