import type { ReactNode } from "react";
import type { TournamentFormat } from "../../lib/tournament/format";
import { defaultKnockout, defaultQualifier, type QualifierKind } from "../../lib/tournament/formatDefaults";
import { useT } from "../../lib/language";

interface Props {
  format: TournamentFormat;
  /** How many teams are entered - the defaults it offers when a choice changes depend on it. */
  n: number;
  onChange: (format: TournamentFormat) => void;
}

/**
 * A labelled control. Module-level on purpose: a component defined INSIDE another is a new component
 * type on every render, so React would unmount and remount its input on each keystroke and the field
 * would lose focus after every character typed.
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="stack" style={{ gap: "0.25rem" }}>
      <span className="muted">{label}</span>
      {children}
    </label>
  );
}

/** Series length: a single game, or best of 3, 5 or 7. */
function BestOf({ value, onPick }: { value: number | undefined; onPick: (v: number) => void }) {
  const t = useT();
  return (
    <select value={value ?? 1} onChange={(e) => onPick(Number(e.target.value))}>
      {[1, 3, 5, 7].map((v) => (
        <option key={v} value={v}>
          {v === 1 ? t("single game", "une manche") : t(`best of ${v}`, `au meilleur de ${v}`)}
        </option>
      ))}
    </select>
  );
}

/**
 * The shape of the event: an optional qualifier (Swiss or groups), then an optional knockout.
 *
 * Every change goes through the format helpers rather than editing fields in isolation, so that
 * switching the kind of qualifier lands on a format that already works instead of one that has lost the
 * fields its new kind needs. What is actually valid for this many teams is the validator's business, and
 * the page shows its verdict beside the controls.
 */
export function FormatEditor({ format, n, onChange }: Props) {
  const t = useT();
  const q = format.qualifier;
  const k = format.knockout;

  const setQualifier = (kind: QualifierKind) =>
    onChange({
      qualifier: defaultQualifier(kind, n),
      // With no qualifier the knockout IS the event, so it can't be absent.
      knockout: kind === "none" ? (k ?? defaultKnockout(n)) : k,
    });

  return (
    <div className="stack" style={{ gap: "0.9rem" }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <Field label={t("Qualifier", "Qualification")}>
          <select value={q.format} onChange={(e) => setQualifier(e.target.value as QualifierKind)}>
            <option value="none">{t("None - straight to a knockout", "Aucune - directement en élimination")}</option>
            <option value="swiss">{t("Swiss", "Suisse")}</option>
            <option value="groups">{t("Groups (round-robin)", "Poules (toutes contre toutes)")}</option>
          </select>
        </Field>

        {q.format === "swiss" && (
          <>
            <Field label={t("Rounds", "Tours")}>
              <input type="number" min={1} value={q.rounds} onChange={(e) => onChange({ ...format, qualifier: { ...q, rounds: Number(e.target.value) } })} style={{ width: "5rem" }} />
            </Field>
            <Field label={t("Each match is", "Chaque match est")}>
              <BestOf value={q.bestOf} onPick={(bestOf) => onChange({ ...format, qualifier: { ...q, bestOf } })} />
            </Field>
          </>
        )}

        {q.format === "groups" && (
          <>
            <Field label={t("Groups", "Poules")}>
              <input type="number" min={1} value={q.groupCount} onChange={(e) => onChange({ ...format, qualifier: { ...q, groupCount: Number(e.target.value) } })} style={{ width: "5rem" }} />
            </Field>
            <Field label={t("Advance from each", "Qualifiés par poule")}>
              <input type="number" min={1} value={q.advancePerGroup ?? 1} onChange={(e) => onChange({ ...format, qualifier: { ...q, advancePerGroup: Number(e.target.value) } })} style={{ width: "5rem" }} />
            </Field>
            <Field label={t("Meetings", "Rencontres")}>
              <select value={q.legs} onChange={(e) => onChange({ ...format, qualifier: { ...q, legs: Number(e.target.value) as 1 | 2 } })}>
                <option value={1}>{t("once", "une fois")}</option>
                <option value={2}>{t("twice (home and away)", "deux fois (aller-retour)")}</option>
              </select>
            </Field>
            <Field label={t("Each match is", "Chaque match est")}>
              <BestOf value={q.bestOf} onPick={(bestOf) => onChange({ ...format, qualifier: { ...q, bestOf } })} />
            </Field>
          </>
        )}
      </div>

      {q.format !== "none" && (
        <label className="row" style={{ gap: "0.5rem" }}>
          <input type="checkbox" checked={k !== null} onChange={(e) => onChange({ ...format, knockout: e.target.checked ? defaultKnockout(n) : null })} />
          <span>
            {q.format === "groups"
              ? t("Then a knockout, seeded by the groups", "Puis une phase à élimination, tête de série d'après les poules")
              : t("Then a knockout for the top teams", "Puis une phase à élimination pour les meilleures équipes")}
          </span>
        </label>
      )}

      {k && (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <Field label={t("Knockout", "Élimination")}>
            <select value={k.format} onChange={(e) => onChange({ ...format, knockout: { ...k, format: e.target.value as "single" | "double" } })}>
              <option value="single">{t("Single elimination", "Élimination simple")}</option>
              <option value="double">{t("Double elimination", "Double élimination")}</option>
            </select>
          </Field>
          {q.format === "swiss" && (
            <Field label={t("Top teams through", "Équipes qualifiées")}>
              <input type="number" min={2} value={k.cutTo ?? 2} onChange={(e) => onChange({ ...format, knockout: { ...k, cutTo: Number(e.target.value) } })} style={{ width: "5rem" }} />
            </Field>
          )}
          <Field label={t("Early rounds", "Premiers tours")}>
            <BestOf value={k.bestOf} onPick={(bestOf) => onChange({ ...format, knockout: { ...k, bestOf } })} />
          </Field>
          <Field label={t("Semifinals", "Demi-finales")}>
            <BestOf value={k.semifinalBestOf ?? k.bestOf} onPick={(semifinalBestOf) => onChange({ ...format, knockout: { ...k, semifinalBestOf } })} />
          </Field>
          <Field label={t("Final", "Finale")}>
            <BestOf value={k.finalBestOf ?? k.bestOf} onPick={(finalBestOf) => onChange({ ...format, knockout: { ...k, finalBestOf } })} />
          </Field>
          {k.format === "single" && (
            <label className="row" style={{ gap: "0.4rem" }}>
              <input type="checkbox" checked={k.thirdPlace} onChange={(e) => onChange({ ...format, knockout: { ...k, thirdPlace: e.target.checked } })} />
              <span>{t("Third-place match", "Match pour la troisième place")}</span>
            </label>
          )}
          {k.format === "double" && (
            <label className="row" style={{ gap: "0.4rem" }} title={t("If the loser-bracket finalist wins the grand final, they have one loss each, so a second grand final decides it.", "Si le finaliste du tableau des perdants gagne la grande finale, chacun a une défaite : une seconde grande finale les départage.")}>
              <input type="checkbox" checked={k.grandFinalReset} onChange={(e) => onChange({ ...format, knockout: { ...k, grandFinalReset: e.target.checked } })} />
              <span>{t("Grand-final reset", "Grande finale décisive")}</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
