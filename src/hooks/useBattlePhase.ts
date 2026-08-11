import { useEffect, useState } from "react";
import { matchStartedAt, battlePhaseAt, matchTimings, type BattlePhaseInfo } from "../lib/matchTime";
import { serverNow, syncServerClock } from "../lib/serverTime";
import type { Attack, Room } from "../types/battleship";

/** How often to re-check the offset. Covers an NTP correction landing mid-match. */
const RESYNC_MS = 5 * 60 * 1000;

/**
 * Ticks every second and returns which of STARTING/PREPARATION/MATCH the battle is currently in.
 *
 * Reads `serverNow()` rather than `Date.now()`: the start instant this counts from is a Postgres
 * timestamp, so the two have to be on the same clock or every player's timer is offset by whatever
 * their own PC clock is wrong by. See lib/serverTime.ts.
 */
export function useBattlePhase(attacks: Attack[], room?: Room | null): BattlePhaseInfo | null {
  const startedAt = matchStartedAt(attacks);
  const [now, setNow] = useState(() => serverNow());

  useEffect(() => {
    if (!startedAt) return;

    // Kick a sync immediately, then tick. The first reading may briefly use a stale offset, which
    // is still no worse than the raw local clock it replaced.
    void syncServerClock().then(() => setNow(serverNow()));

    const tick = setInterval(() => setNow(serverNow()), 1000);
    const resync = setInterval(() => void syncServerClock(), RESYNC_MS);
    return () => {
      clearInterval(tick);
      clearInterval(resync);
    };
  }, [startedAt]);

  return battlePhaseAt(startedAt, now, matchTimings(room));
}
