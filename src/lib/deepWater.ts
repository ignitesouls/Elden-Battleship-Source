import { rng, seedFrom } from "./seededRandom";
import type { FeedShot } from "./attackFeed";
import type { Room } from "../types/battleship";

/**
 * What is hiding in the water.
 *
 * Seven things, all placed the same way: the white whale, Laboon, Cthulhu's tentacles, the Flying
 * Dutchman, four bottles, Alexander, and Patches. Their squares are rolled ONCE, by Postgres, at the
 * moment every fleet is confirmed and before a single shot is fired - out of the cells that no fleet
 * occupies (see supabase/migrations/20260806000000_deep_water_hides.sql). They do not move. Nothing
 * else in the match can move them.
 *
 * -- Why the database picks ------------------------------------------------------------------------
 *
 * Everything down here has to sit in water that is empty for EVERY fleet, and no client can check
 * that: a player may read their own fleet and nobody else's. This used to be settled by observation -
 * a creature sat on the first square nobody had fired at, and a shot that came back a miss was taken
 * as proof the square was open water.
 *
 * It was not proof. A shot writes one `attacks` row PER OPPONENT; the shooter's own fleet is never a
 * defender of the shooter's own shot. So a miss proved the other fleets were empty there and said
 * nothing whatsoever about the crew that fired it, and tentacles duly turned up on squares the
 * finding crew had a ship sitting on. Postgres is the only participant that can see every fleet at
 * once, so Postgres does the placing, and the invariant holds by construction instead of by
 * inference.
 *
 * -- How a thing is found --------------------------------------------------------------------------
 *
 * By firing at its square. That is the whole rule now.
 *
 * A hidden row is invisible to every client until somebody has fired at that cell (RLS enforces it,
 * not this file), so `hides` below only ever contains squares that have already been shot at. The
 * shot is guaranteed a miss against every fleet, because the roll excluded every hull - which is why
 * nothing here needs to reason about hits at all, and why a shot still in the air no longer stops the
 * walk. It just isn't a find yet.
 *
 * Some of these can be taken and some cannot, and that is the only real distinction left:
 *
 *   - The whale, a tentacle and a bottle are CAUGHT. First crew to the square gets them, and a later
 *     shot at the same square by another fleet finds nothing.
 *   - The Dutchman, Laboon, Patches and Alexander are MET. Nothing is caught, so every crew that
 *     fires there gets their own encounter, and meeting one twice in a match is possible.
 *
 * -- Who is told ------------------------------------------------------------------------------------
 *
 * Squares nobody has fired at are unreadable, full stop - there is no longer anything for a client to
 * compute or a curious player to read out of devtools. Among rows a client CAN read, who sees what is
 * still a policy, and `deepMarks` below is the only place it lives. Read it there.
 */

/** The white whale, dead. One per match, if anybody finds him at all. */
export interface WhaleStrike extends DeepFind {}

/**
 * Laboon, who is not the whale you were looking for.
 *
 * One whale square in five is his instead, rolled with the position and just as secret. He takes the
 * shot, shrugs it off, and that is the hunt over: the whale is not one square further on, he is
 * simply not in this match. That is the cost of fixed positions, and it is the right cost - a crew
 * that finds Laboon has found the only thing that was ever there.
 *
 * He is met rather than caught, so every fleet that fires at his square meets him.
 */
export interface LaboonStrike extends DeepFind {}

/**
 * The Flying Dutchman, sighted.
 *
 * Three squares are his, and nothing on any of them can be caught - a sighting is the whole event,
 * which is why this is a list. Every crew that fires at one of his squares sights him, so a match can
 * hold anywhere from nothing to six of these, and three or more is a genuinely rare evening.
 */
export interface DutchmanSighting extends DeepFind {}

/**
 * Alexander, wedged in the shallows, and whoever shook him loose - one of these per crew.
 *
 * The only two-stage thing in the water. Finding him is the ordinary business of firing at his
 * square; freeing him needs a SECOND shot, a later miss on one of the four squares orthogonally
 * beside him. That second condition is what makes freeing him rarer than finding him, and it is the
 * entire reason he carries two honors instead of one.
 *
 * He is MET rather than caught, so every crew that fires at his square turns him up and every crew
 * gets its own go at hauling him out. Both of a crew's shots are their own, and that is a visibility
 * rule rather than a flavour one: a jar moves only for shots the crew watching it fired, so there is
 * nothing here to be inferred from anybody else's play.
 *
 * The version where he is caught once and freed once cannot say that. A crew shown a jar that
 * somebody ELSE got out has been told that one of the four squares beside him is open water for
 * every fleet - a miss is a miss against all defenders - which is close to the most valuable thing a
 * player can be handed for free. Per crew is the only shape where what you can see and what you did
 * agree.
 */
export interface JarEncounter {
  /** Where this crew turned him up, still stuck. */
  found: DeepFind;
  /** This crew's later shot beside him that shook him loose. Null while they still have him in there. */
  freed: DeepFind | null;
}

export interface DeepFind {
  cellIndex: number;
  /** Null for a shot fired by someone who has since left the room. */
  playerId: string | null;
  attackerTeam: number;
  /** Nickname at the time of the shot, or the team name if they've left. */
  who: string;
  at: string;
}

export interface CthulhuState {
  /** Found so far, chronologically. */
  tentacles: DeepFind[];
  /** How many this board hides. Zero on a board too small to hide them in. */
  needed: number;
  /** Every tentacle found. He is awake, and at this point everyone gets to know. */
  awake: boolean;
}

export interface DeepWater {
  whale: WhaleStrike | null;
  laboon: LaboonStrike[];
  cthulhu: CthulhuState;
  dutchman: DutchmanSighting[];
  /** The messages in bottles, in the order they were fished out. Four are hidden; each says its own thing. */
  bottle: DeepFind[];
  /** One entry per crew that turned him up, in the order they got there. See JarEncounter. */
  alexander: JarEncounter[];
  /** Everyone who reached for a tentacle and got Patches. He is "sorry". */
  patches: DeepFind[];
}

/** What the roll hid on a square. Rows arrive from `deep_hides`, one per occupied square. */
export type DeepCreature = "whale" | "tentacle" | "dutchman" | "bottle" | "alexander";

/**
 * One hiding place, as the database rolled it.
 *
 * Only ever holds squares somebody has already fired at - the rest are invisible to the client, and
 * that is enforced by RLS rather than by anything here.
 */
export interface DeepHide {
  cellIndex: number;
  creature: DeepCreature;
  /** The whale square that is really Laboon, or the tentacle square that is really Patches. */
  decoy: boolean;
}

/** What a square is holding, once it is known. */
export type DeepMark =
  | "whale"
  | "laboon"
  | "tentacle"
  | "sleeper"
  | "dutchman"
  | "bottle"
  | "jar"
  | "jarFree"
  | "patches";

/**
 * How many tentacles a board hides.
 *
 * Four on a standard 10x10 - about 4% of the squares, which lands "all four found" at genuinely rare
 * rather than merely uncommon. That is what he is for. Nothing at all below 8x8: a 5x5 board is
 * twenty-five squares already holding a whale, and a pond cannot hide a god.
 *
 * MIRRORED IN SQL, in roll_deep_water(). It has to be: the client cannot count the tentacle rows,
 * because the ones nobody has found are invisible to it, so "how many are there" is computed from the
 * board size at both ends. If the two ever disagree, Cthulhu wakes at the wrong number.
 */
export function tentacleCount(boardSize: number): number {
  const cells = boardSize * boardSize;
  if (cells < 64) return 0;
  return Math.min(6, Math.max(3, Math.round(cells * 0.04)));
}

/**
 * Whether this board is big enough for anything beyond the whale.
 *
 * The same 64-cell floor Cthulhu uses, and for the same reason. The whale is exempt because he was
 * here first and a board with nothing at all hiding in it is a worse board; everything added since is
 * gated, because four secret squares on a twenty-five square pond is not a hunt, it is a minefield.
 *
 * Mirrored in roll_deep_water() alongside tentacleCount, and true for the same reason.
 */
export function hidesExtras(boardSize: number): boolean {
  return boardSize * boardSize >= 64;
}

/**
 * What a bottle has in it: a message off the floor of somebody else's game.
 *
 * Seeded off the room AND the square, so all four bottles in a match say different things and every
 * client reads the same note out of the same bottle. Drawn from a fixed list, so there is nothing to
 * store.
 *
 * SOME OF THESE MAKE CLAIMS ABOUT THE BOARD, and those claims are neither true nor false. "Ship
 * ahead" is in here, and so is "No ship ahead". It is tempting to file them under lies and be done
 * with it, but that is the wrong word in both directions: nothing chose to mislead anybody, and
 * nothing checked either. The note is drawn from the room seed and the cell index ALONE - nothing
 * about any fleet - so it is settled before a single ship is placed, and then simply sits there next
 * to whatever the board turns out to hold.
 *
 * Which means it is sometimes RIGHT. That is the good outcome, not a bug. Somewhere a crew is going
 * to read "Ship ahead", fire at the next square out of pure superstition, and hit something, and they
 * will never know whether the bottle told them or the sea did. That is the institution
 * being quoted: the ground in these games is carpeted with strangers insisting there is an amazing
 * chest just up ahead, and the reason anybody still reads them is that once in a while there is.
 *
 * None of that changes the safety property, which is worth stating separately from the joke: the
 * note is independent of fleet placement, so no arrangement of hulls makes any message true more often
 * than chance and nothing can be worked backwards from it. It cannot be a reliable signal. It is
 * equally not guaranteed to be a false one.
 */
const BOTTLE_NOTES = [
  // The classics, as left on the ground.
  "Try finger, but hole",
  "You don't have the right, O you don't have the right",
  "Amazing chest ahead",
  "Fort, night",
  "Time for crab",
  "Behold, dog!",
  "Be wary of dog",
  "Praise the Sun!",
  "Didn't expect trap",
  "Liar ahead",
  "Seek strength... the rest follows",
  "Maidenless behaviour",
  "Let there be iron",
  "Why is it always lobsters",
  "Try jumping",
  "I did it!",
  "Visions of mother",
  "Offer throat",
  "Guh!",
  // The same grammar, pointed at this sea.
  "Try water, but hole",
  "Time for whale",
  "Praise the Sea!",
  "Be wary of tentacle",
  "Seek broadside... the rest follows",
  "Maidenless, and now shipless",
  "Visions of Laboon",
  "Offer starboard",
  "Shaker was here.",
  // The ones that make a claim. See the note above: not lies, not hints - unverified, and occasionally
  // correct by accident, which is the point of them.
  "Ship ahead",
  "No ship ahead",
  "Weakness: starboard",
  "Try firing here",
] as const;

/**
 * How many notes the list holds.
 *
 * Derived rather than written down, and exported only for scripts/check-deep-water.ts, which proves
 * every one of them can actually be drawn - `Math.floor(roll * length)` is exactly the shape that
 * quietly strands the last entry, and a message nobody can ever get is one nobody would notice was
 * missing.
 */
export const BOTTLE_NOTE_COUNT = BOTTLE_NOTES.length;

/** The note in the bottle on this square. Stable for a square, and independent of it - see BOTTLE_NOTES. */
export function bottleNote(room: Room, cellIndex: number): string {
  const roll = rng(seedFrom(`${room.id}:${room.seed ?? ""}:bottle:note:${cellIndex}`))();
  return BOTTLE_NOTES[Math.floor(roll * BOTTLE_NOTES.length)];
}

/** Whether two squares share an edge. Diagonals don't count - four neighbours, not eight. */
function isAdjacent(a: number, b: number, boardSize: number): boolean {
  const rowA = Math.floor(a / boardSize);
  const rowB = Math.floor(b / boardSize);
  return Math.abs(rowA - rowB) + Math.abs((a % boardSize) - (b % boardSize)) === 1;
}

/**
 * Everything hiding in this room's water, as far as the log has turned it up.
 *
 * @param shots grouped shots, newest-first, as `groupIntoShots` returns them - a find is a property
 * of one trigger-pull rather than of a single `attacks` row.
 * @param hides the `deep_hides` rows this client can read, which is exactly the squares somebody has
 * already fired at. An empty list is the normal state of a match nobody has found anything in, and
 * also what a project that hasn't run the migration looks like.
 */
export function deepWater(room: Room, shots: FeedShot[], hides: DeepHide[]): DeepWater {
  const hidden = new Map(hides.map((h) => [h.cellIndex, h]));

  const result: DeepWater = {
    whale: null,
    laboon: [],
    cthulhu: { tentacles: [], needed: tentacleCount(room.board_size), awake: false },
    dutchman: [],
    bottle: [],
    alexander: [],
    patches: [],
  };

  /** Squares whose occupant has been taken, so a second crew firing there finds nothing. */
  const claimed = new Set<number>();
  /** Squares each crew has already met something on, so one crew meets it once. */
  const met = new Set<string>();

  for (const shot of [...shots].reverse()) {
    // Still in the air. Nothing is decided by an unresolved shot, and unlike the old log-walk this
    // does not have to stop everything behind it: finds are per-square now, so a shot pending at C4
    // cannot change what D7 turned out to be.
    if (shot.rows.some((r) => r.result === "pending")) continue;

    const find = (): DeepFind => ({
      cellIndex: shot.cellIndex,
      playerId: shot.rows[0].attacker_player_id,
      attackerTeam: shot.attackerTeam,
      who: shot.who,
      at: shot.at,
    });

    /**
     * Alexander is loose the moment his own crew misses next to him.
     *
     * Checked before the square's own occupant because it is about a DIFFERENT square from the one
     * being fired at, and it can happen on the same shot that something else is being found on.
     *
     * Scoped to the shooting crew's own jar. Every crew that found him has one, they all sit on the
     * same square, and no crew's shot touches another crew's, which is why he is met rather than
     * caught. See JarEncounter.
     */
    const jar = result.alexander.find((j) => j.found.attackerTeam === shot.attackerTeam);
    if (
      jar &&
      !jar.freed &&
      isAdjacent(shot.cellIndex, jar.found.cellIndex, room.board_size) &&
      !shot.rows.some((r) => r.result === "hit" || r.result === "sunk")
    ) {
      jar.freed = find();
    }

    const here = hidden.get(shot.cellIndex);
    if (!here) continue;

    // Cannot happen: the roll only ever picks cells no fleet occupies, so a shot at one of these
    // squares misses everybody. Guarded anyway, because "impossible" here means "impossible unless
    // someone re-rolls mid-match", and a hit is the one outcome that would make a find a lie.
    if (shot.rows.some((r) => r.result === "hit" || r.result === "sunk")) continue;

    const takeOnce = () => {
      if (claimed.has(shot.cellIndex)) return false;
      claimed.add(shot.cellIndex);
      return true;
    };
    const meetOnce = () => {
      const key = `${shot.cellIndex}:${shot.attackerTeam}`;
      if (met.has(key)) return false;
      met.add(key);
      return true;
    };

    switch (here.creature) {
      case "whale":
        // Not him, and not one square further on either - see LaboonStrike.
        if (here.decoy) {
          if (meetOnce()) result.laboon.push(find());
        } else if (takeOnce()) {
          result.whale = find();
        }
        break;

      case "tentacle":
        if (here.decoy) {
          if (meetOnce()) result.patches.push(find());
        } else if (takeOnce()) {
          result.cthulhu.tentacles.push(find());
          result.cthulhu.awake = result.cthulhu.tentacles.length >= result.cthulhu.needed;
        }
        break;

      case "dutchman":
        if (meetOnce()) result.dutchman.push(find());
        break;

      case "bottle":
        if (takeOnce()) result.bottle.push(find());
        break;

      case "alexander":
        // meetOnce, not takeOnce: one jar per crew, and one per crew only - a crew cannot find him
        // twice, but arriving second no longer means arriving to an empty square.
        if (meetOnce()) result.alexander.push({ found: find(), freed: null });
        break;
    }
  }

  return result;
}

/**
 * What one viewer may see, keyed by square.
 *
 * The single place the who-sees-what policy lives. It is no longer the only thing standing between a
 * player and the answer - squares nobody has fired at are unreadable to every client now - but it is
 * still what stops one crew reading another crew's finds off the board. Three rules while the match
 * is running; `finalMarks` below is the fourth, and it is the one that ends the other three.
 *
 *   - A PLAYER (pass their team) sees only what their own crew found. Every other fleet reads those
 *     shots as plain misses and finds out from the honors when the match ends.
 *   - A CASTER (pass nothing) sees everything, the moment it happens. They cannot call a match they
 *     are being kept in the dark about, and by the time any of it is drawn the thing is already found
 *     - all it says about a square is that it was open water, which the battle log says anyway.
 *   - Cthulhu awake is the loud one, and it is still NOT a free reveal. A crew is shown the sleeper
 *     only on squares that crew has itself fired at (`firedCells`).
 *
 * That last rule is a fairness fix, not fussiness. Every one of these squares is open water, so
 * putting a tentacle on a square a crew has never shot at would tell them, for nothing, that there is
 * no hull there - which is the single most valuable thing a player can be told. The waking is allowed
 * to be everyone's business; it is not allowed to be a free miss. A crew that hasn't been there yet
 * finds out the way they should: by firing at it, and discovering he is already awake.
 *
 * Alexander is the one creature whose mark can change without anybody firing at his square: the shot
 * that frees him lands NEXT to him. That is not a leak - a crew's jar answers only to that crew's
 * own shots, and his square is already drawn for them because they are the ones who found him - so
 * it only ever redraws a square they can already see, off a shot they fired themselves.
 */
export function deepMarks(
  deep: DeepWater,
  viewerTeam?: number | null,
  /** Squares the viewer's own crew has fired at. Omit for a caster, who is holding no fleet. */
  firedCells?: ReadonlySet<number>
): Map<number, DeepMark> {
  const marks = new Map<number, DeepMark>();
  const caster = viewerTeam === undefined || viewerTeam === null;
  const mine = (found: DeepFind) => caster || found.attackerTeam === viewerTeam;
  // A crew that found a square necessarily fired at it, so their own finds pass this either way - it
  // only ever gates squares somebody ELSE reached first.
  const beenThere = (cell: number) => caster || (firedCells?.has(cell) ?? false);

  for (const t of deep.cthulhu.tentacles) {
    if (deep.cthulhu.awake) {
      if (mine(t) || beenThere(t.cellIndex)) marks.set(t.cellIndex, "sleeper");
    } else if (mine(t)) {
      marks.set(t.cellIndex, "tentacle");
    }
  }

  for (const p of deep.patches) {
    if (mine(p)) marks.set(p.cellIndex, "patches");
  }
  for (const d of deep.dutchman) {
    if (mine(d)) marks.set(d.cellIndex, "dutchman");
  }
  for (const l of deep.laboon) {
    if (mine(l)) marks.set(l.cellIndex, "laboon");
  }
  for (const b of deep.bottle) {
    if (mine(b)) marks.set(b.cellIndex, "bottle");
  }
  /**
   * Freed replaces stuck on the same square, the way the sleeper replaces a tentacle. Whether he is
   * still in there is the only thing his square has ever had to say.
   *
   * Every crew's jar is the SAME square, and a map holds one mark per square - so a viewer who can
   * see more than one of them needs a rule for two crews disagreeing. Freed wins, on the same
   * grounds the sleeper does: it is the later state of one object, and a caster or a recap shown
   * "still wedged" while somebody has him out would simply be wrong. A player only ever passes
   * `mine` on their own crew's entry, so for them there is nothing to resolve.
   */
  for (const jar of deep.alexander) {
    if (!mine(jar.found)) continue;
    if (jar.freed) marks.set(jar.found.cellIndex, "jarFree");
    else if (!marks.has(jar.found.cellIndex)) marks.set(jar.found.cellIndex, "jar");
  }
  if (deep.whale && mine(deep.whale)) marks.set(deep.whale.cellIndex, "whale");

  return marks;
}

/**
 * What the recap shows, once the match is over: every find, whoever made it.
 *
 * The fourth rule, and the one that ends the other three. Secrecy exists to stop a crew reading
 * another crew's shots for free while there are still shots to fire; when the last fleet is sunk
 * there is nothing left to protect, and the honors already name every finder out loud - so a board
 * that still hid the squares would be disagreeing with the list printed above it.
 *
 * What it does NOT do is reveal the water nobody searched. A hiding place stays invisible to every
 * client until somebody fires at it, so the tentacles that went unfound have no position to show, in
 * the recap or anywhere else - and since the next match re-rolls against a new set of fleets, nothing
 * here can be prepared for.
 *
 * Deliberately not `deepMarks(deep)` at the call site, though that is what it is. "No team" reads as
 * "I am a caster", and the recap is not one - it is every player at once, which is a different reason
 * for the same answer and would be the first thing to change if it ever stopped being the same answer.
 */
export function finalMarks(deep: DeepWater): Map<number, DeepMark> {
  return deepMarks(deep);
}

/** One find, resolved to the marker its square ends the match drawn with. */
export interface DeepFindRow {
  find: DeepFind;
  mark: DeepMark;
}

/**
 * Every find the match turned up, oldest first, each carrying the mark its square ends up wearing.
 *
 * The one list of "what happened down there", and the reason it lives here rather than in the recap
 * that draws it: the live recap reads it off the room, and `archiveMatch` writes it into the record
 * so a match read back years later can draw the same list. Two callers, one flattening - which
 * matters, because anything missing from it is invisible everywhere however well it is drawn.
 *
 * The mark is read back out of `finalMarks` rather than taken from which list a find came in on, so a
 * row can never name something the board beside it is drawing differently. The sleeper is the case
 * that makes this worth doing: those are the same tentacles wearing a different face.
 */
export function finalFinds(deep: DeepWater): DeepFindRow[] {
  const marks = finalMarks(deep);
  // Every creature's finds, flattened. When something new starts hiding in the water this is the
  // first place to add to - see DeepWater above for the full set.
  const finds = [
    ...(deep.whale ? [deep.whale] : []),
    ...deep.laboon,
    ...deep.cthulhu.tentacles,
    ...deep.dutchman,
    ...deep.bottle,
    // His square only, once per crew that found him - the same shape the Dutchman's sightings take.
    // The shot that freed anybody landed NEXT to it and has no mark of its own; rescues are credited
    // by the Potfriend honor instead.
    ...deep.alexander.map((jar) => jar.found),
    ...deep.patches,
  ];
  return finds
    .map((find) => ({ find, mark: marks.get(find.cellIndex) }))
    .filter((r): r is DeepFindRow => r.mark !== undefined)
    .sort((a, b) => new Date(a.find.at).getTime() - new Date(b.find.at).getTime());
}
