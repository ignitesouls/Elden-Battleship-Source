import { HitMark, MissMark, SunkMark } from "./HitMarkers";
import { shipArtUrl } from "../lib/shipArt";

export type OverlayCellState = "none" | "miss" | "hit" | "sunk";

export interface OverlayShip {
  row: number;
  col: number;
  size: number;
  horizontal: boolean;
  shipName: string;
}

export interface OverlayLayer {
  team: number;
  teamLabel: string;
  colorHex: string;
  /** Outcome of attacks made AGAINST this team, per cell index. */
  state: (cellIndex: number) => OverlayCellState;
  /** Sunk cell -> hull orientation, so the fire leans the way the ship lies. */
  sunkHorizontal?: Map<number, boolean>;
  /** Hulls we're permitted to draw. Only ever the overlay owner's own fleet. */
  ships?: OverlayShip[];
  /** The square the most recent shot landed on, ringed so it can be tied to the name callout. */
  pulseCell?: number | null;
}

interface Props {
  boardSize: number;
  /** Cell edge in px. Small by necessity - this is composited over gameplay footage. */
  cell: number;
  /**
   * One layer per grid normally. In combined mode every team is stacked into each cell as a
   * horizontal band instead, which is the one case markers are dropped for - a burst or a splash
   * rendered into a 12px band is a smudge, whereas a flat color still reads at a glance.
   */
  layers: OverlayLayer[];
  label?: string;
  showCoords?: boolean;
  /** Challenge name per cell. Only worth passing at large cell sizes - see NAME_MIN_CELL. */
  cellName?: (index: number) => string | null;
}

/**
 * Below this cell size, boss names are not drawn at any size.
 *
 * The names average 13 characters and reach 25 ("Maliketh, the Black Blade"), so a cell fits about
 * 11 characters per line whatever the scale - meaning most names need two lines, and the font can
 * only be about cell/6.5. Under a 56px cell that lands below 8px, which a stream encoder turns to
 * mush; the label would cost real screen area and deliver nothing. Refusing to draw them is more
 * honest than shrinking them into noise.
 */
export const NAME_MIN_CELL = 48;

/** Fallback wash for combined mode, where the SVG markers are too small to survive. */
const STATE_FILL: Record<OverlayCellState, string> = {
  none: "transparent",
  miss: "rgba(207, 224, 232, 0.42)",
  hit: "#ff9c28",
  sunk: "#a01e1e",
};

export function OverlayGrid({
  boardSize,
  cell,
  layers,
  label,
  showCoords = true,
  cellName,
}: Props) {
  const gutter = showCoords ? Math.max(10, Math.round(cell * 0.62)) : 0;
  const combined = layers.length > 1;
  const bandHeight = cell / layers.length;
  // Grid lines start after the coordinate gutter/header when those are drawn.
  const offset = showCoords ? 2 : 1;

  const showNames = !!cellName && cell >= NAME_MIN_CELL;
  // Derived from the cell rather than fixed, so one knob (?cell=) scales the whole board coherently.
  const baseFont = Math.max(6, cell / 6.5);

  return (
    <div className="ov-grid-wrap">
      {label && (
        <div
          className="ov-grid-label"
          style={layers.length === 1 ? { color: layers[0].colorHex } : undefined}
        >
          {label}
        </div>
      )}

      <div
        className="ov-grid"
        style={{
          gridTemplateColumns: showCoords
            ? `${gutter}px repeat(${boardSize}, ${cell}px)`
            : `repeat(${boardSize}, ${cell}px)`,
          // Rows must be declared explicitly, not left implicit. A ship overlay is placed by
          // gridRow/gridColumn, and against an implicitly-sized grid that both mis-sizes the hull
          // (its inner box resolves percentages against a row of zero height) and can invent extra
          // rows past the board - which is what made the whole grid collapse when ships were on.
          gridTemplateRows: showCoords
            ? `${Math.round(cell * 0.5)}px repeat(${boardSize}, ${cell}px)`
            : `repeat(${boardSize}, ${cell}px)`,
        }}
      >
        {/*
          EVERY item below carries an explicit gridRow and gridColumn. Nothing here is auto-placed,
          and that is load-bearing rather than tidy.

          A ship overlay is positioned explicitly, and CSS Grid places explicit items BEFORE
          auto-placed ones, then flows the auto-placed items around what is already occupied. So an
          auto-placed board shifts by one slot for every cell a hull covers: row labels end up
          scattered mid-grid, square names sit a column off, the last few cells overflow past the
          declared rows, and the grid's own background shows through the holes as grey blocks. All
          of that on a stream, and only once ships were switched on. Placing the cells explicitly
          means there is nothing left to displace.
        */}
        {showCoords &&
          Array.from({ length: boardSize }, (_, c) => (
            <span key={`col${c}`} className="ov-grid-coord" style={{ gridRow: 1, gridColumn: c + offset }}>
              {String.fromCharCode(65 + c)}
            </span>
          ))}

        {showCoords &&
          Array.from({ length: boardSize }, (_, r) => (
            <span key={`row${r}`} className="ov-grid-coord" style={{ gridRow: r + offset, gridColumn: 1 }}>
              {r + 1}
            </span>
          ))}

        {Array.from({ length: boardSize * boardSize }, (_, index) => {
          const row = Math.floor(index / boardSize);
          const col = index % boardSize;
          return (
            <Cell
              key={index}
              index={index}
              gridRow={row + offset}
              gridColumn={col + offset}
              cell={cell}
              bandHeight={bandHeight}
              combined={combined}
              layers={layers}
              name={showNames ? cellName!(index) : null}
              baseFont={baseFont}
              cellPx={cell}
            />
          );
        })}

        {/* Hulls sit above the cells as their own grid items so a ship spans its real footprint,
            exactly as on the in-game board. Same masked-sprite trick too: the PNG is authored
            horizontally, so a vertical ship is sized as if horizontal and then rotated, rather
            than being squashed into a tall narrow box. */}
        {layers.flatMap((layer) =>
          (layer.ships ?? []).map((s, i) => (
            <div
              key={`${layer.team}-${i}`}
              className="ov-ship"
              style={{
                gridRow: s.horizontal ? s.row + offset : `${s.row + offset} / span ${s.size}`,
                gridColumn: s.horizontal ? `${s.col + offset} / span ${s.size}` : s.col + offset,
              }}
            >
              <div
                className="ov-ship-inner"
                style={{
                  width: s.horizontal ? "100%" : `${s.size * 100}%`,
                  height: s.horizontal ? "100%" : `${100 / s.size}%`,
                  transform: s.horizontal
                    ? "translate(-50%, -50%)"
                    : "translate(-50%, -50%) rotate(90deg)",
                  maskImage: `url(${shipArtUrl(s.shipName, s.size)})`,
                  WebkitMaskImage: `url(${shipArtUrl(s.shipName, s.size)})`,
                  backgroundColor: layer.colorHex,
                }}
              />
            </div>
          ))
        )}
      </div>

      {combined && (
        <div className="ov-grid-legend">
          {layers.map((l) => (
            <span key={l.team} className="ov-grid-legend-item">
              <span className="ov-grid-legend-band" style={{ background: l.colorHex }} />
              <span style={{ color: l.colorHex }}>{l.teamLabel}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Cell({
  index,
  gridRow,
  gridColumn,
  cell,
  bandHeight,
  combined,
  layers,
  name,
  baseFont,
  cellPx,
}: {
  index: number;
  gridRow: number;
  gridColumn: number;
  cell: number;
  bandHeight: number;
  combined: boolean;
  layers: OverlayLayer[];
  name: string | null;
  baseFont: number;
  cellPx: number;
}) {
  return (
    <>
      <span
        className={`ov-grid-cell${layers.some((l) => l.pulseCell === index) ? " ov-grid-cell-latest" : ""}`}
        style={{ width: cell, height: cell, gridRow, gridColumn }}
      >
        {/* Bands sit behind everything as a background wash so the name stays on top of them. */}
        {combined && (
          <span className="ov-grid-bands">
            {layers.map((layer) => (
              <span
                key={layer.team}
                style={{ height: bandHeight, display: "block", background: STATE_FILL[layer.state(index)] }}
              />
            ))}
          </span>
        )}

        {/* The real board's markers: a burst for a hit, ripples for a miss, fire and smoke over a
            sunk hull - the same components the game itself draws, so the stream matches what the
            players are looking at. */}
        {!combined && renderMark(layers[0], index)}

        {/* Above the marker, not below it. A square you've already struck is exactly the one whose
            identity people are discussing, so the explosion goes behind the name rather than
            erasing it. The shadow is what keeps it legible against fire. */}
        {name && (
          <span className="ov-grid-name" style={{ fontSize: `${fitFontSize(name, cellPx, baseFont)}px` }}>
            {name}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Shrinks a boss name until its LONGEST WORD fits across one cell, then stops.
 *
 * Sizing so the whole name fits on a single line would be unreadable - "Maliketh, the Black Blade"
 * is 25 characters, which lands around 4px even in a 56px cell. What actually looked broken was
 * mid-word breaking: at a fixed size "Dragonbarrow" and "Pumpkinhead" are wider than the square,
 * so `overflow-wrap: anywhere` guillotined them into "Dragonbarro / w". Fitting the longest word
 * keeps every word whole and lets the name wrap between words, which is how you'd read it anyway.
 *
 * 0.56em per character is a measured average for Segoe UI at 600 weight - proportional fonts have
 * no exact answer, so this errs slightly small rather than risking a word that still clips.
 *
 * Width alone stopped being enough once squares could hold objectives rather than boss names. The
 * longest word in "Complete 3 Tunnels or Precipice Dungeons in Different Regions" is nine letters,
 * so the width rule is perfectly happy - and then the name needs six lines in a cell that holds
 * four. The second constraint below fits the text by AREA, which is what actually runs out.
 */
function fitFontSize(name: string, cell: number, baseFont: number): number {
  const longestWord = Math.max(1, ...name.split(/\s+/).map((w) => w.length));
  const usable = cell - 4; // the 2px horizontal padding on .ov-grid-name, both sides
  const byWidth = usable / (longestWord * 0.56);

  // Characters per line is usable/(0.56F) and each line costs 1.1F in height, so the text needs
  // about 0.62 * chars * F² of area. The 1.25 is slack for the ragged right edge word wrap leaves.
  const byArea = Math.sqrt((usable * (cell - 2)) / (0.77 * Math.max(1, name.length)));

  // Never scale UP past the base size - a short name like "Adan" shouldn't become a billboard.
  // The 5px floor is where a stream encoder gives up regardless.
  return Math.max(5, Math.min(baseFont, byWidth, byArea));
}

function renderMark(layer: OverlayLayer | undefined, index: number) {
  if (!layer) return null;
  const state = layer.state(index);
  if (state === "hit") return <HitMark />;
  if (state === "miss") return <MissMark />;
  if (state === "sunk") return <SunkMark horizontal={layer.sunkHorizontal?.get(index) ?? true} />;
  return null;
}
