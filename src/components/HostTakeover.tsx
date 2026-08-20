import { useState } from "react";
import { claimHost } from "../lib/rooms";
import type { Player } from "../types/battleship";

interface Props {
  players: Player[];
  /** Presence, from useRoom. Empty means presence hasn't reported yet, not that everyone is away. */
  onlinePlayerIds: string[];
  myPlayerId: string;
  /** Bar form: no panel of its own, for the spectator's toolbar. */
  inline?: boolean;
}

/**
 * Offers to take over hosting when the current host has gone dark.
 *
 * Lives outside the lobby as well as inside it, which is why it is its own
 * component. The takeover used to be a block inside LobbyPhase, and LobbyPhase only renders at
 * status 'lobby' - so a host who closed their tab MID-MATCH stranded the room completely. Their
 * player row keeps is_host = true, so ensure_room_host (which only fires when nobody at all is
 * host) never promotes a replacement, and the one banner that could have fixed it was on a screen
 * nobody could reach until the match ended. Nothing could end the match. That is a room that stays
 * in 'battle' until someone goes into the database, and there was one.
 *
 * Deliberately NOT gated on the room's status: every phase that has a host button worth pressing -
 * End match, Play again, kick - is a phase where losing the host hurts.
 */
export function HostTakeover({ players, onlinePlayerIds, myPlayerId, inline }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const host = players.find((p) => p.is_host);
  const online = new Set(onlinePlayerIds);
  // onlinePlayerIds.length > 0 guards the moment before presence has reported anything, when an
  // empty set would otherwise read as "everybody is offline" and show this to the whole room at once.
  const hostAbsent = !!host && host.id !== myPlayerId && onlinePlayerIds.length > 0 && !online.has(host.id);

  if (!hostAbsent) return null;

  async function handleClaim() {
    setBusy(true);
    setError(null);
    try {
      await claimHost(myPlayerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const button = (
    <button disabled={busy} onClick={() => void handleClaim()} title="Take over hosting so the room isn't stuck">
      {busy ? "Claiming..." : "Become host"}
    </button>
  );

  if (inline) {
    return (
      <>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          Host <strong>{host?.nickname}</strong> is offline
        </span>
        {button}
        {error && <span className="error-text">{error}</span>}
      </>
    );
  }

  return (
    <div
      className="panel row"
      style={{ justifyContent: "space-between", gap: "0.5rem", borderColor: "var(--accent)" }}
    >
      <span className="muted" style={{ fontSize: "0.85rem" }}>
        The host (<strong>{host?.nickname}</strong>) looks offline. Without a host, nobody can end
        the match or start the next one.
      </span>
      <div className="stack" style={{ gap: "0.25rem", alignItems: "flex-end" }}>
        {button}
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}
