import { useEffect, useState } from "react";
import {
  cancelInvite,
  fetchEntryCode,
  fetchTeamInvites,
  inviteToTeam,
  leaveTeam,
  parseLogins,
  renameTeam,
  withdrawTeam,
  type EventDetail,
  type InviteRow,
  type TeamRow,
} from "../../lib/tournament/api";
import { useT } from "../../lib/language";

interface Props {
  event: EventDetail;
  team: TeamRow;
  userId: string;
  reload: () => void;
}

/**
 * The player's own team while signup is open: who is on it, who has been invited, and - for the
 * captain - the controls to change any of that.
 *
 * What a captain can do is decided by the database, not here. The buttons appear for the captain
 * because it would be pointless to show them to anyone else, but a tampered page would only be
 * sending requests the server refuses.
 */
export function MyTeamPanel({ event, team, userId, reload }: Props) {
  const t = useT();
  const isCaptain = team.captain_user_id === userId;
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState(team.name);
  const [more, setMore] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Invitations and the entry code are the captain's to read; a teammate would only be refused.
  useEffect(() => {
    if (!isCaptain) return;
    let cancelled = false;
    void (async () => {
      try {
        const [inv, c] = await Promise.all([fetchTeamInvites(team.id), fetchEntryCode(team.id)]);
        if (cancelled) return;
        setInvites(inv);
        setCode(c);
      } catch {
        // Nothing to show is not an error worth interrupting the page for.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isCaptain, team.id, team.status, team.roster.length]);

  // A rename typed and saved elsewhere should not be clobbered by a stale field.
  useEffect(() => setName(team.name), [team.name]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMore("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      reload();
    }
  }

  const pending = invites.filter((i) => i.status === "pending");
  const spare = event.max_roster - team.roster.length - pending.length;
  const named = parseLogins(more);
  const short = Math.max(0, event.team_size - team.roster.length);

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, border: "none", padding: 0 }}>{t("Your team", "Votre équipe")}</h3>
        {team.status === "approved" ? (
          <span className="badge badge--good">{t("approved", "approuvée")}</span>
        ) : (
          <span className="badge badge--warn">{t("waiting for approval", "en attente d'approbation")}</span>
        )}
      </div>

      {error && <div className="error-text">{error}</div>}

      {isCaptain ? (
        <div className="row">
          <input style={{ flex: 1, minWidth: "10rem" }} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <button disabled={busy || name.trim() === team.name || name.trim().length < 2} onClick={() => void act(() => renameTeam(team.id, name.trim()))}>
            {t("Rename", "Renommer")}
          </button>
        </div>
      ) : (
        <strong style={{ fontSize: "1.1rem" }}>{team.name}</strong>
      )}

      <p className="muted" style={{ margin: 0 }}>
        {team.status === "approved"
          ? short === 0
            ? t("You're in. Your team is full and approved.", "Vous êtes inscrits. Votre équipe est complète et approuvée.")
            : t(
                `You're approved, but the team needs ${short} more player${short === 1 ? "" : "s"} before it can play.`,
                `Vous êtes approuvés, mais il manque ${short} joueur(s) avant de pouvoir jouer.`,
              )
          : t(
              "An administrator will look over your team and approve it.",
              "Un administrateur examinera votre équipe et l'approuvera.",
            )}
      </p>

      <div>
        <div className="muted" style={{ marginBottom: "0.2rem" }}>
          {t("Roster", "Équipe")} ({team.roster.length}/{event.max_roster})
        </div>
        <div className="t-list">
          {team.roster.map((m) => (
            <div className="t-item" key={m.user_id}>
              <span>
                {m.display_name}
                {m.is_captain && <span className="badge" style={{ marginLeft: "0.4rem" }}>{t("captain", "capitaine")}</span>}
                {m.user_id === userId && !m.is_captain && <span className="muted"> ({t("you", "vous")})</span>}
              </span>
              {!m.is_captain && (m.user_id === userId || isCaptain) && (
                <button
                  disabled={busy}
                  style={{ padding: "0.2rem 0.6rem", fontSize: "0.8rem" }}
                  onClick={() => void act(() => leaveTeam(team.id, m.user_id))}
                >
                  {m.user_id === userId ? t("Leave", "Quitter") : t("Remove", "Retirer")}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {isCaptain && invites.some((i) => i.status !== "accepted") && (
        <div>
          <div className="muted" style={{ marginBottom: "0.2rem" }}>{t("Invitations", "Invitations")}</div>
          <div className="t-list">
            {invites.filter((i) => i.status !== "accepted").map((i) => (
              <div className="t-item" key={i.id}>
                <span>
                  @{i.twitch_login}{" "}
                  <span className={`badge ${i.status === "declined" ? "badge--bad" : ""}`}>
                    {i.status === "pending" ? t("waiting", "en attente") : t("declined", "refusée")}
                  </span>
                </span>
                {i.status === "pending" && (
                  <button disabled={busy} style={{ padding: "0.2rem 0.6rem", fontSize: "0.8rem" }} onClick={() => void act(() => cancelInvite(i.id))}>
                    {t("Withdraw", "Retirer")}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isCaptain && spare > 0 && (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <span className="muted">
            {t(`Invite more players (room for ${spare})`, `Inviter d'autres joueurs (place pour ${spare})`)}
          </span>
          <textarea rows={2} value={more} onChange={(e) => setMore(e.target.value)} placeholder={t("Twitch usernames", "Noms Twitch")} />
          <div>
            <button disabled={busy || named.length === 0} onClick={() => void act(() => inviteToTeam(team.id, named))}>
              {t("Send invitations", "Envoyer les invitations")}
            </button>
          </div>
        </div>
      )}

      {isCaptain && team.status === "approved" && code && (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <span className="muted">{t("Your entry code", "Votre code d'entrée")}</span>
          <div>
            <span className="entry-code">{code}</span>
          </div>
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {t(
              "You'll enter this to start your official matches. Share it with your team, and keep it off stream.",
              "Vous le saisirez pour lancer vos matchs officiels. Partagez-le avec votre équipe, et gardez-le hors du stream.",
            )}
          </span>
        </div>
      )}

      {isCaptain && (
        <div>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t("Withdraw this team from the event?", "Retirer cette équipe de l'événement ?"))) void act(() => withdrawTeam(team.id));
            }}
          >
            {t("Withdraw the team", "Retirer l'équipe")}
          </button>
        </div>
      )}
    </div>
  );
}
