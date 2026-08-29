/**
 * Counts the bytes this tab receives from Supabase, and reports them per room.
 *
 * -- Why the client counts this ---------------------------------------------------------------------
 *
 * Supabase bills egress and reports it per day for the whole project. Nothing it publishes says what
 * one match cost, and realtime - the fan-out that dominates a live match - has no byte count in any
 * log at any plan. See the egress_samples migration for the full argument. The short version is that
 * the receiving browser is the only place a websocket frame can be weighed, so that is where this
 * runs.
 *
 * The REST half is measured here too, but it is NOT the authority on REST: the `egress-usage` edge
 * function reads the real billed byte counts out of `edge_logs` for the same window. Two independent
 * measurements of the same thing is the point - the panel shows them side by side, and a gap between
 * them means this file is wrong about something, which is worth knowing.
 *
 * -- What it deliberately does not do ---------------------------------------------------------------
 *
 * It does not touch anything until a room is in the URL, and it only ever reports rooms. Somebody
 * reading the leaderboard is pure REST and `edge_logs` already has them exactly; adding a write per
 * minute per casual visitor would be measuring apparatus that costs more than the thing it measures.
 */
import { supabase } from "./supabase";
import {
  utf8Len,
  frameOverhead,
  readRoute,
  shouldFlush,
  RESPONSE_HEADER_BYTES,
  type EgressRole,
} from "./egressUnits";

export type { EgressRole };

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";

/**
 * How often the flush policy is CONSULTED, which is not how often a flush happens.
 *
 * The decision is shouldFlush's - enough new bytes, or long enough since the last report, or the
 * page is closing. This tick only wakes up to ask. A minute is frequent enough that a burst is
 * reported promptly and costs nothing when the answer is no.
 */
const TICK_MS = 60_000;

/** The RPC this meter reports through. Its own responses are counted like any other - see weigh(). */
const SELF_PATH = "/rest/v1/rpc/record_egress_sample";

interface Counters {
  restBytes: number;
  restRequests: number;
  restEstimated: number;
  realtimeBytes: number;
  realtimeMessages: number;
}

const counters: Counters = {
  restBytes: 0,
  restRequests: 0,
  restEstimated: 0,
  realtimeBytes: 0,
  realtimeMessages: 0,
};

let clientId: string | null = null;
let roomCode: string | null = null;
let role: EgressRole = "site";
let installed = false;

/**
 * The total as of the last report that landed, and when it landed.
 *
 * Together these are the whole flush policy's input: the difference against the running total is
 * how much a flush would have to say, and the age is how much a crash would cost. Kept here rather
 * than as a `dirty` flag because "has anything changed" is the wrong question - a tab that has
 * accrued two hundred bytes has changed and is not worth a kilobyte to report.
 */
let reportedBytes = 0;
let reportedAt = 0;

/** Everything counted so far, in the one unit the flush policy cares about. */
function totalBytes(): number {
  return counters.restBytes + counters.realtimeBytes;
}

/** Bytes off one websocket message, whatever shape the transport handed us. */
function messageBytes(data: unknown): number {
  if (typeof data === "string") return utf8Len(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

/** This tab's current route, as the shared parser reads it. See egressUnits.readRoute. */
function route(): { code: string | null; role: EgressRole } {
  return readRoute(typeof window === "undefined" ? "" : window.location.hash);
}

/**
 * Starts a fresh row when the tab moves to a different room.
 *
 * A new id rather than a reset, because the counters are monotonic server-side - the RPC takes
 * `greatest` of what it holds and what arrives, so re-reporting smaller numbers under the same id
 * would be silently ignored and the second match would inherit the first one's total. Minting a new
 * id is the only way to say "this is a different session".
 */
function rotate(code: string | null, next: EgressRole) {
  roomCode = code;
  role = next;
  clientId = code ? crypto.randomUUID() : null;
  counters.restBytes = 0;
  counters.restRequests = 0;
  counters.restEstimated = 0;
  counters.realtimeBytes = 0;
  counters.realtimeMessages = 0;
  reportedBytes = 0;
  reportedAt = Date.now();
}

/** Corrects the role once the page knows something the URL could not tell it. */
export function setEgressRole(next: EgressRole): void {
  if (roomCode) role = next;
}

/**
 * Names the room for a page that resolved one at read time rather than from its URL.
 *
 * Only /stream/:element needs this - it carries a permanent per-player token instead of a room code,
 * precisely so the OBS Browser Source never goes stale. Ignored once a room is already set, so a
 * re-render cannot rotate the row out from under a match in progress.
 */
export function setEgressRoom(code: string | null, next: EgressRole = "overlay"): void {
  if (!code || roomCode === code.toUpperCase()) return;
  rotate(code.toUpperCase(), next);
}

/**
 * Writes this tab's running totals.
 *
 * `keepalive` so the pagehide flush survives the page going away - a plain fetch is cancelled on
 * navigation, which is exactly the flush that matters most, since it carries the last minute of a
 * match that just ended. The RPC is called over raw fetch rather than supabase-js because
 * supabase-js has no way to pass keepalive through.
 *
 * Failure is swallowed. This is instrumentation: a tab that cannot report its byte count should
 * carry on showing somebody their match.
 */
async function flush(closing = false): Promise<void> {
  if (!clientId || !roomCode) return;
  const at = totalBytes();
  if (!shouldFlush({ delta: at - reportedBytes, sinceMs: Date.now() - reportedAt, closing })) return;

  const body = {
    p_client_id: clientId,
    p_room_code: roomCode,
    p_role: role,
    p_rest_bytes: Math.round(counters.restBytes),
    p_rest_requests: counters.restRequests,
    p_rest_estimated: counters.restEstimated,
    p_realtime_bytes: Math.round(counters.realtimeBytes),
    p_realtime_messages: counters.realtimeMessages,
  };

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string);
    await fetch(`${SUPABASE_URL}${SELF_PATH}`, {
      method: "POST",
      keepalive: closing,
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    // Recorded only on success, so a failed report is retried rather than silently forgotten.
    reportedBytes = at;
    reportedAt = Date.now();
  } catch {
    // Reported next minute, or not at all. Either is fine.
  }
}

/**
 * Weighs one REST response, in the bytes it cost rather than the bytes it contained.
 *
 * -- Why this is harder than reading a header ---------------------------------------------------
 *
 * The obvious answer is Content-Length, which is one of the seven headers the Fetch spec safelists
 * for cross-origin reads, and which for a compressed response is the wire size - exactly what is
 * billed. PostgREST does not send it. Measured against this project:
 *
 *     content-encoding: gzip
 *     transfer-encoding: chunked
 *     (no content-length)
 *
 * A chunked response has no length to declare, so the header is simply absent on every data read the
 * site makes. Nor is Resource Timing a way out: `encodedBodySize` is zeroed cross-origin unless the
 * server sends Timing-Allow-Origin, and Supabase does not.
 *
 * So the decoded body is all a browser is given, and it is the wrong number - this project's JSON
 * gzips to somewhere between a fifth and a third of its size, so counting it raw would overstate
 * every REST figure on the panel by three to five times.
 *
 * -- What this does instead -----------------------------------------------------------------------
 *
 * Compresses the body and weighs that. `CompressionStream('gzip')` is in every browser that can run
 * this site, OBS's embedded Chromium included, and it puts the number in the right order of
 * magnitude instead of a factor of nine out.
 *
 * It reads LOW, consistently. Measured against this project's real responses, comparing what the
 * gateway actually put on the wire against what CompressionStream makes of the same body:
 *
 *     events page (1000 rows)    33,479 wire    22,901 ours    -32%   (raw would say 317,675)
 *     participants (913 rows)    76,376 wire    51,616 ours    -32%   (raw would say 367,037)
 *     board sources (149 rows)   24,142 wire    22,244 ours     -8%   (raw would say  64,829)
 *     report lines (200 rows)    10,684 wire     9,809 ours     -8%   (raw would say  37,437)
 *
 * The gateway compresses at a lower level than CompressionStream does - faster, slightly bigger
 * output - and CompressionStream exposes no level to match it with. So the REST half of a sample is
 * a FLOOR, typically ten to thirty per cent under what was billed, and the panel says so rather than
 * printing it as an answer. The `egress-usage` function is the authority on REST for exactly this
 * reason.
 *
 * None of this touches realtime, which is the number nothing else can see: websocket frames are not
 * compressed, so those bytes are counted as they arrived.
 *
 * Three layers, in order of how much they can be trusted:
 *
 *   1. Content-Length, where a response actually has one (auth, storage, anything not chunked).
 *   2. gzip of the decoded body, for everything else.
 *   3. the decoded body itself, if CompressionStream is missing or throws. Counted in
 *      `restEstimated`, which the panel prints as "uncompressed est.", because a total made mostly
 *      of these is not a measurement and should not be read as one.
 *
 * All of it happens on a clone, off the caller's path, so nothing here delays a request.
 */
function weigh(res: Response): void {
  counters.restRequests++;
  // Charged before the body is even looked at, because for most responses this IS the response -
  // see RESPONSE_HEADER_BYTES for the measurements. Headers are billed and unreadable from here.
  counters.restBytes += RESPONSE_HEADER_BYTES;

  const declared = res.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n >= 0) {
      counters.restBytes += n;
      return;
    }
  }

  let copy: Response;
  try {
    copy = res.clone();
  } catch {
    // Already consumed, or not cloneable. Counted as a request that carried nothing rather than
    // guessed at - an invented number is worse here than a missing one.
    counters.restEstimated++;
    return;
  }

  void copy
    .arrayBuffer()
    .then(async (buf) => {
      const gz = await gzipSize(buf);
      if (gz === null) {
        counters.restEstimated++;
        counters.restBytes += buf.byteLength;
      } else {
        counters.restBytes += gz;
      }
    })
    .catch(() => {});
}

/**
 * How many bytes a payload gzips to, or null if this browser cannot say.
 *
 * Streams the buffer through CompressionStream and adds up what comes out. Null rather than a throw
 * on an older engine, so the caller can fall back and, more importantly, can COUNT that it fell
 * back - a silent substitution of uncompressed bytes is the failure that would quietly inflate every
 * number on the panel.
 */
async function gzipSize(buf: ArrayBuffer): Promise<number | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"));
    const reader = stream.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += (value as Uint8Array).byteLength;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Counts every frame the realtime socket delivers.
 *
 * Wraps `connect()` rather than reaching for the socket once, because realtime-js replaces `conn` on
 * every reconnect - and a long-lived OBS overlay reconnects, that being the whole reason the
 * heartbeat runs in a worker. Wrapping the method means each new socket is instrumented as it is
 * created; the WeakSet stops a socket being counted twice if connect() is called on an open one.
 *
 * `addEventListener` alongside realtime-js's own `onmessage` handler rather than replacing it: the
 * two do not collide, and nothing here can break message delivery by throwing in the wrong place.
 */
function hookRealtime(): void {
  const rt = supabase.realtime as unknown as {
    conn?: unknown;
    connect?: (...args: unknown[]) => unknown;
  };
  if (typeof rt.connect !== "function") return;

  const seen = new WeakSet<object>();
  const attach = (conn: unknown) => {
    if (!conn || typeof conn !== "object") return;
    const socket = conn as { addEventListener?: (t: string, f: (e: MessageEvent) => void) => void };
    if (typeof socket.addEventListener !== "function" || seen.has(conn)) return;
    seen.add(conn);
    socket.addEventListener("message", (event: MessageEvent) => {
      const payload = messageBytes(event.data);
      counters.realtimeBytes += payload + frameOverhead(payload);
      counters.realtimeMessages++;
    });
  };

  const original = rt.connect.bind(rt);
  rt.connect = (...args: unknown[]) => {
    const out = original(...args);
    attach(rt.conn);
    return out;
  };
  attach(rt.conn);
}

/**
 * Turns the meter on. Safe to call more than once; only the first call does anything.
 *
 * Installed at module scope from main.tsx so the fetch wrapper is in place before any page has had a
 * chance to make a request - the site's first reads happen during the first render, and a meter
 * installed in an effect would miss them.
 */
export function installEgressMeter(): void {
  if (installed || typeof window === "undefined" || !SUPABASE_URL) return;
  installed = true;

  const start = route();
  rotate(start.code, start.role);

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await originalFetch(input as RequestInfo, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      /**
       * The meter's own reports are counted too, deliberately.
       *
       * Excluding them was the first version and it was dishonest in the direction that matters:
       * a flush is a real 204 with about 815 bytes of headers on it, it is really billed, and
       * hiding it would make the panel understate the bill by exactly the cost of the apparatus
       * producing the panel. An instrument that conceals its own footprint is worse than one with
       * a large footprint.
       *
       * It cannot run away with itself, because a flush only happens once per 128 KB counted -
       * see shouldFlush. An idle tab accrues nothing, so it reports nothing, so it accrues nothing.
       */
      if (url.startsWith(SUPABASE_URL)) weigh(res);
    } catch {
      // Never let accounting break a request.
    }
    return res;
  };

  hookRealtime();

  // HashRouter navigation, so a room change is a hashchange rather than a page load. Without this a
  // caster moving from one room to the next would file the second match's bytes under the first.
  window.addEventListener("hashchange", () => {
    const next = route();
    if (next.code !== roomCode) {
      void flush();
      rotate(next.code, next.role);
    }
  });

  window.setInterval(() => void flush(), TICK_MS);

  // pagehide rather than unload: it is the one that fires reliably on mobile and on a tab being
  // discarded, and it is compatible with the page being kept in the back/forward cache.
  window.addEventListener("pagehide", () => void flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush(true);
  });
}

/** This tab's running totals, for a live readout. Nothing but the admin panel's own meter uses it. */
export function currentEgress(): Counters & { roomCode: string | null; role: EgressRole } {
  return { ...counters, roomCode, role };
}
