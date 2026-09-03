import { useCallback, useState } from "react";

/**
 * Where a free-floating card sits: its top-left corner, as FRACTIONS of the viewport.
 *
 * Fractions for the same reason the draggable panels store fractions of their canvas (see
 * lib/panelLayout) - a position saved on a 2560px ultrawide has to still mean something on a 1366px
 * laptop, and has to survive the window being resized mid-match. The difference is that a panel
 * scales with its canvas in both axes, while a card like this keeps a fixed pixel size and only its
 * POSITION scales - which is why it needs the measured clamp below and a panel doesn't.
 */
export interface FloatPos {
  x: number;
  y: number;
}

/**
 * Forces a card fully back onto the screen.
 *
 * Measured against the real element rather than clamped to 0..1, because the fraction says where
 * the card's top-left goes and the card has width: a card at x = 0.98 is a sliver of border in the
 * corner with its header - the only thing you can grab it by - off the screen entirely. Run on drag
 * and on window resize, so shrinking the window drags a parked card back into reach instead of
 * stranding it.
 *
 * A card taller or wider than the viewport pins to the top-left rather than being pushed negative:
 * Math.max(0, ...) on the bound is what keeps the header reachable in that case, since the header
 * is at the card's top edge and the overflow hangs off the bottom.
 */
export function clampToViewport(pos: FloatPos, el: HTMLElement | null): FloatPos {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const maxX = Math.max(0, vw - (el?.offsetWidth ?? 0));
  const maxY = Math.max(0, vh - (el?.offsetHeight ?? 0));
  return {
    x: Math.min(maxX, Math.max(0, pos.x * vw)) / vw,
    y: Math.min(maxY, Math.max(0, pos.y * vh)) / vh,
  };
}

/**
 * A floating card's remembered position.
 *
 * Persisted, and per browser rather than per room - where somebody likes a card to sit is a
 * preference about how they read the screen, exactly like the panel layout, and re-parking it every
 * match would be the sort of small friction that makes a feature feel like it is in the way. Note
 * that this is the opposite call from whether such a card is OPEN, which is per match: see the note
 * on UndealtCard for why a dismissal there is a statement about one board and not a preference.
 *
 * -- Why moving the card and correcting it are two different functions -----------------------------
 *
 * `place` is somebody dragging the card, and is written down. `nudge` is this code shoving it back
 * on screen because the window got smaller, and is not - it moves the card for now and leaves the
 * stored preference alone.
 *
 * That split is the rule set out at length in useStoredToggle, applied to a position: only a real
 * choice may be persisted, because a stored value that nobody chose cannot afterwards be told apart
 * from one that somebody did. It also buys the behaviour you actually want out of a resize - park
 * the card bottom-right, drag the window narrow, and it steps aside; widen the window again and it
 * goes back to the corner you put it in, rather than staying wherever the narrow window left it.
 */
export function useFloatPos(key: string, fallback: FloatPos) {
  /**
   * The remembered position - what was chosen, not necessarily what is on screen. Kept alongside
   * `pos` rather than re-read from storage so a resize can restore it without touching localStorage.
   */
  const [placed, setPlaced] = useState<FloatPos>(() => read(key, fallback));
  const [pos, setPos] = useState<FloatPos>(placed);

  /** A drag. The card moves and the choice is written down. */
  const place = useCallback(
    (next: FloatPos) => {
      setPlaced(next);
      setPos(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode or quota. A card that forgets where it was put is a nuisance, not a broken
        // match - the same call usePanelLayout makes about the layout itself.
      }
    },
    [key]
  );

  /** A correction. The card moves; nothing is written, so the choice above survives it. */
  const nudge = useCallback((next: FloatPos) => setPos(next), []);

  return { pos, placed, place, nudge };
}

/** Absent, malformed or non-finite all mean absent, and hand back the caller's default. */
function read(key: string, fallback: FloatPos): FloatPos {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Partial<FloatPos>;
    if (!Number.isFinite(stored?.x) || !Number.isFinite(stored?.y)) return fallback;
    // Only the cheap 0..1 clamp here: there is no element to measure until the card has rendered,
    // so the measured one runs in a layout effect straight afterwards.
    return { x: Math.min(1, Math.max(0, stored.x as number)), y: Math.min(1, Math.max(0, stored.y as number)) };
  } catch {
    return fallback;
  }
}
