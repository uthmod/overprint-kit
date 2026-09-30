---
name: overprint-separation
description: 分色 — separate a flat illustration into four spot-colour plates plus a print proof, using a four-ink palette.json. Use when the user wants plates, a colour separation, or a print proof for an overprint / risograph / 疊印 image.
---

疊印工具包 © TeleportPress。線上疊印色彩矩陣：https://teleportpress-letterpress-user-docu.vercel.app/#overprint-matrix

# 分色: one image → four plates + proof

Each pixel is snapped to the nearest of the palette's 16 printable colours; that colour says which inks are on, so each plate is a plain on/off mask.

Runtime: Python 3.10+ with `opencv-python numpy pillow`. If an import fails, run `python -m pip install opencv-python numpy pillow` and retry.
Input: an image plus a four-ink `palette.json` (from 疊印色盤, the matrix page, or the 疊印工具包 email).

## Steps

1. `python separate.py <image.png> <palette.json> [--penalty 6]` — about 10 s. Writes next to the image:
   `<name>-plate1..4-<ink>.png` (black = ink, in print order), `<name>-proof.png` (the plates recombined in the palette's colours),
   `<name>-sheet.png` (original | proof over the four plates) and `<name>-lines.png` (the shape outlines it traced).
   It prints the mean ΔE to the printable colours, each ink's coverage, and how many of the 15 ink colours appear.
2. **Check before reporting.** Make zoomed original-vs-proof crops (2× on a busy area) and read them; whole sheets hide the problems. Look for:
   - blotchy fills → the art is shaded; regenerate it with a stronger flat-fill clause (疊印插畫) rather than tuning this script;
   - outlines lost where they sat on a fill of the same ink → expected unless the art left a bare-paper keyline; say so;
   - stray specks on a plate, or whole areas flipping to paper → the knobs below.
   Done when every problem you found is either fixed or named in the report.
3. Show the user the sheet and report: what separated cleanly, what was lost, and which knobs you used.

## Options

- `--penalty N` (default 8): the ΔE cost per extra overprinted ink for off-palette pixels. It is about intent.
  Keep 8 for sparse art whose muted colours mean single inks (a muted pink stays pink rather than a 3-ink mauve).
  Use 6 when the art uses the overlap colours on purpose: image AIs draw overlaps darker and more saturated than they print.
  Use 5 to keep shading steps (rose petals, folds) as overlaps; the browser page's default (保留細節). 3 keeps even more,
  but with light-ink palettes (粉彩) it can turn pale fills into dark overprints: check pale areas and greens.
  Use 0 when a whole element was drawn in an overlap colour and came out brighter than the cell.
- `--print other.json`: classify against the palette the art was drawn in, but print with another palette's inks.
- `--screen MASK:PCT` (e.g. `--screen 4:60`): print every pixel labelled with that ink mask as a PCT% halftone (50 lpi round dots,
  per-ink angles, no dot-gain curve: riso dots gain 10–20%, so ask for less than the tone you want). A screen only mixes between
  its two cells; it can never go past the solid overprint. Pick the ink for the strongest overprint you need, then screen the big areas it makes too heavy.
- `python separate.py --check <palette.json> …` — after changing any knob: every exact palette colour must land on its own inks,
  a grainy fill must come out as one colour, a thin dark line must stay darker than its fill, and a soft edge between two
  colours must print only those two (at penalty 3). It does not test real art,
  so also re-separate earlier images and compare zoomed crops.

## How it works (for tuning)

1. 3× Lanczos upscale, so 1–2 px lines keep a solid core.
2. **Shapes:** the original is traced; a line is any pixel whose colour slope is > `EDGE_DE` 3 ΔE/px. Each area the lines close off
   gets one printable colour from its mean colour, and that colour wins every pixel within `TIE_DE` 12 of its own best. This keeps a flat fill from flickering between two colours.
3. **Soft edges:** a line pixel whose colour is a mix of the two nearest shapes (within `BLEND_R` 3 px, `BLEND_RGB` 20)
   prefers the closer shape's colour under the same `TIE_DE` rule, so an anti-aliased edge doesn't print a third, darker ink.
   An outline darker than both sides is no mix of them and keeps its own colour.
4. **Nearest colour** in Lab: a pixel lighter than a candidate pays only `L_WEIGHT` 0.3 of the lightness gap (a pale tint still reads as its ink);
   a darker one pays in full (a dark overlap never collapses to one ink). Off-palette pixels (> 4 ΔE from every colour) pay the ink penalty.
5. 7×7 mode filter removes risograph grain.
6. **Fine lines:** anything narrower than `FINE_PX` 11 px and `FINE_DE` 6 L darker than its surroundings, which the steps above lost,
   is repainted in the nearest palette colour darker than its fill. Expect the palette's next-darker colour, which can be a big step.

Knobs are constants at the top of `separate.py`. Plates come out at 3× the image size (a 1264 px wide image gives 3792 px: ~16 cm at 600 dpi, ~8 cm at the 1200 dpi
our shop asks for sharp curves).
