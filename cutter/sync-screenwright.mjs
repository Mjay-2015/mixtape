// Copies Mixtape's Cutter into screenwright (public/cutter/, served at /studio/cutter) until Mixtape itself moves into
// screenwright. This folder is the Cutter's only source. Run from here: node sync-screenwright.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), app = join(here, '..'), to = join(here, '../../../../screenwright/public/cutter');
if (!existsSync(dirname(to))) throw new Error('screenwright/public was not found next to MINDCRAFTS_MINION');
const put = (f, text) => { mkdirSync(dirname(join(to, f)), { recursive: true }); writeFileSync(join(to, f), text); };
const read = f => readFileSync(join(here, f), 'utf8');
const swap = (s, a, b) => { if (!s.includes(a)) throw new Error(`sync: expected to find ${a}`); return s.replace(a, b); };
for (const f of ['app.js', 'model.js', 'h264.js', 'style.css']) put(f, read(f));
put('engine.js', swap(read('engine.js'), "'../vendor/mediabunny/mediabunny.min.mjs'", "'./vendor/mediabunny/mediabunny.min.mjs'"));
let html = read('index.html');
html = swap(html, '<script src="host-mixtape.js"></script>\n', ''); // screenwright has no Mixtape library (yet)
html = swap(html, '<link rel="manifest" href="../manifest.webmanifest">\n', '');
html = swap(html, '<link rel="icon" href="../icon-192.png">', '<link rel="icon" href="icon-192.png">'); // screenwright's copy keeps its own icon
html = html.replace('<title>Cutter · Mixtape</title>', '<title>Cutter</title>');
put('index.html', html);
for (const f of ['mediabunny.min.mjs', 'LICENSE']) { mkdirSync(join(to, 'vendor/mediabunny'), { recursive: true }); copyFileSync(join(app, 'vendor/mediabunny', f), join(to, 'vendor/mediabunny', f)); }
console.log('screenwright/public/cutter/ updated from Mixtape');
