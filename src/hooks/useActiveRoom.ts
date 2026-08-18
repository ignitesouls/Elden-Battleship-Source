import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { getActiveRoom, clearActiveRoom } from "../lib/playerSession";
import { lookupRoom } from "../lib/rooms";
import { isSupabaseConfigured } from "../lib/supabase";

/**
 * The room this browser is in, confirmed to still exist.
 *
 * The stored code on its own was never evidence of anything. Rooms are swept an hour after they go
 * quiet, and the one place that forgot the code was the room page noticing the room had vanished -
 * which only helps someone who was looking at it when it went. Close the tab mid-match, come back
 * tomorrow, and the top bar still offered "back to SALTY KRAKEN" pointing at nothing at all.
 *
 * So the code is checked rather than trusted. One indexed read of a world-readable table, and only
 * when there is a code to check.
 *
 * -- The three answers, and why they are three and not two -----------------------------------
 *
 *   a room  - it's there; the caller can say what it's doing as well as where it is.
 *   null    - confirmed gone, so the stored code is dropped and the link goes with it.
 *   undefined (read failed) - NOT the same as gone. An offline browser, a blocked request or a
 *             cold start is not evidence about the room, and hiding the way back to a live match
 *             because a request failed would be worse than the stale link this exists to fix.
 *             The link stays; the next navigation tries again.
 */
export interface ActiveRoom {
  code: string;
  /** Null while the check is still out, or when a read failed and we're showing the link anyway. */
  status: string | null;
}

/**
 * Verdicts already reached, so moving between the leaderboard, the almanac and a stats page is one
 * read rather than one per page. Module-level because the top bar unmounts on the overlay routes
 * and would otherwise re-ask on the way back.
 */
const checked = new Map<string, { status: string | null; at: number }>();

/** Long enough that browsing doesn't re-read, short enough that a room deleted mid-session goes. */
const RECHECK_MS = 60_000;

export function useActiveRoom(): ActiveRoom | null {
  // Read on every render rather than held in state: it changes from another component (and another
  // tab), and the bar re-renders on navigation anyway, which is exactly when it matters.
  const code = getActiveRoom();
  const { pathname } = useLocation();
  // Only to re-run the check as you move around; the verdict itself lives in `checked`.
  const [, bump] = useState(0);

  useEffect(() => {
    if (!code || !isSupabaseConfigured) return;
    const seen = checked.get(code);
    if (seen && Date.now() - seen.at < RECHECK_MS) return;

    let cancelled = false;
    void lookupRoom(code).then((room) => {
      if (cancelled) return;
      // undefined is a failed read, not a missing room - leave no verdict behind so the next
      // navigation asks again, and leave the link alone in the meantime.
      if (room === undefined) return;
      checked.set(code, { status: room?.status ?? null, at: Date.now() });
      // Gone for good. Forgetting it here rather than only hiding the link matters: the code is
      // what the room page reads on the way in, and a code nothing answers to is just a trap.
      if (!room) clearActiveRoom(code);
      bump((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [code, pathname]);

  if (!code) return null;
  const seen = checked.get(code);
  if (seen && seen.status === null) return null; // confirmed gone
  return { code, status: seen?.status ?? null };
}
