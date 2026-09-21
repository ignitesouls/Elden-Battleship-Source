import { useEffect, useMemo, useState } from "react";
import { formTeamFromPool, placeFromPool, type FreeAgentRow } from "../../../lib/tournament/api";
import { ratingSpread, suggestPairings, type PairingMode } from "../../../lib/tournament/pairing";
import { fetchCareerRatings } from "../../../lib/tournament/ratings";
import { useT } from "../../../lib/language";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

/**
 * Turns the pool of solo signups into teams.
 *
 * It only ever proposes. The draft is shown as a set of editable teams - rename them, and nothing exists
 * until "Create" is pressed for a team (or for all of them). Before an event starts a draft can make new
 * teams and top up short ones; once it is running the bracket is already built from the teams that
 * exist, so only top-ups are possible, and the draft is limited to those.
 *
 * "Balanced" deals players out by career record, smoothed so a newcomer with one win does not outrank a
 * veteran. Players with no games are treated as average.
 */
export function PairingPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const { event } = data;
  const waiting = useMemo(() => data.agents.filter((a) => a.status === "waiting"), [data.agents]);
  const [ratings, setRatings] = useState<Map<string, number>>(new Map());
  const [mode, setMode] = useState<PairingMode>("balanced");
  const [round, setRound] = useState(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [manualName, setManualName] = useState("");

  const waitingKey = waiting.map((w) => w.user_id).join(",");
  useEffect(() => {
    if (waiting.length === 0) return;
    let cancelled = false;
    fetchCareerRatings(waiting.map((w) => w.user_id))
      .then((r) => !cancelled && setRatings(r))
      .catch(() => undefined); // a rating is a nicety - the draft still works without one
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey]);

  if (!event || (event.status !== "signup" && event.status !== "live") || event.team_size === 1) return null;
  if (waiting.length === 0) return null;

  const canForm = event.status === "signup";
  const byUser = new Map(waiting.map((w) => [w.user_id, w]));
  const nameOf = (id: string) => byUser.get(id)?.display_name ?? "?";

  // Teams that can take more players: still short of a full team, and in the event.
  const open = data.teams
    .filter((team) => (team.status === "approved" || team.status === "pending") && team.roster.length < event.team_size)
    .map((team) => ({ id: team.id, needs: event.team_size - team.roster.length, name: team.name }));

  const draft = suggestPairings({
    players: waiting.map((w) => ({ id: w.user_id, rating: ratings.get(w.user_id) })),
    // Once the event is running no new teams can be made, so ask for none: a team size larger than the
    // pool means every player either tops up a short team or waits.
    teamSize: canForm ? event.team_size : waiting.length + 1,
    openTeams: open.map((o) => ({ id: o.id, needs: o.needs })),
    mode,
    seed: `${event.id}:${round}`,
  });
  const rate = (id: string) => ratings.get(id) ?? 0.5;
  const teamNameFor = (index: number) => names[`new${index}`] ?? `${t("Team", "Équipe")} ${data.seeded.length + index + 1}`;
  const openName = (id: string) => open.find((o) => o.id === id)?.name ?? "?";

  return (
    <div className="panel stack">
      <h3>{t(`Solo players waiting (${waiting.length})`, `Joueurs solo en attente (${waiting.length})`)}</h3>

      <div className="t-list">
        {waiting.map((w: FreeAgentRow) => (
          <div className="t-item" key={w.id}>
            <label className="row" style={{ gap: "0.5rem" }}>
              {canForm && (
                <input
                  type="checkbox"
                  checked={chosen.has(w.user_id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(w.user_id);
                    else next.delete(w.user_id);
                    setChosen(next);
                  }}
                />
              )}
              <strong>{w.display_name}</strong>
              {ratings.has(w.user_id) ? (
                <span className="badge" title={t("Smoothed career win rate", "Taux de victoire de carrière lissé")}>{Math.round(ratings.get(w.user_id)! * 100)}</span>
              ) : (
                <span className="muted" style={{ fontSize: "0.72rem" }}>{t("no games yet", "aucune partie")}</span>
              )}
            </label>
            {w.note && <span className="muted" style={{ fontSize: "0.78rem" }}>{w.note}</span>}
          </div>
        ))}
      </div>

      <div className="row">
        <label className="row" style={{ gap: "0.4rem" }}>
          <span className="muted">{t("Suggest", "Suggérer")}</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as PairingMode)}>
            <option value="balanced">{t("balanced by career record", "équilibré selon le palmarès")}</option>
            <option value="random">{t("at random", "au hasard")}</option>
          </select>
        </label>
        {mode === "random" && <button onClick={() => setRound(round + 1)}>{t("Draw again", "Tirer à nouveau")}</button>}
      </div>

      {draft.fills.length > 0 && (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <strong>{t("Top up short teams", "Compléter les équipes")}</strong>
          {draft.fills.map((fill) => (
            <div key={fill.teamId} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                <strong>{openName(fill.teamId)}</strong> ← {fill.playerIds.map(nameOf).join(", ")}
              </span>
              <button className="primary" disabled={busy} onClick={() => void act(async () => { for (const id of fill.playerIds) await placeFromPool(fill.teamId, id); })}>
                {t("Place them", "Les placer")}
              </button>
            </div>
          ))}
        </div>
      )}

      {canForm && draft.newTeams.length > 0 && (
        <div className="stack" style={{ gap: "0.5rem" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{t("New teams", "Nouvelles équipes")}</strong>
            <span className="muted" style={{ fontSize: "0.78rem" }}>
              {t("teams within", "équipes à")} {ratingSpread(draft.newTeams, rate).toFixed(2)} {t("of each other", "d'écart")}
            </span>
          </div>
          {draft.newTeams.map((team, index) => (
            <div key={team.join("|")} className="row" style={{ border: "1px solid var(--panel-border)", borderRadius: 8, padding: "0.5rem", justifyContent: "space-between" }}>
              <div className="stack" style={{ gap: "0.25rem", flex: 1, minWidth: "14rem" }}>
                <input value={teamNameFor(index)} onChange={(e) => setNames({ ...names, [`new${index}`]: e.target.value })} maxLength={40} />
                <span className="muted" style={{ fontSize: "0.8rem" }}>{team.map(nameOf).join(", ")}</span>
              </div>
              <button className="primary" disabled={busy || teamNameFor(index).trim().length < 2} onClick={() => void act(() => formTeamFromPool(event.id, teamNameFor(index).trim(), team))}>
                {t("Create", "Créer")}
              </button>
            </div>
          ))}
          {draft.newTeams.length > 1 && (
            <div>
              <button className="primary" disabled={busy} onClick={() => void act(async () => { for (const [i, team] of draft.newTeams.entries()) await formTeamFromPool(event.id, teamNameFor(i).trim(), team); })}>
                {t("Create all of these teams", "Créer toutes ces équipes")}
              </button>
            </div>
          )}
        </div>
      )}

      {draft.leftover.length > 0 && (
        <span className="muted">
          {t("Left waiting this time:", "Restent en attente pour cette fois :")} {draft.leftover.map(nameOf).join(", ")}
        </span>
      )}

      {canForm && (
        <div className="stack" style={{ gap: "0.4rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
          <strong>{t("Or pick the players yourself", "Ou choisissez vous-même les joueurs")}</strong>
          <span className="muted" style={{ fontSize: "0.78rem" }}>
            {t(`Tick players above (${chosen.size} chosen, up to ${event.max_roster}), name the team, and create it.`, `Cochez des joueurs ci-dessus (${chosen.size} choisi(s), jusqu'à ${event.max_roster}), nommez l'équipe, puis créez-la.`)}
          </span>
          <div className="row">
            <input value={manualName} onChange={(e) => setManualName(e.target.value)} maxLength={40} placeholder={t("Team name", "Nom de l'équipe")} />
            <button
              disabled={busy || chosen.size === 0 || manualName.trim().length < 2}
              onClick={() => void act(async () => { await formTeamFromPool(event.id, manualName.trim(), [...chosen]); setChosen(new Set()); setManualName(""); })}
            >
              {t("Create this team", "Créer cette équipe")}
            </button>
          </div>
        </div>
      )}

      {!canForm && (
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {t("The event is running, so new teams can't be formed - only short teams topped up.", "L'événement est en cours : on ne peut plus former de nouvelles équipes, seulement compléter celles qui manquent de joueurs.")}
        </span>
      )}
    </div>
  );
}
