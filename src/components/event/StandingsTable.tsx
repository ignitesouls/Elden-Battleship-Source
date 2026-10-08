import type { StandingRow } from "../../lib/tournament/standings";
import { useT } from "../../lib/language";
import { TeamLabel } from "./TeamLogo";

interface Props {
  rows: StandingRow[];
  names: Map<string, string>;
  /** Logo addresses by team id, for the teams that have their own; the rest show the default. */
  logos?: Map<string, string>;
  /** Draw a line under this many rows: the teams that go through to the knockout. */
  cut?: number;
  /** Ids of teams an administrator has removed - shown, but marked. */
  departed?: ReadonlySet<string>;
  title?: string;
}

/**
 * A qualifier table: rank, record, game difference, and Buchholz (how strong the opposition was).
 *
 * The rank is the strict order the tiebreaks produce. Where two rows are level on everything, the order
 * between them was decided by original seed alone and is marked with a dot, so nobody reads a coin flip
 * as a verdict - and so an administrator can see, before building the knockout, exactly where that is.
 */
export function StandingsTable({ rows, names, logos, cut, departed, title }: Props) {
  const t = useT();
  if (rows.length === 0) return null;

  return (
    <div>
      {title && <div className="muted" style={{ marginBottom: "0.2rem" }}>{title}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
        <thead>
          <tr className="muted" style={{ textAlign: "left", fontSize: "0.72rem" }}>
            <th style={{ padding: "0.2rem 0.4rem" }}>#</th>
            <th>{t("Team", "Équipe")}</th>
            <th title={t("Wins", "Victoires")}>{t("W", "V")}</th>
            <th title={t("Losses", "Défaites")}>{t("L", "D")}</th>
            <th title={t("Games won minus games lost", "Manches gagnées moins perdues")}>{t("Diff", "Diff")}</th>
            <th title={t("Total wins of the teams they played", "Total des victoires des équipes affrontées")}>{t("Opp.", "Adv.")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.id}
              style={{
                borderTop: cut !== undefined && index === cut ? "2px solid var(--accent)" : "1px solid rgba(30, 65, 87, 0.7)",
                opacity: departed?.has(row.id) ? 0.55 : 1,
              }}
            >
              <td style={{ padding: "0.35rem 0.4rem", color: index < (cut ?? 0) ? "var(--accent-bright)" : undefined, fontWeight: 600 }}>
                {row.rank}
                {row.tied && <span title={t("Level on every tiebreak - ordered by seed", "À égalité sur tous les critères - classé selon la tête de série")}> ·</span>}
              </td>
              <td>
                <TeamLabel name={names.get(row.id) ?? "?"} logo={logos?.get(row.id)} />
                {departed?.has(row.id) && <span className="badge badge--bad" style={{ marginLeft: "0.4rem" }}>{t("withdrawn", "retirée")}</span>}
              </td>
              <td>{row.wins}</td>
              <td>{row.losses}</td>
              <td>{row.gameDiff > 0 ? `+${row.gameDiff}` : row.gameDiff}</td>
              <td>{row.buchholz}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
