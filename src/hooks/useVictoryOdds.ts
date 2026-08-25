import { useMemo, useRef } from "react";
import { activeTeams } from "../lib/battleshipLogic";
import { matchStartedAt } from "../lib/matchTime";
import { fleetStates, oddsTimeline, victoryOdds, type OddsPoint, type OddsSnapshot } from "../lib/victoryOdds";
import type { Attack, Player, Room } from "../types/battleship";

export interface VictoryOddsRead {
  snapshot: OddsSnapshot | null;
  timeline: OddsPoint[];
}

const EMPTY: VictoryOddsRead = { snapshot: null, timeline: [] };

/**
 * Each fleet's chance of winning, recomputed only when a shot actually lands.
 *
 * -- Why this is keyed rather than memoised on its inputs ---------------------------------------
 *
 * `attacks` is a fresh array on every realtime message the room receives - a player joining, a
 * fleet being confirmed, a team being renamed, a pause opening. The model behind this is a Monte
 * Carlo simulation of ten thousand matches, not an arithmetic expression. Memoised on the array's
 * identity it would re-roll all ten thousand every time anything in the room twitched; keyed on the
 * SHOT COUNT it runs once per kill, which in a real match is about once a minute.
 *
 * So the inputs are read through a ref and the dependency is a key naming everything that can
 * genuinely move the number: whose shots, how many, which fleets, how many captains fly each, and
 * whether the clock has stopped (pausing changes every pace measurement). Anything not in that key
 * cannot change the odds, and anything that can is in it.
 *
 * @param withTimeline whether to replay the whole match for the history line. Costs one simulation
 * per sampled point - about 85ms for a duel - so a surface that only prints the current number says
 * no and skips it entirely.
 */
export function useVictoryOdds(
  attacks: Attack[],
  room: Room | null,
  players: Player[],
  withTimeline = false
): VictoryOddsRead {
  const teams = activeTeams(players);
  let shots = 0;
  for (const a of attacks) if (a.cell_index >= 0) shots++;
  const crews = teams.map((t) => players.reduce((n, p) => (p.team === t ? n + 1 : n), 0)).join(",");

  const key = [
    room?.id ?? "",
    room?.board_size ?? 0,
    shots,
    teams.join(","),
    crews,
    withTimeline ? 1 : 0,
    room?.pause_at ?? "",
    room?.resume_at ?? "",
  ].join("|");

  // Read inside the memo, never compared by it - see the note above.
  const latest = useRef({ attacks, room, players, teams });
  latest.current = { attacks, room, players, teams };

  return useMemo(() => {
    const { attacks: log, room: current, players: crew, teams: fleetTeams } = latest.current;
    if (!current || fleetTeams.length < 2) return EMPTY;
    const shipDefs = current.ship_defs ?? [];
    if (shipDefs.length === 0) return EMPTY;

    const fleets = fleetStates(log, fleetTeams, shipDefs, crew, current);
    return {
      snapshot: victoryOdds(fleets, current.board_size),
      timeline: withTimeline
        ? oddsTimeline(log, fleetTeams, shipDefs, crew, current.board_size, matchStartedAt(log), current)
        : [],
    };
    // `key` IS the dependency: it names every input that can move the odds, and the inputs
    // themselves are read through a ref so that a new `attacks` array alone cannot trigger ten
    // thousand rollouts. See the note above.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, withTimeline]);
}
