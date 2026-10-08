import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchScheduledMatches, multitwitchUrl, teamLogoUrl, type ScheduledMatch } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";
import { useLanguage, useT } from "../lib/language";
import { TeamLabel } from "./event/TeamLogo";
import "./Tournament.css";

/** Polled gently: a time agreed a minute ago can wait two to appear, and the front page is busy. */
const REFRESH_MS = 120_000;

/**
 * The front page's "Tournament matches": every official match a pair of captains has put a time on, and
 * every one being played right now, across all running events - with the ways to watch it.
 *
 *   Watch        the official room itself, as a spectator (only once the room exists).
 *   Multitwitch  every player on both teams streaming side by side.
 *
 * One request (scheduled_official_matches) per look, and nothing at all while the tab is hidden. Renders
 * nothing when there is nothing scheduled - most days, between events.
 */
export function ScheduledMatches() {
  const t = useT();
  const lang = useLanguage();
  const [rows, setRows] = useState<ScheduledMatch[]>([]);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      fetchScheduledMatches()
        .then((found) => !cancelled && setRows(found))
        .catch(() => undefined); // a front page must never fail over an extra
    };
    read();
    const timer = setInterval(read, REFRESH_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);

  if (rows.length === 0) return null;

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const stage = (m: ScheduledMatch) =>
    m.stage === "group" ? t("Groups", "Poules") : m.stage === "swiss" ? t("Swiss", "Suisse") : t("Knockout", "Élimination");
  const logo = (m: ScheduledMatch, side: "a" | "b") =>
    m.team_size === 1 ? (side === "a" ? m.team_a_avatar : m.team_b_avatar) : teamLogoUrl(side === "a" ? m.team_a_logo : m.team_b_logo);

  return (
    <div className="panel stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>{t("Tournament matches", "Matchs de tournoi")}</h3>
        <span className="muted" style={{ fontSize: "0.7rem" }}>{t("Scheduled by the captains", "Programmés par les capitaines")}</span>
      </div>
      <div className="t-list">
        {rows.map((m) => {
          const live = !!m.room_code;
          const streams = multitwitchUrl([...m.streams_a, ...m.streams_b]);
          return (
            <div key={m.match_id} className="stack scheduled-match" style={{ gap: "0.3rem", padding: "0.5rem 0" }}>
              <div className="row" style={{ justifyContent: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                <TeamLabel name={<strong>{m.team_a_name}</strong>} logo={logo(m, "a")} size={1.5} />
                <span className="muted">{live && m.best_of > 1 ? `${m.score_a} - ${m.score_b}` : t("vs", "contre")}</span>
                <TeamLabel name={<strong>{m.team_b_name}</strong>} logo={logo(m, "b")} size={1.5} />
              </div>
              <div className="row" style={{ justifyContent: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
                {live ? (
                  <span className="badge badge--good">{t("live now", "en direct")}</span>
                ) : (
                  m.agreed_at && <strong>{when(m.agreed_at)}</strong>
                )}
                <Link to={`/event/${m.tournament_id}`} className="muted">
                  {m.event_name} · {stage(m)} {t("round", "tour")} {m.phase}
                </Link>
              </div>
              {(live || streams) && (
                <div className="row" style={{ justifyContent: "center", gap: "0.5rem" }}>
                  {live && (
                    // ?spectate=1, like the front page's "Current battles" and the lobby's spectator link: the
                    // seats belong to the two rosters, so a visitor comes in to watch.
                    <Link to={`/room/${m.room_code}?spectate=1`} className="link-button primary" style={{ fontSize: "0.82rem" }}>
                      {t("Watch the match", "Regarder le match")}
                    </Link>
                  )}
                  {streams && (
                    <a href={streams} target="_blank" rel="noreferrer" className="link-button" style={{ fontSize: "0.82rem" }}>
                      {t("Players' streams (Multitwitch)", "Streams des joueurs (Multitwitch)")}
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
