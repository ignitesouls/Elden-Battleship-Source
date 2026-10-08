import { useEffect, useState } from "react";
import { saveGroupNames } from "../../../lib/tournament/api";
import {
  GROUP_NAME_SETS,
  MAX_GROUP_NAME,
  groupLabel,
  groupNamesProblem,
  pickGroupNames,
  tidyGroupNames,
} from "../../../lib/tournament/groupNames";
import { useLanguage, useT } from "../../../lib/language";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

/** Every name on every list, once each, for the suggestions under each box. */
const SUGGESTIONS = [...new Set(GROUP_NAME_SETS.flatMap((s) => s.names))].sort((a, b) => a.localeCompare(b));

/**
 * The group-naming controls on their own: a box per group (with every listed name as a suggestion), and
 * buttons that fill them all from one list. Used by the desk once an event is running, and by the start
 * page while it is still being planned. Saving is the caller's business.
 *
 * `extra` renders under each group's box - the start page puts the group's teams there.
 */
export function GroupNamesEditor({
  names,
  onChange,
  disabled,
  extra,
}: {
  /** One entry per group, "" for an unnamed one. Its length is the number of groups. */
  names: string[];
  onChange: (names: string[]) => void;
  disabled?: boolean;
  extra?: (group: number) => React.ReactNode;
}) {
  const t = useT();
  const lang = useLanguage();
  const count = names.length;
  const problem = groupNamesProblem(tidyGroupNames(names));
  const set = (i: number, value: string) => onChange(names.map((n, j) => (j === i ? value : n)));

  return (
    <div className="stack" style={{ gap: "0.6rem" }}>
      <div className="row" style={{ gap: "0.4rem" }}>
        <span className="muted" style={{ fontSize: "0.8rem" }}>{t("Fill from a list:", "Remplir depuis une liste :")}</span>
        {GROUP_NAME_SETS.map((s) => (
          <button
            key={s.id}
            type="button"
            style={{ fontSize: "0.8rem", padding: "0.25rem 0.6rem" }}
            disabled={disabled}
            title={s.names.join(", ")}
            onClick={() => {
              const picked = pickGroupNames(s, count);
              onChange(Array.from({ length: count }, (_, i) => picked[i] ?? ""));
            }}
          >
            {t(s.label[0], s.label[1])}
          </button>
        ))}
        <button type="button" style={{ fontSize: "0.8rem", padding: "0.25rem 0.6rem" }} disabled={disabled} onClick={() => onChange(Array(count).fill(""))}>
          {t("Letters only", "Lettres seulement")}
        </button>
      </div>

      <datalist id="group-name-suggestions">
        {SUGGESTIONS.map((n) => <option key={n} value={n} />)}
      </datalist>
      <div className="stack" style={{ gap: "0.5rem" }}>
        {names.map((name, i) => (
          <div key={i} className="stack" style={{ gap: "0.2rem" }}>
            <label className="row" style={{ gap: "0.6rem", flexWrap: "nowrap" }}>
              <span className="muted" style={{ minWidth: "4.5rem", fontSize: "0.85rem" }}>{groupLabel([], i, lang)}</span>
              <input
                style={{ flex: 1, minWidth: 0 }}
                value={name}
                maxLength={MAX_GROUP_NAME}
                list="group-name-suggestions"
                placeholder={t("Type any name, or pick one", "Tapez un nom, ou choisissez-en un")}
                aria-label={groupLabel([], i, lang)}
                disabled={disabled}
                onChange={(e) => set(i, e.target.value)}
              />
            </label>
            {extra?.(i)}
          </div>
        ))}
      </div>

      {problem === "duplicate" && <span className="error-text">{t("Two groups have the same name.", "Deux poules portent le même nom.")}</span>}
      {problem === "too-long" && <span className="error-text">{t(`A name can be at most ${MAX_GROUP_NAME} characters.`, `Un nom compte au plus ${MAX_GROUP_NAME} caractères.`)}</span>}
    </div>
  );
}

/**
 * Naming the groups of a running event, on the desk. (Before it starts, the start page names them - see
 * StartEventForm.) Editable for as long as the event exists: a name is a label, not a rule, so changing
 * it mid-event changes nothing but what the standings say at the top.
 */
export function GroupNamesPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const saved = data.event?.group_names ?? [];
  const savedKey = saved.join("\n");
  const qualifier = data.config?.format?.qualifier;
  const count = qualifier?.format === "groups" ? qualifier.groupCount : 0;

  const [names, setNames] = useState<string[]>([]);
  // Follows the saved names when they change (a save, the first load); other desk reloads leave edits alone.
  useEffect(() => setNames(Array.from({ length: count }, (_, i) => saved[i] ?? "")), [savedKey, count]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data.event || count === 0) return null;

  const tidy = tidyGroupNames(names);
  const changed = tidy.join("\n") !== tidyGroupNames(saved.slice(0, count)).join("\n");
  const problem = groupNamesProblem(tidy);

  return (
    <div className="panel stack">
      <h3>{t("Group names", "Noms des poules")}</h3>
      <span className="muted" style={{ fontSize: "0.8rem" }}>
        {t(
          "Shown above each group's standings and beside its matches. Leave one empty to keep its letter. You can rename them at any point in the event.",
          "Affichés au-dessus du classement de chaque poule et à côté de ses matchs. Laissez vide pour garder la lettre. Vous pouvez les renommer à tout moment.",
        )}
      </span>
      <GroupNamesEditor names={names} onChange={setNames} disabled={busy} />
      <div className="row">
        <button className="primary" disabled={busy || !changed || !!problem} onClick={() => void act(() => saveGroupNames(data.event!.id, tidy))}>
          {t("Save names", "Enregistrer les noms")}
        </button>
        {changed && (
          <button type="button" disabled={busy} onClick={() => setNames(Array.from({ length: count }, (_, i) => saved[i] ?? ""))}>
            {t("Undo changes", "Annuler les modifications")}
          </button>
        )}
      </div>
    </div>
  );
}
