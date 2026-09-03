import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { ShipPlacement } from "../types/battleship";
import { castSendKind, frameKey } from "./castFrame";
// Type-only, so this file gains no runtime dependency on the camera - which matters, because the
// camera must stay runnable outside a browser and this one never can. Same arrangement, and the
// same reason, as castFrame's import of these types - see the note at the top of that file.
import type { CastMotion } from "./overlayCamera";

// The frame's pure half lives in castFrame.ts so it can be run outside a browser and asserted -
// see the note there. Re-exported so callers keep importing the cast protocol from one place.
export { DEFAULT_VIEW, castSendKind, frameKey } from "./castFrame";

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
  /**
   * Draw hit/miss/sunk at all.
   *
   * Off, a square that has been fired at keeps only its attribution ring - the coloured outline
   * saying whose shot landed there - and loses both the sprite and the cell fill underneath it.
   * The two go together deliberately: dropping the sprite alone leaves a fully colour-coded board,
   * which is not what "no icons" means to anyone who asks for it.
   *
   * What it buys is the square's NAME. On a stream the board is mostly text, and a hundred burst
   * stars and splash rings sitting on top of that text is a lot of ink spent on information the
   * caster is usually saying out loud anyway.
   *
   * Optional, and defaulted by every reader rather than trusted to be present - a frame sent by a
   * controller that predates this field carries no opinion about it. Same rule as `opacity`.
   */
  markers?: boolean;
  /**
   * Whose shots get markers. Null or absent means every fleet's.
   *
   * ATTACKER teams, not defenders - which is a different question from the one `mode` asks. `mode`
   * picks whose BOARD is on screen; this picks whose SHOTS are drawn on it. On a composited board
   * they are genuinely independent: "Blue's board, showing only Red's hits" is a real thing a
   * caster wants to say.
   */
  markerTeams?: number[] | null;
  /**
   * Squares ringed as a spotlight - what the caster is pointing at.
   *
   * A list rather than a single index because one square and one hull are the same gesture with a
   * different footprint, and a protocol that knew the difference would have to be told about ships
   * to no purpose. The board rings whatever cells it is given.
   *
   * A hull's cells reveal that hull's position and shape, so sending them IS sending a ship - see
   * the guard on the control page, which refuses to spotlight one while the view says no ships are
   * going to stream.
   */
  spot?: number[] | null;
  /**
   * The spotlight's colour, as a hex - whose shot, or whose ship, it is.
   *
   * White when absent, which is the right default for a caster pointing at a square with no fleet
   * attached to the gesture. When there IS one - the fleet that fired the shot, or the fleet whose
   * hull is being shown - the light takes their colour, and the board says whose moment it is
   * without anybody having to narrate it.
   *
   * A hex rather than a team number because the palette is a preference (see teamColors) and the
   * board should not have to know that, exactly as `firedBy` carries colours rather than teams.
   */
  spotColor?: string | null;
  /**
   * How large the square names are drawn, as a fraction of what the square will hold.
   *
   * 1 means fill it: every name is drawn at the largest size that fits its own cell, so a short
   * name like "Dane" gets a big one and "Consecrated Death Rite Bird" gets a small one, and the
   * board stops being mostly empty box. Below 1 trims the whole board by the same proportion.
   *
   * Above 1 is accepted and does nothing, because there is nothing above "as large as it fits" -
   * see lib/textFit, which caps it rather than letting a name overflow.
   *
   * Optional and defaulted by every reader, like the fields above it. A source being driven by a
   * controller that predates this draws at full fill, which is the new default rather than the old
   * behaviour - the old behaviour is not something anyone was choosing.
   */
  text?: number;
  /**
   * The board aiming itself: a clockwise lap of the quadrants, interrupted by each new mark.
   *
   * The SETTINGS travel, never the position. A lap publishes nothing while it runs - both ends work
   * out where the camera is from these four numbers and their own clock, which is the only version
   * that doesn't put a full frame on the wire every 110ms for the length of a broadcast. See
   * lib/overlayCamera for the arithmetic both ends share.
   *
   * Present means the source has the wheel and `zoom`/`cx`/`cy` above are only where it RESTS. Null
   * or absent means the caster is aiming, which is what every control on the aim pad sets it back
   * to - see the handover note on the control page. Two hands on one wheel is the failure this
   * field is shaped to make impossible.
   */
  motion?: CastMotion | null;
}

/**
 * The floor on a source's transparency, which is now none at all.
 *
 * It was 0.25, on the reasoning that a source faded past a quarter is hidden rather than faint, and
 * that hiding a source is OBS's job. What that cost was a slider whose left end was not an end:
 * dragging to the bottom of the track left the board at quarter strength, which reads as a control
 * that doesn't work rather than as a guard rail. A streamer who wants nothing on screen can say so
 * here now, and the box says "hidden" when they have.
 */
export const MIN_OPACITY = 0;

/**
 * `?opacity=` off a source's URL, clamped, defaulting to solid.
 *
 * Shared by every player-facing source rather than parsed once each. They are dropped into one
 * scene and usually want the same setting - a streamer fading the board over their gameplay wants
 * the clock, the key and their own fleet to match, and the overlay box writes one slider into all
 * of their URLs. One reader means one clamp, so a hand-typed `?opacity=0` can't make one source
 * invisible while another quietly floors at 0.25.
 */
export function readOpacity(params: URLSearchParams): number {
  return readFraction(params, "opacity");
}

/**
 * `?empty=` - how solid a square nobody has fired at is, as a fraction of the scene's own opacity.
 *
 * A second, narrower transparency, and it exists because the two questions are different. The scene
 * setting is "how much of my gameplay shows through this overlay"; this one is "which squares am I
 * actually being told about". A player already knows where they have been, so the fill on the
 * squares they haven't is the part of the board with nothing to say - turn it down and their own
 * footage shows through everywhere they have yet to shoot, while every hit, miss and wreck stays
 * exactly as solid as it was.
 *
 * Multiplied by the scene opacity rather than replacing it, so the two sliders compose instead of
 * fighting: at 100% the board looks exactly as it did before this existed.
 *
 * Deliberately absent from a caster's sources. The desk is reading the whole board, and the empty
 * water is where the patterns are.
 */
export function readEmptyFade(params: URLSearchParams): number {
  return readFraction(params, "empty");
}

/** Shared clamp for the 0-1 settings above. Absent means 1, which is "as it comes". */
function readFraction(params: URLSearchParams, key: string): number {
  const raw = params.get(key);
  if (raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/**
 * How long the find alert holds a find on screen.
 *
 * Under two seconds nobody reads the caption; over thirty it has stopped being an alert and become
 * furniture. Both ends are guard rails rather than opinions - see pages/OverlayEgg.
 */
export const MIN_ALERT_SECS = 2;
export const MAX_ALERT_SECS = 30;
export const DEFAULT_ALERT_SECS = 6;

/** `?secs=` off the alert source's URL, clamped. */
export function readAlertSecs(params: URLSearchParams): number {
  const raw = Number(params.get("secs"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ALERT_SECS;
  return Math.min(MAX_ALERT_SECS, Math.max(MIN_ALERT_SECS, raw));
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

/**
 * Zoom bounds, re-exported from where the framing arithmetic lives.
 *
 * They moved to lib/overlayBoardLayout when the self-aiming camera needed them: that module is pure
 * and this one is not - it imports React and the supabase client, so nothing that imports it can be
 * run outside a browser, which put the bounds out of reach of both lib/overlayCamera and the check
 * script that asserts it. Same split, and the same reason, as castFrame.ts.
 *
 * Still exported here because this is where every caller looks for them, and a cap on a zoom is
 * part of the cast protocol as much as it is part of the layout.
 */
export { MIN_ZOOM, MAX_ZOOM } from "./overlayBoardLayout";

const STATE_EVENT = "cast-state";
const HELLO_EVENT = "cast-hello";
/** The source telling its controller how big it is - see SourceSize. */
const SIZE_EVENT = "cast-size";
/**
 * "Still here, nothing has changed."
 *
 * The heartbeat below exists to prove the controller is alive, not to deliver news, and for most
 * of a match there is no news: a caster sets a view and then talks over it for ten minutes while
 * the same frame goes out every five seconds to every source they have open. A frame carries every
 * fleet's placements, so that silence was costing kilobytes a beat per source.
 *
 * So an unchanged beat sends this instead - a stamp and nothing else. The source treats it exactly
 * as it treats a frame for the purpose of deciding whether its controller has gone quiet, and
 * keeps drawing what it already has. The moment anything actually changes, a real frame goes.
 */
const PING_EVENT = "cast-ping";

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
 *
 * A beat only carries a whole frame when the frame has actually changed; otherwise it sends
 * PING_EVENT. Both keep a source's staleness clock fed, which is the only thing a beat is FOR once
 * the source has a picture - see push().
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

  /**
   * The frame the sources are believed to be holding, serialised.
   *
   * Compared against rather than the object itself: `publish` is called from render and hands us a
   * fresh object every time, so identity says nothing about whether anything changed. `at` is
   * excluded because it changes on every send by definition and would defeat the whole comparison.
   */
  const sentFrame = useRef<string | null>(null);

  /**
   * Sends the stored frame immediately, cancelling anything queued.
   *
   * `force` skips the unchanged-frame shortcut. It is for `hello`: a source that has just
   * announced itself is holding NOTHING, so the fact that the frame matches what the other sources
   * already have is precisely the wrong reason not to send it one.
   */
  const push = useCallback((force = false) => {
    if (trailing.current) {
      clearTimeout(trailing.current);
      trailing.current = null;
    }
    const channel = channelRef.current;
    const message = last.current;
    if (!channel || !message) return;
    sentAt.current = Date.now();

    const key = frameKey(message);
    if (castSendKind(sentFrame.current, key, force) === "ping") {
      void channel.send({ type: "broadcast", event: PING_EVENT, payload: { at: sentAt.current } });
      return;
    }
    sentFrame.current = key;
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
      // than waiting out the heartbeat with an empty scene on stream. Forced, because what the
      // OTHER sources are already holding says nothing about what this one needs.
      .on("broadcast", { event: HELLO_EVENT }, () => push(true))
      .on("broadcast", { event: SIZE_EVENT }, ({ payload }) => setSourceSize(payload as SourceSize))
      .subscribe((status) => setReady(status === "SUBSCRIBED"));

    const beat = setInterval(() => push(), HEARTBEAT_MS);

    return () => {
      clearInterval(beat);
      if (trailing.current) clearTimeout(trailing.current);
      trailing.current = null;
      channelRef.current = null;
      // Forget what the sources were holding: this channel is going away, and the next one must
      // open by saying something rather than pinging about a frame it never sent.
      sentFrame.current = null;
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
  /**
   * Bumped every time this source (re)joins the channel.
   *
   * Exists so a caller can re-announce things that are only true per link - the source's own size,
   * in practice. That used to hang off the arrival of a frame, which meant a size report went back
   * up the channel every five seconds forever to tell the controller a number it already had.
   */
  const [linkEpoch, setLinkEpoch] = useState(0);

  useEffect(() => {
    if (!code) return;
    const channel = supabase.channel(channelName(code), { config: { broadcast: { self: false } } });
    channelRef.current = channel;

    channel
      .on("broadcast", { event: STATE_EVENT }, ({ payload }) => setMessage(payload as CastMessage))
      /**
       * An unchanged beat. Keeps the staleness clock fed without redrawing anything.
       *
       * The stamp is written onto the frame already held, so `at` keeps meaning "when did we last
       * hear from the controller" for every reader of it. A ping that arrives before any frame is
       * dropped: there is nothing to stamp, and inventing an empty frame would put a blank board on
       * stream. The `hello` sent on subscribe is what fills that gap.
       */
      .on("broadcast", { event: PING_EVENT }, ({ payload }) => {
        const at = (payload as { at?: number }).at ?? Date.now();
        setMessage((prev) => (prev ? { ...prev, at } : prev));
      })
      .subscribe((status) => {
        // Ask on every (re)subscribe, not just the first: a reconnect after a network blip is
        // exactly when this source's picture is most likely to be out of date.
        if (status === "SUBSCRIBED") {
          setLinkEpoch((n) => n + 1);
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

  return { message, report, linkEpoch };
}
