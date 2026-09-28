import { useState } from "react";
import { Link } from "react-router-dom";
import { LoadingScreen } from "../../BrandMark";
import { useT } from "../../../lib/language";
import { tournamentComplete } from "../../../lib/tournament/complete";
import "../../Tournament.css";
import { MatchRulesPanel } from "./MatchRulesPanel";
import { OfficialFailuresPanel } from "./OfficialFailuresPanel";
import { OverduePanel } from "./OverduePanel";
import { PairingPanel } from "./PairingPanel";
import { ResultsPanel } from "./ResultsPanel";
import { StagesPanel } from "./StagesPanel";
import { TeamsPanel } from "./TeamsPanel";
import { useDeskData } from "./useDeskData";

/**
 * The desk an administrator runs an event from, week to week: who is late, results to enter, the next
 * round to draw, the teams and their players.
 *
 * Every panel reads from the same load and every action re-reads all of it, so entering a result moves
 * the standings, the overdue list and the availability of the next round together.
 *
 * Mounted only for an administrator (see pages/AdminEventDesk), and nothing here is what keeps anyone
 * else out: every action is a database function that checks for an administrator itself.
 */
export function DeskView({ eventId }: { eventId: string }) {
  const t = useT();
  const data = useDeskData(eventId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Runs an action, shows the server's own words if it is refused, and refreshes everything either way. */
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      data.reload();
    }
  }

  if (data.loading) return <LoadingScreen>{t("Loading...", "Chargement...")}</LoadingScreen>;
  if (data.error && !data.event) return <div className="panel error-text">{data.error}</div>;
  if (!data.event) return <div className="panel">{t("There is no such event.", "Cet événement n'existe pas.")}</div>;

  const { event, stored, config } = data;
  const matches = stored?.matches ?? [];
  const open = matches.filter((m) => m.status === "ready" || m.status === "in_progress").length;
  const played = matches.filter((m) => m.status === "done").length;
  const complete = config?.format && matches.length > 0 ? tournamentComplete(config.format, matches) : false;

  return (
    <div className="stack" style={{ width: "min(900px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{event.name}</h1>
        <div className="row" style={{ justifyContent: "center" }}>
          {event.is_test && <span className="badge badge--warn" title={t("Only administrators can see this event", "Seuls les administrateurs voient cet événement")}>{t("TEST", "TEST")}</span>}
          <span className={`badge ${event.status === "live" ? "badge--warn" : event.status === "finished" ? "badge--good" : event.status === "cancelled" ? "badge--bad" : ""}`}>{event.status}</span>
          {event.status === "live" && (
            <span className="muted">
              {t(`${played} played · ${open} open · ${matches.length} drawn so far`, `${played} joués · ${open} ouverts · ${matches.length} tirés jusqu'ici`)}
            </span>
          )}
          {event.status === "live" && complete && <span className="badge badge--good">{t("every match is decided", "tous les matchs sont décidés")}</span>}
        </div>
        <div className="row" style={{ justifyContent: "center", marginTop: "0.5rem" }}>
          <Link to="/admin" className="link-button">{t("Back to the admin page", "Retour à l'administration")}</Link>
          <Link to={`/event/${event.id}`} className="link-button">{t("Open the public page", "Ouvrir la page publique")}</Link>
        </div>
      </div>

      {(event.status === "finished" || event.status === "cancelled") && (
        <div className="panel">
          <strong>
            {event.status === "cancelled"
              ? t("This event was cancelled - its bracket is frozen.", "Cet événement a été annulé - son tableau est figé.")
              : event.champion_name
                ? t(`Finished. Champions: ${event.champion_name}.`, `Terminé. Vainqueurs : ${event.champion_name}.`)
                : t("Finished.", "Terminé.")}
          </strong>{" "}
          <span className="muted">
            {event.status === "finished"
              ? t("Results can still be corrected below; correcting the final reopens the event.", "Les résultats peuvent encore être corrigés ci-dessous ; corriger la finale rouvre l'événement.")
              : ""}
          </span>
        </div>
      )}

      {error && <div className="panel error-text">{error}</div>}

      <OfficialFailuresPanel act={act} busy={busy} version={data.stored} />
      <OverduePanel data={data} act={act} busy={busy} />
      <StagesPanel data={data} act={act} busy={busy} />
      {event.status !== "cancelled" && matches.length > 0 && <ResultsPanel data={data} act={act} busy={busy} />}
      <PairingPanel data={data} act={act} busy={busy} />
      <TeamsPanel data={data} act={act} busy={busy} />
      <MatchRulesPanel data={data} act={act} busy={busy} />
    </div>
  );
}
