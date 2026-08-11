import { supabase } from "./supabase";

/**
 * The database's clock, as best this browser can estimate it.
 *
 * Every shared instant in the game is a Postgres timestamp - the match start marker, every attack
 * row. Measuring elapsed time against `Date.now()` therefore subtracts a SERVER clock from a CLIENT
 * clock, and the difference between those two is whatever the player's PC clock happens to be wrong
 * by. That isn't a rounding error: an unsynced Windows clock drifts minutes, and players were seeing
 * match timers minutes apart from each other in the same room.
 *
 * It also decided who was allowed to shoot. `canFire` comes from the same phase calculation, so a
 * fast clock opened fire early and a slow one stayed locked out after everyone else had started.
 *
 * The fix is one offset, measured against the database and added to every local reading. Everything
 * downstream keeps working in ordinary epoch milliseconds.
 */
let offsetMs = 0;

/** Null until the first successful sync. Guards against two hooks syncing at once on mount. */
let inFlight: Promise<void> | null = null;

/** Local timestamp of the last successful sync, so callers can tell a real 0 from "never ran". */
let syncedAt: number | null = null;

/**
 * Don't re-measure more often than this, however many callers ask.
 *
 * useBattlePhase is mounted about four times over during a match (the room page, the battle phase,
 * the clock, the stream overlay), and each one ticks its own re-sync timer. Without this floor that
 * would be four requests per interval per player for a number that moves by milliseconds an hour.
 * With it, any number of callers collapse to one actual round trip.
 */
const MIN_SYNC_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Re-measure the offset against the database.
 *
 * Cheap by construction: one PostgREST call, throttled to at most one per MIN_SYNC_INTERVAL_MS
 * across the whole tab, and only while a match is actually running. It's an ordinary HTTP request,
 * so it costs nothing against realtime connections or messages.
 *
 * Deliberately failure-tolerant. `server_now()` is a function that has to be created by hand (it's
 * in RUN_THESE.sql), and until it exists the RPC 404s - in which case the offset stays 0 and the
 * clock behaves exactly as it did before, rather than the whole match screen erroring out over a
 * missing convenience.
 */
export async function syncServerClock(force = false): Promise<void> {
  // Collapses the mount burst: every hook that mounts in the same tick awaits one shared request.
  if (inFlight) return inFlight;
  if (!force && syncedAt !== null && Date.now() - syncedAt < MIN_SYNC_INTERVAL_MS) return;

  inFlight = (async () => {
    try {
      const sentAt = Date.now();
      const { data, error } = await supabase.rpc("server_now");
      const receivedAt = Date.now();
      if (error || !data) return;

      const serverMs = new Date(data as string).getTime();
      if (!Number.isFinite(serverMs)) return;

      // The server read its clock somewhere inside the round trip, so the best estimate of the
      // local time that reading corresponds to is the midpoint - not `receivedAt`, which would
      // bake half the latency into the offset as permanent error.
      const localAtServerRead = sentAt + (receivedAt - sentAt) / 2;
      offsetMs = serverMs - localAtServerRead;
      syncedAt = receivedAt;
    } catch {
      // Offline, blocked, or the function isn't there yet. Keep whatever offset we already had.
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Now, on the database's clock.
 *
 * Falls back to the raw local clock before the first sync lands (and if it never does), which is
 * exactly the old behaviour - so an unsynced client is no worse off than it was, never broken.
 */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** How far this browser's clock is from the database's, in ms. Positive means the PC is behind. */
export function clockOffsetMs(): number {
  return offsetMs;
}

/** Whether a sync has ever succeeded, for anything that wants to say so in the UI. */
export function clockSynced(): boolean {
  return syncedAt !== null;
}
