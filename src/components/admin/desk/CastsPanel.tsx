import { useEffect, useMemo, useState } from "react";
import { decideCast, fetchEventCasts, type EventCastRow } from "../../../lib/tournament/api";
import { useLanguage, useT } from "../../../lib/language";
import { PlayerName } from "../../event/TeamLogo";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

/**
 * Requests to cast an official match, and the casters already approved.
 *
 * Anyone signed in with Twitch can ask from the front page's match card (request_cast refuses the
 * players in the match). Approving puts an "Official cast" button to their Twitch beside the match's
 * Multitwitch link everywhere it shows. A match can have several. Declining an approved caster takes
 * the button away again; a declined caster can't ask again for that match, but an administrator can
 * still approve them from Turned down while the match is waiting to be played.
 *
 * Renders nothing when there's nothing to show.
 */
export function CastsPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const [rows, setRows] = useState<EventCastRow[]>([]);
  const eventId = data.event?.id;

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    fetchEventCasts(eventId)
      .then((r) => !cancelled && setRows(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [eventId, data.stored]);

  // Database id -> the engine's match, for the two teams and the round.
  const byId = useMemo(() => {
    const keyOf = new Map([...(data.stored?.ids ?? [])].map(([key, id]) => [id, key]));
    const byKey = new Map((data.stored?.matches ?? []).map((m) => [m.key, m]));
    return (id: string) => byKey.get(keyOf.get(id) ?? "");
  }, [data.stored]);

  const pending = rows.filter((r) => r.status === "pending");
  const approved = rows.filter((r) => r.status === "approved");
  // Only matches still to be played: decide_cast won't approve anything else, and old ones would pile up.
  const declined = rows.filter((r) => {
    const status = r.status === "declined" ? byId(r.match_id)?.status : undefined;
    return status === "ready" || status === "in_progress";
  });

  if (pending.length + approved.length + declined.length === 0) return null;

  const describe = (row: EventCastRow) => {
    const m = byId(row.match_id);
    const a = m?.a ? data.names.get(m.a) ?? "?" : "?";
    const b = m?.b ? data.names.get(m.b) ?? "?" : "?";
    const agreed = data.stored?.agreed.get(m?.key ?? "");
    const when = agreed
      ? new Date(agreed).toLocaleString(lang === "fr" ? "fr-FR" : undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
    const decided = m && m.status !== "ready" && m.status !== "in_progress";
    return (
      <div className="stack" style={{ gap: "0.1rem", flex: 1, minWidth: "14rem" }}>
        <span>
          <strong><PlayerName name={row.display_name} login={row.twitch_login} /></strong>
          <span className="muted"> {t("to cast", "pour commenter")} </span>
          <strong>{a}</strong> <span className="muted">{t("vs", "contre")}</span> <strong>{b}</strong>
        </span>
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {m && `${t("Round", "Tour")} ${m.phase}`}
          {when && ` · ${when}`}
          {decided && ` · ${t("already played", "déjà joué")}`}
        </span>
      </div>
    );
  };

  return (
    <div className="panel stack">
      <h3>
        {t("Official casters", "Commentateurs officiels")}
        {pending.length > 0 && <span className="badge badge--warn" style={{ marginLeft: "0.5rem" }}>{t(`${pending.length} to review`, `${pending.length} à examiner`)}</span>}
      </h3>
      <span className="muted" style={{ fontSize: "0.78rem" }}>
        {t(
          "Approving puts an \"Official cast\" button to their Twitch beside the match's Multitwitch link, on the front page, the event page and Crew Quarters. A match can have several casters.",
          "Approuver ajoute un bouton « Cast officiel » vers leur Twitch à côté du lien Multitwitch du match, sur la page d'accueil, la page de l'événement et les Quartiers. Un match peut avoir plusieurs commentateurs.",
        )}
      </span>
      {pending.length > 0 && (
        <div className="t-list">
          {pending.map((row) => (
            <div className="t-item" key={row.id} style={{ alignItems: "flex-start" }}>
              {describe(row)}
              <div className="row" style={{ gap: "0.3rem" }}>
                <button className="primary" disabled={busy} onClick={() => void act(() => decideCast(row.id, true))}>{t("Approve", "Approuver")}</button>
                <button className="danger" disabled={busy} onClick={() => void act(() => decideCast(row.id, false))}>{t("Decline", "Refuser")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {approved.length > 0 && (
        <>
          <span className="muted" style={{ fontSize: "0.8rem" }}>{t("Approved", "Approuvés")}</span>
          <div className="t-list">
            {approved.map((row) => (
              <div className="t-item" key={row.id} style={{ alignItems: "flex-start" }}>
                {describe(row)}
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t(`Take ${row.display_name} off as an official caster? They won't be able to ask for this match again, but you can approve them again from Turned down.`, `Retirer ${row.display_name} des commentateurs officiels ? Cette personne ne pourra plus redemander ce match, mais vous pourrez l'approuver à nouveau depuis Refusés.`))) {
                      void act(() => decideCast(row.id, false));
                    }
                  }}
                >
                  {t("Remove", "Retirer")}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {declined.length > 0 && (
        <>
          <span className="muted" style={{ fontSize: "0.8rem" }}>{t("Turned down", "Refusés")}</span>
          <div className="t-list">
            {declined.map((row) => (
              <div className="t-item" key={row.id} style={{ alignItems: "flex-start" }}>
                {describe(row)}
                <button className="primary" disabled={busy} onClick={() => void act(() => decideCast(row.id, true))}>{t("Approve", "Approuver")}</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
