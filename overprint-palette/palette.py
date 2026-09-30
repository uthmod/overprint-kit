"""疊印色盤: simulate how spot inks overprint on 特A啤酒紙, check a set, search for one, write palette.json.

    python palette.py check "223 U@0.2 / 720 U@0.2 / 4163 U / 2159 U" [--name 對比] [--json palette.json]
    python palette.py search [--with "806 U"] [--inks 4] [--tries 3000] [--min-l 35]
    python palette.py find 806            # ink names containing "806"

A set line lists inks in PRINT ORDER (first printed first), separated by "/". "@0.2" sets an ink's opacity
(0 = clear, the default; metallics default to 0.6). An ink can also be a screen colour written as #RRGGBB.

Model (TeleportPress 疊印模擬器, the same maths as the online matrix page): each ink laid down in print order
updates the running colour b, starting from the paper P:
    b <- a*I + (1-a) * b * (I/P)^k
k (trapping) is 1 for the first ink on bare paper and 0.6 for ink on ink; a is the ink's opacity.
Mean dE00 is about 4-5 against photos of printed cards: good enough to rank sets, not to proof them.
"""
import argparse
import difflib
import json
import math
import random
import sys
from pathlib import Path

HERE = Path(__file__).parent
STOCK = (90.0, -1.0, 1.0)  # 特A啤酒紙 335gsm, photo estimate; Pantone book values count as printed on it
PAPER_NAME = "特A啤酒紙"
TRAPPING = 0.6
MODEL_ERROR_DE = 5.0  # two cells closer than this may print the same
CUSTOM = {"赤金": (59.4, 6.3, 14.0, "metallic")}  # a supplier mix with no Pantone code


# ---------- colour (sRGB D65, same constants as the site) ----------
def _enc(v):
    return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


def _dec(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _clamp(v):
    return min(1.0, max(0.0, v))


_cbrt = getattr(math, "cbrt", lambda t: t ** (1 / 3))


def lab_to_rgb(lab):
    L, a, b = lab
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200
    f = lambda t: t ** 3 if t ** 3 > 0.008856 else (t - 16 / 116) / 7.787
    X, Y, Z = f(fx) * 0.95047, f(fy), f(fz) * 1.08883
    return [_enc(_clamp(v)) for v in (
        3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
        -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
        0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
    )]


def rgb_to_lab(c):
    r, g, b = (_dec(v) for v in c)
    f = lambda t: _cbrt(t) if t > 0.008856 else 7.787 * t + 16 / 116
    X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
    return (116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z)))


def delta_e00(lab1, lab2):
    L1, a1, b1 = lab1
    L2, a2, b2 = lab2
    r = math.pi / 180
    Cb = (math.hypot(a1, b1) + math.hypot(a2, b2)) / 2
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1, h2 = (math.atan2(b1, a1p) / r + 360) % 360, (math.atan2(b2, a2p) / r + 360) % 360
    dh = h2 - h1
    if C1p * C2p == 0:
        dh = 0
    elif dh > 180:
        dh -= 360
    elif dh < -180:
        dh += 360
    dL, dC, dH = L2 - L1, C2p - C1p, 2 * math.sqrt(C1p * C2p) * math.sin(dh * r / 2)
    Lb, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hb = h1 + h2
    if C1p * C2p != 0:
        hb = (h1 + h2) / 2 if abs(h1 - h2) <= 180 else (h1 + h2 + 360) / 2 if h1 + h2 < 360 else (h1 + h2 - 360) / 2
    T = 1 - 0.17 * math.cos((hb - 30) * r) + 0.24 * math.cos(2 * hb * r) + 0.32 * math.cos((3 * hb + 6) * r) - 0.2 * math.cos((4 * hb - 63) * r)
    SL = 1 + 0.015 * (Lb - 50) ** 2 / math.sqrt(20 + (Lb - 50) ** 2)
    SC, SH = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    RT = -2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * math.sin(60 * math.exp(-(((hb - 275) / 25) ** 2)) * r)
    return math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))


def to_hex(rgb):
    # int(x + 0.5), not round(): matches JavaScript's Math.round on the site
    return "".join(f"{int(v * 255 + 0.5):02X}" for v in rgb)


def hex_to_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


# ---------- the Pantone U table ----------
def load_book():
    """name -> (L, a, b, flag). flag is 'metallic', 'fluorescent' or ''."""
    book = {}
    lines = (HERE / "pantone-u.csv").read_text(encoding="utf-8").strip().splitlines()
    for row in lines[1:]:
        name, L, a, b, _src, *flag = row.split(",")
        book[name] = (float(L), float(a), float(b), flag[0] if flag else "")
    book.update(CUSTOM)
    return book


def resolve(name, book):
    """The book's spelling of an ink name ("223u" -> "223 U"), or exit with suggestions."""
    if name.startswith("#"):
        return name.upper()
    if name in book:
        return name
    squash = lambda s: s.replace(" ", "").lower()
    for k in book:
        if squash(k) == squash(name):
            return k
    near = difflib.get_close_matches(name, book, n=5)
    sys.exit(f"找不到色號「{name}」" + (f"，是不是：{'、'.join(near)}？" if near else "。用 find 查查看。"))


def parse_line(line, book):
    """'A / B@0.2 / C' -> [(name, opacity)] in print order."""
    inks = []
    for part in filter(None, (p.strip() for p in line.split("/"))):
        name, _, alpha = part.partition("@")
        name = resolve(name.strip(), book)
        flag = "" if name.startswith("#") else book[name][3]
        inks.append((name, _clamp(float(alpha)) if alpha.strip() else 0.6 if flag == "metallic" else 0.0))
    return inks


# ---------- model ----------
def simulate(inks, book):
    """16 (or 2^n) cells indexed by ink mask (bit k = the k-th ink printed); each cell is an sRGB triple 0..1."""
    # ponytail: the paper is fixed to 特A啤酒紙, so the site's paper re-tint term is always x1 and is left out.
    P = lab_to_rgb(STOCK)
    I = [hex_to_rgb(n) if n.startswith("#") else lab_to_rgb(book[n][:3]) for n, _ in inks]
    cells = []
    for m in range(1 << len(inks)):
        b = list(P)
        first = True
        for x in range(len(inks)):
            if not m >> x & 1:
                continue
            k, a = (1 if first else TRAPPING), inks[x][1]
            first = False
            b = [a * I[x][j] + (1 - a) * b[j] * (I[x][j] / max(P[j], 1e-4)) ** k for j in range(3)]
        cells.append([_clamp(v) for v in b])
    return cells


def palette_json(name, inks, book):
    cells = simulate(inks, book)
    hexes = [to_hex(c) for c in cells]
    return {
        "name": name,
        "paper": {"name": PAPER_NAME, "hex": hexes[0]},
        "inks": [{"name": n, "hex": hexes[1 << k], "opacity": a} for k, (n, a) in enumerate(inks)],
        "cells": [{"inks": [k + 1 for k in range(len(inks)) if m >> k & 1], "hex": h} for m, h in enumerate(hexes)],
    }


# ---------- swatch libraries (.ase Adobe, .swatches Procreate, .gpl GIMP/Krita/Inkscape) ----------
def swatch_names(p):
    """(name, hex) per cell, paper first: '223 U', '223 U + 720 U', …"""
    names = [i["name"] for i in p["inks"]]
    return [(" + ".join(names[k - 1] for k in c["inks"]) or f"{p['paper']['name']}（紙色）", c["hex"]) for c in p["cells"]]


def ase_bytes(p):
    """Adobe Swatch Exchange: one group; solo inks are spot swatches (Illustrator can print them as plates), the rest global."""
    import struct

    def block(kind, body):
        return struct.pack(">HI", kind, len(body)) + body

    def utf16(s):
        return struct.pack(">H", len(s) + 1) + (s + "\0").encode("utf-16-be")

    blocks = [block(0xC001, utf16(p["name"]))]
    for (name, h), c in zip(swatch_names(p), p["cells"]):
        kind = 1 if len(c["inks"]) == 1 else 0  # 1 spot, 0 global
        blocks.append(block(0x0001, utf16(name) + b"RGB " + struct.pack(">3fH", *hex_to_rgb(h), kind)))
    blocks.append(block(0xC002, b""))
    return b"ASEF" + struct.pack(">HHI", 1, 0, len(blocks)) + b"".join(blocks)


def procreate_bytes(p):
    """Procreate .swatches: a zip holding Swatches.json, colours as HSB 0..1 (Procreate shows no swatch names)."""
    import colorsys
    import io
    import zipfile
    sw = [dict(zip(("hue", "saturation", "brightness"), colorsys.rgb_to_hsv(*hex_to_rgb(h))), alpha=1, colorSpace=0)
          for _, h in swatch_names(p)]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Swatches.json", json.dumps([{"name": p["name"], "swatches": sw}], ensure_ascii=False))
    return buf.getvalue()


def gpl_text(p):
    rows = [f"{int(h[0:2], 16):3d} {int(h[2:4], 16):3d} {int(h[4:6], 16):3d}\t{name} #{h}" for name, h in swatch_names(p)]
    return "GIMP Palette\nName: {}\nColumns: 4\n#\n{}\n".format(p["name"], "\n".join(rows))


def write_swatches(p, json_path):
    """Write <stem>.ase, <stem>.swatches and <stem>.gpl next to palette.json; returns their paths."""
    base = Path(json_path).with_suffix("")
    out = [base.with_suffix(".ase"), base.with_suffix(".swatches"), base.with_suffix(".gpl")]
    out[0].write_bytes(ase_bytes(p))
    out[1].write_bytes(procreate_bytes(p))
    out[2].write_text(gpl_text(p), encoding="utf-8")
    return out


def closest_pair(cells):
    labs = [rgb_to_lab(c) for c in cells]
    return min((delta_e00(labs[i], labs[j]), i, j) for i in range(len(labs)) for j in range(i + 1, len(labs)))


def report(inks, book):
    cells = simulate(inks, book)
    de, i, j = closest_pair(cells)
    all_l = rgb_to_lab(cells[-1])[0]
    label = lambda m: "+".join(inks[k][0] for k in range(len(inks)) if m >> k & 1) or "紙"
    lines = [" / ".join(n if a == 0 else f"{n}@{a:g}" for n, a in inks)]
    lines += [f"  {m:>2} {to_hex(c)}  {label(m)}" for m, c in enumerate(cells)]
    lines.append(f"  最接近的兩格：{label(i)} 和 {label(j)}，色差 {de:.1f}" +
                 ("（小於 5，印出來可能分不出來）" if de < MODEL_ERROR_DE else "（每一格都分得出來）"))
    lines.append(f"  全部疊在一起的那一格亮度 {all_l:.0f}" + ("（低於 35，會顯得灰髒）" if all_l < 35 else ""))
    for n, a in inks:
        flag = "" if n.startswith("#") else book[n][3]
        if flag == "metallic":
            lines.append(f"  {n} 是金屬墨：螢幕上看不出金屬光澤；遮蓋力是估計的")
        elif flag == "fluorescent":
            lines.append(f"  {n} 是螢光墨：螢幕上看不出螢光效果，照光久了會褪色")
        elif n.startswith("#"):
            lines.append(f"  {n} 不是 Pantone 色號，是照螢幕顏色估的")
    return "\n".join(lines), de, all_l


def search(book, must, n, tries, min_l, rng):
    """Random sets of n plain inks that include `must`; the 5 with the widest closest pair. Print order = lightest first."""
    # ponytail: plain random sampling; ~3,000 tries over the ~2,000-ink book takes a few seconds. Add a smarter search if it misses.
    pool = [k for k, v in book.items() if not v[3] and v[0] >= min_l and k not in must]
    seen, best = set(), []
    for _ in range(tries):
        names = tuple(sorted(set(must) | set(rng.sample(pool, n - len(must))), key=lambda k: -book[k][0]))
        if names in seen:
            continue
        seen.add(names)
        inks = [(k, 0.6 if book[k][3] == "metallic" else 0.0) for k in names]
        cells = simulate(inks, book)
        if rgb_to_lab(cells[-1])[0] < 35:
            continue
        best.append((closest_pair(cells)[0], names))
    return sorted(best, reverse=True)[:5]


def main():
    ap = argparse.ArgumentParser(description="疊印色盤")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="simulate one set and optionally write palette.json")
    c.add_argument("line")
    c.add_argument("--name", default="")
    c.add_argument("--json", default="")
    s = sub.add_parser("search", help="find sets whose 16 colours all stay apart")
    s.add_argument("--with", dest="must", action="append", default=[], help="an ink the set must include (repeatable)")
    s.add_argument("--inks", type=int, default=4)
    s.add_argument("--tries", type=int, default=3000)
    s.add_argument("--min-l", type=float, default=55, help="lightest allowed ink lightness L* (lower allows darker inks)")
    s.add_argument("--seed", type=int)
    f = sub.add_parser("find", help="list ink names containing a text")
    f.add_argument("text")
    w = sub.add_parser("swatches", help="turn a palette.json into .ase / .swatches / .gpl swatch files")
    w.add_argument("palette")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to a legacy code page
    book = load_book()

    if args.cmd == "find":
        hits = [f"{k}  L{v[0]:.0f} {v[3]}".rstrip() for k, v in book.items() if args.text.lower() in k.lower()]
        print("\n".join(hits) or "沒有符合的色號")
    elif args.cmd == "check":
        inks = parse_line(args.line, book)
        text, _, _ = report(inks, book)
        print(text)
        if args.json:
            p = palette_json(args.name or " / ".join(n for n, _ in inks), inks, book)
            Path(args.json).write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"  寫好了：{args.json}")
            for f in write_swatches(p, args.json):
                print(f"  色票檔：{f}")
    elif args.cmd == "swatches":
        for f in write_swatches(json.loads(Path(args.palette).read_text(encoding="utf-8")), args.palette):
            print(f"色票檔：{f}")
    else:
        must = [resolve(m, book) for m in args.must]
        for de, names in search(book, must, args.inks, args.tries, args.min_l, random.Random(args.seed)):
            print(f"{de:5.1f}  {' / '.join(names)}")


if __name__ == "__main__":
    main()
