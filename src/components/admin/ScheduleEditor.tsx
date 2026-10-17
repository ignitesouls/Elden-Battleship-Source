import { useState } from "react";
import { groupLabel } from "../../lib/tournament/groupNames";
import { toLocalInput } from "../../lib/tournament/localTime";
import {
  assignGroupWeeks,
  groupWeeksOf,
  scheduleEnd,
  spreadGroupWeeks,
  windowFor,
  type Schedule,
  type ScheduleShape,
  type ScheduleWeek,
} from "../../lib/tournament/schedule";
import type { TMatch } from "../../lib/tournament/types";
import { useLanguage, useT } from "../../lib/language";

interface Props {
  schedule: Schedule;
  shape: ScheduleShape;
  onChange: (schedule: Schedule) => void;
  /**
   * The group matches as they would be drawn right now, for the week-by-week preview and for moving a
   * match by hand. Only the start page has them; without them the weeks are dates only.
   */
  groupMatches?: TMatch[];
  names?: Map<string, string>;
  groupNames?: readonly string[];
}

const WEEK_MS = 7 * 86_400_000;

/**
 * When the rounds open and close: a start date, how many days each round is open, and any round that
 * needs more or less. Rounds are laid end to end, so lengthening one moves everything after it.
 *
 * A group stage can instead be laid out by week. The organizer sets the weeks' dates and the site
 * deals every group match into one (assignGroupWeeks): a group of six over four weeks plays twice in
 * one week per team, spread so no week holds every double. The preview shows who plays when, and any
 * match can be moved to another week by hand - the rest are dealt again around it. The knockout follows
 * the last week to close.
 *
 * Deadlines are advisory - nothing is forfeited by a clock - so this is about telling people when to
 * expect to play, not about enforcing it. The overdue list is where an administrator chases the
 * stragglers.
 */
export function ScheduleEditor({ schedule, shape, onChange, groupMatches, names, groupNames }: Props) {
  const t = useT();
  const lang = useLanguage();
  const { ctx, knockoutPhases } = shape;
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });
  const weeks = groupWeeksOf(schedule, ctx);
  const isGroups = ctx.qualifierStage === "group" && ctx.qualifierRounds > 0;
  const [weekCount, setWeekCount] = useState(() => (weeks && weeks.length > 0 ? weeks.length : Math.min(4, ctx.qualifierRounds) || 1));

  type Round = { stage: "swiss" | "group" | "knockout"; phase: number; label: string };
  const qualifierRounds: Round[] = [];
  if (!weeks) {
    for (let p = 1; p <= ctx.qualifierRounds; p++) {
      const stage = ctx.qualifierStage === "group" ? "group" : "swiss";
      qualifierRounds.push({ stage, phase: p, label: stage === "swiss" ? t(`Swiss round ${p}`, `Tour suisse ${p}`) : t(`Group matchday ${p}`, `Journée de poules ${p}`) });
    }
  }
  const knockoutRounds: Round[] = [];
  for (let p = 1; p <= knockoutPhases; p++) {
    knockoutRounds.push({ stage: "knockout", phase: p, label: t(`Knockout round ${p}`, `Tour d'élimination ${p}`) });
  }
  const rounds = [...qualifierRounds, ...knockoutRounds];

  const setOverride = (key: string, value: string) => {
    const overrides = { ...schedule.overrides };
    const days = Number(value);
    if (value === "" || !Number.isFinite(days)) delete overrides[key];
    else overrides[key] = days;
    onChange({ ...schedule, overrides });
  };

  /**
   * Writes a new list of weeks, `from[i]` being where week i came from in the current list (null for a
   * new one). Weeks are kept in date order and the start date follows the first one, so "First round
   * opens" stays true; matches moved by hand follow their week through the reordering, and a move to a
   * week that was removed goes back to being dealt.
   */
  const setWeeks = (next: ScheduleWeek[], from: Array<number | null>) => {
    const order = next.map((w, i) => ({ w, from: from[i] })).sort((a, b) => Date.parse(a.w.opensAt) - Date.parse(b.w.opensAt));
    const newIndex = new Map<number, number>();
    order.forEach((o, i) => o.from !== null && newIndex.set(o.from, i));
    const weekMoves: Record<string, number> = {};
    for (const [pairing, wk] of Object.entries(schedule.weekMoves ?? {})) {
      const moved = newIndex.get(wk);
      if (moved !== undefined) weekMoves[pairing] = moved;
    }
    onChange({ ...schedule, groupWeeks: order.map((o) => o.w), weekMoves, startsAt: order[0]?.w.opensAt ?? schedule.startsAt });
  };
  const same = (list: ScheduleWeek[]) => list.map((_, i) => i);
  const editWeek = (i: number, patch: Partial<ScheduleWeek>) => weeks && setWeeks(weeks.map((w, k) => (k === i ? { ...w, ...patch } : w)), same(weeks));
  const removeWeek = (i: number) =>
    weeks &&
    setWeeks(
      weeks.filter((_, k) => k !== i),
      same(weeks).filter((k) => k !== i),
    );
  const addWeek = () => {
    if (!weeks) return;
    const last = weeks.reduce((latest, w) => Math.max(latest, Date.parse(w.dueAt)), Number.NEGATIVE_INFINITY);
    const opens = Number.isFinite(last) ? last : Date.parse(schedule.startsAt);
    setWeeks([...weeks, { opensAt: new Date(opens).toISOString(), dueAt: new Date(opens + WEEK_MS).toISOString() }], [...same(weeks), null]);
  };
  /** A fresh set of back-to-back weeks. Hand moves into weeks that still exist are kept. */
  const layOut = () => {
    const fresh = spreadGroupWeeks(weeks?.[0]?.opensAt ?? schedule.startsAt, weekCount);
    setWeeks(fresh, fresh.map((_, i) => (weeks && i < weeks.length ? i : null)));
  };
  /** Moving the start date moves every week with it, keeping the layout. */
  const setStart = (iso: string) => {
    if (!weeks || weeks.length === 0) return onChange({ ...schedule, startsAt: iso });
    const shift = Date.parse(iso) - Date.parse(weeks[0].opensAt);
    const move = (at: string) => new Date(Date.parse(at) + shift).toISOString();
    onChange({ ...schedule, startsAt: iso, groupWeeks: weeks.map((w) => ({ opensAt: move(w.opensAt), dueAt: move(w.dueAt) })) });
  };
  /** Pins one pairing to a week, or (null) hands it back to the dealing. */
  const moveMatch = (pairing: string, wk: number | null) => {
    const weekMoves = { ...(schedule.weekMoves ?? {}) };
    if (wk === null) delete weekMoves[pairing];
    else weekMoves[pairing] = wk;
    onChange({ ...schedule, weekMoves });
  };

  const hasBoth = ctx.qualifierRounds > 0 && knockoutPhases > 0;
  const moveCount = Object.keys(schedule.weekMoves ?? {}).length;
  const knockoutOwnDate = schedule.knockoutStartsAt !== undefined;
  /** Playoffs on their own date (starting from wherever they would open now), or back to following the qualifier. */
  const setKnockoutOwnDate = (own: boolean) => {
    if (own) return onChange({ ...schedule, knockoutStartsAt: windowFor(schedule, ctx, "knockout", 1).opensAt });
    const next = { ...schedule };
    delete next.knockoutStartsAt;
    onChange(next);
  };

  const roundList = (list: Round[]) =>
    list.length > 0 && (
      <div className="t-list">
        {list.map((round) => {
          const key = `${round.stage}:${round.phase}`;
          const w = windowFor(schedule, ctx, round.stage, round.phase);
          const usual = round.stage === "knockout" ? (schedule.knockoutRoundDays ?? schedule.roundDays) : schedule.roundDays;
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
                  placeholder={String(usual)}
                  value={schedule.overrides[key] ?? ""}
                  onChange={(e) => setOverride(key, e.target.value)}
                  style={{ width: "5rem", padding: "0.2rem 0.4rem" }}
                />
              </label>
            </div>
          );
        })}
      </div>
    );

  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      {hasBoth && <strong>{ctx.qualifierStage === "group" ? t("Group stage", "Phase de poules") : t("Swiss rounds", "Rondes suisses")}</strong>}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("First round opens", "Ouverture du premier tour")}</span>
          <input type="datetime-local" value={toLocalInput(schedule.startsAt)} onChange={(e) => e.target.value && setStart(new Date(e.target.value).toISOString())} />
        </label>
        {!weeks && (
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted">{t("Days per round", "Jours par tour")}</span>
            <input type="number" min={1} step={0.5} value={schedule.roundDays} onChange={(e) => onChange({ ...schedule, roundDays: Number(e.target.value) })} style={{ width: "5.5rem" }} />
          </label>
        )}
      </div>

      {isGroups && (
        <div className="stack" style={{ gap: "0.5rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
          <div className="row" style={{ gap: "0.5rem" }}>
            <span className="muted">{t("Run the group stage over", "Jouer la phase de poules sur")}</span>
            <input type="number" min={1} value={weekCount} onChange={(e) => setWeekCount(Number(e.target.value))} style={{ width: "4.5rem" }} />
            <span className="muted">{t(`week${weekCount === 1 ? "" : "s"}`, "semaine(s)")}</span>
            <button type="button" onClick={layOut}>
              {weeks ? t("Lay the weeks out again", "Refaire les semaines") : t("Lay out the weeks", "Créer les semaines")}
            </button>
            {weeks && (
              <button type="button" onClick={() => onChange({ ...schedule, groupWeeks: undefined, weekMoves: undefined })}>
                {t("Back to one matchday after another", "Revenir à une journée après l'autre")}
              </button>
            )}
          </div>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {t(
              `The groups have ${ctx.qualifierRounds} matchday${ctx.qualifierRounds === 1 ? "" : "s"}. In fewer weeks than that, some teams play twice in a week: the site picks the matches so those doubles are shared out - each team doubles up as rarely as it can, and not all in the same week. Move any match by hand below and the rest are dealt around it.`,
              `Les poules ont ${ctx.qualifierRounds} journée(s). En moins de semaines, certaines équipes jouent deux fois dans une semaine : le site choisit les matchs pour répartir ces doublés - chaque équipe en a le moins possible, et pas tous la même semaine. Déplacez un match à la main ci-dessous et les autres sont répartis autour.`,
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
                  <button type="button" style={{ fontSize: "0.75rem" }} onClick={() => removeWeek(i)}>
                    {t("Remove week", "Supprimer la semaine")}
                  </button>
                </div>
              ))}
              <div className="row" style={{ gap: "0.6rem" }}>
                <button type="button" onClick={addWeek}>
                  {t("Add a week", "Ajouter une semaine")}
                </button>
                {moveCount > 0 && (
                  <button type="button" onClick={() => onChange({ ...schedule, weekMoves: {} })}>
                    {t(`Undo ${moveCount} hand move${moveCount === 1 ? "" : "s"}`, `Annuler ${moveCount} déplacement(s)`)}
                  </button>
                )}
              </div>
            </div>
          )}

          {weeks && weeks.length > 0 && groupMatches && groupMatches.length > 0 && (
            <WeekPreview weeks={weeks} schedule={schedule} matches={groupMatches} names={names} groupNames={groupNames} onMove={moveMatch} />
          )}
        </div>
      )}

      {roundList(hasBoth ? qualifierRounds : rounds)}

      {hasBoth && (
        <div className="stack" style={{ gap: "0.6rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.7rem" }}>
          <strong>{t("Playoffs", "Phase finale")}</strong>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="stack" style={{ gap: "0.25rem" }}>
              <span className="muted">{t("Playoffs start", "Début de la phase finale")}</span>
              <select value={knockoutOwnDate ? "date" : "after"} onChange={(e) => setKnockoutOwnDate(e.target.value === "date")}>
                <option value="after">{t("After the qualifier, with a break", "Après la qualification, avec une pause")}</option>
                <option value="date">{t("On a date I choose", "À une date choisie")}</option>
              </select>
            </label>
            {knockoutOwnDate ? (
              <label className="stack" style={{ gap: "0.25rem" }}>
                <span className="muted">{t("First playoff round opens", "Ouverture du premier tour final")}</span>
                <input
                  type="datetime-local"
                  value={toLocalInput(schedule.knockoutStartsAt!)}
                  onChange={(e) => e.target.value && onChange({ ...schedule, knockoutStartsAt: new Date(e.target.value).toISOString() })}
                />
              </label>
            ) : (
              <label className="stack" style={{ gap: "0.25rem" }}>
                <span className="muted">{t("Break before the playoffs (days)", "Pause avant la phase finale (jours)")}</span>
                <input type="number" min={0} step={0.5} value={schedule.stageGapDays} onChange={(e) => onChange({ ...schedule, stageGapDays: Number(e.target.value) })} style={{ width: "5.5rem" }} />
              </label>
            )}
            <label className="stack" style={{ gap: "0.25rem" }}>
              <span className="muted">{t("Days per playoff round", "Jours par tour final")}</span>
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={schedule.knockoutRoundDays ?? schedule.roundDays}
                onChange={(e) => onChange({ ...schedule, knockoutRoundDays: Number(e.target.value) })}
                style={{ width: "5.5rem" }}
              />
            </label>
          </div>
          {roundList(knockoutRounds)}
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

/**
 * Who plays when: each group, week by week, with every match and a picker to move it. A team with two
 * or more matches in a week is named under that week, so the organizer can see the doubles at a glance.
 */
function WeekPreview({
  weeks,
  schedule,
  matches,
  names,
  groupNames,
  onMove,
}: {
  weeks: ScheduleWeek[];
  schedule: Schedule;
  matches: TMatch[];
  names?: Map<string, string>;
  groupNames?: readonly string[];
  onMove: (pairing: string, week: number | null) => void;
}) {
  const t = useT();
  const lang = useLanguage();
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });
  const name = (id: string | null) => (id ? (names?.get(id) ?? id) : "?");
  const slots = assignGroupWeeks(matches, weeks.length, schedule.weekMoves);
  const groups = [...new Set(slots.map((s) => s.match.group ?? 0))].sort((a, b) => a - b);

  return (
    <div className="stack" style={{ gap: "0.8rem" }}>
      <strong>{t("Who plays when", "Qui joue quand")}</strong>
      {groups.map((g) => {
        const mine = slots.filter((s) => (s.match.group ?? 0) === g);
        return (
          <div key={g} className="stack" style={{ gap: "0.4rem" }}>
            <span style={{ fontWeight: 600 }}>{groupLabel(groupNames, g, lang)}</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.5rem" }}>
              {weeks.map((week, w) => {
                const inWeek = mine.filter((s) => s.week === w);
                const load = new Map<string, number>();
                for (const s of inWeek) for (const id of [s.match.a!, s.match.b!]) load.set(id, (load.get(id) ?? 0) + 1);
                const busy = [...load.entries()].filter(([, c]) => c > 1);
                return (
                  <div key={w} className="t-item" style={{ flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start", gap: "0.3rem" }}>
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      {t(`Week ${w + 1}`, `Semaine ${w + 1}`)} · {day(week.opensAt)} → {day(week.dueAt)} · {t(`${inWeek.length} match${inWeek.length === 1 ? "" : "es"}`, `${inWeek.length} match(s)`)}
                    </span>
                    {inWeek.map((s) => (
                      <div key={s.match.key} className="row" style={{ gap: "0.4rem", justifyContent: "space-between", fontSize: "0.85rem" }}>
                        <span style={s.moved ? { fontWeight: 600 } : undefined}>
                          {name(s.match.a)} <span className="muted">vs</span> {name(s.match.b)}
                        </span>
                        <select
                          value={s.moved ? String(w) : ""}
                          onChange={(e) => onMove(s.pairing, e.target.value === "" ? null : Number(e.target.value))}
                          style={{ fontSize: "0.75rem", padding: "0.1rem 0.2rem" }}
                          aria-label={t(`Week for ${name(s.match.a)} vs ${name(s.match.b)}`, `Semaine de ${name(s.match.a)} contre ${name(s.match.b)}`)}
                        >
                          <option value="">{t("auto", "auto")}</option>
                          {weeks.map((_, k) => (
                            <option key={k} value={k}>
                              {t(`week ${k + 1}`, `semaine ${k + 1}`)}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                    {busy.length > 0 && (
                      <span style={{ fontSize: "0.78rem", color: busy.some(([, c]) => c > 2) ? "var(--danger)" : "var(--accent-bright)" }}>
                        {busy.map(([id, c]) => t(`${name(id)} plays ${c}×`, `${name(id)} joue ${c} fois`)).join(" · ")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <span className="muted" style={{ fontSize: "0.78rem" }}>
        {t(
          "Bold matches were moved by hand; set one back to auto to let the site place it again.",
          "Les matchs en gras ont été déplacés à la main ; remettez-en un sur auto pour que le site le replace.",
        )}
      </span>
    </div>
  );
}
