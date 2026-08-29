import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createRoom, joinRoom, fetchLiveBattles, type LiveBattle } from "../lib/rooms";
import { serverNow } from "../lib/serverTime";
import { getLastNickname, storeLastNickname } from "../lib/playerSession";
import { BOARD_SIZE, fleetFor } from "../types/battleship";
import { isSupabaseConfigured } from "../lib/supabase";
import { SiteFooter } from "../components/SiteFooter";
import { useAuthProfile, accountName, saveNickname } from "../hooks/useAuthProfile";
import { NICKNAME_MAX } from "../lib/profiles";
import { formatRoomCode } from "../lib/roomCode";

export function Home() {
  const navigate = useNavigate();
  const [nickname, setNickname] = useState(getLastNickname());
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The matches being fought right now.
   *
   * Polled rather than subscribed. A realtime channel on `rooms` would be live to the second, but
   * it would also be a channel held open by every idle front page on the site - and the front page
   * is the one screen people leave sitting there. Every twenty seconds is well inside the pace this
   * changes at: a match runs for tens of minutes, and the cost of being a few seconds stale is a
   * card that lingers a moment after the last hull goes down.
   *
   * Nothing is fetched while the tab is hidden, for the same reason useRoom stops reading: nobody
   * is looking, and a background tab quietly polling forever is how a free Supabase project's
   * request budget disappears.
   */
  const [live, setLive] = useState<LiveBattle[]>([]);
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;

    const read = () => {
      if (document.visibilityState !== "visible") return;
      void fetchLiveBattles().then((rows) => {
        if (!cancelled) setLive(rows);
      });
    };

    read();
    const timer = setInterval(read, 20_000);
    // So a tab brought back to the front is current immediately, rather than up to 20s behind.
    document.addEventListener("visibilitychange", read);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);

  // A signed-in player's own nickname wins; their Twitch display name is only adopted when they
  // have never chosen one. Typing beats both, for this visit.
  const profile = useAuthProfile();
  const [nicknameTouched, setNicknameTouched] = useState(false);
  const [nicknameSaved, setNicknameSaved] = useState(false);
  const savedName = accountName(profile);
  useEffect(() => {
    if (!nicknameTouched && savedName) setNickname(savedName.slice(0, NICKNAME_MAX));
  }, [savedName, nicknameTouched]);

  /**
   * Remembers the name. For a signed-in player that means their account, so it survives a reload
   * and follows them to another browser; anonymous players only get the localStorage copy, which is
   * all there is to give them.
   */
  async function persistNickname(name: string) {
    storeLastNickname(name);
    if (!profile?.isTwitch) return;
    try {
      await saveNickname(name);
      setNicknameSaved(true);
    } catch (e) {
      setError(`Couldn't save that nickname: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleNicknameBlur() {
    const name = nickname.trim();
    if (nicknameTouched && name) void persistNickname(name);
  }

  async function handleUseTwitchName() {
    setNicknameSaved(false);
    try {
      await saveNickname(null);
      setNicknameTouched(false);
      if (profile?.displayName) {
        setNickname(profile.displayName.slice(0, NICKNAME_MAX));
        storeLastNickname(profile.displayName.slice(0, NICKNAME_MAX));
      }
    } catch (e) {
      setError(`Couldn't clear that nickname: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!nickname.trim()) return setError("Enter a nickname first.");
    setBusy(true);
    setError(null);
    try {
      await persistNickname(nickname.trim());
      // Defaults only. Board size, fleet, squares and prep time are the host's to set in the
      // lobby, where the rest of the room can see them and they can still be changed.
      const { room } = await createRoom(nickname.trim(), BOARD_SIZE, fleetFor(BOARD_SIZE), {
        prepSeconds: 240,
      });
      navigate(`/room/${room.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    if (!nickname.trim()) return setError("Enter a nickname first.");
    if (!joinCode.trim()) return setError("Enter a room code.");
    setBusy(true);
    setError(null);
    try {
      await persistNickname(nickname.trim());
      const { room } = await joinRoom(joinCode.trim(), nickname.trim());
      navigate(`/room/${room.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ width: "min(480px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        {/* Still an h1 - the logo replaces the lettering, not the heading. The alt text is what
            carries the name to screen readers and to anyone whose images haven't loaded, so it's
            the wordmark verbatim rather than a description of the picture.
            Intrinsic size is stated so the page doesn't reflow underneath the join form when the
            art arrives; the CSS overrides the width and keeps the ratio. */}
        <h1>
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="Elden Battleship"
            width={768}
            height={490}
            className="brand-logo"
          />
        </h1>
        <p className="muted">Place your fleet, take aim, sink your rivals.</p>
      </div>

      {!isSupabaseConfigured && (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          <strong>Supabase isn't configured yet.</strong>
          <p className="muted" style={{ marginTop: "0.4rem" }}>
            Copy <code>.env.example</code> to <code>.env.local</code>, fill in your Supabase project's URL and anon
            key, and restart the dev server. See <code>README.md</code> for the full setup steps.
          </p>
        </div>
      )}

      <div className="panel stack">
        <label className="stack" style={{ gap: "0.3rem" }}>
          <span className="muted">Nickname</span>
          <input
            value={nickname}
            onChange={(e) => {
              setNicknameTouched(true);
              setNicknameSaved(false);
              setNickname(e.target.value);
            }}
            onBlur={handleNicknameBlur}
            maxLength={NICKNAME_MAX}
            placeholder="Sir Reginald"
          />
        </label>

        {/* Signed-in players can rename themselves for good, so say where the name goes - silently
            writing to their account would be the wrong kind of surprise. */}
        {profile?.isTwitch && (
          <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", marginTop: "-0.35rem" }}>
            <span className="muted" style={{ fontSize: "0.72rem" }}>
              {nicknameSaved
                ? "Saved - this is your name on any device now."
                : "Kept on your Twitch account, on any device."}
            </span>
            {profile.nickname && profile.displayName && profile.nickname !== profile.displayName && (
              <button
                type="button"
                onClick={() => void handleUseTwitchName()}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontSize: "0.72rem",
                  color: "var(--text-dim)",
                  textDecoration: "underline",
                }}
              >
                Use “{profile.displayName}”
              </button>
            )}
          </div>
        )}

        {error && <div className="error-text">{error}</div>}

        <form onSubmit={handleJoin} className="row">
          <input
            style={{ flex: 1, textTransform: "uppercase" }}
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            // Long enough for the longest word pair plus a numeric suffix ("THUNDERING
            // LEVIATHAN 42"). The old 6 silently truncated anything nautical mid-word.
            maxLength={28}
            placeholder="Room code - e.g. SALTY KRAKEN"
          />
          <button type="submit" disabled={busy || !isSupabaseConfigured}>
            Join
          </button>
        </form>

        <hr style={{ width: "100%", border: "none", borderTop: "1px solid var(--panel-border)" }} />

        {/* Board size, fleet, squares and prep time used to live here, behind a "Match settings"
            disclosure. They belong to the host in the lobby now, where the whole room can see them
            and a wrong choice does not mean abandoning the room to fix it. */}

        <form onSubmit={handleCreate} className="stack">
          <button type="submit" className="primary" disabled={busy || !isSupabaseConfigured}>
            Create new room
          </button>
        </form>
      </div>

      {/* Between creating a room and reading about finished ones, because that is the order of the
          question being asked: is there anything on right now, and if not, what have I missed?
          Renders nothing when the sea is quiet - an empty panel saying "no battles" is a bigger
          thing on the page than the fact deserves. */}
      {live.length > 0 && (
        <div className="panel stack" style={{ gap: "0.45rem" }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h3 style={{ margin: 0 }}>Current battles</h3>
            <span className="muted" style={{ fontSize: "0.7rem" }}>Fighting now</span>
          </div>
          {live.map((b) => (
            <LiveRow key={b.code} battle={b} />
          ))}
        </div>
      )}

      <SiteFooter />
    </div>
  );
}

/**
 * One match in progress, and the way into it.
 *
 * The way in is "Watch", not "Join", and the link carries ?spectate=1 - the same link the lobby
 * hands out as its "Spectator link". Both halves are deliberate. A match already in battle has its
 * fleets placed and locked, so there is no seat to take even if the word invited you to look for
 * one; and routing through the room's own join form means the nickname is collected exactly where
 * it always was, rather than in a second copy of that flow living on the front page.
 */
function LiveRow({ battle }: { battle: LiveBattle }) {
  // serverNow, not Date.now: created_at is a Postgres timestamp, so a skewed PC clock would
  // otherwise report a match that started ten minutes ago as an hour old, or as not yet begun.
  const minutes = Math.max(0, Math.round((serverNow() - new Date(battle.created_at).getTime()) / 60000));

  return (
    <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.82rem" }}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <strong>{formatRoomCode(battle.code)}</strong>
        <div className="muted" style={{ fontSize: "0.7rem" }}>
          {battle.fleets} fleet{battle.fleets === 1 ? "" : "s"} · {battle.players} aboard · opened {minutes}m ago
        </div>
      </span>
      <Link
        to={`/room/${battle.code}?spectate=1`}
        className="link-button"
        style={{ fontSize: "0.72rem", padding: "0.25rem 0.5rem", whiteSpace: "nowrap" }}
        title="Fleets are already placed, so you'll join as a spectator."
      >
        Watch
      </Link>
    </div>
  );
}
