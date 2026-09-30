---
name: overprint-palette
description: 疊印色盤 — simulate how 2–5 Pantone U spot inks overprint, check or search for a set whose overlap colours all stay distinguishable, and write its palette.json. Use when the user wants an overprint / 疊印 ink set, asks what two inks make when overprinted, or needs a palette.json for 疊印插畫 or 分色.
---

疊印工具包 © TeleportPress。線上疊印色彩矩陣：https://teleportpress-letterpress-user-docu.vercel.app/#overprint-matrix

# 疊印色盤: pick spot inks whose overprints all read apart

Four inks printed on top of each other make 16 printable colours: bare paper, 4 solo inks and 11 overlaps.
This tool predicts those colours on 特A啤酒紙 and writes them to a `palette.json` that 疊印插畫 and 分色 read.

Runtime: Python 3.10+, standard library only. Files: `palette.py`, `pantone-u.csv` (the Pantone Solid Uncoated table).

## Commands

Run from this skill's folder.

- `python palette.py find 806` — ink names containing a text. Names use the table's spelling with a space: `806 U`, `Cool Gray 8 U`.
- `python palette.py check "A U / B U@0.2 / C U / D U" --name 我的色盤 --json <out>/palette.json` — the 16 colours,
  the closest pair and the darkest cell, then the palette file and its swatch files (below).
- `python palette.py swatches <palette.json>` — swatch files for a palette.json from anywhere (the matrix page, the 疊印工具包 email).
- `python palette.py search --with "806 U" [--inks 4] [--min-l 55] [--tries 3000]` — the 5 random sets with the widest
  closest pair. Lower `--min-l` to let darker inks in.

### The set line

- Inks are listed in **print order**, first printed first. Print light inks first: a dark ink laid early darkens every overlap after it.
- `@0.2` is an ink's opacity: 0 is a clear ink (the default), metallics default to 0.6, pale tint mixes (heavy in transparent white) are about 0.2.
- `#RRGGBB` in place of a name is a screen colour with no Pantone code; the model treats it as a clear ink.

## Steps

1. Get the inks the user wants to keep (`find` settles the spelling). No inks named: ask for a mood (contrasty, harmonious, neon, pastel) or a colour to build around.
2. `search` with those inks, or `check` a set the user proposes. Done when a set's closest pair is **≥ 5 ΔE00** (the model's own error;
   closer pairs may print the same) and the all-inks cell's lightness is **≥ 35** (darker reads grey and muddy).
3. Show the user the 16 colours of the one or two best sets: a quick HTML swatch grid, or the matrix page above.
4. `check … --json` the chosen set and give the user the file paths.

## Swatch files (for drawing by hand)

Written next to palette.json, same name, 16 swatches each (paper, the solo inks, every overlap, named like `223 U + 720 U`):
- `.ase` — Illustrator, Photoshop, InDesign (Swatches panel → Open Swatch Library → Other Library), Affinity (import palette).
  The solo inks are **spot** swatches, so Illustrator can output one plate per ink; overlaps and paper are global swatches.
- `.swatches` — Procreate: AirDrop or open the file on the iPad. Procreate shows colours only, no names.
- `.gpl` — GIMP, Krita, Inkscape.
Drawing with them: paint every area in one of the 16 swatches as a flat fill; paint an overlap with its overlap swatch rather than
stacking transparent layers; leave white as bare paper. Then 分色 splits the PNG with the same palette.json.

## What the numbers mean

- The model: each ink laid down updates the colour under it, `b ← α·I + (1−α)·b·(I/P)^k`, trapping k = 1 on bare paper and 0.6 on ink.
  It is about 4–5 ΔE00 off photos of printed cards: good for ranking sets, not a proof. The printed proof decides (以印刷打樣為準).
- Full-strength dark inks crowd together near black at 3–4 ΔE00. Lighter or greyed inks spread out and leave room for more distinct overlaps.
- Metallic and fluorescent inks: the screen shows neither the shine nor the glow, and fluorescents fade in daylight.

## palette.json

```json
{
  "name": "對比",
  "paper": { "name": "特A啤酒紙", "hex": "E1E3E0" },
  "inks": [{ "name": "223 U", "hex": "FAA6D7", "opacity": 0.2 }, "…in print order"],
  "cells": [{ "inks": [], "hex": "E1E3E0" }, { "inks": [1], "hex": "FAA6D7" }, "…2^n cells"]
}
```

`cells` has 2^n entries and **index = ink mask** (bit 0 = the first ink printed); each cell's `inks` lists 1-based ink numbers.
Hexes are 6 uppercase characters with no `#`. The matrix page's export and the palette link in the 疊印工具包 email use the same shape.
