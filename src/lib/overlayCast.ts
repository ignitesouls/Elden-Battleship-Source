import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { ShipPlacement } from "../types/battleship";

/**
 * The link between a caster's control page and their OBS browser sources.
 *
 * -- Why a broadcast channel rather than the database ------------------------------------------
 *
 * The board source has to be able to draw EVERY fleet's ships, and it is the one context in the
 * app that can never be allowed to read them: an OBS Browser Source is a fresh browser with no
 * saved session, so it authenticates as an anonymous stranger who belongs to no team, and RLS
 * correctly hands it nothing. That is the same wall `overlay_fleet` was built to get one team's own
 * hulls past, with a per-room key.
 *
 * Widening that RPC to "every fleet, for anyone holding a key" would mean a credential that reveals
 * the whole board, living in a URL, pasted into a tool that stores it in plain text - and a new
 * migration to create it.
 *
 * So the ships don't travel that way at all. The CONTROL PAGE is an ordinary logged-in spectator
 * whose session RLS already trusts with every fleet (see "fleets select by spectator"), and it
 * relays what it can see down a Realtime broadcast channel to its own browser sources. The board
 * source needs no credential because it is never trusted with one: it renders what its caster sends
 * it and nothing else. No new table, no new policy, no key in a URL, and the exposure is exactly
 * the exposure the spectator page already has - one caster, one screen, their own judgement.
 *
 * The trade to know: broadcast is ephemeral. If the control page is closed the sources freeze on
 * the last frame they were sent, which is why HEARTBEAT_MS exists and why the board reports a stale
 * controller rather than pretending. Refreshing a source is safe - it announces itself with `hello`
 * and the controller answers immediately.
 */

/** What the board source is currently showing. */
export interface CastView {
  /**
   * "results" - shots only, no hulls, safe at any time.
   * "all"     - every fleet's ships composited onto the one board.
   * a number  - that single team's ships.
   */
  mode: "results" | "all" | number;
  /** 1 = the whole board fits the source. Above that, `cx`/`cy` decide what stays in frame. */
  zoom: number;
  /** The board point held at the centre of the frame, each 0..1 across the board. */
  cx: number;
  cy: number;
  /** Draw each square's challenge name. The entire reason zoom exists - see OverlayBoard. */
  names: boolean;
  coords: boolean;
  /**
   * How solid the board is on stream, 0.25 to 1.
   *
   * The board is a full-screen-ish element sitting on top of somebody's gameplay, and a caster
   * wants to leave it up through a fight rather than pulling it in and out every thirty seconds.
   * Fading it is what makes that possible: at 0.5 the squares are still readable and the boss the
   * runner is actually fighting is still visible underneath.
   *
   * Optional in practice - a frame sent by an older controller won't carry it, so every reader
   * defaults it rather than trusting it to be there.
   */
  opacity: number;
  /** Hide the board entirely without tearing the source out of the scene. */
  visible: boolean;
}

/** How faint a source may be made before "hidden" is the honest word for it. */
export const MIN_OPACITY = 0.25;

/**
 * `?opacity=` off a source's URL, clamped, defaulting to solid.
 *
 * Shared by all three player-facing sources rather than parsed three times. They are dropped into
 * one scene and usually want the same setting - a streamer fading the board over their gameplay
 * wants the clock and the key to match, and the overlay box writes one slider into all three URLs.
 * One reader means one clamp, so a hand-typed `?opacity=0` can't make one source invisible while
 * another quietly floors at 0.25.
 */
export function readOpacity(params: URLSearchParams): number {
  const raw = params.get("opacity");
  if (raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(MIN_OPACITY, n));
}

export interface CastFleet {
  team: number;
  placements: ShipPlacement[];
}

export interface CastMessage {
  view: CastView;
  /** Empty in "results" mode - the ships are not sent at all rather than sent and not drawn. */
  fleets: CastFleet[];
  /** Wall-clock stamp of the send, so a source can notice its controller has gone quiet. */
  at: number;
}

export const DEFAULT_VIEW: CastView = {
  mode: "results",
  zoom: 1,
  cx: 0.5,
  cy: 0.5,
  names: true,
  coords: true,
  opacity: 1,
  visible: true,
};

/**
 * Zoom bounds. 1 fits the whole board; 2 shows a quarter of it.
 *
 * Capped at 2 deliberately, down from 6. Past 2x a board is a handful of squares and the pan gets
 * twitchy - a small movement of the caster's hand throws a viewer clear across the board, and the
 * thing they were reading is gone before they finished it. 2x is about where the square names stop
 * being the reason to zoom, so it's the useful end of the range rather than an arbitrary limit.
 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2;

const STATE_EVENT = "cast-state";
const HELLO_EVENT = "cast-hello";
/** The source telling its controller how big it is - see SourceSize. */
const SIZE_EVENT = "cast-size";

/**
 * The browser source's own pixel dimensions, reported back to the controller.
 *
 * Without this the control page cannot draw an honest preview. What is actually in frame depends
 * on how large the caster made the source in OBS, which nothing on this side can know - so the
 * source measures itself and says. It is the difference between a viewport rectangle that means
 * something and one that is decoration.
 */
export interface SourceSize {
  w: number;
  h: number;
}

/**
 * Re-send interval.
 *
 * Broadcast has no retained message, so a source that starts up mid-silence would sit blank until
 * the caster next touched a control. `hello` covers the normal case; this covers the ugly ones -
 * a dropped socket, a controller that reconnected, an OBS source restored from a saved scene while
 * the control page was mid-refresh.
 */
const HEARTBEAT_MS = 5000;

/**
 * Shortest gap between two frames on the wire.
 *
 * A drag produces a pointermove per display refresh - 60 to 240 a second - and publishing each one
 * is both pointless and harmful. Realtime rate-limits broadcast (10 messages a second by default),
 * so past that the excess is DROPPED, and what arrives is whatever survived: a few widely spaced
 * positions rather than a smooth run of them. That is what made panning look like it jumped from
 * one part of the board to another instead of sliding.
 *
 * So frames are coalesced to just under the limit and the source interpolates between them - see
 * the transition on .ovb-stage. The last position of a gesture is always sent (the trailing timer
 * below), because the one frame that must never be dropped is where the caster stopped.
 */
const MIN_SEND_GAP_MS = 110;

/** How long without a frame before a source should assume its controller is gone. */
export const STALE_AFTER_MS = 20000;

const channelName = (code: string) => `cast:${code.toUpperCase()}`;

/**
 * Drives the browser sources. Used by the control page only.
 *
 * `publish` is cheap to call on every render of the controller - it stores the frame and sends it,
 * and the sources are idempotent in what they do with it.
 */
export function useCastPublisher(code: string | undefined) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const last = useRef<CastMessage | null>(null);
  const [ready, setReady] = useState(false);
  const [sourceSize, setSourceSize] = useState<SourceSize | null>(null);

  /** When the last frame actually went out, and the trailing send if one is queued. */
  const sentAt = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Sends the stored frame immediately, cancelling anything queued. */
  const push = useCallback(() => {
    if (trailing.current) {
      clearTimeout(trailing.current);
      trailing.current = null;
    }
    const channel = channelRef.current;
    const message = last.current;
    if (!channel || !message) return;
    sentAt.current = Date.now();
    void channel.send({ type: "broadcast", event: STATE_EVENT, payload: { ...message, at: sentAt.current } });
  }, []);

  /**
   * Sends now if enough time has passed, otherwise queues the LATEST frame for when it has.
   *
   * Queued rather than dropped: a caster who stops mid-drag must not leave the stream a hundred
   * pixels from where they aimed, so the final position always goes out even though the dozens
   * before it didn't.
   */
  const pushSoon = useCallback(() => {
    const wait = MIN_SEND_GAP_MS - (Date.now() - sentAt.current);
    if (wait <= 0) {
      push();
      return;
    }
    if (trailing.current) return; // one already queued; it will pick up whatever `last` holds then
    trailing.current = setTimeout(() => {
      trailing.current = null;
      push();
    }, wait);
  }, [push]);

  useEffect(() => {
    if (!code) return;

    // self:false - the controller draws its own preview from its own state and has no use for an
    // echo of what it just sent.
    const channel = supabase.channel(channelName(code), { config: { broadcast: { self: false } } });
    channelRef.current = channel;

    channel
      // A source announcing itself. Answer with the current frame so it fills in at once rather
      // than waiting out the heartbeat with an empty scene on stream.
      .on("broadcast", { event: HELLO_EVENT }, () => push())
      .on("broadcast", { event: SIZE_EVENT }, ({ payload }) => setSourceSize(payload as SourceSize))
      .subscribe((status) => setReady(status === "SUBSCRIBED"));

    const beat = setInterval(push, HEARTBEAT_MS);

    return () => {
      clearInterval(beat);
      if (trailing.current) clearTimeout(trailing.current);
      trailing.current = null;
      channelRef.current = null;
      setReady(false);
      void supabase.removeChannel(channel);
    };
  }, [code, push]);

  const publish = useCallback(
    (message: Omit<CastMessage, "at">) => {
      last.current = { ...message, at: Date.now() };
      pushSoon();
    },
    [pushSoon]
  );

  return { publish, ready, sourceSize };
}

/**
 * Receives frames. Used by the browser sources.
 *
 * Returns null until the first frame lands, which is the honest state - a source that has never
 * heard from a controller knows nothing about what to show, and guessing would put a stale or
 * wrong board on somebody's stream.
 */
export function useCastReceiver(code: string | undefined) {
  const [message, setMessage] = useState<CastMessage | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!code) return;
    const channel = supabase.channel(channelName(code), { config: { broadcast: { self: false } } });
    channelRef.current = channel;

    channel
      .on("broadcast", { event: STATE_EVENT }, ({ payload }) => setMessage(payload as CastMessage))
      .subscribe((status) => {
        // Ask on every (re)subscribe, not just the first: a reconnect after a network blip is
        // exactly when this source's picture is most likely to be out of date.
        if (status === "SUBSCRIBED") {
          void channel.send({ type: "broadcast", event: HELLO_EVENT, payload: {} });
        }
      });

    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [code]);

  /** Tell the controller how big this source is, so its preview can frame honestly. */
  const report = useCallback((size: SourceSize) => {
    const channel = channelRef.current;
    if (!channel || size.w <= 0 || size.h <= 0) return;
    void channel.send({ type: "broadcast", event: SIZE_EVENT, payload: size });
  }, []);

  return { message, report };
}
