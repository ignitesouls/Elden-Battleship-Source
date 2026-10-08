import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchEvent,
  fetchEventConfig,
  fetchMatches,
  fetchStoredMatches,
  fetchTeams,
  teamLogos,
  type EventConfig,
  type EventDetail,
  type MatchRow,
  type TeamRow,
} from "../lib/tournament/api";
import { signupHeadline, signupIsOpen } from "../lib/tournament/frontPage";
import { squareSetLabel } from "../lib/squareSets";
import { qualifierStatus } from "../lib/tournament/stages";
import { groupLabel } from "../lib/tournament/groupNames";
import type { TMatch } from "../lib/tournament/types";
import { isSupabaseConfigured } from "../lib/supabase";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { useLanguage, useT } from "../lib/language";
import { LoadingScreen } from "../components/BrandMark";
import { SignupPanel } from "../components/event/SignupPanel";
import { MatchList } from "../components/event/MatchList";
import { BracketView } from "../components/event/BracketView";
import { StandingsTable } from "../components/event/StandingsTable";
import { TeamLabel } from "../components/event/TeamLogo";
import { EventLogo } from "../components/event/EventLogo";
import { JustForFun, PowerTag } from "../components/event/PowerLine";
import { useTeamPowers } from "../hooks/useTeamPowers";
import { useProfileBits } from "../hooks/useProfileBits";
import { NextMatchCard } from "../components/event/NextMatchCard";
import "../components/Tournament.css";

/** How often a running event is re-read, so results show up without a reload. */
const REFRESH_MS = 60_000;

/**
 * One tournament: the sign-up page while signup is open, then the schedule and results.
 *
 * The same page for the whole life of the event, so the link an organizer shares in Discord on day one
 * is still the right link on day thirty. What it shows follows the event's state:
 *   signup    the headline "Sign up for <name> now!", the ways to sign up, and who is in so far
 *   live      the schedule and results, by round
 *   finished  the champion, and the results
 *   cancelled a plain notice and the reason - the page still reads, but nothing else is on offer
 *
 * A draft does not exist as far as anyone but an administrator is concerned: the database will not
 * return it, so it and a made-up id look the same, and both get the same "no such event" page.
 */
export function Event() {
  const { id = "" } = useParams();
  const t = useT();
  const lang = useLanguage();
  const profile = useAuthProfile();
  const userId = profile?.isTwitch ? profile.userId : null;

  const [event, setEvent] = useState<EventDetail | null | undefined>(undefined);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  // The engine's view of the same matches plus the saved format, from which the standings are worked out.
  const [engine, setEngine] = useState<{ format: NonNullable<EventConfig["format"]>; matches: TMatch[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Re-read when the signed-in account changes as well: which teams are visible depends on who is
  // asking (a pending team is only visible to its own members).
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await fetchEvent(id);
        if (cancelled) return;
        setEvent(found);
        if (!found) return;
        const wantsMatches = found.status === "live" || found.status === "finished";
        const [teamRows, matchRows, config, stored] = await Promise.all([
          fetchTeams(id),
          wantsMatches ? fetchMatches(id) : Promise.resolve([]),
          wantsMatches ? fetchEventConfig(id) : Promise.resolve(null),
          wantsMatches ? fetchStoredMatches(id) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setTeams(teamRows);
        setMatches(matchRows);
        setEngine(config?.format && stored ? { format: config.format, matches: stored.matches } : null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, tick, userId]);

  // A running event is re-read now and then. Nothing is fetched while the tab is hidden.
  const live = event?.status === "live";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, reload]);

  // Standings for a Swiss or group qualifier, worked out by the same engine that decides who advances,
  // so the table a player reads is the table the knockout will be built from.
  const standings = useMemo(() => {
    if (!engine || engine.format.qualifier.format === "none") return null;
    const seededIds = teams
      .filter((team) => team.status === "approved")
      .sort((a, b) => (a.seed ?? Infinity) - (b.seed ?? Infinity))
      .map((team) => team.id);
    const gone = new Set(teams.filter((team) => team.forfeited_at).map((team) => team.id));
    const status = qualifierStatus(engine.format, seededIds, engine.matches, gone);
    const q = engine.format.qualifier;
    return {
      tables: status.tables,
      grouped: q.format === "groups",
      cut: engine.format.knockout ? (q.format === "groups" ? q.advancePerGroup : engine.format.knockout.cutTo) : undefined,
    };
  }, [engine, teams]);

  // Team power, for the team list and the lines on matches still to play. Approved teams only - the ones
  // in the event. Fetched again when a result comes in (the count of finished matches), not every refresh.
  const rosters = useMemo(
    () => new Map(teams.filter((team) => team.status === "approved").map((team) => [team.id, team.roster.map((m) => m.user_id)])),
    [teams],
  );
  const decided = matches.filter((m) => m.status === "done").length;
  const powers = useTeamPowers(event?.status === "cancelled" ? new Map() : rosters, decided);
  const showsPower = !!powers && powers.size > 0;
  // Avatars (an individual event's logos) and Twitch logins (the next-match card's streams link).
  const profileIds = useMemo(() => [...rosters.values()].flat(), [rosters]);
  const profiles = useProfileBits(profileIds);

  if (!isSupabaseConfigured) {
    return <div className="panel">{t("Supabase isn't configured.", "Supabase n'est pas configuré.")}</div>;
  }
  if (event === undefined && !error) return <LoadingScreen>{t("Loading the event...", "Chargement de l'événement...")}</LoadingScreen>;

  if (error && !event) {
    return (
      <div className="panel stack" style={{ width: "min(560px, 100%)" }}>
        <span className="error-text">{error}</span>
        <Link to="/">{t("Back to the harbor", "Retour au port")}</Link>
      </div>
    );
  }

  if (event === null) {
    return (
      <div className="panel stack" style={{ width: "min(560px, 100%)", alignItems: "center", textAlign: "center" }}>
        <p className="muted" style={{ margin: 0 }}>
          {t("There's no event here - it may not have opened yet.", "Il n'y a pas d'événement ici - il n'est peut-être pas encore ouvert.")}
        </p>
        <Link to="/">{t("Back to the harbor", "Retour au port")}</Link>
      </div>
    );
  }
  if (!event) return null;

  const open = signupIsOpen({ status: event.status, signupClosesAt: event.signup_closes_at }, new Date());
  const approved = teams.filter((team) => team.status === "approved");
  const names = new Map(teams.map((team) => [team.id, team.name]));
  // In an individual event each "team" is one player, shown with their Twitch avatar.
  const logos = teamLogos(teams, event.team_size === 1 ? profiles : undefined);
  const knockoutMatches = matches.filter((m) => m.stage === "knockout");
  const departedIds = new Set(teams.filter((team) => team.forfeited_at).map((team) => team.id));
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="stack" style={{ width: "min(720px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <EventLogo path={event.logo_path} size={8} className="event-logo--header" />
        <h1>{open ? signupHeadline(event.name, lang) : event.name}</h1>
        <div className="row" style={{ justifyContent: "center" }}>
          {event.is_test && <span className="badge badge--warn" title={t("Only administrators can see this event", "Seuls les administrateurs voient cet événement")}>{t("TEST", "TEST")}</span>}
          <StatusBadge event={event} open={open} />
          <span className="muted">
            {event.team_size === 1
              ? t("Individual event", "Événement individuel")
              : t(`Teams of ${event.team_size}`, `Équipes de ${event.team_size}`)}
          </span>
          {event.max_entrants && (
            <span className="muted">
              · {t(`up to ${event.max_entrants} ${event.team_size === 1 ? "players" : "teams"}`, `jusqu'à ${event.max_entrants} ${event.team_size === 1 ? "joueurs" : "équipes"}`)}
            </span>
          )}
          {/* The board every official match is played on, where the organisers fix one - worth knowing
              before signing up. Nothing when it is left to each match's host. */}
          {event.rules.square_set && <span className="muted">· {squareSetLabel(event.rules.square_set)}</span>}
          {event.rules.board_size && <span className="muted">· {`${event.rules.board_size}x${event.rules.board_size}`}</span>}
          {event.rules.fleet && (
            <span className="muted" title={event.rules.fleet.map((s) => `${s.name} (${s.size})`).join(" · ")}>
              · {t(`fleet of ${event.rules.fleet.length} ships`, `flotte de ${event.rules.fleet.length} navires`)}
            </span>
          )}
        </div>
        {event.description && <p className="muted" style={{ marginTop: "0.6rem" }}>{event.description}</p>}
        {event.status !== "cancelled" && (
          <p style={{ margin: "0.4rem 0" }}>
            <Link to={`/event/${event.id}/rules`} className="link-button">{t("Read the rules", "Lire le règlement")}</Link>
          </p>
        )}
        {open && event.signup_closes_at && (
          <p className="muted" style={{ margin: 0 }}>
            {t(`Signup closes ${day(event.signup_closes_at)}`, `Inscriptions jusqu'au ${day(event.signup_closes_at)}`)}
          </p>
        )}
      </div>

      {event.status === "cancelled" && (
        <div className="panel stack" style={{ borderColor: "var(--danger)" }}>
          <strong>{t("This event was cancelled.", "Cet événement a été annulé.")}</strong>
          {event.cancel_reason && <span>{event.cancel_reason}</span>}
        </div>
      )}

      {event.status === "finished" && (
        <div className="panel stack event-banner event-banner--finished" style={{ textAlign: "center" }}>
          <h3 style={{ margin: 0, border: "none" }}>
            {event.champion_name
              ? t(`Congratulations to ${event.champion_name}!`, `Félicitations à ${event.champion_name} !`)
              : t("This event has finished.", "Cet événement est terminé.")}
          </h3>
        </div>
      )}

      {event.status === "signup" && !open && (
        <div className="panel">
          <strong>{t("Signup has closed.", "Les inscriptions sont closes.")}</strong>{" "}
          <span className="muted">{t("The event will start soon.", "L'événement va bientôt commencer.")}</span>
        </div>
      )}

      {open && <SignupPanel event={event} teams={teams} profile={profile} reload={reload} />}

      {error && <div className="error-text">{error}</div>}

      {userId && (
        <NextMatchCard event={event} teams={teams} matches={matches} userId={userId} logos={logos} powers={powers} profiles={profiles} reload={reload} />
      )}

      {standings && standings.tables.length > 0 && (
        <div className="panel stack">
          <h3>{t("Standings", "Classement")}</h3>
          {standings.tables.map((rows, g) => (
            <StandingsTable
              key={g}
              rows={rows}
              names={names}
              logos={logos}
              departed={departedIds}
              cut={standings.cut}
              title={standings.grouped ? groupLabel(event.group_names, g, lang) : undefined}
            />
          ))}
          {standings.cut !== undefined && (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {t("The line marks where the knockout starts. A dot after a rank means the teams are level on every tiebreak.", "La ligne marque le début de l'élimination. Un point après un rang signifie une égalité sur tous les critères.")}
            </span>
          )}
        </div>
      )}

      {(event.status === "live" || event.status === "finished") && knockoutMatches.length > 0 && (
        <div className="panel stack">
          <h3>{t("Bracket", "Tableau")}</h3>
          <BracketView matches={knockoutMatches} names={names} logos={logos} powers={powers} />
        </div>
      )}

      {(event.status === "live" || event.status === "finished") && (
        <div className="panel stack">
          <h3>{t("Schedule and results", "Calendrier et résultats")}</h3>
          <MatchList matches={matches} names={names} groupNames={event.group_names} powers={powers} logos={logos} />
        </div>
      )}

      {event.status !== "cancelled" && (
        <div className="panel stack">
          <h3>
            {event.team_size === 1 ? t("Players", "Joueurs") : t("Teams", "Équipes")} ({approved.length}
            {event.max_entrants ? `/${event.max_entrants}` : ""})
          </h3>
          {approved.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {open
                ? t("Nobody has been approved yet - be the first.", "Personne n'a encore été approuvé - soyez le premier.")
                : t("No teams.", "Aucune équipe.")}
            </p>
          ) : (
            <div className="t-list">
              {approved.map((team) => (
                <div className="t-item" key={team.id}>
                  <span>
                    <strong><TeamLabel name={team.name} logo={logos.get(team.id)} size={1.6} /></strong>
                    {team.forfeited_at && <span className="badge badge--bad" style={{ marginLeft: "0.4rem" }}>{t("withdrawn", "retirée")}</span>}
                    <PowerTag info={powers?.get(team.id)} style={{ marginLeft: "0.5rem" }} />
                  </span>
                  {event.team_size > 1 && (
                    <span className="muted" style={{ fontSize: "0.8rem" }}>{team.roster.map((m) => m.display_name).join(", ")}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ textAlign: "center" }}>
        <Link to="/">{t("Back to the harbor", "Retour au port")}</Link>
        {showsPower && event.status !== "cancelled" && <JustForFun />}
      </div>
    </div>
  );
}

function StatusBadge({ event, open }: { event: EventDetail; open: boolean }) {
  const t = useT();
  if (event.status === "signup") {
    return open ? <span className="badge badge--good">{t("signup open", "inscriptions ouvertes")}</span> : <span className="badge badge--warn">{t("signup closed", "inscriptions closes")}</span>;
  }
  if (event.status === "live") return <span className="badge badge--warn">{t("underway", "en cours")}</span>;
  if (event.status === "finished") return <span className="badge badge--good">{t("finished", "terminé")}</span>;
  if (event.status === "cancelled") return <span className="badge badge--bad">{t("cancelled", "annulé")}</span>;
  return <span className="badge">{t("draft", "brouillon")}</span>;
}
