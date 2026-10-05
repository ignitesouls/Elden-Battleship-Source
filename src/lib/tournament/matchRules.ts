import { BOARD_SIZES, customFleetFits, fleetFor, type ShipDefinition } from "../../types/battleship";

/**
 * What an event dictates to its official rooms. The two timers always; and, each on its own, the square
 * set, the board size and the fleet. A null is the host's choice, as it was before an event could say.
 *
 * Any of the three can be fixed without the others, so linking a room settles them the way the lobby
 * does when a host changes one (see link_official_room):
 *   - a fixed SET pulls a host board that is too big for it down to the set's ceiling, refitting the
 *     host's fleet - what picking that set in the lobby does (clampBoardSize + refitFleet);
 *   - a fixed SIZE refits the host's fleet to it, and refuses a room whose squares cannot fill it;
 *   - a fixed FLEET replaces the host's, and refuses a room whose board is too small to hold it.
 * Where two are fixed together, the editor keeps them consistent (rulesProblem).
 *
 * Pure on purpose, like the rest of lib/tournament: the square sets themselves (lib/squareSets, which
 * pulls in every set's JSON) stay out, and the one thing needed from them - each set's ceiling - is
 * passed in by the caller as a SetCaps map.
 */
export interface MatchRules {
  prep_seconds: number;
  starting_seconds: number;
  square_set: string | null;
  board_size: number | null;
  fleet: ShipDefinition[] | null;
}

/** Every square set's largest board, by id - squareSetCaps() in lib/squareSets. */
export type SetCaps = Record<string, number>;

/** The set a room with no square_set plays, and the one an unknown id falls back to (lib/squareSets). */
const DEFAULT_SET = "bosses";

/** The room's own defaults, so an event that says nothing plays the way every other room does. */
export const DEFAULT_MATCH_RULES: MatchRules = {
  prep_seconds: 240,
  starting_seconds: 10,
  square_set: null,
  board_size: null,
  fleet: null,
};

export const PREP_MINUTES = [1, 2, 3, 4, 5, 6, 8, 10];
export const COUNTDOWNS = [3, 5, 10, 15, 30];

const capOf = (caps: SetCaps, set: string) => caps[set] ?? caps[DEFAULT_SET] ?? BOARD_SIZES[BOARD_SIZES.length - 1];

/** The smallest board a fleet fits on, or null if none does. */
export function minBoardFor(fleet: ShipDefinition[]): number | null {
  return BOARD_SIZES.find((n) => customFleetFits(fleet, n)) ?? null;
}

function shipsFrom(x: unknown): ShipDefinition[] | null {
  if (!Array.isArray(x) || x.length === 0) return null;
  const ok = x.every(
    (s) => s && typeof s === "object" && typeof (s as ShipDefinition).name === "string" &&
      Number.isInteger((s as ShipDefinition).size) && (s as ShipDefinition).size >= 1,
  );
  return ok ? (x as ShipDefinition[]).map((s) => ({ name: s.name, size: s.size })) : null;
}

/**
 * The rules as saved on an event, whatever state the JSON is in. An event that never set any holds an
 * empty object, and a value of the wrong type (a hand-edited row, a future field) is ignored rather
 * than trusted - a timer of "abc" must not reach a room.
 */
export function rulesFrom(saved: unknown): MatchRules {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const positive = (x: unknown, fallback: number) =>
    typeof x === "number" && Number.isFinite(x) && x > 0 ? x : fallback;
  return {
    prep_seconds: positive(s.prep_seconds, DEFAULT_MATCH_RULES.prep_seconds),
    starting_seconds: positive(s.starting_seconds, DEFAULT_MATCH_RULES.starting_seconds),
    square_set: typeof s.square_set === "string" && s.square_set.trim() !== "" ? s.square_set : null,
    board_size: typeof s.board_size === "number" && BOARD_SIZES.includes(s.board_size) ? s.board_size : null,
    fleet: shipsFrom(s.ship_defs),
  };
}

/**
 * Why these rules cannot be saved, or null when they can. Only combinations can be wrong - each
 * setting on its own is always playable, and anything a particular room cannot meet is refused when
 * that room links, with the reason.
 */
export function rulesProblem(rules: MatchRules, caps: SetCaps): string | null {
  const { square_set: set, board_size: size, fleet } = rules;
  if (fleet && fleet.length === 0) return "A fixed fleet needs at least one ship.";
  if (set && size && size > capOf(caps, set)) {
    const cap = capOf(caps, set);
    return `These squares fill a board up to ${cap}x${cap}, not ${size}x${size}.`;
  }
  if (fleet) {
    const min = minBoardFor(fleet);
    if (min === null) return "That fleet is too big for any board.";
    if (size && !customFleetFits(fleet, size)) return `That fleet covers more than half of a ${size}x${size} board.`;
    if (!size && set && min > capOf(caps, set)) {
      const cap = capOf(caps, set);
      return `That fleet needs at least a ${min}x${min} board, and these squares fill ${cap}x${cap} at most.`;
    }
  }
  return null;
}

/**
 * The rules as the event stores them - what link_official_room reads.
 *
 * Besides the settings themselves, two lookups go along whenever any of the board is fixed, because
 * linking may have to resize a room and Postgres knows neither the square sets nor the fleet presets:
 * every set's ceiling (`set_caps`), and the default fleet for every board size (`default_fleets`), which
 * is what a host's default fleet becomes on a new size and how linking tells a default fleet from a
 * custom one. With them the database settles a room exactly as refitFleet and clampBoardSize would.
 */
export function toMatchSettings(rules: MatchRules, caps: SetCaps): Record<string, unknown> {
  const out: Record<string, unknown> = { prep_seconds: rules.prep_seconds, starting_seconds: rules.starting_seconds };
  if (rules.square_set) out.square_set = rules.square_set;
  if (rules.board_size) out.board_size = rules.board_size;
  if (rules.fleet) out.ship_defs = rules.fleet.map((s) => ({ name: s.name, size: s.size }));
  if (rules.square_set || rules.board_size || rules.fleet) {
    out.set_caps = { ...caps };
    out.default_fleets = Object.fromEntries(BOARD_SIZES.map((n) => [String(n), fleetFor(n)]));
  }
  return out;
}

export function sameRules(a: MatchRules, b: MatchRules): boolean {
  return (
    a.prep_seconds === b.prep_seconds &&
    a.starting_seconds === b.starting_seconds &&
    a.square_set === b.square_set &&
    a.board_size === b.board_size &&
    JSON.stringify(a.fleet) === JSON.stringify(b.fleet)
  );
}

/**
 * Puts the rules on a set, keeping a fixed board size where it still fits and pulling it down to the
 * set's ceiling where it doesn't - the same thing the lobby does (clampBoardSize).
 */
export function withSquareSet(rules: MatchRules, set: string | null, caps: SetCaps): MatchRules {
  if (!set || rules.board_size === null) return { ...rules, square_set: set };
  return { ...rules, square_set: set, board_size: Math.min(rules.board_size, capOf(caps, set)) };
}
