/**
 * Generates public/sfx/battleship_dutchman.wav - the find cue for the Flying Dutchman.
 *
 * Run: node scripts/synth-dutchman.mjs public/sfx/battleship_dutchman.wav
 *
 * Format matches the rest of public/sfx: PCM, 44100 Hz, mono, 16-bit.
 *
 * The cue is built from four layers, in the order you hear them:
 *   1. a swell of water and wind rising out of nothing,
 *   2. the ship's bell, two tolls, inharmonic the way a real bell is,
 *   3. timber groaning under her as she comes about,
 *   4. a long hall tail so she sounds far away rather than in the room.
 *
 * Everything is deterministic - the noise runs off a seeded PRNG - so
 * regenerating gives byte-identical output.
 */
import { writeFileSync } from "node:fs";

const SR = 44100;
const DUR = 3.8;
const N = Math.round(SR * DUR);

// ---- deterministic noise -------------------------------------------------

let seed = 0x5eed1e;
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const noise = () => rnd() * 2 - 1;

// ---- helpers -------------------------------------------------------------

const buf = new Float64Array(N);
const at = (t) => Math.round(t * SR);

/** One-pole lowpass, used to take the fizz off the noise layers. */
function lowpass(src, cutoff) {
  const out = new Float64Array(src.length);
  const a = Math.exp((-2 * Math.PI * cutoff) / SR);
  let z = 0;
  for (let i = 0; i < src.length; i++) {
    z = src[i] * (1 - a) + z * a;
    out[i] = z;
  }
  return out;
}

function highpass(src, cutoff) {
  const lp = lowpass(src, cutoff);
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] - lp[i];
  return out;
}

// ---- 1. water and wind ---------------------------------------------------

const wind = new Float64Array(N);
for (let i = 0; i < N; i++) wind[i] = noise();

let windBand = lowpass(wind, 900);
windBand = highpass(windBand, 160);

for (let i = 0; i < N; i++) {
  const t = i / SR;
  // one long swell, plus a slow gust underneath it
  const swell = Math.max(0, Math.sin((Math.PI * t) / DUR)) ** 1.4;
  const gust = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.31 * t + 1.1);
  buf[i] += windBand[i] * swell * gust * 0.16;
}

// a low sea rumble under everything
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const swell = Math.max(0, Math.sin((Math.PI * t) / DUR)) ** 1.2;
  buf[i] += Math.sin(2 * Math.PI * 47 * t + Math.sin(2 * Math.PI * 0.7 * t) * 0.6) * swell * 0.1;
  buf[i] += Math.sin(2 * Math.PI * 70.5 * t) * swell * 0.05;
}

// ---- 2. the bell ---------------------------------------------------------

// Inharmonic partials: a bell's overtones are not whole multiples, which is
// exactly why a stack of harmonics sounds like an organ and not a bell.
const F0 = 311.13; // Eb4
const PARTIALS = [
  { r: 0.5, a: 0.34, d: 2.9 },   // hum
  { r: 1.0, a: 1.0, d: 2.3 },    // prime
  { r: 1.183, a: 0.58, d: 1.7 }, // minor third
  { r: 1.506, a: 0.42, d: 1.45 },// fifth
  { r: 2.0, a: 0.6, d: 1.15 },   // nominal
  { r: 2.514, a: 0.26, d: 0.85 },
  { r: 3.011, a: 0.19, d: 0.62 },
  { r: 4.166, a: 0.11, d: 0.4 }
];

function toll(start, gain) {
  for (let i = at(start); i < N; i++) {
    const t = (i - at(start)) / SR;
    let s = 0;
    for (const p of PARTIALS) {
      // a touch of detune so the tolls shimmer instead of ringing dead flat
      const f = F0 * p.r * (1 + 0.0007 * Math.sin(2 * Math.PI * 0.9 * t + p.r));
      s += p.a * Math.exp(-t / p.d) * Math.sin(2 * Math.PI * f * t);
    }
    // strike transient: the clapper, not the ring
    const strike = Math.exp(-t / 0.012) * noise() * 0.5;
    buf[i] += (s * 0.11 + strike * 0.06) * gain;
  }
}

toll(0.18, 1.0);
toll(1.32, 0.72);

// ---- 3. groaning timber --------------------------------------------------

function creak(start, len, f, gain) {
  for (let i = at(start); i < Math.min(N, at(start + len)); i++) {
    const t = (i - at(start)) / SR;
    const e = Math.min(1, t / 0.09) * Math.exp(-t / (len * 0.45));
    // pitch sags as the timber gives
    const pitch = f * (1 - 0.18 * (t / len)) * (1 + 0.03 * Math.sin(2 * Math.PI * 7.3 * t));
    // a sawtooth-ish stack reads as wood far better than a sine
    let s = 0;
    for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * pitch * h * t) / h;
    // rubbed, not struck - modulate with slow noise
    const rub = 0.7 + 0.3 * Math.sin(2 * Math.PI * 11 * t + Math.sin(2 * Math.PI * 3.1 * t) * 2);
    buf[i] += s * e * rub * gain;
  }
}

creak(0.62, 0.9, 96, 0.05);
creak(1.95, 1.1, 74, 0.055);
creak(2.5, 0.7, 118, 0.03);

// ---- 4. hall tail --------------------------------------------------------

/** Schroeder reverb: four combs in parallel, then two allpasses in series. */
function reverb(src, mix) {
  const combs = [
    { d: 1557, g: 0.82 },
    { d: 1617, g: 0.81 },
    { d: 1491, g: 0.83 },
    { d: 1422, g: 0.8 }
  ].map((c) => ({ ...c, buf: new Float64Array(c.d), i: 0 }));

  const allpass = [
    { d: 225, g: 0.5 },
    { d: 556, g: 0.5 }
  ].map((a) => ({ ...a, buf: new Float64Array(a.d), i: 0 }));

  const out = new Float64Array(src.length);
  for (let n = 0; n < src.length; n++) {
    let wet = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.buf[c.i] = src[n] + y * c.g;
      c.i = (c.i + 1) % c.d;
      wet += y;
    }
    wet *= 0.25;

    for (const a of allpass) {
      const y = a.buf[a.i];
      const v = wet + y * a.g;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.d;
      wet = y - v * a.g;
    }

    out[n] = src[n] * (1 - mix) + wet * mix;
  }
  return out;
}

let mixed = reverb(buf, 0.34);
// take the very top off so the tail sits behind the fleet rather than hissing
mixed = lowpass(mixed, 7200);

// ---- fades, normalise, write --------------------------------------------

const fadeIn = at(0.02);
const fadeOut = at(0.5);
for (let i = 0; i < N; i++) {
  if (i < fadeIn) mixed[i] *= i / fadeIn;
  const tail = N - i;
  if (tail < fadeOut) mixed[i] *= (tail / fadeOut) ** 1.6;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mixed[i]));
const target = 0.695; // tuned so RMS lands on battleship_tentacle.wav, the closest cue
const gain = peak > 0 ? target / peak : 1;

const data = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  let v = mixed[i] * gain;
  v = Math.max(-1, Math.min(1, v));
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);      // PCM
header.writeUInt16LE(1, 22);      // mono
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28); // byte rate
header.writeUInt16LE(2, 32);      // block align
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

const out = process.argv[2] || "battleship_dutchman.wav";
writeFileSync(out, Buffer.concat([header, data]));
console.log(
  "wrote", out,
  "-", (DUR).toFixed(2) + "s,",
  ((44 + data.length) / 1024).toFixed(0) + " KB,",
  "peak before normalise", peak.toFixed(3)
);
