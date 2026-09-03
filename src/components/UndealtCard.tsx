import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { clampToViewport, useFloatPos, type FloatPos } from "../hooks/useFloatPos";
import type { Challenge } from "../lib/challenges";
import "./UndealtCard.css";

interface Props {
  /** What the deal left in the pack. Never rendered empty - see the guard below. */
  squares: Challenge[];
  /** How many squares the set holds in total, so the card can say ten OF WHAT. */
  pool: number;
  open: boolean;
  onClose: () => void;
}

/** Shared by the player's match screen and the spectator page, so one drag settles it everywhere. */
const POS_KEY = "eb_undealt_pos";

/**
 * Where the card sits before anybody has moved it: near the top-left, clear of the top bar.
 *
 * Roughly where it used to be pinned - over the fire board's upper-left corner on a match screen,
 * over the leftmost fleet's on a spectator's - so somebody who liked it there has nothing to do.
 * The point of the drag is that this is now only a starting position and not the only one.
 */
const DEFAULT_POS: FloatPos = { x: 0.015, y: 0.14 };

/**
 * The squares this board hasn't got: a floating card naming everything the deal left in the pack.
 *
 * Worth showing at all only because the big boards nearly exhaust their set - a 14x14 boss board is
 * 196 of 206, so ten bosses sit this one out. That is a short enough list to be read once and
 * remembered, and it answers a question crews were otherwise answering by scanning the whole board
 * twice: "is Malenia even on here?". lib/undealt.ts decides which boards are close enough to their
 * ceiling to be asked; this only draws the answer.
 *
 * -- Why it floats over the page rather than sitting in the board's corner ------------------------
 *
 * It began pinned to the fire board's top-left, as an annotation on the board it describes. The
 * trouble with that is the same thing that made it worth pinning: the list is read alongside the
 * board, and a card anchored inside the board covers ten or fifteen of the squares somebody is
 * trying to read it against. Whichever corner it takes is a corner of the game.
 *
 * So it is portalled to the body and fixed to the viewport, dragged by its header to anywhere on
 * screen - including well clear of the board, over a sidebar or the dock. That also makes it one
 * card rather than one per layout: the match screen draws its board twice (canvas and fixed), the
 * spectator page draws one per fleet on show, and a card anchored to a board would have had to pick
 * one of them. Position is remembered per browser (see useFloatPos), because where you like it is a
 * preference and not a per-match decision.
 *
 * Open on arrival, and closed from the ✕ or from the toggle in the bar - the tab that used to sit in
 * the board's corner went with the anchoring, since a card that floats has no corner to return to.
 * See UndealtToggle.
 *
 * Whether it is open is deliberately NOT remembered across matches. Every board leaves out a
 * different ten, so a dismissal is a statement about this board and not a preference about the
 * feature - persisting it would mean somebody who closed the card once never sees the list again on
 * any board. See useStoredToggle for the general version of that argument.
 */
export function UndealtCard({ squares, pool, open, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // `place` is a drag and is remembered; `nudge` is this code putting the card back within reach and
  // deliberately isn't - see useFloatPos. `placed` is what was chosen, which is what a resize has to
  // aim at rather than at wherever the last correction left it.
  const { pos, placed, place, nudge } = useFloatPos(POS_KEY, DEFAULT_POS);

  /**
   * The box as it was when the drag started. Deltas apply to THIS rather than to the live position,
   * for the reason spelled out in CanvasPanel: reading the live value back on every move compounds
   * rounding, and a fast drag creeps away from the cursor.
   */
  const start = useRef<{ pos: FloatPos; x: number; y: number } | null>(null);

  /** The chosen position, for the listener below - it is subscribed once and would read it stale. */
  const placedRef = useRef(placed);
  placedRef.current = placed;

  // Once there is an element to measure, put it somewhere it can actually be grabbed. Covers a
  // position saved on a wider window, and the very first render at the default - a fraction picked
  // without knowing how big the card would turn out to be. Re-run on the list's length because that
  // is what decides the card's height, and the height is half of what is being clamped.
  useLayoutEffect(() => {
    if (!open) return;
    const fixed = clampToViewport(placedRef.current, cardRef.current);
    if (fixed.x !== pos.x || fixed.y !== pos.y) nudge(fixed);
  }, [open, nudge, pos.x, pos.y, squares.length]);

  // A window that gets narrower can leave a parked card with its header off screen, and a header
  // off screen can never be grabbed again - the same unrecoverable state clampBox exists to prevent
  // for the panels. Aimed at the CHOSEN position rather than the current one, so widening the window
  // again returns the card to the corner it was put in.
  useEffect(() => {
    if (!open) return;
    const onResize = () => nudge(clampToViewport(placedRef.current, cardRef.current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, nudge]);

  function begin(e: React.PointerEvent) {
    // Left button only: a right-click on the header shouldn't start dragging it.
    if (e.button !== 0) return;
    e.preventDefault();
    // setPointerCapture is what makes the drag survive the cursor outracing the card - without it,
    // moving fast enough to leave the header silently drops the gesture.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { pos, x: e.clientX, y: e.clientY };
  }

  function move(e: React.PointerEvent) {
    const s = start.current;
    if (!s) return;
    place(
      clampToViewport(
        {
          x: s.pos.x + (e.clientX - s.x) / (window.innerWidth || 1),
          y: s.pos.y + (e.clientY - s.y) / (window.innerHeight || 1),
        },
        cardRef.current
      )
    );
  }

  function end(e: React.PointerEvent) {
    start.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  if (squares.length === 0 || !open) return null;

  return createPortal(
    /*
      Portalled to <body> for the reason the board's tooltip is: position: fixed escapes CLIPPING,
      but not stacking. Both canvases give every panel a z-index and so open a stacking context, and
      a card rendered inside one could never be dragged out over its neighbours. At body level it
      competes with the panels directly, which is what a floating window should do.
    */
    <div
      className="undealt"
      ref={cardRef}
      style={{ left: `${pos.x * 100}vw`, top: `${pos.y * 100}vh` }}
      // A region rather than a dialog: nothing here is modal, nothing is waiting on an answer, and
      // announcing it as a dialog would tell a screen reader the page behind it had stopped.
      role="region"
      aria-label="Squares not on this board"
    >
      <div
        className="undealt-head"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span className="undealt-title">Not on this board</span>
        <span className="undealt-sub">
          {squares.length} of {pool}
        </span>
        {/* stopPropagation because the header it sits in is the drag handle - without it, pressing
            close also starts moving the card. */}
        <button
          className="undealt-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          // Not "the bar below": the match screen's is under the canvas and the spectator page's is
          // over the boards, and naming the button is the one direction that is true on both.
          title="Hide - reopen with the 'not dealt' button"
          aria-label="Hide"
        >
          ✕
        </button>
      </div>
      <ul className="undealt-list">
        {squares.map((c) => (
          // Keyed on the name because that is what a flat set's squares are unique by - the same
          // property buildFlatBoard leans on to never deal one twice.
          <li key={c.name} className="undealt-item">
            {/* The full form, not the board's abbreviation: nothing here is sitting on a square you
                could hover, so the card is the only place it gets spelled out. See squareTitle. */}
            {c.title ?? c.name}
          </li>
        ))}
      </ul>
    </div>,
    document.body
  );
}

/**
 * The card's switch, for the bars: the match dock, the fixed layout's sidebar and the spectate bar.
 *
 * A control in the furniture rather than a tab over the board, which is what the card's own corner
 * tab used to be. Once the card floats there is no corner that belongs to it, and a tab left pinned
 * to the board would have gone on covering squares to advertise a card that no longer does.
 *
 * Renders nothing when there is nothing to name - a board with a cell for every square in its set,
 * or a set this was never offered on at all (see undealtOffered). A button whose only outcome is an
 * empty card is worse than no button.
 */
export function UndealtToggle({
  count,
  open,
  onToggle,
  className,
  style,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  className?: string;
  /** So each bar can keep its own type size - the dock, the sidebar and the spectate bar differ. */
  style?: CSSProperties;
}) {
  if (count === 0) return null;

  return (
    <button
      type="button"
      className={className}
      onClick={onToggle}
      // A state rather than an action, so it carries the accent and aria-pressed - the same shape as
      // the dead-water and rail toggles it sits beside.
      style={{ ...style, borderColor: open ? "var(--accent)" : style?.borderColor }}
      title="Name the squares this board's deal left in the pack. Drag the card by its title to move it."
      aria-pressed={open}
    >
      {count} not dealt
    </button>
  );
}
