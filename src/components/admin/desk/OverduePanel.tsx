import { useState } from "react";
import { forfeitMatchById } from "../../../lib/tournament/api";
import { useLanguage, useT } from "../../../lib/language";
import { ExtendButtons, ExtendDays } from "./ExtendButtons";
import type { DeskData } from "./useDeskData";

export type DeskAct = (action: () => Promise<unknown>) => Promise<void>;

/**
 * The matches that are past their deadline, and what to do about each.
 *
 * Deadlines are advisory: nothing here (or in the database) forfeits anyone by itself. An overdue match
 * is a line on this list, and the administrator decides - forfeit whoever didn't turn up, give the match
 * (or its whole round) more time, or leave it be. Time can also be given before a deadline, from Results. Chasing the teams is done by hand, in Discord.
 */
export function OverduePanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const [extra, setExtra] = useState(3);
  if (!data.stored || data.overdue.length === 0) return null;

  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });
  const daysLate = (iso: string) => Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));

  return (
    <div className="panel stack" style={{ borderColor: "rgba(212, 80, 63, 0.7)" }}>
      <h3>{t(`Overdue (${data.overdue.length})`, `En retard (${data.overdue.length})`)}</h3>
      <ExtendDays days={extra} onChange={setExtra} />
      <div className="t-list">
        {data.overdue.map((o) => {
          const a = o.entrant_a ? data.names.get(o.entrant_a) ?? "?" : "?";
          const b = o.entrant_b ? data.names.get(o.entrant_b) ?? "?" : "?";
          return (
            <div className="t-item" key={o.match_id} style={{ alignItems: "flex-start" }}>
              <div className="stack" style={{ gap: "0.1rem", flex: 1, minWidth: "14rem" }}>
                <span>
                  <strong>{a}</strong> <span className="muted">{t("vs", "contre")}</span> <strong>{b}</strong>
                </span>
                <span className="muted" style={{ fontSize: "0.78rem" }}>
                  {t(`due ${day(o.due_at)} - ${daysLate(o.due_at)} day(s) late`, `attendu le ${day(o.due_at)} - ${daysLate(o.due_at)} jour(s) de retard`)}
                  {o.agreed_at && ` · ${t("agreed", "convenu")} ${new Date(o.agreed_at).toLocaleString()}`}
                </span>
              </div>
              <div className="row" style={{ gap: "0.3rem" }}>
                <button className="danger" disabled={busy} onClick={() => void act(() => forfeitMatchById(o.match_id, "a"))}>
                  {t(`${a} forfeits`, `${a} déclare forfait`)}
                </button>
                <button className="danger" disabled={busy} onClick={() => void act(() => forfeitMatchById(o.match_id, "b"))}>
                  {t(`${b} forfeits`, `${b} déclare forfait`)}
                </button>
                <ExtendButtons matchId={o.match_id} days={extra} act={act} busy={busy} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
