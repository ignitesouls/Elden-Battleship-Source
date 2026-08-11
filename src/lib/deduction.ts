import type { Attack, ShipDefinition } from "../types/battleship";

/** What the "cross out dead water" toggle promises, wherever it's offered. */
export const AUTO_RULE_HINT =
  "Cross out squares where no ship still afloat could possibly fit - the gaps between your misses that are shorter than the shortest hull left. Your own marks are unaffected.";

/**
 * Squares that cannot hold a ship any more, worked out from your own shots.
 *
 * The deduction every battleship player does by hand and then loses track of on a hundred-square
 * board: once the shortest hull still afloat is four long, every gap of three or fewer squares
 * between your misses is dead water. Nothing can be in there, so there is no reason to ever spend a
 * shot on it - and on a board where each square is a named boss fight, "no reason to go there" is
 * worth a great deal more than usual.
 *
 * Two deliberate limits:
 *
 *   * It reasons from YOUR fleet's shots only, never from the public log of everyone else's. Other
 *     fleets' misses against the same defender are public and would sharpen this considerably, but
 *     they aren't on your board - and a square crossed out for a reason you can't see on screen is
 *     worse than no help at all.
 *   * A square is only ruled out when it's impossible for EVERY fleet you're still firing at. One
 *     shot hits all of them at the same square, so as long as one opponent could still be sitting
 *     there, the square is live.
 *
 * Both make this strictly conservative: it never crosses out a square that could hold something.
 */
export function ruledOutCells(opts: {
  boardSize: number;
  shipDefs: ShipDefinition[];
  /** Your fleet's shots, every defender. */
  outgoing: Attack[];
  /** Fleets still worth firing at - eliminated ones can't be hiding anything. */
  opponentTeams: number[];
}): Set<number> {
  const { boardSize, shipDefs, outgoing, opponentTeams } = opts;
  const out = new Set<number>();
  if (opponentTeams.length === 0 || shipDefs.length === 0) return out;

  const possible = new Set<number>();
  // Squares already saying something on the board - your own shots, plus every square of a hull you
  // watched go down, since the fire board draws the whole wreck and not just the killing blow. An X
  // on top of either is noise. (Those two aren't the same set: in a 3+ fleet match another fleet's
  // shots can wound a hull you then finish, so a wreck can span squares you never fired at.)
  const shown = new Set(outgoing.map((a) => a.cell_index));

  for (const team of opponentTeams) {
    const shots = outgoing.filter((a) => a.defender_team === team);
    const blocked = blockedCells(shots, boardSize);
    for (const c of wreckCells(shots, boardSize)) shown.add(c);

    const shortest = shortestAfloat(shipDefs, shots);
    // Nothing left of this fleet to find, so it can't be the reason to keep a square open. A fleet
    // that IS still afloat but has been shot at not at all simply blocks nothing, and every square
    // comes back possible - which is the correct answer at that point.
    if (shortest === null) continue;
    markPossible(possible, blocked, boardSize, shortest);
  }

  for (let i = 0; i < boardSize * boardSize; i++) {
    if (!possible.has(i) && !shown.has(i)) out.add(i);
  }
  return out;
}

/**
 * Length of the shortest hull this fleet could still have afloat, or null if they're all down.
 *
 * Only the shortest matters. A square that a five-long hull could cover can always be covered by a
 * shorter one sitting inside that same run of clear water, so checking every remaining length would
 * reach exactly the same answer as checking the smallest.
 *
 * Sunk hulls are counted by WHERE THEY WERE rather than by name, for the reason spelled out in
 * eliminatedTeamsFromAttacks: ship names repeat within a fleet, and start cells can't.
 */
function shortestAfloat(shipDefs: ShipDefinition[], shots: Attack[]): number | null {
  const sunkSizes = new Map<string, number>();
  for (const a of shots) {
    if (a.result !== "sunk" || a.sunk_start_row === null || a.sunk_start_col === null) continue;
    if (a.sunk_ship_size === null) continue;
    sunkSizes.set(`${a.sunk_start_row},${a.sunk_start_col}`, a.sunk_ship_size);
  }

  const afloat = shipDefs.map((s) => s.size);
  for (const size of sunkSizes.values()) {
    const i = afloat.indexOf(size);
    if (i >= 0) afloat.splice(i, 1);
  }
  return afloat.length === 0 ? null : Math.min(...afloat);
}

/**
 * Squares no remaining hull of this fleet can be sitting on.
 *
 * A miss is empty water. Every square of a hull you've already sunk is taken by a wreck, so nothing
 * still afloat is under it either. A plain hit is NOT blocked - it's part of something still alive,
 * and a remaining hull can perfectly well run through it.
 */
function blockedCells(shots: Attack[], boardSize: number): Set<number> {
  const blocked = wreckCells(shots, boardSize);
  for (const a of shots) {
    if (a.result === "miss") blocked.add(a.cell_index);
  }
  return blocked;
}

/** Every square under a hull of theirs you've sunk, expanded from the geometry on the sunk row. */
function wreckCells(shots: Attack[], boardSize: number): Set<number> {
  const cells = new Set<number>();
  for (const a of shots) {
    if (a.result !== "sunk" || a.sunk_start_row === null || a.sunk_start_col === null) continue;
    if (a.sunk_ship_size === null) continue;
    const dr = a.sunk_horizontal ? 0 : 1;
    const dc = a.sunk_horizontal ? 1 : 0;
    for (let i = 0; i < a.sunk_ship_size; i++) {
      cells.add((a.sunk_start_row + dr * i) * boardSize + (a.sunk_start_col + dc * i));
    }
  }
  return cells;
}

/** Every square a hull of `size` could still be laid across, in either direction. */
function markPossible(possible: Set<number>, blocked: Set<number>, boardSize: number, size: number) {
  if (size > boardSize) return;

  for (let line = 0; line < boardSize; line++) {
    for (let start = 0; start + size <= boardSize; start++) {
      // Horizontal: `line` is the row. Vertical: `line` is the column.
      const across: number[] = [];
      const down: number[] = [];
      for (let i = 0; i < size; i++) {
        across.push(line * boardSize + start + i);
        down.push((start + i) * boardSize + line);
      }
      if (across.every((c) => !blocked.has(c))) for (const c of across) possible.add(c);
      if (down.every((c) => !blocked.has(c))) for (const c of down) possible.add(c);
    }
  }
}
