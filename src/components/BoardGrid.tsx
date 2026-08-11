import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shipArtUrl } from "../lib/shipArt";
import type { Region } from "../lib/challenges";
import "./BoardGrid.css";
import {
  HitMark,
  MissMark,
  SunkMark,
  RuledOutMark,
  WhaleMark,
  LaboonMark,
  TentacleMark,
  DutchmanMark,
  BottleMark,
  JarMark,
  PatchesMark,
} from "./HitMarkers";
import { fitText, useTextFit, breakSegments } from "../lib/textFit";
import type { MarkKind } from "../hooks/usePencilMarks";
import type { DeepMark } from "../lib/deepWater";

export type CellVisual =
  | "empty"
  | "ship"
  | "hit"
  | "miss"
  | "sunk"
  | "preview-valid"
  | "preview-invalid";

/**
 * One crewmate's tally on one square, ready to draw.
 *
 * Deliberately carries no name. An abbreviation short enough to fit beside a two-digit number in a
 * square is too short to be reliably distinct - "Gameglorp" and "Gary" are both GA - and the fix
 * for that (escalating to unique prefixes across the fleet) buys a label that is still a puzzle to
 * read at speed. Position and colour say whose is whose instead, and the tooltip has room for the
 * actual names.
 */
export interface SquareCount {
  tally: number;
  /** The local player's own, drawn in the accent colour and sorted first. */
  mine?: boolean;
  /** Who counted it, for the square's tooltip where there is room to spell it out. */
  fullName: string;
}

/**
 * How many tallies a square prints.
 *
 * Three, and no "+n" past that: a fourth counter on one square is rare, the marker cost a slot that
 * a real number could have used, and the square's tooltip lists everyone anyway. Yours is always
 * one of the three - it sorts first - so what can be dropped is only ever the crewmates with the
 * lowest tallies.
 */
const MAX_COUNT_CHIPS = 3;

export interface ShipOverlay {
  row: number;
  col: number;
  size: number;
  horizontal: boolean;
  shipName: string;
  colorHex: string;
}

interface BoardGridProps {
  boardSize: number;
  cellVisual: (index: number) => CellVisual;
  onCellClick?: (index: number) => void;
  onCellHover?: (index: number) => void;
  onMouseLeave?: () => void;
  disabled?: boolean;
  label?: string;
  ships?: ShipOverlay[];
  /** Cell index -> sunk ship orientation, so the fire/smoke marker rotates to match the hull. */
  sunkOrientation?: Map<number, boolean>;
  /**
   * Which edges carry the A-J / 1-10 labels. "start" (default) is top and left; "all" repeats them
   * along the bottom and right.
   *
   * Opt-in because it costs a gutter on two more sides, which a player's board - sharing a screen
   * with a fleet roster, a log and a clock - can't spare. The stream board can: it is the only
   * thing in its source, and it is being read by people who cannot point at it. On a 10x10 the
   * distance from a square in the middle to the nearest label is halved, and a caster saying "D7"
   * is understood without anyone tracing a line across the whole board.
   */
  coordEdges?: "start" | "all";
  /**
   * Caps grid height. A number is read as a percentage of viewport height; a string is used as a
   * raw CSS length, which is what you want for a board meant to fill the window - `100vh` alone
   * always overflows, because it doesn't know about the page's padding or this board's own label.
   * Pass e.g. "calc(100vh - 5.5rem)" to subtract that chrome in units that don't scale with the
   * viewport (a fixed vh number can only ever be correct at one window height).
   */
  maxVh?: number | string;
  /** Caps grid width. Number = percentage of viewport width (e.g. ~48 for half the screen). */
  maxVw?: number | string;
  /** Text drawn inside each cell (the challenge). Omit for a plain board. */
  cellText?: (index: number) => { label: string; title?: string; region?: Region; color?: string } | null;
  /**
   * Client-local marks made by hand (right-click). Purely cosmetic, never sent anywhere.
   * "guess" pins a square as worth a look; "ruled" is a legacy cross - see usePencilMarks.
   */
  markedCells?: ReadonlyMap<number, MarkKind>;
  onToggleMark?: (index: number, kind: MarkKind) => void;
  /**
   * Squares the board itself has worked out can't hold anything (see lib/deduction).
   *
   * Kept separate from the hand-made marks because it's derived rather than stored: it has to
   * disappear the moment the toggle goes off, which a mark a player made must not. Both draw the
   * same red X, because they're saying the same thing about the square.
   */
  autoRuledCells?: ReadonlySet<number>;
  /**
   * Per-square tallies, nudged with the mouse wheel and shared with the rest of the fleet.
   * Omit onCount to leave the wheel alone entirely - boards without it still scroll normally.
   */
  counts?: Map<number, SquareCount[]>;
  onCount?: (index: number, delta: number) => void;
  /**
   * Fill the parent exactly, at whatever shape the parent happens to be, instead of sizing to a
   * square derived from maxVh/maxVw. Used by the match canvas, where the player owns the size.
   *
   * This is the one mode where cells can be non-square, which the prop-derived font maths can't
   * describe - so it measures instead. See the ResizeObserver below.
   */
  fill?: boolean;
  /**
   * What has been found hiding in the water, keyed by square - the whale, Laboon, Cthulhu's tentacles
   * (see lib/deepWater.ts). Each is drawn in place of that square's miss marker.
   *
   * Build it with `deepMarks`, which is where the rule about who may see what lives. Empty in most
   * matches, because most of this is never found.
   */
  deepCells?: ReadonlyMap<number, DeepMark>;
  /**
   * Require a press-and-hold of this many milliseconds before onCellClick fires. Omit (or 0) for
   * an instant click, which is what every board except the fire board wants.
   *
   * A shot cannot be taken back - it leaks the square's contents, wounds a hull and is broadcast to
   * every spectator the moment it lands - so the fire board is the one place where the cost of a
   * slipped click is worth paying a few hundred milliseconds to avoid. Placement is not: a
   * misplaced ship can simply be picked up again.
   *
   * The length is the player's own choice (see lib/fireHold), which is why this is a duration and
   * not a boolean.
   */
  holdToFireMs?: number;
  /**
   * Draw the square names larger (or smaller) than the board would choose for itself, as a
   * multiplier. Omit on any board somebody is sitting in front of.
   *
   * Exists for the stream sources, where the size a square can hold is not the size a viewer can
   * read - see lib/overlayText. It only moves the ceiling the fit searches down from, so a board
   * asked for more than its squares have room for simply draws what fits.
   */
  textBoost?: number;
  /**
   * Hard ceiling on a square's font size, overriding the per-layout defaults below.
   *
   * The defaults are sized for somebody a foot from a monitor. A browser source is read through an
   * encoder by people who are not, and its cells are far larger than any in the app, so it sets its
   * own - see OverlayBoard.
   */
  maxCellFont?: number;
}

const COL_LETTERS = "ABCDEFGHIJKLMNOPQR";

/**
 * How far to shrink one square's text so it fits, as a multiplier on the grid's font size.
 *
 * A rough guess from the name's length, used for the single render before the cell has been
 * measured. Everything after that goes through lib/textFit, which measures the name against the
 * real board face rather than counting characters - see the note there for why guessing wasn't
 * good enough.
 */
function fitFactor(label: string): number {
  const BASELINE = 24; // characters the grid font already sizes comfortably
  const LONGEST_WORD = 11;
  const longest = label.split(/\s+/).reduce((max, w) => Math.max(max, w.length), 0);

  const byTotal = label.length <= BASELINE ? 1 : Math.sqrt(BASELINE / label.length);
  const byWord = longest <= LONGEST_WORD ? 1 : LONGEST_WORD / longest;

  return Math.max(0.6, Math.round(Math.min(byTotal, byWord) * 100) / 100);
}

/** Lines that first unmeasured render allows itself. Same estimate, same one render. */
function lineBudget(fit: number): number {
  return Math.min(12, Math.max(4, Math.floor(5.7 / fit)));
}

/**
 * Ceiling on a square's font size, per layout.
 *
 * The fixed layout's board is sized off the viewport and its cells get very large on a big monitor -
 * 17px is where a boss name stops looking like a label and starts looking like a headline. On the
 * canvas the player chose the panel's size, so the cap only exists to stop a one-word name filling
 * a square someone dragged enormous.
 */
const MAX_FONT_FIXED = 17;
const MAX_FONT_FILL = 30;

/**
 * How much of its grid area a hull sprite fills, leaving a margin off the grid lines.
 *
 * Applied to the inner box, per axis, rather than as a margin on the area itself - percentage
 * margins are width-relative on all four edges, which made the gap above and below a hull scale
 * with the ship's LENGTH. See .bg-ship-overlay.
 */
const HULL_FIT = 0.92;

/** The grid line between two cells. Must match `gap` in .bg-grid - a hull spans these as well as cells. */
const GRID_GAP = 2;

export function BoardGrid({
  boardSize,
  cellVisual,
  onCellClick,
  onCellHover,
  onMouseLeave,
  disabled,
  label,
  ships,
  sunkOrientation,
  coordEdges = "start",
  maxVh = 82,
  maxVw = 92,
  cellText,
  markedCells,
  onToggleMark,
  autoRuledCells,
  counts,
  onCount,
  fill,
  deepCells,
  holdToFireMs,
  textBoost = 1,
  maxCellFont,
}: BoardGridProps) {
  // Numbers keep the original "percentage of the viewport" shorthand; strings pass through as raw
  // CSS so a caller can subtract fixed page chrome with calc().
  const vhLimit = typeof maxVh === "number" ? `${maxVh}vh` : maxVh;
  const vwLimit = typeof maxVw === "number" ? `${maxVw}vw` : maxVw;

  // One decision for the whole board: can these squares be pressed at all? Read by the hold gesture
  // below as well as by the cells themselves, which is why it is derived this early.
  const interactive = !disabled && Boolean(onCellClick);

  // Whether a press has to be held, and for how long. Zero is a real choice ("instant"), and means
  // the same thing as the prop being absent.
  const holdMs = interactive && holdToFireMs && holdToFireMs > 0 ? holdToFireMs : 0;

  // Tracked locally (in addition to the onCellHover/onMouseLeave callbacks, which callers use
  // for their own purposes like ship-placement preview) so the row/column axis shadow works on
  // every board without every caller having to wire up hover state themselves.
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hoverRow = hoverIndex !== null ? Math.floor(hoverIndex / boardSize) : null;
  const hoverCol = hoverIndex !== null ? hoverIndex % boardSize : null;

  // Roving tabindex: exactly one cell is tabbable, and the arrow keys move that focus. Making
  // all 100 cells tab stops would make keyboard traversal of the page useless.
  const [focusIndex, setFocusIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  /**
   * Measured grid size, in fill mode only.
   *
   * The normal path derives the font from maxVh/maxVw, which works precisely because `.bg-grid`
   * sets width and height to that same expression - the board is always square, so one number
   * describes a cell. On the canvas the player can drag the board to any shape, and then cell width
   * and cell height are different numbers doing different jobs: width governs how much text fits on
   * a line, height governs how many lines there is room for. Neither is knowable from a prop, so
   * they get measured.
   *
   * A wide board is genuinely better for long boss names, which is why free aspect is worth having:
   * the same cell area holds more text when it's short and wide, because fewer, longer lines waste
   * less on ragged right edges.
   */
  const [gridBox, setGridBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!fill) {
      setGridBox(null);
      return;
    }
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setGridBox((prev) => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  // Drives --bg-cell-font in fill mode, which is what the tally chips and the coordinate labels
  // scale off. Divides by boardSize alone, ignoring the coordinate gutter: a percent or two of
  // badge size is not worth a second measurement. The square NAMES no longer read this - they're
  // fitted against the measured cellBox below, where a percent or two decides whether they fit.
  const cellW = gridBox ? gridBox.w / boardSize : 0;

  /**
   * One real cell's box, measured off the DOM. Drives the hull geometry and the square names.
   *
   * Deliberately NOT derived from gridBox: that estimate spreads the coordinate gutter and the grid
   * gaps evenly across every cell, which is nowhere near good enough to place a sprite. On a short
   * panel the gutter is a fixed pixel cost against a small total, and the estimate was out by as
   * much as a fifth - enough to hang a hull over the end of its own berth.
   *
   * It's also what the text fitting needs, and the reason it can now be exact on BOTH layouts. The
   * fill path used to fit against the gridBox estimate and the fixed path against a CSS calc that
   * could only ever describe a square cell; one measured box answers both, so a name shrinks the
   * same way whether the board is sized by a panel or by the viewport.
   *
   * Measured on every board, not just `fill` ones, so the two layouts draw identically.
   */
  const [cellBox, setCellBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLElement>('[data-cell="0"]');
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setCellBox((prev) => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [boardSize]);

  // Re-renders this board once the board face itself has loaded, so names measured against the
  // fallback font get re-measured against the real one. Fires once, early. See lib/textFit.
  useTextFit();

  /**
   * The size and line budget for one square's name, or null before the cell has been measured.
   *
   * Null happens for exactly one render - the first, when there is no DOM to observe yet - and the
   * cell falls back to the length estimate for it. Everything after is measured.
   */
  const fitCap = maxCellFont ?? (fill ? MAX_FONT_FILL : MAX_FONT_FIXED);
  const fitFor = (label: string) =>
    cellBox && cellBox.w > 0 && cellBox.h > 0
      ? fitText(label, cellBox.w, cellBox.h, fitCap, textBoost)
      : null;

  /**
   * Wheel-to-count, wired natively rather than with React's onWheel.
   *
   * React registers its root wheel listener as PASSIVE, which means preventDefault() inside an
   * onWheel handler is ignored and the page (or the panel this board sits in) scrolls anyway -
   * so the gesture would work and also throw the board off screen while doing it. A listener
   * added here with { passive: false } is the only way to claim the gesture.
   *
   * Bound once on the grid and resolved to a square via closest(), rather than one listener per
   * cell: a 20x20 board is 400 non-passive listeners otherwise.
   */
  useEffect(() => {
    const el = gridRef.current;
    if (!el || !onCount) return;

    const handler = (e: WheelEvent) => {
      const cell = (e.target as HTMLElement | null)?.closest?.("[data-cell]");
      if (!cell) return;
      const index = Number(cell.getAttribute("data-cell"));
      if (!Number.isInteger(index)) return;
      e.preventDefault();
      // Wheel away from you counts up, which is the direction every stepper control agrees on.
      onCount(index, e.deltaY < 0 ? 1 : -1);
    };

    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [onCount]);

  /**
   * Press-and-hold to fire, when the board asks for it.
   *
   * -- Why the click handler isn't involved --------------------------------------------------------
   *
   * In hold mode the cell's onClick refuses outright and this gesture owns firing completely.
   * Sharing them doesn't work: a completed hold is still followed by a real `click` on release, and
   * an abandoned one - a tap too short to count - produces exactly the same click. One handler would
   * have to tell those apart from a flag, and getting it wrong in either direction is a shot fired
   * by accident, which is the whole thing this exists to prevent.
   *
   * -- Why it isn't captured -----------------------------------------------------------------------
   *
   * setPointerCapture retargets every later pointermove to the captured element, so the pointer
   * would appear to stay on the square it started on no matter where it went - and sliding off a
   * square is the natural "no, not that one". Cancelling on that gesture matters more than tracking
   * a pointer dragged out of the window, which the window-level release listeners below cover
   * anyway.
   *
   * Bound to the grid rather than to each cell, and resolved with closest(), for the reason spelled
   * out on the wheel handler above: a 20x20 board is 400 listeners otherwise.
   */
  /**
   * The live hold, in refs, with the state alongside purely so the cell can draw itself.
   *
   * The refs are the truth and the state is the picture, rather than the other way round, because
   * every one of these listeners is subscribed once and fires from outside React: a value only
   * committed at the next render is a value they would read stale. The window between starting a
   * hold and painting it is exactly where a pointermove or a blur lands, and reading a stale index
   * there cancels the press that just began.
   */
  const [holdIndex, setHoldIndex] = useState<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdIndexRef = useRef<number | null>(null);
  /**
   * Which input started the current hold.
   *
   * Only a keyboard hold ends when its square loses focus. Cancelling every hold on blur looks
   * right and is wrong: pressing one square while another is focused moves focus as a default
   * action of that same press, so the outgoing square's blur would arrive just after the new hold
   * began and kill it.
   */
  const holdSourceRef = useRef<"pointer" | "key" | null>(null);

  // The click callback as of this render, so the listeners below can depend on the hold length
  // alone. onCellClick is usually a fresh closure every render, and an effect that re-subscribed on
  // each one would clear the pending timer mid-press - a hold interrupted by an unrelated re-render
  // (an incoming shot, the clock ticking) would silently never fire.
  const clickRef = useRef(onCellClick);
  useEffect(() => {
    clickRef.current = onCellClick;
  });

  const cancelHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdIndexRef.current = null;
    holdSourceRef.current = null;
    setHoldIndex(null);
  }, []);

  const startHold = useCallback(
    (index: number, source: "pointer" | "key") => {
      if (!holdMs) return;
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      holdIndexRef.current = index;
      holdSourceRef.current = source;
      setHoldIndex(index);
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        holdIndexRef.current = null;
        holdSourceRef.current = null;
        setHoldIndex(null);
        clickRef.current?.(index);
      }, holdMs);
    },
    [holdMs]
  );

  useEffect(() => {
    const el = gridRef.current;
    if (!el || !holdMs) return;

    const cellOf = (el: Element | null | undefined): number | null => {
      const cell = el?.closest?.("[data-cell]");
      if (!cell) return null;
      const index = Number(cell.getAttribute("data-cell"));
      return Number.isInteger(index) ? index : null;
    };

    const onDown = (e: PointerEvent) => {
      // Left button only. Right-click is the pencil mark and middle-click is nothing, and both of
      // them also emit a pointerdown.
      if (e.button !== 0) return;
      const index = cellOf(e.target as Element | null);
      if (index === null) return;
      startHold(index, "pointer");
    };

    /**
     * Sliding off the square you started on abandons the press - the natural "no, not that one".
     *
     * Located by coordinate rather than by the event's target, because a touch pointer is
     * implicitly captured: every pointermove in a touch drag reports the element the finger STARTED
     * on, so a target comparison can never see the finger leave. Only runs while a hold is actually
     * pending, so the hit test costs nothing the rest of the time.
     */
    const onMove = (e: PointerEvent) => {
      if (holdTimerRef.current === null) return;
      if (cellOf(document.elementFromPoint(e.clientX, e.clientY)) !== holdIndexRef.current) cancelHold();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    // Leaving the board entirely, where pointermove stops arriving.
    el.addEventListener("pointerleave", cancelHold);
    // On the window, so a release outside the board - or outside the page - still counts as one.
    window.addEventListener("pointerup", cancelHold);
    window.addEventListener("pointercancel", cancelHold);
    window.addEventListener("blur", cancelHold);

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", cancelHold);
      window.removeEventListener("pointerup", cancelHold);
      window.removeEventListener("pointercancel", cancelHold);
      window.removeEventListener("blur", cancelHold);
      cancelHold();
    };
  }, [holdMs, startHold, cancelHold]);

  const focusCell = useCallback((index: number) => {
    setFocusIndex(index);
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${index}"]`);
    el?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    // Keyboard parity with the pointer hold. Without this, Enter and Space would go on firing
    // instantly via the button's native click - which would leave the safest way to play the game
    // as the one that skips the safeguard.
    if (holdMs && (e.key === "Enter" || e.key === " ")) {
      // Also suppresses the native click a button synthesises from these two keys, which is what
      // stops a completed hold from firing a second time on release.
      e.preventDefault();
      if (!e.repeat) startHold(index, "key");
      return;
    }
    if (holdMs && e.key === "Escape") {
      cancelHold();
      return;
    }

    const row = Math.floor(index / boardSize);
    const col = index % boardSize;
    let next: number | null = null;

    switch (e.key) {
      case "ArrowLeft":
        next = row * boardSize + Math.max(0, col - 1);
        break;
      case "ArrowRight":
        next = row * boardSize + Math.min(boardSize - 1, col + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, row - 1) * boardSize + col;
        break;
      case "ArrowDown":
        next = Math.min(boardSize - 1, row + 1) * boardSize + col;
        break;
      case "Home":
        next = row * boardSize;
        break;
      case "End":
        next = row * boardSize + (boardSize - 1);
        break;
      default:
        return;
    }

    e.preventDefault();
    if (next !== null && next !== index) {
      focusCell(next);
      setHoverIndex(next);
      onCellHover?.(next);
    }
  }

  function handleCellEnter(i: number, e: React.MouseEvent<HTMLButtonElement>) {
    setHoverIndex(i);
    onCellHover?.(i);

    // Counts are appended rather than replacing the square's description: the chips along the
    // bottom are abbreviated to initials and capped at three, so the tooltip is where a full
    // "Marchbanks 4, KC 2" can actually be read.
    const tallies = counts?.get(i) ?? [];
    const parts = [cellText?.(i)?.title, tallies.map((c) => `${c.fullName} ${c.tally}`).join(", ")].filter(Boolean);

    if (parts.length > 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      setTooltip({ text: parts.join(" - "), x: rect.left + rect.width / 2, y: rect.top });
    } else {
      setTooltip(null);
    }
  }

  function handleGridLeave() {
    setHoverIndex(null);
    setTooltip(null);
    onMouseLeave?.();
  }

  const cells = [];
  // Rendered as a separate layer AFTER the ship overlays below, so hit/miss/sunk markers sit
  // in front of a ship sprite instead of getting buried under it.
  const marks = [];
  for (let i = 0; i < boardSize * boardSize; i++) {
    const visual = cellVisual(i);
    const rawRow = Math.floor(i / boardSize);
    const rawCol = i % boardSize;
    const row = rawRow + 2;
    const col = rawCol + 2;
    const text = cellText?.(i);
    const fit = text ? fitFor(text.label) : null;
    const mark = markedCells?.get(i);
    // One cross, from either source. The board's deduction is the only thing that still makes these;
    // a "ruled" mark is a hand-made one left in a player's storage from when middle-click did it, and
    // it draws identically because it means exactly the same thing about the square.
    const ruled = mark === "ruled" || (autoRuledCells?.has(i) ?? false);
    const cellCounts = counts?.get(i) ?? [];
    // Fired at, and so wearing a result colour across the whole cell. This is what forces the name
    // to white - see .bg-cell-text-marked.
    const resolved = visual === "hit" || visual === "miss" || visual === "sunk";
    // Carries anything drawn over the name at all - result, pencil mark or tally - and so needs the
    // marker layer rendered and the name lifted above it. Deliberately NOT the same test as
    // `resolved`: a mark or a counter sits in one corner and leaves the cell's own colour alone, so
    // the region tint stays perfectly legible under it and there is nothing for white to rescue.
    const deep = deepCells?.get(i);
    // Being held counts as annotated so the name lifts clear of the fill sweeping up behind it -
    // reading which square you are about to commit to is the entire point of the pause.
    const holding = holdIndex === i;
    const annotated =
      resolved || Boolean(deep) || Boolean(mark) || Boolean(ruled) || cellCounts.length > 0 || holding;
    // Darken cells to the left of the hovered cell in its row, and above it in its column,
    // to draw the eye out to the row/column labels along the board's edges.
    const axisShadow =
      hoverRow !== null &&
      hoverCol !== null &&
      ((rawRow === hoverRow && rawCol < hoverCol) || (rawCol === hoverCol && rawRow < hoverRow));
    cells.push(
      <button
        key={i}
        type="button"
        data-cell={i}
        className={`bg-cell bg-${visual}${axisShadow ? " bg-cell-axis-shadow" : ""}${
          interactive ? "" : " bg-cell-inert"
        }${cellCounts.length > 0 ? " bg-cell-has-counts" : ""}${holding ? " bg-cell-holding" : ""}`}
        style={{
          gridRow: row,
          gridColumn: col,
          // The fill has to finish exactly when the shot goes, and the player chose how long that
          // is - so the animation's duration comes from the same number as the timer.
          ...(holding ? { ["--bg-hold-ms" as string]: `${holdMs}ms` } : null),
        }}
        // Deliberately NOT the `disabled` attribute: a disabled button emits no mouse events in
        // Chrome, which silently took the hover highlight, the row/column shading and the square
        // tooltip with it on every board you can't fire at. aria-disabled tells assistive tech the
        // same thing, and the click handler below is what actually refuses the press.
        aria-disabled={!interactive}
        tabIndex={i === focusIndex ? 0 : -1}
        aria-label={`${COL_LETTERS[rawCol] ?? rawCol + 1}${rawRow + 1}${text ? ` - ${text.label}` : ""}${
          cellCounts.length > 0 ? ` - ${cellCounts.map((c) => `${c.fullName} ${c.tally}`).join(", ")}` : ""
        }`}
        onClick={() => {
          if (!interactive) return;
          // In hold mode the gesture fires, not the click - see the hold block above for why the
          // two can't share this handler.
          if (holdMs) return;
          onCellClick?.(i);
        }}
        onKeyDown={(e) => handleKeyDown(e, i)}
        onKeyUp={(e) => {
          if (holdMs && (e.key === "Enter" || e.key === " ")) cancelHold();
        }}
        // A square that loses focus mid-hold can never receive the keyup that would end it. Only
        // keyboard holds - see holdSourceRef.
        onBlur={() => {
          if (holdSourceRef.current === "key") cancelHold();
        }}
        onFocus={() => setFocusIndex(i)}
        onMouseEnter={(e) => handleCellEnter(i, e)}
        onContextMenu={(e) => {
          if (!onToggleMark) return;
          e.preventDefault(); // suppress the browser menu so right-click is usable as a game input
          onToggleMark(i, "guess");
        }}
      >
        {text && (
          <span
            className={`bg-cell-text${text.region ? ` bg-region-${text.region}` : ""}${
              annotated ? " bg-cell-text-lifted" : ""
            }${resolved ? " bg-cell-text-marked" : ""}`}
            style={{
              // Sets that tint by keyword have no named class to hang a colour on, so theirs
              // arrives as a hex and is written straight into the same variable the .bg-region-*
              // classes set. One consumer either way, and .bg-cell-text-marked still wins over both
              // because it sets `color` outright rather than the variable behind it.
              ...(text.color ? { ["--bg-region" as string]: text.color } : null),
              ...(fit
                ? // Measured against the real cell and the real font, so the name shrinks to fit
                  // rather than ending in an ellipsis. Both layouts take this path.
                  { fontSize: `${fit.font}px`, ["--bg-cell-lines" as string]: fit.lines }
                : {
                    // First render only, before there's a cell to measure. Falls back to the CSS
                    // clamp, driven by the length estimate.
                    ["--bg-cell-fit" as string]: fitFactor(text.label),
                    ["--bg-cell-lines" as string]: lineBudget(fitFactor(text.label)),
                  }),
            }}
          >
            {/* The name, with a break opportunity offered after each slash.
                <wbr> is markup rather than a character, so the rendered text is still exactly
                text.label - the aria-label above, the tooltip and anything copied off the board are
                untouched. It is the same split the fit measures against, deliberately: see
                breakSegments, which exists because those two disagreeing is what broke names in
                half. */}
            {breakSegments(text.label).map((segment, s) => (
              <Fragment key={s}>
                {s > 0 && <wbr />}
                {segment}
              </Fragment>
            ))}
          </span>
        )}
      </button>
    );

    if (annotated) {
      marks.push(
        <div key={`m${i}`} className="bg-cell-mark-layer" style={{ gridRow: row, gridColumn: col }}>
          {visual === "hit" && <HitMark />}
          {/* Anything found in the water stands in for the splash on its own square rather than
              floating over it - the shot that found it was a miss, so both would otherwise draw
              here at once. */}
          {visual === "miss" && !deep && <MissMark />}
          {visual === "sunk" && <SunkMark horizontal={sunkOrientation?.get(i) ?? true} />}
          {deep === "whale" && <WhaleMark />}
          {deep === "laboon" && <LaboonMark />}
          {(deep === "tentacle" || deep === "sleeper") && <TentacleMark awake={deep === "sleeper"} />}
          {deep === "dutchman" && <DutchmanMark />}
          {deep === "bottle" && <BottleMark />}
          {(deep === "jar" || deep === "jarFree") && <JarMark freed={deep === "jarFree"} />}
          {deep === "patches" && <PatchesMark />}
          {mark === "guess" && <span className="bg-pencil-mark" aria-hidden />}
          {/* Dead water. Drawn across the whole square rather than in a corner like the guess pin,
              because it's a verdict on the square rather than a note about it - and because the
              thing it has to survive being read against is a hundred squares of boss names. */}
          {ruled && <RuledOutMark />}

          {/* Tallies run along the bottom edge, one per crewmate. A team splitting an objective
              square needs to see who has done how much of it, so these stay separate rather than
              being summed into a single number nobody can attribute - yours gold and first, the
              rest neutral in tally order. Past three they collapse into a "+n", and the square's
              tooltip is where the names live. */}
          {cellCounts.length > 0 && (
            <span className="bg-count-strip" aria-hidden>
              {cellCounts.slice(0, MAX_COUNT_CHIPS).map((c) => (
                <span key={c.fullName} className={`bg-count-num${c.mine ? " bg-count-num-mine" : ""}`}>
                  {c.tally}
                </span>
              ))}
            </span>
          )}
        </div>
      );
    }
  }

  /**
   * The A-J and 1-10 labels.
   *
   * `edge` places the same label on the far side of the board: an extra grid track appended after
   * the cells, which shifts nothing, because every cell and hull is positioned from the START of
   * the grid (row/col + 2). So the opposite edges are purely additive.
   */
  const allEdges = coordEdges === "all";
  const lastTrack = boardSize + 2;

  const coord = (key: string, text: string, active: boolean, gridRow: number, gridColumn: number) => (
    <div key={key} className={`bg-coord${active ? " bg-coord-active" : ""}`} style={{ gridRow, gridColumn }}>
      {text}
    </div>
  );

  const colHeaders = Array.from({ length: boardSize }, (_, c) => {
    const text = COL_LETTERS[c] ?? String(c + 1);
    const active = hoverCol === c;
    return (
      <Fragment key={`c${c}`}>
        {coord(`ct${c}`, text, active, 1, c + 2)}
        {allEdges && coord(`cb${c}`, text, active, lastTrack, c + 2)}
      </Fragment>
    );
  });

  const rowHeaders = Array.from({ length: boardSize }, (_, r) => {
    const text = String(r + 1);
    const active = hoverRow === r;
    return (
      <Fragment key={`r${r}`}>
        {coord(`rl${r}`, text, active, r + 2, 1)}
        {allEdges && coord(`rr${r}`, text, active, r + 2, lastTrack)}
      </Fragment>
    );
  });

  return (
    <div className={`bg-wrap${fill ? " bg-wrap-fill" : ""}`}>
      {label && <div className="bg-label">{label}</div>}
      <div className={`bg-grid-scroll${fill ? " bg-grid-scroll-fill" : ""}`}>
        <div
          ref={gridRef}
          className={`bg-grid${fill ? " bg-grid-fill" : ""}`}
          role="grid"
          aria-label={label ?? "Game board"}
          style={{
            gridTemplateColumns: `auto repeat(${boardSize}, 1fr)${allEdges ? " auto" : ""}`,
            gridTemplateRows: `auto repeat(${boardSize}, 1fr)${allEdges ? " auto" : ""}`,
            ["--bg-max-vh" as string]: vhLimit,
            ["--bg-max-vw" as string]: vwLimit,
            // Derive the label size from the real cell size rather than guessing off the
            // viewport, so challenge names stay as large as each square can actually hold. In fill
            // mode the props can't describe the cell at all, so the measured width is used instead -
            // the square names there are sized inline and don't read this, but the count badge does,
            // and a badge scaled off maxVh on a board the player has dragged is simply wrong.
            ["--bg-cell-font" as string]:
              cellW > 0
                ? `${cellW / 7.2}px`
                : `calc(min(${vhLimit}, ${vwLimit}, 1600px) / ${boardSize} / 7.2)`,
            // Set here rather than in the stylesheet: the icon lives under Vite's base path, which
            // is "/Elden-Battleship/" in a deployed build and "/" in dev, and CSS can't read it.
            ["--bg-star-icon" as string]: `url(${import.meta.env.BASE_URL}marks/star.png)`,
          }}
          onMouseLeave={handleGridLeave}
        >
          {colHeaders}
          {rowHeaders}
          {cells}
          {ships?.map((s, i) => {
            // How tall a vertical hull's grid area is relative to its width: `size` cells stacked up
            // plus the grid lines between them, over one cell across. On a square board this comes
            // out at roughly `size`, which is what the maths below used to hard-code - and precisely
            // why it broke once a panel could be dragged out of square. Horizontal ships don't need
            // it; their box isn't rotated, so 92% of each axis is already the right answer.
            const areaRatio = cellBox
              ? (s.size * cellBox.h + (s.size - 1) * GRID_GAP) / cellBox.w
              : s.size;
            return (
              <div
                key={i}
                className="bg-ship-overlay"
                style={{
                  gridRow: s.horizontal ? s.row + 2 : `${s.row + 2} / span ${s.size}`,
                  gridColumn: s.horizontal ? `${s.col + 2} / span ${s.size}` : s.col + 2,
                }}
              >
                {/*
                  The sprite is authored horizontally (long side across). A vertical ship therefore
                  gets drawn in a box shaped like its own grid area TRANSPOSED, then rotated a
                  quarter turn back onto it.

                  Percentages resolve against the OUTER box's own width and height respectively, so
                  a width of areaRatio and a height of 1/areaRatio produce a box of exactly
                  (outer height x outer width) - the transpose. Rotating that 90 degrees lands its
                  footprint back on the outer box, undistorted, whatever shape the outer box is.
                  HULL_FIT then insets both axes proportionally.
                */}
                <div
                  className="bg-ship-overlay-inner"
                  style={{
                    width: `${(s.horizontal ? HULL_FIT : areaRatio * HULL_FIT) * 100}%`,
                    height: `${(s.horizontal ? HULL_FIT : HULL_FIT / areaRatio) * 100}%`,
                    transform: s.horizontal ? "translate(-50%, -50%)" : "translate(-50%, -50%) rotate(90deg)",
                    maskImage: `url(${shipArtUrl(s.shipName, s.size)})`,
                    WebkitMaskImage: `url(${shipArtUrl(s.shipName, s.size)})`,
                    backgroundColor: s.colorHex,
                  }}
                />
              </div>
            );
          })}
          {marks}
        </div>
      </div>

      {/* Single shared tooltip rather than a native `title` per cell: title has a ~1s delay that
          makes scanning a board painful, and can't be styled. Fixed-positioned so it escapes the
          grid's overflow clipping.

          Portalled to <body> because position:fixed only escapes CLIPPING, not stacking. On the
          match canvas each panel carries a z-index and so opens a stacking context, which the
          tooltip's own z-index can't climb out of - leaving square names hidden behind any panel
          the player had stacked above the board. At body level it competes with the panels
          directly, which is what a tooltip should do. */}
      {tooltip &&
        createPortal(
          <div className="bg-tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
            {tooltip.text}
          </div>,
          document.body
        )}
    </div>
  );
}
