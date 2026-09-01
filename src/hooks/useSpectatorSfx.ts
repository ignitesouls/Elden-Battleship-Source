import { useCallback, useEffect, useRef } from "react";
import { playSfx } from "../lib/sfx";
import type { DeepMark } from "../lib/deepWater";
import { freshDeepEvents } from "../lib/deepQueue";
import type { Attack } from "../types/battleship";

/**
 * What each find sounds like.
 *
 * Two of them borrow rather than owning a file: Laboon takes the whale call, because two creatures
 * in the same register may share one, and Patches takes the tentacle sound, since hearing the dread
 * and getting HIM is the joke. Alexander uses one file for both his states, which is the same
 * argument the tentacle and the sleeper make.
 *
 * The Dutchman borrowed the whale too, until she got her bell. The register was right and the
 * reasoning still reads, but a whale call is an animal making a noise, and the entire point of that
 * ship is that there is nobody aboard to make one - see lib/sfx.
 */
const SOUND = {
  whale: "whale",
  laboon: "whale",
  tentacle: "tentacle",
  sleeper: "awaken",
  dutchman: "dutchman",
  patches: "tentacle",
  bottle: "bottle",
  jar: "jar",
  jarFree: "jar",
  // The only two finds here with their own voice rather than a borrowed noise - see lib/sfx.
  igon: "igonFinger",
  igonAvenged: "igonHappy",
} as const;

/**
 * How long to leave between two stings.
 *
 * A spacing rather than a duration: playSfx clones an Audio element and returns, so there is no
 * completion to wait for and no way to ask a file how long it is. This is long enough that the two
 * longest - the whale call and the waking - do not talk over the front of whatever follows them,
 * and short enough that a second find still feels like part of the same moment.
 */
const SFX_GAP_MS = 1500;

/**
 * How far behind a sighting the third-fate sting arrives.
 *
 * Under the Dutchman's bell rather than after it. Her cue is 3.8s of swell, two tolls at 0.18 and
 * 1.32, and a long tail; 1.2s puts the sting over the top of the second toll, so what a listener
 * hears is one event that resolves rather than a find and then an announcement about it.
 */
export const FATES_DELAY_MS = 1200;

/**
 * The gap owed to whatever is queued BEHIND a sighting that carries the sting.
 *
 * The ordinary gap is measured from one sting to the next, and this one is 6.3s that starts after
 * the sighting has already begun - so the usual 1500 would drop the next find straight onto the
 * front of it. This protects the ARRIVAL and not the whole file: waiting out all 7.5s would stall
 * the queue on a board where other things are still being found, and a tail is allowed to be played
 * over. The 3.8s Dutchman bell is already treated that way by the ordinary gap.
 */
const FATES_GAP_MS = FATES_DELAY_MS + 3000;

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
 * @param fates squares where a sighting was somebody's THIRD - lib/deepWater's fatesConfirmed. Squares
 * rather than people because that is all this hook has: `deepCells` is a map of marks, and who fired
 * anything was thrown away several layers up. Omit it and sightings simply sound like sightings.
 */
export function useSpectatorSfx(
  attacks: Attack[],
  enabled = true,
  deepCells?: ReadonlyMap<number, DeepMark>,
  fates?: ReadonlySet<number>
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
  /**
   * Finds waiting to be heard, and the timer walking through them.
   *
   * It used to play one find per tick and drop the rest, because the case it was defending against
   * was the wake - four squares changing at once, which as four overlapping stings is a mess. That
   * is now handled properly one layer down: freshDeepEvents collapses a wake into the single event
   * it always was, so what reaches here is distinct finds, and dropping those was only ever losing
   * information. Two crews turning up two different things a second apart is rare, and it is
   * exactly the moment a stream should be making a noise about both.
   */
  /**
   * The square travels with the mark, which it did not used to.
   *
   * A queue of marks alone was enough while every find of a kind sounded the same. It stopped being
   * enough with the third-fate chord: two sightings in one match are the same mark on different
   * squares, and only one of them is anybody's third.
   */
  const waiting = useRef<Array<{ cell: number; mark: DeepMark }>>([]);
  const timer = useRef<number | null>(null);
  /**
   * The chord's own timer, held separately from the queue's.
   *
   * It has to be: the queue moves on while this is still pending, so a single ref would be
   * overwritten by the next find and the chord would never be cancelled on unmount.
   */
  const fatesTimer = useRef<number | null>(null);
  /**
   * The live set, read at the moment a sighting is played rather than captured when it was queued.
   *
   * `pump` is a stable callback and the set arrives as a prop, so closing over it would freeze
   * whatever was passed on the first render - which is an empty match, every time.
   */
  const fatesRef = useRef<ReadonlySet<number> | undefined>(fates);
  fatesRef.current = fates;

  const pump = useCallback(() => {
    const next = waiting.current.shift();
    if (next === undefined) {
      timer.current = null;
      return;
    }
    playSfx(SOUND[next.mark]);

    // Somebody's third sail. The chord goes in behind the bell rather than after it - see
    // FATES_DELAY_MS - and whatever is queued behind waits for it.
    const confirmed = next.mark === "dutchman" && (fatesRef.current?.has(next.cell) ?? false);
    if (confirmed) {
      if (fatesTimer.current !== null) clearTimeout(fatesTimer.current);
      fatesTimer.current = window.setTimeout(() => {
        fatesTimer.current = null;
        playSfx("fates");
      }, FATES_DELAY_MS);
    }

    timer.current = window.setTimeout(pump, confirmed ? FATES_GAP_MS : SFX_GAP_MS);
  }, []);

  // A queue that outlived its page would go on playing into a closed tab.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (fatesTimer.current !== null) clearTimeout(fatesTimer.current);
      timer.current = null;
      fatesTimer.current = null;
      waiting.current = [];
    };
  }, []);

  useEffect(() => {
    if (!enabled || !deepCells) return;
    // Priming, the wake collapse and the headline ordering all live in lib/deepQueue, shared with
    // the alert source so the sound and the picture can never disagree about what just happened.
    const { fresh, keys } = freshDeepEvents(
      [...deepCells].map(([cell, mark]) => ({ cell, mark, item: { cell, mark } })),
      heardDeep.current
    );
    heardDeep.current = keys;
    if (fresh.length === 0) return;

    waiting.current.push(...fresh);
    // Nothing draining yet, so this find is heard now rather than after a gap it did not earn.
    if (timer.current === null) pump();
  }, [deepCells, enabled, pump]);
}
