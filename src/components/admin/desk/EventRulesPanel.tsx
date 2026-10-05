import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { saveExtraRules } from "../../../lib/tournament/api";
import { useT } from "../../../lib/language";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

/**
 * What this event adds to the shared rulebook. Shown above it on the event's rules page and taking
 * precedence over it, so a house rule never means editing the rulebook every event shares.
 *
 * Editable in any state: a ruling made mid-event belongs where players will read it.
 */
export function EventRulesPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const saved = data.event?.extra_rules ?? "";
  const [text, setText] = useState(saved);

  // Follows the saved text when it changes (after a save, or the first load). Other desk actions re-read
  // the same string, which does not re-run this, so unsaved edits survive them.
  useEffect(() => setText(saved), [saved]);

  if (!data.event) return null;
  const changed = text.trim() !== saved.trim();

  return (
    <div className="panel stack">
      <h3>{t("Rules for this event", "Règles propres à cet événement")}</h3>
      <span className="muted" style={{ fontSize: "0.8rem" }}>
        {t(
          "Every event shows the shared rulebook, with its crew size, clock, board and format filled in. Anything written here appears above it and takes precedence.",
          "Chaque événement affiche le règlement commun, avec sa taille d'équipe, son horloge, son plateau et son format. Ce qui est écrit ici apparaît au-dessus et prévaut.",
        )}
      </span>
      <textarea rows={6} value={text} maxLength={20000} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button disabled={busy || !changed} onClick={() => void act(() => saveExtraRules(data.event!.id, text.trim()))}>
          {t("Save", "Enregistrer")}
        </button>
        <Link to={`/event/${data.event.id}/rules`} className="link-button">
          {t("Open the rules page", "Ouvrir le règlement")}
        </Link>
      </div>
    </div>
  );
}
