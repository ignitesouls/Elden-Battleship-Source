import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePauseInfo } from "../hooks/useBattlePhase";
import { readyToResume, type PauseInfo } from "../lib/matchPause";
import { pauseMatch, requestPause, resumeMatch, setPauseReady, settlePause } from "../lib/rooms";
import { playSfx } from "../lib/sfx";
import { useT } from "../lib/language";
import type { Player, Room } from "../types/battleship";
import "./PauseControls.css";

/**
 * Stopping the match, and asking for it to be stopped.
 *
 * Two exports because the feature lives in two places on screen and neither is optional: the buttons
 * belong in the control column with everything else a player can do, and the notice belongs over the
 * boards, where somebody staring at a square they are about to click will actually see it. Once the
 * match has settled into a pause the notice also carries Ready up, and can be dragged aside and -
 * once you're ready - closed, since by then it is sitting on a board people still want to read.
 *
 * Both are always mounted - PauseBanner returns null when there is nothing to say - because the
 * sounds and the host's bookkeeping hang off it, and a component that only mounts once a pause
 * exists is one that cannot announce the pause that created it.
 *
 * Nothing here touches the fire path. Shots keep landing through a pause on purpose; see the note at
 * the top of lib/matchPause.ts for why that is the house rule rather than an oversight.
 */

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

/**
 * Which pause this screen has closed the banner for, keyed by the room's pause_at.
 *
 * Module-level rather than component state because two components read it - the banner hides, and
 * the control column offers it back - and they are siblings in two different pages. Keying it by
 * pause_at is what makes the next pause open the banner again without anybody having to reset it.
 * Local to this tab on purpose: closing the notice is a personal choice, not something the room sees.
 */
let closedFor: string | null = null;
const closedListeners = new Set<() => void>();

function setClosedFor(pauseAt: string | null) {
  closedFor = pauseAt;
  closedListeners.forEach((fn) => fn());
}

function subscribeClosed(fn: () => void) {
  closedListeners.add(fn);
  return () => closedListeners.delete(fn);
}

/**
 * Closed only while the match sits in `paused`. The resume countdown brings it back regardless: that
 * is the moment somebody tabbed out to the game has to look up, and the horn alone is easy to miss.
 */
function useBannerClosed(room: Room, phase: PauseInfo["phase"]): boolean {
  const current = useSyncExternalStore(subscribeClosed, () => closedFor);
  return phase === "paused" && room.pause_at != null && current === room.pause_at;
}

export function PauseControls({ room, players, myPlayerId, isHost }: Props) {
  const pause = usePauseInfo(room);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const me = players.find((p) => p.id === myPlayerId);
  const closed = useBannerClosed(room, pause.phase);

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
          {pause.phase === "running" && t("Pause match", "Mettre en pause")}
          {pause.phase === "pausing" && t("Cancel pause", "Annuler la pause")}
          {pause.phase === "paused" && t("Resume match", "Reprendre la partie")}
          {pause.phase === "resuming" && t("Resuming...", "Reprise...")}
        </button>
      ) : (
        <button
          disabled={busy || pause.phase !== "running"}
          style={{ width: "100%" }}
          title={t("Chimes for everyone and puts your name up. The host decides.", "Sonne pour tout le monde et affiche votre nom. L'hôte décide.")}
          onClick={() => run(() => requestPause(myPlayerId))}
        >
          {/* Still live once a request is in: somebody who has been waiting three minutes should be
              able to say so again, and requestPause writes a fresh timestamp that chimes again. */}
          {me?.pause_requested_at ? t("Ask again for a pause", "Redemander une pause") : t("Request pause", "Demander une pause")}
        </button>
      )}

      {/* Readying up lives on the banner now, so a player who closed it needs a way back to it -
          otherwise standing down again would mean waiting for the resume countdown to reopen it. */}
      {closed && (
        <button style={{ width: "100%" }} onClick={() => setClosedFor(null)}>
          {t("Show pause screen", "Afficher l'écran de pause")}
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
  const t = useT();

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

  const closed = useBannerClosed(room, pause.phase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * How far the player has dragged the banner off centre, for this pause only.
   *
   * Tagged with the pause_at it was dragged during, so a new pause opens back in the middle without
   * an effect to reset it: an offset from an older pause simply reads as zero.
   */
  const [drag, setDrag] = useState<{ pauseAt: string | null; dx: number; dy: number }>({
    pauseAt: null,
    dx: 0,
    dy: 0,
  });
  const offset = drag.pauseAt === room.pause_at ? drag : { dx: 0, dy: 0 };
  const bannerRef = useRef<HTMLDivElement>(null);
  // Offset and on-screen rect as they were when the grab started; deltas apply to these, the same
  // way CanvasPanel does it, so a fast drag cannot creep away from the cursor.
  const grab = useRef<{ x: number; y: number; dx: number; dy: number; rect: DOMRect } | null>(null);

  function beginDrag(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || !bannerRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = {
      x: e.clientX,
      y: e.clientY,
      dx: offset.dx,
      dy: offset.dy,
      rect: bannerRef.current.getBoundingClientRect(),
    };
  }

  function moveDrag(e: React.PointerEvent<HTMLElement>) {
    const g = grab.current;
    if (!g) return;
    // Clamped so the whole banner stays on screen - a notice dragged off the edge is one nobody can
    // get back, and the close button only exists once you've readied.
    const mx = Math.min(Math.max(e.clientX - g.x, -g.rect.left), window.innerWidth - g.rect.right);
    const my = Math.min(Math.max(e.clientY - g.y, -g.rect.top), window.innerHeight - g.rect.bottom);
    setDrag({ pauseAt: room.pause_at ?? null, dx: g.dx + mx, dy: g.dy + my });
  }

  function endDrag(e: React.PointerEvent<HTMLElement>) {
    grab.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const me = players.find((p) => p.id === myPlayerId);
  const onFleet = me != null && me.team !== null;
  const iAmReady = me?.pause_ready === true;

  async function toggleReady() {
    setBusy(true);
    setError(null);
    try {
      await setPauseReady(myPlayerId, !iAmReady);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (pause.phase === "running") {
    if (requests.length === 0) return null;
    // No pause called yet, but somebody is asking for one. Named rather than counted: the host is
    // deciding whether to stop a match, and "Kaiden" is a far better basis for that than "1".
    return (
      <div className="panel pause-banner">
        <span className="pause-requests">{requestLine(requests, t)}</span>
        <span className="muted">
          {isHost
            ? t("Pause match is in the controls.", "Le bouton de pause est dans les commandes.")
            : t("Waiting for the host.", "En attente de l'hôte.")}
        </span>
      </div>
    );
  }

  if (closed) return null;

  const counting = pause.phase === "pausing" || pause.phase === "resuming";
  const waiting = crew.filter((p) => p.pause_ready !== true);
  // Only a settled pause can be picked up. During the warning countdown people are still firing, and
  // a grip over the board could eat a click; the resume countdown is short and should be looked at.
  const settled = pause.phase === "paused";
  // A spectator has nothing to ready for, so they may close it whenever; the crew once they're ready.
  const canClose = settled && (!onFleet || iAmReady);

  return (
    <div
      ref={bannerRef}
      className={`panel pause-banner${counting ? " is-counting" : ""}`}
      style={{ transform: `translate(calc(-50% + ${offset.dx}px), calc(-50% + ${offset.dy}px))` }}
    >
      {settled && (
        <div className="pause-banner-bar">
          <span
            className="pause-banner-grip"
            title={t("Drag to move", "Glisser pour déplacer")}
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            ⠿
          </span>
          {canClose && (
            <button
              className="pause-banner-close"
              title={t("Close - it comes back for the resume countdown", "Fermer - il revient pour le compte à rebours de reprise")}
              onClick={() => setClosedFor(room.pause_at ?? null)}
            >
              ✕
            </button>
          )}
        </div>
      )}

      <span className="pause-banner-title display">
        {pause.phase === "pausing" && t("Pausing in", "Pause dans")}
        {pause.phase === "paused" && t("Match paused", "Partie en pause")}
        {pause.phase === "resuming" && t("Resuming in", "Reprise dans")}
      </span>

      {counting && <span className="pause-banner-count">{Math.max(0, Math.ceil(pause.countdown))}</span>}

      {/* Kept up for the whole pause rather than only the countdown: somebody who got into a fight
          AFTER the clock stopped is in exactly the situation this sentence is about. */}
      {pause.phase !== "resuming" && (
        <span className="pause-banner-rule">
          {t("Finish your fight, then quit out.", "Terminez votre combat, puis quittez.")}
        </span>
      )}

      {pause.phase === "paused" && crew.length > 0 && (
        <>
          <div className="pause-roster">
            {crew.map((p) => (
              <span
                key={p.id}
                className={`pause-roster-name${p.pause_ready ? " is-ready" : ""}`}
                title={p.pause_ready ? t("Ready", "Prêt") : t("Not ready yet", "Pas encore prêt")}
              >
                {p.pause_ready ? "✓ " : ""}
                {p.nickname}
                {p.id === myPlayerId ? t(" (you)", " (vous)") : ""}
              </span>
            ))}
          </div>
          <span className="muted">
            {readyToResume(crew)
              ? isHost
                ? t("Everyone is ready. Resume when you are.", "Tout le monde est prêt. Reprenez quand vous voulez.")
                : t("Everyone is ready. Waiting for the host.", "Tout le monde est prêt. En attente de l'hôte.")
              : t(
                  `Waiting on ${waiting.length} ${waiting.length === 1 ? "player" : "players"}.`,
                  `En attente de ${waiting.length} joueur${waiting.length === 1 ? "" : "s"}.`
                )}
          </span>
        </>
      )}

      {/* Readying up is a crew job. A spectating host resumes the match without ever readying, and a
          spectator has nothing to be ready for - the roster above counts fleets only. */}
      {settled && onFleet && (
        <button className={`pause-banner-ready${iAmReady ? "" : " primary"}`} disabled={busy} onClick={toggleReady}>
          {iAmReady ? t("✓ Ready - stand down", "✓ Prêt - se retirer") : t("Ready up", "Se préparer")}
        </button>
      )}

      {error && <div className="error-text pause-banner-error">{error}</div>}
    </div>
  );
}

/** "Kaiden has requested a pause." - or the two-and-more forms of the same sentence. */
function requestLine(requests: Player[], t: (en: string, fr: string) => string): string {
  const names = requests.map((p) => p.nickname);
  if (names.length === 1) return t(`${names[0]} has requested a pause.`, `${names[0]} a demandé une pause.`);
  if (names.length === 2)
    return t(
      `${names[0]} and ${names[1]} have requested a pause.`,
      `${names[0]} et ${names[1]} ont demandé une pause.`
    );
  return t(
    `${names.slice(0, -1).join(", ")} and ${names.at(-1)} have requested a pause.`,
    `${names.slice(0, -1).join(", ")} et ${names.at(-1)} ont demandé une pause.`
  );
}
