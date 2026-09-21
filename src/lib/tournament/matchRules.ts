/**
 * What an event dictates to its official rooms: the two timers. Not the board size - it is the host's
 * to choose and is locked once the room is official, and offering it here would mean rebuilding the
 * fleet to match, which the lobby's own settings do in one write and this cannot (see
 * link_official_room).
 */
export interface MatchRules {
  prep_seconds: number;
  starting_seconds: number;
}

/** The room's own defaults, so an event that says nothing plays the way every other room does. */
export const DEFAULT_MATCH_RULES: MatchRules = { prep_seconds: 240, starting_seconds: 10 };

export const PREP_MINUTES = [1, 2, 3, 4, 5, 6, 8, 10];
export const COUNTDOWNS = [3, 5, 10, 15, 30];

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
  };
}
