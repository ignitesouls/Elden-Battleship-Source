import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchOfficialLeaderboard, officialStatsEnabled, type OfficialRecordRow } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";
import { useT } from "../lib/language";
import "./Tournament.css";

/**
 * The Official record: wins and games in official tournament matches, kept apart from the ordinary
 * leaderboard because an official match is a different kind of game - a real bracket match, between
 * rostered teams - and folding it into the everyday numbers would blur both.
 *
 * It does not exist until the first tournament has gone live. Before that the leaderboard is exactly
 * what it has always been, with no empty "Official" heading and no mention of a feature nobody has
 * seen. After that it stays, even if that tournament is later cancelled: official games count for good,
 * so the place they are counted cannot come and go with the event.
 *
 * Reads never break the page - if the tournament tables aren't there yet, or the read fails, this
 * simply renders nothing.
 */
export function OfficialRecord() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<OfficialRecordRow[] | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    void (async () => {
      const on = await officialStatsEnabled();
      if (cancelled || !on) return;
      setEnabled(true);
      try {
        const data = await fetchOfficialLeaderboard();
        if (!cancelled) setRows(data);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) return null;

  return (
    <div className="panel stack" style={{ borderColor: "rgba(217, 164, 65, 0.55)" }}>
      <h3>{t("Official record", "Palmarès officiel")}</h3>
      <span className="muted" style={{ fontSize: "0.78rem" }}>
        {t("Wins in official tournament matches only.", "Victoires en matchs officiels de tournoi uniquement.")}
      </span>
      {rows === null ? (
        <span className="muted">{t("Loading...", "Chargement...")}</span>
      ) : rows.length === 0 ? (
        <span className="muted">{t("No official matches have been played yet.", "Aucun match officiel n'a encore été joué.")}</span>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr className="muted" style={{ textAlign: "left", fontSize: "0.72rem" }}>
              <th style={{ padding: "0.2rem 0.4rem" }}>#</th>
              <th>{t("Player", "Joueur")}</th>
              <th>{t("Wins", "Victoires")}</th>
              <th>{t("Played", "Jouées")}</th>
              <th>{t("Win rate", "Taux")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.player_key} style={{ borderTop: "1px solid rgba(30, 65, 87, 0.7)" }}>
                <td style={{ padding: "0.35rem 0.4rem", color: "var(--accent-bright)", fontWeight: 600 }}>{index + 1}</td>
                <td>
                  {/^[0-9a-f-]{36}$/.test(row.player_key) ? <Link to={`/player/${encodeURIComponent(row.player_key)}`}>{row.display_name}</Link> : row.display_name}
                </td>
                <td>{row.wins}</td>
                <td>{row.played}</td>
                <td>{row.played > 0 ? `${Math.round((row.wins / row.played) * 100)}%` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
