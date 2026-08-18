// The .ts is load-bearing, and the only import in src/ that carries one. The edge functions import
// activeTeams() from this module, and Deno resolves specifiers literally - extensionless, it cannot
// find this file and the whole worker fails to boot with "Module not found", taking auto-fire and
// balance-board down with it. Vite and tsc both accept the extension (allowImportingTsExtensions),
// so it costs nothing here. The alternative the other shared modules take is to have no imports at
// all - see the note atop squareSetFormat.ts.
import type { Attack, ShipDefinition, ShipPlacement } from "../types/battleship.ts";

/**
 * An array of `size` copies of `fill`.
 *
 * It used to return `size * size`, while every caller already passed the count it wanted - the cell
 * count for a board, the ship count for a fleet. Two consequences, one merely wasteful and one that
 * broke matches:
 *
 *   * ship_grid and ship_index_grid were board_size^4 long: 10,000 entries for a 10x10 and 20,736
 *     for a 12x12, written into a jsonb column on every placement. Harmless to gameplay, since only
 *     the first board_size² entries were ever read.
 *   * ship_sunk was ships², so a three-ship fleet carried six phantom `false`s that nothing could
 *     ever set. resolve_attack() decides a team is eliminated with `not (sunk @> 'false')`, which
 *     those phantoms made permanently untrue - so sinking every ship on a board eliminated nobody,
 *     no winner was ever declared, and the match sat in 'battle' forever. It is also why the record
 *     books are empty: archiving only runs once a match reaches 'finished'.
 */
export function emptyGrid<T>(size: number, fill: T): T[] {
  return new Array(size).fill(fill);
}

export interface PlacementResult {
  valid: boolean;
  shipGrid: boolean[];
  shipIndexGrid: number[];
}

/**
 * Mirrors ServerBattleshipTeamBoard.TryPlaceShips: validates bounds/overlap and builds the
 * grids. Works for partial placement lists too (built up incrementally as the player places
 * each ship) - the grid always reflects every valid ship given, so overlap checks against
 * already-placed ships work throughout, not just once the full set is submitted. `valid`
 * additionally requires the full set to be present with no violations.
 */
export function validatePlacements(
  boardSize: number,
  shipDefs: ShipDefinition[],
  placements: ShipPlacement[]
): PlacementResult {
  const totalCells = boardSize * boardSize;
  const shipGrid = emptyGrid(totalCells, false);
  const shipIndexGrid = emptyGrid(totalCells, -1);
  let valid = true;

  for (const p of placements) {
    const s = p.shipIndex;
    const shipSize = shipDefs[s]?.size;
    if (shipSize === undefined) {
      valid = false;
      continue;
    }

    const dr = p.isHorizontal ? 0 : 1;
    const dc = p.isHorizontal ? 1 : 0;

    for (let i = 0; i < shipSize; i++) {
      const r = p.startRow + dr * i;
      const c = p.startCol + dc * i;

      if (r < 0 || r >= boardSize || c < 0 || c >= boardSize) {
        valid = false;
        continue;
      }

      const idx = r * boardSize + c;
      if (shipGrid[idx]) {
        valid = false;
        continue;
      }

      shipGrid[idx] = true;
      shipIndexGrid[idx] = s;
    }
  }

  if (placements.length !== shipDefs.length) valid = false;

  return { valid, shipGrid, shipIndexGrid };
}

export interface AttackOutcome {
  result: "miss" | "hit" | "sunk";
  sunkShip?: {
    name: string;
    size: number;
    startRow: number;
    startCol: number;
    isHorizontal: boolean;
  };
  newHitsRemaining: number[];
  newShipSunk: boolean[];
}

/** Mirrors ServerBattleshipTeamBoard.ReceiveAttack, run locally by the defending player's client. */
export function resolveAttack(
  shipDefs: ShipDefinition[],
  fleet: {
    shipGrid: boolean[];
    shipIndexGrid: number[];
    shipHitsRemaining: number[];
    shipSunk: boolean[];
    placements: ShipPlacement[] | null;
  },
  cellIndex: number
): AttackOutcome {
  const newHitsRemaining = [...fleet.shipHitsRemaining];
  const newShipSunk = [...fleet.shipSunk];

  if (!fleet.shipGrid[cellIndex]) {
    return { result: "miss", newHitsRemaining, newShipSunk };
  }

  const shipIdx = fleet.shipIndexGrid[cellIndex];
  newHitsRemaining[shipIdx] = Math.max(0, newHitsRemaining[shipIdx] - 1);

  if (newHitsRemaining[shipIdx] <= 0) {
    newShipSunk[shipIdx] = true;
    const placement = fleet.placements?.[shipIdx];
    return {
      result: "sunk",
      sunkShip: placement
        ? {
            name: shipDefs[shipIdx].name,
            size: shipDefs[shipIdx].size,
            startRow: placement.startRow,
            startCol: placement.startCol,
            isHorizontal: placement.isHorizontal,
          }
        : undefined,
      newHitsRemaining,
      newShipSunk,
    };
  }

  return { result: "hit", newHitsRemaining, newShipSunk };
}

export function allShipsSunk(shipSunk: boolean[]): boolean {
  return shipSunk.length > 0 && shipSunk.every((s) => s);
}

/**
 * Teams whose whole fleet is on the bottom, derived purely from the public attack log.
 *
 * Deliberately not read from `team_ready.eliminated`: RLS only lets a team write its OWN
 * team_ready row, so if the losing team's browser is closed (or just slow) nobody ever marks
 * them eliminated and the match hangs unfinished forever. Every resolved "sunk" row already
 * publishes which ship of whose fleet went down, so any client can reach the same verdict
 * without needing the loser present to confirm their own defeat.
 */
export function eliminatedTeamsFromAttacks(attacks: Attack[], shipCount: number): Set<number> {
  if (shipCount <= 0) return new Set();

  /**
   * Hulls are counted by WHERE THEY WERE, not by what they were called.
   *
   * Ship names are not unique within a fleet and were never meant to be - fleetFor() draws from the
   * five hulls that have artwork, so anything longer than that pool repeats, and a preset thin
   * enough to need padding repeats too. Ten of the twenty-four board/preset combinations field a
   * duplicate name: a 5x5 Classic is Cruiser + Destroyer + Destroyer, a 12x12 Armada is ten hulls
   * drawn from five names. Counting distinct names in those rooms tops out below the fleet size, so
   * this function could never reach `>= shipCount` and the fallback silently never fired.
   *
   * A start cell identifies a hull exactly, because validatePlacements() rejects any layout where
   * two ships share a square - so no two hulls in one fleet can begin on the same one. It also
   * de-duplicates for free: a sunk ship whose cells are fired at again resolves as 'sunk' a second
   * time (hits are floored at zero), and both rows carry the same geometry.
   */
  const byTeam = new Map<number, { hulls: Set<string>; names: Set<string>; complete: boolean }>();

  for (const a of attacks) {
    if (a.result !== "sunk") continue;
    let entry = byTeam.get(a.defender_team);
    if (!entry) {
      entry = { hulls: new Set(), names: new Set(), complete: true };
      byTeam.set(a.defender_team, entry);
    }
    if (a.sunk_start_row !== null && a.sunk_start_col !== null) {
      entry.hulls.add(`${a.sunk_start_row},${a.sunk_start_col}`);
    } else {
      // resolve_attack() only records geometry when the fleet had placements to read. Nothing
      // reaches battle without them, but a row from before that column existed would land here.
      entry.complete = false;
    }
    if (a.sunk_ship_name) entry.names.add(a.sunk_ship_name);
  }

  const eliminated = new Set<number>();
  for (const [team, entry] of byTeam) {
    // Never mix the two keys within a team, or one hull counted both ways reads as two. A team's
    // rows either all carry geometry or none do, since it depends on that fleet's row alone.
    const counted = entry.complete ? entry.hulls.size : entry.names.size;
    if (counted >= shipCount) eliminated.add(team);
  }
  return eliminated;
}

/**
 * Every cell index covered by a sunk ship, mapped to that ship's orientation, across a set of
 * resolved attacks. A "sunk" attack row only marks the one cell that dealt the final blow, but
 * it carries the full geometry of the ship it sank (sunk_start_row/col/size/horizontal) -
 * expand that out so every hull cell, not just the last one hit, can be drawn as a sunk wreck
 * (with fire/smoke oriented to match the hull) instead of a plain hit.
 */
export function sunkCellOrientations(attacks: Attack[], boardSize: number): Map<number, boolean> {
  const cells = new Map<number, boolean>();
  for (const a of attacks) {
    if (a.result !== "sunk" || a.sunk_start_row === null || a.sunk_start_col === null || a.sunk_ship_size === null) {
      continue;
    }
    const dr = a.sunk_horizontal ? 0 : 1;
    const dc = a.sunk_horizontal ? 1 : 0;
    for (let i = 0; i < a.sunk_ship_size; i++) {
      cells.set((a.sunk_start_row + dr * i) * boardSize + (a.sunk_start_col + dc * i), !!a.sunk_horizontal);
    }
  }
  return cells;
}

/**
 * Which fleets have fired at each square, across a set of attacks.
 *
 * The composited caster board draws every shown fleet on one grid and merges the results worst-first
 * (see the note in OverlayBoard) - so a square says what happened there but says nothing about who
 * made it happen, which on a two-fleet board is half the story. This is the other half: cell index ->
 * the teams that have fired at it, which BoardGrid draws as a ring in each fleet's own colour.
 *
 * Only RESOLVED shots count. A pending row is a shot the server hasn't judged yet, and ringing it
 * would put a mark on an otherwise blank square - announcing that somebody fired there while the
 * board still shows nothing. The ring appears with the result, or not at all.
 *
 * Sorted by team number rather than by who fired first, so a square's ring is in the same order as
 * every other square's: the ring is read across a whole board at a glance, and segments that swapped
 * sides from square to square would make it unreadable. Nothing here says anything about the fleets'
 * ships, so it is as safe to send to a stream as the shot log it comes from.
 */
export function attackerTeamsByCell(attacks: Attack[]): Map<number, number[]> {
  const byCell = new Map<number, Set<number>>();
  for (const a of attacks) {
    // Negative indices are bookkeeping rows (the match-start marker), not shots anyone fired.
    if (a.cell_index < 0 || a.result === "pending") continue;
    let teams = byCell.get(a.cell_index);
    if (!teams) {
      teams = new Set();
      byCell.set(a.cell_index, teams);
    }
    teams.add(a.attacker_team);
  }

  const out = new Map<number, number[]>();
  for (const [cell, teams] of byCell) out.set(cell, [...teams].sort((x, y) => x - y));
  return out;
}

const CELL_LETTERS = "ABCDEFGHIJKLMNOPQR";

/** Cell index -> the board label a player would read aloud, e.g. 23 on a 10-wide board -> "D3". */
export function cellLabel(cellIndex: number, boardSize: number): string {
  const row = Math.floor(cellIndex / boardSize);
  const col = cellIndex % boardSize;
  return `${CELL_LETTERS[col] ?? col + 1}${row + 1}`;
}

/**
 * The inverse: "D3" -> 23 on a 10-wide board. Null for anything this board could not have produced.
 *
 * Kept beside cellLabel so the two cannot drift, and it exists for one caller: the Almanac recovers
 * the squares of a few old finds out of the honor text, because matches archived before the finds
 * themselves were stored have no other record of where they happened. See matchArchive.deepFromAwards.
 */
export function cellFromLabel(label: string, boardSize: number): number | null {
  const parsed = /^([A-R])(\d{1,2})$/.exec(label.trim().toUpperCase());
  if (!parsed) return null;
  const col = CELL_LETTERS.indexOf(parsed[1]);
  const row = Number(parsed[2]) - 1;
  if (col < 0 || col >= boardSize || row < 0 || row >= boardSize) return null;
  return row * boardSize + col;
}

/** Distinct team numbers with at least one non-spectator player, sorted. */
/**
 * The captain of a fleet: whoever picked it first.
 *
 * Must match team_captain() in SQL exactly - same ordering, same tie-break - or the UI will offer
 * controls the database then refuses. Rows without a team_joined_at sort last, which puts anyone
 * predating that column behind players who have picked since.
 */
export function captainOf<T extends { id: string; team: number | null; team_joined_at?: string | null }>(
  players: T[],
  team: number
): T | null {
  const crew = players.filter((p) => p.team === team);
  if (crew.length === 0) return null;

  return [...crew].sort((a, b) => {
    const at = a.team_joined_at ?? null;
    const bt = b.team_joined_at ?? null;
    if (at !== bt) {
      if (at === null) return 1; // nulls last
      if (bt === null) return -1;
      return at.localeCompare(bt);
    }
    return a.id.localeCompare(b.id);
  })[0];
}

export function isCaptain(
  players: { id: string; team: number | null; team_joined_at?: string | null }[],
  team: number | null,
  playerId: string
): boolean {
  if (team === null) return false;
  return captainOf(players, team)?.id === playerId;
}

export function activeTeams(players: { team: number | null }[]): number[] {
  const teams = new Set<number>();
  for (const p of players) {
    if (p.team !== null && p.team !== undefined) teams.add(p.team);
  }
  return [...teams].sort((a, b) => a - b);
}

export function initialHitsRemaining(shipDefs: ShipDefinition[]): number[] {
  return shipDefs.map((s) => s.size);
}

/** Randomly places every ship without overlap, for a "Randomize" convenience button. */
export function randomPlacements(boardSize: number, shipDefs: ShipDefinition[]): ShipPlacement[] {
  const placements: ShipPlacement[] = [];
  const occupied = emptyGrid(boardSize * boardSize, false);

  for (let s = 0; s < shipDefs.length; s++) {
    const size = shipDefs[s].size;
    let placed = false;
    for (let attempt = 0; attempt < 500 && !placed; attempt++) {
      const isHorizontal = Math.random() < 0.5;
      const startRow = Math.floor(Math.random() * boardSize);
      const startCol = Math.floor(Math.random() * boardSize);
      const dr = isHorizontal ? 0 : 1;
      const dc = isHorizontal ? 1 : 0;

      const cells: number[] = [];
      let fits = true;
      for (let i = 0; i < size; i++) {
        const r = startRow + dr * i;
        const c = startCol + dc * i;
        if (r < 0 || r >= boardSize || c < 0 || c >= boardSize) {
          fits = false;
          break;
        }
        const idx = r * boardSize + c;
        if (occupied[idx]) {
          fits = false;
          break;
        }
        cells.push(idx);
      }

      if (fits) {
        cells.forEach((idx) => (occupied[idx] = true));
        placements.push({ shipIndex: s, startRow, startCol, isHorizontal });
        placed = true;
      }
    }
    if (!placed) {
      // Extremely unlikely on a standard 10x10 board with classic ships; retry the whole layout.
      return randomPlacements(boardSize, shipDefs);
    }
  }

  return placements;
}

// Room-code generation lives in ./roomCode (nautical word pairs), re-exported here so existing
// importers of this module keep working.
// Extension-qualified so this module can be imported by scripts/check-boards.ts, which runs under
// bare Node with no resolver to guess it. Same reason scouting.ts spells out ./careerStats.ts.
export { generateRoomCode, normalizeRoomCode, formatRoomCode } from "./roomCode.ts";
