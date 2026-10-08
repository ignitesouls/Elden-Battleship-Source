import { useBoxSize } from "../hooks/useBoxSize";
import { fitScale } from "../lib/overlayFit";
import type { legendItems } from "../lib/legend";
// As with ClockBar: the strip's styling stays with the source it was written for, so splitting the
// markup out costs nothing in how it looks.
import "../pages/OverlayKey.css";

/** Exactly what legendItems produces, so the key can never disagree with the board's colours. */
type LegendItem = ReturnType<typeof legendItems>["items"][number];

/**
 * The colour key: one swatch and label per region the board actually dealt.
 *
 * Split out of pages/OverlayKey for the OBS box's scene preview - same argument as ClockBar and
 * FindCard. Two callers, one strip.
 *
 * Scaled to fit whatever box it is handed, for the reason the scorebug is: a streamer should be
 * able to make the source any width and have the key fill it, rather than having to match a size
 * somebody else chose. `nowrap` in the stylesheet is load-bearing here - this is a strip, and a key
 * that wraps to a second line is a key that has changed height on somebody's scene mid-match.
 */
export function KeyStrip({
  items,
  heading,
  showLabel,
  plate,
  opacity,
  textSize,
}: {
  items: LegendItem[];
  /** What this set of squares is called. Hidden when the strip is too narrow to spend room on it. */
  heading: string;
  showLabel: boolean;
  /** The backing behind the strip. ?plate=0 drops it for a scene that has its own lower third. */
  plate: boolean;
  opacity: number;
  textSize: number;
}) {
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [barRef, bar] = useBoxSize<HTMLDivElement>();
  const scale = fitScale(bar, frame, 8, textSize);

  return (
    <div className="ovk-fit" ref={frameRef}>
      <div
        className={`ovk-bar${plate ? " ovk-plate" : ""}`}
        ref={barRef}
        style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}
      >
        {showLabel && <span className="ovk-label">{heading}</span>}
        {items.map((item) => (
          <span key={item.key} className="ovk-item">
            <span className={`${item.className} ovk-swatch`} style={item.style} aria-hidden />
            {/* The squares' colourblind-mode code - see BoardLegend. */}
            {item.code && (
              <span className={`${item.className} ovk-code cb-only`} style={item.style}>
                {item.code}
              </span>
            )}
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
