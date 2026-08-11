/**
 * Where a draggable panel sits, and the maths that keeps it somewhere usable.
 *
 * Stored as FRACTIONS of the canvas (0-1), never pixels. A layout saved on a 2560px ultrawide has
 * to still make sense on a 1366px laptop - and it has to survive the player simply resizing their
 * window mid-match, which pixel coordinates cannot. Everything converts to px at render time
 * against the measured canvas, so the same numbers describe the same arrangement at any size.
 *
 * Generic over the panel id set, because two screens now use this: the match canvas (a fixed five
 * panels, see matchLayout) and the spectator canvas (one panel per fleet on show, so its id set and
 * its defaults both depend on how many teams are in the room - see spectatorLayout).
 */
export interface PanelBox {
  /** Left edge, as a fraction of canvas width. */
  x: number;
  /** Top edge, as a fraction of canvas height. */
  y: number;
  w: number;
  h: number;
  /**
   * Stacking order, 1..n, unique across the layout - who covers whom when panels overlap.
   *
   * Kept normalised to a dense 1..n range rather than letting "bring to front" climb forever,
   * so a layout that has been rearranged a few hundred times still serialises to small integers
   * and still means the same thing when it's read back.
   */
  z: number;
}

export type PanelLayout<Id extends string> = Record<Id, PanelBox>;

/** Smallest a panel may be dragged, as a fraction. Below this a board is unreadable anyway. */
const MIN_W = 0.08;
const MIN_H = 0.06;

/**
 * Forces a box back inside the canvas.
 *
 * Runs on every drag and on load, not just on save. A layout is stored in fractions, so a window
 * that got NARROWER since the layout was saved can leave a panel partly outside - and a panel whose
 * header is off-screen can never be grabbed again. Clamping on read is what makes that
 * unrecoverable state impossible rather than merely unlikely.
 */
export function clampBox(box: PanelBox): PanelBox {
  const w = Math.min(1, Math.max(MIN_W, box.w));
  const h = Math.min(1, Math.max(MIN_H, box.h));
  // Spread first so z (which has nothing to do with the canvas bounds) survives a clamp.
  return {
    ...box,
    w,
    h,
    x: Math.min(1 - w, Math.max(0, box.x)),
    y: Math.min(1 - h, Math.max(0, box.y)),
  };
}

/**
 * Re-labels every panel's z to a dense 1..n, preserving their current relative order.
 *
 * Run after every restack so "bring to front" can be a naive max+1 without the numbers climbing
 * forever, and so a layout saved before z existed comes back with a clean stack rather than n
 * panels all claiming the same level.
 */
export function normaliseZ<Id extends string>(ids: Id[], layout: PanelLayout<Id>): PanelLayout<Id> {
  const order = [...ids].sort(
    // Ties broken by id-list position, so the result is deterministic rather than
    // sort-implementation-dependent when two panels share a z.
    (a, b) => layout[a].z - layout[b].z || ids.indexOf(a) - ids.indexOf(b)
  );
  const out = {} as PanelLayout<Id>;
  order.forEach((id, i) => {
    out[id] = { ...layout[id], z: i + 1 };
  });
  return out;
}

/** Moves one panel to the top or the bottom of the stack, leaving the others' order intact. */
export function restack<Id extends string>(
  ids: Id[],
  layout: PanelLayout<Id>,
  id: Id,
  to: "front" | "back"
): PanelLayout<Id> {
  const zs = ids.map((p) => layout[p].z);
  const z = to === "front" ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
  return normaliseZ(ids, { ...layout, [id]: { ...layout[id], z } });
}

/** The four fractions every stored box must have. z is optional - see parseOverrides. */
function isBox(v: unknown): v is PanelBox {
  const b = v as PanelBox;
  return (
    !!b &&
    typeof b.x === "number" &&
    typeof b.y === "number" &&
    typeof b.w === "number" &&
    typeof b.h === "number" &&
    [b.x, b.y, b.w, b.h].every(Number.isFinite)
  );
}

/**
 * Rebuilds the panels a player has actually moved, from stored JSON.
 *
 * Per-panel rather than all-or-nothing on purpose: adding a sixth panel later must not throw away
 * the five the player already arranged. Anything missing or malformed is simply absent from the
 * result, which leaves it on whatever default the caller computes for it.
 *
 * Overrides rather than a whole layout because the spectator canvas has no fixed default: its
 * boards are tiled to fit however many fleets are on show, so a stored copy of every panel would
 * freeze a two-fleet arrangement onto a four-fleet match. Storing only what was dragged means an
 * untouched panel keeps following the room.
 */
export function parseOverrides<Id extends string>(raw: string | null): Partial<PanelLayout<Id>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<Record<Id, unknown>>;
    const out: Partial<PanelLayout<Id>> = {};
    // Every stored key, not just the ones on screen right now: the spectator canvas shows a
    // different subset per mode, and filtering to the current one would quietly forget where a
    // caster had parked a board the moment they looked at a single fleet instead of all of them.
    for (const id of Object.keys(parsed ?? {}) as Id[]) {
      const stored = parsed?.[id];
      if (!isBox(stored)) continue;
      // z is treated as optional for the same reason the rest is per-panel: layouts saved before
      // panels could be restacked have no z at all, so they inherit the default level and
      // normaliseZ tidies the result into a stack.
      out[id] = clampBox({ ...stored, z: Number.isFinite(stored.z) ? stored.z : 1 });
    }
    return out;
  } catch {
    return {};
  }
}

/** Defaults with the player's own boxes laid over the top, stacked into a dense 1..n order. */
export function mergeLayout<Id extends string>(
  ids: Id[],
  defaults: PanelLayout<Id>,
  overrides: Partial<PanelLayout<Id>>
): PanelLayout<Id> {
  const out = {} as PanelLayout<Id>;
  for (const id of ids) out[id] = overrides[id] ?? defaults[id];
  return normaliseZ(ids, out);
}
