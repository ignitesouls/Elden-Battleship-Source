import { useEffect, useMemo, useState } from "react";
import { drawStage, saveSchedule, teamLogos, type AdminTeamRow, type MatchRow } from "../../../lib/tournament/api";
import { tableCuts } from "../../../lib/tournament/format";
import { scheduleShape } from "../../../lib/tournament/schedule";
import type { Schedule } from "../../../lib/tournament/schedule";
import { planKnockout, planNextSwissRound, planTiebreaks, qualifierStatus } from "../../../lib/tournament/stages";
import type { TMatch } from "../../../lib/tournament/types";
import { useLanguage, useT } from "../../../lib/language";
import { groupLabel } from "../../../lib/tournament/groupNames";
import { MatchList } from "../../event/MatchList";
import { StandingsTable } from "../../event/StandingsTable";
import { ScheduleEditor } from "../ScheduleEditor";
import { SeedList } from "../SeedList";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

const NO_MATCHES: TMatch[] = [];

/** A drawn match as the list the event page shows, so the preview looks like what players will see. */
function previewRow(m: TMatch): MatchRow {
  return {
    id: m.key, key: m.key, stage: m.stage, bracket: m.bracket, grp: m.group, round: m.round, phase: m.phase, idx: m.index,
    entrant_a: m.a, entrant_b: m.b, best_of: m.bestOf, score_a: m.scoreA, score_b: m.scoreB, status: m.status,
    winner: m.winner, result_kind: m.resultKind, opens_at: m.opensAt, due_at: m.dueAt, agreed_at: null, agreed_by: null,
  };
}

/**
 * The stages after the first: drawing the next Swiss round, and building the knockout that follows a
 * qualifier - each shown with the reason it is or isn't available, and a preview of exactly what would
 * be drawn before anything is written.
 *
 * Neither can be drawn early, and the database refuses an early draw on its own. What this panel adds is
 * telling the administrator WHY it isn't time yet ("3 matches are still open"), which a refusal after the
 * fact would only say once they had already tried.
 */
export function StagesPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const { event, config, stored, seeded, departed, gameStats } = data;
  const [schedule, setSchedule] = useState<Schedule | null>(config?.schedule ?? null);
  const [advancing, setAdvancing] = useState<AdminTeamRow[] | null>(null);
  useEffect(() => setSchedule(config?.schedule ?? null), [config]);

  const format = config?.format;
  // A stable fallback: `?? []` would be a new array every render and quietly defeat the memo below.
  const matches = stored?.matches ?? NO_MATCHES;
  const seededIds = useMemo(() => seeded.map((s) => s.id), [seeded]);
  const status = useMemo(
    () => (format ? qualifierStatus(format, seededIds, matches, departed, gameStats) : null),
    [format, seededIds, matches, departed, gameStats],
  );

  // The order the knockout will be seeded in starts from the standings; the administrator can change it.
  const advancingKey = status?.advancing.join(",") ?? "";
  useEffect(() => {
    if (!status) return;
    const byId = new Map(seeded.map((s) => [s.id, s]));
    setAdvancing(status.advancing.map((id) => byId.get(id)).filter((x): x is AdminTeamRow => !!x));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advancingKey]);

  if (!event || event.status !== "live" || !format || !schedule || !stored || !status) return null;

  const swissDrawn = matches.filter((m) => m.stage === "swiss").reduce((most, m) => Math.max(most, m.round), 0);
  const koBuilt = matches.some((m) => m.stage === "knockout");
  const isSwiss = format.qualifier.format === "swiss";
  const swissPlan = isSwiss ? planNextSwissRound(format, seededIds, matches, departed, schedule) : null;
  const koPlan =
    format.knockout && !koBuilt && advancing
      ? planKnockout(format, seededIds, matches, departed, advancing.map((a) => a.id), schedule, gameStats)
      : null;
  const tiebreakPlan = !koBuilt && status.playoffs.length > 0 ? planTiebreaks(format, seededIds, matches, departed, gameStats) : null;
  const openTiebreaks = matches.filter((m) => m.stage === "tiebreak" && (m.status === "ready" || m.status === "in_progress" || m.status === "pending")).length;

  const swissRoundsLeft = isSwiss && format.qualifier.format === "swiss" ? format.qualifier.rounds - swissDrawn : 0;
  // Is there any stage still to come? A Swiss round not yet drawn, or a knockout not yet built.
  const stageToCome = swissRoundsLeft > 0 || (!!format.knockout && !koBuilt) || (!koBuilt && status.playoffs.length > 0);
  const shape = scheduleShape(format, seededIds.length);

  return (
    <div className="panel stack">
      <h3>{t("Drawing the next stage", "Tirage de l'étape suivante")}</h3>

      {isSwiss && format.qualifier.format === "swiss" && (
        <div className="stack" style={{ gap: "0.5rem" }}>
          <strong>
            {t(`Swiss: ${swissDrawn} of ${format.qualifier.rounds} rounds drawn`, `Suisse : ${swissDrawn} tour(s) tiré(s) sur ${format.qualifier.rounds}`)}
          </strong>
          {swissRoundsLeft > 0 && swissPlan?.ok && (
            <>
              <span className="muted">
                {t(`Round ${swissDrawn + 1} can be drawn now. It pairs teams by their standings, and leaves out anyone who has been removed.`,
                  `Le tour ${swissDrawn + 1} peut être tiré. Il apparie les équipes selon le classement, sans les équipes retirées.`)}
              </span>
              <MatchList matches={swissPlan.matches.map(previewRow)} names={data.names} />
              <div>
                <button className="primary" disabled={busy} onClick={() => void act(() => drawStage(event.id, "swiss", swissPlan.matches))}>
                  {t(`Draw round ${swissDrawn + 1}`, `Tirer le tour ${swissDrawn + 1}`)}
                </button>
              </div>
            </>
          )}
          {swissRoundsLeft > 0 && swissPlan && !swissPlan.ok && (
            <span className="muted">{swissPlan.problems.join(" ")}</span>
          )}
          {swissRoundsLeft === 0 && <span className="muted">{t("Every round has been drawn.", "Tous les tours ont été tirés.")}</span>}
        </div>
      )}

      {status.tables.length > 0 && (
        <div className="stack" style={{ gap: "0.6rem" }}>
          {status.tables.map((rows, g) => (
            <StandingsTable
              key={g}
              rows={rows}
              names={data.names}
              logos={teamLogos(data.teams)}
              departed={departed}
              cut={tableCuts(format)?.[g]}
              title={format.qualifier.format === "groups" ? groupLabel(event.group_names, g, lang) : t("Standings", "Classement")}
            />
          ))}
        </div>
      )}

      {!koBuilt && (status.playoffs.length > 0 || openTiebreaks > 0) && (
        <div className="panel stack" style={{ borderColor: "var(--accent)", padding: "0.7rem", gap: "0.5rem" }}>
          <strong>{t("Tiebreakers", "Barrages")}</strong>
          {openTiebreaks > 0 ? (
            <span className="muted">
              {t(
                `${openTiebreaks} tiebreaker match${openTiebreaks === 1 ? " is" : "es are"} still to be played. Teams link them from their entry code like any official match.`,
                `${openTiebreaks} match(s) de barrage reste(nt) à jouer. Les équipes les lancent avec leur code d'inscription, comme tout match officiel.`,
              )}
            </span>
          ) : (
            <>
              <span className="muted">
                {t(
                  "These teams are level on every tiebreak, and the tie decides who goes through or where they are seeded. They have to play it off - original seed never decides it. Each tie is a single-game round robin among the tied teams.",
                  "Ces équipes sont à égalité sur tous les critères, et cette égalité décide de la qualification ou du placement. Elles doivent se départager sur le terrain - la tête de série ne décide jamais. Chaque égalité se joue en poule unique, une manche par match.",
                )}
              </span>
              {status.playoffs.map((p) => (
                <div key={p.ids.join(",")}>
                  {p.group !== null && <span className="muted">{groupLabel(event.group_names, p.group, lang)}: </span>}
                  {p.ids.map((id) => data.names.get(id) ?? "?").join(", ")}
                </div>
              ))}
              {tiebreakPlan?.ok ? (
                <>
                  <MatchList matches={tiebreakPlan.matches.map(previewRow)} names={data.names} groupNames={event.group_names} />
                  <div>
                    <button className="primary" disabled={busy} onClick={() => void act(() => drawStage(event.id, "tiebreak", tiebreakPlan.matches))}>
                      {t("Draw the tiebreakers", "Tirer les barrages")}
                    </button>
                  </div>
                </>
              ) : tiebreakPlan ? (
                <div className="error-text">{tiebreakPlan.problems.map((p) => <div key={p}>{p}</div>)}</div>
              ) : null}
            </>
          )}
        </div>
      )}

      {format.knockout && !koBuilt && (
        <div className="stack" style={{ gap: "0.6rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.7rem" }}>
          <strong>{t("The knockout", "L'élimination")}</strong>
          {!status.complete ? (
            <span className="muted">
              {t("Not ready to build: ", "Pas encore prêt : ")}
              {status.waitingOn.join("; ")}.
            </span>
          ) : (
            <>
              <span className="muted">{t("Seeding for the knockout, best first - move teams to change it:", "Têtes de série de l'élimination, la meilleure d'abord - déplacez les équipes pour la modifier :")}</span>
              {advancing && <SeedList teams={advancing} onChange={setAdvancing} signupOrder={seeded.filter((s) => status.advancing.includes(s.id))} />}
              {koPlan?.ok ? (
                <>
                  <MatchList matches={koPlan.matches.map(previewRow)} names={data.names} />
                  <div>
                    <button className="primary" disabled={busy} onClick={() => void act(() => drawStage(event.id, "knockout", koPlan.matches))}>
                      {t("Build the knockout", "Construire l'élimination")}
                    </button>
                  </div>
                </>
              ) : koPlan ? (
                <div className="error-text">{koPlan.problems.map((p) => <div key={p}>{p}</div>)}</div>
              ) : null}
            </>
          )}
        </div>
      )}

      {!stageToCome && (
        <span className="muted">{t("There is nothing further to draw - every match is already in place.", "Il n'y a rien d'autre à tirer - tous les matchs sont déjà en place.")}</span>
      )}

      <details>
        <summary style={{ cursor: "pointer" }}>{t("Schedule for the stages still to come", "Calendrier des étapes à venir")}</summary>
        <div className="stack" style={{ marginTop: "0.6rem" }}>
          <ScheduleEditor schedule={schedule} shape={shape} onChange={setSchedule} />
          <div>
            <button disabled={busy} onClick={() => void act(() => saveSchedule(event.id, schedule))}>
              {t("Save the schedule", "Enregistrer le calendrier")}
            </button>
            <span className="muted" style={{ marginLeft: "0.6rem", fontSize: "0.75rem" }}>
              {t("Applies to rounds drawn from now on. To give a round already drawn more time, use the extension buttons under Results.", "S'applique aux tours tirés à partir de maintenant. Pour donner plus de temps à un tour déjà tiré, utilisez les boutons de prolongation sous Résultats.")}
            </span>
          </div>
        </div>
      </details>
    </div>
  );
}
