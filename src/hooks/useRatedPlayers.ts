import { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { cached } from "../lib/archiveCache";

/** One player as the battle-ratings function's `{ board: true }` mode hands them back. */
export interface RatedPlayer {
  /** Same shape as participantKey: user id when signed in, `name:<nickname>` for guests. */
  key: string;
  name: string;
  avatar: string | null;
  verified: boolean;
  elo: number;
  /** Two-fleet games behind the Elo. 0 means none: the Elo is just the 1500 everyone starts on. */
  games: number;
  /** The shrunk battle-rating average (see lib/tournament/teamPower), or null with no rated game. */
  battle: number | null;
}

/**
 * Every rated player, in one request.
 *
 * Through the shared cache so a visitor bouncing between the leaderboard and other pages doesn't ask
 * again each time - every request is a log line.
 */
function fetchRatedPlayers(): Promise<RatedPlayer[]> {
  return cached("ratings-board", async () => {
    const { data, error } = await supabase.functions.invoke("battle-ratings", { body: { board: true } });
    if (error || !data || !Array.isArray(data.players)) return [];
    return data.players as RatedPlayer[];
  });
}

/**
 * All-time Elo and battle rating per player key, or null while loading.
 *
 * NOT per board: both are worked out across every board at once, the same numbers the tournament
 * pages' team power is built from.
 */
export function useRatedPlayers(): Map<string, RatedPlayer> | null {
  const [players, setPlayers] = useState<Map<string, RatedPlayer> | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setPlayers(new Map());
      return;
    }
    let cancelled = false;
    fetchRatedPlayers()
      .then((list) => !cancelled && setPlayers(new Map(list.map((p) => [p.key, p]))))
      .catch(() => !cancelled && setPlayers(new Map()));
    return () => {
      cancelled = true;
    };
  }, []);

  return players;
}
