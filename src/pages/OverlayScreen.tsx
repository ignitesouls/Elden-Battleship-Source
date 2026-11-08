import { useEffect, useRef } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { useCastScreens } from "../hooks/useCastScreens";
import { useScreenAux } from "../lib/castAux";
import { CAST_CANVAS, SEAT_SOURCE, playerGameRect, seatGameSourceRect } from "../lib/castSceneLayout";
import { useCastReceiver } from "../lib/overlayCast";
import { useFrameOnStream, useFramesOnAir } from "../lib/frameBeacon";
import "./OverlayScreen.css";

/**
 * One player box in a casting scene: their muted Twitch stream and nothing over it. The crew colour
 * round the box is the frame source's job (pages/OverlayFrame paints the art's divider strips).
 *
 * -- No text on the box ------------------------------------------------------------------------
 *
 * It used to carry the player's name and a live hit / miss / accuracy tag. That moved to the frame
 * source (pages/OverlayFrame), which draws all six tags itself: one source means one size for every
 * tag, where six sources each scaled differently by OBS gave six different sizes.
 *
 * That includes a caster's talking point (lib/castAux's CARD): the frame draws it over this box's hole.
 * Never here - anything drawn in this page over the Twitch player makes Twitch pause the stream, and
 * the box stays frozen. See useFrameCards.
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
 * -- `?cams=1`: OBS does the cropping ------------------------------------------------------------
 *
 * The current casting scene places this source twice, one item cropped to the gameplay and one to
 * the webcam (seatCamRects in lib/castSceneLayout), so with a cam to show the page draws the player's
 * whole frame and leaves the cutting to OBS. Those crops are fixed, so when there is no cam - no
 * player frame, or the caster switched it off (CastView.camsOff) - the stream is drawn only inside
 * the gameplay item's rectangle. The rest of the page is transparent, so the cam item shows nothing.
 *
 * A scene imported before this has no `?cams=1`, and fills its box exactly as it always did.
 *
 * -- One source per box, driven by `?slot=` --------------------------------------------------
 *
 * The casting scene lays down one of these per seat, all pointed at the CASTER's overlay token and
 * told apart only by `?slot=`. The token resolves the room (overlay_session, via the /stream
 * wrapper); the slot indexes the competitor roster in a stable order - see lib/castScreens. Six
 * separate sources rather than one grid page because a caster wants each box independently
 * refreshable when a stream hitches - which is what lib/castAux's resync is for.
 *
 * -- The empty states -----------------------------------------------------------------------------
 *
 * A missing or out-of-range slot, and a token whose owner is between matches, both draw nothing at
 * all - the same rule every persistent source follows (see pages/StreamSource). A seat that IS
 * filled by an account with no linked Twitch draws a quiet dark panel, so the box is not a hole.
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
  getQuality?(): string;
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
 *
 * -- Only ever set it once per target --------------------------------------------------------------
 *
 * setQuality makes the player rebuffer, and coming out of a rebuffer fires PLAYING - which is one of
 * the events this runs on. Setting it unconditionally there was a loop: set, buffer, PLAYING, set
 * again, forever, with Twitch's dimmed buffering screen over the box the whole time. So it remembers
 * the rung it last asked for (`applied`) and skips a call that would ask for the same one, and skips
 * one the player is already on. A new target - the crop flipping the cap - still goes through, once.
 */
function capQuality(player: TwitchPlayer, maxHeight: number, applied: { current: string | null }): void {
  try {
    const rungs = player.getQualities().filter((q) => q.group && q.group !== "auto");
    if (rungs.length === 0) return;
    const withHeight = rungs.filter((q) => typeof q.height === "number");
    const sized = withHeight.length > 0 ? withHeight : rungs;
    const byHeight = [...sized].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    const capped = byHeight.filter((q) => (q.height ?? 9999) <= maxHeight).pop() ?? byHeight[0];
    if (!capped || capped.group === applied.current) return;
    applied.current = capped.group;
    if (player.getQuality?.() === capped.group) return;
    player.setQuality(capped.group);
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

/** How often a box re-reads its own latency, for the desk's readout. Latency drifts slowly. */
const LATENCY_POLL_MS = 4000;

/**
 * The muted Twitch embed, filling its box - or, `cropped`, showing only the player frame's gameplay
 * hole. Rebuilt on a channel change or a resync (via `key`); cropping only restyles it and moves the
 * quality cap, so the stream never reloads when it flips. `framed` is whether the picture is the
 * player's frame, which is what needs the extra pixels, whoever is doing the cropping.
 */
function TwitchStream({
  channel,
  cropped,
  framed,
  onLatency,
}: {
  channel: string;
  cropped: boolean;
  framed: boolean;
  onLatency: (ms: number | null) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const onLatencyRef = useRef(onLatency);
  onLatencyRef.current = onLatency;
  const playerRef = useRef<TwitchPlayer | null>(null);
  const capRef = useRef(framed ? CAP_CROPPED : CAP_WHOLE);
  capRef.current = framed ? CAP_CROPPED : CAP_WHOLE;
  /** The rung this player was last asked for - see capQuality. Reset with each new player. */
  const appliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (playerRef.current) capQuality(playerRef.current, capRef.current, appliedRef);
  }, [framed]);

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
        appliedRef.current = null;
        const cap = () => player && capQuality(player, capRef.current, appliedRef);
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

/** The screen source's gameplay item, as CSS for this page. */
function gameRegionStyle(slot: number) {
  const r = seatGameSourceRect(slot);
  return {
    left: `${(r.x / SEAT_SOURCE.w) * 100}%`,
    top: `${(r.y / SEAT_SOURCE.h) * 100}%`,
    width: `${(r.w / SEAT_SOURCE.w) * 100}%`,
    height: `${(r.h / SEAT_SOURCE.h) * 100}%`,
  };
}

export function OverlayScreen(props: OverlaySourceProps = {}) {
  const { code, params, owner } = useOverlaySource(props);
  const state = useRoom(code);

  const slotRaw = params.get("slot");
  const slot = slotRaw !== null && slotRaw !== "" ? Number(slotRaw) : NaN;
  const slotKey = Number.isInteger(slot) ? slot : -1;

  const screens = useCastScreens(state.players);
  const screen = Number.isInteger(slot) ? screens.find((s) => s.slot === slot) ?? null : null;

  /** This box's own latency to its broadcaster, in ms, published to the desk by useScreenAux. */
  const latencyRef = useRef<number | null>(null);
  const { resyncNonce } = useScreenAux(code, owner, slotKey, () => latencyRef.current);

  // Only a box with a stream to crop listens for frames.
  const framesOnAir = useFramesOnAir(!!screen?.twitchLogin);
  const framed = useFrameOnStream(!!screen && framesOnAir.has(screen.userId), latencyRef);

  const cams = params.get("cams") === "1";
  const { message } = useCastReceiver(cams ? code : undefined, owner);
  const camOff = !!screen && (message?.view.camsOff ?? []).includes(screen.userId);
  // The whole frame goes to OBS only when there is a cam in it to cut out.
  const wholeFrame = cams && framed && !camOff;

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

  return (
    <div className="ovs">
      <div className="ovs-region" style={cams && !wholeFrame ? gameRegionStyle(slot) : undefined}>
        {screen.twitchLogin ? (
          <TwitchStream
            key={`${screen.twitchLogin}:${resyncNonce}`}
            channel={screen.twitchLogin}
            cropped={framed && !wholeFrame}
            framed={framed}
            onLatency={(ms) => {
              latencyRef.current = ms;
            }}
          />
        ) : (
          <div className="ovs-stream ovs-stream-empty" />
        )}
      </div>
    </div>
  );
}
