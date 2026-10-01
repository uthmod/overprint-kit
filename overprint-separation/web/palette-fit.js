// palette-fit.js — 從這張圖找色盤 on the 分色 page: four plain Pantone U inks and a print order whose own colours and
// overprints come closest to a flat-colour picture's colours (docs/superpowers/specs/2026-10-01-palette-from-picture-design.md).
// Printed colours = the 色盤產生器's model (OverprintModel.simulate: transparent inks on 特A啤酒紙), worked out from per-ink
// factors so one set costs microseconds; distance = the separation's own rule (separate.js nearest).
// Plain script: window.OverprintFit in a page, module.exports in Node.
(function factory(root) {
  'use strict';

  const L_WEIGHT = 0.3, EXACT_DE = 4; // as separate.js: a lighter pixel counts 0.3 of its lightness gap; inks cost past 4
  const bits = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
  const N_INKS = Array.from({ length: 16 }, (_, m) => Math.max(bits(m) - 1, 0)); // extra stacked inks in cell m

  // ---------- colour: sRGB 0–255 → Lab, the same sums as separate.js ----------
  const lin = (v) => { const c = v / 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const LIN = Float64Array.from({ length: 256 }, (_, v) => lin(v));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function labOf(R, G, B, out, o) {
    const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
    const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    out[o] = 116 * fy - 16; out[o + 1] = 500 * (fx - fy); out[o + 2] = 200 * (fy - fz);
  }

  // ---------- the ink pool and a set's printed colours ----------
  /** Plain Pantone U inks (no metallic or fluorescent) from the site's model M: names, colour on paper (0–1 sRGB),
   *  book Lab, and the paper and trapping every set prints with. */
  function poolFrom(M) {
    const inks = M.parsePantoneCsv(M.PANTONE_CSV).filter((i) => !i.flag);
    return {
      names: inks.map((i) => i.name),
      rgb: Float64Array.from(inks.flatMap((i) => M.labToRgb([i.L, i.a, i.b]))),
      lab: Float64Array.from(inks.flatMap((i) => [i.L, i.a, i.b])),
      paper: M.labToRgb(M.STOCK), trapping: M.DEFAULT_TRAPPING,
    };
  }

  /** Per-ink factors of the model's cell formula: (ink / paper) ** 1 for a cell's first ink, ** trapping for the rest. */
  function prepare(pool) {
    const n = pool.names.length, first = new Float64Array(n * 3), later = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) {
      const q = pool.rgb[i * 3 + j] / Math.max(pool.paper[j], 1e-4);
      first[i * 3 + j] = q ** 1; later[i * 3 + j] = q ** pool.trapping;
    }
    return { pool, n, first, later, raw: new Float64Array(48), hex: new Uint8Array(48), lab: new Float64Array(48) };
  }

  /** Inks `set` (pool indices, first printed first) → P.hex: the 16 colours as palette.json stores them (0–255, by ink
   *  mask, bit k = the k-th ink printed), and P.lab: those colours as the separation reads them. The same
   *  multiplications in the same order as OverprintModel.simulate with alpha 0, so the hex match bit for bit. */
  function cells(P, set) {
    const { raw, hex, lab } = P, paper = P.pool.paper;
    raw[0] = paper[0]; raw[1] = paper[1]; raw[2] = paper[2];
    for (let m = 1; m < 16; m++) {
      const h = 31 - Math.clz32(m), rest = m ^ (1 << h), fac = rest ? P.later : P.first, x = set[h] * 3;
      for (let j = 0; j < 3; j++) raw[m * 3 + j] = raw[rest * 3 + j] * fac[x + j];
    }
    for (let i = 0; i < 48; i++) hex[i] = Math.round(Math.min(1, Math.max(0, raw[i])) * 255);
    for (let m = 0; m < 16; m++) labOf(LIN[hex[m * 3]], LIN[hex[m * 3 + 1]], LIN[hex[m * 3 + 2]], lab, m * 3);
  }

  /** For each art colour, the cell the separation would pick (nearest; past EXACT_DE each extra stacked ink costs
   *  `penalty`) and its distance. score: distances weighted by √share, what the search ranks by (a big background counts
   *  more but can't drown an eye); estimate: weighted by share, the scale of the page's 平均相差. */
  function score(lab, art, penalty) {
    let s = 0, e = 0;
    for (let c = 0; c < art.n; c++) {
      const l = art.lab[c * 3], a = art.lab[c * 3 + 1], b = art.lab[c * 3 + 2];
      let bs = Infinity, bd = 0;
      for (let k = 0; k < 16; k++) {
        const dl0 = l - lab[k * 3], dl = dl0 > 0 ? L_WEIGHT * dl0 : dl0, da = a - lab[k * 3 + 1], db = b - lab[k * 3 + 2];
        const d = Math.sqrt(dl * dl + da * da + db * db), sc = d + (d > EXACT_DE ? penalty * N_INKS[k] : 0);
        if (sc < bs) { bs = sc; bd = d; }
      }
      s += art.root[c] * bd; e += art.share[c] * bd;
    }
    return { score: s / art.rootSum, estimate: e / art.shareSum };
  }

  // ---------- the art's flat colours ----------
  const SAMPLE_PX = 250000, FLAT = 10, MERGE_DE = 8, MIN_SHARE = 0.001, MAX_COLOURS = 24, MAX_BINS = 400; // FLAT 10: AI-drawn flat art has grain up to ~8
  /** The picture's flat colours, biggest first. About SAMPLE_PX pixels are sampled evenly; a pixel counts only where it
   *  matches its right and lower neighbours within `flat` per channel, so edge blends and noise don't; 5-bit buckets,
   *  each merged into a bigger colour within MERGE_DE (Lab); colours over MIN_SHARE of the sample are kept, at most
   *  MAX_COLOURS. coverage = the kept colours' share of every sampled pixel: low for photos, gradients and texture. */
  function artColours(rgb, w, h, flat = FLAT) {
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / SAMPLE_PX)));
    const cnt = new Float64Array(32768), sum = new Float64Array(32768 * 3);
    const near = (i, j) => Math.abs(rgb[i] - rgb[j]) <= flat && Math.abs(rgb[i + 1] - rgb[j + 1]) <= flat && Math.abs(rgb[i + 2] - rgb[j + 2]) <= flat;
    let total = 0;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      total++;
      const i = (y * w + x) * 3;
      if ((x + 1 < w && !near(i, i + 3)) || (y + 1 < h && !near(i, i + w * 3))) continue;
      const k = ((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3);
      cnt[k]++; sum[k * 3] += rgb[i]; sum[k * 3 + 1] += rgb[i + 1]; sum[k * 3 + 2] += rgb[i + 2];
    }
    const keys = [];
    for (let k = 0; k < 32768; k++) if (cnt[k]) keys.push(k);
    if (!keys.length && flat < 255) return artColours(rgb, w, h, 255); // nothing flat at all: count every pixel
    keys.sort((p, q) => cnt[q] - cnt[p] || p - q);
    const cols = [], t = [0, 0, 0];
    for (const k of keys) {
      const n = cnt[k], r = sum[k * 3] / n, g = sum[k * 3 + 1] / n, b = sum[k * 3 + 2] / n;
      labOf(lin(r), lin(g), lin(b), t, 0);
      let host = null, hd = MERGE_DE;
      for (const c of cols) { const d = Math.hypot(t[0] - c.lab[0], t[1] - c.lab[1], t[2] - c.lab[2]); if (d < hd) { hd = d; host = c; } }
      if (host) host.n += n;
      else if (cols.length < MAX_BINS) cols.push({ lab: [t[0], t[1], t[2]], n, rgb: [r, g, b].map(Math.round) });
    }
    cols.sort((p, q) => q.n - p.n);
    let kept = cols.filter((c) => c.n >= MIN_SHARE * total).slice(0, MAX_COLOURS);
    if (!kept.length) kept = cols.slice(0, 1);
    const n = kept.length, lab = new Float64Array(n * 3), share = new Float64Array(n), root = new Float64Array(n);
    kept.forEach((c, i) => { lab.set(c.lab, i * 3); share[i] = c.n / total; root[i] = Math.sqrt(share[i]); });
    const shareSum = share.reduce((a, v) => a + v, 0);
    return { n, lab, share, root, shareSum, rootSum: root.reduce((a, v) => a + v, 0), coverage: shareSum, rgb: kept.map((c) => c.rgb) };
  }

  const indexOf = (pool, names) => names.map((n) => {
    const i = pool.names.indexOf(n);
    if (i < 0) throw new Error(`${n} 不在油墨清單裡（只用一般的 Pantone U 油墨）。`);
    return i;
  });
  /** The 16 colours of four inks (names, first printed first) as palette.json hex, by ink mask. */
  function printedColours(names, pool) {
    const P = prepare(pool);
    cells(P, indexOf(pool, names));
    return Array.from({ length: 16 }, (_, m) =>
      Array.from(P.hex.subarray(m * 3, m * 3 + 3), (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  /** How close four inks (names, first printed first) come to the art: { score, estimate } (see score). */
  function scoreSet(names, art, pool, opts) {
    const P = prepare(pool);
    cells(P, indexOf(pool, names));
    return score(P.lab, art, (opts || {}).penalty ?? 5);
  }

  // ---------- the search: start from the art's nearest inks, swap one ink at a time, then try every print order ----------
  const ORDERS = [];
  (function perm(a, rest) { if (!rest.length) ORDERS.push(a); else rest.forEach((x, i) => perm([...a, x], rest.filter((_, j) => j !== i))); })([], [0, 1, 2, 3]);
  const MAX_ROUNDS = 12;
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const shuffle = (a, rand) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  /** The `keep` best four-ink sets for the art, best first, each sharing at most two inks with a better one:
   *  [{ inks: names first printed first, score, estimate }]. Each set comes from `starts` hill climbs: start from the
   *  inks nearest the art's colours (the bare paper's colours skipped), swap one ink for any other in the pool while
   *  that helps, then try all 24 print orders; repeat until nothing helps. Deterministic for a seed. */
  function fit(art, pool, opts) {
    const o = opts || {}, penalty = o.penalty ?? 5, starts = o.starts ?? 6, keep = o.keep ?? 3, rand = mulberry32(o.seed ?? 1);
    const P = prepare(pool), chosen = [];
    const shared = (s, t) => s.reduce((n, i) => n + (t.includes(i) ? 1 : 0), 0);
    const tooLike = (set) => chosen.some((c) => shared(set, c.set) > 2);
    const evaluate = (set) => { if (tooLike(set)) return Infinity; cells(P, set); return score(P.lab, art, penalty).score; };
    cells(P, [0, 1, 2, 3]);
    const pl = P.lab[0], pa = P.lab[1], pb = P.lab[2]; // the bare paper (cell 0 of any set)
    const seeds = [];
    for (let c = 0; c < art.n; c++) {
      const l = art.lab[c * 3], a = art.lab[c * 3 + 1], b = art.lab[c * 3 + 2], dl0 = l - pl;
      if (Math.hypot(dl0 > 0 ? L_WEIGHT * dl0 : dl0, a - pa, b - pb) <= 2 * EXACT_DE) continue; // the paper prints it
      let bi = 0, bd = Infinity;
      for (let i = 0; i < P.n; i++) {
        const d = (l - pool.lab[i * 3]) ** 2 + (a - pool.lab[i * 3 + 1]) ** 2 + (b - pool.lab[i * 3 + 2]) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      if (!seeds.includes(bi)) seeds.push(bi);
    }
    const randomInk = (set) => { for (;;) { const i = Math.floor(rand() * P.n); if (!set.includes(i)) return i; } };
    const start = (s) => {
      const set = (s === 0 ? seeds.slice() : shuffle(seeds.slice(), rand)).slice(0, 4);
      while (set.length < 4) set.push(randomInk(set));
      while (tooLike(set)) set[Math.floor(rand() * 4)] = randomInk(set);
      return set.sort((p, q) => pool.lab[q * 3] - pool.lab[p * 3]); // lightest first, like the palette skill
    };
    const climb = (set) => {
      let cur = evaluate(set);
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let moved = false;
        for (let slot = 0; slot < 4; slot++) {
          const was = set[slot];
          let bestInk = was, bestScore = cur;
          for (let i = 0; i < P.n; i++) {
            if (set.includes(i)) continue;
            set[slot] = i;
            const sc = evaluate(set);
            if (sc < bestScore) { bestScore = sc; bestInk = i; }
          }
          set[slot] = bestInk;
          if (bestInk !== was) { cur = bestScore; moved = true; }
        }
        let bestOrder = null;
        for (const ord of ORDERS) {
          const s = ord.map((k) => set[k]), sc = evaluate(s);
          if (sc < cur) { cur = sc; bestOrder = s; }
        }
        if (bestOrder) { set = bestOrder; moved = true; }
        if (!moved) break;
      }
      return { set, score: cur };
    };
    for (let r = 0; r < keep; r++) {
      let won = null;
      for (let s = 0; s < starts; s++) { const got = climb(start(s)); if (!won || got.score < won.score) won = got; }
      if (!won || !Number.isFinite(won.score)) break;
      chosen.push(won);
    }
    return chosen.map((c) => { cells(P, c.set); return { inks: c.set.map((i) => pool.names[i]), ...score(P.lab, art, penalty) }; });
  }

  /** fit() on a Web Worker built from this same file, so the page keeps answering clicks while it searches; on the
   *  page's thread where workers are refused (a strict page policy, an old browser, Node). */
  function fitInWorker(art, pool, opts) {
    const here = () => new Promise((ok) => ok(fit(art, pool, opts)));
    let worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([`(${factory})(self);
onmessage = ({ data: [art, pool, opts] }) => {
  try { postMessage({ found: self.OverprintFit.fit(art, pool, opts) }); }
  catch (err) { postMessage({ error: String(err && err.message || err) }); }
};`], { type: 'text/javascript' })));
    } catch { return here(); }
    return new Promise((ok, fail) => {
      worker.onmessage = ({ data }) => { worker.terminate(); if (data.error) fail(new Error(data.error)); else ok(data.found); };
      worker.onerror = (e) => { e.preventDefault(); worker.terminate(); here().then(ok, fail); }; // could not start
      worker.postMessage([art, pool, opts || {}]);
    });
  }

  const api = { poolFrom, printedColours, scoreSet, artColours, fit, fitInWorker };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OverprintFit = api;
})(globalThis);
