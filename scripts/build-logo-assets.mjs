/**
 * Regenerates every derived logo asset in public/ from the master art in art/.
 *
 * Run it with `node scripts/build-logo-assets.mjs` after the master is redrawn; nothing here runs
 * at build time, because these outputs change roughly never and committing them keeps the deploy
 * a plain `dist/` upload with no image toolchain in the loop.
 *
 * The PNG codec below is written out longhand rather than pulled from sharp/jimp: this is the only
 * image processing in the entire project, and a one-file decoder built on Node's own zlib is a far
 * smaller thing to own than a native dependency that has to compile on every machine that clones
 * the repo. It handles exactly what the master needs - 8-bit, non-interlaced - and throws loudly on
 * anything else rather than quietly producing garbage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = join(root, "art", "battleship-logo.png");
const PUBLIC = join(root, "public");

/* --- the sea ---------------------------------------------------------------
   The same two stops the favicon uses, which are themselves the app background: sunlight at the
   surface, black in the depths. Anything the logo is composited onto uses this, so the share card
   and the phone icon look like they came off the same page as the site. */
const SEA_TOP = [0x12, 0x35, 0x4a];
const SEA_BOTTOM = [0x06, 0x12, 0x1b];

/* --- PNG decode ----------------------------------------------------------- */

function decodePng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);

  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }

  if (depth !== 8) throw new Error(`${path}: unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNGs unsupported`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${path}: unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const flat = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec 9.2). Each line's filter byte precedes its data, and
  // filters reference the already-reconstructed pixel to the left and the line above.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
  }

  // Everything downstream works in RGBA, so widen here and have exactly one pixel format after.
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) r = g = b = flat[i];
    else if (colorType === 2) [r, g, b] = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]];
    else if (colorType === 3) {
      const idx = flat[i];
      [r, g, b] = [palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]];
      if (trns && idx < trns.length) a = trns[idx];
    } else if (colorType === 4) { r = g = b = flat[i * 2]; a = flat[i * 2 + 1]; }
    else [r, g, b, a] = [flat[i * 4], flat[i * 4 + 1], flat[i * 4 + 2], flat[i * 4 + 3]];
    data.set([r, g, b, a], i * 4);
  }

  return { width, height, data };
}

/* --- PNG encode ----------------------------------------------------------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(path, img) {
  const stride = img.width * 4;
  // Sub on every line. Not adaptive filtering, just the one that suits this art: the outputs are
  // horizontal gradients and flat glow, which Sub flattens to long runs of zero.
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? img.data[y * stride + x - 4] : 0;
      raw[y * (stride + 1) + 1 + x] = (img.data[y * stride + x] - left) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA

  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
  return path;
}

/* --- geometry ------------------------------------------------------------- */

/** Tightest rectangle containing every pixel above `alphaMin`. The master is a 3000px square with
    the art floating in the middle of it, and that padding would otherwise become dead margin
    baked into every derived size. */
function contentBox(img, alphaMin = 8) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > alphaMin) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function crop(img, { x0, y0, width, height }) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y + y0) * img.width + x0) * 4;
    img.data.copy(data, y * width * 4, from, from + width * 4);
  }
  return { width, height, data };
}

/**
 * Box-filter downscale, averaging in PREMULTIPLIED alpha.
 *
 * Averaging straight RGBA instead would pull the colour of fully transparent pixels into every
 * edge. The master's transparent region is transparent black, so that shows up as a dark fringe
 * tracing the outside of the white glow - subtle at 1000px, obvious at 180.
 */
function resize(img, outW, outH) {
  const data = Buffer.alloc(outW * outH * 4);
  const sx = img.width / outW, sy = img.height / outH;
  for (let y = 0; y < outH; y++) {
    const yStart = Math.floor(y * sy);
    const yEnd = Math.min(img.height, Math.max(yStart + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < outW; x++) {
      const xStart = Math.floor(x * sx);
      const xEnd = Math.min(img.width, Math.max(xStart + 1, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let j = yStart; j < yEnd; j++) {
        for (let i = xStart; i < xEnd; i++) {
          const o = (j * img.width + i) * 4;
          const al = img.data[o + 3] / 255;
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += img.data[o + 3];
          n++;
        }
      }
      const alpha = a / n;
      const unmul = alpha > 0 ? 255 / alpha : 0;
      const o = (y * outW + x) * 4;
      data[o] = Math.min(255, Math.round((r / n) * unmul));
      data[o + 1] = Math.min(255, Math.round((g / n) * unmul));
      data[o + 2] = Math.min(255, Math.round((b / n) * unmul));
      data[o + 3] = Math.round(alpha);
    }
  }
  return { width: outW, height: outH, data };
}

/** An opaque canvas carrying the app's vertical sea gradient. */
function seaCanvas(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const t = height === 1 ? 0 : y / (height - 1);
    const row = [
      Math.round(SEA_TOP[0] + (SEA_BOTTOM[0] - SEA_TOP[0]) * t),
      Math.round(SEA_TOP[1] + (SEA_BOTTOM[1] - SEA_TOP[1]) * t),
      Math.round(SEA_TOP[2] + (SEA_BOTTOM[2] - SEA_TOP[2]) * t),
      255,
    ];
    for (let x = 0; x < width; x++) data.set(row, (y * width + x) * 4);
  }
  return { width, height, data };
}

/** Source-over composite of `top` onto `base` at (dx, dy), in place. */
function composite(base, top, dx, dy) {
  for (let y = 0; y < top.height; y++) {
    const by = y + dy;
    if (by < 0 || by >= base.height) continue;
    for (let x = 0; x < top.width; x++) {
      const bx = x + dx;
      if (bx < 0 || bx >= base.width) continue;
      const s = (y * top.width + x) * 4;
      const d = (by * base.width + bx) * 4;
      const a = top.data[s + 3] / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) {
        base.data[d + c] = Math.round(top.data[s + c] * a + base.data[d + c] * (1 - a));
      }
      base.data[d + 3] = 255;
    }
  }
}

/** Scales `logo` to the largest size fitting a `padding`-inset box, and centres it. */
function centreOnSea(logo, width, height, padding) {
  const canvas = seaCanvas(width, height);
  const scale = Math.min((width * (1 - padding * 2)) / logo.width, (height * (1 - padding * 2)) / logo.height);
  const w = Math.round(logo.width * scale);
  const h = Math.round(logo.height * scale);
  composite(canvas, resize(logo, w, h), Math.round((width - w) / 2), Math.round((height - h) / 2));
  return canvas;
}

/* --- outputs -------------------------------------------------------------- */

const master = decodePng(MASTER);
const logo = crop(master, contentBox(master));
console.log(`master ${master.width}x${master.height} -> content ${logo.width}x${logo.height}`);

const written = [];

// The transparent wordmark, for the harbor page. The hero is capped at 20rem by CSS, so this is
// ~2.4x the largest size it can ever be painted at - enough for any HiDPI screen, and a third
// smaller on the wire than the 1024px version that was the first thing tried. Going wider only
// buys detail no display can resolve, on the one page every player loads first.
const heroW = 768;
written.push(encodePng(join(PUBLIC, "logo.png"), resize(logo, heroW, Math.round((heroW / logo.width) * logo.height))));

// The same wordmark again, small, for everywhere inside the app that isn't the hero: the recap
// header, the lobby, the loading screens. A separate file rather than the hero scaled down in CSS
// because a loading screen is by definition the thing shown while the connection is still slow,
// and 200KB is a poor thing to be waiting on when 47 will do. Displayed at 9-11rem, so 320 still
// leaves headroom on a HiDPI screen.
written.push(encodePng(join(PUBLIC, "logo-small.png"), resize(logo, 320, Math.round((320 / logo.width) * logo.height))));

// Link-unfurl card. 1200x630 is the size Discord, Twitter and Slack all crop toward; anything else
// gets letterboxed by one of them. Composited rather than transparent because an unfurl sits on
// whichever background the client uses, and the glow vanishes against a light one.
written.push(encodePng(join(PUBLIC, "og-card.png"), centreOnSea(logo, 1200, 630, 0.09)));

// Home-screen icon. iOS ignores SVG favicons entirely and Android Chrome falls back to this one in
// the absence of a manifest, so this single file covers both. iOS applies its own rounded mask,
// which is why the plate is drawn square.
written.push(encodePng(join(PUBLIC, "apple-touch-icon.png"), centreOnSea(logo, 180, 180, 0.06)));

for (const path of written) console.log(`wrote ${path}`);
