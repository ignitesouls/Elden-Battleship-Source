import { SQUARE_SET_LIST, type SquareSetId } from "../lib/challenges";

interface Props {
  value: SquareSetId;
  onChange: (id: SquareSetId) => void;
  /** Matches counted per set, used to gray out a set nobody has played and to show the tally. */
  counts: Record<string, number>;
}

/**
 * Picks which square set's records to look at.
 *
 * The two boards are barely the same game - a hundred boss kills against "acquire 3 painting
 * rewards" - so their numbers can't share a table. A shot at a boss square and a shot at an
 * objective square are different acts, and an accuracy figure averaged over both describes
 * neither. Hence one set at a time, everywhere records are shown.
 */
export function SquareSetTabs({ value, onChange, counts }: Props) {
  return (
    <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
      {SQUARE_SET_LIST.map((s) => {
        const n = counts[s.id] ?? 0;
        return (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            aria-pressed={value === s.id}
            // Empty sets stay clickable rather than disabled: the resulting "nothing here yet" is
            // a clearer answer than a button that ignores you.
            title={s.blurb}
            style={{
              borderColor: value === s.id ? "var(--accent)" : undefined,
              color: value === s.id ? "var(--text)" : "var(--text-dim)",
              fontSize: "0.82rem",
            }}
          >
            {s.label}
            <span className="muted" style={{ fontSize: "0.72rem" }}> · {n}</span>
          </button>
        );
      })}
    </div>
  );
}
