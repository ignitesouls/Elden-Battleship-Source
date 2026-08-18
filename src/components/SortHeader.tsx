import { useState, type ReactNode } from "react";

export type SortDirection = "asc" | "desc";

/**
 * One clickable column heading.
 *
 * Every column carries a `title`, including the ones whose heading looks self-explanatory: four
 * characters can't say whether "Hit %" counts a sinking shot once or twice, and a tooltip on some
 * headings and not others teaches people that hovering usually does nothing.
 */
export interface SortColumn<K extends string> {
  key: K;
  label: string;
  /** A second line under the heading, for a column whose name doesn't say which number it is. */
  sublabel?: string;
  align: "left" | "right";
  /**
   * Which way the first click sorts.
   *
   * Every column opens on its most interesting end: most shots, most ignored - and for a time, the
   * FASTEST, which is the low number. A column whose first click buries what people came to see is
   * a column they have to click twice.
   */
  firstDirection: SortDirection;
  /** The whole stat in a sentence, on hover. */
  title: string;
}

/**
 * Sort state for one table: which column, which way, and what a click does.
 *
 * Clicking the column you're already on flips it; clicking a new one opens it its own way.
 */
export function useSortColumns<K extends string>(columns: SortColumn<K>[], initial: K) {
  const [sort, setSort] = useState<K>(initial);
  const [direction, setDirection] = useState<SortDirection>(
    columns.find((c) => c.key === initial)?.firstDirection ?? "desc"
  );

  const sortBy = (key: K) => {
    if (key === sort) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDirection(columns.find((c) => c.key === key)?.firstDirection ?? "desc");
  };

  return { sort, direction, sortBy };
}

/**
 * A `<thead>` of sort buttons, shared by every table on the site that sorts.
 *
 * Sticky by default, because these tables are now long enough to scroll inside their panel - the
 * squares table is the whole boss set - and a heading that scrolls away takes the only explanation
 * of what the columns mean with it.
 */
export function SortHeader<K extends string>({
  columns,
  sort,
  direction,
  onSort,
  leading,
  sticky = true,
}: {
  columns: SortColumn<K>[];
  sort: K;
  direction: SortDirection;
  onSort: (key: K) => void;
  /** Content for an unsortable first column, such as a rank number. */
  leading?: ReactNode;
  sticky?: boolean;
}) {
  // Top-aligned throughout, because one heading may be two lines tall and the default middle
  // alignment would centre the others against it.
  const cell = {
    fontWeight: 500,
    verticalAlign: "top" as const,
    ...(sticky
      ? { position: "sticky" as const, top: 0, zIndex: 1, background: "var(--panel-raised)" }
      : {}),
  };

  return (
    <thead>
      <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
        {leading !== undefined && (
          <th style={{ ...cell, textAlign: "left", padding: "0.25rem 0.4rem" }}>{leading}</th>
        )}
        {columns.map((col) => {
          const active = sort === col.key;
          return (
            <th
              key={col.key}
              // Announces the sorted column and its direction to a screen reader, which is otherwise
              // the one thing the arrow says that nothing else does.
              aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
              style={{ ...cell, textAlign: col.align, padding: 0 }}
            >
              {/* A real button, not a click handler on the th: it has to be reachable by keyboard
                  and announced as pressable. */}
              <button
                type="button"
                onClick={() => onSort(col.key)}
                title={col.title}
                style={{
                  width: "100%",
                  background: "none",
                  border: "none",
                  padding: "0.25rem 0.4rem",
                  font: "inherit",
                  fontWeight: active ? 600 : 500,
                  color: active ? "var(--accent)" : "inherit",
                  textAlign: col.align,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  // A two-line heading has to sit on the same baseline as the one-line ones, so the
                  // stack grows DOWNWARD from a common top edge.
                  justifyContent: "flex-start",
                  alignItems: col.align === "left" ? "flex-start" : "flex-end",
                  gap: 0,
                  lineHeight: 1.15,
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
                  {col.label}
                  {/* Only the sorted column carries an arrow. Showing a dimmed one on every header
                      turns eight headings into eight pieces of punctuation. */}
                  <span aria-hidden style={{ fontSize: "0.6rem", opacity: active ? 1 : 0 }}>
                    {direction === "asc" ? "\u25B2" : "\u25BC"}
                  </span>
                </span>
                {/* Dimmer and smaller even when the column is sorted: it qualifies the heading rather
                    than being part of it, and matching weight would read as two headings stacked. */}
                {col.sublabel && (
                  <span style={{ fontSize: "0.68em", fontWeight: 400, opacity: 0.72, letterSpacing: "0.02em" }}>
                    {col.sublabel}
                  </span>
                )}
              </button>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
