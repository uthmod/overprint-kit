"""分色: split a four-ink overprint illustration into four spot plates.

Each pixel is snapped to the nearest of the palette's 16 printable colours
(bare paper + 4 solo inks + 11 overprints, from palette.json), in Lab space.
That colour tells which inks are on, so each plate is a plain on/off mask.
First the art is traced into shapes (lines where the colour jumps); each shape gets one printable colour,
which wins its close calls, so a flat fill can't flicker between two colours. Fine dark features (hair strands, a rose's
spiral, a small shadow) are traced too and printed in a colour darker than the fill around them.

    python separate.py <image.png> <palette.json>
    -> <image>-plate1-223U.png ... <image>-proof.png, <image>-sheet.png, <image>-lines.png (next to the image)
    python separate.py <image.png> <palette.json> --penalty 6   # for art that uses the overlap colours on purpose
    python separate.py --check <palette.json> [...]             # every exact palette colour lands on its own inks
    python separate.py <image.png> <palette.json> --print other.json --screen 4:60
        # classify against palette.json (the colours the art was drawn in), print with other.json's inks,
        # and print every pixel labelled mask 4 (ink 3 alone) as a 60% halftone instead of solid
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

SCALE = 3
# ponytail: generated art is a little off the true ink colours; charging ~8 dE per extra overprinted ink makes a muted pink
# snap to 223 U rather than a 3-ink mauve. Raise it if plates grow stray overprints, lower it if dark lines vanish.
# It is intent, not physics: art that uses the overlap colours on purpose (a 15-colour map) wants --penalty 6, or
# its darker, more saturated overlaps (GPT Image overshoots them) fall back to fewer inks and go blotchy.
INK_PENALTY = 8.0
L_WEIGHT = 0.3
EXACT_DE = 4.0
# shapes: a colour slope above EDGE_DE (dE per pixel) is a traced line; a shape's colour wins any pixel inside it that
# scores within TIE_DE of the pixel's own best. TIE_DE 20 let a soft-edged pale sparkle leak into the paper; 8 left flicker.
EDGE_DE = 3.0
TIE_DE = 12.0
MIN_AREA = 12  # px at original size; smaller shapes (screentone dots, noise) get no shape colour
# fine features: anything narrower than FINE_PX (original px) and FINE_DE darker than what surrounds it.
# Nearest-colour snaps a dark-blue strand on pale-blue hair back to the fill (no printable shade between them), and the
# mode filter erases 1-px lines, so each lost piece picks among colours darker than its fill, painted last.
# ponytail: dark only. Light features (highlights, 1-px paper keylines) were tried: the pale hair fill between dark strands
# read as "light lines" and went to bare paper, and rose petals speckled orange.
FINE_PX = 11
FINE_DE = 6.0
FINE_MIN = 4  # px at original size; smaller pieces are grain
# soft edges: a line pixel whose colour lies within BLEND_RGB of the mix of the two nearest shapes (within BLEND_R px)
# prefers the closer shape's colour (the TIE_DE rule, like inside a shape), so an anti-aliased edge doesn't print a third,
# darker ink (slivers at a low --penalty). An outline darker than both sides is no mix of them and keeps its own colour.
BLEND_R = 3
BLEND_RGB = 20.0
N_INKS = np.array([max(bin(m).count("1") - 1, 0) for m in range(16)])  # paper and solo inks are free
# halftone screens (--screen MASK:PCT): pixels labelled MASK print that mask's inks as dots instead of solid.
# ponytail: plain round AM dots and no dot-gain curve. Riso dots gain ~10-20%, so ask for less than the tone you want.
SCREEN_PX = 6  # dot pitch in plate pixels; plates are ~300 dpi at 32 cm, so 6 px = 50 lpi
SCREEN_ANGLE = (15, 75, 45, 0)  # degrees per ink, like CMYK, so two screened inks don't moire


def load_set(path):
    """A palette.json (from 疊印色盤, the matrix page, or the kit email): ink names for the plate files, and the
    16 printable colours as RGB, indexed by ink mask (bit 0 = the first ink printed)."""
    import json
    p = json.loads(Path(path).read_text(encoding="utf-8"))
    if len(p["inks"]) != 4 or len(p["cells"]) != 16:
        sys.exit(f"{path}: 分色需要 4 支墨的色盤（這個有 {len(p['inks'])} 支）")
    names = [i["name"].replace(" ", "") for i in p["inks"]]
    return names, np.array([[int(c["hex"][i:i + 2], 16) for i in (0, 2, 4)] for c in p["cells"]], dtype=np.float64)


def palette(path):
    """16 entries indexed by ink mask (bit 0 = ink 1)."""
    return load_set(path)[1]


def to_lab(rgb):
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def classify(rgb, pal, prefer=None):
    """Label each pixel with the ink mask of its nearest printable colour; returns (labels, mean dE).
    prefer: optional per-pixel label (-1 = none) that wins wherever it scores within TIE_DE of the pixel's best."""
    lab, pal_lab = to_lab(rgb).reshape(-1, 3), to_lab(pal)
    idx = np.empty(len(lab), np.uint8)
    de = 0.0
    for i in range(0, len(lab), 1 << 20):  # chunked: the 3x image is ~29M pixels
        diff = lab[i:i + (1 << 20), None, :] - pal_lab[None, :, :]
        # ponytail: lightness is asymmetric. A pixel LIGHTER than a candidate costs only L_WEIGHT (a pale tint still
        # reads as its ink, not paper); a pixel DARKER costs full weight (a dark overlap never collapses to one ink).
        dl = np.where(diff[..., 0] > 0, L_WEIGHT, 1.0) * diff[..., 0]
        d = np.sqrt(dl ** 2 + diff[..., 1] ** 2 + diff[..., 2] ** 2)
        # the ink penalty only breaks ties between off-palette guesses; a near-exact printable colour always wins
        sc = d + INK_PENALTY * N_INKS * (d > EXACT_DE)
        best = sc.argmin(1)
        if prefer is not None:
            p, r = prefer.ravel()[i:i + len(d)].astype(np.intp), np.arange(len(d))
            best = np.where((p >= 0) & (sc[r, np.maximum(p, 0)] - sc[r, best] < TIE_DE), p, best)
        idx[i:i + len(d)] = best
        de += d[np.arange(len(d)), best].sum()
    return idx.reshape(rgb.shape[:2]), de / len(lab)


def screen(h, w, ink, pct):
    """On/off halftone dots covering pct of an h x w plate, at the ink's own screen angle."""
    a = np.radians(SCREEN_ANGLE[ink])
    y, x = np.mgrid[:h, :w].astype(np.float32)
    k = np.float32(2 * np.pi / SCREEN_PX)
    spot = np.cos((x * np.cos(a) + y * np.sin(a)) * k) + np.cos((y * np.cos(a) - x * np.sin(a)) * k)
    return spot > np.quantile(spot, 1 - pct)


def self_check(palette_paths):
    """Every one of a palette's 16 colours must separate to exactly its own inks. Rerun after touching a knob."""
    for n in palette_paths:
        pal = palette(n)
        idx, _ = classify(np.repeat(pal[:, None, :], 2, 1), pal)
        bad = [m for m in range(16) if (idx[m] != m).any()]
        assert not bad, f"{n}: colours {bad} do not separate to their own inks"
    # a grainy fill halfway between two printable colours must come out as ONE colour (shapes), not flicker between them
    pal = palette(palette_paths[0])
    ramp = pal[4] + np.linspace(0, 1, 101)[:, None] * (pal[8] - pal[4])
    img = np.full((120, 120, 3), pal[0])
    img[30:90, 30:90] = ramp[np.argmax(classify(ramp[None], pal)[0][0] != 4)]  # right where ink 3 turns into ink 4
    img = np.clip(img + np.random.default_rng(0).normal(0, 1.5, img.shape), 0, 255).astype(np.uint8)
    inner = labels(Image.fromarray(img), pal)[0][35 * SCALE:85 * SCALE, 35 * SCALE:85 * SCALE]
    assert (inner == np.bincount(inner.ravel()).argmax()).mean() > 0.99, "a flat fill flickers between two colours"
    # a 1-px line a little darker than its flat fill survives, printed darker than the fill
    img = np.full((90, 90, 3), pal[0])
    img[20:70, 20:70] = pal[4]
    img[45, 25:65] = pal[4] * 0.8
    img = np.clip(img + np.random.default_rng(0).normal(0, 1.5, img.shape), 0, 255).astype(np.uint8)
    idx = labels(Image.fromarray(img), pal)[0]
    fill, dark = (np.bincount(idx[r * SCALE + 1, 30 * SCALE:60 * SCALE]).argmax() for r in (30, 45))
    assert to_lab(pal[dark])[0] < to_lab(pal[fill])[0] - 2, f"a dark 1-px line on colour {fill} came out as {dark}"
    # a soft edge between two printable colours prints only those two, even at a low --penalty (no dark slivers)
    global INK_PENALTY
    saved, INK_PENALTY = INK_PENALTY, 3.0
    try:
        for n in palette_paths:
            pal = palette(n)
            for c1, c2 in [(1, 0), (2, 1), (4, 0), (8, 0), (1, 4)]:
                img = np.full((90, 90, 3), pal[c2])
                yy, xx = np.mgrid[:90, :90]
                img[xx + 0.6 * yy < 70] = pal[c1]
                img = cv2.GaussianBlur(img.astype(np.float32), (0, 0), 0.8)
                img = np.clip(img + np.random.default_rng(0).normal(0, 1.5, img.shape), 0, 255).astype(np.uint8)
                idx = labels(Image.fromarray(img), pal)[0]
                assert np.isin(idx, [c1, c2]).all(), f"{Path(n).stem}: a soft edge between colours {c1} and {c2} prints a third colour"
    finally:
        INK_PENALTY = saved
    assert abs(screen(300, 300, 2, 0.4).mean() - 0.4) < 0.01, "a 40% screen does not cover 40%"
    print("self-check ok:", ", ".join(Path(n).stem for n in palette_paths))


def trace(orig):
    """Line layer and the shapes it closes off. Returns (lines, shape id per pixel, count); id 0 = on a line or too small."""
    lab = to_lab(np.asarray(orig, dtype=np.float64)).astype(np.float32)
    g = sum(cv2.Sobel(lab[..., c], cv2.CV_32F, 1, 0) ** 2 + cv2.Sobel(lab[..., c], cv2.CV_32F, 0, 1) ** 2 for c in range(3))
    lines = np.sqrt(g) / 8 > EDGE_DE  # Sobel's gain is 8 for a slope of 1 per pixel
    n, shape = cv2.connectedComponents((~lines).astype(np.uint8), connectivity=4)
    shape[np.bincount(shape.ravel(), minlength=n)[shape] < MIN_AREA] = 0
    return lines, shape, n


def shape_colours(orig, pal):
    """Each shape's printable colour from its mean colour; lines and tiny shapes get -1 (no preference)."""
    lines, shape, n = trace(orig)
    rgb, s = np.asarray(orig, dtype=np.float64).reshape(-1, 3), shape.ravel()
    mean = np.stack([np.bincount(s, rgb[:, k], minlength=n) for k in range(3)], 1) / np.maximum(np.bincount(s, minlength=n), 1)[:, None]
    lbl = classify(mean[None], pal)[0][0].astype(np.int8)
    lbl[0] = -1
    return lines, shape, lbl, mean


def edge_prefer(shape, mean, lbl, img, prefer):
    """Soft edges (in place on prefer, at SCALE x): a line pixel between two shapes whose colour is a mix of theirs
    prefers the nearer one's label."""
    h, w = shape.shape
    offs = sorted(((dy, dx) for dy in range(-BLEND_R, BLEND_R + 1) for dx in range(-BLEND_R, BLEND_R + 1)),
                  key=lambda o: (o[0] ** 2 + o[1] ** 2, o[0], o[1]))
    pad = np.pad(shape, BLEND_R)
    near = [pad[BLEND_R + dy:BLEND_R + dy + h, BLEND_R + dx:BLEND_R + dx + w] for dy, dx in offs]
    a = np.zeros_like(shape)
    for s in near:  # the nearest shape
        a = np.where(a == 0, s, a)
    b = np.zeros_like(shape)
    for s in near:  # and the nearest other one
        b = np.where((b == 0) & (s != 0) & (s != a), s, b)
    both = (shape == 0) & (a > 0) & (b > 0)
    ys, xs = np.nonzero(np.repeat(np.repeat(both, SCALE, 0), SCALE, 1))
    a, b = a[ys // SCALE, xs // SCALE], b[ys // SCALE, xs // SCALE]
    p, ca, cb = img[ys, xs], mean[a], mean[b]
    v0, v1, v2 = cb[:, 0] - ca[:, 0], cb[:, 1] - ca[:, 1], cb[:, 2] - ca[:, 2]
    vv = v0 * v0 + v1 * v1 + v2 * v2
    t = ((p[:, 0] - ca[:, 0]) * v0 + (p[:, 1] - ca[:, 1]) * v1 + (p[:, 2] - ca[:, 2]) * v2) / np.maximum(vv, 1e-9)
    tc = np.clip(t, 0, 1)
    d0, d1, d2 = p[:, 0] - (ca[:, 0] + tc * v0), p[:, 1] - (ca[:, 1] + tc * v1), p[:, 2] - (ca[:, 2] + tc * v2)
    mix = (vv > 0) & (d0 * d0 + d1 * d1 + d2 * d2 < BLEND_RGB * BLEND_RGB)
    prefer[ys[mix], xs[mix]] = np.where(t[mix] < 0.5, lbl[a[mix]], lbl[b[mix]])


def fine_features(orig, img, pal, idx):
    """Paint fine dark features over idx (in place). Each connected piece takes the printable colour nearest to it
    (plain dE, so a pale grey line stays as light as the palette allows) among those darker than the fill it sits on."""
    a = np.asarray(orig, dtype=np.float64)
    pal_lab = to_lab(pal)
    # the surroundings: closing wipes out anything dark and narrower than FINE_PX
    bg = cv2.morphologyEx(a.astype(np.float32), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (FINE_PX,) * 2))
    bg = bg.astype(np.float64)
    h, w = idx.shape
    diff = cv2.resize((to_lab(bg)[..., 0] - to_lab(a)[..., 0]).astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    on = diff > FINE_DE
    ys, xs = np.nonzero(on)
    if not len(ys):
        return
    # pieces: connected feature pixels of one nearest colour, so touching features keep their own colours
    # (a yellow rope tied to a slate harpoon, a gold watch hung on blue outlines)
    near = np.full((h, w), 255, np.uint8)
    near[ys, xs] = classify(img[ys, xs][None], pal)[0][0]
    seg, n = np.zeros((h, w), np.int32), 1
    for m in np.unique(near[ys, xs]):
        c, s = cv2.connectedComponents((near == m).astype(np.uint8), connectivity=8)
        seg = np.where(s > 0, s + n - 1, seg)
        n += c - 1
    # the fill each piece sits on: the darkest colour making up >= 25% of a ring around it (an outline between hair and
    # paper must stand out from the hair), counted where the art is flat, or an eye's own soft rim reads as its fill
    grown = cv2.dilate(seg.astype(np.float32), np.ones((9, 9), np.uint8)).astype(np.intp)
    ry, rx = np.nonzero((grown > 0) & (diff <= 2))
    rs, rl = grown[ry, rx], idx[ry, rx]
    cnt = np.bincount(rs * 16 + rl, minlength=n * 16).reshape(n, 16)
    host = np.where(cnt >= 0.25 * cnt.sum(1, keepdims=True), pal_lab[None, :, 0], np.inf).argmin(1)
    # and how light that fill really is in the art: a drop's pointed tip is as dark as its body, not a line on it
    on_host = rl == host[rs]
    host_l = np.bincount(rs[on_host], to_lab(img[ry[on_host], rx[on_host]])[:, 0], minlength=n)
    host_l /= np.maximum(np.bincount(rs[on_host], minlength=n), 1)
    s, dv = seg[ys, xs], diff[ys, xs]
    peak = np.zeros(n)
    np.maximum.at(peak, s, dv)
    core = dv >= 0.6 * peak[s]  # the feature's middle, not its anti-aliased edges
    col = np.stack([np.bincount(s[core], img[ys[core], xs[core], ch], minlength=n) for ch in range(3)], 1)
    col /= np.maximum(np.bincount(s[core], minlength=n), 1)[:, None]
    col_lab = to_lab(col)
    d = np.linalg.norm(col_lab[:, None] - pal_lab[None], axis=2)
    sc = d + INK_PENALTY * N_INKS * (d > EXACT_DE)
    darker = pal_lab[None, :, 0] < pal_lab[host, 0][:, None] - 2  # colours that still show against the fill
    sc[~darker] = np.inf
    pick = sc.argmin(1)
    own = np.zeros(n, np.intp)
    own[s] = near[ys, xs]
    pick = np.where(darker[np.arange(n), own], own, pick)  # its own nearest colour, when that already shows
    area = np.bincount(s, minlength=n)
    # leave pieces that already show: the shapes kept a pocket watch ring or an eye dot, only lost lines need help
    shown = np.bincount(s, darker[s, idx[ys, xs]], minlength=n) >= 0.5 * area
    keep = (area >= FINE_MIN * SCALE ** 2) & np.isfinite(sc.min(1)) & ~shown & (host_l - col_lab[:, 0] > FINE_DE)
    keep[0] = False
    on = keep[s]
    idx[ys[on], xs[on]] = pick[s[on]]


def labels(orig, pal):
    """Ink mask per pixel at SCALE x the original; returns (labels, mean dE, traced lines)."""
    # ponytail: 3x Lanczos upscale first so 1-2px line art keeps a solid core instead of breaking into dashes
    img = np.asarray(orig.resize((orig.width * SCALE, orig.height * SCALE), Image.LANCZOS), dtype=np.float64)
    h, w, _ = img.shape
    # lines keep their per-pixel colour, so thin features (outlines, a rope) survive as they did before shapes
    lines, shape, lbl, mean = shape_colours(orig, pal)
    prefer = lbl[cv2.resize(shape, (w, h), interpolation=cv2.INTER_NEAREST)]
    edge_prefer(shape, mean, lbl, img, prefer)
    idx, de = classify(img, pal, prefer)
    # ponytail: mode filter kills risograph grain speckle; raise the size if plates look noisy
    idx = np.array(Image.fromarray(idx, "L").filter(ImageFilter.ModeFilter(7)))
    fine_features(orig, img, pal, idx)
    return idx, de, lines


def separate(src, palette_path, out_dir, print_path=None, screens={}):
    orig = Image.open(src).convert("RGB")
    idx, de, lines = labels(orig, palette(palette_path))
    h, w = idx.shape
    # the labels say which inks go where; --print swaps in other inks (the art stays drawn for palette_path)
    names, pal = load_set(print_path or palette_path)[0], palette(print_path or palette_path)

    stem = Path(src).stem
    Image.fromarray(np.where(lines, 0, 255).astype(np.uint8), "L").save(out_dir / f"{stem}-lines.png")
    plates, printed = [], np.zeros_like(idx)
    for b, n in enumerate(names):
        on = (idx >> b) & 1
        for m, pct in screens.items():
            if m >> b & 1:
                on = np.where(idx == m, screen(h, w, b, pct), on).astype(np.uint8)
        printed |= on << b
        plate = Image.fromarray(np.where(on, 0, 255).astype(np.uint8), "L")
        plate.save(out_dir / f"{stem}-plate{b + 1}-{n}.png")
        plates.append((n, on.mean()))
    proof = Image.fromarray(pal[printed].astype(np.uint8), "RGB")  # from the plates, so halftone dots show
    proof.save(out_dir / f"{stem}-proof.png")

    # sheet: original | proof on top, the four plates below
    tw, th = w // (2 * SCALE), h // (2 * SCALE)
    sheet = Image.new("RGB", (tw * 4, th * 3), "white")
    sheet.paste(orig.resize((tw * 2, th * 2)), (0, 0))
    sheet.paste(proof.resize((tw * 2, th * 2)), (tw * 2, 0))
    for b, n in enumerate(names):
        sheet.paste(Image.open(out_dir / f"{stem}-plate{b + 1}-{n}.png").convert("RGB").resize((tw, th)), (tw * b, th * 2))
    sheet.save(out_dir / f"{stem}-sheet.png")
    return de, plates, np.bincount(idx.ravel(), minlength=16) / idx.size


if __name__ == "__main__":
    if len(sys.argv) < 3:  # both modes need a palette.json
        sys.exit(__doc__)
    if sys.argv[1] == "--check":  # python separate.py --check palette.json [...]
        self_check(sys.argv[2:])
        sys.exit()
    if "--penalty" in sys.argv:
        i = sys.argv.index("--penalty")
        INK_PENALTY = float(sys.argv.pop(i + 1))
        sys.argv.pop(i)
    print_path, screens = None, {}
    while "--print" in sys.argv or "--screen" in sys.argv:
        i = next(i for i, a in enumerate(sys.argv) if a in ("--print", "--screen"))
        flag, val = sys.argv.pop(i), sys.argv.pop(i)
        if flag == "--print":
            print_path = val
        else:
            m, pct = val.split(":")
            screens[int(m)] = float(pct) / 100
    src, palette_path = sys.argv[1], sys.argv[2]
    de, plates, share = separate(src, palette_path, Path(src).parent, print_path, screens)
    print(f"{Path(palette_path).stem}: mean dE to nearest printable colour {de:.1f}; ink coverage " +
          ", ".join(f"{n} {c:.0%}" for n, c in plates))
    # share of the image per printable colour, by ink mask (0 = bare paper); < 0.1% counts as unused
    print(f"colours used {(share[1:] >= 0.001).sum()}/15: " + " ".join(f"{m}:{share[m]:.1%}" for m in range(16)))
