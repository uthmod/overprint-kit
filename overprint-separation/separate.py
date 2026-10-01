"""分色: split a four-ink overprint illustration into four spot plates.

Each pixel is snapped to the nearest of the palette's 16 printable colours
(bare paper + 4 solo inks + 11 overprints, from palette.json), in Lab space.
That colour tells which inks are on, so each plate is a plain on/off mask. Screened colours go on the plates as flat
greys at their percentage, for the plate-maker's RIP to screen; the proof shows them as dots.
First the art is traced into shapes (lines where the colour jumps); each shape gets one printable colour,
which wins its close calls, so a flat fill can't flicker between two colours. Fine dark features (hair strands, a rose's
spiral, a small shadow) are traced too and printed in a colour darker than the fill around them.

    python separate.py <image.png> <palette.json>
    -> <image>-plate1-223U.tif ... <image>-proof.png, <image>-sheet.png, <image>-lines.png (next to the image)
    python separate.py <image.png> <palette.json> --penalty 6   # for art that uses the overlap colours on purpose
    python separate.py --check <palette.json> [...]             # every exact palette colour lands on its own inks
    python separate.py <image.png> <palette.json> --print other.json --screen 4:60
        # classify against palette.json (the colours the art was drawn in), print with other.json's inks,
        # and print every pixel labelled mask 4 (ink 3 alone) as a 60% halftone instead of solid
    python separate.py <image.png> <palette.json> --screen-colour F8C4A2=2:50@252,507 --width 12
        # the art's own #F8C4A2 becomes one more colour, printed as ink 2 in 50% dots in the area at 252,507 (a face; without
        # @x,y everywhere it matches). On the plate that area is 50% grey for the RIP; the proof shows 80 lpi dots
        # when the picture prints 12 cm wide (without --width: plates at 1200 dpi, i.e. art drawn at 600 dpi).
        # <image>-製版說明.txt tells the plate-maker the size, angles and tints.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

# ponytail: the art is enlarged SCALE× before classifying. 2 (founder, 2026-10-01): art prepared at 600 dpi at print size
# gives 1200 dpi plates; enlarging a small picture more only magnifies its blur and noise. Was 3 until v17.
SCALE = 2
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
MASKS = np.arange(16)  # labels 0-15 are the palette's 16 colours, each its own ink mask; screened colours come after
# halftone screens: --screen MASK:PCT prints every pixel of that colour as dots; --screen-colour RRGGBB=MASK:PCT adds the
# art's own RRGGBB as one more colour, printed as MASK's inks in PCT% dots (a face paler than the hair it shares an ink with).
# The plates carry them as flat greys (plate_tones) so the plate-maker's RIP screens them, with its own dot-gain curve.
# ponytail: the proof's dots are plain round AM dots with no dot-gain curve, a preview only.
LPI = 80  # the proof's screen ruling in lines per inch, at the printed size
DPI = 1200  # the printed plate resolution when --width isn't given: art at 600 dpi × SCALE 2
# per ink 15, 75, 45, 0 degrees (like CMYK, so two screened inks don't moire), as literals so separate.js matches bit for bit
SCREEN_COS = (0.9659258262890683, 0.25881904510252074, 0.7071067811865476, 1.0)
SCREEN_SIN = (0.25881904510252074, 0.9659258262890683, 0.7071067811865476, 0.0)


def load_set(path):
    """A palette.json (from 疊印色盤, the matrix page, or the kit email): ink names ("223 U"; plate files drop the space), and the
    16 printable colours as RGB, indexed by ink mask (bit 0 = the first ink printed)."""
    import json
    p = json.loads(Path(path).read_text(encoding="utf-8"))
    if len(p["inks"]) != 4 or len(p["cells"]) != 16:
        sys.exit(f"{path}: 分色需要 4 支墨的色盤（這個有 {len(p['inks'])} 支）")
    field = lambda x, k: x[k] if isinstance(x, dict) else x  # older palette.json files: plain "E1E3E0" and "720U"
    names = [field(i, "name") for i in p["inks"]]
    hexes = [field(c, "hex").lstrip("#") for c in p["cells"]]
    return names, np.array([[int(h[i:i + 2], 16) for i in (0, 2, 4)] for h in hexes], dtype=np.float64)


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


def classify(rgb, pal, prefer=None, masks=MASKS):
    """Label each pixel with its nearest printable colour (an index into pal, whose ink masks are masks); returns
    (labels, mean dE). prefer: optional per-pixel label (-1 = none) that wins wherever it scores within TIE_DE of the best,
    except over a screened colour (label 16+): those are chosen to tell apart areas sharing an ink (a face beside the hair),
    which a soft boundary often leaves in one traced shape, so a pixel that looks most like one keeps it. A pixel more than
    EXACT_DE darker than a screened colour never takes it."""
    lab, pal_lab = to_lab(rgb).reshape(-1, 3), to_lab(pal)
    cost = INK_PENALTY * N_INKS[masks]
    idx = np.empty(len(lab), np.uint8)
    de = 0.0
    for i in range(0, len(lab), 1 << 20):  # chunked: the 3x image is ~29M pixels
        diff = lab[i:i + (1 << 20), None, :] - pal_lab[None, :, :]
        # ponytail: lightness is asymmetric. A pixel LIGHTER than a candidate costs only L_WEIGHT (a pale tint still
        # reads as its ink, not paper); a pixel DARKER costs full weight (a dark overlap never collapses to one ink).
        dl = np.where(diff[..., 0] > 0, L_WEIGHT, 1.0) * diff[..., 0]
        d = np.sqrt(dl ** 2 + diff[..., 1] ** 2 + diff[..., 2] ** 2)
        # the ink penalty only breaks ties between off-palette guesses; a near-exact printable colour always wins
        sc = d + cost * (d > EXACT_DE)
        # a screen prints its colour paler than the solid ink, so a pixel darker than a screened colour stays solid:
        # screen a teacup's body and its darker inside still prints solid, darker than the body
        sc[:, 16:][diff[:, 16:, 0] < -EXACT_DE] = np.inf
        best = sc.argmin(1)
        if prefer is not None:
            p, r = prefer.ravel()[i:i + len(d)].astype(np.intp), np.arange(len(d))
            wins = (p >= 0) & (sc[r, np.maximum(p, 0)] - sc[r, best] < TIE_DE) & ((best < 16) | (p >= 16))
            best = np.where(wins, p, best)
        idx[i:i + len(d)] = best
        de += d[np.arange(len(d)), best].sum()
    return idx.reshape(rgb.shape[:2]), de / len(lab)


def screen(ys, xs, ink, pct, pitch):
    """Whether plate pixels (ys, xs) fall inside round halftone dots covering pct, pitch plate px apart at the ink's own
    angle. Plain arithmetic per pixel (no trig), so separate.js draws the same dots bit for bit."""
    c, s = SCREEN_COS[ink], SCREEN_SIN[ink]
    x, y = xs + 0.5, ys + 0.5
    u, v = (x * c + y * s) / pitch, (y * c - x * s) / pitch
    fu, fv = u - np.floor(u) - 0.5, v - np.floor(v) - 0.5
    if pct <= 0.5:  # an ink dot in the middle of each cell
        return fu * fu + fv * fv < pct / np.pi
    gu, gv = 0.5 - np.abs(fu), 0.5 - np.abs(fv)  # past 50%: round paper holes at the cell corners
    return gu * gu + gv * gv >= (1 - pct) / np.pi


def screen_area(idx, k, shape, seeds):
    """Where screened colour k prints as dots: its connected areas (8-connected, at plate size) that a clicked point
    (x, y in original px) falls in, or that overlap the clicked point's traced shape (a soft face/hair boundary leaves the
    face inside the hair's shape, so the click can land on either)."""
    n, comp = cv2.connectedComponents((idx == k).astype(np.uint8), connectivity=8)
    h, w = shape.shape
    blocks = comp.reshape(h, SCALE, w, SCALE)
    hit = np.zeros(n, bool)
    for x, y in seeds:
        hit[blocks[y, :, x, :]] = True
        if shape[y, x]:
            ys, xs = np.nonzero(shape == shape[y, x])
            hit[blocks[ys, :, xs, :]] = True
    hit[0] = False
    return hit[comp]


def print_masks(idx, masks, pcts, pitch, areas={}):
    """The ink mask each plate pixel prints: its label's mask, as halftone dots where that label has a pct (0 = solid)
    and, if areas has a mask for it, only inside that mask (elsewhere it prints solid)."""
    out = masks[idx].astype(np.uint8)
    for k in np.nonzero(pcts)[0]:
        ys, xs = np.nonzero((idx == k) & areas[k] if k in areas else idx == k)
        on = np.zeros(len(ys), np.uint8)
        for b in range(4):
            if masks[k] >> b & 1:
                on |= screen(ys, xs, b, pcts[k], pitch).astype(np.uint8) << b
        out[ys, xs] = on
    return out


def plate_tones(idx, masks, pcts, areas={}):
    """The plates for the plate-maker's RIP, one uint8 image per ink: 0 where the ink prints solid, a flat grey
    255 × (1 − pct) where its label is screened (inside areas[label] if given; 50% → 128), 255 elsewhere.
    print_masks' dots are only the proof's preview of how the RIP will screen these greys."""
    tint = np.where(pcts > 0, np.floor(255 * (1 - pcts) + 0.5), 0).astype(np.uint8)  # floor(+0.5): rounds like separate.js
    level = tint[idx]
    for k in areas:
        level[(idx == k) & ~areas[k]] = 0  # outside its clicked areas a screened colour prints solid
    m = masks.astype(np.uint8)[idx]
    return [np.where(m >> b & 1, level, 255).astype(np.uint8) for b in range(4)]


def plate_note(names, tones, dpi):
    """製版說明.txt for the plate-maker: what the greys mean, the size, and each plate's angle and tints."""
    h, w = tones[0].shape
    lines = ["給製版廠的說明", "",
             f"這 {len(names)} 塊印版是灰階圖，網點還沒有做，請用 RIP 加網：",
             "・黑色＝100% 實地",
             "・灰色＝網點，灰階值就是網點大小，例如 50% 灰＝50% 網點",
             "・白色＝不上墨",
             "印版沒有做網點擴大補償，請依貴廠的設定處理。", "",
             f"尺寸：{w} × {h} 像素，{dpi:.0f} dpi，印出來 {w / dpi * 2.54:.1f} × {h / dpi * 2.54:.1f} 公分。",
             f"網點設定（印刷模擬用的設定，可依貴廠建議調整）：圓點，{LPI} lpi。", ""]
    for b, (n, t) in enumerate(zip(names, tones)):
        angle = round(np.degrees(np.arctan2(SCREEN_SIN[b], SCREEN_COS[b])))
        greys = sorted({int(v) for v in np.unique(t)} - {0, 255})
        pcts = "、".join(f"{round(100 - v / 2.55)}%" for v in greys)
        what = f"網點 {pcts}" if greys else "只有實地" if (t == 0).any() else "空白（沒有用到這支油墨）"
        lines.append(f"{b + 1}. {n}，角度 {angle}°：{what}")
    return "﻿" + "\n".join(lines) + "\n"  # BOM: older Windows editors read the Chinese right


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
    ys, xs = (a.ravel() for a in np.mgrid[:300, :300])
    for pct in (0.2, 0.5, 0.8):
        assert abs(screen(ys, xs, 2, pct, DPI / LPI).mean() - pct) < 0.02, f"a {pct:.0%} screen does not cover {pct:.0%}"
    # a screened colour: a fill paler than ink 2 (a face) prints as ink 2 dots, the solid ink 2 beside it (hair) stays solid
    pal = palette(palette_paths[0])
    face = pal[2] * 0.6 + pal[0] * 0.4
    img = np.full((90, 90, 3), pal[0])
    img[10:80, 10:45], img[10:80, 45:80] = pal[2], face
    img = np.clip(img + np.random.default_rng(0).normal(0, 1.5, img.shape), 0, 255).astype(np.uint8)
    masks = np.append(MASKS, 2)
    idx = labels(Image.fromarray(img), np.vstack([pal, face]), masks)[0]
    hair, skin = idx[15 * SCALE:75 * SCALE, 15 * SCALE:40 * SCALE], idx[15 * SCALE:75 * SCALE, 50 * SCALE:75 * SCALE]
    assert (hair == 2).mean() > 0.99 and (skin == 16).mean() > 0.99, "a screened colour is not told apart from its solid ink"
    dots = print_masks(idx, masks, np.append(np.zeros(16), 0.5), DPI / LPI)[15 * SCALE:75 * SCALE, 50 * SCALE:75 * SCALE]
    assert abs((dots == 2).mean() - 0.5) < 0.03 and np.isin(dots, [0, 2]).all(), "a 50% screened colour does not print 50% dots"
    # clicked areas: two patches of the screened colour, only the clicked one prints as dots, the other stays solid ink
    img[10:80, 10:45] = pal[0]
    img[10:40, 45:80], img[40:45, 45:80] = face, pal[0]
    img = np.clip(img + np.random.default_rng(1).normal(0, 1.5, img.shape), 0, 255).astype(np.uint8)
    idx = labels(Image.fromarray(img), np.vstack([pal, face]), masks)[0]
    area = screen_area(idx, 16, trace(Image.fromarray(img))[1], [(60, 25)])
    out = print_masks(idx, masks, np.append(np.zeros(16), 0.5), DPI / LPI, {16: area})
    top, low = out[15 * SCALE:35 * SCALE, 50 * SCALE:75 * SCALE], out[50 * SCALE:75 * SCALE, 50 * SCALE:75 * SCALE]
    assert abs((top == 2).mean() - 0.5) < 0.05 and (low == 2).mean() > 0.99, "a screen is not limited to the clicked area"
    # the RIP plates: the clicked area is a flat 50% grey on ink 2's plate, the other patch solid, other plates blank
    tones = plate_tones(idx, masks, np.append(np.zeros(16), 0.5), {16: area})
    t2 = tones[1]
    assert (t2[15 * SCALE:35 * SCALE, 50 * SCALE:75 * SCALE] == 128).mean() > 0.99, "a 50% screen is not a 50% grey plate"
    assert (t2[50 * SCALE:75 * SCALE, 50 * SCALE:75 * SCALE] == 0).mean() > 0.99, "an unclicked area is not solid on the plate"
    assert all((tones[b] == 255).all() for b in (0, 2, 3)), "a screen put grey on another ink's plate"
    # a teacup: its body screened, its darker inside (nearer the body's colour than any ink) stays solid
    cup, inside = pal[4] * 0.92, pal[4] * 0.8
    img = np.full((90, 90, 3), pal[0])
    img[10:80, 10:80], img[10:40, 20:70] = cup, inside
    img = np.clip(img + np.random.default_rng(0).normal(0, 1.5, img.shape), 0, 255).astype(np.uint8)
    idx = labels(Image.fromarray(img), np.vstack([pal, cup]), np.append(MASKS, 4))[0]
    body, dark = idx[50 * SCALE:75 * SCALE, 15 * SCALE:75 * SCALE], idx[15 * SCALE:35 * SCALE, 25 * SCALE:65 * SCALE]
    assert (body == 16).mean() > 0.99 and (dark == 16).mean() < 0.01, "a colour darker than a screened one is screened too"
    print("self-check ok:", ", ".join(Path(n).stem for n in palette_paths))


def trace(orig):
    """Line layer and the shapes it closes off. Returns (lines, shape id per pixel, count); id 0 = on a line or too small."""
    lab = to_lab(np.asarray(orig, dtype=np.float64)).astype(np.float32)
    g = sum(cv2.Sobel(lab[..., c], cv2.CV_32F, 1, 0) ** 2 + cv2.Sobel(lab[..., c], cv2.CV_32F, 0, 1) ** 2 for c in range(3))
    lines = np.sqrt(g) / 8 > EDGE_DE  # Sobel's gain is 8 for a slope of 1 per pixel
    n, shape = cv2.connectedComponents((~lines).astype(np.uint8), connectivity=4)
    shape[np.bincount(shape.ravel(), minlength=n)[shape] < MIN_AREA] = 0
    return lines, shape, n


def shape_colours(orig, pal, masks=MASKS):
    """Each shape's printable colour from its mean colour; lines and tiny shapes get -1 (no preference)."""
    lines, shape, n = trace(orig)
    rgb, s = np.asarray(orig, dtype=np.float64).reshape(-1, 3), shape.ravel()
    mean = np.stack([np.bincount(s, rgb[:, k], minlength=n) for k in range(3)], 1) / np.maximum(np.bincount(s, minlength=n), 1)[:, None]
    lbl = classify(mean[None], pal, masks=masks)[0][0].astype(np.int8)
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


def fine_features(orig, img, pal, idx, shape, mean, masks=MASKS):
    """Paint fine dark features over idx (in place). Each connected piece takes the printable colour nearest to it
    (plain dE, so a pale grey line stays as light as the palette allows) among those darker than the fill it sits on.
    Only the palette's own 16 colours: a line printed as halftone dots would break up. A piece the colour of a traced
    shape it touches (shape, mean: from shape_colours) is that shape's tip or a strand leaving it: it keeps its own colour."""
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
    near[ys, xs] = classify(img[ys, xs][None], pal[:16])[0][0]
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
    K = len(pal)
    cnt = np.bincount(rs * K + rl, minlength=n * K).reshape(n, K)
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
    sc = d + INK_PENALTY * N_INKS[masks] * (d > EXACT_DE)
    darker = pal_lab[None, :, 0] < pal_lab[host, 0][:, None] - 2  # colours that still show against the fill
    sc[~darker] = np.inf
    sc[:, 16:] = np.inf
    pick = sc.argmin(1)
    own = np.zeros(n, np.intp)
    own[s] = near[ys, xs]
    # its own nearest colour when that already shows, or when the piece is a tip: no longer than FINE_PX and the colour of a
    # shape in its ring. A teacup's dark inside narrows to a point at the rim, and that point is no line to print darker
    # than the inside itself; a longer strand leaving a shape still is (hair drawn as dark strands from a dark mass)
    sr = shape[ry // SCALE, rx // SCALE]
    tip = np.bincount(rs, (sr > 0) & (np.linalg.norm(col_lab[rs] - to_lab(mean)[sr], axis=1) < FINE_DE), minlength=n) > 0
    lo, hi = np.full((n, 2), 1 << 30), np.full((n, 2), -1)
    np.minimum.at(lo, s, np.stack([ys, xs], 1)); np.maximum.at(hi, s, np.stack([ys, xs], 1))
    tip &= (hi - lo).max(1) < FINE_PX * SCALE
    pick = np.where(darker[np.arange(n), own] | tip, own, pick)
    area = np.bincount(s, minlength=n)
    # leave pieces that already show: the shapes kept a pocket watch ring or an eye dot, only lost lines need help
    shown = np.bincount(s, darker[s, idx[ys, xs]], minlength=n) >= 0.5 * area
    keep = (area >= FINE_MIN * SCALE ** 2) & np.isfinite(sc.min(1)) & ~shown & (host_l - col_lab[:, 0] > FINE_DE)
    keep[0] = False
    on = keep[s]
    idx[ys[on], xs[on]] = pick[s[on]]


def labels(orig, pal, masks=MASKS):
    """Printable colour per pixel at SCALE x the original, as an index into pal (the palette's 16 colours are their own
    ink masks; screened colours follow, their masks in masks); returns (labels, mean dE, traced lines)."""
    # ponytail: SCALE× Lanczos upscale first so 1-2px line art keeps a solid core instead of breaking into dashes
    img = np.asarray(orig.resize((orig.width * SCALE, orig.height * SCALE), Image.LANCZOS), dtype=np.float64)
    h, w, _ = img.shape
    # lines keep their per-pixel colour, so thin features (outlines, a rope) survive as they did before shapes
    lines, shape, lbl, mean = shape_colours(orig, pal, masks)
    prefer = lbl[cv2.resize(shape, (w, h), interpolation=cv2.INTER_NEAREST)]
    edge_prefer(shape, mean, lbl, img, prefer)
    idx, de = classify(img, pal, prefer, masks)
    # ponytail: mode filter kills risograph grain speckle; raise the size if plates look noisy
    idx = np.array(Image.fromarray(idx, "L").filter(ImageFilter.ModeFilter(2 * SCALE + 1)))  # ~2.5 original px
    fine_features(orig, img, pal, idx, shape, mean, masks)
    return idx, de, lines


def separate(src, palette_path, out_dir, print_path=None, screens={}, colours=(), width=None):
    """screens: {mask: pct} prints every pixel of that colour as dots. colours: [(RRGGBB, mask, pct, seeds)] adds the art's
    own colour RRGGBB as one more printable colour, printed as mask's inks in pct dots: only in the areas clicked at seeds
    [(x, y), ...] (see screen_area), or everywhere when seeds is empty. width: printed width in cm (sets the plates' dpi,
    so the dots come out LPI lines per inch); None = printed at DPI."""
    orig = Image.open(src).convert("RGB")
    rgb = [[int(c[i:i + 2], 16) for i in (0, 2, 4)] for c, *_ in colours]
    pal = np.vstack([palette(palette_path), np.array(rgb, dtype=np.float64).reshape(-1, 3)])
    masks = np.concatenate([MASKS, [c[1] for c in colours]]).astype(np.intp)
    pcts = np.zeros(len(pal))
    for m, pct in screens.items():
        pcts[m] = pct
    pcts[16:] = [c[2] for c in colours]
    idx, de, lines = labels(orig, pal, masks)
    h, w = idx.shape
    dpi = DPI if width is None else w * 2.54 / width
    shape = trace(orig)[1] if any(c[3] for c in colours) else None
    areas = {16 + k: screen_area(idx, 16 + k, shape, c[3]) for k, c in enumerate(colours) if c[3]}
    printed = print_masks(idx, masks, pcts, dpi / LPI, areas)
    # the labels say which inks go where; --print swaps in other inks (the art stays drawn for palette_path)
    names, ink_pal = load_set(print_path or palette_path)

    stem = Path(src).stem
    Image.fromarray(np.where(lines, 0, 255).astype(np.uint8), "L").save(out_dir / f"{stem}-lines.png")
    plates, tones = [], plate_tones(idx, masks, pcts, areas)
    for b, n in enumerate(names):  # greyscale TIFF with no colour profile, so a RIP reads each grey as its tint;
        # PackBits is baseline TIFF (every RIP reads it) and shrinks a flat plate ~30×
        Image.fromarray(tones[b], "L").save(out_dir / f"{stem}-plate{b + 1}-{n.replace(' ', '')}.tif", dpi=(dpi, dpi),
                                            compression="packbits")
        plates.append((n, 1 - tones[b].mean() / 255))
    (out_dir / f"{stem}-製版說明.txt").write_text(plate_note(names, tones, dpi), encoding="utf-8", newline="")  # same bytes as the page
    proof = Image.fromarray(ink_pal[printed].astype(np.uint8), "RGB")  # with the dots the RIP's screen will make
    proof.save(out_dir / f"{stem}-proof.png", dpi=(dpi, dpi))

    # sheet: original | proof on top, the four plates below
    tw, th = w // (2 * SCALE), h // (2 * SCALE)
    sheet = Image.new("RGB", (tw * 4, th * 3), "white")
    sheet.paste(orig.resize((tw * 2, th * 2)), (0, 0))
    sheet.paste(proof.resize((tw * 2, th * 2)), (tw * 2, 0))
    for b, t in enumerate(tones):
        sheet.paste(Image.fromarray(t, "L").convert("RGB").resize((tw, th)), (tw * b, th * 2))
    sheet.save(out_dir / f"{stem}-sheet.png")
    return de, plates, np.bincount(idx.ravel(), minlength=len(pal)) / idx.size, w * 2.54 / dpi


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
    print_path, screens, colours, width = None, {}, [], None
    flags = ("--print", "--screen", "--screen-colour", "--width")
    while any(f in sys.argv for f in flags):
        i = next(i for i, a in enumerate(sys.argv) if a in flags)
        flag, val = sys.argv.pop(i), sys.argv.pop(i)
        if flag == "--print":
            print_path = val
        elif flag == "--width":
            width = float(val)
        elif flag == "--screen":
            m, pct = val.split(":")
            screens[int(m)] = float(pct) / 100
        else:  # --screen-colour F8C4A2=2:50, or F8C4A2=2:50@252,507@317,539 for only the areas clicked at those points
            hexc, spec = val.lstrip("#").split("=")
            spec, *at = spec.split("@")
            m, pct = spec.split(":")
            colours.append((hexc, int(m), float(pct) / 100, [tuple(map(int, a.split(","))) for a in at]))
    for m, pct in [*screens.items(), *((c[1], c[2]) for c in colours)]:
        if not (1 <= m <= 15 and 0 < pct < 1):
            sys.exit(f"--screen / --screen-colour: the mask must be 1-15 and the percentage 1-99 (got {m}:{pct:.0%})")
    src, palette_path = sys.argv[1], sys.argv[2]
    de, plates, share, cm = separate(src, palette_path, Path(src).parent, print_path, screens, colours, width)
    print(f"{Path(palette_path).stem}: mean dE to nearest printable colour {de:.1f}; ink coverage " +
          ", ".join(f"{n} {c:.0%}" for n, c in plates))
    # share of the image per printable colour, by ink mask (0 = bare paper); < 0.1% counts as unused
    print(f"colours used {(share[1:16] >= 0.001).sum()}/15: " + " ".join(f"{m}:{share[m]:.1%}" for m in range(16)))
    for k, (hexc, m, pct, at) in enumerate(colours):
        where = f"in the areas at {' '.join(f'{x},{y}' for x, y in at)}" if at else "everywhere"
        print(f"screened colour #{hexc} (mask {m} at {pct:.0%}, {where}): matches {share[16 + k]:.1%} of the picture")
    if screens or colours:
        print(f"plates carry the screens as greys for the RIP; the proof shows {LPI} lpi dots at {cm:.1f} cm wide (--width to change)")
