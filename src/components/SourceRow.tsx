import { useState } from "react";
import "./SourceRow.css";

interface Props {
  label: string;
  url: string;
  /** Width x height to type into OBS's Browser Source dialog. */
  size: string;
  note: string;
}

/**
 * One ready-made browser source: what it is, its URL, and the size to make it in OBS.
 *
 * Shared by the caster's desk and the player's overlay box on purpose. The clock and the colour key
 * are the SAME source for both - a player and a caster paste the same URL and make the same
 * rectangle - so presenting them differently in two places would invent a difference that doesn't
 * exist, and would let the recommended sizes drift apart the first time one of them was edited.
 */
export function SourceRow({ label, url, size, note }: Props) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="src-row">
      <div className="src-line">
        <span className="src-label">{label}</span>
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button
          onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* The size sits with the URL rather than in a readme nobody opens: get a source's aspect
          wrong and the board arrives square inside a rectangle with dead space either side. */}
      <span className="src-size">
        <strong>{size}</strong> - {note}
      </span>
    </div>
  );
}
