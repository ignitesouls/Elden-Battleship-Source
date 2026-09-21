import { useEffect, useState } from "react";
import { fetchMatchSettings, saveMatchSettings } from "../../../lib/tournament/api";
import { useT } from "../../../lib/language";
import { rulesFrom, type MatchRules } from "../../../lib/tournament/matchRules";
import { MatchRulesEditor } from "../MatchRulesEditor";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

/**
 * The clock official matches are played by. Editable at any point in the event: a change applies to
 * rooms linked from then on, and never to one already linked - a match that has been agreed under one
 * set of rules is not re-timed under another.
 */
export function MatchRulesPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const eventId = data.event?.id;
  const [saved, setSaved] = useState<MatchRules | null>(null);
  const [rules, setRules] = useState<MatchRules | null>(null);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    fetchMatchSettings(eventId)
      .then((s) => {
        if (cancelled) return;
        const r = rulesFrom(s);
        setSaved(r);
        setRules(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!data.event || !rules || !saved) return null;
  if (data.event.status !== "signup" && data.event.status !== "live") return null;
  const changed = rules.prep_seconds !== saved.prep_seconds || rules.starting_seconds !== saved.starting_seconds;

  return (
    <div className="panel stack">
      <h3>{t("Official match rules", "Règles des matchs officiels")}</h3>
      <MatchRulesEditor rules={rules} onChange={setRules} />
      <div className="row">
        <button
          disabled={busy || !changed}
          onClick={() =>
            void act(async () => {
              await saveMatchSettings(data.event!.id, { ...rules });
              setSaved(rules);
            })
          }
        >
          {t("Save", "Enregistrer")}
        </button>
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          {t("Applies to official rooms linked from now on.", "S'applique aux parties officielles liées à partir de maintenant.")}
        </span>
      </div>
    </div>
  );
}
