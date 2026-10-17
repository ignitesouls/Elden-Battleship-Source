import { useState } from "react";
import { toLocalInput } from "../../lib/tournament/localTime";
import { groupWeeksOf, scheduleEnd, spreadGroupWeeks, windowFor, type Schedule, type ScheduleShape, type ScheduleWeek } from "../../lib/tournament/schedule";
import { useLanguage, useT } from "../../lib/language";

interface Props {
  schedule: Schedule;
  shape: ScheduleShape;
  onChange: (schedule: Schedule) => void;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * When the rounds open and close: a start date, how many days each round is open, and any round that
 * needs more or less. Rounds are laid end to end, so lengthening one moves everything after it.
 *
 * A group stage can instead be laid out by week: "run it over 3 weeks" spreads the matchdays across
 * three weeks, or "start from scratch" gives empty weeks the organizer fills by hand. Either way each
 * week's dates and matchdays stay editable, and the knockout follows the last week to close.
 *
 * Deadlines are advisory - nothing is forfeited by a clock - so this is about telling people when to
 * expect to play, not about enforcing it. The overdue list is where an administrator chases the
 * stragglers.
 */
export function ScheduleEditor({ schedule, shape, onChange }: Props) {
  const t = useT();
  const lang = useLanguage();
  const { ctx, knockoutPhases } = shape;
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });
  const weeks = groupWeeksOf(schedule, ctx);
  const isGroups = ctx.qualifierStage === "group" && ctx.qualifierRounds > 0;
  const [weekCount, setWeekCount] = useState(() => (weeks && weeks.length > 0 ? weeks.length : Math.min(4, ctx.qualifierRounds) || 1));

  const rounds: Array<{ stage: "swiss" | "group" | "knockout"; phase: number; label: string }> = [];
  if (!weeks) {
    for (let p = 1; p <= ctx.qualifierRounds; p++) {
      const stage = ctx.qualifierStage === "group" ? "group" : "swiss";
      rounds.push({ stage, phase: p, label: stage === "swiss" ? t(`Swiss round ${p}`, `Tour suisse ${p}`) : t(`Group matchday ${p}`, `Journée de poules ${p}`) });
    }
  }
  for (let p = 1; p <= knockoutPhases; p++) {
    rounds.push({ stage: "knockout", phase: p, label: t(`Knockout round ${p}`, `Tour d'élimination ${p}`) });
  }

  const setOverride = (key: string, value: string) => {
    const overrides = { ...schedule.overrides };
    const days = Number(value);
    if (value === "" || !Number.isFinite(days)) delete overrides[key];
    else overrides[key] = days;
    onChange({ ...schedule, overrides });
  };

  // Weeks are kept in date order and the start date follows the first one, so "First round opens" stays true.
  const setWeeks = (next: ScheduleWeek[]) => {
    const sorted = [...next].sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt));
    onChange({ ...schedule, groupWeeks: sorted, startsAt: sorted[0]?.opensAt ?? schedule.startsAt });
  };
  const editWeek = (i: number, patch: Partial<ScheduleWeek>) => weeks && setWeeks(weeks.map((w, k) => (k === i ? { ...w, ...patch } : w)));
  /** Puts a matchday in week `i`, taking it out of whichever week had it. */
  const moveMatchday = (p: number, i: number) =>
    weeks &&
    setWeeks(weeks.map((w, k) => ({ ...w, matchdays: k === i ? [...w.matchdays.filter((x) => x !== p), p].sort((a, b) => a - b) : w.matchdays.filter((x) => x !== p) })));
  const addWeek = () => {
    if (!weeks) return;
    const last = weeks.reduce((latest, w) => Math.max(latest, Date.parse(w.dueAt)), Number.NEGATIVE_INFINITY);
    const opens = Number.isFinite(last) ? last : Date.parse(schedule.startsAt);
    setWeeks([...weeks, { opensAt: new Date(opens).toISOString(), dueAt: new Date(opens + WEEK_MS).toISOString(), matchdays: [] }]);
  };
  /** Moving the start date moves every week with it, keeping the layout. */
  const setStart = (iso: string) => {
    if (!weeks || weeks.length === 0) return onChange({ ...schedule, startsAt: iso });
    const shift = Date.parse(iso) - Date.parse(weeks[0].opensAt);
    const move = (at: string) => new Date(Date.parse(at) + shift).toISOString();
    onChange({ ...schedule, startsAt: iso, groupWeeks: weeks.map((w) => ({ ...w, opensAt: move(w.opensAt), dueAt: move(w.dueAt) })) });
  };

  const weekOf = new Map<number, number>();
  weeks?.forEach((w, i) => w.matchdays.forEach((p) => weekOf.set(p, i)));
  const unplaced = Array.from({ length: ctx.qualifierRounds }, (_, i) => i + 1).filter((p) => !weekOf.has(p));

  const hasBoth = ctx.qualifierRounds > 0 && knockoutPhases > 0;

  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("First round opens", "Ouverture du premier tour")}</span>
          <input type="datetime-local" value={toLocalInput(schedule.startsAt)} onChange={(e) => e.target.value && setStart(new Date(e.target.value).toISOString())} />
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{weeks ? t("Days per knockout round", "Jours par tour d'élimination") : t("Days per round", "Jours par tour")}</span>
          <input type="number" min={1} step={0.5} value={schedule.roundDays} onChange={(e) => onChange({ ...schedule, roundDays: Number(e.target.value) })} style={{ width: "5.5rem" }} />
        </label>
        {hasBoth && (
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted">{t("Break before the knockout (days)", "Pause avant l'élimination (jours)")}</span>
            <input type="number" min={0} step={0.5} value={schedule.stageGapDays} onChange={(e) => onChange({ ...schedule, stageGapDays: Number(e.target.value) })} style={{ width: "5.5rem" }} />
          </label>
        )}
      </div>

      {isGroups && (
        <div className="stack" style={{ gap: "0.5rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
          <div className="row" style={{ gap: "0.5rem" }}>
            <span className="muted">{t("Run the group stage over", "Jouer la phase de poules sur")}</span>
            <input type="number" min={1} max={ctx.qualifierRounds} value={weekCount} onChange={(e) => setWeekCount(Number(e.target.value))} style={{ width: "4.5rem" }} />
            <span className="muted">{t(`week${weekCount === 1 ? "" : "s"}`, "semaine(s)")}</span>
            <button type="button" onClick={() => setWeeks(spreadGroupWeeks(weeks?.[0]?.opensAt ?? schedule.startsAt, ctx.qualifierRounds, weekCount))}>
              {t("Spread the matchdays", "Répartir les journées")}
            </button>
            <button type="button" onClick={() => setWeeks([])}>
              {t("Start from scratch", "Partir de zéro")}
            </button>
            {weeks && (
              <button type="button" onClick={() => onChange({ ...schedule, groupWeeks: undefined })}>
                {t("Back to one matchday after another", "Revenir à une journée après l'autre")}
              </button>
            )}
          </div>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {t(
              `The groups have ${ctx.qualifierRounds} matchday${ctx.qualifierRounds === 1 ? "" : "s"}; a team plays at most once per matchday, so a week with two matchdays means up to two matches that week.`,
              `Les poules ont ${ctx.qualifierRounds} journée(s) ; une équipe joue au plus une fois par journée, donc une semaine de deux journées veut dire jusqu'à deux matchs cette semaine-là.`,
            )}
          </span>

          {weeks && (
            <div className="t-list">
              {weeks.length === 0 && <span className="muted">{t("No weeks yet - add one.", "Aucune semaine pour l'instant - ajoutez-en une.")}</span>}
              {weeks.map((week, i) => (
                <div className="t-item" key={i} style={{ flexWrap: "wrap", gap: "0.4rem 0.8rem" }}>
                  <strong>{t(`Week ${i + 1}`, `Semaine ${i + 1}`)}</strong>
                  <label className="row" style={{ gap: "0.3rem" }}>
                    <span className="muted" style={{ fontSize: "0.75rem" }}>{t("opens", "ouvre")}</span>
                    <input type="datetime-local" value={toLocalInput(week.opensAt)} onChange={(e) => e.target.value && editWeek(i, { opensAt: new Date(e.target.value).toISOString() })} />
                  </label>
                  <label className="row" style={{ gap: "0.3rem" }}>
                    <span className="muted" style={{ fontSize: "0.75rem" }}>{t("due", "échéance")}</span>
                    <input type="datetime-local" value={toLocalInput(week.dueAt)} onChange={(e) => e.target.value && editWeek(i, { dueAt: new Date(e.target.value).toISOString() })} />
                  </label>
                  <span className="row" style={{ gap: "0.3rem" }}>
                    {week.matchdays.length === 0 && <span className="muted" style={{ fontSize: "0.8rem" }}>{t("no matchdays", "aucune journée")}</span>}
                    {week.matchdays.map((p) => (
                      <span key={p}>
                        {t(`Matchday ${p}`, `Journée ${p}`)}{" "}
                        <button
                          type="button"
                          style={{ padding: "0 0.4rem", fontSize: "0.75rem" }}
                          aria-label={t(`Take matchday ${p} out of week ${i + 1}`, `Retirer la journée ${p} de la semaine ${i + 1}`)}
                          onClick={() => editWeek(i, { matchdays: week.matchdays.filter((x) => x !== p) })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </span>
                  <select value="" onChange={(e) => e.target.value && moveMatchday(Number(e.target.value), i)} style={{ fontSize: "0.8rem" }}>
                    <option value="">{t("Add a matchday...", "Ajouter une journée...")}</option>
                    {Array.from({ length: ctx.qualifierRounds }, (_, k) => k + 1)
                      .filter((p) => weekOf.get(p) !== i)
                      .map((p) => (
                        <option key={p} value={p}>
                          {weekOf.has(p) ? t(`Matchday ${p} (from week ${weekOf.get(p)! + 1})`, `Journée ${p} (de la semaine ${weekOf.get(p)! + 1})`) : t(`Matchday ${p}`, `Journée ${p}`)}
                        </option>
                      ))}
                  </select>
                  <button type="button" style={{ fontSize: "0.75rem" }} onClick={() => setWeeks(weeks.filter((_, k) => k !== i))}>
                    {t("Remove week", "Supprimer la semaine")}
                  </button>
                </div>
              ))}
              <div>
                <button type="button" onClick={addWeek}>
                  {t("Add a week", "Ajouter une semaine")}
                </button>
              </div>
              {unplaced.length > 0 && (
                <span className="error-text" style={{ fontSize: "0.85rem" }}>
                  {t(`Not in a week yet: matchday ${unplaced.join(", ")}.`, `Pas encore dans une semaine : journée ${unplaced.join(", ")}.`)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {rounds.length > 0 && (
        <div className="t-list">
          {rounds.map((round) => {
            const key = `${round.stage}:${round.phase}`;
            const w = windowFor(schedule, ctx, round.stage, round.phase);
            return (
              <div className="t-item" key={key}>
                <span>
                  {round.label}{" "}
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {day(w.opensAt)} → {day(w.dueAt)}
                  </span>
                </span>
                <label className="row" style={{ gap: "0.4rem" }}>
                  <span className="muted" style={{ fontSize: "0.75rem" }}>{t("days", "jours")}</span>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    placeholder={String(schedule.roundDays)}
                    value={schedule.overrides[key] ?? ""}
                    onChange={(e) => setOverride(key, e.target.value)}
                    style={{ width: "5rem", padding: "0.2rem 0.4rem" }}
                  />
                </label>
              </div>
            );
          })}
        </div>
      )}

      {(rounds.length > 0 || (weeks && weeks.length > 0)) && (
        <span className="muted">
          {t("Scheduled to finish around", "Fin prévue vers le")} <strong>{day(scheduleEnd(schedule, ctx, knockoutPhases))}</strong>
          {" · "}
          {t("times are in your own time zone", "les heures sont dans votre fuseau horaire")}
        </span>
      )}
    </div>
  );
}
