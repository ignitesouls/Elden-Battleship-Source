import { useCallback, useRef, useState } from "react";

/**
 * An element's live content-box size in pixels.
 *
 * For layouts that have to fit a viewport exactly rather than approximately. CSS can express "this
 * board is at most 60vh" but not "this board is at most whatever is left after a toolbar that wraps
 * onto a second row on some monitors and not others" - and that gap is the whole reason a page
 * overflows on one screen and not another. Measuring the container answers it at any size.
 *
 * -- Why this is a callback ref and not a useRef + useEffect --
 *
 * It used to attach the observer from an effect with an empty dependency list, which silently
 * measured NOTHING on any page that renders the element later than its first render. Both overlay
 * pages and the caster's desk do exactly that: they `return null` (or a "no such room" card) until
 * useRoom has loaded, so at the moment the effect ran, the element being measured did not exist -
 * and with no dependencies the effect never ran again once it appeared.
 *
 * The result was a size stuck at 0x0 forever. On the caster's monitor that put placeBoard at half
 * the frame, parking the board in the bottom-right corner with most of it cropped; on the board
 * source it made every pan offset zero, so zooming past 1x moved nothing. Neither looked like a
 * measurement bug from the outside, which is why both survived so long.
 *
 * A callback ref is called by React whenever the node is attached, however late that is.
 */
export function useBoxSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const observed = useRef<{ el: T; ro: ResizeObserver } | null>(null);

  const ref = useCallback((el: T | null) => {
    // Stable identity (empty deps) means React only calls this on a real attach/detach, but guard
    // anyway - re-observing the same node would leak an observer per call.
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el) return;

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Bail on an unchanged box: a ResizeObserver that setStates unconditionally can re-enter
      // through its own layout effects.
      setSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    });
    ro.observe(el);
    observed.current = { el, ro };
  }, []);

  return [ref, size] as const;
}

/**
 * The largest square board that fits a grid cell, given how many boards share the stage.
 *
 * Returns a pixel length for BoardGrid's maxVh/maxVw, which already collapse to
 * `min(maxVh, maxVw, 1600px)` - so handing both the same number asks for exactly that square.
 * Boards are laid out at most two across, because three side by side on a 16:9 screen are each
 * shorter than half the height they could have had.
 */
export function boardSideFor(stage: { w: number; h: number }, count: number, gap = 12, labelPx = 18) {
  if (count === 0 || stage.w === 0 || stage.h === 0) return 0;
  const cols = Math.min(2, count);
  const rows = Math.ceil(count / cols);
  const slotW = (stage.w - gap * (cols - 1)) / cols;
  // Each board carries a caption above its grid, which eats into the height available to the square.
  const slotH = (stage.h - gap * (rows - 1)) / rows - labelPx;
  return Math.max(0, Math.floor(Math.min(slotW, slotH)));
}

/** Column count that boardSideFor assumed, so the CSS grid and the maths can't disagree. */
export function boardColumns(count: number) {
  return Math.max(1, Math.min(2, count));
}
