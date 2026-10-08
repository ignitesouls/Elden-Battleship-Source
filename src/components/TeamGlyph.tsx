import { teamHex } from "../lib/teamColors";

/**
 * One shape per fleet, by team index - the same order as TEAM_COLORS, and just as load-bearing.
 *
 * Drawn as paths rather than Unicode symbols because OBS's browser source and half the fonts on a
 * phone have no ⬟ or ✚, and a tofu box is not a shape anybody can tell apart. Filled with the fleet's
 * own colour and outlined dark, so the shape and the colour say the same thing twice.
 */
const SHAPES: string[] = [
  "M5 1a4 4 0 1 1 0 8a4 4 0 1 1 0-8z", // circle
  "M1.5 1.5h7v7h-7z", // square
  "M5 1l4.2 7.6H0.8z", // triangle
  "M5 0.6l4.4 4.4L5 9.4L0.6 5z", // diamond
  "M3.6 1h2.8v2.6H9v2.8H6.4V9H3.6V6.4H1V3.6h2.6z", // plus
  "M0.8 1.4h8.4L5 9z", // triangle, point down
  "M5 0.8l1.2 2.9 3.1.2-2.4 2 .8 3.1L5 7.3 2.3 9l.8-3.1-2.4-2 3.1-.2z", // star
  "M3 1h4l2 4-2 4H3L1 5z", // hexagon
  "M1.6 3.2L3.2 1.6 5 3.4 6.8 1.6l1.6 1.6L6.6 5l1.8 1.8-1.6 1.6L5 6.6 3.2 8.4 1.6 6.8 3.4 5z", // cross
];

/**
 * A fleet's shape, the second cue colourblind mode gives a fleet wherever colour alone was naming
 * it. Hidden outside the mode by the `cb-only` rule in index.css rather than by a prop, so the
 * toggle reaches it live the way it reaches the palette.
 */
export function TeamGlyph({ team, className }: { team: number; className?: string }) {
  const d = SHAPES[team % SHAPES.length];
  return (
    <svg
      className={`team-glyph cb-only${className ? ` ${className}` : ""}`}
      viewBox="0 0 10 10"
      aria-hidden
    >
      <path d={d} fill={teamHex(team)} stroke="rgba(0, 0, 0, 0.85)" strokeWidth="0.9" strokeLinejoin="round" />
    </svg>
  );
}
