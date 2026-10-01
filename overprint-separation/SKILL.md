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
   - a new or bigger copy of an art you separated before can land differently: a fill a few RGB off can cross the switch to
     a 3-ink overprint (a pale mint going sage at penalty 5), and `FINE_PX` counts the image's own pixels, so two-tone petals
     that printed one shade darker at 1264 px wide were plain pink at 1636 px. Compare it with the old proof, crop by crop.
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
- `--screen-colour RRGGBB=MASK:PCT` (e.g. `--screen-colour F8C4A2=2:50`): the art's own colour RRGGBB becomes one more printable
  colour, printed as MASK's inks in PCT% dots. Use it when a paler area shares an ink with a darker one and merges into it: Alice's
  face and her hair both separate to solid 720 U, so her skin goes to 720 U at 50%. Read RRGGBB from the art (median of a flat patch,
  not an edge), take MASK from what that area separates to now, repeat the flag for more colours (up to 8). A pixel that looks
  most like a screened colour keeps it even inside a traced shape of the solid colour (soft face/hair boundaries leave both
  in one shape). A pixel more than 4 ΔE darker than a screened colour never takes it (a screen only prints paler), so
  screening a pale part makes a darker part of the same ink show: a teacup whose body and darker inside both separate to
  solid 283 U gets `7FBCEE=4:70@480,470` on the body, and the inside stays solid. On grey stock a screen reads greyer, not
  just paler. Fine dark lines are never screened.
  Add `@x,y` (original px, repeatable) to screen only the areas clicked there: `F8C4A2=2:50@252,507@317,539` screens Alice's
  face and arm but not the same-coloured hearts, which print solid. An area is the colour's connected patch at
  that point, plus any of its patches inside that point's traced shape (see `-lines.png`). Without `@` every area of the colour
  is screened; usually you want `@`, so pick a point inside each area and check the proof. A clearly paler area that took the
  same screened colour (the clock face, paler than the face) gets its own flag, so its dots can be sparser: `FCE4CD=2:30@1175,265`.
- `--screen MASK:PCT` (e.g. `--screen 4:60`): print every pixel of that printable colour as PCT% dots instead (the whole colour, everywhere).
  A screen only mixes between its two cells; it can never go past the solid overprint.
- Dots are round, 80 lpi at the printed size, at per-ink angles (15/75/45/0°), with no dot-gain curve (riso and letterpress dots
  gain 10–20%, so ask for less than the tone you want). `--width CM` is the printed width of the whole picture; without it the
  plates are taken to print at 600 dpi (the size the output line reports). Plates and proof are saved tagged with that dpi, so they
  open at the right size in Illustrator. Printed at another size, the dots scale with it: tell the user the width.
- `python separate.py --check <palette.json> …` — after changing any knob: every exact palette colour must land on its own inks,
  a grainy fill must come out as one colour, a thin dark line must stay darker than its fill, a soft edge between two
  colours must print only those two (at penalty 3), screens must cover their percentage, a screened colour must be told
  apart from its solid ink beside it, and a darker colour beside a screened one must stay solid. It does not test real art,
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
   Screened colours are candidates too, except for pixels more than `EXACT_DE` darker than them; a shape's colour never
   overrides a pixel whose best is a screened colour.
5. 7×7 mode filter removes risograph grain.
6. **Fine lines:** anything narrower than `FINE_PX` 11 px and `FINE_DE` 6 L darker than its surroundings, which the steps above lost,
   is repainted in the nearest palette colour darker than its fill. Expect the palette's next-darker colour, which can be a big step.
   A piece no longer than `FINE_PX` and the colour of a traced shape it touches is that shape's tip (a teacup's dark inside
   narrowing at the rim), not a line: it keeps its own colour instead of printing as a darker speck.
7. **Dots:** screened colours print as halftone dots (the plate step; see Options).

Knobs are constants at the top of `separate.py`. Plates come out at 3× the image size (a 1264 px wide image gives 3792 px: ~16 cm at 600 dpi, ~8 cm at the 1200 dpi
our shop asks for sharp curves).
