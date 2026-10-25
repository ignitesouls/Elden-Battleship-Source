/**
 * Turns whatever picture a captain chooses into a team logo (or an administrator into an event logo): a
 * square - at most 256px for a team, 1024px for an event, never larger than the picture itself - the whole image fitted
 * inside it (never cropped - a logo with its edge cut off is a different logo), transparent around it,
 * encoded as WebP where the browser can and PNG where it can't (Safari).
 *
 * Done in the browser, before upload, for three reasons: a 4000px phone photo becomes a 20 KB file the
 * event page can load for every team at once; redrawing strips everything but the pixels, including the
 * GPS position a phone writes into a photo; and only a plain raster image ever reaches the bucket, so an
 * SVG with a script in it never gets there.
 *
 * Browser only - it needs a canvas. Kept out of api.ts so the node checks that load api.ts never touch it.
 */

export const LOGO_SIZE = 256;

/**
 * An event's logo is shown much larger - across the whole front-page banner, ~430px wide, and twice that
 * many pixels on a scaled-up screen - so it is kept at four times the size. At 512 its small print went
 * soft the moment the banner made it big.
 */
export const EVENT_LOGO_SIZE = 1024;

/** Refused before decoding: a picture this big is not a logo, and decoding it could stall a phone. */
const MAX_INPUT_BYTES = 15 * 1024 * 1024;

export class LogoImageError extends Error {}

export async function makeLogo(file: File, maxSize: number = LOGO_SIZE): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new LogoImageError("not-image");
  if (file.size > MAX_INPUT_BYTES) throw new LogoImageError("too-big");

  const image = await load(file);
  const width = image.naturalWidth || maxSize;
  const height = image.naturalHeight || maxSize;
  // Never enlarged: a picture smaller than the cap is kept at its own size, since stretching it adds bytes
  // and no detail. The page draws it at whatever size it wants either way.
  const size = Math.min(maxSize, Math.max(width, height));
  const scale = Math.min(size / width, size / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new LogoImageError("unreadable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);

  // A browser that cannot write WebP quietly hands back a PNG instead; both are accepted. An event's logo
  // is saved at a higher quality - it is shown big, and fine lettering is the first thing compression blurs.
  const quality = maxSize > LOGO_SIZE ? 0.95 : 0.9;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  if (!blob || (blob.type !== "image/webp" && blob.type !== "image/png")) throw new LogoImageError("unreadable");
  return blob;
}

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new LogoImageError("unreadable"));
    };
    image.src = url;
  });
}
