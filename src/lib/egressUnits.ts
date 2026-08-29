/**
 * The arithmetic behind egress accounting, with nothing plugged into it.
 *
 * Split out from lib/egressMeter and lib/egress for one reason: both of those import the Supabase
 * client, and a module that does cannot be loaded by a check script. Everything here is a pure
 * function of its arguments, so scripts/check-egress.ts can assert on it directly - which matters
 * more than usual for this feature, because a byte counter that is quietly wrong looks exactly like
 * a byte counter that is right.
 */

/** What a tab is doing. Drives the per-role split on the admin panel. */
export type EgressRole = "player" | "spectator" | "overlay" | "caster" | "site";

/**
 * UTF-8 byte length without allocating a buffer for it.
 *
 * `new TextEncoder().encode(s).length` is the obvious spelling and allocates a Uint8Array per
 * websocket frame, on a path that runs once per shot per subscriber plus a heartbeat every 25
 * seconds for as long as an overlay is open. This walks the string instead.
 *
 * A surrogate pair is one code point encoding to four bytes, not two characters encoding to three
 * each. That is the case the naive version gets wrong, and boss names carry enough punctuation that
 * it is worth getting right.
 */
export function utf8Len(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The websocket frame header the server sent along with a payload of this size.
 *
 * Server-to-client frames are unmasked, so the header is two bytes plus the extended length field:
 * nothing under 126 bytes, two more up to 64 KB, eight beyond that. Small, and worth including
 * anyway - realtime is thousands of tiny frames, where the header is a real fraction of the total
 * rather than a rounding error.
 *
 * TCP and TLS framing underneath cannot be seen from a browser and are not counted, so a realtime
 * figure is a floor on what was billed rather than a ceiling.
 */
export function frameOverhead(payload: number): number {
  if (payload < 126) return 2;
  if (payload < 65536) return 4;
  return 10;
}

/**
 * The room and role a URL implies.
 *
 * HashRouter, so the route is in the fragment. Takes the hash as an argument rather than reading
 * `location` so it can be asserted on.
 *
 * The role is a first guess and two of them are knowingly incomplete:
 *
 *   /room/:code    cannot tell a player from a spectator, because they are the same URL. Corrected
 *                  by SpectatorView through setEgressRole.
 *   /stream/:el    has no room in it at all - that is the point of the persistent overlay - so it
 *                  reports no code and therefore does not flush until StreamSource resolves one.
 */
export function readRoute(hash: string): { code: string | null; role: EgressRole } {
  const path = hash.replace(/^#/, "");

  const overlay = path.match(/^\/overlay(?:-[a-z]+)?\/([^/?]+)/);
  if (overlay) return { code: decodeURIComponent(overlay[1]).toUpperCase(), role: "overlay" };

  const caster = path.match(/^\/cast\/([^/?]+)/);
  if (caster) return { code: decodeURIComponent(caster[1]).toUpperCase(), role: "caster" };

  const room = path.match(/^\/room\/([^/?]+)/);
  if (room) return { code: decodeURIComponent(room[1]).toUpperCase(), role: "player" };

  if (/^\/stream\//.test(path)) return { code: null, role: "overlay" };

  return { code: null, role: "site" };
}

/**
 * When a match ran, from the only two things the archive records about its clock.
 *
 * `match_key` is `CODE:started_at`, so the start is inside the key - split on the FIRST colon only,
 * because the timestamp that follows is full of them. The end is `finished_at`.
 *
 * Widened by three minutes at each end on purpose. The bytes a match costs do not begin at the
 * countdown: players load the room, place fleets and open overlays first, and the archive write
 * itself lands after the final shot. A window clipped to the clock would attribute all of that to
 * nothing at all.
 */
export function matchWindow(
  matchKey: string,
  finishedAt: string
): { startedAt: string; endedAt: string } | null {
  const colon = matchKey.indexOf(":");
  if (colon < 0) return null;

  // Postgres prints `2026-08-29 16:22:09.674681+00`, which Safari refuses. The space becomes a T
  // and the bare `+00` becomes `+00:00`, which every engine parses.
  const raw = matchKey
    .slice(colon + 1)
    .replace(" ", "T")
    .replace(/([+-])(\d{2})$/, "$1$2:00");
  const start = new Date(raw);
  const end = new Date(finishedAt);
  if (Number.isNaN(+start) || Number.isNaN(+end) || +end <= +start) return null;

  const PAD_MS = 3 * 60 * 1000;
  return {
    startedAt: new Date(+start - PAD_MS).toISOString(),
    endedAt: new Date(+end + PAD_MS).toISOString(),
  };
}

/**
 * What one response costs before its body is counted.
 *
 * Response headers are billed and are completely invisible to JavaScript: `Headers` on a
 * cross-origin fetch exposes seven safelisted names, while the gateway actually sends a couple of
 * dozen - `set-cookie: __cf_bm`, `strict-transport-security`, `cf-ray`, `sb-request-id` and the
 * rest. Measured on this project:
 *
 *     tiny read (1 row)         926 header bytes      2 body bytes   headers are 99.8%
 *     small read (8 rows)       999 header bytes    231 body bytes   headers are 81.2%
 *     big read (1000 rows)    1,002 header bytes    478 body bytes   headers are 67.7%
 *
 * So for anything but a bulk fetch, the headers ARE the response. Counting only bodies understated
 * a request-heavy session by about a kilobyte per request - on the order of hundreds of KB across a
 * match, which is the same size as the thing being measured.
 *
 * A flat allowance rather than a guess per request: the figure barely moves (926 to 1,002 across
 * three orders of magnitude of body size) because it is nearly all fixed gateway headers.
 */
export const RESPONSE_HEADER_BYTES = 950;

/**
 * Whether a tab should spend a request reporting what it has counted.
 *
 * -- Why this is not simply a timer ----------------------------------------------------------------
 *
 * Because the meter is not free, and a meter that costs a tenth of what it measures is not an
 * instrument, it is an expense. One flush is a 204 with an empty body and 815 bytes of headers.
 * On a fixed 60-second tick that came to roughly 716 KB across ten tabs on a 90-minute match -
 * more than a full stats page load, spent to report numbers that had barely moved.
 *
 * So a flush has to earn itself. Three ways it can:
 *
 *   delta      enough new bytes have accrued to be worth a round trip
 *   age        it has been long enough that a crash would lose something worth having
 *   closing    the page is going away, so it is now or never
 *
 * An idle overlay between shots accrues only heartbeat replies - a couple of hundred bytes a
 * minute - and now reports none of them until they add up, instead of paying a kilobyte to say so
 * every sixty seconds.
 *
 * The delta threshold also bounds the meter's own footprint as a FRACTION rather than as a rate: a
 * tab cannot flush more than once per 128 KB it receives, so the overhead is pinned near 0.8% of
 * whatever it is measuring no matter how long the session runs.
 */
export function shouldFlush(opts: {
  /** Bytes counted since the last successful report. */
  delta: number;
  /** How long since the last successful report. */
  sinceMs: number;
  /** The page is unloading, so there is no next chance. */
  closing: boolean;
}): boolean {
  if (opts.delta <= 0) return false;
  if (opts.closing) return true;
  if (opts.delta >= SIGNIFICANT_DELTA_BYTES) return true;
  return opts.sinceMs >= MAX_REPORT_AGE_MS;
}

/**
 * Enough new bytes to be worth a round trip.
 *
 * 128 KB against an 815-byte flush is 0.6% overhead at worst, and it is the most a hard-closed tab
 * can lose. On a match where each tab receives megabytes that is a rounding error in exchange for
 * an instrument that no longer distorts its own reading.
 */
export const SIGNIFICANT_DELTA_BYTES = 128 * 1024;

/**
 * The longest a tab sits on numbers it has not reported.
 *
 * Needed because an OBS Browser Source never fires pagehide - it is killed with the scene - so a
 * quiet overlay that never crosses the delta threshold would otherwise report nothing at all for
 * the whole match and then vanish. Fifteen minutes costs a handful of flushes across a session and
 * guarantees every tab is represented.
 */
export const MAX_REPORT_AGE_MS = 15 * 60 * 1000;

/** Bytes as something a person reads at a glance. Binary units, because that is what Supabase bills in. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
