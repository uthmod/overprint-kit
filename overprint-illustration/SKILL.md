---
name: overprint-illustration
description: 疊印插畫 — write an image-generation prompt from a palette.json so any AI image tool draws a flat illustration printable with just those four spot inks, then hand it to 分色. Use when the user wants an illustration, spot art or example image "printable with" / "只用這四支油墨" an overprint palette.
---

疊印工具包 © TeleportPress。線上疊印色彩矩陣：https://teleportpress-letterpress-user-docu.vercel.app/#overprint-matrix

# 疊印插畫: palette.json → prompt → image → 分色

The prompt does the work: it pins the image AI to the palette's 16 printable colours and to flat fills that separate cleanly.
Any image tool that takes a text prompt works (Adobe Firefly, ChatGPT, Gemini, Midjourney…). Models that follow long, exact
prompts and hex colours do best; GPT Image 2 did best in our trials.

## Steps

1. **Read the palette.** From `palette.json` take the paper hex, each ink's name and hex (`inks`, in print order) and the 11 overlap
   colours: the `cells` entries whose `inks` list has two or more numbers. Name every colour by how it looks (dusty pink, sage green,
   maroon), not by its ink sum; the image AI understands looks.
2. **Ask** what to draw if the user hasn't said. Few elements work best: 2–4 things, not a full scene.
3. **Write the prompt** from the blocks below, in order. Done when every element of the scene has a colour from the palette and the prompt holds all 8 blocks.
4. **Generate.** Default: give the user the prompt to paste into their image tool, ask for a 3:2 landscape image at the highest
   quality, and have them save the PNG where you can read it. With Chrome and the Claude in Chrome extension you can drive Firefly
   yourself instead: see [firefly.md](firefly.md).
5. **Look at the image before separating.** Regenerate (with a stronger block 4 or 8) if fills are shaded or colours outside the palette show up.
6. **Separate** with 分色 (`overprint-separation`): `--penalty 6` when the prompt used the overlap colours on purpose (the colour map variant).

## The prompt blocks

`<paper>` is the paper hex, e.g. `#E1E3E0`.

1. **Style + medium:** `Minimal <anime|manga|picture-book> spot illustration, printed as a four-colour risograph on pale grey paper <paper>.`
2. **Scene:** 2–4 elements, and where they sit ("small, in the lower left third"). End with `Nothing else.`
3. **Space:** `The background is left as bare paper, with no background fill. At least 60% of the image is untouched bare paper <paper>, lots of negative space. The background is one perfectly smooth, even colour <paper>: no paper texture, no speckle, no noise.`
   Ask for the smooth background every time, redraws too: a 4K redraw came back with faint speckle over the paper (±1.5 levels),
   which the separation ignores but which made the lossless sample 7× bigger (6.4 MB vs 0.9 MB once evened out).
4. **Flat fills** (essential for clean plates): `Every shape is one perfectly solid, uniform flat fill of full-strength ink, like a screen print: no shading inside fills, no highlights, no watercolour, no mottling, no texture, no grain, no pale tints. Shadows only as a few hard-edged shapes of a second ink overprinted on top.`
5. **Line art:** `Line art in the <darkest single ink> ink.` An outline drawn in the same ink as the fill under it vanishes on the plate, so add `where an outline sits on a fill of the same ink, leave a thin keyline of bare paper instead`.
6. **Ink map:** `Ink 1 <look> #hex: <elements>. Ink 2 …` for all four inks; assign every element to an ink.
7. **Overlaps:** `Where inks overlap use ONLY: <look> #hex, …` with all 11 overlap colours.
8. **Strict close:** `STRICT: every area is either bare paper <paper> or one of these 15 colours. No black, no white, no gradients, no glow, no colours outside the list. No text.`

### Variants

- **Lineless cut-paper** (the cleanest separations): replace block 5 with `NO outlines, NO line art; forms are flat overlapping colour shapes, overlaps overprint into a darker third colour; details are small solid shapes of another ink` and add `let shapes overlap on purpose: A over B`. Two touching shapes of the same ink merge into one, so give neighbours different inks or a bare-paper gap.
- **Colour map** (a busier scene that shows all 15 colours): replace blocks 6–7 with `Colour map: use EVERY ONE of these 15 colours, each for the listed parts.` then one line per colour, `#hex <look>: <parts>`, plus a `Bare paper <paper>: <parts>` line. Give each overlap colour a flat area of its own (hair, a dress, a hedgehog), not a tiny detail: small cells drift to a neighbouring colour. About 30% bare paper holds up.
- **Redrawing an existing image:** upload it as the reference image and start with `Redraw the reference image …` plus the colour map. For a one-thing fix: `Keep the reference image exactly as it is … Change ONLY the X`.
  Name the colour of every element even when the reference already shows it: without that, a redraw drifts to the usual look
  (Alice came back with yellow hair, a pink dress and a white apron). To get a bigger copy of an image, redraw it at a higher
  resolution this way (see firefly.md for sizes), then separate the new copy and compare it with the old one.

### What goes wrong

- White objects: say `the rabbit is bare paper with <ink> outlines`. "White" or "black-and-white" pulls in colours the palette doesn't have.
- Thin stripes and pale fills come out as patchy tints: ask for solid shapes.
- Tonal detail inside one shape (petals in two pinks) flattens to one ink unless it is a narrow, darker stroke.
- Image AIs draw overlaps darker and more saturated than they print; that is what `--penalty 6` in 分色 absorbs.
- Coral or salmon tends to snap to a nearby peach or orange ink: name the exact ink for anything that must stay in one colour.
