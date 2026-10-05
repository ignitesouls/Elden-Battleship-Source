/**
 * Which games are comparable: same board size, same fleet.
 *
 * Hits, hulls sunk and shots taken are capped by the board and the fleet - a 6x6 game against three
 * ships cannot reach a 14x14 game's numbers - so a personal best only means something against games
 * played on the same shape. Both the overlay's PB line (the auto-fire Edge Function) and the career
 * page's "Single-game bests" key on this, which is why it lives in one place.
 *
 * The fleet is compared by its hull sizes alone, longest first: ship names and the order the lobby
 * lists them in are cosmetic, and two fleets with the same hulls play identically.
 *
 * No imports, deliberately: the Edge Function pulls this file into Deno as-is.
 */

/** "5,4,3,3,2" - the fleet's hull sizes, longest first. */
export function fleetShape(ships: { size: number }[] | null | undefined): string {
  return (ships ?? [])
    .map((s) => s.size)
    .sort((a, b) => b - a)
    .join(",");
}

/** "10|5,4,3,3,2" - one key per comparable board. */
export function boardShapeKey(boardSize: number, ships: { size: number }[] | null | undefined): string {
  return `${boardSize}|${fleetShape(ships)}`;
}
