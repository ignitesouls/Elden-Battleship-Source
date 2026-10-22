import { useCallback, useEffect, useState } from "react";
import { createRoom } from "../lib/rooms";
import { fetchMyCasts, linkCastRoom, type MyCastMatch } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";
import { getLastNickname } from "../lib/playerSession";
import { BOARD_SIZE, fleetFor } from "../types/battleship";
import { useAuthProfile, accountName } from "../hooks/useAuthProfile";
import { useT } from "../lib/language";
import type { DeskTeams } from "./DeskMatchup";

const roomUrl = (code: string, spectate = false) =>
  `${window.location.origin}${import.meta.env.BASE_URL}#/room/${code}${spectate ? "?spectate=1" : ""}`;

/**
 * "Your casts", on the caster desk before there is a room: the official matches this account is
 * approved to cast, each one click from its lobby.
 *
 * Open lobby makes an ordinary room with the caster as its spectating host, links it to the match with
 * no code (link_cast_room - the approval is the permission), opens it in a new tab and puts the two
 * teams on the Starting Soon screen. The desk then follows the caster into the room by itself, as it
 * always has. The captains still enter their own codes in the lobby; nothing here does that for them.
 *
 * A match that already has a lobby - a co-caster's, or one a team opened - offers Join instead, since
 * there can only be one.
 *
 * Read once when the desk opens, and again right before a lobby is made, so a lobby somebody else
 * opened in the meantime is joined rather than duplicated. No polling: the desk sits open for hours.
 */
export function DeskCasts({ tokenOwner, onTeams }: { tokenOwner: string; onTeams: (teams: DeskTeams) => void }) {
  const t = useT();
  const profile = useAuthProfile();
  const [rows, setRows] = useState<MyCastMatch[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Where the lobby is, when the browser wouldn't let the desk open a tab for it. */
  const [blocked, setBlocked] = useState<string | null>(null);

  const signedIn = !!profile?.isTwitch;
  const me = profile?.userId ?? null;

  const refresh = useCallback(async () => {
    const next = await fetchMyCasts();
    setRows(next);
    return next;
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !signedIn) return;
    refresh().catch(() => setRows([]));
  }, [signedIn, me, refresh]);

  if (!signedIn || !rows || rows.length === 0) return null;

  /** Point the tab opened on the click at the lobby, or say where it is if no tab could open. */
  const go = (tab: Window | null, url: string) => {
    if (tab) tab.location.href = url;
    else setBlocked(url);
  };

  async function open(m: MyCastMatch) {
    setMessage(null);
    setBlocked(null);
    setBusy(m.match_id);
    // Opened now, inside the click, so a popup blocker lets it through; pointed at the lobby once it exists.
    const tab = window.open("", "_blank");
    try {
      // Somebody may have opened it since the list was read - join theirs rather than make a second.
      const now = (await refresh()).find((r) => r.match_id === m.match_id);
      if (!now) {
        tab?.close();
        setMessage(t("That match isn't waiting to be played any more.", "Ce match n'attend plus d'être joué."));
        return;
      }
      if (now.room_code) {
        go(tab, roomUrl(now.room_code, true));
        return;
      }
      const nickname = accountName(profile) || getLastNickname() || "Caster";
      const { room } = await createRoom(nickname, BOARD_SIZE, fleetFor(BOARD_SIZE), { prepSeconds: 240 });
      const linked = await linkCastRoom(room.id, m.match_id);
      if (!linked.ok) {
        tab?.close();
        setMessage(linked.error ?? t("That didn't work.", "Ça n'a pas fonctionné."));
        void refresh();
        return;
      }
      onTeams({ match: m.match_id, names: [m.team_a_name, m.team_b_name] });
      go(tab, roomUrl(room.code));
    } catch (e) {
      tab?.close();
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="stack" style={{ gap: "0.5rem" }}>
      <h3>{t("Your casts", "Vos casts")}</h3>
      {me !== tokenOwner && (
        <p className="error-text" style={{ margin: 0, fontSize: "0.85rem" }}>
          {t(
            "This browser is signed in to a different account from your overlay token. The desk follows the token's account into rooms, so sign in here as that account before opening a lobby.",
            "Ce navigateur est connecté à un autre compte que celui de votre jeton d'overlay. Le poste suit le compte du jeton dans les parties, alors connectez-vous ici avec ce compte avant d'ouvrir un lobby."
          )}
        </p>
      )}
      {rows.map((m) => (
        <div key={m.match_id} className="row" style={{ justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
          <span>
            <strong>{m.team_a_name}</strong> <span className="muted">vs.</span> <strong>{m.team_b_name}</strong>
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              {" - "}
              {m.event_name}
              {m.agreed_at ? ` - ${new Date(m.agreed_at).toLocaleString()}` : ""}
            </span>
          </span>
          {m.room_code ? (
            <a className="link-button" href={roomUrl(m.room_code, true)} target="_blank" rel="noreferrer">
              {t("Join lobby", "Rejoindre le lobby")}
            </a>
          ) : (
            <button className="primary" disabled={busy !== null} onClick={() => void open(m)}>
              {busy === m.match_id ? t("Opening...", "Ouverture...") : t("Open lobby", "Ouvrir le lobby")}
            </button>
          )}
        </div>
      ))}
      {message && <span className="error-text">{message}</span>}
      {blocked && (
        <a href={blocked} target="_blank" rel="noreferrer">
          {t("Your lobby is ready - open it", "Votre lobby est prêt - ouvrez-le")}
        </a>
      )}
      <p className="cast-note muted" style={{ margin: 0 }}>
        {t(
          "Open lobby makes the match's room with you as host, watching from spectators, and puts both teams on Starting Soon. Keep that tab open - the host's page runs the lobby. Each team's captain enters their entry code there, then you start the match.",
          "Ouvrir le lobby crée la partie du match avec vous comme hôte, en spectateur, et met les deux équipes sur Bientôt. Gardez cet onglet ouvert - la page de l'hôte fait tourner le lobby. Le capitaine de chaque équipe y saisit son code d'entrée, puis vous lancez le match."
        )}
      </p>
    </section>
  );
}
