import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  adminFreeAgents,
  adminTeams,
  fetchEvent,
  fetchEventPlan,
  fetchMatchSettings,
  saveEventPlan,
  saveGroupNames,
  saveMatchSettings,
  startEvent,
  type AdminTeamRow,
  type EventDetail,
  type MatchRow,
} from "../../lib/tournament/api";
import { effectiveCut, estimateMatches, suggestFormat, validateFormat, type TournamentFormat } from "../../lib/tournament/format";
import { scheduleShape, suggestSchedule, type Schedule } from "../../lib/tournament/schedule";
import { planStart } from "../../lib/tournament/start";
import { assignGroups } from "../../lib/tournament/groups";
import { groupNamesProblem, tidyGroupNames } from "../../lib/tournament/groupNames";
import type { TMatch } from "../../lib/tournament/types";
import { useLanguage, useT } from "../../lib/language";
import { useTeamPowers } from "../../hooks/useTeamPowers";
import { LoadingScreen } from "../BrandMark";
import { MatchList } from "../event/MatchList";
import { JustForFun, PowerTag } from "../event/PowerLine";
import { FormatEditor } from "./FormatEditor";
import { GroupNamesEditor } from "./desk/GroupNamesPanel";
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

/** The group count a format asks for, or 0 when it has no group stage. */
function groupCountOf(format: TournamentFormat | null): number {
  return format?.qualifier.format === "groups" ? format.qualifier.groupCount : 0;
}

/**
 * The plan-and-start page: draft an event while signup is open, then turn it into a running event.
 *
 * This is mounted only for an administrator (see pages/AdminStartEvent) and nothing here is fetched
 * before that - but the page is not what keeps anyone else out. Saving a plan writes to an admin-only
 * table, and starting is one database function, start_tournament, that checks for an administrator
 * itself and either does everything or nothing.
 *
 * While signup is open (or the event is still a draft) the organiser can work on the plan - seeding,
 * format, groups and their names, schedule, match rules - and SAVE it, coming back to it as teams keep
 * signing up. The page always opens from the saved plan: teams that signed up since go on the end of the
 * seeding, teams that left drop out. Pressing Start saves once more and starts, and only then does
 * anything become the event's real format.
 *
 * Two ways in, from two buttons on the admin page, so an organiser doing group work can't start the
 * event by accident: `mode="plan"` (/plan) has no Start button at all, only Save; `mode="start"` (/start)
 * is the same page with Start at the bottom.
 */
export function StartEventForm({ eventId, mode = "start" }: { eventId: string; mode?: "plan" | "start" }) {
  const t = useT();
  const lang = useLanguage();
  const navigate = useNavigate();

  const [event, setEvent] = useState<EventDetail | null | undefined>(undefined);
  const [teams, setTeams] = useState<AdminTeamRow[]>([]);
  const [soloWaiting, setSoloWaiting] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // What the administrator decides.
  const [order, setOrder] = useState<AdminTeamRow[]>([]);
  const [format, setFormat] = useState<TournamentFormat | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [fitDays, setFitDays] = useState(28);
  const [rules, setRules] = useState<MatchRules>(DEFAULT_MATCH_RULES);
  const [groupNames, setGroupNames] = useState<string[]>([]);

  // What was last saved, as one string, so "unsaved changes" is a comparison rather than bookkeeping.
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [found, allTeams, agents, saved, plan] = await Promise.all([
          fetchEvent(eventId),
          adminTeams(eventId),
          adminFreeAgents(eventId),
          // Rules may already have been set from the desk while signup was open; start from those, not
          // from the defaults, or pressing Start would quietly put them back.
          fetchMatchSettings(eventId).catch(() => ({})),
          fetchEventPlan(eventId).catch(() => null),
        ]);
        if (cancelled) return;
        setEvent(found);
        setRules(rulesFrom(saved));
        setTeams(allTeams);
        setSoloWaiting(agents.filter((a) => a.status === "waiting").length);

        const entered = allTeams.filter((team) => team.status === "approved" && !team.forfeited_at);
        let nextOrder = entered; // sign-up order, which favours nobody, unless a plan says otherwise
        let nextFormat = suggestFormat(entered.length).format;
        let nextSchedule = suggestSchedule(nextFormat, entered.length, nextHour()).schedule;
        let nextFit = 28;
        if (plan) {
          // The saved seeding, minus teams no longer in, plus teams approved since - on the end.
          const byId = new Map(entered.map((team) => [team.id, team]));
          const kept = plan.seed_order.map((id) => byId.get(id)).filter((x): x is AdminTeamRow => !!x);
          const keptIds = new Set(kept.map((team) => team.id));
          nextOrder = [...kept, ...entered.filter((team) => !keptIds.has(team.id))];
          nextFormat = plan.format;
          nextSchedule = plan.schedule;
          nextFit = plan.fit_days ?? 28;
          setSavedAt(plan.updated_at);
        }
        const names = Array.from({ length: groupCountOf(nextFormat) }, (_, i) => found?.group_names[i] ?? "");
        setOrder(nextOrder);
        setFormat(nextFormat);
        setSchedule(nextSchedule);
        setFitDays(nextFit);
        setGroupNames(names);
        if (plan) setSavedKey(planKey(nextFormat, nextSchedule, nextOrder, nextFit, names, rulesFrom(saved)));
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // One name box per group, following the group count as the format changes; names already typed stay.
  const groupCount = groupCountOf(format);
  useEffect(() => {
    setGroupNames((now) => (now.length === groupCount ? now : Array.from({ length: groupCount }, (_, i) => now[i] ?? "")));
  }, [groupCount]);

  const n = order.length;
  const suggestion = useMemo(() => suggestFormat(n), [n]);
  const plan = useMemo(
    () => (format && schedule ? planStart(format, order.map((team) => team.id), schedule) : null),
    [format, schedule, order],
  );
  const rosters = useMemo(() => new Map(order.map((team) => [team.id, team.roster.map((m) => m.user_id)])), [order]);
  const powers = useTeamPowers(rosters);

  if (loadError) return <div className="panel error-text">{loadError}</div>;
  if (event === undefined || !format || !schedule) return <LoadingScreen>{t("Loading...", "Chargement...")}</LoadingScreen>;
  if (event === null) return <div className="panel">{t("There is no such event.", "Cet événement n'existe pas.")}</div>;

  if (event.status !== "signup" && event.status !== "draft") {
    return (
      <div className="panel stack">
        <strong>
          {t(`"${event.name}" has already started, so its plan can't be changed here.`, `« ${event.name} » a déjà commencé : son plan ne peut plus être modifié ici.`)}
        </strong>
        <span className="muted">{t(`It is ${event.status}.`, `Il est ${event.status}.`)}</span>
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
  const tidyNames = tidyGroupNames(groupNames);
  const namesProblem = groupNamesProblem(tidyNames);
  const canSave = !busy && !namesProblem && rulesProblem(rules, SET_CAPS) === null;
  const canStart = event.status === "signup" && n >= 2 && plan?.ok === true && canSave;
  const names = new Map(order.map((team) => [team.id, team.name]));
  const currentKey = planKey(format, schedule, order, fitDays, groupNames, rules);
  const unsaved = savedKey !== currentKey;
  const groups = groupCount > 0 && n >= groupCount ? assignGroups(order.map((team) => team.id), groupCount) : null;

  /** Writes the plan, the group names and the match rules - everything this page decides. */
  async function persist() {
    if (!format || !schedule || !event) return;
    await saveMatchSettings(event.id, toMatchSettings(rules, SET_CAPS));
    await saveGroupNames(event.id, tidyNames);
    await saveEventPlan(event.id, { format, schedule, seed_order: order.map((team) => team.id), fit_days: fitDays });
    setSavedKey(planKey(format, schedule, order, fitDays, groupNames, rules));
    setSavedAt(new Date().toISOString());
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await persist();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

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
      // Everything decided here goes first: harmless if the start is then refused, and an event that
      // started without its rules would have official rooms on the default clock until somebody noticed.
      await persist();
      await startEvent(event.id, format, schedule, order.map((team) => team.id), plan.plan.matches);
      navigate(`/event/${event.id}`);
    } catch (e) {
      // Refused, or failed part-way: either way nothing was started, and the reason is the server's own.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const when = (iso: string) => new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="stack" style={{ width: "min(860px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{mode === "plan" ? t("Plan", "Préparer") : t("Start", "Lancer")} {event.name}</h1>
        <p className="muted">
          {mode === "plan"
            ? t(
                "Work on the plan while teams are still signing up and save it as often as you like. This page can't start the event - when you're ready, use \"Start the event\" on the admin page, which opens from this plan.",
                "Préparez le plan pendant que les équipes s'inscrivent et enregistrez-le aussi souvent que vous voulez. Cette page ne peut pas lancer l'événement - le moment venu, utilisez « Lancer l'événement » sur la page d'administration, qui reprend ce plan.",
              )
            : t(
                "Check the plan, change anything you need, then press Start at the bottom. Nothing goes live before that.",
                "Vérifiez le plan, modifiez ce qu'il faut, puis appuyez sur Lancer en bas. Rien n'est lancé avant.",
              )}
        </p>
        {savedAt && (
          <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            {t(`Plan last saved ${when(savedAt)}.`, `Plan enregistré le ${when(savedAt)}.`)} {unsaved && <strong style={{ color: "var(--accent-bright)" }}>{t("You have unsaved changes.", "Modifications non enregistrées.")}</strong>}
          </p>
        )}
      </div>

      {/* Things that will not be in the event, said before the administrator commits. */}
      {(n < 2 || pending.length > 0 || short.length > 0 || soloWaiting > 0 || event.status === "draft") && (
        <div className="panel stack" style={{ borderColor: n < 2 ? "var(--danger)" : "rgba(217, 164, 65, 0.6)" }}>
          {event.status === "draft" && <strong>{t("This event is still a draft. You can plan it now; open signup before it can be started.", "Cet événement est encore un brouillon. Vous pouvez le préparer ; ouvrez les inscriptions avant de le lancer.")}</strong>}
          {n < 2 && <strong>{t("At least two approved teams are needed to start.", "Il faut au moins deux équipes approuvées pour lancer.")}</strong>}
          {pending.length > 0 && (
            <span>
              {t(
                `${pending.length} team${pending.length === 1 ? " is" : "s are"} still awaiting approval and are not in this plan: `,
                `${pending.length} équipe(s) en attente d'approbation ne sont pas dans ce plan : `,
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
            "The seed order decides who meets whom - the top seed meets the bottom seed first, and groups are dealt from it so none is stacked. It starts in sign-up order, which favours nobody; \"Seed by power\" orders it by the teams' records instead.",
            "L'ordre des têtes de série détermine les affrontements - la première affronte la dernière, et les poules en sont tirées pour qu'aucune ne soit déséquilibrée. Il part de l'ordre d'inscription, qui ne favorise personne ; « par puissance » le classe d'après les résultats des équipes.",
          )}
        </p>
        <SeedList teams={order} onChange={setOrder} signupOrder={teams.filter((team) => team.status === "approved" && !team.forfeited_at)} powers={powers} />
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

      {groupCount > 0 && (
        <div className="panel stack">
          <h3>{t("3. Groups", "3. Poules")}</h3>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              "Name each group - type anything, or fill them from a list - and see who is in it. Teams are dealt into groups from the seeding, so reorder the seeds to change a group. The groups follow the teams as more sign up; leave a name empty to keep its letter.",
              "Nommez chaque poule - tapez ce que vous voulez, ou remplissez depuis une liste - et voyez qui la compose. Les équipes sont réparties d'après les têtes de série : changez l'ordre pour changer une poule. Les poules suivent les inscriptions ; laissez un nom vide pour garder la lettre.",
            )}
          </p>
          <GroupNamesEditor
            names={groupNames}
            onChange={setGroupNames}
            disabled={busy}
            extra={(g) =>
              groups ? (
                <div className="row" style={{ gap: "0.3rem 0.8rem", paddingLeft: "5.1rem", fontSize: "0.82rem" }}>
                  {groups[g].map((id) => (
                    <span key={id}>
                      {names.get(id)} <PowerTag info={powers?.get(id)} />
                    </span>
                  ))}
                </div>
              ) : (
                <span className="muted" style={{ paddingLeft: "5.1rem", fontSize: "0.78rem" }}>
                  {t("Not enough teams yet to fill every group.", "Pas encore assez d'équipes pour remplir chaque poule.")}
                </span>
              )
            }
          />
        </div>
      )}

      <div className="panel stack">
        <h3>{t(`${groupCount > 0 ? 4 : 3}. Schedule`, `${groupCount > 0 ? 4 : 3}. Calendrier`)}</h3>
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
        <h3>{t(`${groupCount > 0 ? 5 : 4}. What will be drawn`, `${groupCount > 0 ? 5 : 4}. Ce qui sera tiré`)}</h3>
        {plan?.ok ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {plan.plan.stage === "swiss"
                ? t("Round 1 only. Each later round is drawn from the results of the one before.", "Le premier tour seulement. Chaque tour suivant est tiré d'après les résultats du précédent.")
                : plan.plan.stage === "group"
                  ? t("Every group match, all at once.", "Tous les matchs de poule, d'un coup.")
                  : t("The whole bracket.", "Tout le tableau.")}
              {event.status !== "signup" || n < 2 ? "" : ` ${t("As signups stand right now.", "D'après les inscriptions actuelles.")}`}
            </p>
            <MatchList matches={plan.plan.matches.map(previewRow)} names={names} groupNames={groupNames} powers={powers} />
          </>
        ) : (
          <div className="error-text">
            {problems.length > 0 ? problems.map((p) => <div key={p}>{p}</div>) : t("Fix the problems above to see the draw.", "Corrigez les problèmes ci-dessus pour voir le tirage.")}
          </div>
        )}
      </div>

      <div className="panel stack">
        <h3>{t(`${groupCount > 0 ? 6 : 5}. Official match rules`, `${groupCount > 0 ? 6 : 5}. Règles des matchs officiels`)}</h3>
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
        <button disabled={!canSave || !unsaved} onClick={() => void save()} style={{ padding: "0.7rem 1.4rem" }}>
          {busy ? t("Saving...", "Enregistrement...") : unsaved ? t("Save the plan", "Enregistrer le plan") : t("Plan saved", "Plan enregistré")}
        </button>
        {mode === "start" && (
          <button className="primary" disabled={!canStart} onClick={() => void start()} style={{ padding: "0.7rem 2rem", fontSize: "1.05rem" }}>
            {busy ? t("Starting...", "Lancement...") : t("Start the event", "Lancer l'événement")}
          </button>
        )}
      </div>
      {powers && powers.size > 0 && <JustForFun />}
    </div>
  );
}

/** Everything the page decides, as one string - equal strings mean nothing has changed since the save. */
function planKey(format: TournamentFormat, schedule: Schedule, order: AdminTeamRow[], fitDays: number, groupNames: string[], rules: MatchRules): string {
  return JSON.stringify([format, schedule, order.map((team) => team.id), fitDays, tidyGroupNames(groupNames), rules]);
}
