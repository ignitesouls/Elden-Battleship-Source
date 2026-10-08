import { useEffect, useMemo, useState } from "react";
import { fetchPlayerPowers } from "../lib/tournament/api";
import { ratedCount, teamPower, type PlayerPower } from "../lib/tournament/teamPower";

export interface TeamPowerInfo {
  /** The team's power, on the Elo scale (1500 is an average side). */
  power: number;
  /** How many of its players the archive knows anything about. */
  rated: number;
  size: number;
}

/**
 * Team power for a set of rosters: team id -> its players' account ids.
 *
 * One request to the battle-ratings function for every player at once, then the arithmetic here (see
 * lib/tournament/teamPower). `refreshKey` is what makes it "live" without costing a request a minute:
 * pass something that changes when a result comes in - the number of finished matches, say - and the
 * powers are fetched again then, and only then. The server recomputes on its own when the archive moves.
 *
 * Null while loading, or when the function can't answer - callers show no power rather than a guess.
 */
export function useTeamPowers(rosters: ReadonlyMap<string, readonly string[]>, refreshKey: unknown = 0): Map<string, TeamPowerInfo> | null {
  // A stable key for "these players", so a re-render with the same rosters is not a new request.
  const ids = useMemo(() => [...new Set([...rosters.values()].flat())].sort(), [rosters]);
  const idsKey = ids.join(",");
  const [players, setPlayers] = useState<Map<string, PlayerPower> | null>(null);

  useEffect(() => {
    if (ids.length === 0) {
      setPlayers(new Map());
      return;
    }
    let cancelled = false;
    fetchPlayerPowers(ids)
      .then((found) => !cancelled && setPlayers(found))
      .catch(() => !cancelled && setPlayers(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, refreshKey]);

  return useMemo(() => {
    if (!players) return null;
    const out = new Map<string, TeamPowerInfo>();
    for (const [team, roster] of rosters) {
      const list = roster.map((id) => players.get(id));
      const power = teamPower(list);
      if (power !== null) out.set(team, { power, rated: ratedCount(list), size: roster.length });
    }
    return out;
  }, [players, rosters]);
}
