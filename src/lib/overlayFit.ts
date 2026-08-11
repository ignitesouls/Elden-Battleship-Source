/**
 * How much a bar-shaped overlay has to shrink to sit inside its browser source.
 *
 * Shared by the scorebug and the colour key, which are the same shape problem: a strip laid out at
 * its natural size, dropped into whatever source the streamer dragged out, and scaled to fit rather
 * than authored against one design width. That is what lets a room with nine regions and a room
 * with five both look right in the same 1920x90 source.
 *
 * -- Why the inset --
 *
 * Fitting EXACTLY is what shipped first, and it clipped the plate's own left and right borders. A
 * scale of frame.w / bar.w puts the scaled bar's edges precisely on the frame's edges, where the
 * source's `overflow: hidden` and a half-pixel of rounding are enough to take a 1px border with
 * them - so the strip arrived on stream as a slab of background with no sides. The padding is the
 * fix, and it is also just better: a plate touching the exact edge of its source reads as clipped
 * even when it isn't.
 *
 * -- Why the ceiling is a parameter --
 *
 * It was a hard 1, on the grounds that upscaling text is what a stream encoder punishes and anyone
 * wanting it bigger should make the source bigger. Both halves of that turned out to be wrong in
 * practice. The natural sizes are generous, so a streamer who made a tall source got a strip sitting
 * in the middle of it with empty space above and below and no way to spend it - "make the source
 * bigger" was already what they had done. And the encoder argument overstates the cost: this is a
 * layout transform on static text, which the browser rasterises at its final scale, not a bitmap
 * being stretched.
 *
 * So the ceiling is the streamer's to raise, and 1 is merely its default - the shape of the thing is
 * unchanged for every source that doesn't ask. See lib/overlayText for where the number comes from.
 */
export function fitScale(
  bar: { w: number; h: number },
  frame: { w: number; h: number },
  /** Breathing room left on every side, in source pixels. */
  pad = 8,
  /** Largest scale allowed. Above 1 the bar is drawn bigger than its natural size. */
  max = 1
): number {
  if (bar.w <= 0 || bar.h <= 0 || frame.w <= 0 || frame.h <= 0) return 1;
  // max(1, ...) so a source smaller than the padding can't ask for a zero or negative scale.
  const w = Math.max(1, frame.w - pad * 2);
  const h = Math.max(1, frame.h - pad * 2);
  // The frame still wins: a ceiling above 1 offers room the source may simply not have, and a strip
  // scaled past its own source is a strip with its ends cut off.
  return Math.min(max, w / bar.w, h / bar.h);
}
