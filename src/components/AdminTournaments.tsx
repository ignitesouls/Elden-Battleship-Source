import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  adminFreeAgents,
  adminListEvents,
  adminTeams,
  cancelEvent,
  createEvent,
  deleteEvent,
  regenerateEntryCode,
  setEventStatus,
  setTeamStatus,
  type AdminEventRow,
  type AdminTeamRow,
  type FreeAgentRow,
} from "../lib/tournament/api";
import { useT } from "../lib/language";
import "./Tournament.css";

/**
 * The administrators' tournament desk: create an event, open it for signup, look after the teams that
 * sign up, and cancel it if it has to be.
 *
 * Every rule about who may do any of this lives in the database, so nothing here is a security
 * boundary - a page shown to a non-admin would only be sending requests the server refuses. The page
 * that mounts this already keeps it from being shown to them.
 *
 * What it does not do yet, on purpose: start an event (draw the bracket) and enter results. Those need
 * the bracket generator wired in, and are the next piece; until then an event can be created, opened,
 * filled and approved, which is everything up to the start.
 */
export function AdminTournaments() {
  const t = useT();
  const [events, setEvents] = useState<AdminEventRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      // Events that need attention first - open signups, running events, drafts being prepared - and
      // the finished and cancelled ones after them. Newest first within each, so the list stays
      // useful after months of events rather than burying the current one under old results.
      const rank: Record<string, number> = { signup: 0, live: 1, draft: 2, finished: 3, cancelled: 4 };
      const rows = await adminListEvents();
      setEvents([...rows].sort((a, b) => rank[a.status] - rank[b.status] || b.created_at.localeCompare(a.created_at)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEvents([]);
    }
  }, []);
  useEffect(() => void load(), [load]);

  /** Runs an action, shows the server's words if it is refused, and refreshes either way. */
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await load();
    }
  }

  return (
    <div className="panel stack">
      <h3>{t("Tournaments", "Tournois")}</h3>
      {error && <div className="error-text">{error}</div>}

      <NewEventForm busy={busy} act={act} />

      {events === null ? (
        <p className="muted" style={{ margin: 0 }}>{t("Loading...", "Chargement...")}</p>
      ) : events.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t("No events yet. Create one above - it stays hidden from everyone until you open signup.", "Aucun événement pour l'instant. Créez-en un ci-dessus - il reste caché à tous jusqu'à l'ouverture des inscriptions.")}
        </p>
      ) : (
        <div className="stack" style={{ gap: "0.75rem" }}>
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              open={selected === event.id}
              onToggle={() => setSelected(selected === event.id ? null : event.id)}
              busy={busy}
              act={act}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type Act = (action: () => Promise<unknown>) => Promise<void>;

function NewEventForm({ busy, act }: { busy: boolean; act: Act }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamSize, setTeamSize] = useState(2);
  const [subs, setSubs] = useState(1);
  const [maxTeams, setMaxTeams] = useState("");
  const [closes, setCloses] = useState("");

  if (!shown) {
    return (
      <div>
        <button onClick={() => setShown(true)}>{t("New event", "Nouvel événement")}</button>
      </div>
    );
  }

  const valid = name.trim().length >= 3 && teamSize >= 1 && teamSize <= 10 && subs >= 0;

  return (
    <div className="stack" style={{ gap: "0.6rem", border: "1px solid var(--panel-border)", borderRadius: 8, padding: "0.9rem" }}>
      <label className="stack" style={{ gap: "0.25rem" }}>
        <span className="muted">
          {t("Event name - players see \"Sign up for <name> now!\"", "Nom de l'événement - les joueurs voient « Inscrivez-vous à <nom> dès maintenant ! »")}
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("Autumn Cup", "Coupe d'automne")} />
      </label>
      <label className="stack" style={{ gap: "0.25rem" }}>
        <span className="muted">{t("Description (optional)", "Description (facultative)")}</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Team size", "Taille d'équipe")}</span>
          <input type="number" min={1} max={10} value={teamSize} onChange={(e) => setTeamSize(Number(e.target.value))} style={{ width: "5rem" }} />
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Substitutes allowed", "Remplaçants autorisés")}</span>
          <input type="number" min={0} max={6} value={subs} onChange={(e) => setSubs(Number(e.target.value))} style={{ width: "5rem" }} />
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Max teams (blank = no limit)", "Équipes max (vide = illimité)")}</span>
          <input type="number" min={2} value={maxTeams} onChange={(e) => setMaxTeams(e.target.value)} style={{ width: "7rem" }} />
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Signup closes (optional)", "Fin des inscriptions (facultatif)")}</span>
          <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} />
        </label>
      </div>
      <span className="muted" style={{ fontSize: "0.75rem" }}>
        {teamSize === 1
          ? t("Team size 1 makes this an individual event.", "Une taille d'équipe de 1 en fait un événement individuel.")
          : t(`Teams of ${teamSize}, up to ${teamSize + subs} on a roster.`, `Équipes de ${teamSize}, jusqu'à ${teamSize + subs} par effectif.`)}
      </span>
      <div className="row">
        <button
          className="primary"
          disabled={busy || !valid}
          onClick={() =>
            void act(async () => {
              await createEvent({
                name: name.trim(),
                description: description.trim(),
                team_size: teamSize,
                max_roster: teamSize + subs,
                max_entrants: maxTeams ? Number(maxTeams) : null,
                signup_closes_at: closes ? new Date(closes).toISOString() : null,
              });
              setShown(false);
              setName("");
              setDescription("");
              setMaxTeams("");
              setCloses("");
            })
          }
        >
          {t("Create draft", "Créer le brouillon")}
        </button>
        <button onClick={() => setShown(false)}>{t("Cancel", "Annuler")}</button>
      </div>
      <span className="muted" style={{ fontSize: "0.75rem" }}>
        {t("A new event is a draft: only administrators can see it until you open signup.", "Un nouvel événement est un brouillon : seuls les administrateurs le voient tant que vous n'ouvrez pas les inscriptions.")}
      </span>
    </div>
  );
}

function EventCard({ event, open, onToggle, busy, act }: { event: AdminEventRow; open: boolean; onToggle: () => void; busy: boolean; act: Act }) {
  const t = useT();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const badge =
    event.status === "draft" ? <span className="badge">{t("draft", "brouillon")}</span>
    : event.status === "signup" ? <span className="badge badge--good">{t("signup open", "inscriptions ouvertes")}</span>
    : event.status === "live" ? <span className="badge badge--warn">{t("underway", "en cours")}</span>
    : event.status === "finished" ? <span className="badge badge--good">{t("finished", "terminé")}</span>
    : <span className="badge badge--bad">{t("cancelled", "annulé")}</span>;

  const canCancel = event.status === "draft" || event.status === "signup" || event.status === "live";

  return (
    <div style={{ border: "1px solid var(--panel-border)", borderRadius: 8, padding: "0.8rem" }} className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row">
          <strong>{event.name}</strong>
          {badge}
          <span className="muted">
            {event.team_size === 1 ? t("individual", "individuel") : t(`teams of ${event.team_size}`, `équipes de ${event.team_size}`)}
          </span>
        </span>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {t(`${event.team_count} approved`, `${event.team_count} approuvée(s)`)}
          {event.pending_count > 0 && <strong style={{ color: "var(--accent-bright)" }}> · {t(`${event.pending_count} awaiting`, `${event.pending_count} en attente`)}</strong>}
          {event.waiting_count > 0 && ` · ${t(`${event.waiting_count} solo`, `${event.waiting_count} solo`)}`}
        </span>
      </div>

      {event.status === "cancelled" && event.cancel_reason && (
        <span className="muted">{t("Cancelled:", "Annulé :")} {event.cancel_reason}</span>
      )}

      <div className="row">
        <button onClick={onToggle}>{open ? t("Hide teams", "Masquer les équipes") : t("Manage teams", "Gérer les équipes")}</button>
        <Link to={`/event/${event.id}`} className="link-button">{t("Open the page", "Ouvrir la page")}</Link>
        {event.status !== "draft" && (
          <Link to={`/admin/event/${event.id}`} className="link-button">
            {event.status === "signup" ? t("Pair solo players", "Former des équipes") : t("Run the event", "Gérer l'événement")}
          </Link>
        )}

        {event.status === "draft" && (
          <button className="primary" disabled={busy} onClick={() => void act(() => setEventStatus(event.id, "signup"))}>
            {t("Open signup", "Ouvrir les inscriptions")}
          </button>
        )}
        {event.status === "signup" && (
          <Link to={`/admin/event/${event.id}/start`} className="link-button primary">
            {t("Start the event…", "Lancer l'événement…")}
          </Link>
        )}
        {event.status === "signup" && (
          <button disabled={busy} onClick={() => void act(() => setEventStatus(event.id, "draft"))} title={t("Hide it from the public again", "Le cacher à nouveau au public")}>
            {t("Back to draft", "Repasser en brouillon")}
          </button>
        )}
        {event.status === "draft" && (
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t(`Delete "${event.name}" for good?`, `Supprimer « ${event.name} » définitivement ?`))) void act(() => deleteEvent(event.id));
            }}
          >
            {t("Delete", "Supprimer")}
          </button>
        )}
        {canCancel && event.status !== "draft" && !cancelling && (
          <button className="danger" disabled={busy} onClick={() => setCancelling(true)}>
            {t("Cancel event", "Annuler l'événement")}
          </button>
        )}
      </div>

      {cancelling && (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted">
              {t(
                "Reason (optional) - shown on the event's page. Nothing is deleted, and a cancelled event can be reopened.",
                "Motif (facultatif) - affiché sur la page de l'événement. Rien n'est supprimé, et un événement annulé peut être rouvert.",
              )}
            </span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </label>
          <div className="row">
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await cancelEvent(event.id, reason);
                  setCancelling(false);
                  setReason("");
                })
              }
            >
              {t("Cancel it", "Annuler")}
            </button>
            <button onClick={() => setCancelling(false)}>{t("Keep it", "Le garder")}</button>
          </div>
        </div>
      )}

      {open && <TeamManager event={event} busy={busy} act={act} />}
    </div>
  );
}

function TeamManager({ event, busy, act }: { event: AdminEventRow; busy: boolean; act: Act }) {
  const t = useT();
  const [teams, setTeams] = useState<AdminTeamRow[] | null>(null);
  const [agents, setAgents] = useState<FreeAgentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tm, fa] = await Promise.all([adminTeams(event.id), adminFreeAgents(event.id)]);
      setTeams(tm);
      setAgents(fa.filter((f) => f.status === "waiting"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTeams([]);
    }
  }, [event.id]);
  // Reloaded whenever the event list is (its counts change when a team is approved).
  useEffect(() => void load(), [load, event.team_count, event.pending_count, event.waiting_count]);

  /** An action on one team, then a reload of this list as well as the event list above. */
  const onTeam = (action: () => Promise<unknown>) => act(async () => { await action(); await load(); });

  if (teams === null) return <p className="muted" style={{ margin: 0 }}>{t("Loading...", "Chargement...")}</p>;

  const order = { pending: 0, approved: 1, rejected: 2, withdrawn: 3 } as const;
  const sorted = [...teams].sort((a, b) => order[a.status] - order[b.status]);
  const short = (team: AdminTeamRow) => Math.max(0, event.team_size - team.roster.length);

  return (
    <div className="stack" style={{ gap: "0.6rem" }}>
      {error && <div className="error-text">{error}</div>}
      {sorted.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t("Nobody has signed up yet.", "Personne ne s'est encore inscrit.")}</p>
      ) : (
        <div className="t-list">
          {sorted.map((team) => (
            <div className="t-item" key={team.id} style={{ alignItems: "flex-start" }}>
              <div className="stack" style={{ gap: "0.15rem", flex: 1, minWidth: "14rem" }}>
                <span>
                  <strong>{team.name}</strong>{" "}
                  {team.status === "pending" && <span className="badge badge--warn">{t("awaiting approval", "en attente")}</span>}
                  {team.status === "approved" && <span className="badge badge--good">{t("approved", "approuvée")}</span>}
                  {team.status === "rejected" && <span className="badge badge--bad">{t("rejected", "refusée")}</span>}
                  {team.status === "withdrawn" && <span className="badge">{t("withdrawn", "retirée")}</span>}
                  {event.team_size > 1 && short(team) > 0 && team.status !== "rejected" && team.status !== "withdrawn" && (
                    <span className="badge badge--warn" style={{ marginLeft: "0.3rem" }}>
                      {t(`${short(team)} short`, `il manque ${short(team)}`)}
                    </span>
                  )}
                </span>
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  {team.roster.map((m) => m.display_name + (m.is_captain ? " (c)" : "")).join(", ")}
                </span>
                {team.entry_code && (
                  <span>
                    <span className="muted" style={{ fontSize: "0.75rem" }}>{t("entry code", "code d'entrée")} </span>
                    <span className="entry-code" style={{ fontSize: "1rem" }}>{team.entry_code}</span>
                  </span>
                )}
              </div>
              <div className="row" style={{ gap: "0.4rem" }}>
                {team.status === "pending" && (
                  <>
                    <button className="primary" disabled={busy} onClick={() => void onTeam(() => setTeamStatus(team.id, "approved"))}>{t("Approve", "Approuver")}</button>
                    <button className="danger" disabled={busy} onClick={() => void onTeam(() => setTeamStatus(team.id, "rejected"))}>{t("Reject", "Refuser")}</button>
                  </>
                )}
                {team.status === "approved" && (
                  <>
                    <button disabled={busy} onClick={() => void onTeam(async () => { await regenerateEntryCode(team.id); })} title={t("Issue a new code if it was lost or leaked", "Émettre un nouveau code s'il a été perdu ou divulgué")}>
                      {t("New code", "Nouveau code")}
                    </button>
                    <button disabled={busy} onClick={() => void onTeam(() => setTeamStatus(team.id, "pending"))}>{t("Back to pending", "Remettre en attente")}</button>
                  </>
                )}
                {team.status === "rejected" && (
                  <button disabled={busy} onClick={() => void onTeam(() => setTeamStatus(team.id, "pending"))}>{t("Reconsider", "Réexaminer")}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {agents.length > 0 && (
        <div>
          <div className="muted" style={{ marginBottom: "0.2rem" }}>
            {t(`Solo players waiting for a team (${agents.length})`, `Joueurs solo en attente d'une équipe (${agents.length})`)}
          </div>
          <div className="t-list">
            {agents.map((a) => (
              <div className="t-item" key={a.id}>
                <strong>{a.display_name}</strong>
                {a.note && <span className="muted" style={{ fontSize: "0.8rem" }}>{a.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
