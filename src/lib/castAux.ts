import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

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
 * LATENCY, screen -> desk: "I am this many milliseconds behind the broadcaster right now". The desk
 * shows it per box and offers to set the whole-overlay delay to the slowest of them, so the board
 * and the clock can be pulled back to where the cams actually are.
 */

const RESYNC_EVENT = "resync";
const LATENCY_EVENT = "latency";

/** How often a screen tells the desk where it is. Latency drifts slowly; this is not a hot path. */
const LATENCY_REPORT_MS = 8000;

/** A reading older than this is stale - the box was closed or refreshed - and the desk drops it. */
export const LATENCY_STALE_MS = 25000;

const channelName = (code: string) => `cast-aux:${code.toUpperCase()}`;

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
 */
export function useScreenAux(
  code: string | undefined,
  slot: number,
  getLatencyMs: () => number | null
): number {
  const [resyncNonce, setResyncNonce] = useState(0);
  const latencyRef = useRef(getLatencyMs);
  latencyRef.current = getLatencyMs;

  useEffect(() => {
    if (!code) return;
    const channel = supabase.channel(channelName(code), { config: { broadcast: { self: false } } });

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
  }, [code, slot]);

  return resyncNonce;
}

export interface CasterAux {
  /** slot -> most recent latency in ms, stale readings already dropped. */
  latencies: Map<number, number>;
  /** The slowest box's latency in ms, or null when nothing has reported. What the delay wants to be. */
  slowestMs: number | null;
  /** Ask a box to reload. Omit `slot` for all of them. */
  resync: (slot?: number) => void;
}

/**
 * The desk's end. Collects latency readings and hands back a resync trigger.
 *
 * A second channel object on a topic the publisher does not touch, so it needs nothing from
 * useCastPublisher and cannot interfere with a frame in flight.
 */
export function useCasterAux(code: string | undefined): CasterAux {
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const [readings, setReadings] = useState<Map<number, { ms: number; at: number }>>(new Map());

  useEffect(() => {
    if (!code) return;
    const channel = supabase.channel(channelName(code), { config: { broadcast: { self: false } } });
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
  }, [code]);

  const resync = useCallback((slot?: number) => {
    const channel = channelRef.current;
    if (!channel) return;
    void channel.send({
      type: "broadcast",
      event: RESYNC_EVENT,
      payload: { slot: slot ?? null } satisfies ResyncMsg,
    });
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

  return { latencies, slowestMs, resync };
}
