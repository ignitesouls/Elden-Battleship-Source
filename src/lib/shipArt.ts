/**
 * Where a hull's sprite comes from.
 *
 * The mask used to be `ships/${name.toLowerCase()}.png` at each call site, which silently rendered
 * nothing whenever a fleet held a name with no file behind it - a blank square where a ship should
 * be, with no error anywhere. Routing every call site through here means an unknown name falls back
 * to the sprite for its LENGTH, so a fleet can always be seen even if someone adds "Dreadnought"
 * to the naming pool without adding the art.
 */

/** The hulls that actually have a file in public/ships. */
const SHIP_ART = new Set(["carrier", "battleship", "cruiser", "submarine", "destroyer"]);

/** Fallback sprite per ship length, for any name we don't have art for. */
const BY_SIZE: Record<number, string> = {
  5: "carrier",
  4: "battleship",
  3: "cruiser",
  2: "destroyer",
  1: "destroyer",
};

/**
 * SVG rather than PNG since the hulls were redrawn.
 *
 * A drop-in swap, because these files were only ever masks: .bg-ship-overlay-inner takes the alpha and
 * fills it with the team's colour, so the format was never doing anything a vector can't. What it buys
 * is that a five-cell carrier is drawn from paths at whatever size the board happens to be, instead of
 * being resampled from a 480px bitmap - and that the five classes are now five distinct silhouettes
 * rather than one drawing stretched to three lengths, which is what the PNGs were.
 */
export function shipArtUrl(name: string, size?: number): string {
  const slug = name.toLowerCase();
  const file = SHIP_ART.has(slug) ? slug : (BY_SIZE[size ?? 0] ?? "destroyer");
  return `${import.meta.env.BASE_URL}ships/${file}.svg`;
}
