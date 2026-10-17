// Mixtape offline cache. Bump VERSION whenever app files change so installed copies pick up the new version.
const VERSION = 'mixtape-v48';
const CORE = ['./', './index.html', './app.js', './studio.html', './studio.js', './dsp-worker.js', './dsp-shared.js', './midi.js', './long-mp3.js', './media-cut.js', './vendor/mediabunny/mediabunny.min.mjs', './lofi-worklet.js', './vendor/tone/Tone.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
// The AI stem splitter is large and changes rarely, so it lives in its own caches that app updates don't clear.
const STEMS_RUNTIME = 'mixtape-stems-runtime-v1';   // ONNX Runtime + splitter code, saved on first use
const KEEP = k => k === VERSION || k.startsWith('mixtape-stems-') || k.startsWith('mixtape-orch-');
const ORCH_CACHE = 'mixtape-orch-v1'; // the orchestra's recordings, saved on first use

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's own HTTP cache: GitHub Pages lets it keep files for 10 minutes, so a new version
  // installed soon after publishing could otherwise store the previous version's files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !KEEP(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Fonts: use the saved copy, refresh it in the background when online.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  // Orchestra recordings: saved the first time each one is used, so the orchestra also works offline.
  if (path.includes('/orch/') || path.includes('/piano/') || path.includes('/gm/') || path.includes('/drums/')) {
    e.respondWith(caches.open(ORCH_CACHE).then(async c => { const hit = await c.match(req); if (hit) return hit; const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }));
    return;
  }
  // The AI model is downloaded, checked and saved by the stem worker itself.
  if (path.includes('/stems/model/')) return;
  // Splitter runtime: save on first use so splitting also works offline later.
  if (path.includes('/stems/')) {
    e.respondWith(caches.open(STEMS_RUNTIME).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r;
    }));
    return;
  }
  // Pages: try the network for updates, fall back to the saved copy of that same page offline.
  if (req.mode === 'navigate') {
    const key = path.endsWith('studio.html') ? './studio.html' : './index.html';
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(key, copy)); } return r; })
      .catch(() => caches.match(key)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
