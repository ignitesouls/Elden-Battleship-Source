import { useState } from "react";
import { resetRoomToLobby } from "../lib/rooms";

export function EndMatchButton({ roomId, activeTeamsList }: { roomId: string; activeTeamsList: number[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnd() {
    if (!window.confirm("End this match now and send everyone back to the lobby?")) return;
    setBusy(true);
    setError(null);
    try {
      await resetRoomToLobby(roomId, activeTeamsList);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="danger" disabled={busy} onClick={handleEnd} style={{ width: "100%" }}>
        {busy ? "Ending..." : "End match"}
      </button>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}
