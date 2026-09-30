# Optional route: drive Adobe Firefly from Claude Code

Needs Chrome, the Claude in Chrome extension, and an Adobe Firefly account that can use GPT Image 2 (about 20 credits per image).
Files: `firefly-helpers.js` (pasted into the Firefly tab), `recv.py` (a tiny local receiver the tab sends the PNG to).

## Generate

1. Find or open a tab on `https://firefly.adobe.com/generate/image`. If the page is blank, go via the Firefly home page and wait ~10 s.
2. Paste `firefly-helpers.js` with the javascript tool. It returns the three picker values; they should be
   `openai:firefly:colligo:gpt-image-2`, `{"height":848,"width":1264}` (3:2 landscape) and `medium`. If not, set them by clicking
   (take a full-resolution screenshot first; dropdown rows are easy to miss by one).
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
3. Stop the receiver as soon as the file is saved.

`__ff.last` holds the image captured when it was generated. Old `blob:` URLs stop working when Firefly redraws its gallery.
