import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import { castTopic } from "./overlayCast";
import type { BarnacleMood } from "./talkingPoints";

/**
 * The casting scene's out-of-band channel: resync the player streams, and report how far behind
 * each one is running.
 *
 * -- Why this is not the frame channel --------------------------------------------------------
 *
 * lib/overlayCast owns `cast:<code>`, and everything on it is a board FRAME - a view and a set of
 * placements, coalesced and heartbeated, asserted by scripts/check-cast-heartbeat. A resync press
 * and a latency reading are neither: they carry no board state, they must not reset a source's
 * staleness clock, and one of them is sent by the screen sources rather than to them. Putting them
 * on the frame channel would mean teaching that protocol - and its check - about messages that are
 * not frames, to no purpose. So they get their own topic, `cast-aux:<code>`, and the frame channel
 * stays exactly what it was.
 *
 * -- What travels ---------------------------------------------------------------------------------
 *
 * RESYNC, desk -> screens: "reload now". A `slot` of null is everyone; a number is one box. The
 * screen decides what "reload" means (it rebuilds the Twitch embed - see pages/OverlayScreen); this
 * only says when.
 *
 * LATENCY, screen -> desk and frame: "I am this many milliseconds behind the broadcaster right now".
 * The desk shows it per box and offers to set the whole-overlay delay to the slowest of them, so the
 * board and the clock can be pulled back to where the cams actually are. The frame holds each box's
 * card by it.
 *
 * CARD, desk -> frame: a talking point to put over one player's box (see lib/talkingPoints), drawn by
 * the frame source over that box's hole - never by the box itself, see useFrameCards. Not a frame
 * either - it is a caster's one-off call, gone in seconds. CARD_CLEAR takes it down early.
 */

const RESYNC_EVENT = "resync";
const LATENCY_EVENT = "latency";
const CARD_EVENT = "card";
const CARD_CLEAR_EVENT = "card-clear";

/** How long a card stays up once it is on screen. */
export const CARD_MS = 8000;

/** A talking point on its way to one player's box. */
export interface StatCard {
  /** The talking point's id, so the desk can tell which one is up. */
  id: string;
  slot: number;
  emoji: string;
  /** Which barnacle pops up to say it - see BarnacleMood in lib/talkingPoints. */
  mood: BarnacleMood;
  text: string;
  team: number | null;
  /**
   * When the shot behind it was fired, for a live point. The box holds the card until its own stream
   * has caught up to that moment, so a "world record" card never lands before the viewer has seen the
   * kill. Clocks on two machines disagree by a little, which only moves the card by that little.
   */
  shotAt: string | null;
  /** How long to show it, once showing. */
  ms: number;
}

/** How often a screen tells the desk where it is. Latency drifts slowly; this is not a hot path. */
const LATENCY_REPORT_MS = 8000;

/** A reading older than this is stale - the box was closed or refreshed - and the desk drops it. */
export const LATENCY_STALE_MS = 25000;

// Per stream, like the frame channel: each stream has its own screen boxes running their own latency.
const channelName = (code: string, owner?: string | null) => `cast-aux:${castTopic(code, owner)}`;

interface LatencyMsg {
  slot: number;
  ms: number;
}

interface ResyncMsg {
  /** null - every box. A number - just that slot. */
  slot: number | null;
}

/**
 * The screen source's end.
 *
 * Returns a nonce that steps every time the desk asks this box (or all boxes) to reload - a caller
 * hangs it off the embed's React key and the player is rebuilt. Also pumps a latency reading up the
 * channel on a slow interval, read through `getLatencyMs` so this hook never has to know what a
 * Twitch player is.
 *
 * The talking-point cards are NOT drawn here - see useFrameCards.
 */
export function useScreenAux(
  code: string | undefined,
  owner: string | null | undefined,
  slot: number,
  getLatencyMs: () => number | null
): { resyncNonce: number } {
  const [resyncNonce, setResyncNonce] = useState(0);
  const latencyRef = useRef(getLatencyMs);
  latencyRef.current = getLatencyMs;

  useEffect(() => {
    if (!code) return;
    const channel = supabase.channel(channelName(code, owner), { config: { broadcast: { self: false } } });

    channel
      .on("broadcast", { event: RESYNC_EVENT }, ({ payload }) => {
        const target = (payload as ResyncMsg)?.slot;
        if (target === null || target === undefined || target === slot) {
          setResyncNonce((n) => n + 1);
        }
      })
      .subscribe();

    const report = () => {
      const ms = latencyRef.current();
      if (ms === null || !Number.isFinite(ms)) return;
      void channel.send({
        type: "broadcast",
        event: LATENCY_EVENT,
        payload: { slot, ms: Math.round(ms) } satisfies LatencyMsg,
      });
    };
    const beat = setInterval(report, LATENCY_REPORT_MS);

    return () => {
      clearInterval(beat);
      void supabase.removeChannel(channel);
    };
  }, [code, owner, slot]);

  return { resyncNonce };
}

/**
 * The frame source's end of the cards: every box's talking point, by slot.
 *
 * -- Why the frame draws them, not the box -------------------------------------------------------
 *
 * They used to be drawn by each screen source, over its own Twitch embed - and the moment one went up
 * that stream froze, for good. Twitch's player pauses itself when something in its own page covers it.
 * The frame (pages/OverlayFrame) is a separate Browser Source stacked over every box in the scene, so a
 * card drawn there sits over the stream in OBS's picture and never inside the player's page.
 *
 * -- Timing ----------------------------------------------------------------------------------------
 *
 * A card is held until its box's stream shows the shot it is about, shown for its time, then gone. The
 * frame has no player to ask how far behind a box runs, so it listens to the latency the boxes already
 * report to the desk (LATENCY) and holds each card by its own box's reading. One card per box; a new
 * card for a box replaces the one showing there - the caster's latest call wins.
 */
export function useFrameCards(code: string | undefined, owner: string | null | undefined): Map<number, StatCard> {
  const [cards, setCards] = useState<Map<number, StatCard>>(() => new Map());

  useEffect(() => {
    if (!code) return;
    const channel = supabase.channel(channelName(code, owner), { config: { broadcast: { self: false } } });
    const latency = new Map<number, number>();
    // Per box: the hold before its card shows, then its time on screen.
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const drop = (slot: number) => {
      clearTimeout(timers.get(slot));
      timers.delete(slot);
      setCards((prev) => {
        if (!prev.has(slot)) return prev;
        const next = new Map(prev);
        next.delete(slot);
        return next;
      });
    };

    channel
      .on("broadcast", { event: LATENCY_EVENT }, ({ payload }) => {
        const msg = payload as LatencyMsg;
        if (typeof msg?.slot === "number" && typeof msg?.ms === "number") latency.set(msg.slot, msg.ms);
      })
      .on("broadcast", { event: CARD_EVENT }, ({ payload }) => {
        const next = payload as StatCard;
        if (typeof next?.slot !== "number" || typeof next.text !== "string") return;
        const slot = next.slot;
        drop(slot);
        const shotMs = next.shotAt ? Date.parse(next.shotAt) : NaN;
        const behind = latency.get(slot) ?? 0;
        const hold = Number.isNaN(shotMs) ? 0 : Math.max(0, Math.min(behind - (Date.now() - shotMs), 30000));
        // Clamped here, once, so the card's exit animation (timed off `ms`) ends exactly as it is dropped.
        const shown = { ...next, ms: Math.max(1000, Math.min(next.ms, 30000)) };
        timers.set(
          slot,
          setTimeout(() => {
            setCards((prev) => new Map(prev).set(slot, shown));
            timers.set(slot, setTimeout(() => drop(slot), shown.ms));
          }, hold)
        );
      })
      .on("broadcast", { event: CARD_CLEAR_EVENT }, ({ payload }) => {
        const slot = (payload as { slot?: number })?.slot;
        if (typeof slot === "number") drop(slot);
      })
      .subscribe();

    return () => {
      timers.forEach(clearTimeout);
      setCards(new Map());
      void supabase.removeChannel(channel);
    };
  }, [code, owner]);

  return cards;
}

export interface CasterAux {
  /** slot -> most recent latency in ms, stale readings already dropped. */
  latencies: Map<number, number>;
  /** The slowest box's latency in ms, or null when nothing has reported. What the delay wants to be. */
  slowestMs: number | null;
  /** Ask a box to reload. Omit `slot` for all of them. */
  resync: (slot?: number) => void;
  /** Put a talking point over one player's box. */
  showCard: (card: StatCard) => void;
  /** Take a box's card down before its time is up. */
  clearCard: (slot: number) => void;
}

/**
 * The desk's end. Collects latency readings and hands back a resync trigger.
 *
 * A second channel object on a topic the publisher does not touch, so it needs nothing from
 * useCastPublisher and cannot interfere with a frame in flight.
 */
export function useCasterAux(code: string | undefined, owner?: string | null): CasterAux {
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const [readings, setReadings] = useState<Map<number, { ms: number; at: number }>>(new Map());

  useEffect(() => {
    if (!code) return;
    setReadings(new Map());
    const channel = supabase.channel(channelName(code, owner), { config: { broadcast: { self: false } } });
    channelRef.current = channel;

    channel
      .on("broadcast", { event: LATENCY_EVENT }, ({ payload }) => {
        const msg = payload as LatencyMsg;
        if (typeof msg?.slot !== "number" || typeof msg?.ms !== "number") return;
        setReadings((prev) => {
          const next = new Map(prev);
          next.set(msg.slot, { ms: msg.ms, at: Date.now() });
          return next;
        });
      })
      .subscribe();

    // Sweep stale readings so a closed box stops counting towards the slowest.
    const sweep = setInterval(() => {
      setReadings((prev) => {
        const cut = Date.now() - LATENCY_STALE_MS;
        let changed = false;
        const next = new Map(prev);
        for (const [slot, r] of prev) {
          if (r.at < cut) {
            next.delete(slot);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, LATENCY_REPORT_MS);

    return () => {
      clearInterval(sweep);
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [code, owner]);

  const resync = useCallback((slot?: number) => {
    const channel = channelRef.current;
    if (!channel) return;
    void channel.send({
      type: "broadcast",
      event: RESYNC_EVENT,
      payload: { slot: slot ?? null } satisfies ResyncMsg,
    });
  }, []);

  const showCard = useCallback((card: StatCard) => {
    void channelRef.current?.send({ type: "broadcast", event: CARD_EVENT, payload: card });
  }, []);

  const clearCard = useCallback((slot: number) => {
    void channelRef.current?.send({ type: "broadcast", event: CARD_CLEAR_EVENT, payload: { slot } });
  }, []);

  const latencies = useMemo(() => {
    const out = new Map<number, number>();
    for (const [slot, r] of readings) out.set(slot, r.ms);
    return out;
  }, [readings]);

  const slowestMs = useMemo(() => {
    let max: number | null = null;
    for (const ms of latencies.values()) max = max === null ? ms : Math.max(max, ms);
    return max;
  }, [latencies]);

  return { latencies, slowestMs, resync, showCard, clearCard };
}
