# Optional route: drive Adobe Firefly from Claude Code

Needs Chrome, the Claude in Chrome extension, and an Adobe Firefly account that can use GPT Image 2 (about 20 credits per image).
Files: `firefly-helpers.js` (pasted into the Firefly tab), `recv.py` (a tiny local receiver the tab sends the PNG to).

## Generate

1. Find or open a tab on `https://firefly.adobe.com/generate/image`. If the page is blank, go via the Firefly home page and wait ~10 s.
2. Paste `firefly-helpers.js` with the javascript tool. It returns the three picker values; they should be
   `openai:firefly:colligo:gpt-image-2`, `{"height":848,"width":1264}` (3:2 landscape) and `medium`. If not, set them by clicking
   (take a full-resolution screenshot first; dropdown rows are easy to miss by one, and a click during the menu's ~1 s fade-in lands nowhere).
   **Bigger pictures:** GPT Image 2 makes about 1 megapixel at every aspect (3:2 = 1264×848); its 品質 only adds detail.
   Gemini 3.1 (Nano Banana 2) has a resolution picker: at 2K, 3:2 is 2528×1696 for the same 20 credits.
   GPT Image 2.5 Flare goes to 1536×1024 (5 credits). The browser 分色 page shrinks anything over 1.8M pixels.
   If Chrome is minimized, Firefly lays out for a tiny window and hides its generate button: ask the user to restore the window.
3. `__ff.run(prompt)`, then poll `__ff.state` in short calls (wait loops of 20 s or less: a javascript call dies at about 45 s, and timers in a hidden tab run slow).
   An image takes 20–35 s. If nothing arrives after ~60 s, the generate click didn't take: check the prompt box holds the prompt and run again.
   Run images one at a time; a second click while one is running is ignored.
4. Screenshots time out while the tab is hidden; the helpers work regardless. To look at results, inject a fixed full-screen `<div>` grid of the images, screenshot it, then remove it.

**Reference image** (redrawing the user's image): the file input sits in shadow DOM (`FIREFLY-UPLOAD-NEW` > `input#file-input`).
Append a visible proxy `<input type=file>` to `document.body` whose `change` copies its file into that input (via a DataTransfer) and
dispatches bubbling, composed `input` and `change` events; find the proxy, then upload the file to it. Remove any old reference chip (×) first.

## Save the PNG

1. `python recv.py <out_dir>` in the background.
2. In the tab: `await __ff.send('<name>.png')` returns the byte count.
   The first time, Chrome asks in the Firefly tab to allow local network access, and the send waits until the user clicks Allow: tell them.
   If the send fails or answers 501, another program holds port 8765: run a copy of `recv.py` with another port and `fetch` to that port.
3. Stop the receiver as soon as the file is saved.

`__ff.last` holds the image captured when it was generated. Old `blob:` URLs stop working when Firefly redraws its gallery.
Check `__ff.state.w`: the gallery can show a smaller preview first (a 2K image came back once at 2048 px wide).
