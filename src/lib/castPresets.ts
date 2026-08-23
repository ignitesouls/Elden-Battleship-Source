/**
 * Saved framings for the caster's board - a zoom and a centre, recalled in one press.
 *
 * -- Why these exist --
 *
 * Aiming is a gesture, and the aim pad is good at continuous movement: follow a fleet, step across,
 * nudge back. What it is bad at is RETURNING. A caster who has been talking about the north-east
 * corner, cut away to a fight in the south-west, and now wants the corner back has to re-find it by
 * hand, on air, while talking - and the pan is smooth precisely so it cannot be thrown to an exact
 * spot quickly. Four slots turn "where was I" into a keypress.
 *
 * -- Why per room --
 *
 * A framing is a set of squares, and the squares are dealt per room (see challengesForRoom). The
 * same centre in tomorrow's match is a different part of a different board, so a global preset
 * would recall a position that means nothing - worse than having none, because it looks deliberate.
 * Keyed by room code, which is what the caster is looking at anyway.
 *
 * -- Why localStorage and not the profile --
 *
 * This is desk furniture, set up in the minutes before a match by whoever is sitting at that
 * machine, and thrown away with the room. It has none of the properties that would justify a column
 * and a migration: nobody needs it on a second device, nobody needs it after the match, and losing
 * it costs four presses. The match canvas layout is stored the same way and for the same reasons.
 */

/** What one slot remembers: everything about the framing, and nothing about the match. */
export interface Preset {
  zoom: number;
  cx: number;
  cy: number;
}

/**
 * Four, and not more.
 *
 * They are recalled by a modifier plus a digit, and the digits 1-9 are already the aim pad - so
 * these live on Shift and want to stay inside one hand's reach without looking down. Four also
 * happens to be the number of quadrants on a board, which is what most of them will be.
 */
export const PRESET_SLOTS = 4;

const key = (code: string) => `cast-presets:${code.toUpperCase()}`;

/** An empty rack, which is also what every failure below falls back to. */
function empty(): (Preset | null)[] {
  return Array.from({ length: PRESET_SLOTS }, () => null);
}

function valid(p: unknown): p is Preset {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.zoom === "number" &&
    typeof o.cx === "number" &&
    typeof o.cy === "number" &&
    Number.isFinite(o.zoom) &&
    Number.isFinite(o.cx) &&
    Number.isFinite(o.cy)
  );
}

/**
 * Reads a room's rack.
 *
 * Every way this can go wrong ends at an empty rack rather than at a throw: storage disabled by the
 * browser, a quota error, JSON left by an older shape of this feature, or a hand-edited value. None
 * of those are worth taking a caster's desk down for - the cost of getting it wrong is four presets
 * the caster sets again, and the cost of throwing is a blank page mid-match.
 */
export function castPresets(code: string | undefined) {
  const read = (): (Preset | null)[] => {
    if (!code) return empty();
    try {
      const raw = localStorage.getItem(key(code));
      if (!raw) return empty();
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return empty();
      // Rebuilt slot by slot rather than trusted wholesale, so a stored array of the wrong length -
      // which is what a change to PRESET_SLOTS leaves behind - still yields a usable rack.
      return Array.from({ length: PRESET_SLOTS }, (_, i) => (valid(parsed[i]) ? (parsed[i] as Preset) : null));
    } catch {
      return empty();
    }
  };

  const write = (slots: (Preset | null)[]) => {
    if (!code) return;
    try {
      localStorage.setItem(key(code), JSON.stringify(slots));
    } catch {
      // Full, or storage denied. The rack still works for this session; it just won't outlive it.
    }
  };

  return { read, write };
}
