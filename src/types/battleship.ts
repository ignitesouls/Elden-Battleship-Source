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
}

/** Every board size a room can be set to. 5x5 is a bingo card; 12x12 is a long evening. */
export const BOARD_SIZES = [5, 6, 7, 8, 9, 10, 11, 12];

/**
 * How much of the board each fleet preset covers.
 *
 * Classic is 0.17 because that is what real battleship is: 17 ship squares on a 10x10 board. The
 * other two are that proportion loosened and tightened, so a preset means the same thing - the same
 * chance a shot lands - on every board size.
 *
 * Declaration order IS the order the buttons render in (Object.keys preserves insertion order for
 * string keys).
 */
export const FLEET_PRESETS: Record<string, number> = {
  Skirmish: 0.11,
  Classic: 0.17,
  Armada: 0.23,
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
 * Two consequences worth knowing. A 10x10 Classic board still deals exactly the standard fleet,
 * 5-4-3-3-2, because that composition IS the pattern at its natural size. And small boards come out
 * denser than the headline percentage, because MIN_SHIPS wins: three little ships on a 5x5 is a
 * game, and one is a coin toss.
 */
export function fleetFor(boardSize: number, preset: string = DEFAULT_FLEET_PRESET): ShipDefinition[] {
  const density = FLEET_PRESETS[preset] ?? FLEET_PRESETS[DEFAULT_FLEET_PRESET];
  const cells = boardSize * boardSize;
  const target = Math.max(2, Math.round(cells * density));
  const longest = Math.min(5, Math.max(2, Math.floor(boardSize / 2) + 1));

  // The classic fleet, capped to what this board can carry: 5-4-3-3-2 becomes 4-3-3-2 on a board
  // too narrow for a Carrier, and 3-3-2 on one too narrow for a Battleship.
  const pattern: number[] = [];
  for (let s = longest; s >= 2; s--) {
    pattern.push(s);
    if (s === 3) pattern.push(3);
  }
  if (pattern.length === 0) pattern.push(2);

  // Terminates because the pattern always ends in a 2, and while `used < target` a 2 always fits
  // inside the +1 tolerance - so every lap of the pattern takes at least one ship.
  const sizes: number[] = [];
  let used = 0;
  for (let i = 0; used < target; i++) {
    const size = pattern[i % pattern.length];
    // Overshooting by one square beats leaving two short - the alternative is padding every fleet
    // with 2s, which reads as a swarm of Destroyers rather than a fleet.
    if (used + size <= target + 1) {
      sizes.push(size);
      used += size;
    }
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
  summary: unknown;
  report_text: string;
  finished_at: string;
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
}
