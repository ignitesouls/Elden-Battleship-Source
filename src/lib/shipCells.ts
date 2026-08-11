import type { ShipPlacement } from "../types/battleship";

/**
 * Expands placements into the flat set of cell indices those hulls occupy.
 *
 * Deliberately its own module rather than living beside the fetch that uses it: this is pure
 * coordinate maths with no need of a configured Supabase client, and keeping it separable is what
 * lets it be tested directly.
 *
 * The overlay draws ship presence per cell rather than per hull - at the ~20px cells a stream
 * overlay can afford, a footprint outline is what reads, not a sprite.
 */
export function shipCellIndices(
  placements: ShipPlacement[],
  shipSizes: number[],
  boardSize: number
): Set<number> {
  const cells = new Set<number>();
  for (const p of placements) {
    const size = shipSizes[p.shipIndex];
    if (!size) continue;
    for (let n = 0; n < size; n++) {
      const row = p.isHorizontal ? p.startRow : p.startRow + n;
      const col = p.isHorizontal ? p.startCol + n : p.startCol;
      // Bounds-checked per axis before flattening. Checking only the final index would let a hull
      // running off the right edge wrap onto the start of the next row.
      if (row < 0 || col < 0 || row >= boardSize || col >= boardSize) continue;
      cells.add(row * boardSize + col);
    }
  }
  return cells;
}
