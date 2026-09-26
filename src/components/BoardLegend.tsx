import { legendItems } from "../lib/legend";
import type { Challenge } from "../lib/challenges";
import { useT } from "../lib/language";
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
  highlightKey,
  onHighlight,
}: {
  challenges: Challenge[];
  setId?: string | null;
  inline?: boolean;
  /** The group currently picked out on the board, so its entry here reads as the lit one. */
  highlightKey?: string | null;
  /**
   * Hovering an entry picks its group out on the board (see highlightKey in BoardGrid); leaving it
   * clears. Omit and the key is the plain, inert picture it always was - and carries no hint
   * promising otherwise.
   */
  onHighlight?: (key: string | null) => void;
}) {
  const t = useT();
  const { items, heading } = legendItems(challenges, setId);
  if (items.length === 0) return null;

  const swatches = (
    <div className="board-legend-items">
      {items.map((item) => (
        <span
          key={item.key}
          className={`board-legend-item${onHighlight ? " board-legend-item-live" : ""}${
            highlightKey === item.key ? " board-legend-item-active" : ""
          }`}
          // Focusable as well as hoverable, so the same thing is reachable without a mouse.
          tabIndex={onHighlight ? 0 : undefined}
          onMouseEnter={onHighlight && (() => onHighlight(item.key))}
          onMouseLeave={onHighlight && (() => onHighlight(null))}
          onFocus={onHighlight && (() => onHighlight(item.key))}
          onBlur={onHighlight && (() => onHighlight(null))}
        >
          <span className={`${item.className} board-legend-swatch`} style={item.style} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );

  // Region-tagged sets name places; the keyword sets name colour groups, and calling one of those a
  // region would be wrong.
  const hint = onHighlight
    ? heading === "Regions"
      ? t("(Hover a region to highlight)", "(Survolez une région pour la surligner)")
      : t("(Hover a colour to highlight)", "(Survolez une couleur pour la surligner)")
    : null;

  // Bar form: no card, no heading of its own, just a label and the swatches on one line. Used by the
  // dock along the bottom of the match screen and by the spectator's bar, where the surrounding bar
  // is already the container and a second border around the key would read as a panel that wandered
  // out of the canvas.
  if (inline) {
    return (
      <div className="board-legend-inline">
        <span className="board-legend-inline-label">{heading}</span>
        {swatches}
        {hint && <span className="board-legend-hint">{hint}</span>}
      </div>
    );
  }

  return (
    <div className="panel stack board-legend">
      <h3 className="board-legend-title">
        {heading}
        {hint && <span className="board-legend-hint"> {hint}</span>}
      </h3>
      {swatches}
    </div>
  );
}
