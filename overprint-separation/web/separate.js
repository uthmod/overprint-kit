// separate.js — 分色 in the browser: a JavaScript port of ../separate.py (same constants, same steps, same order),
// so a plate made here matches one made in Claude Code. One image + a four-ink palette.json → a printable colour per
// pixel at 3× the image size (labels 0–15 are the palette's colours, each its own ink mask; screened colours follow);
// printMasks turns them into ink masks with halftone dots, and plate b is (mask >> b) & 1 (bit 0 = the first ink printed).
// Plain script: window.OverprintSeparate in a page, module.exports in Node (the parity check against separate.py).
(function (root) {
  'use strict';

  const SCALE = 3;
  const INK_PENALTY = 8; // dE per extra overprinted ink for off-palette pixels (the Python --penalty)
  const L_WEIGHT = 0.3, EXACT_DE = 4, EDGE_DE = 3, TIE_DE = 12, MIN_AREA = 12;
  const FINE_PX = 11, FINE_DE = 6, FINE_MIN = 4;
  const BLEND_R = 3, BLEND_RGB = 20; // soft edges: see edgePrefer
  const PREC = 1 << 22; // Pillow's fixed-point resample precision
  const bits = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
  const N_INKS = Array.from({ length: 16 }, (_, m) => Math.max(bits(m) - 1, 0)); // paper and solo inks are free
  // halftone screens: a screened colour is the art's own colour, printed as an ink mask in dots (see separate.py)
  const LPI = 80, DPI = 600;
  const SCREEN_COS = [0.9659258262890683, 0.25881904510252074, 0.7071067811865476, 1.0];
  const SCREEN_SIN = [0.25881904510252074, 0.9659258262890683, 0.7071067811865476, 0.0];

  // ---------- colour: sRGB → Lab (D65), the matrix and white point of separate.py ----------
  const lin = (v) => { const c = v / 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const LIN = Float64Array.from({ length: 256 }, (_, v) => lin(v));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function labOf(R, G, B, out, o) {
    const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
    const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    out[o] = 116 * fy - 16; out[o + 1] = 500 * (fx - fy); out[o + 2] = 200 * (fy - fz);
  }
  const labInt = (r, g, b, out, o) => labOf(LIN[r], LIN[g], LIN[b], out, o); // 0–255 integers
  const labF = (r, g, b, out, o) => labOf(lin(r), lin(g), lin(b), out, o); // any 0–255 value

  /** A palette.json (from 疊印色盤, the matrix page, or the kit email) → names + the 16 printable colours by ink mask.
   *  masks/pcts: each colour's ink mask and screen (0 = solid); withScreens adds screened colours after the 16. */
  function parsePalette(p) {
    if (!p || !Array.isArray(p.inks) || !Array.isArray(p.cells)) throw new Error('這不是 palette.json：找不到 inks 和 cells');
    if (p.inks.length !== 4 || p.cells.length !== 16) throw new Error(`分色需要 4 支墨的色盤（這個有 ${p.inks.length} 支）`);
    const rgb = new Float64Array(48), lab = new Float64Array(48);
    const field = (x, k) => (x && typeof x === 'object' ? x[k] : x); // older palette.json files: plain "E1E3E0" and "720U"
    p.cells.forEach((c, m) => {
      const hex = String(field(c, 'hex')).replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`palette.json 第 ${m + 1} 格的色碼看不懂：${field(c, 'hex')}`);
      for (let k = 0; k < 3; k++) rgb[m * 3 + k] = parseInt(hex.slice(2 * k, 2 * k + 2), 16);
      labF(rgb[m * 3], rgb[m * 3 + 1], rgb[m * 3 + 2], lab, m * 3);
    });
    const masks = Int32Array.from({ length: 16 }, (_, m) => m), pcts = new Float64Array(16);
    return { name: String(p.name || ''), inks: p.inks.map((i) => String(field(i, 'name'))), rgb, lab, masks, pcts };
  }

  /** The palette plus screened colours: [{ rgb: [r, g, b], mask, pct }], the art's own colour printed as mask's inks in
   *  pct (0–1) dots. They become labels 16, 17, … (the Python --screen-colour). */
  function withScreens(p, list) {
    const K = 16 + list.length, rgb = new Float64Array(K * 3), lab = new Float64Array(K * 3);
    rgb.set(p.rgb.subarray(0, 48)); lab.set(p.lab.subarray(0, 48));
    const masks = new Int32Array(K), pcts = new Float64Array(K);
    masks.set(p.masks.subarray(0, 16)); pcts.set(p.pcts.subarray(0, 16));
    list.forEach((c, k) => {
      const j = 16 + k;
      for (let q = 0; q < 3; q++) rgb[j * 3 + q] = c.rgb[q];
      labF(c.rgb[0], c.rgb[1], c.rgb[2], lab, j * 3);
      masks[j] = c.mask; pcts[j] = c.pct;
    });
    return { ...p, rgb, lab, masks, pcts };
  }

  // ---------- nearest printable colour ----------
  const SC = new Float64Array(64), D = new Float64Array(64);
  /** Q: { lab, cost } for the candidate colours (cost = penalty × extra inks). Best label for one Lab colour; D[best] is
   *  left holding its dE. prefer (-1 = none) wins within TIE_DE, but never over a screened colour (label 16+) unless
   *  it is one too: those tell apart areas sharing an ink (a face beside the hair) that a soft boundary leaves in one shape.
   *  A pixel more than EXACT_DE darker than a screened colour never takes it (a screen prints paler than the solid ink). */
  function nearest(l, a, b, Q, prefer) {
    const P = Q.lab, C = Q.cost, K = C.length;
    let best = 0, bs = Infinity;
    for (let k = 0; k < K; k++) {
      const dl0 = l - P[3 * k];
      // lightness is asymmetric: a pixel LIGHTER than a candidate costs only L_WEIGHT (a pale tint still reads as its ink)
      const dl = dl0 > 0 ? L_WEIGHT * dl0 : dl0, da = a - P[3 * k + 1], db = b - P[3 * k + 2];
      const d = Math.sqrt(dl * dl + da * da + db * db);
      const sc = k >= 16 && dl0 < -EXACT_DE ? Infinity : d + (d > EXACT_DE ? C[k] : 0);
      D[k] = d; SC[k] = sc;
      if (sc < bs) { bs = sc; best = k; }
    }
    if (prefer >= 0 && SC[prefer] - bs < TIE_DE && (best < 16 || prefer >= 16)) best = prefer;
    return best;
  }

  // ---------- 3× upscale: Pillow's Lanczos (support 3, 22-bit fixed point, horizontal pass first, 8-bit between) ----------
  const sinc = (x) => (x === 0 ? 1 : Math.sin(x * Math.PI) / (x * Math.PI));
  const lanczos = (x) => (x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0);
  function coeffs(inSize, outSize) {
    const scale = inSize / outSize, fs = Math.max(scale, 1), support = 3 * fs, ks = Math.ceil(support) * 2 + 1;
    const lo = new Int32Array(outSize), n = new Int32Array(outSize), k = new Float64Array(outSize * ks), w = new Float64Array(ks);
    for (let xx = 0; xx < outSize; xx++) {
      const center = (xx + 0.5) * scale;
      let xmin = Math.trunc(center - support + 0.5); if (xmin < 0) xmin = 0;
      let xmax = Math.trunc(center + support + 0.5); if (xmax > inSize) xmax = inSize; xmax -= xmin;
      let ww = 0;
      for (let x = 0; x < xmax; x++) { w[x] = lanczos((x + xmin - center + 0.5) / fs); ww += w[x]; }
      for (let x = 0; x < xmax; x++) {
        const v = ww !== 0 ? w[x] / ww : w[x];
        k[xx * ks + x] = v < 0 ? Math.trunc(-0.5 + v * PREC) : Math.trunc(0.5 + v * PREC);
      }
      lo[xx] = xmin; n[xx] = xmax;
    }
    return { lo, n, k, ks };
  }
  const clip8 = (s) => { const v = Math.floor(s / PREC); return v < 0 ? 0 : v > 255 ? 255 : v; };
  function upscale(src, w, h, W, H) {
    const cx = coeffs(w, W), cy = coeffs(h, H), tmp = new Uint8Array(W * h * 3), out = new Uint8Array(W * H * 3);
    for (let y = 0; y < h; y++) {
      for (let X = 0; X < W; X++) {
        let s0 = PREC / 2, s1 = PREC / 2, s2 = PREC / 2;
        const base = (y * w + cx.lo[X]) * 3, kb = X * cx.ks;
        for (let t = 0; t < cx.n[X]; t++) {
          const kk = cx.k[kb + t], v = base + t * 3;
          s0 += src[v] * kk; s1 += src[v + 1] * kk; s2 += src[v + 2] * kk;
        }
        const o = (y * W + X) * 3;
        tmp[o] = clip8(s0); tmp[o + 1] = clip8(s1); tmp[o + 2] = clip8(s2);
      }
    }
    for (let Y = 0; Y < H; Y++) {
      const kb = Y * cy.ks, y0 = cy.lo[Y], ny = cy.n[Y];
      for (let X = 0; X < W; X++) {
        let s0 = PREC / 2, s1 = PREC / 2, s2 = PREC / 2;
        for (let t = 0; t < ny; t++) {
          const kk = cy.k[kb + t], v = ((y0 + t) * W + X) * 3;
          s0 += tmp[v] * kk; s1 += tmp[v + 1] * kk; s2 += tmp[v + 2] * kk;
        }
        const o = (Y * W + X) * 3;
        out[o] = clip8(s0); out[o + 1] = clip8(s1); out[o + 2] = clip8(s2);
      }
    }
    return out;
  }

  // ---------- connected components (OpenCV's numbering: raster order of each component's first pixel) ----------
  /** Pixels with equal value (other than bg) that touch are one component. Returns labels (0 = bg) and count incl. 0. */
  function components(v, w, h, eight, bg) {
    const lab = new Int32Array(w * h);
    let parent = new Int32Array(1024), next = 1;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const join = (a, b) => { a = find(a); b = find(b); if (a < b) parent[b] = a; else if (b < a) parent[a] = b; return a < b ? a : b; };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, c = v[i];
        if (c === bg) continue;
        let l = 0;
        const see = (j) => { if (v[j] === c) l = l ? join(l, lab[j]) : find(lab[j]); };
        if (x > 0) see(i - 1);
        if (y > 0) {
          see(i - w);
          if (eight) { if (x > 0) see(i - w - 1); if (x < w - 1) see(i - w + 1); }
        }
        if (!l) {
          if (next >= parent.length) { const p = new Int32Array(parent.length * 2); p.set(parent); parent = p; }
          parent[next] = next; l = next++;
        }
        lab[i] = l;
      }
    }
    const final = new Int32Array(next);
    let n = 1;
    for (let i = 0; i < w * h; i++) {
      if (!lab[i]) continue;
      const r = find(lab[i]);
      if (!final[r]) final[r] = n++;
      lab[i] = final[r];
    }
    return { lab, n };
  }

  // ---------- shapes: lines where the colour jumps, and the areas they close off ----------
  function trace(rgb, w, h) {
    const n = w * h, L = new Float32Array(n * 3); // float32 like separate.py
    const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) { labInt(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], tmp, 0); L[i * 3] = tmp[0]; L[i * 3 + 1] = tmp[1]; L[i * 3 + 2] = tmp[2]; }
    const r = (x, m) => (x < 0 ? -x : x >= m ? 2 * m - 2 - x : x); // BORDER_REFLECT_101
    const fr = Math.fround, notLine = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const ym = r(y - 1, h), yp = r(y + 1, h);
      for (let x = 0; x < w; x++) {
        const xm = r(x - 1, w), xp = r(x + 1, w);
        let g = 0;
        for (let c = 0; c < 3; c++) {
          const p = (yy, xx) => L[(yy * w + xx) * 3 + c];
          const gx = fr(p(ym, xp) - p(ym, xm) + 2 * (p(y, xp) - p(y, xm)) + p(yp, xp) - p(yp, xm));
          const gy = fr(p(yp, xm) - p(ym, xm) + 2 * (p(yp, x) - p(ym, x)) + p(yp, xp) - p(ym, xp));
          g = fr(g + fr(fr(gx * gx) + fr(gy * gy)));
        }
        notLine[y * w + x] = fr(fr(Math.sqrt(g)) / 8) > EDGE_DE ? 0 : 1; // Sobel's gain is 8 for a slope of 1 per pixel
      }
    }
    const { lab: shape, n: count } = components(notLine, w, h, false, 0);
    const size = new Int32Array(count);
    for (let i = 0; i < n; i++) size[shape[i]]++;
    for (let i = 0; i < n; i++) if (size[shape[i]] < MIN_AREA) shape[i] = 0;
    return { notLine, shape, count };
  }

  /** Each shape's printable colour from its mean colour; lines and tiny shapes get -1 (no preference). Also the means. */
  function shapeColours(rgb, shape, count, P) {
    const sum = new Float64Array(count * 3), num = new Float64Array(count);
    for (let i = 0; i < shape.length; i++) {
      const s = shape[i]; num[s]++;
      sum[s * 3] += rgb[i * 3]; sum[s * 3 + 1] += rgb[i * 3 + 1]; sum[s * 3 + 2] += rgb[i * 3 + 2];
    }
    const lbl = new Int8Array(count), mean = new Float64Array(count * 3), t = [0, 0, 0];
    for (let s = 0; s < count; s++) {
      const q = Math.max(num[s], 1);
      mean[s * 3] = sum[s * 3] / q; mean[s * 3 + 1] = sum[s * 3 + 1] / q; mean[s * 3 + 2] = sum[s * 3 + 2] / q;
      labF(mean[s * 3], mean[s * 3 + 1], mean[s * 3 + 2], t, 0);
      lbl[s] = nearest(t[0], t[1], t[2], P, -1);
    }
    lbl[0] = -1;
    return { lbl, mean };
  }

  /** Soft edges: a line pixel whose colour lies within BLEND_RGB of the mix of the two nearest shapes (within BLEND_R px)
   *  prefers the closer shape's label (the TIE_DE rule, like inside a shape), so an anti-aliased edge doesn't print a
   *  third, darker ink. An outline darker than both sides is no mix of them and keeps its own colour. -1 = no preference. */
  function edgePrefer(shape, w, h, mean, lbl, img, W, H) {
    const offs = [];
    for (let dy = -BLEND_R; dy <= BLEND_R; dy++) for (let dx = -BLEND_R; dx <= BLEND_R; dx++) offs.push([dy, dx]);
    offs.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]) || p[0] - q[0] || p[1] - q[1]);
    const A = new Int32Array(w * h), B = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (shape[i]) continue;
      let a = 0, b = 0;
      for (const [dy, dx] of offs) { // the nearest shape
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w && shape[yy * w + xx]) { a = shape[yy * w + xx]; break; }
      }
      for (const [dy, dx] of offs) { // and the nearest other one
        const yy = y + dy, xx = x + dx;
        const s = yy >= 0 && yy < h && xx >= 0 && xx < w ? shape[yy * w + xx] : 0;
        if (s && s !== a) { b = s; break; }
      }
      A[i] = a; B[i] = b;
    }
    const pref = new Int8Array(W * H).fill(-1), R2 = BLEND_RGB * BLEND_RGB;
    for (let Y = 0; Y < H; Y++) {
      const row = ((Y / SCALE) | 0) * w;
      for (let X = 0; X < W; X++) {
        const j = row + ((X / SCALE) | 0), a = A[j], b = B[j];
        if (!a || !b) continue;
        const i = Y * W + X, p0 = img[i * 3], p1 = img[i * 3 + 1], p2 = img[i * 3 + 2];
        const a0 = mean[a * 3], a1 = mean[a * 3 + 1], a2 = mean[a * 3 + 2];
        const v0 = mean[b * 3] - a0, v1 = mean[b * 3 + 1] - a1, v2 = mean[b * 3 + 2] - a2;
        const vv = v0 * v0 + v1 * v1 + v2 * v2;
        const t = ((p0 - a0) * v0 + (p1 - a1) * v1 + (p2 - a2) * v2) / Math.max(vv, 1e-9);
        const tc = t < 0 ? 0 : t > 1 ? 1 : t;
        const d0 = p0 - (a0 + tc * v0), d1 = p1 - (a1 + tc * v1), d2 = p2 - (a2 + tc * v2);
        if (vv > 0 && d0 * d0 + d1 * d1 + d2 * d2 < R2) pref[i] = t < 0.5 ? lbl[a] : lbl[b];
      }
    }
    return pref;
  }

  // ---------- 7×7 mode filter (Pillow's ModeFilter: most frequent value if it appears > 2 times, lowest on ties) ----------
  function modeFilter(src, W, H) {
    const out = new Uint8Array(W * H), hist = new Int32Array(256), R = 3;
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - R), y1 = Math.min(H - 1, y + R);
      hist.fill(0);
      for (let yy = y0; yy <= y1; yy++) for (let xx = 0; xx <= Math.min(W - 1, R); xx++) hist[src[yy * W + xx]]++;
      for (let x = 0; x < W; x++) {
        if (x > 0) {
          const add = x + R, drop = x - R - 1;
          for (let yy = y0; yy <= y1; yy++) {
            if (add < W) hist[src[yy * W + add]]++;
            if (drop >= 0) hist[src[yy * W + drop]]--;
          }
        }
        let mp = 0, mc = hist[0];
        for (let k = 1; k < 64; k++) if (hist[k] > mc) { mc = hist[k]; mp = k; }
        out[y * W + x] = mc > 2 ? mp : src[y * W + x];
      }
    }
    return out;
  }

  // ---------- fine dark features the steps above lost (hair strands, a rose's spiral) ----------
  /** Max (dilate) or min (erode) over an 11×11 OpenCV ellipse, per channel; out-of-image pixels are ignored. */
  const ELLIPSE = [0, 3, 4, 5, 5, 5, 5, 5, 4, 3, 0]; // half-width per row, rows -5..5
  function morph(src, w, h, max) {
    const out = new Float64Array(src.length), rows = {}, pick = max ? Math.max : Math.min, none = max ? -Infinity : Infinity;
    for (const hw of new Set(ELLIPSE)) {
      const a = (rows[hw] = new Float64Array(src.length));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
        let v = none;
        for (let xx = Math.max(0, x - hw); xx <= Math.min(w - 1, x + hw); xx++) v = pick(v, src[(y * w + xx) * 3 + c]);
        a[(y * w + x) * 3 + c] = v;
      }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let v = none;
      for (let dy = -5; dy <= 5; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < h) v = pick(v, rows[ELLIPSE[dy + 5]][(yy * w + x) * 3 + c]);
      }
      out[(y * w + x) * 3 + c] = v;
    }
    return out;
  }

  /** How much darker each pixel is than its surroundings (a closing wipes out anything dark narrower than FINE_PX),
   *  at the original size, then bilinearly upscaled the way cv2.resize does. */
  function darkness(rgb, w, h, W, H) {
    const a = Float64Array.from(rgb), bg = morph(morph(a, w, h, true), w, h, false), small = new Float32Array(w * h), t = [0, 0, 0], u = [0, 0, 0];
    for (let i = 0; i < w * h; i++) {
      labF(bg[i * 3], bg[i * 3 + 1], bg[i * 3 + 2], t, 0);
      labInt(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], u, 0);
      small[i] = t[0] - u[0];
    }
    const axis = (inN, outN) => {
      const i0 = new Int32Array(outN), i1 = new Int32Array(outN), fw = new Float64Array(outN);
      for (let d = 0; d < outN; d++) {
        let fx = Math.fround((d + 0.5) * (inN / outN) - 0.5), sx = Math.floor(fx);
        fx -= sx;
        if (sx < 0) { fx = 0; sx = 0; }
        if (sx >= inN - 1) { fx = 0; sx = inN - 1; }
        i0[d] = sx; i1[d] = Math.min(sx + 1, inN - 1); fw[d] = fx;
      }
      return { i0, i1, fw };
    };
    const ax = axis(w, W), ay = axis(h, H), diff = new Float32Array(W * H);
    for (let Y = 0; Y < H; Y++) {
      const r0 = ay.i0[Y] * w, r1 = ay.i1[Y] * w, fy = ay.fw[Y];
      for (let X = 0; X < W; X++) {
        const x0 = ax.i0[X], x1 = ax.i1[X], fx = ax.fw[X];
        const top = small[r0 + x0] * (1 - fx) + small[r0 + x1] * fx, bot = small[r1 + x0] * (1 - fx) + small[r1 + x1] * fx;
        diff[Y * W + X] = top * (1 - fy) + bot * fy;
      }
    }
    return diff;
  }

  /** Q: all candidate colours; Q16: the palette's own 16, the only ones a line is painted in (dots would break it up).
   *  shape, mean: the traced shapes (see shapeColours); a piece no longer than FINE_PX and the colour of a shape in its
   *  ring is that shape's tip (a teacup's dark inside narrowing at the rim), not a line: it keeps its own colour. */
  function fineFeatures(rgb, w, h, img, W, H, Q, Q16, idx, shape, mean) {
    const diff = darkness(rgb, w, h, W, H), N = W * H, pal = Q.lab, K = Q.cost.length, t = [0, 0, 0];
    const near = new Uint8Array(N).fill(255);
    let any = false;
    for (let i = 0; i < N; i++) {
      if (!(diff[i] > FINE_DE)) continue;
      any = true;
      labInt(img[i * 3], img[i * 3 + 1], img[i * 3 + 2], t, 0);
      near[i] = nearest(t[0], t[1], t[2], Q16, -1);
    }
    if (!any) return;
    // pieces: connected feature pixels of one nearest colour, numbered colour by colour like separate.py
    const cc = components(near, W, H, true, 255), n = cc.n, seg = cc.lab;
    const colourOf = new Int32Array(n);
    for (let i = 0; i < N; i++) if (seg[i]) colourOf[seg[i]] = near[i];
    const order = Array.from({ length: n - 1 }, (_, k) => k + 1).sort((a, b) => colourOf[a] - colourOf[b] || a - b);
    const renum = new Int32Array(n);
    order.forEach((s, k) => { renum[s] = k + 1; });
    for (let i = 0; i < N; i++) if (seg[i]) seg[i] = renum[seg[i]];
    // the ring around each piece: a 9×9 max of the piece numbers, where the art is flat
    const rowMax = new Int32Array(N), grown = new Int32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (let xx = Math.max(0, x - 4); xx <= Math.min(W - 1, x + 4); xx++) if (seg[y * W + xx] > v) v = seg[y * W + xx];
      rowMax[y * W + x] = v;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (let yy = Math.max(0, y - 4); yy <= Math.min(H - 1, y + 4); yy++) if (rowMax[yy * W + x] > v) v = rowMax[yy * W + x];
      grown[y * W + x] = v;
    }
    const palL = (k) => pal[3 * k];
    // the fill each piece sits on: the darkest colour making up >= 25% of its ring
    const cnt = new Float64Array(n * K);
    for (let i = 0; i < N; i++) if (grown[i] > 0 && diff[i] <= 2) cnt[grown[i] * K + idx[i]]++;
    const host = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      let tot = 0;
      for (let k = 0; k < K; k++) tot += cnt[s * K + k];
      let best = 0, bv = Infinity;
      for (let k = 0; k < K; k++) { const v = cnt[s * K + k] >= 0.25 * tot ? palL(k) : Infinity; if (v < bv) { bv = v; best = k; } }
      host[s] = best;
    }
    // and how light that fill really is in the art
    const hostSum = new Float64Array(n), hostNum = new Float64Array(n);
    for (let i = 0; i < N; i++) {
      const s = grown[i];
      if (!(s > 0 && diff[i] <= 2) || idx[i] !== host[s]) continue;
      labInt(img[i * 3], img[i * 3 + 1], img[i * 3 + 2], t, 0);
      hostSum[s] += t[0]; hostNum[s]++;
    }
    // each piece's colour from its middle (not its anti-aliased edges)
    const peak = new Float64Array(n), area = new Float64Array(n), own = new Int32Array(n);
    const lo = new Int32Array(2 * n).fill(1 << 30), hi = new Int32Array(2 * n).fill(-1); // each piece's extent (y, x)
    for (let i = 0; i < N; i++) {
      const s = seg[i];
      if (!s) continue;
      if (diff[i] > peak[s]) peak[s] = diff[i];
      area[s]++; own[s] = near[i];
      const Y = (i / W) | 0, X = i - Y * W;
      lo[2 * s] = Math.min(lo[2 * s], Y); hi[2 * s] = Math.max(hi[2 * s], Y);
      lo[2 * s + 1] = Math.min(lo[2 * s + 1], X); hi[2 * s + 1] = Math.max(hi[2 * s + 1], X);
    }
    const col = new Float64Array(n * 3), colN = new Float64Array(n);
    for (let i = 0; i < N; i++) {
      const s = seg[i];
      if (!s || !(diff[i] >= 0.6 * peak[s])) continue;
      col[s * 3] += img[i * 3]; col[s * 3 + 1] += img[i * 3 + 1]; col[s * 3 + 2] += img[i * 3 + 2]; colN[s]++;
    }
    const colLab = new Float64Array(n * 3);
    for (let s = 0; s < n; s++) {
      const q = Math.max(colN[s], 1);
      labF(col[s * 3] / q, col[s * 3 + 1] / q, col[s * 3 + 2] / q, colLab, s * 3);
    }
    // tips: short pieces the colour of a traced shape in their ring
    const meanLab = new Float64Array(mean.length), tip = new Uint8Array(n);
    for (let k = 0; k < mean.length; k += 3) labF(mean[k], mean[k + 1], mean[k + 2], meanLab, k);
    for (let i = 0; i < N; i++) {
      const s = grown[i];
      if (!(s > 0 && diff[i] <= 2) || tip[s]) continue;
      const Y = (i / W) | 0, sr = shape[((Y / SCALE) | 0) * w + (((i - Y * W) / SCALE) | 0)];
      if (!sr) continue;
      const d0 = colLab[s * 3] - meanLab[sr * 3], d1 = colLab[s * 3 + 1] - meanLab[sr * 3 + 1], d2 = colLab[s * 3 + 2] - meanLab[sr * 3 + 2];
      if (Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) < FINE_DE) tip[s] = 1;
    }
    for (let s = 1; s < n; s++) if (Math.max(hi[2 * s] - lo[2 * s], hi[2 * s + 1] - lo[2 * s + 1]) >= FINE_PX * SCALE) tip[s] = 0;
    const pick = new Int32Array(n), finite = new Uint8Array(n), colL = new Float64Array(n), darker = new Uint8Array(n * K);
    for (let s = 0; s < n; s++) {
      t[0] = colLab[s * 3]; t[1] = colLab[s * 3 + 1]; t[2] = colLab[s * 3 + 2];
      colL[s] = t[0];
      let best = 0, bv = Infinity;
      for (let k = 0; k < K; k++) {
        darker[s * K + k] = palL(k) < palL(host[s]) - 2 ? 1 : 0; // colours that still show against the fill
        if (k >= 16) continue; // lines only in the palette's own colours
        const d = Math.hypot(t[0] - pal[3 * k], t[1] - pal[3 * k + 1], t[2] - pal[3 * k + 2]);
        const sc = darker[s * K + k] ? d + (d > EXACT_DE ? Q.cost[k] : 0) : Infinity;
        if (sc < bv) { bv = sc; best = k; }
      }
      finite[s] = bv < Infinity ? 1 : 0;
      pick[s] = darker[s * K + own[s]] || tip[s] ? own[s] : best; // its own nearest colour, when that already shows or a tip
    }
    // leave pieces that already show; only lost lines need help
    const shown = new Float64Array(n);
    for (let i = 0; i < N; i++) { const s = seg[i]; if (s && darker[s * K + idx[i]]) shown[s]++; }
    const keep = new Uint8Array(n);
    for (let s = 1; s < n; s++) {
      const hostL = hostSum[s] / Math.max(hostNum[s], 1);
      keep[s] = area[s] >= FINE_MIN * SCALE * SCALE && finite[s] && !(shown[s] >= 0.5 * area[s]) && hostL - colL[s] > FINE_DE ? 1 : 0;
    }
    for (let i = 0; i < N; i++) { const s = seg[i]; if (s && keep[s]) idx[i] = pick[s]; }
  }

  // ---------- the whole separation ----------
  const pause = () => new Promise((r) => setTimeout(r, 0));
  /** rgb: Uint8Array w*h*3. Returns the ink mask per pixel at 3× (W×H), the mean dE to the nearest printable colour,
   *  and the traced line layer. onStage(text) is called (and awaited) before each step, for a progress line. */
  async function labels(rgb, w, h, palette, opts) {
    const o = opts || {}, pen = o.penalty == null ? INK_PENALTY : o.penalty;
    const cost = Float64Array.from(palette.masks, (m) => pen * N_INKS[m]);
    const P = { lab: palette.lab, cost }, P16 = { lab: palette.lab, cost: cost.subarray(0, 16) };
    const stage = async (s) => { if (o.onStage) await o.onStage(s); await pause(); };
    const W = w * SCALE, H = h * SCALE;
    await stage('放大 3 倍');
    const img = upscale(rgb, w, h, W, H);
    await stage('描出色塊');
    const { notLine, shape, count } = trace(rgb, w, h);
    const { lbl, mean } = shapeColours(rgb, shape, count, P);
    const edge = edgePrefer(shape, w, h, mean, lbl, img, W, H);
    await stage('每一點找最接近的印刷色');
    let idx = new Uint8Array(W * H), de = 0;
    const t = [0, 0, 0];
    for (let Y = 0; Y < H; Y++) {
      const srow = ((Y / SCALE) | 0) * w;
      for (let X = 0; X < W; X++) {
        const i = Y * W + X;
        labInt(img[i * 3], img[i * 3 + 1], img[i * 3 + 2], t, 0);
        const s = lbl[shape[srow + ((X / SCALE) | 0)]];
        const b = nearest(t[0], t[1], t[2], P, s >= 0 ? s : edge[i]);
        idx[i] = b; de += D[b];
      }
    }
    await stage('去掉雜點');
    idx = modeFilter(idx, W, H);
    await stage('補回細線');
    fineFeatures(rgb, w, h, img, W, H, P, P16, idx, shape, mean);
    return { idx, W, H, de: de / (W * H), lines: notLine, shape, w, h };
  }

  // ---------- printing: halftone dots, then plates and the proof ----------
  /** Whether plate pixel (X, Y) falls inside a round halftone dot covering pct, pitch plate px apart at the ink's own
   *  angle. The same plain arithmetic as separate.py's screen(), so the dots match bit for bit. */
  function dot(X, Y, ink, pct, pitch) {
    const c = SCREEN_COS[ink], s = SCREEN_SIN[ink], x = X + 0.5, y = Y + 0.5;
    const u = (x * c + y * s) / pitch, v = (y * c - x * s) / pitch;
    const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
    if (pct <= 0.5) return fu * fu + fv * fv < pct / Math.PI; // an ink dot in the middle of each cell
    const gu = 0.5 - Math.abs(fu), gv = 0.5 - Math.abs(fv); // past 50%: round paper holes at the cell corners
    return gu * gu + gv * gv >= (1 - pct) / Math.PI;
  }

  /** Where screened colour k prints as dots (separate.py's screen_area), for a labels() result r: its 8-connected
   *  areas at plate size that a clicked point [x, y] (original px) falls in, or that overlap that point's traced shape
   *  (a soft face/hair boundary leaves the face inside the hair's shape). 1 = dots. */
  function screenArea(r, k, seeds) {
    const { idx, W, H, shape, w } = r, on = new Uint8Array(W * H);
    for (let i = 0; i < on.length; i++) on[i] = idx[i] === k ? 1 : 0;
    const { lab, n } = components(on, W, H, true, 0), hit = new Uint8Array(n);
    const block = (x, y) => {
      for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) hit[lab[(y * SCALE + dy) * W + x * SCALE + dx]] = 1;
    };
    for (const [x, y] of seeds) {
      block(x, y);
      const s = shape[y * w + x];
      if (s) for (let i = 0; i < shape.length; i++) if (shape[i] === s) block(i % w, (i - (i % w)) / w);
    }
    hit[0] = 0;
    const area = new Uint8Array(W * H);
    for (let i = 0; i < area.length; i++) area[i] = hit[lab[i]];
    return area;
  }

  /** The ink mask each plate pixel prints: its label's mask, as dots where that label is screened (and, if areas[label]
   *  is given, only inside it; elsewhere solid). dpi: the plates' printed resolution (plate width × 2.54 / printed cm),
   *  which makes the dots LPI lines per inch. */
  function printMasks(idx, W, palette, dpi, areas) {
    const { masks, pcts } = palette, pitch = dpi / LPI, out = new Uint8Array(idx.length), A = areas || [];
    for (let i = 0; i < idx.length; i++) {
      const k = idx[i], m = masks[k];
      if (!pcts[k] || (A[k] && !A[k][i])) { out[i] = m; continue; }
      const X = i % W, Y = (i - X) / W;
      let v = 0;
      for (let b = 0; b < 4; b++) if ((m >> b) & 1 && dot(X, Y, b, pcts[k], pitch)) v |= 1 << b;
      out[i] = v;
    }
    return out;
  }

  /** The proof: each pixel in the colour its inks print (from printMasks, so the dots show). RGBA for a canvas. */
  function proof(idx, palette) {
    const out = new Uint8ClampedArray(idx.length * 4);
    for (let i = 0; i < idx.length; i++) {
      const m = idx[i] * 3;
      out[i * 4] = palette.rgb[m]; out[i * 4 + 1] = palette.rgb[m + 1]; out[i * 4 + 2] = palette.rgb[m + 2]; out[i * 4 + 3] = 255;
    }
    return out;
  }

  /** Plate b as RGBA from printMasks: black where ink b prints, white elsewhere; and its coverage (0–1). */
  function plate(idx, b) {
    const out = new Uint8ClampedArray(idx.length * 4);
    let on = 0;
    for (let i = 0; i < idx.length; i++) {
      const ink = (idx[i] >> b) & 1, v = ink ? 0 : 255;
      on += ink;
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
    }
    return { rgba: out, coverage: on / idx.length };
  }

  const api = { SCALE, INK_PENALTY, LPI, DPI, parsePalette, withScreens, labels, screenArea, printMasks, proof, plate, _test: { upscale, modeFilter, components, trace, morph } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OverprintSeparate = api;
})(globalThis);
