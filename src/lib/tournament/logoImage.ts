/**
 * Turns whatever picture a captain chooses into a team logo: a 256px square, the whole image fitted
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

/** Refused before decoding: a picture this big is not a logo, and decoding it could stall a phone. */
const MAX_INPUT_BYTES = 15 * 1024 * 1024;

export class LogoImageError extends Error {}

export async function makeLogo(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new LogoImageError("not-image");
  if (file.size > MAX_INPUT_BYTES) throw new LogoImageError("too-big");

  const image = await load(file);
  const width = image.naturalWidth || LOGO_SIZE;
  const height = image.naturalHeight || LOGO_SIZE;
  const scale = Math.min(LOGO_SIZE / width, LOGO_SIZE / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = LOGO_SIZE;
  canvas.height = LOGO_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new LogoImageError("unreadable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, Math.round((LOGO_SIZE - w) / 2), Math.round((LOGO_SIZE - h) / 2), w, h);

  // A browser that cannot write WebP quietly hands back a PNG instead; both are accepted.
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
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
