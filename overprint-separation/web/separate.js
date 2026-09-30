// separate.js — 分色 in the browser: a JavaScript port of ../separate.py (same constants, same steps, same order),
// so a plate made here matches one made in Claude Code. One image + a four-ink palette.json → an ink mask per
// pixel at 3× the image size; plate b is (mask >> b) & 1 (bit 0 = the first ink printed).
// Plain script: window.OverprintSeparate in a page, module.exports in Node (the parity check against separate.py).
(function (root) {
  'use strict';

  const SCALE = 3;
  const INK_PENALTY = 8; // dE per extra overprinted ink for off-palette pixels (the Python --penalty)
  const L_WEIGHT = 0.3, EXACT_DE = 4, EDGE_DE = 3, TIE_DE = 12, MIN_AREA = 12;
  const FINE_PX = 11, FINE_DE = 6, FINE_MIN = 4;
  const PREC = 1 << 22; // Pillow's fixed-point resample precision
  const bits = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
  const N_INKS = Array.from({ length: 16 }, (_, m) => Math.max(bits(m) - 1, 0)); // paper and solo inks are free

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

  /** A palette.json (from 疊印色盤, the matrix page, or the kit email) → names + the 16 printable colours by ink mask. */
  function parsePalette(p) {
    if (!p || !Array.isArray(p.inks) || !Array.isArray(p.cells)) throw new Error('這不是 palette.json：找不到 inks 和 cells');
    if (p.inks.length !== 4 || p.cells.length !== 16) throw new Error(`分色需要 4 支墨的色盤（這個有 ${p.inks.length} 支）`);
    const rgb = new Float64Array(48), lab = new Float64Array(48);
    p.cells.forEach((c, m) => {
      const hex = String(c && c.hex).replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`palette.json 第 ${m + 1} 格的色碼看不懂：${c && c.hex}`);
      for (let k = 0; k < 3; k++) rgb[m * 3 + k] = parseInt(hex.slice(2 * k, 2 * k + 2), 16);
      labF(rgb[m * 3], rgb[m * 3 + 1], rgb[m * 3 + 2], lab, m * 3);
    });
    return { name: String(p.name || ''), inks: p.inks.map((i) => String(i.name)), rgb, lab };
  }

  // ---------- nearest printable colour ----------
  const SC = new Float64Array(16), D = new Float64Array(16);
  /** Best ink mask for one Lab colour; D[best] is left holding its dE. prefer (-1 = none) wins within TIE_DE. */
  function nearest(l, a, b, P, pen, prefer) {
    let best = 0, bs = Infinity;
    for (let k = 0; k < 16; k++) {
      const dl0 = l - P[3 * k];
      // lightness is asymmetric: a pixel LIGHTER than a candidate costs only L_WEIGHT (a pale tint still reads as its ink)
      const dl = dl0 > 0 ? L_WEIGHT * dl0 : dl0, da = a - P[3 * k + 1], db = b - P[3 * k + 2];
      const d = Math.sqrt(dl * dl + da * da + db * db);
      const sc = d + (d > EXACT_DE ? pen * N_INKS[k] : 0);
      D[k] = d; SC[k] = sc;
      if (sc < bs) { bs = sc; best = k; }
    }
    if (prefer >= 0 && SC[prefer] - bs < TIE_DE) best = prefer;
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

  /** Each shape's printable colour from its mean colour; lines and tiny shapes get -1 (no preference). */
  function shapeColours(rgb, shape, count, P, pen) {
    const sum = new Float64Array(count * 3), num = new Float64Array(count);
    for (let i = 0; i < shape.length; i++) {
      const s = shape[i]; num[s]++;
      sum[s * 3] += rgb[i * 3]; sum[s * 3 + 1] += rgb[i * 3 + 1]; sum[s * 3 + 2] += rgb[i * 3 + 2];
    }
    const lbl = new Int8Array(count), t = [0, 0, 0];
    for (let s = 0; s < count; s++) {
      const q = Math.max(num[s], 1);
      labF(sum[s * 3] / q, sum[s * 3 + 1] / q, sum[s * 3 + 2] / q, t, 0);
      lbl[s] = nearest(t[0], t[1], t[2], P, pen, -1);
    }
    lbl[0] = -1;
    return lbl;
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
        for (let k = 1; k < 16; k++) if (hist[k] > mc) { mc = hist[k]; mp = k; }
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

  function fineFeatures(rgb, w, h, img, W, H, P, pen, idx) {
    const diff = darkness(rgb, w, h, W, H), N = W * H, pal = P, t = [0, 0, 0];
    const near = new Uint8Array(N).fill(255);
    let any = false;
    for (let i = 0; i < N; i++) {
      if (!(diff[i] > FINE_DE)) continue;
      any = true;
      labInt(img[i * 3], img[i * 3 + 1], img[i * 3 + 2], t, 0);
      near[i] = nearest(t[0], t[1], t[2], pal, pen, -1);
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
    const cnt = new Float64Array(n * 16);
    for (let i = 0; i < N; i++) if (grown[i] > 0 && diff[i] <= 2) cnt[grown[i] * 16 + idx[i]]++;
    const host = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      let tot = 0;
      for (let k = 0; k < 16; k++) tot += cnt[s * 16 + k];
      let best = 0, bv = Infinity;
      for (let k = 0; k < 16; k++) { const v = cnt[s * 16 + k] >= 0.25 * tot ? palL(k) : Infinity; if (v < bv) { bv = v; best = k; } }
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
    for (let i = 0; i < N; i++) {
      const s = seg[i];
      if (!s) continue;
      if (diff[i] > peak[s]) peak[s] = diff[i];
      area[s]++; own[s] = near[i];
    }
    const col = new Float64Array(n * 3), colN = new Float64Array(n);
    for (let i = 0; i < N; i++) {
      const s = seg[i];
      if (!s || !(diff[i] >= 0.6 * peak[s])) continue;
      col[s * 3] += img[i * 3]; col[s * 3 + 1] += img[i * 3 + 1]; col[s * 3 + 2] += img[i * 3 + 2]; colN[s]++;
    }
    const pick = new Int32Array(n), finite = new Uint8Array(n), colL = new Float64Array(n), darker = new Uint8Array(n * 16);
    for (let s = 0; s < n; s++) {
      const q = Math.max(colN[s], 1);
      labF(col[s * 3] / q, col[s * 3 + 1] / q, col[s * 3 + 2] / q, t, 0);
      colL[s] = t[0];
      let best = 0, bv = Infinity;
      for (let k = 0; k < 16; k++) {
        darker[s * 16 + k] = palL(k) < palL(host[s]) - 2 ? 1 : 0; // colours that still show against the fill
        const d = Math.hypot(t[0] - pal[3 * k], t[1] - pal[3 * k + 1], t[2] - pal[3 * k + 2]);
        const sc = darker[s * 16 + k] ? d + (d > EXACT_DE ? pen * N_INKS[k] : 0) : Infinity;
        if (sc < bv) { bv = sc; best = k; }
      }
      finite[s] = bv < Infinity ? 1 : 0;
      pick[s] = darker[s * 16 + own[s]] ? own[s] : best; // its own nearest colour, when that already shows
    }
    // leave pieces that already show; only lost lines need help
    const shown = new Float64Array(n);
    for (let i = 0; i < N; i++) { const s = seg[i]; if (s && darker[s * 16 + idx[i]]) shown[s]++; }
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
    const o = opts || {}, pen = o.penalty == null ? INK_PENALTY : o.penalty, P = palette.lab;
    const stage = async (s) => { if (o.onStage) await o.onStage(s); await pause(); };
    const W = w * SCALE, H = h * SCALE;
    await stage('放大 3 倍');
    const img = upscale(rgb, w, h, W, H);
    await stage('描出色塊');
    const { notLine, shape, count } = trace(rgb, w, h);
    const lbl = shapeColours(rgb, shape, count, P, pen);
    await stage('每一點找最接近的印刷色');
    let idx = new Uint8Array(W * H), de = 0;
    const t = [0, 0, 0];
    for (let Y = 0; Y < H; Y++) {
      const srow = ((Y / SCALE) | 0) * w;
      for (let X = 0; X < W; X++) {
        const i = Y * W + X;
        labInt(img[i * 3], img[i * 3 + 1], img[i * 3 + 2], t, 0);
        const b = nearest(t[0], t[1], t[2], P, pen, lbl[shape[srow + ((X / SCALE) | 0)]]);
        idx[i] = b; de += D[b];
      }
    }
    await stage('去掉雜點');
    idx = modeFilter(idx, W, H);
    await stage('補回細線');
    fineFeatures(rgb, w, h, img, W, H, P, pen, idx);
    return { idx, W, H, de: de / (W * H), lines: notLine };
  }

  /** The proof: each pixel in the colour its inks print (from the plates). RGBA for a canvas. */
  function proof(idx, palette) {
    const out = new Uint8ClampedArray(idx.length * 4);
    for (let i = 0; i < idx.length; i++) {
      const m = idx[i] * 3;
      out[i * 4] = palette.rgb[m]; out[i * 4 + 1] = palette.rgb[m + 1]; out[i * 4 + 2] = palette.rgb[m + 2]; out[i * 4 + 3] = 255;
    }
    return out;
  }

  /** Plate b as RGBA: black where ink b prints, white elsewhere; and its coverage (0–1). */
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

  const api = { SCALE, INK_PENALTY, parsePalette, labels, proof, plate, _test: { upscale, modeFilter, components, trace, morph } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OverprintSeparate = api;
})(globalThis);
