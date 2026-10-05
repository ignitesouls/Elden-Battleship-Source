import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  adminFreeAgents,
  adminTeams,
  fetchEvent,
  fetchMatchSettings,
  saveMatchSettings,
  startEvent,
  type AdminTeamRow,
  type EventDetail,
  type MatchRow,
} from "../../lib/tournament/api";
import { effectiveCut, estimateMatches, suggestFormat, validateFormat, type TournamentFormat } from "../../lib/tournament/format";
import { scheduleShape, suggestSchedule, type Schedule } from "../../lib/tournament/schedule";
import { planStart } from "../../lib/tournament/start";
import type { TMatch } from "../../lib/tournament/types";
import { useT } from "../../lib/language";
import { LoadingScreen } from "../BrandMark";
import { MatchList } from "../event/MatchList";
import { FormatEditor } from "./FormatEditor";
import { DEFAULT_MATCH_RULES, rulesFrom, rulesProblem, toMatchSettings, type MatchRules } from "../../lib/tournament/matchRules";
import { MatchRulesEditor, SET_CAPS } from "./MatchRulesEditor";
import { ScheduleEditor } from "./ScheduleEditor";
import { SeedList } from "./SeedList";
import "../Tournament.css";

/** The next whole hour: a sensible default for "when does round 1 open" that is not in the past. */
function nextHour(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

/** A drawn match as the list the event page shows, so the preview looks like what players will see. */
function previewRow(m: TMatch): MatchRow {
  return {
    id: m.key, key: m.key, stage: m.stage, bracket: m.bracket, grp: m.group, round: m.round, phase: m.phase, idx: m.index,
    entrant_a: m.a, entrant_b: m.b, best_of: m.bestOf, score_a: m.scoreA, score_b: m.scoreB, status: m.status,
    winner: m.winner, result_kind: m.resultKind, opens_at: m.opensAt, due_at: m.dueAt, agreed_at: null,
  };
}

/**
 * The start page: turn a signup into a running event.
 *
 * This is mounted only for an administrator (see pages/AdminStartEvent) and nothing here is fetched
 * before that - but the page is not what keeps anyone else out. Starting is one database function,
 * start_tournament, that checks for an administrator itself and either does everything or nothing.
 *
 * What it shows is exactly what will happen: the teams in seed order, the format, the schedule, and the
 * first stage's matches as they will be drawn. Nothing is written until the button is pressed.
 */
export function StartEventForm({ eventId }: { eventId: string }) {
  const t = useT();
  const navigate = useNavigate();

  const [event, setEvent] = useState<EventDetail | null | undefined>(undefined);
  const [teams, setTeams] = useState<AdminTeamRow[]>([]);
  const [soloWaiting, setSoloWaiting] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The three things the administrator decides.
  const [order, setOrder] = useState<AdminTeamRow[]>([]);
  const [format, setFormat] = useState<TournamentFormat | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [fitDays, setFitDays] = useState(28);
  const [rules, setRules] = useState<MatchRules>(DEFAULT_MATCH_RULES);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [found, allTeams, agents, saved] = await Promise.all([
          fetchEvent(eventId),
          adminTeams(eventId),
          adminFreeAgents(eventId),
          // Rules may already have been set from the desk while signup was open; start from those, not
          // from the defaults, or pressing Start would quietly put them back.
          fetchMatchSettings(eventId).catch(() => ({})),
        ]);
        if (cancelled) return;
        setEvent(found);
        setRules(rulesFrom(saved));
        setTeams(allTeams);
        setSoloWaiting(agents.filter((a) => a.status === "waiting").length);

        // Teams go in the order they signed up, which favours nobody; the administrator changes it.
        const entered = allTeams.filter((team) => team.status === "approved" && !team.forfeited_at);
        setOrder(entered);
        const suggestion = suggestFormat(entered.length).format;
        setFormat(suggestion);
        setSchedule(suggestSchedule(suggestion, entered.length, nextHour()).schedule);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const n = order.length;
  const suggestion = useMemo(() => suggestFormat(n), [n]);
  const plan = useMemo(
    () => (format && schedule ? planStart(format, order.map((team) => team.id), schedule) : null),
    [format, schedule, order],
  );

  if (loadError) return <div className="panel error-text">{loadError}</div>;
  if (event === undefined || !format || !schedule) return <LoadingScreen>{t("Loading...", "Chargement...")}</LoadingScreen>;
  if (event === null) return <div className="panel">{t("There is no such event.", "Cet événement n'existe pas.")}</div>;

  if (event.status !== "signup") {
    return (
      <div className="panel stack">
        <strong>
          {t(`"${event.name}" isn't taking signups, so it can't be started.`, `« ${event.name} » n'accepte plus d'inscriptions, il ne peut donc pas être lancé.`)}
        </strong>
        <span className="muted">
          {event.status === "draft"
            ? t("Open signup first, let teams register, then come back to start it.", "Ouvrez d'abord les inscriptions, laissez les équipes s'inscrire, puis revenez le lancer.")
            : t(`It is ${event.status}.`, `Il est ${event.status}.`)}
        </span>
        <Link to="/admin">{t("Back to the admin page", "Retour à la page d'administration")}</Link>
      </div>
    );
  }

  const pending = teams.filter((team) => team.status === "pending");
  const short = order.filter((team) => team.roster.length < event.team_size);
  const shape = scheduleShape(format, n);
  const formatErrors = validateFormat(format, n);
  const estimate = estimateMatches(format, n);
  const problems = plan && !plan.ok ? plan.problems : [];
  const canStart = n >= 2 && plan?.ok === true && !busy && rulesProblem(rules, SET_CAPS) === null;
  const names = new Map(order.map((team) => [team.id, team.name]));

  async function start() {
    if (!plan || !plan.ok || !format || !schedule || !event) return;
    const ok = window.confirm(
      t(
        `Start "${event.name}" with ${n} ${event.team_size === 1 ? "players" : "teams"}?\n\nThis closes signup and locks the format. An event that has started can be cancelled, but not un-started.`,
        `Lancer « ${event.name} » avec ${n} ${event.team_size === 1 ? "joueurs" : "équipes"} ?\n\nCela ferme les inscriptions et verrouille le format. Un événement lancé peut être annulé, mais pas « dé-lancé ».`,
      ),
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      // The rules go first: they are harmless if the start is then refused, and an event that started
      // without them would have official rooms on the default clock until somebody noticed.
      await saveMatchSettings(event.id, toMatchSettings(rules, SET_CAPS));
      await startEvent(event.id, format, schedule, order.map((team) => team.id), plan.plan.matches);
      navigate(`/event/${event.id}`);
    } catch (e) {
      // Refused, or failed part-way: either way nothing was changed, and the reason is the server's own.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ width: "min(860px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{t("Start", "Lancer")} {event.name}</h1>
        <p className="muted">{t("Nothing is written until you press Start at the bottom.", "Rien n'est enregistré avant d'appuyer sur Lancer, en bas.")}</p>
      </div>

      {/* Things that will not be in the event, said before the administrator commits. */}
      {(n < 2 || pending.length > 0 || short.length > 0 || soloWaiting > 0) && (
        <div className="panel stack" style={{ borderColor: n < 2 ? "var(--danger)" : "rgba(217, 164, 65, 0.6)" }}>
          {n < 2 && <strong>{t("At least two approved teams are needed to start.", "Il faut au moins deux équipes approuvées pour lancer.")}</strong>}
          {pending.length > 0 && (
            <span>
              {t(
                `${pending.length} team${pending.length === 1 ? " is" : "s are"} still awaiting approval and will NOT be in the event: `,
                `${pending.length} équipe(s) en attente d'approbation ne seront PAS dans l'événement : `,
              )}
              <strong>{pending.map((p) => p.name).join(", ")}</strong>. {t("Approve them on the admin page first if they should play.", "Approuvez-les d'abord sur la page d'administration si elles doivent jouer.")}
            </span>
          )}
          {short.length > 0 && (
            <span>
              {t(`Not full (fewer than ${event.team_size} players): `, `Incomplètes (moins de ${event.team_size} joueurs) : `)}
              <strong>{short.map((s) => `${s.name} (${s.roster.length})`).join(", ")}</strong>.{" "}
              {t("They can still be topped up from the solo pool after the event starts.", "Elles pourront encore être complétées depuis la liste des joueurs solo après le lancement.")}
            </span>
          )}
          {soloWaiting > 0 && (
            <span>
              {t(`${soloWaiting} solo player${soloWaiting === 1 ? " is" : "s are"} still waiting for a team. New teams can't be formed once the event starts.`, `${soloWaiting} joueur(s) solo attendent encore une équipe. On ne pourra plus former de nouvelles équipes après le lancement.`)}
            </span>
          )}
        </div>
      )}

      <div className="panel stack">
        <h3>{t(`1. Seeding (${n} ${event.team_size === 1 ? "players" : "teams"})`, `1. Têtes de série (${n} ${event.team_size === 1 ? "joueurs" : "équipes"})`)}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            "The seed order decides who meets whom - the top seed meets the bottom seed first. It starts in sign-up order, which favours nobody.",
            "L'ordre des têtes de série détermine les affrontements - la première tête de série affronte la dernière. Il part de l'ordre d'inscription, qui ne favorise personne.",
          )}
        </p>
        <SeedList teams={order} onChange={setOrder} signupOrder={teams.filter((team) => team.status === "approved" && !team.forfeited_at)} />
      </div>

      <div className="panel stack">
        <h3>{t("2. Format", "2. Format")}</h3>
        <div className="stack" style={{ gap: "0.3rem" }}>
          <span className="muted">{t("Suggested for this many entrants:", "Suggestion pour ce nombre de participants :")}</span>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {suggestion.reasons.map((reason) => (
              <li key={reason} className="muted">{reason}</li>
            ))}
          </ul>
          <div>
            <button
              onClick={() => {
                setFormat(suggestion.format);
                setSchedule(suggestSchedule(suggestion.format, n, schedule.startsAt).schedule);
              }}
            >
              {t("Use the suggestion", "Utiliser la suggestion")}
            </button>
          </div>
        </div>
        <FormatEditor format={format} n={n} onChange={setFormat} />
        {formatErrors.length > 0 ? (
          <div className="error-text">{formatErrors.map((e) => <div key={e}>{e}</div>)}</div>
        ) : (
          <span className="muted">
            {t(
              `About ${estimate.qualifier + estimate.knockoutMin}${estimate.knockoutMax > estimate.knockoutMin ? `-${estimate.qualifier + estimate.knockoutMax}` : ""} matches in all` +
                (effectiveCut(format, n) > 0 && format.qualifier.format !== "none" ? `; ${effectiveCut(format, n)} teams reach the knockout.` : "."),
              `Environ ${estimate.qualifier + estimate.knockoutMin}${estimate.knockoutMax > estimate.knockoutMin ? `-${estimate.qualifier + estimate.knockoutMax}` : ""} matchs au total` +
                (effectiveCut(format, n) > 0 && format.qualifier.format !== "none" ? ` ; ${effectiveCut(format, n)} équipes atteignent l'élimination.` : "."),
            )}
          </span>
        )}
      </div>

      <div className="panel stack">
        <h3>{t("3. Schedule", "3. Calendrier")}</h3>
        <div className="row">
          <span className="muted">{t("Fit the whole event into about", "Faire tenir l'événement en environ")}</span>
          <input type="number" min={7} value={fitDays} onChange={(e) => setFitDays(Number(e.target.value))} style={{ width: "5rem" }} />
          <span className="muted">{t("days", "jours")}</span>
          <button onClick={() => setSchedule(suggestSchedule(format, n, schedule.startsAt, fitDays).schedule)} disabled={formatErrors.length > 0}>
            {t("Fit", "Ajuster")}
          </button>
        </div>
        <ScheduleEditor schedule={schedule} shape={shape} onChange={setSchedule} />
      </div>

      <div className="panel stack">
        <h3>{t("4. What will be drawn", "4. Ce qui sera tiré")}</h3>
        {plan?.ok ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {plan.plan.stage === "swiss"
                ? t("Round 1 only. Each later round is drawn from the results of the one before.", "Le premier tour seulement. Chaque tour suivant est tiré d'après les résultats du précédent.")
                : plan.plan.stage === "group"
                  ? t("Every group match, all at once.", "Tous les matchs de poule, d'un coup.")
                  : t("The whole bracket.", "Tout le tableau.")}
            </p>
            <MatchList matches={plan.plan.matches.map(previewRow)} names={names} />
          </>
        ) : (
          <div className="error-text">
            {problems.length > 0 ? problems.map((p) => <div key={p}>{p}</div>) : t("Fix the problems above to see the draw.", "Corrigez les problèmes ci-dessus pour voir le tirage.")}
          </div>
        )}
      </div>

      <div className="panel stack">
        <h3>{t("5. Official match rules", "5. Règles des matchs officiels")}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            "When a team's room becomes an official match it takes these rules, and the host can't change them. You can change them later from the event's desk.",
            "Quand la partie d'une équipe devient un match officiel, elle adopte ces règles et l'hôte ne peut plus les modifier. Vous pourrez les changer plus tard depuis le bureau de l'événement.",
          )}
        </p>
        <MatchRulesEditor rules={rules} onChange={setRules} />
      </div>

      {error && <div className="panel error-text">{error}</div>}

      <div className="row" style={{ justifyContent: "center", gap: "1rem" }}>
        <Link to="/admin" className="link-button">{t("Back", "Retour")}</Link>
        <button className="primary" disabled={!canStart} onClick={() => void start()} style={{ padding: "0.7rem 2rem", fontSize: "1.05rem" }}>
          {busy ? t("Starting...", "Lancement...") : t("Start the event", "Lancer l'événement")}
        </button>
      </div>
    </div>
  );
}
