import { legendItems } from "../lib/legend";
import type { Challenge } from "../lib/challenges";
import "./BoardLegend.css";

/**
 * Key to the colours the board tints square names with.
 *
 * What goes in it, and why only some of the set's colours appear, lives in lib/legend - shared with
 * the caster's OBS key strip so the two can never name a colour differently. This is the card and
 * bar rendering of it.
 */
export function BoardLegend({
  challenges,
  /** The room's square set, which is what says how to name a keyword-tinted board's colours. */
  setId,
  inline,
}: {
  challenges: Challenge[];
  setId?: string | null;
  inline?: boolean;
}) {
  const { items, heading } = legendItems(challenges, setId);
  if (items.length === 0) return null;

  const swatches = (
    <div className="board-legend-items">
      {items.map((item) => (
        <span key={item.key} className="board-legend-item">
          <span className={`${item.className} board-legend-swatch`} style={item.style} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );

  // Bar form: no card, no heading of its own, just a label and the swatches on one line. Used by the
  // dock along the bottom of the match screen and by the spectator's bar, where the surrounding bar
  // is already the container and a second border around the key would read as a panel that wandered
  // out of the canvas.
  if (inline) {
    return (
      <div className="board-legend-inline">
        <span className="board-legend-inline-label">{heading}</span>
        {swatches}
      </div>
    );
  }

  return (
    <div className="panel stack board-legend">
      <h3 className="board-legend-title">{heading}</h3>
      {swatches}
    </div>
  );
}
