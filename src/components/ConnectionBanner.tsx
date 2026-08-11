import { useEffect, useState } from "react";

/**
 * Warns when live updates have stopped arriving.
 *
 * Without this a dropped realtime channel is indistinguishable from "nothing is happening" -
 * the board just quietly stops changing and everyone assumes the game froze. The delay before
 * showing it matters as much as the banner itself: brief blips self-heal in well under a
 * second, and flashing a scary red bar on every one of those would train people to ignore it.
 */
export function ConnectionBanner({ connection }: { connection: "connecting" | "online" | "offline" }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (connection === "online") {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(t);
  }, [connection]);

  if (!visible || connection === "online") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 40,
        padding: "0.4rem 0.8rem",
        textAlign: "center",
        fontSize: "0.82rem",
        fontWeight: 600,
        color: "#2a1a05",
        background: "var(--accent)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
      }}
    >
      {connection === "connecting"
        ? "Connecting to the match..."
        : "Connection lost - reconnecting. The board may be out of date."}
    </div>
  );
}
