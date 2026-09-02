import type { Challenge } from "../lib/challenges";
import "./UndealtCard.css";

interface Props {
  /** What the deal left in the pack. Never rendered empty - see the guard below. */
  squares: Challenge[];
  /** How many squares the set holds in total, so the card can say ten OF WHAT. */
  pool: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * The squares this board hasn't got: a card over the fire board's corner naming everything the deal
 * left in the pack.
 *
 * Worth showing at all only because the big boards nearly exhaust their set - a 14x14 boss board is
 * 196 of 206, so ten bosses sit this one out. That is a short enough list to be read once and
 * remembered, and it answers a question crews were otherwise answering by scanning the whole board
 * twice: "is Malenia even on here?". lib/undealt.ts decides which boards are close enough to their
 * ceiling to be asked; this only draws the answer.
 *
 * Open on arrival and closable to a tab, rather than a control you have to know about. The list
 * matters most in the first minute - it is a thing to check before you start planning, not a
 * reference to consult mid-hunt - and a card that opens itself once and then gets out of the way
 * suits that better than one nobody finds until the match is over. The tab keeps it recoverable,
 * because "which ones were missing again" is a question that comes back.
 *
 * Deliberately not remembered across matches. Every board leaves out a different ten, so a
 * dismissal is a statement about this board and not a preference about the feature - persisting it
 * would mean somebody who closed the card once never sees the list again on any board. See
 * useStoredToggle for the general version of that argument.
 */
export function UndealtCard({ squares, pool, open, onOpen, onClose }: Props) {
  if (squares.length === 0) return null;

  if (!open) {
    return (
      <button
        className="undealt-tab"
        onClick={onOpen}
        title="Show the squares this board left out"
      >
        {squares.length} not dealt
      </button>
    );
  }

  return (
    <div className="undealt">
      <div className="undealt-head">
        <span className="undealt-title">Not on this board</span>
        <span className="undealt-sub">
          {squares.length} of {pool}
        </span>
        <button className="undealt-close" onClick={onClose} title="Hide - reopen from the tab" aria-label="Hide">
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
    </div>
  );
}
