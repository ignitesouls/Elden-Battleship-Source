import { useRef, type ReactNode } from "react";
import { clampBox, type PanelBox } from "../lib/panelLayout";
import "./CanvasPanel.css";

interface Props {
  title: string;
  box: PanelBox;
  /** Canvas size in px, so fractions can be resolved and drag deltas converted back. */
  canvas: { w: number; h: number };
  onChange: (box: PanelBox) => void;
  /** Lets the board opt out of the panel's own padding, since its grid fills edge to edge. */
  flush?: boolean;
  /** Frozen: no drag, no resize, no restacking. The arrangement is the player's, not an accident. */
  locked?: boolean;
  /** Move this panel to the top or bottom of the stack. Omit to hide the layer buttons. */
  onRestack?: (to: "front" | "back") => void;
  children: ReactNode;
}

/**
 * One draggable, resizable window on the match canvas.
 *
 * Hand-rolled on pointer events rather than pulling in react-rnd: the whole app is four runtime
 * dependencies and none of them are UI, which is worth keeping. Pointer events also give touch and
 * pen for free, and setPointerCapture is what makes a drag survive the cursor outracing the panel -
 * without it, moving fast enough to leave the header mid-drag silently drops the gesture.
 *
 * Everything is committed in fractions. The panel converts to px only to apply a delta, so a window
 * resize rescales an arrangement instead of breaking it.
 */
export function CanvasPanel({ title, box, canvas, onChange, flush, locked, onRestack, children }: Props) {
  // The box as it was when the gesture started. Deltas apply to THIS, not to the live box - reading
  // the live one back each move compounds rounding and makes fast drags creep away from the cursor.
  const start = useRef<{ box: PanelBox; x: number; y: number } | null>(null);

  function begin(e: React.PointerEvent, mode: "move" | "resize") {
    // Left button only: a right-click on a panel header shouldn't start dragging it.
    if (e.button !== 0) return;
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { box, x: e.clientX, y: e.clientY };
    const el = e.currentTarget as HTMLElement;
    el.dataset.mode = mode;
  }

  function move(e: React.PointerEvent) {
    const s = start.current;
    if (!s) return;
    const mode = (e.currentTarget as HTMLElement).dataset.mode;
    const dx = (e.clientX - s.x) / canvas.w;
    const dy = (e.clientY - s.y) / canvas.h;

    onChange(
      clampBox(
        mode === "resize"
          ? { ...s.box, w: s.box.w + dx, h: s.box.h + dy }
          : { ...s.box, x: s.box.x + dx, y: s.box.y + dy }
      )
    );
  }

  function end(e: React.PointerEvent) {
    start.current = null;
    const el = e.currentTarget as HTMLElement;
    delete el.dataset.mode;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  return (
    <div
      className={`canvas-panel${locked ? " canvas-panel-locked" : ""}`}
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        zIndex: box.z,
      }}
    >
      <div
        className="canvas-panel-bar"
        onPointerDown={(e) => begin(e, "move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span className="canvas-panel-title">{title}</span>

        {/*
          Explicit layer buttons rather than raise-on-click, which is what a desktop window manager
          would do. Raise-on-click fights the whole point of this: someone who has deliberately put
          the clock over a corner of the board loses that arrangement the moment they fire a shot.
          Stacking here is something you set, like position, not something that happens to you.

          stopPropagation because the bar they sit in is the drag handle - without it, pressing a
          button also starts moving the panel.
        */}
        {onRestack && !locked && (
          <span className="canvas-panel-layers" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="canvas-panel-layer-btn"
              onClick={() => onRestack("back")}
              title={`Send ${title} behind the other panels`}
              aria-label={`Send ${title} to back`}
            >
              ▽
            </button>
            <button
              type="button"
              className="canvas-panel-layer-btn"
              onClick={() => onRestack("front")}
              title={`Bring ${title} in front of the other panels`}
              aria-label={`Bring ${title} to front`}
            >
              △
            </button>
          </span>
        )}
      </div>

      <div className={`canvas-panel-body${flush ? " canvas-panel-body-flush" : ""}`}>{children}</div>

      {/* Corner grip. Deliberately a separate capture target from the bar so a resize can never be
          misread as a move when the pointer crosses between them. */}
      {!locked && (
        <div
          className="canvas-panel-grip"
          onPointerDown={(e) => begin(e, "resize")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          aria-hidden
        />
      )}
    </div>
  );
}
