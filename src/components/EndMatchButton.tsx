import { useState } from "react";
import { resetRoomToLobby } from "../lib/rooms";
import { useT } from "../lib/language";

export function EndMatchButton({ roomId }: { roomId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  async function handleEnd() {
    if (
      !window.confirm(
        t(
          "End this match now and send everyone back to the lobby?",
          "Terminer cette partie maintenant et renvoyer tout le monde au lobby ?"
        )
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await resetRoomToLobby(roomId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="danger" disabled={busy} onClick={handleEnd} style={{ width: "100%" }}>
        {busy ? t("Ending...", "Fin en cours...") : t("End match", "Terminer la partie")}
      </button>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}
