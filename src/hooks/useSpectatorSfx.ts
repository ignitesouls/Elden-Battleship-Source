import { useEffect, useRef } from "react";
import { playSfx } from "../lib/sfx";
import type { DeepMark } from "../lib/deepWater";
import { isHeadline } from "../lib/deepLabels";
import type { Attack } from "../types/battleship";

/**
 * Sound for someone watching rather than playing.
 *
 * Spectators used to sit through a silent match: every hit, miss and sinking is announced from
 * BattlePhase, which only mounts for a player with a fleet, so a caster (or a host who chose to
 * spectate) heard the two horns and nothing else for the rest of the game.
 *
 * Two differences from the player's version, both deliberate:
 *
 *  * One sound per SHOT, not per attack row. A single trigger-pull writes a row per opposing
 *    team, and a player only ever sees the row aimed at (or fired by) them - a spectator sees all
 *    of them, so playing each would turn a three-team volley into a wall of noise. Rows are
 *    grouped by attacker, square and timestamp, exactly as the archive groups them.
 *  * The loudest outcome in the group wins: a shot that sinks something is a sinking, even if it
 *    missed two other fleets at the same time.
 *
 * The first pass only primes the seen-set, so opening a match already in progress doesn't replay
 * the whole log at once.
 *
 * @param deepCells what has been found in the water, if the caller knows (see lib/deepWater). Passing
 * it is what lets a whale sing on a spectator's screen: the shot that found it is a miss against every
 * fleet, so from `attacks` alone the rarest moment in a match sounds like the dullest one.
 */
export function useSpectatorSfx(
  attacks: Attack[],
  enabled = true,
  deepCells?: ReadonlyMap<number, DeepMark>
): void {
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  /** Squares already sung about, keyed with what was on them. Null until the first pass has primed it. */
  const heardDeep = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // sunk beats hit beats miss, so a group resolves to its most significant sound.
    const rank = { sunk: 3, hit: 2, miss: 1 } as const;
    const shots = new Map<string, keyof typeof rank>();

    for (const a of attacks) {
      if (a.cell_index < 0 || a.result === "pending") continue;
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      if (!primed.current) continue;

      const key = `${a.attacker_team}:${a.cell_index}:${a.created_at}`;
      const best = shots.get(key);
      if (!best || rank[a.result as keyof typeof rank] > rank[best]) {
        shots.set(key, a.result as keyof typeof rank);
      }
    }

    for (const result of shots.values()) playSfx(result);
    primed.current = true;
  }, [attacks, enabled]);

  /**
   * The whale, in place of the miss it would otherwise have sounded like.
   *
   * Its own effect rather than a branch inside the one above, because it is keyed on a different thing:
   * a find is a square, not an attack row, and the row that produced it has already been played as a
   * miss by the time this runs. Both sounds firing together is correct - the splash, then the whale.
   */
  useEffect(() => {
    if (!enabled || !deepCells) return;
    // Square AND kind, so the four squares turning from "tentacle" to "sleeper" the moment he wakes
    // count as news rather than as squares already heard. See the same note in BattlePhase.
    const key = (cell: number, kind: DeepMark) => `${cell}:${kind}`;
    const heard = heardDeep.current;
    heardDeep.current = new Set([...deepCells].map(([cell, kind]) => key(cell, kind)));
    if (!heard) return; // first pass primes only

    // One at a time - a four-tentacle wake is not four sounds at once - and the waking wins.
    const fresh = [...deepCells].filter(([cell, kind]) => !heard.has(key(cell, kind)));
    // The two long ones win the tick. Both are the biggest thing that can happen in a match and both
    // can land alongside an ordinary find - so without this, the sleeper waking or Igon getting to his
    // feet can be silently dropped in favour of whichever square sorted first. Shared with the alert
    // source, so the sound and the picture always agree about which find was the event.
    const next = fresh.find(([, kind]) => isHeadline(kind)) ?? fresh[0];
    if (!next) return;

    /**
     * What each find sounds like.
     *
     * Two of them borrow rather than owning a file: the ghost ship takes the whale call, because a
     * mournful horn out of the fog is the same register and Laboon already established that two
     * creatures may share one, and Patches takes the tentacle sound, since hearing the dread and
     * getting HIM is the joke. Alexander uses one file for both his states, which is the same
     * argument the tentacle and the sleeper make.
     */
    const SOUND = {
      whale: "whale",
      laboon: "whale",
      tentacle: "tentacle",
      sleeper: "awaken",
      dutchman: "whale",
      patches: "tentacle",
      bottle: "bottle",
      jar: "jar",
      jarFree: "jar",
      // The only two finds here with their own voice rather than a borrowed noise - see lib/sfx.
      igon: "igonFinger",
      igonAvenged: "igonHappy",
    } as const;

    playSfx(SOUND[next[1]]);
  }, [deepCells, enabled]);
}
