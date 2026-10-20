import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { useCastScreens } from "../hooks/useCastScreens";
import { useScreenAux } from "../lib/castAux";
import { groupIntoShots } from "../lib/attackFeed";
import { buildPlayerStats } from "../lib/matchReport";
import { teamHex, teamName } from "../lib/teamColors";
import { CAST_CANVAS, playerGameRect } from "../lib/castSceneLayout";
import { useFramesOnAir } from "../lib/frameBeacon";
import "./OverlayScreen.css";

/**
 * One player box in a casting scene: their muted Twitch stream inside a border in their crew's
 * colour, their name in the top-right corner in that colour, and a live hit / miss / accuracy line.
 *
 * -- Cropping to the gameplay ------------------------------------------------------------------
 *
 * A player streaming our player frame (fire board, fleet and webcam around a 16:9 gameplay hole)
 * would otherwise arrive here as their whole overlay shrunk into a box. When their frame is showing
 * (lib/frameBeacon - nothing to tick) the embed is blown up and shifted so the box shows the
 * gameplay hole only, edge to edge, and the stream is asked for 720p instead of 480p, so the crop
 * still has more pixels than the box. The switch waits out the stream's own delay, so the box
 * changes when the viewer's picture does rather than seconds before it.
 *
 * -- One source per box, driven by `?slot=` --------------------------------------------------
 *
 * The casting scene lays down one of these per seat, all pointed at the CASTER's overlay token and
 * told apart only by `?slot=`. The token resolves the room (overlay_session, via the /stream
 * wrapper); the slot indexes the competitor roster in a stable order - see lib/castScreens. Six
 * separate sources rather than one grid page because a caster wants each box independently
 * refreshable when a stream hitches - which is what lib/castAux's resync is for.
 *
 * -- Why the numbers are read straight from the public log -----------------------------------
 *
 * `attacks` carries `attacker_player_id` and is world-readable, and buildPlayerStats already turns
 * it into the exact per-player scoreboard the recap prints - "at any point in a match", see the note
 * there. So this needs no controller and no relay: it watches the room like the scorebug does and
 * runs the same function, which means the box and the end-of-match recap can never disagree.
 *
 * -- The empty states -----------------------------------------------------------------------------
 *
 * A missing or out-of-range slot, and a token whose owner is between matches, both draw nothing at
 * all - the same rule every persistent source follows (see pages/StreamSource). A seat that IS
 * filled by an account with no linked Twitch draws the name plate and the tally over an empty frame:
 * "player here, stream not linked" is a real state and better said than hidden.
 */

interface TwitchQuality {
  group: string;
  height?: number;
}

interface TwitchPlaybackStats {
  /** Seconds the viewer is behind the broadcaster. Absent until playback is going. */
  hlsLatencyBroadcaster?: number;
}

interface TwitchPlayer {
  setQuality(group: string): void;
  getQualities(): TwitchQuality[];
  getPlaybackStats?(): TwitchPlaybackStats | null;
  addEventListener(event: string, listener: () => void): void;
  destroy?(): void;
}

interface TwitchNamespace {
  Player: {
    new (el: HTMLElement, options: Record<string, unknown>): TwitchPlayer;
    PLAYING: string;
    READY: string;
  };
}

const EMBED_SRC = "https://player.twitch.tv/js/embed/v1.js";

/** Load the Twitch embed API once for the whole document, however many boxes ask for it. */
let embedScript: Promise<void> | null = null;
function loadTwitchEmbed(): Promise<void> {
  if (embedScript) return embedScript;
  embedScript = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${EMBED_SRC}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = EMBED_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Twitch embed script failed to load"));
    document.head.appendChild(script);
  });
  return embedScript;
}

function twitch(): TwitchNamespace | null {
  return (window as unknown as { Twitch?: TwitchNamespace }).Twitch ?? null;
}

/** The quality cap for a whole-stream box, and for one cropped to the gameplay hole. */
const CAP_WHOLE = 480;
const CAP_CROPPED = 720;

/**
 * Cap the player at a low-but-legible rung so six of these on one PC do not melt it.
 *
 * The highest rung at or below `maxHeight`, or failing that the lowest real rung. `auto` is left off
 * the table deliberately - it climbs to source on a good connection, which is exactly what a wall of
 * boxes cannot afford. Best-effort throughout: a throw here just leaves the stream on `auto`.
 */
function capQuality(player: TwitchPlayer, maxHeight: number): void {
  try {
    const rungs = player.getQualities().filter((q) => q.group && q.group !== "auto");
    if (rungs.length === 0) return;
    const withHeight = rungs.filter((q) => typeof q.height === "number");
    const sized = withHeight.length > 0 ? withHeight : rungs;
    const byHeight = [...sized].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    const capped = byHeight.filter((q) => (q.height ?? 9999) <= maxHeight).pop() ?? byHeight[0];
    if (capped) player.setQuality(capped.group);
  } catch {
    /* quality control is a nice-to-have, not a reason to break the box */
  }
}

/**
 * Where the gameplay hole sits in the player frame, as the CSS that blows the embed up around it:
 * the embed is made as much wider than the box as the canvas is than the hole, kept 16:9, and moved
 * up and left by the hole's corner - in its own size, which is what translate's percentages are.
 */
const GAME = playerGameRect();
const CROP_STYLE = {
  ["--ovs-crop-w" as string]: `${(CAST_CANVAS.w / GAME.w) * 100}%`,
  ["--ovs-crop-x" as string]: `${(-GAME.x / CAST_CANVAS.w) * 100}%`,
  ["--ovs-crop-y" as string]: `${(-GAME.y / CAST_CANVAS.h) * 100}%`,
};

/** Twitch's delay when the box can't read it yet - near the low end of what a player's stream runs. */
const DEFAULT_DELAY_MS = 4000;

/** How often a box re-reads its own latency, for the desk's readout. Latency drifts slowly. */
const LATENCY_POLL_MS = 4000;

/**
 * The muted Twitch embed, filling its box - or, `cropped`, showing only the player frame's gameplay
 * hole. Rebuilt on a channel change or a resync (via `key`); cropping only restyles it and moves the
 * quality cap, so the stream never reloads when it flips.
 */
function TwitchStream({
  channel,
  cropped,
  onLatency,
}: {
  channel: string;
  cropped: boolean;
  onLatency: (ms: number | null) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const onLatencyRef = useRef(onLatency);
  onLatencyRef.current = onLatency;
  const playerRef = useRef<TwitchPlayer | null>(null);
  const capRef = useRef(cropped ? CAP_CROPPED : CAP_WHOLE);
  capRef.current = cropped ? CAP_CROPPED : CAP_WHOLE;

  useEffect(() => {
    if (playerRef.current) capQuality(playerRef.current, capRef.current);
  }, [cropped]);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    let disposed = false;
    let player: TwitchPlayer | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    void loadTwitchEmbed()
      .then(() => {
        const T = twitch();
        if (disposed || !T) return;
        player = new T.Player(holder, {
          channel,
          // Whatever host this page is served from IS the correct embed parent - the deployed
          // Pages domain in a browser source, `localhost` in dev. Nothing to hardcode.
          parent: [window.location.hostname],
          // The popout player - the bare POV, as at player.twitch.tv/?channel=x&player=popout. The
          // embed script copies every option into the iframe's query string, so this rides along.
          player: "popout",
          muted: true,
          autoplay: true,
          controls: false,
          width: "100%",
          height: "100%",
        });
        playerRef.current = player;
        const cap = () => player && capQuality(player, capRef.current);
        player.addEventListener(T.Player.PLAYING, cap);
        player.addEventListener(T.Player.READY, cap);

        poll = setInterval(() => {
          try {
            const stats = player?.getPlaybackStats?.();
            const secs = stats?.hlsLatencyBroadcaster;
            onLatencyRef.current(typeof secs === "number" && secs > 0 ? secs * 1000 : null);
          } catch {
            onLatencyRef.current(null);
          }
        }, LATENCY_POLL_MS);
      })
      .catch(() => {
        /* no embed script, no stream - the name plate still stands */
      });

    return () => {
      disposed = true;
      playerRef.current = null;
      if (poll) clearInterval(poll);
      onLatencyRef.current(null);
      try {
        player?.destroy?.();
      } catch {
        /* */
      }
      holder.innerHTML = "";
    };
  }, [channel]);

  return <div className={cropped ? "ovs-stream ovs-stream--game" : "ovs-stream"} style={cropped ? CROP_STYLE : undefined} ref={holderRef} />;
}

/**
 * Whether the box should be cropped now: the frame's showing, as the VIEWER sees it. Presence moves
 * the instant a player switches scene, but their stream shows the switch only after its delay, so a
 * change is held back by that delay - the box's own measured latency, or a typical one until known.
 */
function useDelayedCrop(onAir: boolean, latencyRef: React.RefObject<number | null>): boolean {
  const [cropped, setCropped] = useState(onAir);
  useEffect(() => {
    if (onAir === cropped) return;
    const timer = setTimeout(() => setCropped(onAir), latencyRef.current ?? DEFAULT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [onAir, cropped, latencyRef]);
  return cropped;
}

export function OverlayScreen(props: OverlaySourceProps = {}) {
  const { code, params } = useOverlaySource(props);
  const state = useRoom(code);

  const slotRaw = params.get("slot");
  const slot = slotRaw !== null && slotRaw !== "" ? Number(slotRaw) : NaN;
  const slotKey = Number.isInteger(slot) ? slot : -1;

  const screens = useCastScreens(state.players);
  const screen = Number.isInteger(slot) ? screens.find((s) => s.slot === slot) ?? null : null;

  /** This box's own latency to its broadcaster, in ms, published to the desk by useScreenAux. */
  const latencyRef = useRef<number | null>(null);
  const resyncNonce = useScreenAux(code, slotKey, () => latencyRef.current);

  const shots = useMemo(
    () => groupIntoShots(state.attacks, state.players),
    [state.attacks, state.players]
  );
  const stats = useMemo(() => buildPlayerStats(state.players, shots), [state.players, shots]);
  const mine = screen ? stats.find((s) => s.playerId === screen.playerId) ?? null : null;

  // Only a box with a stream to crop listens for frames.
  const framesOnAir = useFramesOnAir(!!screen?.twitchLogin);
  const cropped = useDelayedCrop(!!screen && framesOnAir.has(screen.userId), latencyRef);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  // Nothing to draw is the right picture on a stream: an unfilled slot, or a source that has
  // outlived the match it was pointed at. Never the last match's box.
  if (!screen) return null;

  const label = screen.name ?? teamName(screen.team);
  const accent = teamHex(screen.team);
  const hits = mine?.hits ?? 0;
  const misses = mine?.misses ?? 0;
  const accuracy = mine ? Math.round(mine.accuracy * 100) : 0;

  return (
    <div className="ovs" style={{ ["--ovs-accent" as string]: accent }}>
      {screen.twitchLogin ? (
        <TwitchStream
          key={`${screen.twitchLogin}:${resyncNonce}`}
          channel={screen.twitchLogin}
          cropped={cropped}
          onLatency={(ms) => {
            latencyRef.current = ms;
          }}
        />
      ) : (
        <div className="ovs-stream ovs-stream-empty" />
      )}

      <span className="ovs-name">{label}</span>
      <div className="ovs-plate">
        <span className="ovs-stats">
          <span className="ovs-stat">H- {hits}</span>
          <span className="ovs-stat">M- {misses}</span>
          <span className="ovs-stat">A- {accuracy}%</span>
        </span>
      </div>
      <div className="ovs-border" />
    </div>
  );
}
