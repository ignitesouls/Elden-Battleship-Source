/**
 * The admin side of egress accounting: what a match cost, from both directions.
 *
 * Two sources, deliberately kept apart rather than added together:
 *
 *   measured   `egress_by_room`, summed from what each browser tab reported receiving. Covers
 *              realtime, which nothing on the server side can see, and covers REST as a check.
 *   billed     the `egress-usage` function, reading Supabase's own `edge_logs` byte counts for the
 *              same window. Covers REST/auth/storage exactly and realtime not at all.
 *
 * Their REST figures measure the same thing by different means, so the panel shows both and lets a
 * gap be visible. Adding them would double-count REST and still miss nothing extra.
 */
import { supabase } from "./supabase";
import { matchWindow, bytes } from "./egressUnits";

// Re-exported so the panel has one import for everything egress, rather than having to know which
// half of this feature happens to be pure.
export { matchWindow, bytes };

const CALL_TIMEOUT_MS = 30_000;

/** One room's worth of client-reported bytes. Mirrors the `egress_by_room` view. */
export interface RoomEgress {
  room_code: string | null;
  clients: number;
  players: number;
  spectators: number;
  overlays: number;
  casters: number;
  rest_bytes: number;
  rest_requests: number;
  rest_estimated: number;
  realtime_bytes: number;
  realtime_messages: number;
  first_seen: string;
  last_seen: string;
}

/** What Supabase says it sent, for one window. */
export interface BilledEgress {
  window: { startedAt: string; endedAt: string };
  requests: number;
  bytes: number;
  withoutLength: number;
  byPath: Array<{ path: string; requests: number; bytes: number }>;
  retentionWarning: boolean;
  covers: string;
}

/**
 * Every room that has reported bytes, newest first.
 *
 * Admin-only by RLS on the underlying table, so this returns an empty list rather than an error for
 * anyone else - the same shape the rest of lib/admin uses.
 */
export async function listRoomEgress(limit = 40): Promise<RoomEgress[]> {
  const { data, error } = await supabase
    .from("egress_by_room")
    .select(
      "room_code,clients,players,spectators,overlays,casters,rest_bytes,rest_requests,rest_estimated,realtime_bytes,realtime_messages,first_seen,last_seen"
    )
    .order("last_seen", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as RoomEgress[];
}

export type BilledResult =
  | { ok: true; data: BilledEgress }
  | { ok: false; reason: string; status?: number };

/**
 * Asks Supabase what it sent during one window.
 *
 * The reasons are worth distinguishing rather than collapsing into "it failed", because two of them
 * are configuration rather than breakage and the panel can say what to do about them:
 * `no_management_token` means the secret was never set, and an empty result means the window has
 * fallen off the end of log retention.
 */
export async function fetchBilledEgress(
  startedAt: string,
  endedAt: string
): Promise<BilledResult> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), CALL_TIMEOUT_MS)
    );
    const { data, error } = await Promise.race([
      supabase.functions.invoke("egress-usage", { body: { startedAt, endedAt } }),
      timeout,
    ]);

    // Same dig as balanceStats.invoke: a non-2xx arrives as an error and the reason is inside the
    // Response, which is also the only place a platform-level failure says anything at all.
    if (error) {
      const ctx = (error as { context?: Response }).context;
      const status = ctx?.status;
      const raw = ctx ? await ctx.clone().text().catch(() => "") : "";
      let reason = "";
      try {
        reason = (JSON.parse(raw) as { error?: string })?.error ?? "";
      } catch {
        reason = raw.slice(0, 200);
      }
      return { ok: false, status, reason: reason || (error as Error).message };
    }
    if (!data) return { ok: false, reason: "no data" };
    const asError = (data as { error?: string }).error;
    if (asError) return { ok: false, reason: asError };
    return { ok: true, data: data as BilledEgress };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

