import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { leaveRoom } from "../lib/rooms";
import { clearActiveRoom, clearStoredPlayerId } from "../lib/playerSession";
import { useT } from "../lib/language";

interface Props {
  playerId: string;
  roomCode: string;
  /**
   * True once the match is underway. Only changes the warning: walking out of a lobby costs
   * nothing, walking out of a battle abandons a fleet that other people are still shooting at.
   */
  inMatch?: boolean;
  label?: string;
  /** Spectators get a quieter confirm - there's no fleet to abandon. */
  spectating?: boolean;
}

/**
 * Leaves the room from anywhere, not just the lobby.
 *
 * Deletes the player row rather than merely navigating away, which is what lets ensure_room_host()
 * notice a room has lost its host and promote somebody else. The stored seat id goes with it so
 * coming back later reads as a fresh join instead of "you were removed".
 */
export function LeaveMatchButton({ playerId, roomCode, inMatch = true, label, spectating = false }: Props) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  async function handleLeave() {
    const warning = spectating
      ? t("Stop spectating and leave this room?", "Arrêter de regarder et quitter cette partie ?")
      : inMatch
        ? t(
            "Leave this match? You give up your seat and the fight carries on without you. Rejoining " +
              "puts you back as a new player, and your fleet stays where it is.",
            "Quitter ce combat ? Vous abandonnez votre place et le combat continue sans vous. En " +
              "revenant, vous serez un nouveau joueur, mais votre flotte restera en place."
          )
        : t("Leave this room?", "Quitter cette partie ?");
    if (!window.confirm(warning)) return;

    setBusy(true);
    setError(null);
    try {
      await leaveRoom(playerId);
      clearStoredPlayerId(roomCode);
      clearActiveRoom(roomCode);
      navigate("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <button disabled={busy} onClick={() => void handleLeave()} style={{ width: "100%", fontSize: "0.8rem" }}>
        {busy
          ? t("Leaving...", "Départ en cours...")
          : (label ?? (spectating ? t("Leave room", "Quitter la partie") : t("Leave match", "Quitter le combat")))}
      </button>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}
