import { useEffect, useState } from "react";
import { fetchOfficialFailures, resolveOfficialFailure, type OfficialFailure } from "../../../lib/tournament/api";
import { useT } from "../../../lib/language";
import type { DeskAct } from "./OverduePanel";

/**
 * Official games whose result the bracket could not take.
 *
 * The game itself is never lost: it is archived and counts everywhere else. But when writing its result
 * into the bracket fails - the event was cancelled while the game was in progress, the match had
 * already been decided by hand - the reason is written down here instead of being swallowed. An
 * administrator looks at it, enters the result on the desk if it should stand, and marks it dealt with.
 *
 * Renders nothing when there is nothing to deal with.
 */
export function OfficialFailuresPanel({ act, busy, version }: { act: DeskAct; busy: boolean; version: unknown }) {
  const t = useT();
  const [rows, setRows] = useState<OfficialFailure[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchOfficialFailures()
      .then((r) => !cancelled && setRows(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (rows.length === 0) return null;

  return (
    <div className="panel stack" style={{ borderColor: "rgba(212, 80, 63, 0.7)" }}>
      <h3>{t(`Official results that didn't reach the bracket (${rows.length})`, `Résultats officiels absents du tableau (${rows.length})`)}</h3>
      <span className="muted" style={{ fontSize: "0.78rem" }}>
        {t(
          "The games themselves were archived. Enter any result that should stand from the results list, then mark these as dealt with.",
          "Les parties elles-mêmes ont été archivées. Saisissez tout résultat à conserver depuis la liste des résultats, puis marquez-les comme traités.",
        )}
      </span>
      <div className="t-list">
        {rows.map((row) => (
          <div className="t-item" key={row.id} style={{ alignItems: "flex-start" }}>
            <div className="stack" style={{ gap: "0.1rem", flex: 1, minWidth: "14rem" }}>
              <span>
                <strong>{row.room_code ?? "?"}</strong>{" "}
                <span className="muted" style={{ fontSize: "0.75rem" }}>{new Date(row.created_at).toLocaleString()}</span>
              </span>
              <span className="error-text" style={{ fontSize: "0.82rem" }}>{row.error}</span>
            </div>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await resolveOfficialFailure(row.id);
                  setRows(rows.filter((r) => r.id !== row.id));
                })
              }
            >
              {t("Mark as dealt with", "Marquer comme traité")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
