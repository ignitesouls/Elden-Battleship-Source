import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchEntryCode,
  multitwitchUrl,
  setMatchTime,
  type EventDetail,
  type MatchRow,
  type PlayerProfileBits,
  type TeamRow,
} from "../../lib/tournament/api";
import { fromLocalInput, toLocalInput } from "../../lib/tournament/localTime";
import { groupLabel } from "../../lib/tournament/groupNames";
import type { TeamPowerInfo } from "../../hooks/useTeamPowers";
import { useLanguage, useT } from "../../lib/language";
import { TeamLabel } from "./TeamLogo";
import { MatchOdds } from "./PowerLine";

interface Props {
  event: EventDetail;
  teams: TeamRow[];
  matches: MatchRow[];
  userId: string;
  logos: Map<string, string>;
  powers: Map<string, TeamPowerInfo> | null;
  profiles: Map<string, PlayerProfileBits>;
  reload: () => void;
}

/**
 * "Your next match": for a player on a team in a running event, at the top of the event page.
 *
 * Everything they need for the one match that is theirs to play next - who, by when, the line, both
 * teams' streams - and, for the captain, the two things only they can do: set the time the teams have
 * agreed (which then shows on the front page for anyone to watch), and see the entry code that makes a
 * room official. The code used to be shown only while signup was open; this is where it lives once the
 * event is running.
 *
 * What a captain may set is the database's rule (set_match_time): their own match, while it is waiting
 * to be played, inside the round's window. A refusal comes back in its own words.
 */
export function NextMatchCard({ event, teams, matches, userId, logos, powers, profiles, reload }: Props) {
  const t = useT();
  const lang = useLanguage();
  const mine = teams.find((team) => team.status === "approved" && !team.forfeited_at && team.roster.some((m) => m.user_id === userId));
  const isCaptain = mine?.captain_user_id === userId;

  // The match to play next: one waiting to be played (or under way), earliest first; failing that, the
  // next one whose opponent is not decided yet.
  const ours = mine ? matches.filter((m) => m.entrant_a === mine.id || m.entrant_b === mine.id) : [];
  const order = (a: MatchRow, b: MatchRow) => (a.phase ?? a.round) - (b.phase ?? b.round) || a.idx - b.idx;
  const next =
    ours.filter((m) => m.status === "ready" || m.status === "in_progress").sort(order)[0] ??
    ours.filter((m) => m.status === "pending").sort(order)[0] ??
    null;

  const [code, setCode] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mine || !isCaptain) return;
    let cancelled = false;
    fetchEntryCode(mine.id).then((c) => !cancelled && setCode(c)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mine?.id, isCaptain]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setValue(toLocalInput(next?.agreed_at)), [next?.id, next?.agreed_at]);

  if (!mine || event.status !== "live") return null;

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });

  if (!next) {
    return (
      <div className="panel stack next-match">
        <h3 style={{ margin: 0 }}>{t("Your next match", "Votre prochain match")}</h3>
        <span className="muted">
          {t("Nothing waiting for you right now - the next round hasn't been drawn, or your run in this event is over.", "Rien ne vous attend pour l'instant - le tour suivant n'est pas encore tiré, ou votre parcours est terminé.")}
        </span>
      </div>
    );
  }

  const weAreA = next.entrant_a === mine.id;
  const theirId = weAreA ? next.entrant_b : next.entrant_a;
  const them = theirId ? teams.find((team) => team.id === theirId) : undefined;
  const stage =
    next.stage === "group"
      ? next.grp !== null
        ? groupLabel(event.group_names, next.grp, lang)
        : t("Groups", "Poules")
      : next.stage === "swiss"
        ? t("Swiss", "Suisse")
        : t("Knockout", "Élimination");
  const streams = multitwitchUrl([...mine.roster, ...(them?.roster ?? [])].map((m) => profiles.get(m.user_id)?.twitch_login));
  const playable = next.status === "ready" || next.status === "in_progress";

  async function saveTime(iso: string | null) {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await setMatchTime(next.id, iso);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack next-match">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>{t("Your next match", "Votre prochain match")}</h3>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {stage} · {t("Round", "Tour")} {next.phase ?? next.round}
          {next.best_of > 1 && ` · ${t(`best of ${next.best_of}`, `au meilleur de ${next.best_of}`)}`}
        </span>
      </div>

      <div className="next-match__teams">
        <TeamLabel name={<strong>{mine.name}</strong>} logo={logos.get(mine.id)} size={2.2} />
        <span className="muted">
          {next.status === "in_progress" ? `${weAreA ? next.score_a : next.score_b} - ${weAreA ? next.score_b : next.score_a}` : t("vs", "contre")}
        </span>
        {them ? (
          <TeamLabel name={<strong>{them.name}</strong>} logo={logos.get(them.id)} size={2.2} />
        ) : (
          <span className="muted">{t("opponent not decided yet", "adversaire pas encore connu")}</span>
        )}
      </div>

      {them && powers && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <MatchOdds a={powers.get(mine.id)} b={powers.get(them.id)} nameA={mine.name} nameB={them.name} bestOf={next.best_of} />
        </div>
      )}

      {playable && (
        <div className="stack" style={{ gap: "0.35rem" }}>
          <span>
            {next.agreed_at ? (
              <>
                {t("Playing", "Match prévu")} <strong>{when(next.agreed_at)}</strong>
              </>
            ) : (
              <span className="muted">{t("No time agreed yet.", "Pas encore d'heure convenue.")}</span>
            )}
            {next.due_at && <span className="muted"> · {t("due by", "à jouer avant le")} {day(next.due_at)}</span>}
          </span>

          {isCaptain ? (
            <div className="stack" style={{ gap: "0.3rem" }}>
              <div className="row" style={{ gap: "0.4rem" }}>
                <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t("Agreed match time", "Heure convenue")} />
                <button className="primary" disabled={busy || !value || value === toLocalInput(next.agreed_at)} onClick={() => void saveTime(fromLocalInput(value))}>
                  {next.agreed_at ? t("Change time", "Changer l'heure") : t("Set the time", "Fixer l'heure")}
                </button>
                {next.agreed_at && (
                  <button disabled={busy} onClick={() => void saveTime(null)}>
                    {t("Clear", "Effacer")}
                  </button>
                )}
              </div>
              <span className="muted" style={{ fontSize: "0.75rem" }}>
                {t(
                  "Agree the time with the other captain first. Once set, it shows on the front page so anyone can come and watch.",
                  "Convenez d'abord de l'heure avec l'autre capitaine. Une fois fixée, elle s'affiche en page d'accueil pour que chacun puisse venir regarder.",
                )}
              </span>
              {error && <span className="error-text">{error}</span>}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: "0.8rem" }}>{t("Your captain sets the match time.", "Votre capitaine fixe l'heure du match.")}</span>
          )}
        </div>
      )}

      {playable && (
        <div className="stack" style={{ gap: "0.3rem" }}>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {t(
              "To play: one of you creates a room, then picks \"Make this an official match\" in the lobby with your team's entry code; the other team confirms with theirs.",
              "Pour jouer : l'un de vous crée une partie, puis choisit « Faire de ceci un match officiel » dans le salon avec le code d'entrée de votre équipe ; l'autre équipe confirme avec le sien.",
            )}
          </span>
          <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
            <Link to="/" className="link-button">{t("Create a room", "Créer une partie")}</Link>
            {isCaptain && code && (
              <span>
                <span className="muted" style={{ fontSize: "0.75rem" }}>{t("your entry code", "votre code d'entrée")} </span>
                <span className="entry-code" style={{ fontSize: "1rem" }}>{code}</span>
              </span>
            )}
            {streams && (
              <a href={streams} target="_blank" rel="noreferrer" className="link-button">
                {t("Both teams' streams (Multitwitch)", "Les streams des deux équipes (Multitwitch)")}
              </a>
            )}
          </div>
          {isCaptain && code && (
            <span className="muted" style={{ fontSize: "0.72rem" }}>{t("Keep the code off stream.", "Gardez le code hors du stream.")}</span>
          )}
        </div>
      )}
    </div>
  );
}
