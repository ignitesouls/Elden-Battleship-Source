/**
 * The water the draw happens on: a night sea, and Leyndell on the far shore
 * under the Erdtree.
 *
 * Canvas rather than DOM or SVG because none of it is content - it is weather.
 * Nothing here is clickable, nothing here is read by a screen reader, and the
 * whole thing redraws every frame anyway, so the cheapest surface wins.
 *
 * The ships are NOT drawn here; they are DOM nodes over the top, so their
 * nameplates get real text rendering and can be selected and read.
 */

const BANDS = [
  { y: 0.3, amp: 3.5, len: 250, spd: 0.011, fill: "#0b1e2b" },
  { y: 0.48, amp: 5.5, len: 195, spd: 0.02, fill: "#102b3c" },
  { y: 0.68, amp: 7.5, len: 152, spd: 0.032, fill: "#123145" },
  { y: 0.88, amp: 9.5, len: 118, spd: 0.047, fill: "#16394f" },
];

/**
 * Leyndell, as stepped boxes: ziggurat tiers, drummed domes and gilded spires,
 * each with a thin gold line along its roof so a near-black skyline still
 * reads as a gold city.
 *
 * [xFrac on its ridge, depth row, width, height, kind]
 */
const CITY: [number, number, number, number, string][] = [
  [-0.88, 0, 0.7, 0.26, "tier"], [-0.74, 0, 0.8, 0.2, "dome"], [-0.6, 0, 0.5, 0.48, "spire"],
  [-0.46, 0, 0.9, 0.24, "tier"], [-0.32, 0, 0.6, 0.34, "tower"], [0.32, 0, 0.6, 0.32, "tower"],
  [0.46, 0, 0.9, 0.22, "tier"], [0.6, 0, 0.5, 0.5, "spire"], [0.74, 0, 0.8, 0.26, "dome"],
  [0.88, 0, 0.7, 0.22, "tier"],

  [-0.78, 1, 0.9, 0.24, "tier"], [-0.58, 1, 0.55, 0.44, "spire"], [-0.36, 1, 1.0, 0.28, "dome"],
  [-0.14, 1, 0.8, 0.34, "tier"], [0.16, 1, 0.9, 0.26, "dome"], [0.38, 1, 0.55, 0.46, "spire"],
  [0.6, 1, 0.9, 0.24, "tier"], [0.8, 1, 0.8, 0.28, "tower"],

  [-0.52, 2, 0.9, 0.3, "tier"], [-0.3, 2, 0.62, 0.58, "spire"],
  [0.0, 2, 1.75, 0.46, "dome"],
  [0.3, 2, 0.62, 0.56, "spire"], [0.52, 2, 0.9, 0.28, "tier"],
];

const GOLD_TRIM = "rgba(216, 174, 98, 0.55)";

export type PropKind = "bottle" | "tentacle" | "patches" | "dutchman";

export interface PropHit {
  kind: PropKind;
  /** Where it was, in stage px, so a bubble can be put over it. */
  x: number;
  y: number;
}

export interface Scene {
  resize(): void;
  draw(ms: number): void;
  setPresenting(on: boolean): void;
  /** Where the waterline sits, in px, for laying ships out on the water. */
  horizon(): number;
  /** Consumes the topmost prop under the point, if there is one. */
  hitTest(x: number, y: number): PropHit | null;
}

export function createScene(canvas: HTMLCanvasElement, host: HTMLElement): Scene {
  const maybeCtx = canvas.getContext("2d");
  if (maybeCtx === null) throw new Error("fleet draw: no 2d context");
  // Rebound so the null check holds inside every closure below, rather than
  // being re-widened at each function boundary.
  const ctx: CanvasRenderingContext2D = maybeCtx;

  let W = 0;
  let H = 0;
  let hz = 0;
  let presenting = false;

  // Deterministic noise, reseeded every frame so the tree never crawls.
  let seed = 1;
  function sr(): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  function resize(): void {
    const r = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hz = H * 0.24;
  }

  /* ---- the far shore ---------------------------------------------------- */

  function sampleQ(
    x0: number, y0: number, qx: number, qy: number, x1: number, y1: number, n: number,
  ): [number, number][] {
    const p: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = 1 - u;
      p.push([v * v * x0 + 2 * v * u * qx + u * u * x1, v * v * y0 + 2 * v * u * qy + u * u * y1]);
    }
    return p;
  }

  /** Fills a curve as a tapering ribbon - roots, necks, anything organic. */
  function taperFill(pts: [number, number][], w0: number, w1: number, fill: string): void {
    const n = pts.length;
    const norm = (i: number): [number, number] => {
      const a = pts[Math.max(i - 1, 0)];
      const b = pts[Math.min(i + 1, n - 1)];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    };
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const w = w0 + (w1 - w0) * (i / (n - 1));
      const nn = norm(i);
      const x = pts[i][0] + nn[0] * w;
      const y = pts[i][1] + nn[1] * w;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let j = n - 1; j >= 0; j--) {
      const w = w0 + (w1 - w0) * (j / (n - 1));
      const nn = norm(j);
      ctx.lineTo(pts[j][0] - nn[0] * w, pts[j][1] - nn[1] * w);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function cityShape(kind: string, x: number, base: number, w: number, h: number): void {
    ctx.beginPath();

    if (kind === "dome") {
      ctx.moveTo(x - w / 2, base);
      ctx.lineTo(x - w / 2, base - h);
      ctx.bezierCurveTo(x - w * 0.78, base - h - w * 0.38, x - w * 0.3, base - h - w * 0.82, x, base - h - w * 0.98);
      ctx.bezierCurveTo(x + w * 0.3, base - h - w * 0.82, x + w * 0.78, base - h - w * 0.38, x + w / 2, base - h);
      ctx.lineTo(x + w / 2, base);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = GOLD_TRIM;
      ctx.fillRect(x - w / 2, base - h - 1, w, 1.2);
      ctx.fillRect(x - w * 0.035, base - h - w * 1.18, w * 0.07, w * 0.2);
      return;
    }

    if (kind === "spire") {
      const s1 = h * 0.45;
      const s2 = h * 0.78;
      ctx.rect(x - w / 2, base - s1, w, s1);
      ctx.rect(x - w * 0.36, base - s2, w * 0.72, s2 - s1);
      ctx.rect(x - w * 0.24, base - h, w * 0.48, h - s2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - w * 0.24, base - h);
      ctx.lineTo(x, base - h - w * 1.6);
      ctx.lineTo(x + w * 0.24, base - h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = GOLD_TRIM;
      ctx.fillRect(x - w / 2, base - s1 - 1, w, 1.2);
      ctx.fillRect(x - w * 0.36, base - s2 - 1, w * 0.72, 1.2);
      ctx.fillRect(x - w * 0.24, base - h - 1, w * 0.48, 1.2);
      return;
    }

    if (kind === "tier") {
      const steps = 3;
      for (let s = 0; s < steps; s++) {
        const sw = w * (1 - s * 0.26);
        ctx.fillRect(x - sw / 2, base - h * ((s + 1) / steps), sw, h / steps + 1);
      }
      ctx.fillStyle = GOLD_TRIM;
      for (let g = 0; g < steps; g++) {
        const gw = w * (1 - g * 0.26);
        ctx.fillRect(x - gw / 2, base - h * ((g + 1) / steps) - 1, gw, 1.2);
      }
      return;
    }

    // battlemented tower
    const m = w / 6;
    ctx.moveTo(x - w / 2, base);
    ctx.lineTo(x - w / 2, base - h - m);
    for (let q = 0; q < 3; q++) {
      const qx = x - w / 2 + (w / 3) * q;
      ctx.lineTo(qx + m, base - h - m);
      ctx.lineTo(qx + m, base - h);
      ctx.lineTo(qx + w / 3, base - h);
      ctx.lineTo(qx + w / 3, base - h - m);
    }
    ctx.lineTo(x + w / 2, base - h - m);
    ctx.lineTo(x + w / 2, base);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = GOLD_TRIM;
    ctx.fillRect(x - w / 2, base - h - 1, w, 1.2);
  }

  /**
   * Dragon Gransax, still pinned where he fell. He is the one thing on the
   * skyline taller than the city, which is the point of him being there.
   */
  function gransax(x: number, groundY: number, h: number): void {
    const DARK = "#02070c";
    ctx.fillStyle = DARK;

    taperFill(
      sampleQ(x - h * 0.92, groundY - h * 0.16, x - h * 0.6, groundY + h * 0.04, x - h * 0.16, groundY - h * 0.04, 14),
      h * 0.012, h * 0.07, DARK,
    );

    ctx.beginPath();
    ctx.ellipse(x - h * 0.04, groundY - h * 0.1, h * 0.24, h * 0.11, -0.1, 0, Math.PI * 2);
    ctx.fill();

    // wing: leading edge out to the longest strut, then a scalloped trailing
    // edge sagging back between the fingers. In that order, or the membrane
    // closes into a solid shield.
    const wx = x - h * 0.06;
    const wy = groundY - h * 0.14;
    const fingers: [number, number][] = [[-0.1, -0.78], [-0.3, -0.6], [-0.44, -0.3]];
    ctx.beginPath();
    ctx.moveTo(wx, wy);
    ctx.lineTo(wx + h * fingers[0][0], wy + h * fingers[0][1]);
    for (let f = 0; f < fingers.length - 1; f++) {
      const a = fingers[f];
      const b = fingers[f + 1];
      ctx.quadraticCurveTo(
        wx + h * ((a[0] + b[0]) / 2 + 0.06), wy + h * ((a[1] + b[1]) / 2 + 0.1),
        wx + h * b[0], wy + h * b[1],
      );
    }
    const last = fingers[fingers.length - 1];
    ctx.quadraticCurveTo(wx + h * (last[0] / 2 + 0.06), wy + h * (last[1] / 2 + 0.1), wx, wy);
    ctx.closePath();
    ctx.fill();

    const neck = sampleQ(x + h * 0.14, groundY - h * 0.14, x + h * 0.16, groundY - h * 0.7, x + h * 0.46, groundY - h * 0.88, 16);
    taperFill(neck, h * 0.062, h * 0.02, DARK);

    const [hx, hy] = neck[neck.length - 1];
    ctx.beginPath();
    ctx.moveTo(hx - h * 0.03, hy - h * 0.025);
    ctx.lineTo(hx + h * 0.06, hy - h * 0.05);
    ctx.lineTo(hx + h * 0.2, hy - h * 0.022);
    ctx.lineTo(hx + h * 0.21, hy + h * 0.004);
    ctx.lineTo(hx + h * 0.07, hy + h * 0.012);
    ctx.lineTo(hx + h * 0.17, hy + h * 0.06);
    ctx.lineTo(hx + h * 0.03, hy + h * 0.035);
    ctx.lineTo(hx - h * 0.03, hy + h * 0.03);
    ctx.closePath();
    ctx.fill();

    // the spear, driven through and standing clear on both sides. The only
    // gold thing out here, so it carries the eye.
    const sx0 = x - h * 0.34;
    const sy0 = groundY + h * 0.2;
    const sx1 = x + h * 0.42;
    const sy1 = groundY - h * 0.98;
    const sl = Math.hypot(sx1 - sx0, sy1 - sy0);
    const ux = (sx1 - sx0) / sl;
    const uy = (sy1 - sy0) / sl;
    const nx = -uy * h * 0.015;
    const ny = ux * h * 0.015;

    ctx.beginPath();
    ctx.moveTo(sx0 + nx, sy0 + ny);
    ctx.lineTo(sx1 + nx, sy1 + ny);
    ctx.lineTo(sx1 - nx, sy1 - ny);
    ctx.lineTo(sx0 - nx, sy0 - ny);
    ctx.closePath();
    ctx.fillStyle = "rgba(196, 164, 106, 0.9)";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(sx1 + ux * h * 0.16, sy1 + uy * h * 0.16);
    ctx.lineTo(sx1 + nx * 3.4, sy1 + ny * 3.4);
    ctx.lineTo(sx1 - ux * h * 0.07, sy1 - uy * h * 0.07);
    ctx.lineTo(sx1 - nx * 3.4, sy1 - ny * 3.4);
    ctx.closePath();
    ctx.fill();
  }

  function shore(t: number): void {
    const baseY = hz + 1;
    const cx = W * 0.5;
    const top = Math.max(presenting ? 84 : 66, hz * 0.14);
    const totalH = baseY - top;
    if (totalH < 54) return;

    seed = 20250831;

    const cityH = totalH * 0.36;
    const forkY = baseY - cityH - totalH * 0.05;
    const crownY = top + (forkY - top) * 0.44;
    const landW = Math.min(W * 0.76, totalH * 4.4);
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.018);

    // the glow it all sits inside
    const halo = ctx.createRadialGradient(cx, crownY, totalH * 0.03, cx, crownY, totalH * 0.95);
    halo.addColorStop(0, `rgba(255, 230, 158, ${(0.3 + pulse * 0.09).toFixed(3)})`);
    halo.addColorStop(0.34, `rgba(228, 182, 98, ${(0.12 + pulse * 0.04).toFixed(3)})`);
    halo.addColorStop(1, "rgba(201, 165, 95, 0)");
    ctx.fillStyle = halo;
    ctx.fillRect(cx - totalH, crownY - totalH, totalH * 2, totalH * 2);

    // a few soft shafts, fading out along their length
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let r = 0; r < 9; r++) {
      const ang = -Math.PI * 0.86 + ((r + 0.5) / 9) * Math.PI * 0.72;
      const len = totalH * (0.62 + sr() * 0.5) * (0.9 + 0.1 * Math.sin(t * 0.012 + r));
      const spread = totalH * 0.018;
      const ex = cx + Math.cos(ang) * len;
      const ey = crownY + Math.sin(ang) * len;
      const lg = ctx.createLinearGradient(cx, crownY, ex, ey);
      lg.addColorStop(0, "rgba(246, 216, 148, 0.10)");
      lg.addColorStop(0.45, "rgba(238, 200, 120, 0.045)");
      lg.addColorStop(1, "rgba(226, 188, 116, 0)");
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(cx, crownY);
      ctx.lineTo(ex - Math.sin(ang) * spread, ey + Math.cos(ang) * spread);
      ctx.lineTo(ex + Math.sin(ang) * spread, ey - Math.cos(ang) * spread);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // trunk
    const trunkW = totalH * 0.082;
    ctx.fillStyle = "rgba(176, 138, 72, 0.9)";
    ctx.beginPath();
    ctx.moveTo(cx - trunkW, baseY);
    ctx.quadraticCurveTo(cx - trunkW * 0.62, forkY + totalH * 0.1, cx - trunkW * 0.46, forkY);
    ctx.lineTo(cx + trunkW * 0.46, forkY);
    ctx.quadraticCurveTo(cx + trunkW * 0.62, forkY + totalH * 0.1, cx + trunkW, baseY);
    ctx.closePath();
    ctx.fill();

    // a recursive fork, so it reads as a tree rather than a starburst
    const tips: [number, number, number][] = [];
    ctx.strokeStyle = "rgba(206, 168, 96, 0.85)";
    ctx.lineCap = "round";

    const limb = (x: number, y: number, ang: number, len: number, wdt: number, depth: number, bend: number, glow: number): void => {
      const ex = x + Math.cos(ang) * len;
      const ey = y + Math.sin(ang) * len;
      ctx.lineWidth = Math.max(0.7, wdt);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + Math.cos(ang - bend) * len * 0.6, y + Math.sin(ang - bend) * len * 0.6, ex, ey);
      ctx.stroke();
      if (depth <= 0) {
        tips.push([ex, ey, len * glow]);
        return;
      }
      const fan = 0.27 + sr() * 0.15;
      limb(ex, ey, ang - fan, len * (0.68 + sr() * 0.1), wdt * 0.64, depth - 1, bend, glow);
      limb(ex, ey, ang + fan, len * (0.68 + sr() * 0.1), wdt * 0.64, depth - 1, bend, glow);
      if (depth >= 2 && sr() > 0.35) {
        limb(ex, ey, ang + (sr() - 0.5) * 0.5, len * 0.55, wdt * 0.5, depth - 1, bend, glow);
      }
    };

    const boughs = 5;
    for (let b = 0; b < boughs; b++) {
      limb(cx, forkY, -Math.PI / 2 + (b - (boughs - 1) / 2) * 0.42, (forkY - crownY) * 0.86, trunkW * 0.9, 3, 0.14, 1);
    }

    // the lateral boughs, kept inside the crown's own span - any further and
    // they stop reading as a tree and start reading as wires across the sky
    const laterals: [number, number, number][] = [[-1, 0.12, 0.46], [1, 0.18, 0.42], [-1, 0.44, 0.3], [1, 0.5, 0.32]];
    for (const [dir, from, reach] of laterals) {
      limb(cx + dir * trunkW * 0.4, forkY - (forkY - crownY) * from, dir > 0 ? -0.2 : Math.PI + 0.2,
        totalH * reach, trunkW * 0.55, 2, dir * 0.4, 0.16);
    }

    // canopy: light hung on the branch tips
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const [tx, ty, tl] of tips) {
      const br = tl * (1.6 + sr() * 0.75);
      const g = ctx.createRadialGradient(tx, ty, 0, tx, ty, br);
      g.addColorStop(0, `rgba(255, 240, 190, ${(0.3 + pulse * 0.09).toFixed(3)})`);
      g.addColorStop(0.45, "rgba(232, 190, 104, 0.17)");
      g.addColorStop(1, "rgba(201, 165, 95, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(tx, ty, br, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    /**
     * Three ridges, one per depth row, each actually drawn. A back row is not
     * the front hill with its buildings nudged upward - that is exactly what
     * leaves them hanging in the air. It is its own higher, narrower ridge
     * behind, and its buildings stand on THAT surface with no lift at all.
     */
    const hillW = landW * 0.62;
    const ridgeW = (back: number): number => hillW * (1 - back * 0.13);
    const ridgeY = (back: number, px: number): number => {
      const w = ridgeW(back);
      const u = (px - cx) / w;
      if (Math.abs(u) >= 1) return baseY + 3;
      return baseY + 3 - (cityH * (0.5 + back * 0.13) + 3) * Math.cos((u * Math.PI) / 2);
    };

    const rows = [
      { back: 2, ground: "#0c1a27", build: "#16283a" },
      { back: 1, ground: "#07121d", build: "#0f1e2d" },
      { back: 0, ground: "#03080e", build: "#08141f" },
    ];

    const buildingX = (c: number): number => cx + CITY[c][0] * ridgeW(rows[CITY[c][1]].back) * 0.84;

    for (let rw = 0; rw < rows.length; rw++) {
      const back = rows[rw].back;
      const w = ridgeW(back);
      ctx.fillStyle = rows[rw].ground;
      ctx.beginPath();
      ctx.moveTo(cx - w, baseY + 3);
      for (let hp = -w; hp <= w; hp += 5) ctx.lineTo(cx + hp, ridgeY(back, cx + hp));
      ctx.lineTo(cx + w, baseY + 3);
      ctx.closePath();
      ctx.fill();

      // great roots, riding the near ridge under the near row only
      if (back === 0) {
        const roots: [number, number, number][] = [
          [-1, 0.86, 0.3], [-1, 0.52, 0.44], [1, 0.9, 0.28], [1, 0.56, 0.46], [-1, 0.3, 0.5], [1, 0.32, 0.52],
        ];
        for (const [d, run, lift] of roots) {
          const R = ridgeW(0) * run;
          const midX = cx + d * R * 0.45;
          const endX = cx + d * R;
          taperFill(
            sampleQ(cx, ridgeY(0, cx) + cityH * 0.06, midX, ridgeY(0, midX) - cityH * lift * 0.4, endX, ridgeY(0, endX) + 2, 12),
            trunkW * 0.3, trunkW * 0.05, "rgba(88, 68, 36, 0.6)",
          );
        }
      }

      for (let c = 0; c < CITY.length; c++) {
        if (CITY[c][1] !== rw) continue;
        ctx.fillStyle = rows[rw].build;
        const bx = buildingX(c);
        cityShape(CITY[c][4], bx, ridgeY(back, bx), totalH * 0.055 * CITY[c][2] * (1 + rw * 0.12), cityH * CITY[c][3]);
      }
    }

    const gx = cx + ridgeW(0) * 0.52;
    gransax(gx, ridgeY(0, gx), cityH);

    // viaduct, following the near ridge
    const vW = ridgeW(0) * 0.7;
    const arches = 12;
    const aW = (vW * 2) / arches;
    ctx.fillStyle = "#02060b";
    ctx.beginPath();
    for (let vp = -vW; vp <= vW; vp += 5) ctx.lineTo(cx + vp, ridgeY(0, cx + vp) - cityH * 0.15);
    for (let vq = vW; vq >= -vW; vq -= 5) ctx.lineTo(cx + vq, ridgeY(0, cx + vq) - cityH * 0.115);
    ctx.closePath();
    ctx.fill();
    for (let a = 0; a < arches; a++) {
      const ax = cx - vW + aW * (a + 0.5);
      ctx.fillRect(ax - aW * 0.12, ridgeY(0, ax) - cityH * 0.12, aW * 0.24, cityH * 0.12);
    }

    // windows, placed from each building's own width so they land inside it
    ctx.fillStyle = "rgba(255, 206, 130, 0.6)";
    const dot = Math.max(0.9, totalH * 0.0055);
    for (let wI = 0; wI < CITY.length; wI++) {
      if (CITY[wI][4] === "spire") continue;
      const row = rows[CITY[wI][1]];
      const bw = totalH * 0.055 * CITY[wI][2] * (1 + CITY[wI][1] * 0.12);
      const wx2 = buildingX(wI);
      const wbase = ridgeY(row.back, wx2);
      const wh = cityH * CITY[wI][3];
      if (wh < dot * 4) continue;
      for (let k = 0; k < 2; k++) {
        for (let col = -1; col <= 1; col++) {
          if (Math.abs(col) * dot * 2.2 > bw * 0.34) continue;
          ctx.fillRect(wx2 + col * bw * 0.26 - dot / 2, wbase - wh * (0.26 + k * 0.3), dot, dot * 1.5);
        }
      }
    }
  }

  /* ---- things that bob past ---------------------------------------------- */

  /**
   * Ambient props, and the one part of this that is deliberately NOT shared.
   *
   * The draw is synchronised because it is the result; a bottle drifting past
   * is weather. Syncing them would mean a message per spawn for no gain, and
   * worse, one person clicking a bottle would take it away from everybody
   * else. So every viewer gets their own, and pops their own.
   */
  interface Prop {
    kind: PropKind;
    born: number;
    die: number;
    dir: 1 | -1;
    x: number;
    y: number;
    span: number;
    h: number;
    curl: number;
    /** hit box, refreshed every frame while it draws */
    hx: number;
    hy: number;
    hr: number;
    used: boolean;
    struck: boolean;
  }

  // Weighted so bottles are common and the Dutchman is a rare sighting.
  const KINDS: { kind: PropKind; weight: number; life: number }[] = [
    { kind: "bottle", weight: 42, life: 52 },
    { kind: "tentacle", weight: 26, life: 10 },
    { kind: "patches", weight: 18, life: 11 },
    { kind: "dutchman", weight: 14, life: 46 },
  ];

  let props: Prop[] = [];
  let nextPropAt = 4;

  function spawnProp(now: number): void {
    const seaTop = hz + (H - hz) * 0.34;
    const seaH = H - seaTop;

    let roll = Math.random() * KINDS.reduce((a, k) => a + k.weight, 0);
    let pick = KINDS[0];
    for (const k of KINDS) {
      roll -= k.weight;
      if (roll <= 0) {
        pick = k;
        break;
      }
    }

    const p: Prop = {
      kind: pick.kind,
      born: now,
      die: now + pick.life,
      dir: Math.random() < 0.5 ? 1 : -1,
      x: W * 0.12 + Math.random() * W * 0.76,
      y: seaTop + seaH * (0.16 + Math.random() * 0.6),
      span: 0,
      h: 0,
      curl: 0,
      hx: -1e4,
      hy: -1e4,
      hr: 0,
      used: false,
      struck: false,
    };

    if (pick.kind === "bottle") {
      p.y = seaTop + seaH * (0.1 + Math.random() * 0.42);
      p.span = (W + 120) / pick.life;
    } else if (pick.kind === "tentacle") {
      p.y = seaTop + seaH * (0.3 + Math.random() * 0.5);
      p.h = 44 + Math.random() * 42;
      p.curl = (Math.random() - 0.5) * 1.3;
    } else if (pick.kind === "patches") {
      p.y = seaTop + seaH * (0.34 + Math.random() * 0.5);
      p.h = 34 + Math.random() * 16;
    } else {
      // the Dutchman keeps to the far water, up near the horizon
      p.y = seaTop + seaH * (0.02 + Math.random() * 0.2);
      p.span = (W + 260) / pick.life;
    }

    props.push(p);
  }

  function updateProps(now: number): void {
    if (now >= nextPropAt) {
      nextPropAt = now + 6 + Math.random() * 10;
      if (props.length < 3) spawnProp(now);
    }
    props = props.filter((p) => now < p.die);
  }

  function drawBottle(p: Prop, now: number): void {
    const age = now - p.born;
    const x = p.dir > 0 ? -60 + age * p.span : W + 60 - age * p.span;
    const y = p.y + Math.sin(age * 1.9) * 2.6;

    p.hx = x;
    p.hy = y;
    p.hr = 22;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(age * 1.5) * 0.14);
    ctx.scale(p.dir, 1);

    ctx.strokeStyle = "rgba(180, 220, 230, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 5, 15, 3.2, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "rgba(110, 178, 156, 0.62)";
    ctx.strokeStyle = "rgba(206, 238, 226, 0.5)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.roundRect(-10, -4.5, 17, 9, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(6, -2.4, 5, 4.8);
    ctx.fillStyle = "#b98a4e";
    ctx.fillRect(10, -2.6, 2.6, 5.2);
    ctx.fillStyle = "rgba(240, 232, 208, 0.85)";
    ctx.fillRect(-6, -2.4, 8, 4.8);
    ctx.restore();
  }

  function drawTentacle(p: Prop, now: number): void {
    const age = now - p.born;
    const life = p.die - p.born;
    let env = age < 1.6 ? age / 1.6 : age > life - 1.8 ? Math.max(0, (life - age) / 1.8) : 1;
    env = env * env * (3 - 2 * env);
    if (env <= 0.01) return;

    let h = p.h * env;

    p.hx = p.x + p.curl * 18;
    p.hy = p.y - h * 0.55;
    p.hr = Math.max(18, h * 0.55);

    // a struck tentacle recoils and goes back under early
    if (p.struck) {
      p.die = Math.min(p.die, now + 1.1);
      h *= 0.86;
    }

    const N = 11;
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const yy = p.y - h * u;
      const xx = p.x + Math.sin(u * 2.4 + age * 1.4) * u * 13 + p.curl * u * u * 30;
      const w = ((1 - u) * 0.82 + 0.1) * 6.5;
      left.push([xx - w, yy]);
      right.push([xx + w, yy]);
    }

    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let a = 1; a <= N; a++) ctx.lineTo(left[a][0], left[a][1]);
    for (let b = N; b >= 0; b--) ctx.lineTo(right[b][0], right[b][1]);
    ctx.closePath();
    ctx.fillStyle = "rgba(11, 38, 42, 0.94)";
    ctx.fill();
    ctx.strokeStyle = `rgba(126, 206, 190, ${(0.3 * env).toFixed(3)})`;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.fillStyle = `rgba(150, 214, 198, ${(0.34 * env).toFixed(3)})`;
    for (let s = 2; s < N - 1; s += 2) {
      ctx.beginPath();
      ctx.arc((left[s][0] + right[s][0]) / 2 - 1, left[s][1], Math.max(0.8, (1 - s / N) * 1.9), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = `rgba(180, 226, 220, ${(0.22 * env).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 2, 16 * env, 4 * env, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** An arm comes up out of the water and waves. */
  function drawPatches(p: Prop, now: number): void {
    const age = now - p.born;
    const life = p.die - p.born;
    let env = age < 0.9 ? age / 0.9 : age > life - 1 ? Math.max(0, life - age) : 1;
    env = Math.min(1, env);
    env = env * env * (3 - 2 * env);
    if (env <= 0.01) return;

    const h = p.h * env;
    const wave = Math.sin(age * 4.4) * 0.34;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(wave * 0.3);
    ctx.fillStyle = "#123240";
    ctx.beginPath();
    ctx.moveTo(-4.5, 4);
    ctx.lineTo(-3, -h);
    ctx.lineTo(3, -h);
    ctx.lineTo(4.5, 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#2c1f16";
    ctx.fillRect(-5.5, -h * 0.32, 11, h * 0.16);

    ctx.save();
    ctx.translate(0, -h);
    ctx.rotate(wave);
    ctx.fillStyle = "#123240";
    ctx.beginPath();
    ctx.roundRect(-6, -9, 12, 11, 3);
    ctx.fill();
    for (let f = 0; f < 4; f++) ctx.fillRect(-5.5 + f * 3.1, -14.5, 2.2, 6.5);
    ctx.fillRect(5, -8, 3.4, 2.4);
    ctx.restore();
    ctx.restore();

    ctx.strokeStyle = `rgba(180, 226, 220, ${(0.24 * env).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 3, 13 * env, 3.4 * env, 0, 0, Math.PI * 2);
    ctx.stroke();

    p.hx = p.x;
    p.hy = p.y - h * 0.7;
    p.hr = Math.max(16, h * 0.6);
  }

  /**
   * The Flying Dutchman: a tall ship that is mostly not there. Stroked outline
   * with barely any fill so the water shows through her, tattered canvas, and
   * a lamp at the masthead.
   */
  function drawDutchman(p: Prop, now: number): void {
    const age = now - p.born;
    const life = p.die - p.born;
    const fade = Math.min(age / 5, 1) * Math.min((life - age) / 5, 1);
    if (fade <= 0.01) return;

    const x = p.dir > 0 ? -130 + age * p.span : W + 130 - age * p.span;
    const y = p.y + Math.sin(age * 0.7) * 3;
    const a = fade * 0.85;

    p.hx = x;
    p.hy = y - 26;
    p.hr = 58;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(age * 0.55) * 0.035);
    ctx.scale(p.dir * 0.5, 0.5);
    ctx.globalAlpha = a;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(-78, 0);
    ctx.lineTo(74, 0);
    ctx.quadraticCurveTo(60, 34, 18, 36);
    ctx.lineTo(-46, 36);
    ctx.quadraticCurveTo(-74, 30, -78, 0);
    ctx.closePath();
    ctx.fillStyle = "rgba(143, 220, 196, 0.2)";
    ctx.fill();
    ctx.strokeStyle = "rgba(196, 242, 226, 0.85)";
    ctx.lineWidth = 2.2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-78, 0);
    ctx.lineTo(-72, -22);
    ctx.lineTo(-44, -22);
    ctx.lineTo(-44, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(70, -4);
    ctx.lineTo(104, -20);
    ctx.stroke();

    const masts: [number, number][] = [[-34, -76], [6, -96], [46, -70]];
    for (const [mx, mtop] of masts) {
      ctx.strokeStyle = "rgba(196, 242, 226, 0.75)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, mtop);
      ctx.stroke();

      const top = mtop + 12;
      const bot = -14;
      ctx.beginPath();
      ctx.moveTo(mx - 22, top);
      ctx.lineTo(mx + 22, top);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(mx - 20, top);
      ctx.lineTo(mx + 20, top);
      ctx.lineTo(mx + 16, bot);
      ctx.lineTo(mx + 6, bot - 10);
      ctx.lineTo(mx - 2, bot - 1);
      ctx.lineTo(mx - 12, bot - 12);
      ctx.lineTo(mx - 17, bot);
      ctx.closePath();
      ctx.fillStyle = "rgba(223, 247, 236, 0.22)";
      ctx.fill();
      ctx.strokeStyle = "rgba(214, 244, 232, 0.6)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const lamp = 0.5 + 0.5 * Math.sin(age * 2.1);
    ctx.globalAlpha = a * (0.5 + lamp * 0.5);
    const lg = ctx.createRadialGradient(6, -100, 0, 6, -100, 26);
    lg.addColorStop(0, "rgba(244, 224, 138, 0.9)");
    lg.addColorStop(1, "rgba(244, 224, 138, 0)");
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(6, -100, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = a * 0.35;
    ctx.strokeStyle = "rgba(191, 240, 221, 0.6)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, y + 18, 46, 5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function hitTest(mx: number, my: number): PropHit | null {
    // topmost first, so the thing drawn last wins the click
    for (let i = props.length - 1; i >= 0; i--) {
      const p = props[i];
      if (p.used || p.hr === 0) continue;
      const dx = mx - p.hx;
      const dy = my - p.hy;
      if (dx * dx + dy * dy > p.hr * p.hr) continue;

      p.used = true;
      const now = performance.now() / 1000;
      if (p.kind === "tentacle") p.struck = true;
      // A bottle you have read drifts off; Patches ducks back under. The
      // Dutchman does not react and does not leave early - you only get the bell.
      if (p.kind === "bottle") p.die = Math.min(p.die, now + 2.4);
      if (p.kind === "patches") p.die = Math.min(p.die, now + 1.4);
      return { kind: p.kind, x: p.hx, y: p.hy };
    }
    return null;
  }

  /* ---- the sea ---------------------------------------------------------- */

  function band(b: number, t: number): void {
    const cfg = BANDS[b];
    const baseY = hz + (H - hz) * cfg.y;
    const phase = t * cfg.spd;
    const at = (x: number): number =>
      baseY + Math.sin(x / cfg.len + phase) * cfg.amp + Math.sin(x / (cfg.len * 0.41) + phase * 1.7) * cfg.amp * 0.34;

    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, baseY);
    for (let x = 0; x <= W; x += 6) ctx.lineTo(x, at(x));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = cfg.fill;
    ctx.fill();

    ctx.beginPath();
    for (let x = 0; x <= W; x += 6) {
      if (x === 0) ctx.moveTo(x, at(x));
      else ctx.lineTo(x, at(x));
    }
    ctx.strokeStyle = `rgba(160, 205, 222, ${0.05 + b * 0.03})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function draw(ms: number): void {
    const t = ms / 16.666;
    ctx.clearRect(0, 0, W, H);

    const sky = ctx.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, "#08131c");
    sky.addColorStop(0.72, "#0d2130");
    sky.addColorStop(1, "#1b4053");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hz);

    shore(t);

    const glow = ctx.createLinearGradient(0, hz - 30, 0, hz + 4);
    glow.addColorStop(0, "rgba(201,165,95,0)");
    glow.addColorStop(1, "rgba(201,165,95,0.18)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, hz - 30, W, 34);

    ctx.fillStyle = "#0a1c28";
    ctx.fillRect(0, hz, W, H - hz);

    /**
     * The Erdtree laid out on the water. Not a column - a real light path
     * breaks into separate glints that widen as they come toward you and
     * wander with the swell, so it never shows an edge.
     */
    const pathH = (H - hz) * 0.5;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let gi = 0; gi < 26; gi++) {
      const u = (gi + 0.5) / 26;
      const gy = hz + pathH * u * u;
      const wob = Math.sin(u * 9 + t * 0.05) * 26 * u + Math.sin(u * 21 - t * 0.03) * 10 * u;
      const gw = (12 + u * 120) * (0.6 + 0.4 * Math.abs(Math.sin(u * 13 + t * 0.04)));
      const alpha = 0.19 * (1 - u * 0.85) * (0.55 + 0.45 * Math.sin(u * 17 + t * 0.06));
      if (alpha <= 0.002) continue;
      const lg = ctx.createLinearGradient(W * 0.5 + wob - gw / 2, 0, W * 0.5 + wob + gw / 2, 0);
      lg.addColorStop(0, "rgba(226, 188, 116, 0)");
      lg.addColorStop(0.5, `rgba(240, 208, 140, ${alpha.toFixed(3)})`);
      lg.addColorStop(1, "rgba(226, 188, 116, 0)");
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.ellipse(W * 0.5 + wob, gy, gw / 2, Math.max(1.2, 1.6 + u * 3.4), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    band(0, t);
    band(1, t);

    // Props sit between the far and near swell, so the front waves cut across
    // their bases and they read as being IN the water rather than on it.
    const now = ms / 1000;
    updateProps(now);
    for (const p of props) {
      if (p.kind === "bottle") drawBottle(p, now);
      else if (p.kind === "tentacle") drawTentacle(p, now);
      else if (p.kind === "patches") drawPatches(p, now);
      else drawDutchman(p, now);
    }

    band(2, t);
    band(3, t);
  }

  return {
    resize,
    draw,
    setPresenting: (on: boolean) => {
      presenting = on;
    },
    horizon: () => hz,
    hitTest,
  };
}
