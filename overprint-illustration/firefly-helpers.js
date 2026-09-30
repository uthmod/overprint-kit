// Paste into the Firefly 產生影像 tab (javascript_tool) once per page load.
// Model / aspect / quality pickers are set by hand or by clicking; these helpers only
// type the prompt, press 產生, wait for the new image, and ship it to recv.py.
(() => {
  const all = (sel, root = document, out = []) => {
    root.querySelectorAll(sel).forEach(e => out.push(e));
    root.querySelectorAll('*').forEach(e => e.shadowRoot && all(sel, e.shadowRoot, out));
    return out;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = () => all('img').filter(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth >= 1000);
  // Firefly re-renders its gallery and swaps every blob: URL, so identify images by pixels, not src.
  const fp = img => {
    const c = document.createElement('canvas'); c.width = c.height = 12;
    c.getContext('2d').drawImage(img, 0, 0, 12, 12);
    return Array.from(c.getContext('2d').getImageData(0, 0, 12, 12).data, v => v >> 4).join('');
  };

  window.__ff = {
    all,
    pickers: () => all('sp-picker').map(p => p.value), // expect gpt-image-2, {"height":848,"width":1264}, medium
    async go(text) {
      const ta = all('textarea')[0];
      ta.focus(); // without focus Firefly ignores the value and 產生 does nothing
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      await sleep(500);
      all('sp-button').find(b => b.textContent.trim() === '產生').click();
    },
    // Fire and forget: poll __ff.state until it is not 'running'. A single javascript_tool call
    // times out at ~45 s, so never await this directly.
    run(text) {
      const known = new Set(results().map(fp));
      window.__ff.state = 'running'; window.__ff.last = null;
      (async () => {
        await window.__ff.go(text);
        const t0 = Date.now();
        while (Date.now() - t0 < 150000) {
          await sleep(1500);
          const fresh = results().find(i => !known.has(fp(i)));
          if (fresh) {
            const c = document.createElement('canvas');
            c.width = fresh.naturalWidth; c.height = fresh.naturalHeight;
            c.getContext('2d').drawImage(fresh, 0, 0);
            window.__ff.last = await new Promise(r => c.toBlob(r, 'image/png'));
            window.__ff.state = { ok: true, secs: Math.round((Date.now() - t0) / 1000), size: window.__ff.last.size, w: c.width, h: c.height };
            return;
          }
        }
        window.__ff.state = { ok: false, error: (document.body.innerText.match(/發生錯誤/g) || []).length ? '發生錯誤' : 'timeout' };
      })();
      return 'started';
    },
    // POST the last result to recv.py on 127.0.0.1:8765. First time per profile Chrome asks the
    // user to allow local network access for firefly.adobe.com; the fetch hangs until they do.
    async send(name) {
      const r = await fetch('http://127.0.0.1:8765/?name=' + encodeURIComponent(name), { method: 'POST', body: window.__ff.last });
      return r.text();
    },
  };
  return 'ok ' + JSON.stringify(window.__ff.pickers());
})();
