export interface ShipDefinition {
  name: string;
  size: number;
}

export const BOARD_SIZE = 10;

export const CLASSIC_SHIPS: ShipDefinition[] = [
  { name: "Carrier", size: 5 },
  { name: "Battleship", size: 4 },
  { name: "Cruiser", size: 3 },
  { name: "Submarine", size: 3 },
  { name: "Destroyer", size: 2 },
];

export interface ShipPlacement {
  shipIndex: number;
  startRow: number;
  startCol: number;
  isHorizontal: boolean;
}

export type AttackResult = "pending" | "miss" | "hit" | "sunk";

export type RoomStatus = "lobby" | "placement" | "battle" | "finished";

export interface Room {
  id: string;
  code: string;
  board_size: number;
  ship_defs: ShipDefinition[];
  status: RoomStatus;
  winner_team: number | null;
  created_at: string;
  /** Countdown lengths, configurable per room. Optional so rooms created before the
   *  qol_batch migration (which added the columns) still load with the defaults. */
  starting_seconds?: number;
  prep_seconds?: number;
  /** Sparse per-team name overrides. A null/blank entry keeps that team's color name. */
  team_names?: (string | null)[] | null;
  /** 9-digit seed every player feeds to the Elden Ring randomizer so they get matching runs. */
  seed?: string | null;
  /**
   * When that seed was last rolled - maintained by a trigger, so it is the SERVER's clock and it is
   * kept wherever the seed is written rather than at each of the three call sites that write one.
   *
   * Dates the BOARD rather than the room, which is the distinction Igon's reveal turns on: a room
   * made last week and re-randomized tonight is playing tonight's board. Optional because rooms from
   * before the column existed have none, and those read as too early - see squareSetFormat.igonUnveiled.
   */
  seed_set_at?: string | null;
  /** Which pool the board's squares come from - see lib/squareSets. Null means the default. */
  square_set?: string | null;
  /**
   * Where the balancer put the squares: perm[cell] indexes into the seeded deal.
   *
   * Written once by the balance-board function, between the last fleet being confirmed and the
   * first shot being possible, so no fleet ends up parked on a wall of late-game bosses while
   * another sits on tutorial soldiers. Null means the plain seeded deal - true of every room from
   * before balancing existed, and of any room whose balancer was unreachable.
   */
  board_perm?: number[] | null;
  /**
   * What the balancer made of the board it just dealt - see lib/matchBalance.
   *
   * Written by balance-board in the same update as board_perm, and copied onto the match by
   * archive_match, so the recap can say how fair the board was without anything re-deriving it.
   * Null wherever board_perm is null, and on every room from before it was kept.
   *
   * Typed `unknown` rather than as the record it holds, and not for want of a type: this file is
   * in the import graph of the edge functions, which run under Deno, and lib/matchBalance reaches
   * lib/supabase - a browser module built around import.meta.env and window. Even as `import
   * type` that put the whole browser client in front of Deno's type checker and broke `deno
   * check` on balance-board. It is also the more honest declaration: the column is jsonb, so it
   * genuinely is unknown until asMatchBalance has looked at it, which is what every reader does.
   */
  balance_report?: unknown;
  /**
   * The instant the match clock freezes, or null when it is running - see lib/matchPause.ts.
   *
   * Set five seconds AHEAD of the press, so a room in this state may still be counting down to the
   * freeze rather than sitting in it. Optional, like every column added after launch: a room from a
   * project that hasn't run the match_pause migration reads as a match that has never been stopped,
   * which is exactly what it is.
   */
  pause_at?: string | null;
  /** The instant the clock restarts, likewise set five seconds ahead of the host's press. */
  resume_at?: string | null;
  /** Every pause that has already closed, oldest first. */
  pause_log?: PauseWindow[] | null;
  /**
   * Declared in the lobby: this match counts for nothing - see the practice_matches migration.
   *
   * Set by the host while the room is still in 'lobby' and refused by a trigger after that, so it
   * is a decision made before anybody knows the result. archive_match copies it onto the match
   * record and voids the match in the same insert; from there every stats reader on the site
   * already skips it, because they all filter on `voided`.
   *
   * Optional like every column added after launch, and absent reads as a real match - which is the
   * right way round for a flag whose whole job is to take a match OUT of the record.
   */
  practice?: boolean;
  /**
   * The bracket match this room is playing, when it is an official tournament match. Optional like every
   * column added after launch; absent (or null) is an ordinary room. Set only by the official-match
   * functions - see 20260922010000_official_matches.
   */
  tournament_match_id?: string | null;
  /** Whether each team of the match has entered its entry code. Both must, before the match can start. */
  official_a_confirmed?: boolean;
  official_b_confirmed?: boolean;
  /** Which fleet (team index) each of the two teams sits on. Bound by whoever sits first. */
  official_team_a?: number | null;
  official_team_b?: number | null;
}

/** One stretch of stopped clock, written by the host once the window closes. */
export interface PauseWindow {
  at: string;
  until: string;
}

/**
 * Every board size a room can be set to. 5x5 is a bingo card; 14x14 is an entire evening.
 *
 * The top of the range is what the square sets can actually carry rather than a round number: the
 * full boss set is 206 squares, so 196 of them fit a 14x14 board and a 15x15 would have to deal 19
 * of them twice. Not every set reaches the top - a room is held to what the set it is ON can fill,
 * which is maxBoardSize, and the lobby greys out the rest.
 *
 * Coordinates run out first after this: cellLabel's letters stop at R, so 18 is the ceiling this
 * list could ever grow to without boards that name their own columns by number.
 */
export const BOARD_SIZES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/**
 * How much of the board each fleet preset covers.
 *
 * Classic is 0.17 because that is what real battleship is: 17 ship squares on a 10x10 board. The
 * other two are that proportion loosened and tightened, so a preset means the same thing - the same
 * chance a shot lands - on every board size.
 *
 * Armada is 0.24 rather than the 0.23 it launched at. At 0.23 an 8x8 Armada fielded no Destroyer at
 * all and an 11x11 fielded one, which is a strange shape for the preset that is meant to be the
 * busy one - the extra squares were going into another Cruiser rather than another hull to hunt.
 * The point of Armada is that shots land more often, so it rounds up.
 *
 * Declaration order IS the order the buttons render in (Object.keys preserves insertion order for
 * string keys).
 */
export const FLEET_PRESETS: Record<string, number> = {
  Skirmish: 0.11,
  Classic: 0.17,
  Armada: 0.24,
};

export const DEFAULT_FLEET_PRESET = "Classic";

/**
 * Ship names by length.
 *
 * Confined to the five hulls that have artwork in public/ships - the sprite is looked up by name,
 * so a "Corvette" or a "Dreadnought" renders as nothing at all, which is precisely how a 5x5 board
 * came to show two ships instead of three. Repeats within a size reuse a name rather than inventing
 * one; the old Armada preset already listed Cruiser and Destroyer twice, so nothing downstream
 * assumes fleet names are unique.
 */
const SHIP_NAMES: Record<number, string[]> = {
  5: ["Carrier"],
  4: ["Battleship"],
  3: ["Cruiser", "Submarine"],
  2: ["Destroyer"],
};

/**
 * Builds a fleet that fits a board of this size.
 *
 * Fleets used to be three fixed arrays, which only made sense on the board they were written for:
 * Classic's 17 squares is 68% of a 5x5 board - unplaceable - and 12% of a 12x12, where you could
 * hunt for a Destroyer all evening. Both the number of ships and the longest one now scale.
 *
 * The longest ship is held to about half the board's width, which is the proportion the standard
 * game uses (a 5-square Carrier on a 10-wide board) and the point past which a ship's position is
 * more or less given away by its length alone. From there the fleet repeats the classic
 * composition - one of each length, two of the 3s - until it covers the board.
 *
 * The fleet is never allowed to come out UNDER the density its preset asks for - it rounds up.
 * Where the next ship in the pattern would carry the fleet past the target, the shortest hull that
 * still reaches the target stands in for it, so the last ship lands on the line rather than
 * vaulting over it with squares to spare. That is what puts a second Destroyer on the busier
 * boards: an 11x11 Armada three squares short used to close with a Cruiser, and now closes with a
 * Destroyer and stops in the same place.
 *
 * Two consequences worth knowing. A 10x10 Classic board still deals exactly the standard fleet,
 * 5-4-3-3-2, because that composition IS the pattern at its natural size. And small boards come out
 * denser than the headline percentage, because MIN_SHIPS wins: three little ships on a 5x5 is a
 * game, and one is a coin toss.
 */
export function fleetFor(boardSize: number, preset: string = DEFAULT_FLEET_PRESET): ShipDefinition[] {
  const density = FLEET_PRESETS[preset] ?? FLEET_PRESETS[DEFAULT_FLEET_PRESET];
  const cells = boardSize * boardSize;
  // Rounded up, so a preset never deals a board thinner than it advertises.
  const target = Math.max(2, Math.ceil(cells * density));
  const longest = Math.min(5, Math.max(2, Math.floor(boardSize / 2) + 1));

  // The classic fleet, capped to what this board can carry: 5-4-3-3-2 becomes 4-3-3-2 on a board
  // too narrow for a Carrier, and 3-3-2 on one too narrow for a Battleship.
  const pattern: number[] = [];
  for (let s = longest; s >= 2; s--) {
    pattern.push(s);
    if (s === 3) pattern.push(3);
  }
  if (pattern.length === 0) pattern.push(2);

  // The hulls this board can carry, shortest first - what a closing ship is chosen from.
  const hulls = [...new Set(pattern)].sort((a, b) => a - b);

  // Terminates because nothing is ever skipped: every lap of the pattern takes every ship in it, so
  // `used` climbs by at least 2 a time and passes any target.
  const sizes: number[] = [];
  let used = 0;
  for (let i = 0; used < target; i++) {
    const patterned = pattern[i % pattern.length];
    // Closing the gap beats overshooting it. Where the patterned ship would carry the fleet past
    // the target, the shortest hull that still reaches the target stands in for it - usually a
    // Destroyer, which is why the busier boards now field two. A ship is only ever swapped DOWN, so
    // the fleet keeps the classic silhouette and only its last hull shrinks.
    const closing = hulls.find((h) => h >= target - used);
    const size = closing !== undefined && closing < patterned ? closing : patterned;
    sizes.push(size);
    used += size;
  }

  // A board with one or two ships on it is decided by whoever stumbles on them first. Pad with the
  // smallest hull rather than leaving the fleet that thin, even where it costs the density target.
  const MIN_SHIPS = 3;
  while (sizes.length < MIN_SHIPS) sizes.push(Math.min(2, longest));

  // Cycles the pool so a fleet with two 3s reads "Cruiser, Submarine" rather than "Cruiser" twice.
  // Beyond the pool it repeats, unnumbered: a numeral would be a name with no sprite behind it.
  const usedNames: Record<number, number> = {};
  return sizes.map((s) => {
    const pool = SHIP_NAMES[s] ?? SHIP_NAMES[2];
    const n = usedNames[s] ?? 0;
    usedNames[s] = n + 1;
    return { name: pool[n % pool.length], size: s };
  });
}

/**
 * Which preset a room's fleet matches, or null for one from before fleets scaled with the board.
 *
 * Has to be answered against THIS board size: "Classic" is 5-4-3-3-2 on a 10x10 and 4-3-2 on a
 * 7x7, so the same stored fleet is Classic on one board and nothing recognizable on another.
 *
 * Lives here beside fleetFor rather than in the settings panel, because resizing a board is no
 * longer only something a host does on purpose - the lobby's roster sync can pull a board down to
 * what its square set can carry, and it has to refit the fleet the same way the buttons do.
 */
export function presetNameOf(shipDefs: ShipDefinition[], boardSize: number): string | null {
  const shape = (defs: ShipDefinition[]) => defs.map((d) => d.size).join(",");
  const mine = shape(shipDefs);
  return Object.keys(FLEET_PRESETS).find((k) => shape(fleetFor(boardSize, k)) === mine) ?? null;
}

/**
 * The fleet presets, resolved for one board size. Callers that just need the buttons.
 */
export function fleetPresetsFor(boardSize: number): Record<string, ShipDefinition[]> {
  return Object.fromEntries(Object.keys(FLEET_PRESETS).map((k) => [k, fleetFor(boardSize, k)]));
}

export interface MatchReportRow {
  id: string;
  match_key: string;
  room_code: string;
  winner_team: number | null;
  duration: string | null;
  total_shots: number;
  /**
   * Both optional because the list readers do not ask for either - see REPORT_LINE_COLUMNS in
   * lib/rooms. `summary` is the biggest column in the archive and nothing that renders a LIST of
   * matches reads it; `report_text` is fetched only by the front page, which has a Copy button for
   * it. Required here would be a type that promises data the row was never asked for.
   */
  summary?: unknown;
  report_text?: string;
  finished_at: string;
  /** Struck from every stat and record but still archived - see lib/voidedMatches. */
  voided?: boolean;
  /** Voided because it was declared a practice match before it was played, and never reversible. */
  practice?: boolean;
}

export interface TeamReady {
  room_id: string;
  team: number;
  ready: boolean;
  eliminated: boolean;
}

export interface Player {
  id: string;
  room_id: string;
  user_id: string;
  nickname: string;
  team: number | null;
  is_host: boolean;
  joined_at: string;
  /** Bearer token for reclaiming this slot on another device. Optional so player rows
   *  predating the rejoin_codes migration still parse. */
  rejoin_code?: string | null;
  /** When this player picked their current fleet. Earliest on a team is its captain. */
  team_joined_at?: string | null;
  /**
   * When this player last asked for a pause, or null if they haven't - see components/PauseControls.
   *
   * A column rather than a Realtime broadcast so the ask survives the host being tabbed out, and a
   * timestamp rather than a boolean so a second ask after an ignored first one is a fresh event the
   * chime can tell apart from the one already on screen.
   */
  pause_requested_at?: string | null;
  /** Whether this player has readied up during the current pause. Cleared by the host at both ends. */
  pause_ready?: boolean;
}

export interface Fleet {
  room_id: string;
  team: number;
  ship_grid: boolean[];
  ship_index_grid: number[];
  ship_hits_remaining: number[];
  ship_sunk: boolean[];
  placements: ShipPlacement[] | null;
  placement_confirmed: boolean;
}

export interface Attack {
  id: string;
  room_id: string;
  cell_index: number;
  attacker_team: number;
  defender_team: number;
  attacker_player_id: string | null;
  result: AttackResult;
  sunk_ship_name: string | null;
  sunk_ship_size: number | null;
  sunk_start_row: number | null;
  sunk_start_col: number | null;
  sunk_horizontal: boolean | null;
  created_at: string;
  resolved_at: string | null;
  /**
   * Fired by the auto-fire edge function rather than clicked. Optional because rows from before the
   * auto_fire_only_timing migration don't carry it, and those read as manual - which is what the
   * pace rule wants of a shot whose timestamp can't be trusted as the kill time.
   */
  auto?: boolean;
}
