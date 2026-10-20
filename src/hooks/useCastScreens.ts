import { useEffect, useMemo, useState } from "react";
import type { Player } from "../types/battleship";
import { screensFromRoster, fetchScreenProfiles, type CastScreen, type ScreenProfile } from "../lib/castScreens";

/**
 * The casting scene's player boxes, resolved from a room's roster and kept current as it changes.
 *
 * Takes `players` from the caller's own useRoom rather than opening a subscription of its own: the
 * screen source is already watching the room for its hit/miss tallies, and a parallel realtime
 * channel for the same rows would be duplicated egress - the cost lib/attackFeed and useFollowedSeat
 * are both shaped to avoid. The Twitch logins and site names are re-fetched only when the competing
 * roster's shape actually changes, which between matches is rare and mid-match is never - so a player
 * who renames their account mid-match keeps the old nametag until the next match.
 */
export function useCastScreens(players: Player[]): CastScreen[] {
  const [profiles, setProfiles] = useState<Map<string, ScreenProfile>>(new Map());

  const competitorIds = useMemo(
    () =>
      players
        .filter((p) => p.team !== null && p.team !== undefined)
        .map((p) => p.user_id),
    [players]
  );

  /** Changes only when a competitor joins, leaves or swaps fleet - never on a shot landing. */
  const rosterKey = useMemo(() => [...competitorIds].sort().join("|"), [competitorIds]);

  useEffect(() => {
    let cancelled = false;
    void fetchScreenProfiles(rosterKey ? rosterKey.split("|") : []).then((map) => {
      if (!cancelled) setProfiles(map);
    });
    return () => {
      cancelled = true;
    };
  }, [rosterKey]);

  return useMemo(() => screensFromRoster(players, profiles), [players, profiles]);
}
