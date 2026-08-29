import { groupIntoShots, type FeedShot } from "./attackFeed";
import { cellLabel } from "./battleshipLogic";
import { teamName } from "./teamColors";
import { formatDuration, matchStartedAt, matchTimings } from "./matchTime";
import { pausedMsAt, pausedMsBefore, pauseWindows, type PauseFields } from "./matchPause";
import { shipCellIndices } from "./shipCells";
import { deepWater, bottleNote, type DeepHide, type DeepWater } from "./deepWater";
import { seedFrom, rng } from "./seededRandom";
import { paceFromGaps, paceLabel } from "./squarePace";
import type { Attack, Player, Room } from "../types/battleship";

export interface PlayerStats {
  playerId: string | null;
  nickname: string;
  team: number;
  /** Distinct trigger-pulls, not `attacks` rows - one shot writes one row per opponent. */
  shots: number;
  hits: number;
  misses: number;
  sunk: number;
  accuracy: number;
  /**
   * Median seconds from one of this captain's squares falling to the next, or null when they took
   * too few for a middle value to mean anything. Optional because reports archived before pace was
   * on the scoreboard carry no such number and never will - see the column in components/MatchReport.
   */
  pace?: number | null;
}

export interface Award {
  /** Nautical title, e.g. "Admiral of the Fleet". */
  title: string;
  emoji: string;
  nickname: string;
  detail: string;
}

export interface MatchReport {
  /** `roomCode:matchStartTimestamp` - identical on every client, used to dedupe saved reports. */
  matchKey: string;
  roomCode: string;
  winnerTeam: number | null;
  draw: boolean;
  duration: string;
  totalShots: number;
  stats: PlayerStats[];
  awards: Award[];
  /**
   * What the match turned up in the water, for the recap to draw (see lib/deepWater.ts).
   *
   * Only ever what was actually FOUND. A tentacle nobody fired at is not in here and cannot be -
   * its row is unreadable to every client until a shot at its square resolves, so the recap has
   * nothing to leak about the squares that were missed. That is the whole reason the report carries
   * this rather than the hiding places.
   */
  deep: DeepWater;
}

/**
 * The scoreboard for a set of shots - the same numbers the recap prints, at any point in a match.
 *
 * Split out of buildMatchReport so a live match can read them without building a whole report (and
 * without computing honors and duration for a match that hasn't finished). That is what the record
 * chase needs: see lib/recordChase.
 *
 * Sorted as the scoreboard sorts: sunk, then hits, then accuracy.
 *
 * `pause` is only wanted for the pace, which is the one figure here measured in time rather than in
 * shots: a gap spanning a stopped clock is the room waiting, not a captain working. Optional because
 * the live callers that want a running tally have no use for a pace - and a null pace is a dash on
 * screen, where a pace inflated by a twenty-minute break would be a wrong number wearing a right
 * one's clothes.
 */
export function buildPlayerStats(
  players: Player[],
  shots: FeedShot[],
  pause?: PauseFields | null
): PlayerStats[] {
  const byPlayer = new Map<string, PlayerStats>();
  /** Every gap between one captain's consecutive shots, in seconds on the match clock. */
  const gaps = new Map<string, number[]>();
  const previous = new Map<string, number>();

  // Seed from the roster first, so a player who never pulled the trigger still shows on the
  // scoreboard (as a row of zeroes) and can still be handed an award, rather than vanishing
  // from the recap entirely.
  for (const p of players) {
    if (p.team === null || p.team === undefined) continue; // spectators aren't competitors
    byPlayer.set(p.id, {
      playerId: p.id,
      nickname: p.nickname,
      team: p.team,
      shots: 0,
      hits: 0,
      misses: 0,
      sunk: 0,
      accuracy: 0,
      pace: null,
    });
  }

  // Oldest first, because a gap is only a gap in order - groupIntoShots hands these over newest
  // first, which would measure every one of them backwards. The tallies below don't care either way.
  const inOrder = [...shots].sort((a, b) => matchMs(a.at, pause) - matchMs(b.at, pause));

  for (const shot of inOrder) {
    // Rows for one shot share an attacker; group under the player when known, else the team,
    // so shots fired by someone who has since left the room still count toward their side.
    const row = shot.rows[0];
    const key = row.attacker_player_id ?? `team:${shot.attackerTeam}`;

    // Where their previous square fell. A captain's first shot opens no gap: the time before it is
    // the lobby and the placement phase, not work on a square.
    const at = matchMs(shot.at, pause) / 1000;
    const last = previous.get(key);
    previous.set(key, at);
    if (last !== undefined) {
      const list = gaps.get(key);
      if (list) list.push(at - last);
      else gaps.set(key, [at - last]);
    }
    let s = byPlayer.get(key);
    if (!s) {
      s = {
        playerId: row.attacker_player_id,
        nickname: shot.who,
        team: shot.attackerTeam,
        shots: 0,
        hits: 0,
        misses: 0,
        sunk: 0,
        accuracy: 0,
        pace: null,
      };
      byPlayer.set(key, s);
    }

    s.shots++;
    // A single shot lands on every opponent at once, so "was this a hit" is per-shot (did it
    // connect with anyone), while sunk counts every ship it actually put under.
    const connected = shot.rows.some((r) => r.result === "hit" || r.result === "sunk");
    if (connected) s.hits++;
    else if (shot.rows.some((r) => r.result === "miss")) s.misses++;
    s.sunk += shot.rows.filter((r) => r.result === "sunk").length;
  }

  // Thresholds and the median itself live in lib/squarePace, so a captain's pace here and their
  // pace on the leaderboard are the same measurement rather than two that happen to agree.
  for (const [key, s] of byPlayer) s.pace = paceFromGaps(gaps.get(key) ?? []);

  const stats = [...byPlayer.values()];
  for (const s of stats) s.accuracy = s.shots > 0 ? s.hits / s.shots : 0;
  stats.sort((a, b) => b.sunk - a.sunk || b.hits - a.hits || b.accuracy - a.accuracy);
  return stats;
}

export function buildMatchReport(
  room: Room,
  players: Player[],
  attacks: Attack[],
  deepHides: DeepHide[],
  /**
   * Where the board dealt Bayle, for Igon - see lib/challenges.bayleCell, which is the only thing
   * that can answer it and cannot be imported here: it reconstructs a board, which means binding the
   * square-set registry's JSON, which is exactly what scripts/check-honors.ts cannot load under bare
   * Node. Defaulted rather than required because the honor tests pass boards they never deal squares
   * onto, and null is the honest answer for those - no arena, no Igon.
   */
  bayleCell: number | null = null
): MatchReport {
  const shots = groupIntoShots(attacks, players);
  const stats = buildPlayerStats(players, shots, room);
  // Computed once and handed to both the honors and the recap's boards, which need the same answer:
  // an award naming a finder while the board it sits above marks a different square would be a bug
  // nobody could explain.
  const deep = deepWater(room, shots, deepHides, bayleCell);

  const startedAt = matchStartedAt(attacks);
  const lastShot = shots.length > 0 ? shots[0].at : null; // groupIntoShots sorts newest-first
  let duration = "--:--";
  if (startedAt && lastShot) {
    // Stopped clock comes off the same way the countdown buffer does, and for the same reason: this
    // is the match that was played, not the evening it was played over. Measured at the LAST SHOT
    // rather than at now, so a pause that is still open when the recap renders bills only the part
    // of it that had passed by the time the match ended.
    //
    // Mirrors archive_match, which recomputes this from the room's own columns when the result is
    // filed (see the match_pause migration). The recap on screen and the record in the book have to
    // read the same, or a crew watching their own duration will catch the difference.
    const lastShotMs = new Date(lastShot).getTime();
    const stopped = pausedMsBefore(pauseWindows(room), lastShotMs);
    const secs = (lastShotMs - new Date(startedAt).getTime() - stopped) / 1000;
    duration = formatDuration(secs - matchTimings(room).matchBeginsAt);
  }

  // Stable across every client in the room, so concurrent saves dedupe on it (see the
  // match_reports.match_key unique constraint) - which is exactly the property the honors draw
  // needs from a seed, so it doubles as one.
  const matchKey = `${room.code}:${startedAt ?? "unknown"}`;

  return {
    matchKey,
    roomCode: room.code,
    winnerTeam: room.winner_team,
    draw: room.winner_team === null,
    duration,
    totalShots: shots.length,
    stats,
    // The note is read from the square rather than the find, because it is a property of the bottle
    // and exists whether or not anybody ever fished that one out. Four bottles, four notes - hence a
    // lookup rather than a string.
    awards: buildAwards(
      stats,
      shots,
      room.board_size,
      room.ship_defs?.length ?? 0,
      deep,
      (cell) => bottleNote(room, cell),
      matchKey,
      room
    ),
    deep,
  };
}

/** An instant on the match clock: wall time with any stopped clock before it taken off. */
function matchMs(at: string, pause?: PauseFields | null): number {
  const ms = new Date(at).getTime();
  return ms - pausedMsAt(pause, ms);
}

/** One shot's worth of facts, resolved back to the player who pulled the trigger. */
interface Salvo {
  shot: FeedShot;
  player: PlayerStats | undefined;
  atMs: number;
  row: number;
  col: number;
  /** Landed on at least one fleet. */
  connected: boolean;
  /** At least one row came back from the server, so it can count toward a streak. */
  resolved: boolean;
  /** How many separate fleets this single shot struck - only ever >1 in a 3+ team room. */
  fleetsStruck: number;
}

/**
 * A hull that went down, with its footprint rebuilt from the sinking row.
 *
 * The footprint is what makes per-ship honors possible: `attacks` records which square was hit,
 * not which ship was under it, so the only way to know that four earlier hits belonged to the
 * same Battleship is to reconstruct the hull from the sunk_start_* columns and look back. Hulls
 * still afloat at the end can't be reconstructed at all, which is why every ship-level honor here
 * is about a ship that sank.
 */
interface Hull {
  name: string;
  size: number;
  defenderTeam: number;
  /** Who landed the killing blow. */
  finisher: PlayerStats | undefined;
  /** Null on rows archived before the sunk_start_* columns existed. */
  cells: Set<number> | null;
  hitsBy: Map<PlayerStats, number>;
}

/** Per-player facts the plain scoreboard columns don't carry. */
interface Metrics {
  longestHitStreak: number;
  longestMissStreak: number;
  rows: Set<number>;
  cols: Set<number>;
  /** Shots on the outer ring of the board. */
  rimShots: number;
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  /** Shortest gap between two of their own shots, in seconds. */
  fastestReload: number | null;
  /** Mean gap between their own shots, in seconds. */
  averageGap: number | null;
  fleetsStruckAtOnce: number;
  /** Kills on a hull another player had already wounded. */
  stolenFinishes: number;
  /** The single hull they poured the most hits into. */
  obsession: { hull: Hull; hits: number } | null;
  /** Their own first shot of the match landed. Measured on the first shot that resolved. */
  openedWithHit: boolean;
}

interface HonorContext {
  /** Scoreboard order: sunk, then hits, then accuracy. */
  stats: PlayerStats[];
  boardSize: number;
  /**
   * How many hulls each fleet was dealt - the same number for everybody, since every fleet in a room
   * is built from one preset (see types/battleship.fleetFor).
   *
   * 0 for a room whose ship_defs weren't recorded, which is the only honest answer there: without it
   * there is no way to tell a fleet wiped out from a fleet that merely lost a lot of ships, so the
   * honor that needs it simply doesn't appear.
   */
  fleetSize: number;
  metrics: Map<PlayerStats, Metrics>;
  /** Chronological. */
  hulls: Hull[];
  firstBlood: PlayerStats | undefined;
  /** Who found the whale, and where. Null in the great majority of matches. */
  whale: { player: PlayerStats | undefined; cellIndex: number } | null;
  /** Everyone who put a cannonball into Laboon, who did not mind. */
  laboon: Array<PlayerStats | undefined>;
  /** Sightings of the Flying Dutchman per player. He can be met more than once. */
  dutchman: Array<[PlayerStats, number]>;
  /** The first sail seen, whoever saw it. */
  dutchmanFirst: { player: PlayerStats; cellIndex: number } | null;
  /** Who got the FIRST of the four bottles out, and what that one turned out to say. */
  bottle: { player: PlayerStats | undefined; cellIndex: number; note: string } | null;
  /**
   * Alexander, in both halves, per crew that turned him up.
   *
   * Two people rather than one in each entry, because finding him and freeing him are different
   * deeds by different shots - often by different members of the same crew, since only that crew can
   * do either to their own jar. A list because he is met rather than caught: every crew that reaches
   * his square gets their own, and their own chance at the rescue (see deepWater.JarEncounter).
   */
  alexander: Array<{
    foundBy: PlayerStats | undefined;
    foundAt: number;
    freedBy: PlayerStats | undefined;
    freedAt: number | null;
  }>;
  /**
   * Igon, in both halves, per crew that met him. Empty in the great majority of matches, since the
   * board has to have dealt Bayle at all. See deepWater.IgonEncounter.
   *
   * A list for the same reason Alexander is one: he is met rather than caught, so every crew that
   * fires at his square gets their own finger and their own dragon to go and kill with it. Two
   * people per entry, because meeting him and finishing his business are different shots - often by
   * different members of the same crew, and never by a different crew.
   */
  igon: Array<{
    foundBy: PlayerStats | undefined;
    foundAt: number;
    avengedBy: PlayerStats | undefined;
    avengedAt: number | null;
  }>;
  /** Everyone Patches happened to, and how many times. */
  patches: Array<[PlayerStats, number]>;
  /**
   * Tentacles found, per player, and whether the last of them woke him.
   *
   * Any fleet's shot can find any tentacle - they are four squares in the room's water, not four
   * squares belonging to anybody - so this is counted across the whole board and the ladder of honors
   * below is per player.
   */
  tentacles: { by: Map<PlayerStats, number>; needed: number; awake: boolean; lastFinder: PlayerStats | undefined };
}

interface Claim {
  player: PlayerStats;
  detail: string;
}

interface Honor {
  title: string;
  emoji: string;
  /**
   * Everyone who genuinely earned this title, strongest claim first. The first player on the list
   * who isn't already holding an honor takes it; if they're all spoken for, the title goes
   * unawarded rather than being handed to someone who didn't do the thing.
   */
  earnedBy: (c: HonorContext) => Claim[];
  /**
   * Awarded ahead of the draw, in list order, to the strongest claim that is still free.
   *
   * For the handful of deeds that ARE the story of the match. Everything without this flag goes
   * into the pool below and is drawn at random from what each player actually earned - see
   * buildAwards for why that changed and what it fixed.
   *
   * Keep this list short. Every title marked here is one the draw can never reach, which is the
   * problem the draw exists to solve; the bar is "if somebody did this and the recap said something
   * else instead, the recap got it wrong".
   */
  guaranteed?: true;
  /**
   * Titles this one makes redundant FOR THE SAME PLAYER, by name.
   *
   * The ladders need it. `tentacleRung` is "at least n", so somebody who found three tentacles
   * genuinely earns Acolyte, Dreamer AND Whispers, and Potfriend's owner necessarily found the jar
   * they then shot loose. Under the old fixed order the strongest simply came first and the rest
   * were unreachable behind it; a draw has no such luck built in, and would happily tell a player
   * who found three tentacles that they found one.
   *
   * Only needed between POOLED titles. A guaranteed one takes its player out of the draw entirely,
   * so everything lesser it might have outranked is already unreachable for them.
   */
  supersedes?: string[];
}

/**
 * Every honor is an achievement, in descending order of prestige and how specific a story it
 * tells. Nothing here is positional or random: a title is only ever offered to players whose log
 * actually shows the deed, so re-rendering the same match always produces the same honors, and a
 * player who did nothing measurable gets nothing rather than a participation ribbon.
 *
 * Two shapes of title live in this list, and the difference decides whether it cascades:
 *
 *   - Ranked titles (Master Gunner, Sharpest Eye) describe a role, and the runner-up filling in is
 *     still true to it - the detail line states their own number, not the leader's.
 *   - Singular titles (Struck the Colors, Opening Broadside) describe one specific event. Those
 *     return exactly one claim, so when its owner already has an honor the title simply doesn't
 *     appear that match.
 *
 * Floors matter as much as the ordering. "Sharpest eye" off one lucky shot, or a wooden spoon in a
 * three-shot match, is noise rather than a distinction - so each honor carries a minimum sample,
 * and the honors below it pick up whoever the floors exclude.
 *
 * ORDER IS NOW LOAD-BEARING OUTSIDE THIS FILE. The record book's "Rarest honor" reads a position in
 * this list as how hard a title was to earn (see HONOR_ORDER below), so moving a title up or down
 * restates a standing record on the leaderboard rather than only deciding who gets first claim
 * tonight. Inserting a new one is free - the archive stores titles, not positions, so every held
 * record keeps its title and simply reads a rung further down a longer list.
 */
/**
 * The smallest crew Shaker's Protégé can be earned in.
 *
 * The title's whole claim is that nobody ELSE on your side closed out a hull, and in a small crew
 * that is not a deed, it is arithmetic. In a 1v1 it is unconditional: there is nobody else who could
 * have taken a killing blow, so beating the other fleet at all wins the rarest thing on this list -
 * which is what SALTYLANTERN handed out, to a player whose own fleet was never on the board.
 *
 * Three is the same line the rest of the app already draws between a small room and a full one:
 * bossSetForRoster switches a room off the 2v2 cut of the boss board when a crew reaches three, so
 * "3v3 or bigger" already means something specific here and this is that. Measured on the SWEEPER'S
 * OWN crew rather than on the room, because that is the crew the claim is about - a lone gunner
 * facing a six-strong fleet has still beaten nobody to the punch.
 */
const SHAKER_MIN_CREW = 3;

/** How many people were on one fleet. `stats` is seeded from the roster, so non-firers count. */
function crewSize(c: HonorContext, team: number): number {
  return c.stats.filter((s) => s.team === team).length;
}

const HONORS: Honor[] = [
  {
    title: "Shaker's Protégé",
    emoji: "🐐",
    guaranteed: true,
    /**
     * Every ship in an enemy fleet, every killing blow theirs.
     *
     * The hardest thing on this list to get, and first because of it - the one title ranked above
     * what the water is hiding, which is a deliberate statement about how hard it is. A crewmate
     * landing one lucky finish anywhere in the fleet ends the run, so it takes both the shooting and
     * a whole match where nobody else on your side closes out a hull. Anyone who did this is the top
     * sinker too, and would otherwise be handed "sank the most ships" while the far better story went
     * untold.
     *
     * Needs the fleet size to mean anything (see HonorContext.fleetSize): "sank every hull that went
     * down" is a different and much cheaper claim than "sank every hull they had".
     */
    earnedBy: (c) => {
      // A fleet with a hull still afloat isn't a sweep, whatever the shooting looked like.
      const sweeps = new Map<PlayerStats, number[]>();
      for (const [team, hulls] of wipedFleets(c)) {
        const finisher = hulls[0].finisher;
        if (!finisher || hulls.some((h) => h.finisher !== finisher)) continue;
        // Only a crew big enough for "alone" to mean anything - see SHAKER_MIN_CREW.
        if (crewSize(c, finisher.team) < SHAKER_MIN_CREW) continue;
        const teams = sweeps.get(finisher);
        if (teams) teams.push(team);
        else sweeps.set(finisher, [team]);
      }

      // Two fleets swept by one gunner only happens in a 3+ team room, and outranks one.
      return [...sweeps]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([player, teams]) => ({
          player,
          detail:
            teams.length > 1
              ? `wiped out ${teams.length} whole fleets alone - ${teams.length * c.fleetSize} killing blows`
              : `sank all ${c.fleetSize} of ${teamName(teams[0])}'s ships - every killing blow theirs`,
        }));
    },
  },
  /**
   * -- What the water is hiding ---------------------------------------------------------------------
   *
   * The whale, Laboon and Cthulhu's four tentacles: squares that hold something nobody was told about
   * and nobody can aim for (see lib/deepWater.ts). Any fleet's shot can find any of them, nobody is
   * told what anybody else has turned up, and the fourth tentacle wakes him for the whole room at once.
   *
   * The whole block sits above every honor that measures shooting, and only Shaker's Protégé outranks
   * it - because finding one of these is the rarest thing a match can hand out and none of it can be
   * earned by playing well. That ordering is load-bearing rather than decorative: one honor per player,
   * so anything ranked above the water quietly EATS a find. It used to be three titles - the Admiralty,
   * Captain Nemo and Ishmael all sat up here - and the match that prompted moving them turned up a
   * bottle and the Flying Dutchman while its two best gunners took "sank the most ships" and said
   * nothing about either. The tentacle rungs run down in order - four, three, two, one - and cascade
   * the way every ranked honor does, so two crewmates on three each take the top two rungs rather than
   * one of them taking nothing.
   */
  {
    title: "High Priest of R'lyeh",
    emoji: "🦑",
    guaranteed: true,
    earnedBy: (c) =>
      [...c.tentacles.by]
        .filter(([, n]) => c.tentacles.needed > 0 && n >= c.tentacles.needed)
        .map(([player, n]) => ({ player, detail: `found all ${n} tentacles alone and woke the sleeper` })),
  },
  {
    title: "Woke the Sleeper",
    emoji: "🌀",
    guaranteed: true,
    // The last tentacle, whoever else did the digging - singular, so no cascade.
    earnedBy: (c) =>
      c.tentacles.awake && c.tentacles.lastFinder
        ? [{ player: c.tentacles.lastFinder, detail: `landed the ${c.tentacles.needed}th tentacle - it is awake` }]
        : [],
  },
  {
    title: "Tormented No Longer",
    emoji: "🐉",
    guaranteed: true,
    supersedes: ["Igon's Furled Finger"],
    /**
     * Bayle dead, killed by a crew carrying one of his fingers.
     *
     * The highest of the deep-water titles that isn't a clean sweep of the tentacles, and what earns
     * it is the dragon rather than the man: meeting Igon is cheap now - one miss beside the arena -
     * but Bayle is one of the most expensive squares in the set, with bossTimeCost at 5278 and
     * bossReachability at 0.133, both near the far end. The board has to have dealt him at all, that
     * crew has to have fired beside him, and then they have to go and do it.
     *
     * Both halves are the SAME crew's, exactly as Alexander's are. A crew carrying a finger kills
     * their own dragon; another fleet doing it is not their vengeance. One per crew that managed it,
     * for the same reason Potfriend is.
     *
     * That is also why this supersedes the finger rather than sitting beside it - a player who did
     * both takes this one, and being told you also met him is a participation ribbon, exactly as it
     * is for Potfriend and the jar.
     */
    earnedBy: (c) =>
      c.igon.flatMap((ig) =>
        ig.avengedBy
          ? [
              {
                player: ig.avengedBy,
                detail: `killed Bayle at ${cellLabel(ig.avengedAt ?? 0, c.boardSize)} with Igon's finger, from ${cellLabel(ig.foundAt, c.boardSize)}`,
              },
            ]
          : []
      ),
  },
  {
    title: "Thrice-Cursed",
    emoji: "👻",
    guaranteed: true,
    /**
     * Three sightings of the Dutchman, by one person.
     *
     * Rarer than the whale, and above him because of it. Nothing about him can be caught (see
     * deepWater), so three sightings by one person means three of his squares reached, where the
     * whale is one square reached once and then gone.
     */
    earnedBy: (c) =>
      [...c.dutchman]
        .filter(([, n]) => n >= 3)
        .sort((a, b) => b[1] - a[1])
        .map(([player, n]) => ({ player, detail: `sighted the Flying Dutchman ${n} times and kept firing` })),
  },
  {
    title: "Acolyte of the Sleeper",
    emoji: "🔮",
    supersedes: ["Dreamer of R'lyeh", "Whispers in the Deep"],
    earnedBy: (c) => tentacleRung(c, 3),
  },
  {
    title: "Potfriend",
    emoji: "💪",
    supersedes: ["Found the Jar"],
    /**
     * Shot Alexander loose from the shallows.
     *
     * Above the whale because it needs two things rather than one: his square found at all, and then
     * a later miss on one of the four squares beside it.
     *
     * One per crew that managed it, since each crew has their own jar - the same way the Dutchman can
     * be sighted by everybody. The interaction with "Found the Jar" below is deliberate and survives
     * that: a player who did both takes this one and the other title goes unawarded under the
     * one-honor-per-player cascade, because getting him out is the whole deed and being told you also
     * found him is a participation ribbon.
     */
    earnedBy: (c) =>
      c.alexander.flatMap((jar) =>
        jar.freedBy
          ? [{ player: jar.freedBy, detail: `shot Alexander loose from ${cellLabel(jar.freedAt ?? 0, c.boardSize)}` }]
          : []
      ),
  },
  {
    title: "Wrong Whale",
    emoji: "🐳",
    /**
     * Laboon. Not an achievement by any reading, but it did happen to somebody and they deserve to
     * see it written down - and it belongs with the rest of what the water is hiding.
     *
     * Above the whale himself, which looks wrong and isn't: he is a 20% substitution ON a whale find,
     * so you have to reach the square AND lose the roll. He is strictly the rarer animal.
     */
    earnedBy: (c) =>
      c.laboon
        .filter((p): p is PlayerStats => p !== undefined)
        .map((player) => ({ player, detail: "put a cannonball into Laboon, who did not mind" })),
  },
  {
    title: "Dreamer of R'lyeh",
    emoji: "💤",
    supersedes: ["Whispers in the Deep"],
    earnedBy: (c) => tentacleRung(c, 2),
  },
  {
    title: "Captain Ahab",
    emoji: "🐋",
    /**
     * The whale (see lib/deepWater.ts). One square of open water on the whole board, never marked and
     * never hinted at, and this is what finding it is for.
     *
     * Singular by definition: there is one whale, it dies once, and if its killer already holds an
     * honor then Ahab goes unclaimed rather than to somebody who never saw it.
     *
     * First of the single finds, which are each one square of the open water and therefore about
     * equally likely - so the order among them is a tie broken on story rather than on odds. Moby
     * Dick wins that tie and always will. (The bottles are the exception: there are four of them,
     * and Beachcomber keeps its place anyway - see HONORS.md.)
     */
    earnedBy: (c) =>
      c.whale?.player
        ? [{ player: c.whale.player, detail: `found the white whale at ${cellLabel(c.whale.cellIndex, c.boardSize)}` }]
        : [],
  },
  {
    title: "Sighted the Dutchman",
    emoji: "⛵",
    // The first sail seen. Singular - the sighting, not the sighter, is the event.
    earnedBy: (c) =>
      c.dutchmanFirst
        ? [{ player: c.dutchmanFirst.player, detail: `sighted a sail at ${cellLabel(c.dutchmanFirst.cellIndex, c.boardSize)} with nothing under it` }]
        : [],
  },
  {
    title: "Beachcomber",
    emoji: "📜",
    /**
     * The note is quoted here rather than just the square, because the note IS the find - the bottle
     * is only the container it came in. Everywhere else it appears is transient or buried: a toast
     * that has gone by the time anybody reads it, a line in a log that scrolls, and an entry further
     * down the recap. The honors are the part people screenshot.
     */
    earnedBy: (c) =>
      c.bottle?.player
        ? [
            {
              player: c.bottle.player,
              detail: `fished a bottle out of the sea at ${cellLabel(c.bottle.cellIndex, c.boardSize)}. It said "${c.bottle.note}"`,
            },
          ]
        : [],
  },
  {
    title: "Found the Jar",
    emoji: "🏺",
    // The consolation for turning Alexander up and leaving him wedged. Per crew, like Potfriend
    // above, and only ever appears for a crew that never got him out - or one where the rescuer was
    // somebody else, who is already holding Potfriend.
    earnedBy: (c) =>
      c.alexander.flatMap((jar) =>
        jar.foundBy
          ? [
              {
                player: jar.foundBy,
                detail: `turned up a warrior jar at ${cellLabel(jar.foundAt, c.boardSize)}, wedged fast`,
              },
            ]
          : []
      ),
  },
  {
    title: "Igon's Furled Finger",
    emoji: "🏹",
    /**
     * Meeting Igon (see deepWater.IgonEncounter), and walking off with the finger rather than the
     * dragon.
     *
     * The consolation half, and it sits exactly where Found the Jar sits for exactly the same
     * reason: it is what a crew is left holding when they turned something up and never finished it.
     * Per crew, since he is met rather than caught - he hands one to everybody who comes past - and
     * so it only ever appears for a crew that never got to Bayle, or one whose dragon-killer is
     * already holding the title above.
     *
     * Cheap on its own. One miss on one of at most four squares, on a board that dealt the arena at
     * all, which is why it ranks below the single finds rather than above them: the whale is one
     * unmarked square in a hundred and this is a man who is hard to avoid once you are in the
     * neighbourhood.
     */
    earnedBy: (c) =>
      c.igon.flatMap((ig) =>
        ig.foundBy
          ? [
              {
                player: ig.foundBy,
                detail: `met Igon on the rocks at ${cellLabel(ig.foundAt, c.boardSize)} and was handed his furled finger`,
              },
            ]
          : []
      ),
  },
  {
    title: "Ahh, So It's You",
    emoji: "🙇",
    /**
     * Patches. Laboon's joke wearing Cthulhu's coat, and six places lower than Wrong Whale for a
     * reason: there are several tentacles rolling for him against the whale's one, so four chances at
     * a 20% substitution is a much easier thing to land than a single chance at it.
     */
    earnedBy: (c) =>
      [...c.patches]
        .sort((a, b) => b[1] - a[1])
        .map(([player, n]) => ({
          player,
          detail: n > 1 ? `reached for a tentacle and got Patches, ${n} times` : "reached for a tentacle and got Patches",
        })),
  },
  {
    title: "Whispers in the Deep",
    emoji: "🕯️",
    // Last in the tier, because one tentacle out of several is the most common thing in it by a
    // distance - on most boards somebody turns one up.
    earnedBy: (c) => tentacleRung(c, 1),
  },
  /**
   * -- Everything the shooting earns ----------------------------------------------------------------
   *
   * Below the easter eggs, all of it. Every honor from here down is read off the scoreboard or the
   * shape of somebody's shots.
   *
   * The first three are the ranking ones - the best story a losing crew has, then command, then the
   * hull hunted down alone - and they lead the block in that order. After those it is no order that
   * means anything: which of the rest a player is handed is a matter of what their log happened to
   * show rather than a ranking of the deeds against each other.
   */
  {
    title: "Ishmael",
    emoji: "📖",
    /**
     * "And I only am escaped alone to tell thee." The best gunner on a fleet that went down with
     * every hull lost.
     *
     * The one story the rest of this list can't tell: a player who shot well and lost anyway.
     * Everything below measures a deed against the room, so a losing crew's best is handed "most
     * hits landed" as though the night went fine. This says what actually happened, which is why it
     * sits above the Admiralty rather than below it.
     *
     * One claim per wiped fleet, and only for a player who landed something - cascading down to a
     * crewmate who did less would be a worse survivor than the wreck deserves. Needs fleetSize for
     * the same reason Shaker's Protege does (see wipedFleets).
     */
    earnedBy: (c) => {
      const survivors: PlayerStats[] = [];
      for (const [team] of wipedFleets(c)) {
        // c.stats is in scoreboard order, so the first crewmate who landed anything is their best.
        const best = c.stats.find((s) => s.team === team && s.hits > 0);
        if (best) survivors.push(best);
      }
      return survivors
        .sort((a, b) => b.sunk - a.sunk || b.hits - a.hits)
        .map((s) => ({
          player: s,
          detail:
            s.sunk > 0
              ? `${s.sunk} ${s.sunk === 1 ? "ship" : "ships"} sunk, and their own fleet still went down with all hands`
              : `${s.hits} hits landed, and their own fleet still went down with all hands`,
        }));
    },
  },
  {
    title: "Admiral of the Fleet",
    emoji: "⚓",
    earnedBy: (c) => {
      const sinkers = c.stats.filter((s) => s.sunk > 0);
      if (sinkers.length > 0) {
        return sinkers.map((s) => ({
          player: s,
          detail: `${s.sunk} ${s.sunk === 1 ? "ship" : "ships"} sent to the bottom`,
        }));
      }
      // A match where nothing sank still has a best gunner, and they take command.
      return c.stats
        .filter((s) => s.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .map((s) => ({ player: s, detail: `${s.hits} hits landed` }));
    },
  },
  {
    title: "Captain Nemo",
    emoji: "🐙",
    /**
     * A hull hunted down single-handed - every hit on it theirs, and the kill.
     *
     * The solo requirement is the honor, whatever the hull. Finding a ship's every square without a
     * crewmate stumbling into one of them is a piece of hunting, where "landed the last of six shots
     * a team took at it" is a coincidence of turn order. Hulls whose footprint can't be rebuilt are
     * excluded rather than assumed solo - see Hull.cells.
     *
     * Ranked by how many, then by the biggest one, because a Carrier taken alone is five squares
     * found without help and a Destroyer is two.
     */
    earnedBy: (c) => {
      const biggest = (hulls: Hull[]) => Math.max(...hulls.map((h) => h.size));
      return killsOf(c, (h) => h.cells !== null && h.hitsBy.size === 1)
        .sort((a, b) => b[1].length - a[1].length || biggest(b[1]) - biggest(a[1]))
        .map(([player, hulls]) => ({
          player,
          detail:
            hulls.length > 1
              ? `${hulls.length} hulls run down single-handed`
              : `ran the ${hulls[0].name} down single-handed - all ${hulls[0].size} squares`,
        }));
    },
  },
  {
    title: "Struck the Colors",
    emoji: "🏴",
    // The blow that ended the match - singular, so no cascade.
    earnedBy: (c) => {
      const last = c.hulls[c.hulls.length - 1];
      if (!last?.finisher) return [];
      return [{ player: last.finisher, detail: `sank ${teamName(last.defenderTeam)}'s ${last.name} to end it` }];
    },
  },
  {
    title: "Slayer of the Leviathan",
    emoji: "🛳️",
    earnedBy: (c) => {
      const biggest = Math.max(0, ...c.hulls.map((h) => h.size));
      if (biggest < 4) return []; // a Cruiser is not a leviathan
      return killsOf(c, (h) => h.size === biggest).map(([player, hulls]) => ({
        player,
        detail:
          hulls.length > 1
            ? `${hulls.length} great hulls broken, ${biggest} squares apiece`
            : `sank the ${hulls[0].name} - ${biggest} squares of hull`,
      }));
    },
  },
  {
    title: "The Old Man and the Sea",
    emoji: "🪝",
    /**
     * Hits poured into one particular hull, kill or no kill. Ahab belongs to the whale, so the
     * long lonely chase is Santiago's.
     *
     * The sort is what makes the name fit: a chase that got away outranks one that landed, which is
     * the whole of Hemingway's book - eighty-four days on one fish and a skeleton lashed to the boat.
     */
    earnedBy: (c) => {
      const chases: Array<{ player: PlayerStats; hull: Hull; hits: number; gotAway: boolean }> = [];
      for (const [player, m] of c.metrics) {
        if (!m.obsession || m.obsession.hits < 3) continue;
        chases.push({
          player,
          hull: m.obsession.hull,
          hits: m.obsession.hits,
          gotAway: m.obsession.hull.finisher !== player,
        });
      }
      // A grudge nobody got to settle is the better story, so an unfinished chase outranks a kill.
      chases.sort((a, b) => Number(b.gotAway) - Number(a.gotAway) || b.hits - a.hits);
      return chases.map((x) => ({
        player: x.player,
        detail: x.gotAway
          ? `${x.hits} hits into one ${x.hull.name} and never landed the kill`
          : `${x.hits} hits hounding a single ${x.hull.name}`,
      }));
    },
  },
  {
    title: "The Hunt for Red October",
    emoji: "📡",
    /**
     * Sank the Submarine.
     *
     * Fills the gap in the middle of the hull ladder: the 4+ square hulls are the Leviathan's, the
     * 2-square hulls are the Needle's, and the 3 in between had nothing of its own. Named for the
     * hull rather than its size, because a submarine is the one ship on the board worth hunting by
     * name - and rooms whose preset fields no Submarine simply never see this.
     */
    earnedBy: (c) =>
      killsOf(c, (h) => h.name === "Submarine").map(([player, hulls]) => ({
        player,
        detail:
          hulls.length > 1 ? `ran ${hulls.length} Submarines to ground` : "ran the Submarine to ground",
      })),
  },
  {
    title: "Needle in the Haystack",
    emoji: "🪡",
    earnedBy: (c) => {
      const smallest = Math.min(...c.hulls.map((h) => h.size));
      if (!Number.isFinite(smallest) || smallest > 2) return []; // only the little hulls are needles
      return killsOf(c, (h) => h.size === smallest).map(([player, hulls]) => ({
        player,
        detail:
          hulls.length > 1
            ? `dug ${hulls.length} ${smallest}-square hulls out of open water`
            : `dug the ${hulls[0].name} out of open water - ${smallest} squares`,
      }));
    },
  },
  {
    title: "Coup de Grace",
    emoji: "🗡️",
    earnedBy: (c) =>
      [...c.metrics]
        .filter(([, m]) => m.stolenFinishes > 0)
        .sort((a, b) => b[1].stolenFinishes - a[1].stolenFinishes)
        .map(([player, m]) => ({
          player,
          detail: `finished ${m.stolenFinishes} ${m.stolenFinishes === 1 ? "hull" : "hulls"} another gunner had wounded`,
        })),
  },
  /*
   * There was a shooting honor here called "The Flying Dutchman" - 3+ hits and 6+ shots without ever
   * sinking anything, condemned to sail and never make port. It was deleted when an actual Dutchman
   * started appearing in the water: two unrelated things under one name, one a marker a player can
   * see and the other a scoring quirk they can't, is how a recap becomes unreadable. Its 👻 went to
   * Thrice-Cursed. Nothing replaces it here, because the tier already covers that gunner three ways -
   * Coup de Grace names whoever kept taking those kills off them, and Master Gunner and Sharpest Eye
   * both catch someone landing hits.
   */
  {
    title: "Master Gunner",
    emoji: "💣",
    earnedBy: (c) =>
      c.stats
        .filter((s) => s.hits >= 2)
        .sort((a, b) => b.hits - a.hits)
        .map((s) => ({ player: s, detail: `${s.hits} hits landed` })),
  },
  {
    title: "Dead Reckoning",
    emoji: "🎯",
    earnedBy: (c) =>
      [...c.metrics]
        .filter(([, m]) => m.longestHitStreak >= 3)
        .sort((a, b) => b[1].longestHitStreak - a[1].longestHitStreak)
        .map(([player, m]) => ({ player, detail: `${m.longestHitStreak} hits in a row` })),
  },
  {
    title: "Sharpest Eye in the Crow's Nest",
    emoji: "🔭",
    earnedBy: (c) =>
      c.stats
        .filter((s) => s.shots >= 3 && s.accuracy > 0)
        .sort((a, b) => b.accuracy - a.accuracy)
        .map((s) => ({ player: s, detail: `${Math.round(s.accuracy * 100)}% of shots on target` })),
  },
  {
    title: "Opening Broadside",
    emoji: "🧨",
    // First blood - singular, so no cascade.
    earnedBy: (c) => (c.firstBlood ? [{ player: c.firstBlood, detail: "drew first blood" }] : []),
  },
  {
    title: "Davy Jones' Pen Pal",
    emoji: "🌊",
    // Deliberately ahead of the volume and geometry honors: when someone's match was mostly
    // misses, "fired the most shots" is the duller read of the same log.
    earnedBy: (c) =>
      c.stats
        .filter((s) => s.shots >= 5 && s.accuracy < 0.34)
        .sort((a, b) => a.accuracy - b.accuracy)
        .map((s) => ({ player: s, detail: `${s.misses} shots fed to the fish` })),
  },
  {
    title: "Water, Water, Everywhere",
    emoji: "🕳️",
    /** Coleridge's line is about being surrounded by ocean and getting nothing out of it. */
    earnedBy: (c) =>
      [...c.metrics]
        .filter(([, m]) => m.longestMissStreak >= 4)
        .sort((a, b) => b[1].longestMissStreak - a[1].longestMissStreak)
        .map(([player, m]) => ({ player, detail: `${m.longestMissStreak} straight shots into open water` })),
  },
  {
    title: "Raking Fire",
    emoji: "💥",
    earnedBy: (c) =>
      [...c.metrics]
        .filter(([, m]) => m.fleetsStruckAtOnce >= 2)
        .sort((a, b) => b[1].fleetsStruckAtOnce - a[1].fleetsStruckAtOnce)
        .map(([player, m]) => ({ player, detail: `one shot struck ${m.fleetsStruckAtOnce} fleets at once` })),
  },
  {
    title: "X Marks the Spot",
    emoji: "❌",
    /**
     * Their own first shot of the match found a hull.
     *
     * Opening Broadside is the room's first blood and there is only ever one of it. This is the
     * same moment from each player's side, so a whole crew can open on target and every one of them
     * has done something worth writing down.
     *
     * It sits down here rather than up with the opening because of how little it takes: one lucky
     * square. Above Raking Fire it was quietly stealing a shot that struck two fleets at once, which
     * is the rarer thing by a long way; below the geometry honors it would never be read at all.
     */
    earnedBy: (c) =>
      [...c.metrics]
        .filter(([, m]) => m.openedWithHit)
        .map(([player]) => ({ player, detail: "their first shot of the match found a hull" })),
  },
  {
    title: "Cartographer of the Narrow Sea",
    emoji: "🗺️",
    earnedBy: (c) => {
      const spread = (m: Metrics) => m.rows.size + m.cols.size;
      return [...c.metrics]
        .filter(([s, m]) => s.shots >= 6 && spread(m) >= c.boardSize)
        .sort((a, b) => spread(b[1]) - spread(a[1]))
        .map(([player, m]) => ({
          player,
          detail: `shots spread over ${m.rows.size} rows and ${m.cols.size} columns`,
        }));
    },
  },
  {
    title: "Trawler",
    emoji: "🎣",
    earnedBy: (c) => {
      const box = (m: Metrics) => ({ h: m.maxRow - m.minRow + 1, w: m.maxCol - m.minCol + 1 });
      const area = (m: Metrics) => box(m).h * box(m).w;
      // A quarter of the board or less counts as working one patch of sea.
      const cap = (c.boardSize * c.boardSize) / 4;
      return [...c.metrics]
        .filter(([s, m]) => s.shots >= 5 && area(m) <= cap)
        .sort((a, b) => area(a[1]) - area(b[1]))
        .map(([player, m]) => ({ player, detail: `worked one ${box(m).h}x${box(m).w} patch of sea` }));
    },
  },
  {
    title: "Hugger of the Shoals",
    emoji: "🪨",
    earnedBy: (c) => {
      const ratio = (s: PlayerStats, m: Metrics) => (s.shots > 0 ? m.rimShots / s.shots : 0);
      return [...c.metrics]
        .filter(([s, m]) => m.rimShots >= 4 && ratio(s, m) > 0.6)
        .sort((a, b) => ratio(b[0], b[1]) - ratio(a[0], a[1]))
        .map(([player, m]) => ({ player, detail: `${m.rimShots} of ${player.shots} shots along the rim` }));
    },
  },
  {
    title: "Quickest Powder",
    emoji: "⚡",
    earnedBy: (c) =>
      [...c.metrics]
        .filter(([, m]) => m.fastestReload !== null && m.fastestReload <= 5)
        .sort((a, b) => (a[1].fastestReload ?? 0) - (b[1].fastestReload ?? 0))
        .map(([player, m]) => ({ player, detail: `two shots ${gapText(m.fastestReload ?? 0)} apart` })),
  },
  {
    title: "Das Boot",
    emoji: "🧭",
    /** Long silences between shots: the patient patrol rather than a job title. */
    earnedBy: (c) =>
      [...c.metrics]
        .filter(([s, m]) => s.shots >= 3 && m.averageGap !== null && m.averageGap >= 30)
        .sort((a, b) => (b[1].averageGap ?? 0) - (a[1].averageGap ?? 0))
        .map(([player, m]) => ({ player, detail: `${gapText(m.averageGap ?? 0)} of chartwork between shots` })),
  },
  {
    title: "Powder Monkey",
    emoji: "🐒",
    earnedBy: (c) =>
      c.stats
        .filter((s) => s.shots >= 5)
        .sort((a, b) => b.shots - a.shots)
        .map((s) => ({ player: s, detail: `${s.shots} shots fired` })),
  },
];

/**
 * The titles in list order, which is the order of how hard they are to earn.
 *
 * Derived rather than written out, so it cannot drift from the list above - the walk order IS the
 * rarity ordering, and HONORS.md documents it as such: #1 is the hardest thing on the list and #39
 * is whatever nobody above it took.
 *
 * Exported for the record book's rarest honor, which is the only thing outside this file that needs
 * to compare two titles. Deliberately not "how rare a title turned out to be" in the archive: that
 * is a different question, answered by counting rows, and it would rank a title that is easy but
 * seldom drawn above one that is genuinely hard.
 */
export const HONOR_ORDER: readonly string[] = HONORS.map((h) => h.title);

/**
 * Everyone who EARNED each title, in claim order, whether or not the draw went their way.
 *
 * The honors have two questions in them and they used to have one answer. "Does sinking the most
 * ships earn Admiral of the Fleet" is about the rule; "did Aljex end up holding it" is about the
 * draw, and since the draw is now random the second no longer answers the first. Separating them is
 * what lets the rules stay testable - see scripts/check-honors.ts, which asserts against this and
 * leaves the draw to its own handful of cases.
 *
 * Titles nobody earned are absent rather than present-and-empty, so `has()` reads as "was this
 * earned at all".
 */
export function honorClaims(
  room: Room,
  players: Player[],
  attacks: Attack[],
  deepHides: DeepHide[],
  /** See buildMatchReport - same argument, same reason. */
  bayleCell: number | null = null
): Map<string, Array<{ nickname: string; detail: string }>> {
  const shots = groupIntoShots(attacks, players);
  const stats = buildPlayerStats(players, shots);
  const deep = deepWater(room, shots, deepHides, bayleCell);
  const context = buildHonorContext(
    stats,
    shots,
    room.board_size,
    room.ship_defs?.length ?? 0,
    deep,
    (cell) => bottleNote(room, cell),
    room
  );

  const out = new Map<string, Array<{ nickname: string; detail: string }>>();
  for (const honor of HONORS) {
    const claims = honor.earnedBy(context);
    if (claims.length === 0) continue;
    out.set(
      honor.title,
      claims.map((c) => ({ nickname: c.player.nickname, detail: c.detail }))
    );
  }
  return out;
}

/**
 * Who gets which title.
 *
 * -- Why this is a draw and not a ranking -----------------------------------------------------------
 *
 * A player takes at most one honor and an honor goes to at most one player, so a match hands out
 * exactly as many titles as it has crew. This list is 37 long and a crew is about six, which used to
 * mean the first six claimable titles won every single time. Measured over the archive: in 96 of 96
 * matches the awards handed out equalled the player count exactly, and EIGHT titles had never once
 * been awarded to anybody. Seven of those sat in a row near the bottom, and their conditions are not
 * even demanding - "Water, Water, Everywhere" wants a four-shot miss streak, which happens in nearly
 * every match. They were unreachable by position, not by difficulty.
 *
 * So the ordering no longer decides. Every player is offered a title drawn at random from the ones
 * they actually earned, which means a fourth match in a row can finally say something new about the
 * same crew doing the same thing. Nothing is invented: the pool for a player is exactly the set of
 * titles whose `earnedBy` named them, so a title is still only ever given to someone who did the deed.
 *
 * -- Except the deeds that ARE the match -----------------------------------------------------------
 *
 * `guaranteed` honors are handed out first, in list order, exactly as everything used to be. Wiping
 * an enemy fleet single-handed and then being told you fired the most shots is not variety, it is
 * the recap getting it wrong - and that specific swap is called out in Shaker's Protégé's own note.
 * Four titles carry the flag; everything else is drawn.
 *
 * -- Why the randomness is seeded ------------------------------------------------------------------
 *
 * This function runs on every client in the room to draw the recap, and again in lib/archiveMatch to
 * write the permanent record. Math.random() would give every player a different set of awards on
 * screen and archive whichever browser happened to save first. Seeded from the match key - the room
 * code and the match's start timestamp, the same string the archive dedupes on - every client draws
 * the identical result without anything being synced, which is the property lib/seededRandom exists
 * for. Re-rendering a finished match is still stable forever.
 */
function buildAwards(
  stats: PlayerStats[],
  shots: FeedShot[],
  boardSize: number,
  fleetSize: number,
  deep: DeepWater,
  bottleMessage: (cellIndex: number) => string,
  matchKey: string,
  pause?: PauseFields | null
): Award[] {
  const awards: Award[] = [];
  if (stats.length === 0) return awards;

  const context = buildHonorContext(stats, shots, boardSize, fleetSize, deep, bottleMessage, pause);

  // Every honor's claimants, resolved once. earnedBy can be expensive and is about to be read from
  // two directions.
  const claims = new Map<Honor, Claim[]>();
  for (const honor of HONORS) claims.set(honor, honor.earnedBy(context));

  // Keyed on the stats object rather than the nickname, so two players who happen to share a
  // nickname are still two crew members here.
  const taken = new Set<PlayerStats>();
  const used = new Set<Honor>();

  const give = (honor: Honor, claim: Claim) => {
    taken.add(claim.player);
    used.add(honor);
    awards.push({
      title: honor.title,
      emoji: honor.emoji,
      nickname: claim.player.nickname,
      detail: claim.detail,
    });
  };

  // 1. The deeds that are the story of the match, in list order, strongest free claim first.
  for (const honor of HONORS) {
    if (!honor.guaranteed) continue;
    for (const claim of claims.get(honor) ?? []) {
      if (taken.has(claim.player)) continue;
      give(honor, claim);
      break;
    }
  }

  // 2. Everything else, drawn.
  const random = rng(seedFrom(`honors:${matchKey}`));

  /** What this player could still be handed, with their ladders collapsed to the top rung. */
  const poolFor = (player: PlayerStats) => {
    const mine: Array<{ honor: Honor; claim: Claim }> = [];
    for (const honor of HONORS) {
      if (honor.guaranteed || used.has(honor)) continue;
      const claim = (claims.get(honor) ?? []).find((c) => c.player === player);
      if (claim) mine.push({ honor, claim });
    }
    // Drop anything this player has out-earned - see Honor.supersedes.
    const outranked = new Set(mine.flatMap(({ honor }) => honor.supersedes ?? []));
    return mine.filter(({ honor }) => !outranked.has(honor.title));
  };

  /*
   * Fewest options first, rather than scoreboard order.
   *
   * "One title each" is a promise the recap makes, and a greedy draw in a fixed order can break it:
   * the top scorer takes the one title a quieter crewmate also qualified for, and the crewmate ends
   * the match with nothing rather than with the only thing they earned. Serving the most constrained
   * player first spends the contested titles on whoever has no alternative, which is the standard
   * fix and costs nothing at a crew of six.
   *
   * Ties break on scoreboard order, so the draw stays deterministic.
   */
  for (;;) {
    let next: { player: PlayerStats; pool: Array<{ honor: Honor; claim: Claim }> } | null = null;
    for (const player of stats) {
      if (taken.has(player)) continue;
      const pool = poolFor(player);
      if (pool.length === 0) continue; // earned nothing measurable - no participation ribbon
      if (!next || pool.length < next.pool.length) next = { player, pool };
    }
    if (!next) break;
    const pick = next.pool[Math.floor(random() * next.pool.length)];
    give(pick.honor, pick.claim);
  }

  return awards;
}

/**
 * One rung of the tentacle ladder: everyone who found at least `n` of them, most first.
 *
 * "At least" rather than "exactly", so the rungs cascade like every other ranked honor - the second
 * player on three tentacles drops to the rung below rather than out of the report. The rung for a full
 * set is deliberately not built from this: it is a different claim (all of them, alone) and has to
 * check the count this board actually hides.
 */
function tentacleRung(c: HonorContext, n: number): Claim[] {
  return [...c.tentacles.by]
    .filter(([, found]) => found >= n && found < c.tentacles.needed)
    .sort((a, b) => b[1] - a[1])
    .map(([player, found]) => ({
      player,
      detail: found === 1 ? "found something down there" : `found ${found} of the tentacles`,
    }));
}

/**
 * The fleets that went down with all hands, each with the hulls it lost.
 *
 * Empty for a room whose `ship_defs` weren't recorded (see HonorContext.fleetSize): without knowing
 * how many hulls a fleet was dealt there is no way to tell one wiped out from one that merely lost a
 * lot of ships, and guessing would hand out the two honors that hang on this to people who never
 * earned them.
 */
function wipedFleets(c: HonorContext): Map<number, Hull[]> {
  if (c.fleetSize <= 0) return new Map();

  const byTeam = new Map<number, Hull[]>();
  for (const hull of c.hulls) {
    const list = byTeam.get(hull.defenderTeam);
    if (list) list.push(hull);
    else byTeam.set(hull.defenderTeam, [hull]);
  }
  for (const [team, hulls] of byTeam) {
    if (hulls.length < c.fleetSize) byTeam.delete(team);
  }
  return byTeam;
}

/** Hulls sunk by each player that match `pred`, most kills first. */
function killsOf(c: HonorContext, pred: (h: Hull) => boolean): Array<[PlayerStats, Hull[]]> {
  const by = new Map<PlayerStats, Hull[]>();
  for (const hull of c.hulls) {
    if (!hull.finisher || !pred(hull)) continue;
    const list = by.get(hull.finisher);
    if (list) list.push(hull);
    else by.set(hull.finisher, [hull]);
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}

function gapText(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(1)}s` : formatDuration(seconds);
}

function buildHonorContext(
  stats: PlayerStats[],
  shots: FeedShot[],
  boardSize: number,
  fleetSize: number,
  deep: DeepWater,
  bottleMessage: (cellIndex: number) => string,
  /** The room's pause columns, so a stoppage doesn't read as somebody taking their time. */
  pause?: PauseFields | null
): HonorContext {
  // Same keying as the scoreboard: the player id when known, else the team, so shots fired by
  // someone who has since left the room still resolve to their row.
  const byKey = new Map<string, PlayerStats>();
  for (const s of stats) byKey.set(s.playerId ?? `team:${s.team}`, s);

  // groupIntoShots sorts newest-first; streaks and reload gaps need the match as it happened.
  const timeline: Salvo[] = [...shots].reverse().map((shot) => {
    const struck = new Set(
      shot.rows.filter((r) => r.result === "hit" || r.result === "sunk").map((r) => r.defender_team)
    );
    const first = shot.rows[0];
    return {
      shot,
      player: byKey.get(first.attacker_player_id ?? `team:${first.attacker_team}`),
      // MATCH time rather than wall time: the stopped clock comes off here, once, so everything
      // downstream measures the game rather than the evening. Only ever read as a DIFFERENCE
      // (reload gaps, streak windows), so shifting the whole timeline changes no other answer -
      // and without it the one gap that happens to span a pause reads as a player who wandered
      // off for five minutes, which is exactly what "fastest reload" must not reward or punish.
      atMs: matchMs(shot.at, pause),
      row: Math.floor(shot.cellIndex / boardSize),
      col: shot.cellIndex % boardSize,
      connected: struck.size > 0,
      resolved: shot.rows.some((r) => r.result !== "pending"),
      fleetsStruck: struck.size,
    };
  });

  const hulls = buildHulls(timeline, boardSize);
  const metrics = buildMetrics(stats, timeline, hulls, boardSize);
  const firstBlood = timeline.find((s) => s.connected)?.player;

  /** Whoever fired a shot, resolved to their scoreboard row. */
  const finder = (found: { playerId: string | null; attackerTeam: number }) =>
    byKey.get(found.playerId ?? `team:${found.attackerTeam}`);

  /** Finds per player, for the creatures that can turn up more than once. */
  const tally = (finds: Array<{ playerId: string | null; attackerTeam: number }>) => {
    const by = new Map<PlayerStats, number>();
    for (const f of finds) {
      const player = finder(f);
      if (player) by.set(player, (by.get(player) ?? 0) + 1);
    }
    return by;
  };

  const tentaclesBy = tally(deep.cthulhu.tentacles);
  const last = deep.cthulhu.tentacles[deep.cthulhu.tentacles.length - 1];
  const firstSail = deep.dutchman[0];
  const firstSailPlayer = firstSail ? finder(firstSail) : undefined;

  return {
    stats,
    boardSize,
    fleetSize,
    metrics,
    hulls,
    firstBlood,
    whale: deep.whale ? { player: finder(deep.whale), cellIndex: deep.whale.cellIndex } : null,
    laboon: deep.laboon.map(finder),
    tentacles: {
      by: tentaclesBy,
      needed: deep.cthulhu.needed,
      awake: deep.cthulhu.awake,
      lastFinder: last ? finder(last) : undefined,
    },
    dutchman: [...tally(deep.dutchman)],
    // deep.dutchman is chronological, so the first entry is the first sail seen.
    dutchmanFirst: firstSail && firstSailPlayer ? { player: firstSailPlayer, cellIndex: firstSail.cellIndex } : null,
    // The first one fished out, of four in the water. Whoever got there first gets the honor, and the
    // note quoted is the one that was actually in THAT bottle.
    bottle: deep.bottle[0]
      ? {
          player: finder(deep.bottle[0]),
          cellIndex: deep.bottle[0].cellIndex,
          note: bottleMessage(deep.bottle[0].cellIndex),
        }
      : null,
    // One per crew that found him, in the order they got there.
    alexander: deep.alexander.map((jar) => ({
      foundBy: finder(jar.found),
      foundAt: jar.found.cellIndex,
      freedBy: jar.freed ? finder(jar.freed) : undefined,
      freedAt: jar.freed?.cellIndex ?? null,
    })),
    // One per crew that met him, in the order they got there - the same shape alexander takes.
    igon: deep.igon.map((e) => ({
      foundBy: finder(e.found),
      foundAt: e.found.cellIndex,
      avengedBy: e.avenged ? finder(e.avenged) : undefined,
      avengedAt: e.avenged?.cellIndex ?? null,
    })),
    patches: [...tally(deep.patches)],
  };
}

function buildHulls(timeline: Salvo[], boardSize: number): Hull[] {
  const hulls: Hull[] = [];
  const seen = new Set<string>();

  for (const salvo of timeline) {
    for (const r of salvo.shot.rows) {
      if (r.result !== "sunk" || !r.sunk_ship_name) continue;
      // Two fleets can own a Cruiser at the same coordinates, so the defender is part of identity.
      const id = `${r.defender_team}:${r.sunk_ship_name}:${r.sunk_start_row}:${r.sunk_start_col}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const size = r.sunk_ship_size ?? 0;
      const placed =
        r.sunk_start_row !== null && r.sunk_start_col !== null && r.sunk_horizontal !== null && size > 0;
      hulls.push({
        name: r.sunk_ship_name,
        size,
        defenderTeam: r.defender_team,
        finisher: salvo.player,
        cells: placed
          ? shipCellIndices(
              [
                {
                  shipIndex: 0,
                  startRow: r.sunk_start_row as number,
                  startCol: r.sunk_start_col as number,
                  isHorizontal: r.sunk_horizontal as boolean,
                },
              ],
              [size],
              boardSize
            )
          : null,
        hitsBy: new Map(),
      });
    }
  }

  // Second pass: every hit that landed on a reconstructed footprint belongs to that hull, which is
  // what lets a chase be told apart from scattered luck.
  for (const salvo of timeline) {
    if (!salvo.player) continue;
    for (const r of salvo.shot.rows) {
      if (r.result !== "hit" && r.result !== "sunk") continue;
      const hull = hulls.find(
        (h) => h.defenderTeam === r.defender_team && h.cells?.has(salvo.shot.cellIndex)
      );
      if (!hull) continue;
      hull.hitsBy.set(salvo.player, (hull.hitsBy.get(salvo.player) ?? 0) + 1);
    }
  }

  return hulls;
}

function buildMetrics(
  stats: PlayerStats[],
  timeline: Salvo[],
  hulls: Hull[],
  boardSize: number
): Map<PlayerStats, Metrics> {
  const metrics = new Map<PlayerStats, Metrics>();
  // Seeded in scoreboard order so iteration - and therefore every tie-break below - is stable.
  for (const s of stats) {
    metrics.set(s, {
      longestHitStreak: 0,
      longestMissStreak: 0,
      rows: new Set(),
      cols: new Set(),
      rimShots: 0,
      minRow: boardSize,
      maxRow: -1,
      minCol: boardSize,
      maxCol: -1,
      fastestReload: null,
      averageGap: null,
      fleetsStruckAtOnce: 0,
      stolenFinishes: 0,
      obsession: null,
      openedWithHit: false,
    });
  }

  const opened = new Set<PlayerStats>();
  const running = new Map<PlayerStats, { hit: number; miss: number }>();
  const lastShotAt = new Map<PlayerStats, number>();
  const gapTotals = new Map<PlayerStats, { total: number; count: number }>();

  for (const salvo of timeline) {
    const player = salvo.player;
    const m = player ? metrics.get(player) : undefined;
    if (!player || !m) continue;

    m.rows.add(salvo.row);
    m.cols.add(salvo.col);
    m.minRow = Math.min(m.minRow, salvo.row);
    m.maxRow = Math.max(m.maxRow, salvo.row);
    m.minCol = Math.min(m.minCol, salvo.col);
    m.maxCol = Math.max(m.maxCol, salvo.col);
    if (salvo.row === 0 || salvo.col === 0 || salvo.row === boardSize - 1 || salvo.col === boardSize - 1) {
      m.rimShots++;
    }
    m.fleetsStruckAtOnce = Math.max(m.fleetsStruckAtOnce, salvo.fleetsStruck);

    // Unresolved shots break nothing: a pending row is a shot still in the air, not a miss.
    if (salvo.resolved) {
      // Their opening shot is the first one that came back with an answer - a pending row would
      // otherwise spend the honor on a shot still in the air.
      if (!opened.has(player)) {
        opened.add(player);
        m.openedWithHit = salvo.connected;
      }

      let run = running.get(player);
      if (!run) {
        run = { hit: 0, miss: 0 };
        running.set(player, run);
      }
      if (salvo.connected) {
        run.hit++;
        run.miss = 0;
      } else {
        run.miss++;
        run.hit = 0;
      }
      m.longestHitStreak = Math.max(m.longestHitStreak, run.hit);
      m.longestMissStreak = Math.max(m.longestMissStreak, run.miss);
    }

    // Gaps are measured against this player's own previous shot, not the match's, so a busy room
    // full of other people firing doesn't read as a fast reload.
    const previous = lastShotAt.get(player);
    if (previous !== undefined) {
      const gap = (salvo.atMs - previous) / 1000;
      m.fastestReload = m.fastestReload === null ? gap : Math.min(m.fastestReload, gap);
      const totals = gapTotals.get(player) ?? { total: 0, count: 0 };
      totals.total += gap;
      totals.count++;
      gapTotals.set(player, totals);
    }
    lastShotAt.set(player, salvo.atMs);
  }

  for (const [player, totals] of gapTotals) {
    const m = metrics.get(player);
    if (m && totals.count > 0) m.averageGap = totals.total / totals.count;
  }

  for (const hull of hulls) {
    for (const [player, hits] of hull.hitsBy) {
      const m = metrics.get(player);
      if (!m) continue;
      if (!m.obsession || hits > m.obsession.hits) m.obsession = { hull, hits };
    }
    // Every hit on a hull necessarily precedes the blow that sank it, so another name in hitsBy
    // means the finisher took a kill someone else had set up.
    if (hull.finisher && [...hull.hitsBy.keys()].some((p) => p !== hull.finisher)) {
      const m = metrics.get(hull.finisher);
      if (m) m.stolenFinishes++;
    }
  }

  return metrics;
}

/** Plain-text recap for the clipboard - reads cleanly pasted into Discord or chat. */
export function formatReportText(report: MatchReport, attacks: Attack[], boardSize: number): string {
  const lines: string[] = [];
  lines.push(`ELDEN BATTLESHIP - room ${report.roomCode}`);
  lines.push(
    report.draw
      ? "Result: mutual destruction"
      : `Winner: ${report.winnerTeam !== null ? teamName(report.winnerTeam) : "unknown"}`
  );
  lines.push(`Match time: ${report.duration}   Shots fired: ${report.totalShots}`);

  if (report.awards.length > 0) {
    lines.push("");
    for (const a of report.awards) {
      lines.push(`${a.emoji} ${a.title}: ${a.nickname} (${a.detail})`);
    }
  }

  lines.push("");
  lines.push("Scoreboard");
  const byTeam = new Map<number, PlayerStats[]>();
  for (const s of report.stats) {
    if (!byTeam.has(s.team)) byTeam.set(s.team, []);
    byTeam.get(s.team)!.push(s);
  }
  lines.push(
    `  ${"".padEnd(14)} ${"shots".padStart(5)} ${"hits".padStart(5)} ${"miss".padStart(5)} ${"sunk".padStart(5)} ${"acc".padStart(5)} ${"pace".padStart(6)}`
  );
  for (const [team, list] of [...byTeam.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`  ${teamName(team)}`);
    for (const s of list) {
      lines.push(
        `    ${s.nickname.padEnd(14)} ${String(s.shots).padStart(3)} ${String(s.hits).padStart(5)} ` +
          `${String(s.misses).padStart(5)} ${String(s.sunk).padStart(5)} ` +
          `${(Math.round(s.accuracy * 100) + "%").padStart(5)} ` +
          // Blank rather than a dash when there is no pace: this is the line people paste into
          // Discord, and a column of dashes down a short match reads as broken rather than as absent.
          `${(s.pace != null ? paceLabel(s.pace) : "").padStart(6)}`
      );
    }
    if (list.length > 1) {
      const t = list.reduce(
        (acc, s) => ({
          shots: acc.shots + s.shots,
          hits: acc.hits + s.hits,
          misses: acc.misses + s.misses,
          sunk: acc.sunk + s.sunk,
        }),
        { shots: 0, hits: 0, misses: 0, sunk: 0 }
      );
      const acc = t.shots > 0 ? Math.round((t.hits / t.shots) * 100) : 0;
      lines.push(
        `    ${"- fleet total".padEnd(14)} ${String(t.shots).padStart(3)} ${String(t.hits).padStart(5)} ` +
          `${String(t.misses).padStart(5)} ${String(t.sunk).padStart(5)} ${(acc + "%").padStart(5)}`
      );
    }
  }

  const sinkings = attacks
    .filter((a) => a.result === "sunk" && a.sunk_ship_name)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (sinkings.length > 0) {
    lines.push("");
    lines.push("Ships lost");
    for (const s of sinkings) {
      lines.push(`  ${teamName(s.defender_team)}'s ${s.sunk_ship_name} at ${cellLabel(s.cell_index, boardSize)}`);
    }
  }

  return lines.join("\n");
}
