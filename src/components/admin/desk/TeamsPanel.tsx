import { useState } from "react";
import { handOverCaptain, reinstateTeam, removeTeam, substitutePlayer, type AdminTeamRow } from "../../../lib/tournament/api";
import { useT } from "../../../lib/language";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

/**
 * The teams in the event, and the changes an administrator makes to them over a month: removing a team
 * that has dropped out, bringing one back, swapping a player for a substitute, handing on a captaincy.
 *
 * All of these are decisions made in Discord and carried out here - captains ask, an administrator
 * decides - so there is no request queue, just the actions. Each is checked by the database function
 * behind it, so a refusal ("that player is already on another team") arrives in its own words.
 */
export function TeamsPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const { event } = data;
  if (!event) return null;
  const editable = event.status === "signup" || event.status === "live";
  const canRemove = event.status === "live";

  return (
    <div className="panel stack">
      <h3>{event.team_size === 1 ? t("Players", "Joueurs") : t("Teams", "Équipes")} ({data.seeded.length})</h3>
      {data.seeded.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t("No approved teams.", "Aucune équipe approuvée.")}</p>
      ) : (
        <div className="t-list">
          {data.seeded.map((team) => (
            <TeamRow key={team.id} team={team} gone={data.departed.has(team.id)} editable={editable} canRemove={canRemove} teamSize={event.team_size} act={act} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}

function TeamRow({
  team, gone, editable, canRemove, teamSize, act, busy,
}: { team: AdminTeamRow; gone: boolean; editable: boolean; canRemove: boolean; teamSize: number; act: DeskAct; busy: boolean }) {
  const t = useT();
  const [swapping, setSwapping] = useState<string | null>(null); // user id being swapped out
  const [login, setLogin] = useState("");

  return (
    <div className="t-item" style={{ alignItems: "flex-start", opacity: gone ? 0.65 : 1 }}>
      <div className="stack" style={{ gap: "0.3rem", flex: 1, minWidth: "14rem" }}>
        <span>
          {team.seed !== null && <span style={{ color: "var(--accent-bright)", fontWeight: 600 }}>#{team.seed} </span>}
          <strong>{team.name}</strong>
          {gone && <span className="badge badge--bad" style={{ marginLeft: "0.4rem" }}>{t("removed from the event", "retirée de l'événement")}</span>}
        </span>

        {teamSize > 1 &&
          team.roster.map((m) => (
            <div key={m.user_id} className="row" style={{ gap: "0.4rem" }}>
              <span className="muted">
                {m.display_name}
                {m.is_captain && <span className="badge" style={{ marginLeft: "0.3rem" }}>{t("captain", "capitaine")}</span>}
              </span>
              {editable && !gone && (
                <>
                  {!m.is_captain && (
                    <button style={{ fontSize: "0.72rem", padding: "0.15rem 0.45rem" }} disabled={busy} onClick={() => void act(() => handOverCaptain(team.id, m.user_id))}>
                      {t("Make captain", "Nommer capitaine")}
                    </button>
                  )}
                  <button style={{ fontSize: "0.72rem", padding: "0.15rem 0.45rem" }} disabled={busy} onClick={() => { setSwapping(swapping === m.user_id ? null : m.user_id); setLogin(""); }}>
                    {t("Substitute", "Remplacer")}
                  </button>
                </>
              )}
            </div>
          ))}

        {swapping && (
          <div className="row" style={{ gap: "0.4rem" }}>
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder={t("Twitch username coming in", "Nom Twitch du remplaçant")} style={{ minWidth: "14rem" }} />
            <button
              className="primary"
              disabled={busy || login.trim().length < 3}
              onClick={() => void act(async () => { await substitutePlayer(team.id, swapping, login); setSwapping(null); setLogin(""); })}
            >
              {t("Swap them in", "Faire le remplacement")}
            </button>
            <button onClick={() => setSwapping(null)}>{t("Cancel", "Annuler")}</button>
            <span className="muted" style={{ fontSize: "0.72rem", flexBasis: "100%" }}>
              {t("They need to have signed in on this site once. The captain has to be handed on first.", "Ils doivent s'être connectés une fois sur ce site. Le capitaine doit d'abord être remplacé.")}
            </span>
          </div>
        )}
      </div>

      {canRemove && (
        <div className="row">
          {gone ? (
            <button disabled={busy} onClick={() => void act(() => reinstateTeam(team.id))}>{t("Reinstate", "Réintégrer")}</button>
          ) : (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t(`Remove ${team.name} from the event? Everything it is due to play is forfeited.`, `Retirer ${team.name} de l'événement ? Tout ce qu'elle doit jouer est perdu par forfait.`))) void act(() => removeTeam(team.id));
              }}
            >
              {t("Remove from the event", "Retirer de l'événement")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
