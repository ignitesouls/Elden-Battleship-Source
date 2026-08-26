import { BoardGrid, type CellVisual } from "./BoardGrid";
import { FindCard } from "./FindCard";
import type { Region } from "../lib/challenges";
import type { DeepMark } from "../lib/deepWater";
import "../pages/OverlayTiers.css";
import "../pages/OverlayBoard.css";
import "./OverlaySample.css";

/** The board's edge, in squares. Six is the smallest that still reads as a grid rather than a swatch. */
const SIZE = 6;
/** Rendered size. Sits inside a panel that can be a narrow column, so this is a ceiling, not a target. */
const PX = 232;

/**
 * The squares, written out rather than generated.
 *
 * Every one is here to make something visible that a slider can change, and the arrangement is the
 * point: unfired squares next to fired ones, a wreck spanning three of them, a long name beside a
 * short one, and a couple of squares left plain so the water can be seen on its own. A random board
 * would sometimes show none of that and a streamer would drag a slider and see nothing move.
 *
 * The names are real squares from a real set, because made-up ones would be the wrong LENGTH - how
 * a name wraps at each text size is most of what the text slider is for, and "Maliketh, the Black
 * Blade" is the one that decides it.
 */
const SQUARES: Record<number, { label: string; region: Region }> = {
  0: { label: "Godrick", region: "limgrave" },
  1: { label: "Rennala", region: "liurnia" },
  2: { label: "Radahn", region: "caelid" },
  3: { label: "Morgott", region: "altus" },
  4: { label: "Rykard", region: "altus" },
  5: { label: "Astel", region: "underground" },
  6: { label: "Maliketh, the Black Blade", region: "mountaintops" },
  7: { label: "Mohg", region: "underground" },
  8: { label: "Malenia", region: "mountaintops" },
  9: { label: "Messmer", region: "dlc" },
  10: { label: "Bayle", region: "dlc" },
  11: { label: "Radagon", region: "altus" },
  12: { label: "Margit", region: "limgrave" },
  13: { label: "Godfrey", region: "altus" },
  14: { label: "Rellana", region: "dlc" },
  15: { label: "Midra", region: "dlc" },
  16: { label: "Placidusax", region: "mountaintops" },
  17: { label: "Fortissax", region: "underground" },
};

/** What each square is showing. The three results, and everything else left as open water. */
const VISUALS: Record<number, CellVisual> = {
  8: "miss",
  13: "hit",
  20: "sunk",
  21: "sunk",
  22: "sunk",
  27: "miss",
  30: "hit",
};

/**
 * A sample of the real thing, driven by the sliders above it.
 *
 * -- Why this is fabricated rather than the live board ---------------------------------------------
 *
 * This box is built to be opened in the LOBBY - a scene gets set up before a match, not during one -
 * and in a lobby there is no board, no shots and nothing to preview. A synthetic board works there,
 * which is where it is needed most.
 *
 * It also gets to be composed. A real board mid-match might have every shot in one corner, or none
 * yet, and a streamer dragging the unfired-squares slider across it would see nothing happen and
 * conclude the control does nothing. Here there is always a miss, a hit and a wreck to hold still
 * while the water moves around them.
 *
 * -- Why it can be trusted ------------------------------------------------------------------------
 *
 * Because it is not a drawing OF the source, it is the source. Same BoardGrid, wearing the same
 * .ovb-board and .ovl-fade classes, reading the same three variables the browser source reads. There
 * is no second implementation here to drift out of step with the first - if this looks right and the
 * stream doesn't, the bug is in something they share, which is the only kind worth having.
 *
 * The one thing it cannot promise is the footage. See OverlaySample.css.
 */
export function OverlaySample({
  opacity,
  emptyFade,
  textSize,
  alertMark,
}: {
  opacity: number;
  emptyFade: number;
  textSize: number;
  /** A find to hold over the board, for as long as the box says. Null the rest of the time. */
  alertMark?: DeepMark | null;
}) {
  return (
    <div className="ovp-wrap">
      <div
        className="ovp-shot"
        style={{
          // From public/ rather than bundled, so it can be swapped without a rebuild. Absolute off
          // BASE_URL because a public asset is not rewritten by the bundler and the site lives under
          // a subpath on Pages - a relative url() here resolves against the CSS file and 404s.
          //
          // If the file isn't there the layer simply doesn't paint and the generated field beneath
          // shows through, which is why that field exists rather than being dead weight.
          backgroundImage: `url(${import.meta.env.BASE_URL}preview/footage.jpg)`,
        }}
      />
      <div
        className="ovp-board ovb-board ovl-fade"
        style={{
          ["--ovb-cells" as string]: SIZE,
          ["--ovb-text" as string]: textSize,
        }}
      >
        <div
          className="ovl-fade-stage"
          style={{
            ["--ovl-a-bg" as string]: opacity,
            ["--ovl-a-empty" as string]: emptyFade,
          }}
        >
          <BoardGrid
            boardSize={SIZE}
            cellVisual={(i) => VISUALS[i] ?? "empty"}
            maxVh={`${PX}px`}
            maxVw={`${PX}px`}
            textBoost={textSize}
            growText
            // The wreck, so a sunk hull has something to burn on - the three squares above.
            ships={[{ row: 3, col: 2, size: 3, horizontal: true, shipName: "Cruiser", colorHex: "#e08a3c" }]}
            sunkOrientation={new Map([[20, true], [21, true], [22, true]])}
            cellText={(i) => {
              const sq = SQUARES[i];
              return sq ? { label: sq.label, region: sq.region } : null;
            }}
            // The region wash on unfired squares - the thing the unfired-squares slider thins.
            cellTint={(i) => {
              const sq = SQUARES[i];
              return sq ? { region: sq.region } : null;
            }}
          />
        </div>
      </div>

      {/* The real card, at preview scale - see .ovp-alert. Whoever it credits is invented, because
          nothing has been found: the point of playing one here is the size and the wording, which is
          what a streamer has no way to judge from a duration in seconds. */}
      {alertMark ? (
        <div className="ovp-alert">
          <FindCard mark={alertMark} who="Your crew" team={1} where="D7" />
        </div>
      ) : null}
    </div>
  );
}
