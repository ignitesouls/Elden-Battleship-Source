/**
 * How large the text on a stream source is drawn, as a multiplier on its natural size.
 *
 * -- Why this is a setting -----------------------------------------------------------------------
 *
 * Every one of these sources picks its own text size from something it can measure - the board from
 * how wide a square came out, the clock and the key from how big the browser source is. That is the
 * right default and it is not enough, because the one number none of them can measure is how far
 * away the viewer is sitting. A 1080p stream watched full screen on a monitor and the same stream
 * watched on a phone on a bus want visibly different boards, and the streamer is the only person in
 * the chain who knows which audience they have.
 *
 * So the fitting stays - nothing here can make text overflow a square or a strip - and this rides on
 * top of it as a ceiling the streamer chooses. Smaller than natural fits more of a long boss name on
 * one line; larger trades that for something readable across a room.
 *
 * -- One setting for all three sources -----------------------------------------------------------
 *
 * Written into all three URLs from one control, exactly as `opacity` is, and for the same reason: the
 * three are dropped into a single scene over the same gameplay, and a board with huge square names
 * under a scorebug at half the size reads as a mistake rather than a choice. Anyone who genuinely
 * wants them to differ can edit `?text=` on the one URL afterwards - every source parses the
 * parameter for itself, they just aren't asked about it three times.
 */

/**
 * Ceiling on a square's name on a stream board, replacing the 17px the app draws at.
 *
 * 17 is right for a player a foot from their own monitor and has always been wrong for a browser
 * source - OverlayBoard.css says so and raises its clamp to 72 - but that rule only ever governed
 * the single render before a cell has been measured, because BoardGrid writes the fitted size inline
 * and inline wins. So the cap was still 17 in every frame anyone saw, and a caster zooming to 2x got
 * squares four times the size with names exactly as small as before.
 *
 * Lives here rather than in OverlayBoard so scripts/check-text-fit.ts asserts against the same number
 * the page renders with. A check that carried its own copy would keep passing while the two drifted.
 */
export const OVERLAY_MAX_FONT = 72;

/** The named steps offered in the overlay box, largest last. */
export const TEXT_SIZE_OPTIONS: readonly { value: number; label: string; note: string }[] = [
  { value: 0.8, label: "Small", note: "long names on fewer lines" },
  { value: 1, label: "Normal", note: "sized to the square" },
  { value: 1.25, label: "Large", note: "comfortable on a 1080p stream" },
  { value: 1.5, label: "Huge", note: "readable across a room" },
  { value: 1.8, label: "Giant", note: "for a small board on a big source" },
  { value: 2.2, label: "Colossal", note: "as far as a square will stretch" },
];

/**
 * Bounds on a hand-typed `?text=`.
 *
 * Wider than the named steps because the steps are a menu, not a policy - somebody who has found
 * that 1.35 is exactly right for their scene should keep it. The floor is where a name stops being
 * worth rendering at all and the ceiling is well past where any square has room to grow, so both
 * ends are guard rails rather than opinions.
 */
export const MIN_TEXT_SIZE = 0.5;
export const MAX_TEXT_SIZE = 3;

/**
 * `?text=` off a source's URL, clamped, defaulting to natural size.
 *
 * Shared by all three player-facing sources for the reason given above - one reader means one clamp,
 * so a hand-typed value can't mean one thing to the board and another to the clock.
 */
export function readTextSize(params: URLSearchParams): number {
  const raw = params.get("text");
  if (raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, n));
}
