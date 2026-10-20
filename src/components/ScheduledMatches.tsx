import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchScheduledMatches, multitwitchUrl, requestCast, teamLogoUrl, withdrawCast, type ScheduledMatch } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";
import { useLanguage, useT } from "../lib/language";
import { groupLabel } from "../lib/tournament/groupNames";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { CasterLinks } from "./event/CasterLinks";
import { PlayerName, TeamLabel } from "./event/TeamLogo";
import "./Tournament.css";

// The tale of the tape lives with its own page; the front page only fetches that code when a card is opened.
const MatchupTapeInline = lazy(() => import("../pages/TaleOfTheTape").then((m) => ({ default: m.MatchupTapeInline })));

/** Polled gently: a time agreed a minute ago can wait two to appear, and the front page is busy. */
const REFRESH_MS = 120_000;

/**
 * The front page's "Tournament matches": every official match a pair of captains has put a time on, and
 * every one being played right now, across all running events - with the ways to watch it.
 *
 *   Watch        the official room itself, as a spectator (only once the room exists).
 *   Multitwitch  every player on both teams streaming side by side.
 *   Official cast  each caster an administrator approved, their own Twitch.
 *   Tale of the tape  opens under the card - the event's data is read only then, and only while open.
 *
 * Anyone signed in with Twitch can ask to cast a match from its card; an administrator approves it on the
 * event desk. The card says where their request stands and lets them withdraw it.
 *
 * One request (scheduled_official_matches) per look, and nothing at all while the tab is hidden. Renders
 * nothing when there is nothing scheduled - most days, between events.
 */
export function ScheduledMatches() {
  const t = useT();
  const lang = useLanguage();
  const me = useAuthProfile();
  const [rows, setRows] = useState<ScheduledMatch[]>([]);
  // One card open at a time: each open tape re-reads its event every minute.
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [castError, setCastError] = useState<{ match: string; message: string } | null>(null);

  const read = useCallback(() => {
    if (!isSupabaseConfigured || document.visibilityState !== "visible") return Promise.resolve();
    return fetchScheduledMatches()
      .then(setRows)
      .catch(() => undefined); // a front page must never fail over an extra
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    const tick = () => void read();
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
    // Re-read when the account changes: my_cast is the reader's own.
  }, [read, me?.userId]);

  /** Asks to cast, or withdraws; the server's refusal is shown under the card in its own words. */
  async function cast(m: ScheduledMatch, action: (matchId: string) => Promise<void>) {
    setBusy(m.match_id);
    setCastError(null);
    try {
      await action(m.match_id);
    } catch (e) {
      setCastError({ match: m.match_id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      await read();
      setBusy(null);
    }
  }

  if (rows.length === 0) return null;

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const stage = (m: ScheduledMatch) =>
    m.stage === "group"
      ? m.grp !== null && m.grp !== undefined ? m.group_name || groupLabel([], m.grp, lang) : t("Groups", "Poules")
      : m.stage === "swiss" ? t("Swiss", "Suisse") : t("Knockout", "Élimination");
  // The team's series won - lost in the event so far, under its name.
  const record = (won: number | undefined, lost: number | undefined) =>
    typeof won === "number" && typeof lost === "number" ? (
      <span className="muted" style={{ fontSize: "0.75rem" }} title={t("Series won - lost in this event", "Séries gagnées - perdues dans cet événement")}>
        {won} - {lost}
      </span>
    ) : null;
  const logo = (m: ScheduledMatch, side: "a" | "b") =>
    m.team_size === 1 ? (side === "a" ? m.team_a_avatar : m.team_b_avatar) : teamLogoUrl(side === "a" ? m.team_a_logo : m.team_b_logo);
  // In an individual event the side's name is its one player's, so it opens their Twitch.
  const solo = (m: ScheduledMatch, side: "a" | "b") => (m.team_size === 1 ? (side === "a" ? m.streams_a : m.streams_b)[0] : null);
  // Players can't cast their own match (request_cast refuses). The account's Twitch display name is its
  // login in another case, near enough to hide the button from them; the server's rule is the real one.
  const myName = me?.displayName?.toLowerCase();
  const plays = (m: ScheduledMatch) => !!myName && [...m.streams_a, ...m.streams_b].some((l) => l.toLowerCase() === myName);

  return (
    <div className="panel stack" style={{ gap: "0.5rem" }}>
      <h3 style={{ margin: 0 }}>{t("Tournament matches", "Matchs de tournoi")}</h3>
      <div className="t-list">
        {rows.map((m) => {
          const live = !!m.room_code;
          const streams = multitwitchUrl(m.streams_a, m.streams_b);
          return (
            <div key={m.match_id} className="stack scheduled-match" style={{ gap: "0.3rem", padding: "0.5rem 0" }}>
              <Link to={`/event/${m.tournament_id}`} className="muted" style={{ alignSelf: "center", fontSize: "0.8rem" }}>
                {m.event_name} · {stage(m)} · {t("Round", "Tour")} {m.phase}
              </Link>
              <div className="row" style={{ justifyContent: "center", alignItems: "flex-start", gap: "0.6rem", flexWrap: "wrap" }}>
                <div className="stack" style={{ alignItems: "center", gap: "0.1rem" }}>
                  <TeamLabel name={<strong><PlayerName name={m.team_a_name} login={solo(m, "a")} /></strong>} logo={logo(m, "a")} size={1.5} />
                  {record(m.won_a, m.lost_a)}
                </div>
                <span className="muted" style={{ lineHeight: "1.5rem" }}>{live && m.best_of > 1 ? `${m.score_a} - ${m.score_b}` : t("vs", "contre")}</span>
                <div className="stack" style={{ alignItems: "center", gap: "0.1rem" }}>
                  <TeamLabel name={<strong><PlayerName name={m.team_b_name} login={solo(m, "b")} /></strong>} logo={logo(m, "b")} size={1.5} />
                  {record(m.won_b, m.lost_b)}
                </div>
              </div>
              <div className="row" style={{ justifyContent: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
                {live ? (
                  <span className="badge badge--good">{t("live now", "en direct")}</span>
                ) : (
                  m.agreed_at && <strong>{when(m.agreed_at)}</strong>
                )}
              </div>
              {(live || streams || m.casters?.length > 0) && (
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
                  <CasterLinks casters={m.casters ?? []} style={{ fontSize: "0.82rem" }} />
                </div>
              )}
              {me?.isTwitch && !plays(m) && (
                <div className="row" style={{ justifyContent: "center", gap: "0.5rem", fontSize: "0.78rem" }}>
                  {m.my_cast === "pending" || m.my_cast === "approved" ? (
                    <>
                      <span className="muted">
                        {m.my_cast === "pending"
                          ? t("You asked to cast this - waiting for an administrator.", "Vous avez demandé à commenter ce match - en attente d'un administrateur.")
                          : t("You're an official caster for this match.", "Vous êtes commentateur officiel de ce match.")}
                      </span>
                      <button type="button" className="link-button" style={{ fontSize: "0.78rem" }} disabled={busy === m.match_id} onClick={() => void cast(m, withdrawCast)}>
                        {t("Withdraw", "Retirer")}
                      </button>
                    </>
                  ) : m.my_cast === "declined" ? (
                    <span className="muted">{t("An administrator turned down your cast for this match.", "Un administrateur a refusé votre commentaire pour ce match.")}</span>
                  ) : (
                    <button type="button" className="link-button" style={{ fontSize: "0.78rem" }} disabled={busy === m.match_id} onClick={() => void cast(m, requestCast)}>
                      🎙 {t("Ask to cast this match", "Demander à commenter ce match")}
                    </button>
                  )}
                </div>
              )}
              {castError?.match === m.match_id && (
                <span className="error-text" style={{ alignSelf: "center", fontSize: "0.78rem" }}>{castError.message}</span>
              )}
              <button
                type="button"
                className="link-button"
                style={{ alignSelf: "center", fontSize: "0.82rem" }}
                aria-expanded={open === m.match_id}
                onClick={() => setOpen(open === m.match_id ? null : m.match_id)}
              >
                {open === m.match_id ? t("Hide the tale of the tape ▴", "Masquer la fiche du combat ▴") : t("Tale of the tape ▾", "Fiche du combat ▾")}
              </button>
              {open === m.match_id && (
                <Suspense fallback={<p className="muted" style={{ margin: 0, textAlign: "center", fontSize: "0.85rem" }}>{t("Unrolling the tape...", "On déroule le ruban...")}</p>}>
                  <MatchupTapeInline eventId={m.tournament_id} a={m.team_a} b={m.team_b} />
                </Suspense>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
