import { toLocalInput } from "../../lib/tournament/localTime";
import { scheduleEnd, windowFor, type Schedule, type ScheduleShape } from "../../lib/tournament/schedule";
import { useLanguage, useT } from "../../lib/language";

interface Props {
  schedule: Schedule;
  shape: ScheduleShape;
  onChange: (schedule: Schedule) => void;
}

/**
 * When the rounds open and close: a start date, how many days each round is open, and any round that
 * needs more or less. Rounds are laid end to end, so lengthening one moves everything after it.
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

  const rounds: Array<{ stage: "swiss" | "group" | "knockout"; phase: number; label: string }> = [];
  for (let p = 1; p <= ctx.qualifierRounds; p++) {
    const stage = ctx.qualifierStage === "group" ? "group" : "swiss";
    rounds.push({ stage, phase: p, label: stage === "swiss" ? t(`Swiss round ${p}`, `Tour suisse ${p}`) : t(`Group matchday ${p}`, `Journée de poules ${p}`) });
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

  const hasBoth = ctx.qualifierRounds > 0 && knockoutPhases > 0;

  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("First round opens", "Ouverture du premier tour")}</span>
          <input
            type="datetime-local"
            value={toLocalInput(schedule.startsAt)}
            onChange={(e) => e.target.value && onChange({ ...schedule, startsAt: new Date(e.target.value).toISOString() })}
          />
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Days per round", "Jours par tour")}</span>
          <input type="number" min={1} step={0.5} value={schedule.roundDays} onChange={(e) => onChange({ ...schedule, roundDays: Number(e.target.value) })} style={{ width: "5.5rem" }} />
        </label>
        {hasBoth && (
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted">{t("Break before the knockout (days)", "Pause avant l'élimination (jours)")}</span>
            <input type="number" min={0} step={0.5} value={schedule.stageGapDays} onChange={(e) => onChange({ ...schedule, stageGapDays: Number(e.target.value) })} style={{ width: "5.5rem" }} />
          </label>
        )}
      </div>

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

      {rounds.length > 0 && (
        <span className="muted">
          {t("Scheduled to finish around", "Fin prévue vers le")} <strong>{day(scheduleEnd(schedule, ctx, knockoutPhases))}</strong>
          {" · "}
          {t("times are in your own time zone", "les heures sont dans votre fuseau horaire")}
        </span>
      )}
    </div>
  );
}
