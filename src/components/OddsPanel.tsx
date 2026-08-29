import { useBoxSize } from "../hooks/useBoxSize";
import { fitScale } from "../lib/overlayFit";
import { formatDuration } from "../lib/matchTime";
import { teamName, teamHex } from "../lib/teamColors";
import { oddsLabel, oddsWorthShowing, type OddsPoint, type OddsSnapshot } from "../lib/victoryOdds";
import { OddsGraph } from "./OddsGraph";
// The panel's styling still lives with the source it was written for. Imported rather than moved so
// the split costs no risk: nothing about how the odds look changes here. Same arrangement ClockBar
// uses for OverlayTimer.css.
import "../pages/OverlayOdds.css";

/**
 * The evaluation bar: each fleet's chance of winning, and the line that got them there.
 *
 * Split out of pages/OverlayOdds when the spectator page wanted the same thing. Two callers now -
 * the browser source, and the caster's own screen - and a second implementation would be a second
 * opinion about the one number on this site people will argue with. The argument should be about
 * the model, not about which surface drew it.
 *
 * It fills whatever box it is given, rather than being authored against a fixed width: laid out at
 * its natural size and scaled to fit, so it works in a 960px browser source and in a rail panel a
 * caster dragged to 280px alike. A caller only has to be a size.
 *
 * -- The one rule for measuring anything in here -------------------------------------------------
 *
 * This panel may measure the box it was GIVEN. It may never measure anything its own drawing can
 * change.
 *
 * The rule is written down because the scorebug's version of this same band broke it. That one took
 * its width from the clock row beside it, added its own padding to lay itself out, and thereby made
 * the row wider - so it grew by about two dozen pixels every frame while the fit divided by it, and
 * a caster's clock shrank towards nothing for as long as the source was open. See the note on
 * .ovt-row in OverlayTimer.css.
 *
 * Both measurements below are on the safe side of that line. `frame` is .ovo-fit, which takes its
 * size from its PARENT, and the plate inside it is absolutely positioned - so nothing drawn here
 * contributes to it. `panel` is the plate, read only to scale the plate, which is a transform and
 * changes no layout size at all. Anything added later has to clear the same bar.
 */

/**
 * The panel's natural size - the largest it is ever laid out at, and what the fit scales down from.
 * Generous on purpose: downscaling survives a stream encoder, upscaling does not.
 */
const GRAPH_WIDTH = 880;
const GRAPH_HEIGHT = 150;

/**
 * Narrowest the bar is laid out at before the fit takes over.
 *
 * Below this the two labels inside a slice stop fitting and .ovo-seg-tight starts dropping names,
 * which is the right behaviour for a fleet down to 4% and the wrong one for a panel that is merely
 * in a narrow column.
 */
const MIN_WIDTH = 280;

/** How much of the frame the plate's own padding and border need. */
const PLATE_CHROME = 42;

export function OddsPanel({
  snapshot,
  points,
  elapsed,
  showGraph,
  opacity = 1,
  textSize = 1,
}: {
  snapshot: OddsSnapshot | null;
  points: OddsPoint[];
  /** The match clock, already formatted - only the caller knows whether it is running. */
  elapsed: string;
  /**
   * The history line under the bar.
   *
   * Off is not a lesser version: the bar alone is the whole reading, and the line is the reasoning.
   * A narrow rail wants the reading; a panel somebody dragged out wants both.
   */
  showGraph: boolean;
  opacity?: number;
  /** The CEILING on the fit, not a multiplier after it - see fitScale and lib/overlayText. */
  textSize?: number;
}) {
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [panelRef, panel] = useBoxSize<HTMLDivElement>();

  /**
   * The width the bar is LAID OUT at, before anything is scaled.
   *
   * Authored at a flat 880 this panel was fine in the browser source it was written for and close to
   * illegible anywhere else: dropped into a 300px rail the fit took it to a third, which put the
   * team names at about seven pixels. Scaling is the right tool for "a bit bigger or smaller" and
   * the wrong one for "a third of the size", because every ratio inside the plate was chosen for a
   * panel somebody reads at a glance.
   *
   * So the natural width follows the box, and the fit only handles what is left over. Reading
   * `frame` here is safe and is worth saying why: .ovo-fit takes its size from its PARENT and the
   * plate inside it is absolutely positioned, so nothing this panel draws can change the number
   * being read. That is exactly the property the scorebug's odds band did not have, and it grew by
   * its own padding every frame until a caster's clock had shrunk to nothing - see the note on
   * .ovt-row in OverlayTimer.css. Any future measurement in here has to clear the same bar.
   */
  const natural =
    frame.w > 0 ? Math.max(MIN_WIDTH, Math.min(GRAPH_WIDTH, frame.w - PLATE_CHROME)) : GRAPH_WIDTH;

  const scale = fitScale(panel, frame, 8, textSize);

  // The frame is still rendered when there is nothing to say, because it is what gets measured -
  // returning null outright would leave the box at 0x0 and the panel would arrive at scale 1 on the
  // first frame that did have something, then jump.
  const ready = oddsWorthShowing(snapshot);

  return (
    <div className="ovo-fit" ref={frameRef}>
      {ready && (
        /**
         * The panel takes its width from its contents rather than carrying one, because
         * `box-sizing: border-box` is global here: a width on the plate would be the OUTER width and
         * the graph inside it would lose the padding off its right edge. Sizing the children and
         * letting the plate shrink to fit keeps the bar exactly `natural` wide whatever the padding
         * is changed to later.
         */
        <div
          className="ovo-panel"
          ref={panelRef}
          style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}
        >
          <div className="ovo-head">
            <span className="ovo-title">Odds of Victory</span>
            {snapshot.decided && <span className="ovo-decided">Decided</span>}
          </div>

          {/**
           * The bar is the number. Each fleet's slice IS its chance, so the reading is the width
           * rather than the digits - which is what lets somebody glance at it mid-sentence.
           *
           * A slice under a few percent cannot hold its own label, so the text moves outside rather
           * than being clipped to an unreadable sliver. flexGrow rather than a percentage width so
           * the slices always close the row exactly, whatever rounding does to the labels.
           */}
          <div className="ovo-now" style={{ width: natural }}>
            {snapshot.teams.map((team, i) => (
              <div
                key={team}
                className={`ovo-seg${snapshot.odds[i] < 0.12 ? " ovo-seg-tight" : ""}`}
                style={{ flexGrow: Math.max(snapshot.odds[i], 0.008), background: teamHex(team) }}
              >
                <span className="ovo-seg-name">{teamName(team)}</span>
                <span className="ovo-seg-pct">{oddsLabel(snapshot.odds[i])}</span>
              </div>
            ))}
          </div>

          {showGraph && points.length > 1 && (
            <>
              <div className="ovo-graph" style={{ width: natural, height: GRAPH_HEIGHT }}>
                <OddsGraph teams={snapshot.teams} points={points} width={natural} height={GRAPH_HEIGHT} />
              </div>
              {/* The axis is the match clock, which is the only scale this line is meaningful on. */}
              <div className="ovo-axis">
                <span>{formatDuration(points[0].seconds)}</span>
                <span className="ovo-axis-now">{elapsed}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
