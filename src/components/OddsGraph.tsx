import { teamHex } from "../lib/teamColors";
import { oddsBands, type OddsPoint } from "../lib/victoryOdds";

interface OddsGraphProps {
  teams: number[];
  points: OddsPoint[];
  /** Drawing box. The graph fills it exactly - the caller decides how big it is on screen. */
  width: number;
  height: number;
  /** Draw the halfway rule. Off on the very compact strip, where it is more ink than information. */
  rule?: boolean;
}

/**
 * The win-probability line: how the odds have moved across the match clock.
 *
 * -- Why it is a stacked band and not a line ---------------------------------------------------
 *
 * A single line means "one fleet's chance", which forces a choice of whose - and in a three-way or
 * a nine-way match there is no such fleet. A stack has no such problem: every fleet gets a band,
 * the bands always fill the height because the odds always sum to one, and the same drawing works
 * unchanged for two fleets or nine. It also puts the thing a viewer actually wants in the most
 * readable form there is - the WIDTH of your colour, right now, versus a minute ago.
 *
 * For the two-fleet case that 95 of the archive's 121 matches are, this reads exactly like the
 * momentum bar people already know from other sports: one colour swelling as the other is squeezed.
 *
 * -- Why it is drawn rather than animated -------------------------------------------------------
 *
 * Every point is a simulation of the match as it stood at that moment (see oddsTimeline), replayed
 * from the public log rather than accumulated as the match ran. A source refreshed at the ninety
 * minute mark draws the same shape as one that has been open since the horn, which is the property
 * that makes it safe to put on a stream - scenes get rebuilt mid-match, and an element that could
 * only draw what it personally witnessed is one the caster cannot trust.
 *
 * The geometry lives in lib/victoryOdds.oddsBands rather than here, so that it can be asserted -
 * see the note there.
 */
export function OddsGraph({ teams, points, width, height, rule = true }: OddsGraphProps) {
  const bands = oddsBands(teams, points, width, height);
  if (bands.length === 0) return null;

  return (
    <svg
      className="odds-graph"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {bands.map(({ team, polygon }) => (
        <polygon
          key={team}
          points={polygon.map(([x, y]) => `${x},${y}`).join(" ")}
          fill={teamHex(team)}
          fillOpacity={0.85}
        />
      ))}

      {/* Where the odds are even. The eye needs somewhere to measure the swing from. */}
      {rule && (
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="rgba(255,255,255,0.5)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      )}
    </svg>
  );
}
