import { BoardGrid, type CellVisual, type ShipOverlay } from "./BoardGrid";
import { FindCard } from "./FindCard";
import { ClockBar, type ClockFleet } from "./ClockBar";
import { KeyStrip } from "./KeyStrip";
import { legendItems } from "../lib/legend";
import { useT } from "../lib/language";
import type { Region } from "../lib/challenges";
import type { Challenge } from "../lib/squareSetFormat";
import type { DeepMark } from "../lib/deepWater";
import type { ShipDefinition } from "../types/battleship";
import "../pages/OverlayFleet.css";
import "../pages/OverlayTiers.css";
import "../pages/OverlayBoard.css";
import "./OverlaySample.css";

/** The board's edge, in squares. Six is the smallest that still reads as a grid rather than a swatch. */
const SIZE = 6;
/**
 * The board's size, as a share of the frame it sits in.
 *
 * A container unit rather than pixels, because the panel this box lives in is a different width in
 * a lobby, in the match dock and on a phone - and a preview whose board was a fixed 232px would
 * claim a different share of the frame in each of them, which is the one thing it must not get
 * wrong. Half the width of a 16:9 frame is very nearly its full height, which is about what a
 * 1000x1000 browser source occupies in a 1080p scene.
 */
const BOARD = "38cqw";

/** The fleet panel, at the 400/1920 share a 400px source has of a 1080p scene. */
const FLEET = "20.8cqw";

/** A classic fleet, for the scorebug's hull rows. */
const SHIPS: ShipDefinition[] = [
  { name: "Carrier", size: 5 },
  { name: "Battleship", size: 4 },
  { name: "Cruiser", size: 3 },
  { name: "Submarine", size: 3 },
  { name: "Destroyer", size: 2 },
];

/**
 * Two crews, mid-match, one of them losing.
 *
 * Deliberately uneven: a scorebug with every hull intact says nothing about what it looks like once
 * it has something to report, and the wrecked hulls are the part a streamer is checking is legible.
 */
const FLEETS: ClockFleet[] = [
  { team: 1, sunkHulls: [false, true, false, false, true] },
  { team: 2, sunkHulls: [true, true, false, true, false] },
];

/** A swing, so the caster's band has a shape rather than a flat line. */
const ODDS = {
  teams: [1, 2],
  odds: [0.68, 0.32],
  points: [
    { seconds: 0, odds: [0.5, 0.5] },
    { seconds: 420, odds: [0.42, 0.58] },
    { seconds: 900, odds: [0.55, 0.45] },
    { seconds: 1320, odds: [0.68, 0.32] },
  ],
};

/** The crew's own board: their hulls, and what has been thrown at them. */
const FLEET_VISUALS: Record<number, CellVisual> = { 3: "miss", 9: "hit", 14: "miss", 26: "sunk", 32: "hit" };
const FLEET_HULLS: ShipOverlay[] = [
  { row: 1, col: 1, size: 3, horizontal: true, shipName: "Cruiser", colorHex: "#2f9ee0" },
  { row: 4, col: 3, size: 2, horizontal: false, shipName: "Destroyer", colorHex: "#2f9ee0" },
];

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
 * The sample board on its own - the real BoardGrid wearing the browser source's classes. Shared with
 * the casting preview (components/CastScenePreview), which sets it in the frame art's board hole.
 */
export function SampleBoard({
  opacity,
  emptyFade,
  textSize,
  size,
  className,
}: {
  opacity: number;
  emptyFade: number;
  textSize: number;
  /** The board's edge, as a CSS length - a container unit, so it holds its share of the frame. */
  size: string;
  className?: string;
}) {
  return (
    <div
      className={`ovb-board ovl-fade${className ? ` ${className}` : ""}`}
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
          maxVh={size}
          maxVw={size}
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
  );
}

/** The sample scorebug on its own. Fills whatever box it is put in - see components/ClockBar. */
export function SampleClock({ isCaster, opacity, textSize }: { isCaster: boolean; opacity: number; textSize: number }) {
  return (
    <ClockBar
      phaseLabel="Match"
      clock="18:42"
      fleets={FLEETS}
      shipDefs={SHIPS}
      highlightTeam={isCaster ? null : 1}
      showFleets
      // The band is a caster's instrument, so it appears on a caster's scene and nowhere else -
      // which is the difference the box is otherwise only able to describe in words.
      odds={isCaster ? ODDS : null}
      opacity={opacity}
      textSize={textSize}
    />
  );
}

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
  isCaster,
}: {
  opacity: number;
  emptyFade: number;
  textSize: number;
  /** A find to hold over the board, for as long as the box says. Null the rest of the time. */
  alertMark?: DeepMark | null;
  /** The desk's scene rather than a crew's: odds on the clock, and no fleet panel. */
  isCaster: boolean;
}) {
  const t = useT();
  /**
   * The legend, from the same function the real key strip is built from.
   *
   * Fabricated challenges rather than fabricated ITEMS: legendItems decides which regions appear,
   * what they are called and what order they come in, and a preview that hand-rolled that list
   * would be a second opinion about all three.
   */
  const legend = legendItems(
    Object.values(SQUARES).map((sq) => ({ name: sq.label, region: sq.region }) as Challenge),
    null
  );

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

      {/* The scorebug, across the top. Real one, real fit - see components/ClockBar. */}
      <div className="ovp-clock">
        <SampleClock isCaster={isCaster} opacity={opacity} textSize={textSize} />
      </div>

      <SampleBoard className="ovp-board" opacity={opacity} emptyFade={emptyFade} textSize={textSize} size={BOARD} />

      {/* The crew's own fleet panel. Not on a caster's scene, because a caster has no fleet - the
          source needs a rejoin code and only its owner has one. See OverlayFleet. */}
      {!isCaster && (
        <div className="ovp-fleet ovf-board ovl-fade">
          <div
            className="ovl-fade-stage"
            style={{
              ["--ovl-a-bg" as string]: opacity,
              ["--ovl-a-empty" as string]: emptyFade,
            }}
          >
            <BoardGrid
              boardSize={SIZE}
              cellVisual={(i) => FLEET_VISUALS[i] ?? "empty"}
              maxVh={FLEET}
              maxVw={FLEET}
              // No names at this size - it wears the square's COLOUR instead, which is the whole
              // reason that source exists. See pages/OverlayFleet.
              ships={FLEET_HULLS}
              cellTint={(i) => {
                const sq = SQUARES[i];
                return sq ? { region: sq.region } : null;
              }}
            />
          </div>
        </div>
      )}

      {/* The colour key, along the bottom edge where it goes. */}
      <div className="ovp-key">
        <KeyStrip
          items={legend.items}
          heading={legend.heading}
          showLabel
          plate
          opacity={opacity}
          textSize={textSize}
        />
      </div>

      {/* The real card, at preview scale - see .ovp-alert. Whoever it credits is invented, because
          nothing has been found: the point of playing one here is the size and the wording, which is
          what a streamer has no way to judge from a duration in seconds. */}
      {alertMark ? (
        <div className="ovp-alert">
          <FindCard mark={alertMark} who={t("Your crew", "Votre équipe")} team={1} where="D7" />
        </div>
      ) : null}
    </div>
  );
}