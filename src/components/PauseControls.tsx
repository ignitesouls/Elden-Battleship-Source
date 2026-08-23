import { useEffect, useRef, useState } from "react";
import { usePauseInfo } from "../hooks/useBattlePhase";
import { readyToResume } from "../lib/matchPause";
import { pauseMatch, requestPause, resumeMatch, setPauseReady, settlePause } from "../lib/rooms";
import { playSfx } from "../lib/sfx";
import type { Player, Room } from "../types/battleship";
import "./PauseControls.css";

/**
 * Stopping the match, and asking for it to be stopped.
 *
 * Two exports because the feature lives in two places on screen and neither is optional: the buttons
 * belong in the control column with everything else a player can do, and the notice belongs over the
 * boards, where somebody staring at a square they are about to click will actually see it.
 *
 * Both are always mounted - PauseBanner returns null when there is nothing to say - because the
 * sounds and the host's bookkeeping hang off it, and a component that only mounts once a pause
 * exists is one that cannot announce the pause that created it.
 *
 * Nothing here touches the fire path. Shots keep landing through a pause on purpose; see the note at
 * the top of lib/matchPause.ts for why that is the house rule rather than an oversight.
 */

/** The one instruction anybody has to act on, and the reason the freeze is five seconds late. */
const HOUSE_RULE = "Finish your fight, then quit out.";

interface Props {
  room: Room;
  players: Player[];
  myPlayerId: string;
  isHost: boolean;
}

/** Everyone the resume is waiting on: fleets only, so a spectator cannot hold the room up. */
function crewOf(players: Player[]): Player[] {
  return players.filter((p) => p.team !== null);
}

function outstandingRequests(players: Player[]): Player[] {
  return players.filter((p) => Boolean(p.pause_requested_at));
}

export function PauseControls({ room, players, myPlayerId, isHost }: Props) {
  const pause = usePauseInfo(room);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = players.find((p) => p.id === myPlayerId);
  const onFleet = me != null && me.team !== null;
  const iAmReady = me?.pause_ready === true;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {isHost ? (
        <button
          className={pause.stopped ? "primary" : undefined}
          disabled={busy || pause.phase === "resuming"}
          style={{ width: "100%" }}
          onClick={() => run(() => (pause.phase === "running" ? pauseMatch(room) : resumeMatch(room)))}
        >
          {/* Four states, four labels. "Cancel pause" is the warning window: the clock has not
              actually stopped yet, so calling it off leaves no window to record and no trace. */}
          {pause.phase === "running" && "Pause match"}
          {pause.phase === "pausing" && "Cancel pause"}
          {pause.phase === "paused" && "Resume match"}
          {pause.phase === "resuming" && "Resuming..."}
        </button>
      ) : (
        <button
          disabled={busy || pause.phase !== "running"}
          style={{ width: "100%" }}
          title="Chimes for everyone and puts your name up. The host decides."
          onClick={() => run(() => requestPause(myPlayerId))}
        >
          {/* Still live once a request is in: somebody who has been waiting three minutes should be
              able to say so again, and requestPause writes a fresh timestamp that chimes again. */}
          {me?.pause_requested_at ? "Ask again for a pause" : "Request pause"}
        </button>
      )}

      {/* Readying up is a crew job. A spectating host resumes the match without ever readying, and a
          spectator has nothing to be ready for - the roster in the banner counts fleets only. */}
      {pause.phase === "paused" && onFleet && (
        <button
          className={iAmReady ? undefined : "primary"}
          disabled={busy}
          style={{ width: "100%" }}
          onClick={() => run(() => setPauseReady(myPlayerId, !iAmReady))}
        >
          {iAmReady ? "✓ Ready - stand down" : "Ready up"}
        </button>
      )}

      {error && <div className="error-text">{error}</div>}
    </>
  );
}

export function PauseBanner({ room, players, myPlayerId, isHost }: Props) {
  const pause = usePauseInfo(room);
  const requests = outstandingRequests(players);
  const crew = crewOf(players);

  /**
   * Requests that were already on screen when this mounted.
   *
   * Seeded on the first render rather than left empty, so somebody rejoining mid-pause does not get
   * a chime for an ask that went up before they opened the tab. Only NEW asks make a noise.
   */
  const heard = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = requests.map((p) => `${p.id}|${p.pause_requested_at}`);
    if (heard.current === null) {
      heard.current = new Set(keys);
      return;
    }
    let rang = false;
    for (const key of keys) {
      if (heard.current.has(key)) continue;
      heard.current.add(key);
      rang = true;
    }
    // Once, however many arrived together. Two people asking at the same moment is one interruption.
    if (rang) playSfx("pause");
  }, [requests]);

  /**
   * The two sounds a pause makes, and why they land at opposite ends of their countdowns.
   *
   * The chime opens the pause countdown, because it is a warning: it exists to make somebody who is
   * looking at their own board look up while there are still five seconds to finish a fight in. A
   * warning that arrived as the clock stopped would be too late to act on.
   *
   * The horn closes the resume countdown, on the transition out of `resuming` rather than into it,
   * because it is a starting gun. It is already the sound of a match opening fire (see the
   * status-change effect in pages/Room), and a starting gun five seconds before the start is
   * something else entirely - the room would come back on the horn and find the clock still frozen.
   *
   * The check is against the phase we came FROM, not just the one we are in: `running` is also where
   * a cancelled pause lands, and calling a pause off is not a restart to sound a horn over.
   */
  const lastPhase = useRef(pause.phase);
  useEffect(() => {
    const from = lastPhase.current;
    if (pause.phase === from) return;
    if (pause.phase === "pausing") playSfx("pause");
    if (pause.phase === "running" && from === "resuming") playSfx("prepare");
    lastPhase.current = pause.phase;
  }, [pause.phase]);

  /**
   * Write the finished pause into the log, once, from the host's client alone.
   *
   * Every client already reads a resume_at that has passed as "running again" (see pauseInfoAt), so
   * the clock is right on every screen whether or not this lands. This is what makes it durable -
   * and it is deliberately fire-and-forget: a failure here costs a row in the log, not a stuck room.
   */
  const settling = useRef(false);
  useEffect(() => {
    if (!isHost || settling.current) return;
    if (pause.phase !== "running" || !room.pause_at) return;
    settling.current = true;
    void settlePause(room).finally(() => {
      settling.current = false;
    });
  }, [isHost, pause.phase, room]);

  if (pause.phase === "running") {
    if (requests.length === 0) return null;
    // No pause called yet, but somebody is asking for one. Named rather than counted: the host is
    // deciding whether to stop a match, and "Kaiden" is a far better basis for that than "1".
    return (
      <div className="panel pause-banner">
        <span className="pause-requests">{requestLine(requests)}</span>
        <span className="muted">{isHost ? "Pause match is in the controls." : "Waiting for the host."}</span>
      </div>
    );
  }

  const counting = pause.phase === "pausing" || pause.phase === "resuming";
  const waiting = crew.filter((p) => p.pause_ready !== true);

  return (
    <div className={`panel pause-banner${counting ? " is-counting" : ""}`}>
      <span className="pause-banner-title display">
        {pause.phase === "pausing" && "Pausing in"}
        {pause.phase === "paused" && "Match paused"}
        {pause.phase === "resuming" && "Resuming in"}
      </span>

      {counting && <span className="pause-banner-count">{Math.max(0, Math.ceil(pause.countdown))}</span>}

      {/* Kept up for the whole pause rather than only the countdown: somebody who got into a fight
          AFTER the clock stopped is in exactly the situation this sentence is about. */}
      {pause.phase !== "resuming" && <span className="pause-banner-rule">{HOUSE_RULE}</span>}

      {pause.phase === "paused" && crew.length > 0 && (
        <>
          <div className="pause-roster">
            {crew.map((p) => (
              <span
                key={p.id}
                className={`pause-roster-name${p.pause_ready ? " is-ready" : ""}`}
                title={p.pause_ready ? "Ready" : "Not ready yet"}
              >
                {p.pause_ready ? "✓ " : ""}
                {p.nickname}
                {p.id === myPlayerId ? " (you)" : ""}
              </span>
            ))}
          </div>
          <span className="muted">
            {readyToResume(crew)
              ? isHost
                ? "Everyone is ready. Resume when you are."
                : "Everyone is ready. Waiting for the host."
              : `Waiting on ${waiting.length} ${waiting.length === 1 ? "player" : "players"}.`}
          </span>
        </>
      )}
    </div>
  );
}

/** "Kaiden has requested a pause." - or the two-and-more forms of the same sentence. */
function requestLine(requests: Player[]): string {
  const names = requests.map((p) => p.nickname);
  if (names.length === 1) return `${names[0]} has requested a pause.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} have requested a pause.`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} have requested a pause.`;
}
