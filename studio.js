(() => {
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtT = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const hueOf = str => { let h = 0; for (const c of String(str || '')) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };
const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const keyName = (k, mode) => `${KEYS[((k % 12) + 12) % 12]} ${mode}`;

/* The Studio is laptop-only */
if (matchMedia('(pointer: coarse)').matches || innerWidth < 900) { $('#phoneNote').hidden = false; $('#app').hidden = true; return; }

/* ---------- library storage (shared with the player) ---------- */
let db = null, lib = [];
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('mixtape-player', 1);
    r.onupgradeneeded = () => { const d = r.result;
      if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('lists')) d.createObjectStore('lists', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function req(store, mode, fn) {
  return new Promise((res, rej) => { let out;
    try { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); } catch (e) { rej(e); } });
}
async function loadLibrary() {
  const all = db ? await req('tracks', 'readonly', o => o.getAll()).catch(() => []) : [];
  lib = all.map(t => { if (!t.blob && t.buf) { t.blob = new Blob([t.buf], { type: t.type || '' }); delete t.buf; } return t; })
    .filter(t => t.blob).sort((a, b) => b.added - a.added);
}
const libTrack = id => lib.find(t => t.id === id);
async function saveToLibrary(t) {
  await req('tracks', 'readwrite', o => o.put(t));
  try { new BroadcastChannel('mixtape').postMessage({ type: 'library' }); } catch (e) {}
  await loadLibrary(); renderLibrary();
}

/* ---------- background worker (tempo, key, time-stretch) ---------- */
const worker = new Worker('dsp-worker.js');
let wid = 0; const pending = new Map();
worker.onmessage = e => { const { id, ok, result, error } = e.data; const p = pending.get(id); if (!p) return; pending.delete(id); ok ? p.res(result) : p.rej(new Error(error)); };
worker.onerror = e => { for (const p of pending.values()) p.rej(new Error(e.message || 'Worker failed')); pending.clear(); };
const dsp = (type, payload, transfer = []) => new Promise((res, rej) => { const id = ++wid; pending.set(id, { res, rej }); worker.postMessage({ id, type, ...payload }, transfer); });

/* ---------- audio ---------- */
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const bufs = new Map(), loading = new Map();
function computePeaks(buffer) {
  const rate = 200, n = Math.ceil(buffer.duration * rate), min = new Float32Array(n), max = new Float32Array(n);
  const chs = []; for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  const step = buffer.sampleRate / rate, len = buffer.length;
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0; const a = Math.floor(i * step), b = Math.min(len, Math.floor((i + 1) * step));
    for (const d of chs) for (let j = a; j < b; j++) { const v = d[j]; if (v < lo) lo = v; else if (v > hi) hi = v; }
    min[i] = lo; max[i] = hi;
  }
  return { min, max, rate };
}
function ensureBuf(trackId) {
  if (bufs.has(trackId)) return Promise.resolve(bufs.get(trackId));
  if (loading.has(trackId)) return loading.get(trackId);
  const t = libTrack(trackId);
  if (!t) return Promise.reject(new Error('This song is no longer in your library.'));
  const p = (async () => {
    busy(`Loading “${t.title}”…`);
    try {
      const buffer = await ctx.decodeAudioData(await t.blob.arrayBuffer());
      const e = { buffer, peaks: computePeaks(buffer) }; bufs.set(trackId, e);
      analyzeTrack(trackId);
      return e;
    } catch (err) { throw new Error(`Couldn't open “${t.title}”. The file may be damaged or in a format this browser can't edit.`); }
    finally { busy(null); loading.delete(trackId); }
  })();
  loading.set(trackId, p); return p;
}

/* tempo + key analysis, cached per song */
const ANA_KEY = 'mixtape-analysis-v1';
let ana = {}; try { ana = JSON.parse(localStorage.getItem(ANA_KEY)) || {}; } catch (e) {}
const analyzing = new Set();
async function analyzeTrack(id) {
  if (ana[id] || analyzing.has(id) || !bufs.has(id)) return;
  analyzing.add(id); renderLibrary();
  try {
    const b = bufs.get(id).buffer, n = b.length, mono = new Float32Array(n), chs = b.numberOfChannels;
    for (let c = 0; c < chs; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
    ana[id] = await dsp('analyze', { mono, sr: b.sampleRate }, [mono.buffer]);
    try { localStorage.setItem(ANA_KEY, JSON.stringify(ana)); } catch (e) {}
    let changed = false;
    if (!P.bpm && ana[id].bpm) { P.bpm = ana[id].bpm; changed = true; }
    if (!P.key && ana[id].key != null) { P.key = { key: ana[id].key, mode: ana[id].mode }; changed = true; }
    if (changed) { last = JSON.stringify(P); persist(); }
  } catch (e) { console.warn('analysis failed', e); }
  finally { analyzing.delete(id); renderLibrary(); renderLanes(); renderInspector(); renderTransport(); drawEditor(); }
}

/* speed + key: playback rate r, pitch factor p, stretch factor k */
function clipParams(c) {
  const r = c.rate || 1, semi = c.semi || 0;
  if (c.keepPitch === false) return { r, p: r, k: 1 };
  const p = Math.pow(2, semi / 12);
  return { r, p, k: Math.abs(p / r - 1) < 1e-4 ? 1 : p / r };
}
const procReady = new Map(), procLoading = new Map();
const procKey = (id, k) => `${id}|${k.toFixed(4)}`;
function ensureProc(c) {
  const { k } = clipParams(c); if (k === 1) return Promise.resolve(null);
  const key = procKey(c.trackId, k);
  if (procReady.has(key)) return Promise.resolve(procReady.get(key));
  if (procLoading.has(key)) return procLoading.get(key);
  const p = (async () => {
    const e = await ensureBuf(c.trackId), b = e.buffer;
    busy('Changing speed and key… this takes a few seconds');
    try {
      const chs = []; for (let i = 0; i < b.numberOfChannels; i++) chs.push(b.getChannelData(i).slice());
      const res = await dsp('stretch', { chs, sr: b.sampleRate, factor: k }, chs.map(x => x.buffer));
      const out = ctx.createBuffer(res.chs.length, res.chs[0].length, b.sampleRate);
      res.chs.forEach((d, i) => out.copyToChannel(d, i));
      procReady.set(key, out); return out;
    } finally { busy(null); procLoading.delete(key); }
  })();
  procLoading.set(key, p); return p;
}

/* ---------- project ---------- */
const LSP = 'mixtape-studio-project-v1';
const FX0 = () => ({ bass: 0, treble: 0, filter: 0, echo: 0, reverb: 0 });
const newLane = n => ({ id: uid(), name: typeof n === 'string' ? n : `Layer ${n}`, gain: 1, pan: 0, mute: false, solo: false, fx: FX0() });
const newProject = () => ({ name: 'My mix', lanes: [newLane(1)], clips: [], xfade: 0.5, bpm: null, key: null, snap: false, polish: false });
function normalize(p) {
  if (!p || !p.lanes || !p.lanes.length) return newProject();
  p.lanes.forEach(l => { l.fx = { ...FX0(), ...(l.fx || {}) }; });
  p.clips.forEach(c => { if (c.rate == null) c.rate = 1; if (c.semi == null) c.semi = 0; if (c.keepPitch == null) c.keepPitch = true; c.fxIn = c.fxIn || 'fade'; c.fxOut = c.fxOut || 'fade'; });
  p.xfade = p.xfade ?? 0.5; p.snap = !!p.snap; p.polish = !!p.polish; p.bpm = p.bpm || null; p.key = p.key || null;
  return p;
}
let P; try { P = normalize(JSON.parse(localStorage.getItem(LSP))); } catch (e) { P = newProject(); }
let selClip = null, selLane = P.lanes[0].id, playhead = 0, pps = 24, edSel = null;
let hist = [], fut = [], last = JSON.stringify(P);
const persist = () => { try { localStorage.setItem(LSP, last); } catch (e) {} };
const clipById = id => P.clips.find(c => c.id === id);
const dur = c => (c.end - c.start) / (c.rate || 1);
const tlOf = (c, src) => c.at + (src - c.start) / (c.rate || 1);
const projectEnd = () => P.clips.reduce((m, c) => Math.max(m, c.at + dur(c)), 0);
const laneClips = id => P.clips.filter(c => c.lane === id).sort((a, b) => a.at - b.at);
const laneLast = id => laneClips(id).reduce((m, c) => (!m || c.at + dur(c) > m.at + dur(m) ? c : m), null);
const beatLen = () => P.bpm ? 60 / P.bpm : 0;
const effFo = c => c.fxOut === 'echo' && !(c.fadeOut > 0) ? Math.min(1, dur(c) / 3) : (c.fadeOut || 0);
function fixFades(c) { const d = dur(c); c.fadeIn = clamp(c.fadeIn || 0, 0, d); c.fadeOut = clamp(c.fadeOut || 0, 0, d - c.fadeIn); }
function fixSel() {
  if (selClip && !clipById(selClip)) selClip = null;
  if (!P.lanes.some(l => l.id === selLane)) selLane = P.lanes[0] ? P.lanes[0].id : null;
}
function commit(msg) {
  P.clips.forEach(fixFades);
  const s = JSON.stringify(P); if (s === last) { renderAll(); if (msg) toast(msg); return; }
  hist.push(last); if (hist.length > 150) hist.shift(); fut = []; last = s; persist();
  fixSel(); renderAll(); restartIfPlaying(); if (msg) toast(msg);
}
function undo() { if (!hist.length) return; fut.push(last); last = hist.pop(); P = normalize(JSON.parse(last)); fixSel(); persist(); renderAll(); restartIfPlaying(); toast('Undone'); }
function redo() { if (!fut.length) return; hist.push(last); last = fut.pop(); P = normalize(JSON.parse(last)); fixSel(); persist(); renderAll(); restartIfPlaying(); toast('Redone'); }
function ripple(laneId, from, shift, skip = []) {
  for (const c of P.clips) if (c.lane === laneId && !skip.includes(c.id) && c.at >= from - 1e-3) c.at = Math.max(0, c.at + shift);
}
const newClip = (trackId, lane, at, start, end, extra = {}) => ({ id: uid(), trackId, lane, at, start, end, gain: 1, fadeIn: 0, fadeOut: 0, rate: 1, semi: 0, keepPitch: true, fxIn: 'fade', fxOut: 'fade', ...extra });

/* ---------- editing operations ---------- */
async function addRegion(trackId, a, b, mode) {
  let e; try { e = await ensureBuf(trackId); } catch (err) { return toast(err.message, 5000); }
  if (b == null) { a = 0; b = e.buffer.duration; }
  let laneId, at, xf = 0;
  if (mode === 'layer') { const l = newLane(P.lanes.length + 1); P.lanes.push(l); laneId = l.id; at = playhead; }
  else {
    laneId = selLane && P.lanes.some(l => l.id === selLane) ? selLane : P.lanes[0].id;
    const prev = laneLast(laneId);
    if (prev) { xf = Math.min(P.xfade, (b - a) / 2, dur(prev) / 2); at = Math.max(0, prev.at + dur(prev) - xf); prev.fadeOut = Math.max(prev.fadeOut || 0, xf); }
    else at = 0;
  }
  const c = newClip(trackId, laneId, at, a, b, { fadeIn: xf });
  P.clips.push(c); selClip = c.id; selLane = laneId; edSel = null;
  commit(mode === 'layer' ? 'Added as a new layer' : xf ? `Joined with a ${xf.toFixed(1)}s fade` : 'Added to the layer');
  scrollToTime(c.at);
}
function keepSel() {
  const c = clipById(selClip); if (!c || !edSel) return;
  c.start = edSel.a; c.end = edSel.b; edSel = null; commit('Kept only the selected part');
}
function removeSel() {
  const c = clipById(selClip); if (!c || !edSel) return;
  const a = Math.max(edSel.a, c.start), b = Math.min(edSel.b, c.end), r = c.rate || 1;
  if (b - a < 0.05) return toast('Select a section inside the highlighted part first.');
  const origEnd = c.at + dur(c), cut = (b - a) / r;
  if (a <= c.start + 0.02 && b >= c.end - 0.02) { P.clips = P.clips.filter(x => x !== c); ripple(c.lane, origEnd, -cut); selClip = null; }
  else if (a <= c.start + 0.02) { c.start = b; ripple(c.lane, origEnd, -cut, [c.id]); }
  else if (b >= c.end - 0.02) { c.end = a; ripple(c.lane, origEnd, -cut, [c.id]); }
  else {
    const xf = Math.min(P.xfade, (a - c.start) / r / 2, (c.end - b) / r / 2);
    const c2 = { ...c, id: uid(), start: b, at: tlOf(c, a) - xf, fadeIn: xf, fxIn: 'fade' };
    c.end = a; c.fadeOut = xf; c.fxOut = 'fade'; P.clips.push(c2);
    ripple(c.lane, origEnd, -(cut + xf), [c.id, c2.id]);
  }
  edSel = null; commit('Removed. The gap closes up with a smooth fade.');
}
function splitAtPlayhead() {
  const c = clipById(selClip) || P.clips.find(x => x.lane === selLane && playhead > x.at && playhead < x.at + dur(x));
  if (!c) return toast('Put the red playhead over a part to split it.');
  const t = playhead - c.at;
  if (t <= 0.05 || t >= dur(c) - 0.05) return toast('Move the playhead inside the part to split it.');
  const srcT = c.start + t * (c.rate || 1);
  const c2 = { ...c, id: uid(), start: srcT, at: playhead, fadeIn: 0, fxIn: 'fade' };
  c.end = srcT; c.fadeOut = 0; c.fxOut = 'fade'; P.clips.push(c2); selClip = c2.id; commit('Split in two');
}
function loopClip(n) {
  const c = clipById(selClip); if (!c) return;
  const d = dur(c), after = c.at + d, edge = Math.min(0.01, d / 4), lastFade = c.fadeOut, lastFx = c.fxOut;
  ripple(c.lane, after, (n - 1) * d, [c.id]);
  c.fadeOut = edge; c.fxOut = 'fade';
  for (let k = 1; k < n; k++) P.clips.push({ ...c, id: uid(), at: c.at + k * d, fadeIn: edge, fxIn: 'fade', fadeOut: k === n - 1 ? lastFade : edge, fxOut: k === n - 1 ? lastFx : 'fade' });
  commit(`Looped ${n} times`);
}
function dupClip() {
  const c = clipById(selClip); if (!c) return;
  const after = c.at + dur(c); ripple(c.lane, after, dur(c), [c.id]);
  const c2 = { ...c, id: uid(), at: after }; P.clips.push(c2); selClip = c2.id; commit('Copied');
}
function deleteClip() { const c = clipById(selClip); if (!c) return; P.clips = P.clips.filter(x => x !== c); selClip = null; edSel = null; commit('Part deleted'); }
function closeGaps(laneId) {
  let t = 0; for (const c of laneClips(laneId)) { if (c.at > t) c.at = t; t = Math.max(t, c.at + dur(c)); }
  commit('Gaps closed');
}
async function deleteLane(id) {
  const l = P.lanes.find(x => x.id === id); if (!l) return;
  const n = P.clips.filter(c => c.lane === id).length;
  if (n && !(await ask({ title: `Delete “${l.name}”?`, text: `Its ${n} part${n === 1 ? '' : 's'} go too. You can undo this.`, ok: 'Delete layer', danger: true }))) return;
  P.lanes = P.lanes.filter(x => x !== l); P.clips = P.clips.filter(c => c.lane !== id);
  if (!P.lanes.length) P.lanes.push(newLane(1));
  commit('Layer deleted');
}

/* speed, key, beat */
function nearestRate(songBpm) {
  if (!P.bpm || !songBpm) return 1;
  return [0.5, 1, 2].map(m => P.bpm / (songBpm * m)).reduce((b, r) => Math.abs(Math.log(r)) < Math.abs(Math.log(b)) ? r : b);
}
async function setRate(c, r, msg) {
  const oldEnd = c.at + dur(c);
  c.rate = clamp(r, 0.5, 2);
  ripple(c.lane, oldEnd, c.at + dur(c) - oldEnd, [c.id]);
  try { await ensureProc(c); } catch (e) { toast('Could not change the speed: ' + e.message, 5000); }
  commit(msg);
}
function matchTempo() {
  const c = clipById(selClip); if (!c) return; const a = ana[c.trackId];
  if (!a) return toast('Still working out this song’s tempo. Try again in a moment.');
  if (!a.bpm) return toast('This part has no steady beat, so there is no tempo to match.', 4500);
  if (!P.bpm) return toast('Set the mix tempo first (in Mix on the right).');
  return setRate(c, nearestRate(a.bpm), `Now plays at ${P.bpm} BPM`);
}
function keyShiftTo(a, target) {
  const tonicMaj = x => x.mode === 'minor' ? (x.key + 3) % 12 : x.key;
  let d = ((tonicMaj(target) - tonicMaj(a)) % 12 + 12) % 12; if (d > 6) d -= 12; return d;
}
async function matchKey() {
  const c = clipById(selClip); if (!c) return; const a = ana[c.trackId];
  if (!a) return toast('Still working out this song’s key. Try again in a moment.');
  if (a.key == null) return toast('This part has no clear key (drums or speech, for example), so there is nothing to match.', 4500);
  if (!P.key) return toast('Set the mix key first (in Mix on the right).');
  c.keepPitch = true; c.semi = keyShiftTo(a, P.key);
  try { await ensureProc(c); } catch (e) { return toast('Could not change the key: ' + e.message, 5000); }
  commit(c.semi ? `Shifted ${c.semi > 0 ? 'up' : 'down'} ${Math.abs(c.semi)} semitone${Math.abs(c.semi) === 1 ? '' : 's'} to fit ${keyName(P.key.key, P.key.mode)}` : 'Already in a matching key');
}
function songBeats(id) { const a = ana[id]; return a && a.bpm ? { len: 60 / a.bpm, off: a.offset || 0 } : null; }
function snapSrc(id, t) { const b = songBeats(id); if (!P.snap || !b) return t; return b.off + Math.round((t - b.off) / b.len) * b.len; }
function clipLoudness(c) {
  const e = bufs.get(c.trackId); if (!e) return null;
  const b = e.buffer, sr = b.sampleRate, a = Math.floor(c.start * sr), z = Math.min(b.length, Math.floor(c.end * sr));
  const chs = []; for (let i = 0; i < b.numberOfChannels; i++) chs.push(b.getChannelData(i));
  let s = 0, n = 0; for (let i = a; i < z; i += 8) { let v = 0; for (const d of chs) v += d[i]; v /= chs.length; s += v * v; n++; }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-12);
}
function evenOut() {
  const ls = P.clips.map(c => [c, clipLoudness(c)]).filter(x => x[1] !== null && x[1] > -80);
  if (ls.length < 2) return toast('Add at least two parts to even out.');
  const target = ls.reduce((s, x) => s + x[1], 0) / ls.length;
  ls.forEach(([c, L]) => { c.gain = clamp(Math.pow(10, (target - L) / 20), 0.2, 3); });
  commit('Every part now plays at about the same loudness');
}

/* ---------- sound graph (shared by playback and saving) ---------- */
let impulse = null;
function getImpulse(ac) {
  if (impulse && impulse.sampleRate === ac.sampleRate) return impulse;
  const len = Math.floor(ac.sampleRate * 2.4), b = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
  return (impulse = b);
}
const echoTime = () => P.bpm ? clamp(0.75 * 60 / P.bpm, 0.08, 1.5) : 0.36;
function setFilter(node, v) {
  if (v < 0) { node.type = 'lowpass'; node.frequency.value = 20000 * Math.pow(2, v / 100 * 9.4); node.Q.value = 0.9; }
  else if (v > 0) { node.type = 'highpass'; node.frequency.value = 20 * Math.pow(2, v / 100 * 9.4); node.Q.value = 0.9; }
  else { node.type = 'lowpass'; node.frequency.value = 22000; node.Q.value = 0.0001; }
}
const laneAudible = l => !l.mute && (!P.lanes.some(x => x.solo) || l.solo);
function buildLane(ac, l, master) {
  const g = ac.createGain(); g.gain.value = laneAudible(l) ? l.gain : 0;
  const bass = ac.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 150; bass.gain.value = l.fx.bass;
  const treble = ac.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 5000; treble.gain.value = l.fx.treble;
  const filt = ac.createBiquadFilter(); setFilter(filt, l.fx.filter);
  const pan = ac.createStereoPanner(); pan.pan.value = l.pan;
  g.connect(bass); bass.connect(treble); treble.connect(filt); filt.connect(pan);
  const echoSend = ac.createGain(); echoSend.gain.value = l.fx.echo / 100;
  const delay = ac.createDelay(2); delay.delayTime.value = echoTime();
  const fb = ac.createGain(); fb.gain.value = 0.42; const dl = ac.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 3500;
  filt.connect(echoSend); echoSend.connect(delay); delay.connect(dl); dl.connect(fb); fb.connect(delay); dl.connect(pan);
  const revSend = ac.createGain(); revSend.gain.value = l.fx.reverb / 100 * 0.8;
  const conv = ac.createConvolver(); conv.buffer = getImpulse(ac);
  filt.connect(revSend); revSend.connect(conv); conv.connect(pan);
  pan.connect(master);
  return { g, bass, treble, filt, pan, echoSend, delay, revSend };
}
function envelope(param, c, startPos, when0) {
  const d = dur(c), fi = c.fadeIn || 0, fo = effFo(c), g = c.gain ?? 1;
  const v = u => g * Math.max(0, Math.min(1, fi > 0 ? u / fi : 1, fo > 0 ? (d - u) / fo : 1));
  const T = u => when0 + (c.at + u - startPos);
  const u0 = Math.max(0, startPos - c.at);
  param.setValueAtTime(v(u0), Math.max(when0, T(u0)));
  if (fi > 0 && u0 < fi) param.linearRampToValueAtTime(v(fi), T(fi));
  if (fo > 0) { if (u0 < d - fo) param.setValueAtTime(v(d - fo), T(d - fo)); param.linearRampToValueAtTime(0, T(d)); }
}
function buildGraph(ac, startPos, when0) {
  const master = ac.createGain();
  let out = master;
  if (P.polish) { // one-tap mastering: gentle compression, more level, peak catcher
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -20; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.006; comp.release.value = 0.2;
    const make = ac.createGain(); make.gain.value = 1.9;
    const lim = ac.createDynamicsCompressor(); lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    master.connect(comp); comp.connect(make); make.connect(lim); out = lim;
  }
  out.connect(ac.destination);
  const lanes = new Map();
  for (const l of P.lanes) lanes.set(l.id, buildLane(ac, l, master));
  const srcs = [];
  for (const c of P.clips) {
    const e = bufs.get(c.trackId), ln = lanes.get(c.lane); if (!e || !ln) continue;
    const d = dur(c); if (c.at + d <= startPos) continue;
    const { r, p, k } = clipParams(c);
    const buffer = k === 1 ? e.buffer : procReady.get(procKey(c.trackId, k)); if (!buffer) continue;
    const off = Math.max(0, startPos - c.at), when = when0 + Math.max(0, c.at - startPos);
    const T = u => when0 + (c.at + u - startPos);
    const s = ac.createBufferSource(); s.buffer = buffer; s.playbackRate.value = p;
    const g = ac.createGain(); s.connect(g); envelope(g.gain, c, startPos, when0);
    let tail = g;
    const fi = c.fadeIn || 0, fo = effFo(c), u0 = off;
    if (c.fxIn === 'filter' && fi > 0) {
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.8;
      const fAt = u => 3000 * Math.pow(20 / 3000, clamp(u / fi, 0, 1));
      hp.frequency.setValueAtTime(fAt(u0), Math.max(when0, T(u0))); if (u0 < fi) hp.frequency.exponentialRampToValueAtTime(20, T(fi));
      tail.connect(hp); tail = hp;
    }
    if (c.fxOut === 'filter' && fo > 0) {
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
      const st = d - fo, fAt = u => u <= st ? 20000 : 20000 * Math.pow(150 / 20000, clamp((u - st) / fo, 0, 1));
      lp.frequency.setValueAtTime(fAt(u0), Math.max(when0, T(u0)));
      if (u0 < st) lp.frequency.setValueAtTime(20000, T(st));
      lp.frequency.exponentialRampToValueAtTime(150, T(d));
      tail.connect(lp); tail = lp;
    }
    tail.connect(ln.g);
    if (c.fxOut === 'echo' && fo > 0) { // echo out: the last bit rings on in time with the beat
      const pre = ac.createGain(); pre.gain.value = c.gain ?? 1; s.connect(pre);
      const send = ac.createGain(), st = d - fo;
      send.gain.setValueAtTime(u0 >= st ? 1 : 0, Math.max(when0, T(u0))); if (u0 < st) send.gain.setValueAtTime(1, T(st)); send.gain.setValueAtTime(0, T(d));
      const dl = ac.createDelay(2); dl.delayTime.value = echoTime();
      const fb = ac.createGain(); fb.gain.value = 0.55; const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
      pre.connect(send); send.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(ln.g);
    }
    s.start(when, Math.max(0, (c.start + off * r) * k));
    s.stop(when + (d - off) + 0.01);
    srcs.push(s);
  }
  return { master, out, lanes, srcs };
}
const hasTails = () => P.clips.some(c => c.fxOut === 'echo') || P.lanes.some(l => l.fx.echo > 0 || l.fx.reverb > 0);

/* ---------- playback ---------- */
let playing = false, pos0 = 0, t0 = 0, graph = null, preview = null, tickT = null, previewT = null;
async function ensureAll() {
  for (const id of new Set(P.clips.map(c => c.trackId))) await ensureBuf(id);
  for (const c of P.clips) await ensureProc(c);
}
async function play() {
  stopPreview();
  if (!P.clips.length) { toast('Add a song from the left to start.'); return false; }
  try { await ensureAll(); } catch (err) { toast(err.message, 5000); return false; }
  await ctx.resume();
  if (playhead >= projectEnd() - 0.02) playhead = 0;
  pos0 = playhead; t0 = ctx.currentTime + 0.05;
  graph = buildGraph(ctx, pos0, t0); playing = true; renderTransport(); clearInterval(tickT); tickT = setInterval(tick, 33);
  return true;
}
function pause() {
  if (!playing) return;
  playhead = curPos(); playing = false; clearInterval(tickT);
  if (graph) { graph.srcs.forEach(s => { try { s.stop(); } catch (e) {} }); try { graph.out.disconnect(); graph.master.disconnect(); } catch (e) {} }
  graph = null; renderTransport(); drawPlayhead();
}
const curPos = () => playing ? pos0 + Math.max(0, ctx.currentTime - t0) : playhead;
function restartIfPlaying() { if (playing && !rec) { pause(); play(); } }
function tick() {
  if (!playing) return clearInterval(tickT);
  const p = curPos();
  if (p >= projectEnd() && !rec) { pause(); playhead = projectEnd(); drawPlayhead(); return; }
  drawPlayhead(p); followPlayhead(p); if (rec) renderTransport();
}
function liveLanes() {
  if (!graph) return; const now = ctx.currentTime;
  for (const l of P.lanes) {
    const n = graph.lanes.get(l.id); if (!n) continue;
    n.g.gain.setTargetAtTime(laneAudible(l) ? l.gain : 0, now, 0.02); n.pan.pan.setTargetAtTime(l.pan, now, 0.02);
    n.bass.gain.setTargetAtTime(l.fx.bass, now, 0.02); n.treble.gain.setTargetAtTime(l.fx.treble, now, 0.02);
    setFilter(n.filt, l.fx.filter); n.echoSend.gain.setTargetAtTime(l.fx.echo / 100, now, 0.02); n.revSend.gain.setTargetAtTime(l.fx.reverb / 100 * 0.8, now, 0.02);
    n.delay.delayTime.setTargetAtTime(echoTime(), now, 0.05);
  }
}
function seek(t) { playhead = clamp(t, 0, Math.max(projectEnd(), 0)); if (playing && !rec) { pause(); play(); } else drawPlayhead(); }
async function previewSel() {
  if (preview) return stopPreview();
  const c = clipById(selClip); if (!c) return;
  const e = bufs.get(c.trackId); if (!e) return;
  const a = edSel ? edSel.a : c.start, b = edSel ? edSel.b : c.end;
  pause(); await ctx.resume();
  const s = ctx.createBufferSource(); s.buffer = e.buffer; s.connect(ctx.destination);
  const st = ctx.currentTime + 0.03; s.start(st, a, b - a);
  preview = { s, a, b, st }; s.onended = () => { if (preview && preview.s === s) stopPreview(); };
  $('[data-act="prevsel"]').textContent = 'Stop';
  clearInterval(previewT); previewT = setInterval(() => { if (preview) drawEditor(); else clearInterval(previewT); }, 50);
}
function stopPreview() { if (!preview) return; try { preview.s.stop(); } catch (e) {} preview = null; clearInterval(previewT); const b = $('[data-act="prevsel"]'); if (b) b.textContent = edSel ? 'Play selection' : 'Play part'; drawEditor(); }

/* ---------- recording your voice ---------- */
let rec = null;
async function toggleRecord() {
  if (rec) return stopRecord();
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('This browser cannot record sound.', 5000);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch (e) { return toast('Mixtape needs permission to use your microphone. Allow it in the address bar, then try again.', 6000); }
  stopPreview(); pause();
  const mr = new MediaRecorder(stream), chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const started = new Promise(r => { mr.onstart = () => r(performance.now()); });
  mr.start(); const recWall = await started;
  const at = playhead;
  rec = { mr, stream, chunks, recWall, playWall: performance.now(), at, began: Date.now() };
  if (P.clips.length) { const ok = await play(); if (ok) rec.playWall = performance.now() + Math.max(0, t0 - ctx.currentTime) * 1000; }
  else { await ctx.resume(); playing = true; pos0 = playhead; t0 = ctx.currentTime; rec.playWall = performance.now(); clearInterval(tickT); tickT = setInterval(tick, 33); }
  renderTransport(); toast('Recording. Wear headphones so the music isn’t recorded as well.', 4000);
}
async function stopRecord() {
  const r = rec; rec = null;
  const stopped = new Promise(res => { r.mr.onstop = res; }); r.mr.stop(); await stopped;
  r.stream.getTracks().forEach(t => t.stop());
  if (playing) { if (graph) pause(); else { playhead = curPos(); playing = false; clearInterval(tickT); } }
  renderTransport();
  if (!r.chunks.length) return toast('Nothing was recorded.');
  busy('Saving your recording…');
  try {
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
    const n = lib.filter(t => t.artist === 'My recordings').length + 1, title = `Recording ${n}`;
    const t = { id: uid(), name: title + '.webm', size: blob.size, type: blob.type, title, artist: 'My recordings', album: 'Mixtape Studio', track: 0, duration: 0, added: Date.now(), blob, art: null };
    await saveToLibrary(t);
    const e = await ensureBuf(t.id); t.duration = e.buffer.duration; req('tracks', 'readwrite', o => o.put(t)).catch(() => {});
    const lead = clamp((r.playWall - r.recWall) / 1000 + (ctx.outputLatency || 0) + (ctx.baseLatency || 0), 0, Math.max(0, e.buffer.duration - 0.1));
    const l = newLane('Voice'); P.lanes.push(l);
    const c = newClip(t.id, l.id, r.at, lead, e.buffer.duration); P.clips.push(c); selClip = c.id; selLane = l.id;
    commit(`Saved “${title}” and added it as a new layer`);
  } catch (err) { toast('Could not save the recording: ' + err.message, 6000); }
  finally { busy(null); }
}


/* ---------- splitting into stems (AI, on this device) ---------- */
const STEMS = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other instruments' };
const SPEED_KEY = 'mixtape-split-speed'; // minutes of work per minute of music, measured on this device
const MODEL_PARTS = ['stems/model/htdemucs.part1', 'stems/model/htdemucs.part2'];
function stemsOf(id) {
  const s = {}; for (const t of lib) if (t.stemOf === id && STEMS[t.stemName]) s[t.stemName] = t;
  return Object.keys(STEMS).every(k => s[k]) ? s : null;
}
async function modelSaved() {
  try { const c = await caches.open('mixtape-stems-model-v1'); const r = await Promise.all(MODEL_PARTS.map(p => c.match(new URL(p, location.href).href))); return r.every(Boolean); }
  catch (e) { return false; }
}
async function to44k(buffer) {
  let b = buffer;
  if (b.sampleRate !== 44100) {
    const oc = new OfflineAudioContext(2, Math.ceil(b.duration * 44100), 44100);
    const s = oc.createBufferSource(); s.buffer = b; s.connect(oc.destination); s.start(); b = await oc.startRendering();
  }
  const left = b.getChannelData(0).slice(), right = (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice();
  return { left, right };
}
const fmtLeft = s => s < 90 ? `${Math.max(5, Math.round(s / 5) * 5)} seconds` : `${Math.round(s / 60)} minutes`;
function runSplit(src, left, right) {
  const w = new Worker('stems/stem-worker.js', { type: 'module' });
  let t1 = 0;
  const p = new Promise((res, rej) => {
    const cancel = () => { w.terminate(); const e = new Error('cancelled'); e.cancelled = true; rej(e); };
    busy('Getting the song ready…', { progress: 0, onCancel: cancel });
    w.onmessage = ev => {
      const m = ev.data;
      if (m.type === 'progress') {
        if (m.stage === 'download') busy(`Downloading the AI model (one time only): ${Math.round(m.done / 1048576)} of ${Math.round(m.total / 1048576)} MB`, { progress: m.done / m.total, onCancel: cancel });
        else if (m.stage === 'load') busy(m.backend === 'webgpu' ? 'Starting the AI on your graphics chip…' : 'Starting the AI. The browser cannot use a graphics chip on this laptop, so this will be slow…', { progress: 0, onCancel: cancel });
        else {
          if (!t1) t1 = performance.now();
          const per = m.done > 1 ? (performance.now() - t1) / 1000 / (m.done - 1) : 0;
          busy(`Splitting “${src.title}”: section ${m.done} of ${m.total}${per ? ` · about ${fmtLeft(per * (m.total - m.done))} left` : ''}`, { progress: m.done / m.total, onCancel: cancel });
        }
      } else if (m.type === 'done') res(m);
      else if (m.type === 'error') rej(new Error(m.message));
    };
    w.onerror = ev => rej(new Error(ev.message || 'The stem splitter stopped unexpectedly.'));
    w.postMessage({ type: 'split', left, right }, [left.buffer, right.buffer]);
  });
  return p.finally(() => w.terminate());
}
async function splitStems() {
  const c = clipById(selClip); if (!c) return;
  const src = libTrack(c.trackId); if (!src) return;
  if (src.stemOf) return toast('This part is already a stem.');
  let stems = stemsOf(src.id);
  if (!stems) {
    const saved = await modelSaved();
    let speed = 0; try { speed = +localStorage.getItem(SPEED_KEY) || 0; } catch (e) {}
    const songMin = (src.duration || 180) / 60;
    const howLong = speed
      ? `Last time, this laptop needed about ${Math.max(1, Math.round(speed))} minutes for every minute of music, so this song should take about ${Math.max(1, Math.round(speed * songMin))} minutes.`
      : 'This is heavy work for a laptop: expect several minutes for every minute of music, and the first section is the slowest while the AI warms up.';
    const ok = await ask({ title: `Split “${src.title}”?`, ok: 'Split song',
      text: (saved ? '' : 'The first time, Mixtape downloads the AI model (181 MB). After that it works offline. ')
        + howLong + ' Keep Mixtape open and in front while it works. You can cancel at any time, and each song only needs splitting once.' });
    if (!ok) return;
    pause(); stopPreview();
    let e; try { e = await ensureBuf(src.id); } catch (err) { return toast(err.message, 5000); }
    busy('Getting the song ready…', { progress: 0 });
    const { left, right } = await to44k(e.buffer);
    let result;
    try { result = await runSplit(src, left, right); }
    catch (err) { busy(null); return toast(err.cancelled ? 'Splitting cancelled' : `Couldn't split the song: ${err.message}`, err.cancelled ? 2600 : 7000); }
    busy('Saving the four parts to your library…', { progress: 1 });
    try {
      const n = result.stems.vocals.left.length;
      for (const k of Object.keys(STEMS)) {
        const s = result.stems[k], blob = encodeWavData([s.left, s.right], 44100);
        await saveToLibrary({ id: uid(), name: `${src.title} - ${STEMS[k]}.wav`, size: blob.size, type: 'audio/wav', title: `${src.title} (${STEMS[k].toLowerCase()})`,
          artist: src.artist || '', album: 'Stems', track: 0, duration: n / 44100, added: Date.now(), blob, art: null, stemOf: src.id, stemName: k });
      }
    } catch (err) { busy(null); return toast('Could not save the stems: ' + (err.message || 'your browser may be out of storage space'), 7000); }
    busy(null);
    stems = stemsOf(src.id);
    if (!stems) return toast('The stems were made but could not be found in your library.', 6000);
    try { if (src.duration > 0) localStorage.setItem(SPEED_KEY, String(result.seconds / src.duration)); } catch (e) {}
  }
  // Replace the part with four layers, one per stem, lined up exactly where the part was
  const at = P.lanes.findIndex(l => l.id === c.lane);
  const newLanes = Object.keys(STEMS).map(k => newLane(STEMS[k]));
  P.lanes.splice(at + 1, 0, ...newLanes);
  Object.keys(STEMS).forEach((k, i) => P.clips.push({ ...c, id: uid(), trackId: stems[k].id, lane: newLanes[i].id }));
  P.clips = P.clips.filter(x => x !== c);
  selClip = null; selLane = newLanes[0].id;
  for (const k of Object.keys(STEMS)) { try { await ensureBuf(stems[k].id); } catch (e) {} }
  commit('Split into 4 layers. Mute “Vocals” for a karaoke version, or keep only the drums.');
}


/* ---------- saving the mix as a song ---------- */
function encodeWav(buf, scale) {
  const data = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) data.push(buf.getChannelData(c));
  return encodeWavData(data, buf.sampleRate, scale);
}
function encodeWavData(data, sr, scale = 1) {
  const ch = data.length, n = data[0].length;
  const ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = clamp(data[c][i] * scale, -1, 1); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
}
async function renderMix() {
  await ensureAll();
  const end = projectEnd() + (hasTails() ? 2.5 : 0), sr = ctx.sampleRate;
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(end * sr)), sr);
  buildGraph(oc, 0, 0);
  const out = await oc.startRendering();
  let peak = 0; for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
  return { blob: encodeWav(out, peak > 0.98 ? 0.98 / peak : 1), duration: out.duration, buffer: out };
}
async function saveSong() {
  if (!P.clips.length) return toast('There is nothing to save yet. Add a song first.');
  const name = await ask({ title: 'Save as a song', text: 'Your mix is added to your library as a new song. The original songs stay as they are.', input: P.name || 'My mix', ok: 'Save song' });
  if (!name) return;
  pause(); busy('Mixing your song…');
  try {
    const { blob, duration } = await renderMix();
    await saveToLibrary({ id: uid(), name: name + '.wav', size: blob.size, type: 'audio/wav', title: name, artist: 'My mixes', album: 'Mixtape Studio', track: 0, duration, added: Date.now(), blob, art: null });
    toast(`Saved “${name}” to your library (${(blob.size / 1048576).toFixed(1)} MB).`, 4500);
  } catch (err) { toast(`Couldn't save the mix: ${err.message || 'your browser may be out of storage space'}.`, 6000); }
  finally { busy(null); }
}

/* ---------- drawing ---------- */
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const waveColor = (h, alpha = 1) => `hsl(${h} 45% ${css('--wave-l')} / ${alpha})`;
function drawWave(g, e, ta, tb, x0, w, h, color) {
  const { min, max, rate } = e.peaks, mid = h / 2; g.fillStyle = color;
  const span = tb - ta;
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((ta + span * x / w) * rate), i1 = Math.max(i0 + 1, Math.ceil((ta + span * (x + 1) / w) * rate));
    let lo = 0, hi = 0; for (let i = Math.max(0, i0); i < Math.min(min.length, i1); i++) { if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i]; }
    g.fillRect(x0 + x, mid - hi * mid * 0.92, 1, Math.max(1, (hi - lo) * mid * 0.92));
  }
}
function drawClipCanvas(cv, c) {
  const e = bufs.get(c.trackId), r = dpr();
  const wCss = Math.max(1, dur(c) * pps), hCss = cv.parentElement.clientHeight || 80;
  const w = Math.min(16000, Math.round(wCss * r)), h = Math.round(hCss * r);
  cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
  if (!e) return;
  drawWave(g, e, c.start, c.end, 0, w, h, waveColor(hueOf(c.trackId), .9));
  g.fillStyle = css('--bg'); g.globalAlpha = .55;
  const fi = (c.fadeIn || 0) / dur(c) * w, fo = effFo(c) / dur(c) * w;
  if (fi > 1) { g.beginPath(); g.moveTo(0, 0); g.lineTo(fi, 0); g.lineTo(0, h); g.closePath(); g.fill(); }
  if (fo > 1) { g.beginPath(); g.moveTo(w, 0); g.lineTo(w - fo, 0); g.lineTo(w, h); g.closePath(); g.fill(); }
  g.globalAlpha = 1;
}
const headW = () => parseFloat(css('--head-w')) || 200;
const timelineWidth = () => Math.max($('#tl').clientWidth - headW(), (projectEnd() + 30) * pps);
function clipBadge(c) {
  const bits = [];
  if ((c.rate || 1) !== 1) bits.push(`${Math.round(c.rate * 100)}%`);
  if (c.semi) bits.push(`${c.semi > 0 ? '+' : ''}${c.semi} key`);
  if (c.fxOut === 'echo') bits.push('echo out'); else if (c.fxOut === 'filter') bits.push('filter out');
  if (c.fxIn === 'filter') bits.push('filter in');
  return bits.length ? ' · ' + bits.join(' · ') : '';
}
function renderLanes() {
  const anySolo = P.lanes.some(l => l.solo), bl = beatLen();
  const gridCls = P.snap && bl ? ' grid' : '', gridVars = P.snap && bl ? `--beat:${bl * pps}px;--bar:${bl * 4 * pps}px;` : '';
  $('#lanes').innerHTML = P.lanes.map(l => {
    const fxOn = Object.values(l.fx).some(v => v);
    return `
    <div class="lane${l.id === selLane ? ' on' : ''}" data-lane="${l.id}">
      <div class="lane-head">
        <div class="lh-top">
          <input value="${esc(l.name)}" data-lf="name" aria-label="Layer name" maxlength="40">
          <button class="tg m${l.mute ? ' on' : ''}" data-lf="mute" title="Mute this layer" aria-pressed="${l.mute}">M</button>
          <button class="tg s${l.solo ? ' on' : ''}" data-lf="solo" title="Hear only this layer" aria-pressed="${l.solo}">S</button>
          <button class="tg x" data-lf="del" title="Delete layer" aria-label="Delete layer">✕</button>
        </div>
        <div class="lh-row"><span>VOL</span><input type="range" min="0" max="150" value="${Math.round(l.gain * 100)}" data-lf="gain" aria-label="Layer volume"><output>${Math.round(l.gain * 100)}%</output></div>
        <div class="lh-row"><span>L·R</span><input type="range" min="-100" max="100" value="${Math.round(l.pan * 100)}" data-lf="pan" aria-label="Layer left-right balance"><output>${l.pan === 0 ? 'C' : (l.pan < 0 ? 'L' : 'R') + Math.abs(Math.round(l.pan * 100))}</output></div>
        ${fxOn ? '<div class="lh-row"><span>FX</span><span style="grid-column:2/4;color:var(--accent)">effects on</span></div>' : ''}
      </div>
      <div class="lane-body${gridCls}" style="${gridVars}width:${timelineWidth()}px;${anySolo && !l.solo || l.mute ? 'opacity:.45' : ''}">
        ${P.clips.filter(c => c.lane === l.id).map(c => {
          const t = libTrack(c.trackId), name = t ? t.title : 'Missing song';
          return `<div class="clip${c.id === selClip ? ' sel' : ''}" data-clip="${c.id}" style="left:${c.at * pps}px;width:${Math.max(4, dur(c) * pps)}px;--h:${hueOf(c.trackId)}" title="${esc(name)} · ${fmtT(dur(c))}${esc(clipBadge(c))}">
            <canvas></canvas><span class="cl">${esc(name)}${esc(clipBadge(c))}</span><span class="h l" data-h="l"></span><span class="h r" data-h="r"></span></div>`;
        }).join('')}
      </div>
    </div>`; }).join('');
  $('#tlInner').style.width = (headW() + timelineWidth()) + 'px';
  $$('.clip').forEach(el => drawClipCanvas(el.querySelector('canvas'), clipById(el.dataset.clip)));
  renderRuler(); drawPlayhead();
}
function renderRuler() {
  const cv = $('#ruler'), r = dpr(), w = timelineWidth(), h = 28;
  cv.style.width = w + 'px'; cv.width = Math.min(32000, Math.round(w * r)); cv.height = h * r;
  const g = cv.getContext('2d'); g.setTransform(cv.width / w, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  const bl = beatLen();
  if (bl && bl * pps >= 5) { g.fillStyle = css('--line'); for (let b = 0; b * bl * pps < w; b++) g.fillRect(Math.round(b * bl * pps), b % 4 ? 23 : 19, 1, b % 4 ? 5 : 9); }
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120]; const step = steps.find(s => s * pps >= 64) || 300;
  g.fillStyle = css('--muted'); g.strokeStyle = css('--line'); g.font = `11px ${css('--f-mono')}`; g.textBaseline = 'middle';
  for (let t = 0; t * pps < w; t += step) {
    const x = Math.round(t * pps) + .5; g.beginPath(); g.moveTo(x, 14); g.lineTo(x, h); g.stroke();
    const m = Math.floor(t / 60), s = t % 60; g.fillText(`${m}:${String(Math.floor(s)).padStart(2, '0')}${step < 1 && s % 1 ? '.5' : ''}`, x + 4, 8);
  }
}
function drawPlayhead(p = curPos()) {
  $('#playhead').style.left = (headW() + p * pps) + 'px';
  $('#clock').innerHTML = `${fmtT(p)} <span>/ ${fmtT(projectEnd())}</span>`;
}
function followPlayhead(p) {
  const tl = $('#tl'), x = headW() + p * pps;
  if (x > tl.scrollLeft + tl.clientWidth - 40 || x < tl.scrollLeft + headW()) tl.scrollLeft = x - headW() - 40;
}
function scrollToTime(t) { const tl = $('#tl'); const x = t * pps; if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - headW() - 60) tl.scrollLeft = Math.max(0, x - 60); }

let edView = null;
function drawEditor() {
  const c = clipById(selClip), cv = $('#edCanvas'), wrap = $('#edWrap');
  $('#edEmpty').hidden = !!c;
  ['keep', 'remove', 'selappend', 'sellayer'].forEach(a => { const b = $(`[data-act="${a}"]`); if (b) b.disabled = !c || !edSel; });
  $('[data-act="selall"]').disabled = $('[data-act="prevsel"]').disabled = !c;
  if (!preview) $('[data-act="prevsel"]').textContent = edSel ? 'Play selection' : 'Play part';
  const r = dpr(), w = wrap.clientWidth, h = wrap.clientHeight;
  cv.width = Math.round(w * r); cv.height = Math.round(h * r);
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  if (!c) { $('#edTitle').textContent = 'Part editor'; $('#edInfo').textContent = ''; $('#selInfo').textContent = 'No part selected'; edView = null; return; }
  const t = libTrack(c.trackId), e = bufs.get(c.trackId), a = ana[c.trackId];
  $('#edTitle').textContent = t ? t.title : 'Missing song';
  $('#edInfo').textContent = `part ${fmtT(c.start)}–${fmtT(c.end)} of ${e ? fmtT(e.buffer.duration) : '?'}${a ? ` · ${a.bpm ? a.bpm + ' BPM' : 'no steady beat'} · ${a.keyName}` : analyzing.has(c.trackId) ? ' · finding tempo and key…' : ''}`;
  $('#selInfo').textContent = edSel ? `Selected ${fmtT(edSel.a)}–${fmtT(edSel.b)} (${(edSel.b - edSel.a).toFixed(1)}s)` : P.snap ? 'Drag to select (snaps to the beat)' : 'Drag across the waveform to select';
  if (!e) return;
  const D = e.buffer.duration; edView = { D, w };
  const X = s => s / D * w, hue = hueOf(c.trackId);
  g.fillStyle = waveColor(hue, .12); g.fillRect(X(c.start), 0, X(c.end) - X(c.start), h);
  drawWave(g, e, 0, D, 0, w, h, waveColor(hue, .35));
  g.save(); g.beginPath(); g.rect(X(c.start), 0, X(c.end) - X(c.start), h); g.clip(); drawWave(g, e, 0, D, 0, w, h, waveColor(hue, 1)); g.restore();
  const sb = songBeats(c.trackId);
  if (sb && sb.len / D * w >= 3) { g.fillStyle = css('--muted'); for (let b = 0, tb = sb.off; tb < D; b++, tb += sb.len) g.fillRect(Math.round(X(tb)), 0, 1, b % 4 ? 4 : 9); }
  g.fillStyle = css('--accent'); g.fillRect(X(c.start) - 1, 0, 2, h); g.fillRect(X(c.end) - 1, 0, 2, h);
  if (edSel) { g.fillStyle = css('--sel'); g.fillRect(X(edSel.a), 0, X(edSel.b) - X(edSel.a), h); g.fillStyle = css('--ink'); g.fillRect(X(edSel.a), 0, 1, h); g.fillRect(X(edSel.b), 0, 1, h); }
  if (preview) { const p = preview.a + (ctx.currentTime - preview.st); g.fillStyle = css('--danger'); g.fillRect(X(clamp(p, preview.a, preview.b)), 0, 2, h); }
  else { const p = curPos() - c.at; if (p >= 0 && p <= dur(c)) { g.fillStyle = css('--danger'); g.fillRect(X(c.start + p * (c.rate || 1)), 0, 2, h); } }
}

function renderInspector() {
  const c = clipById(selClip), l = P.lanes.find(x => x.id === selLane);
  let html = '';
  if (c) {
    const t = libTrack(c.trackId), d = dur(c), a = ana[c.trackId], { r } = clipParams(c);
    const songBpm = a && a.bpm ? a.bpm : null, nowBpm = songBpm ? Math.round(songBpm * r * 10) / 10 : null;
    const nowKey = a && a.key != null ? keyName(a.key + (c.keepPitch === false ? Math.round(12 * Math.log2(r)) : c.semi), a.mode) : null;
    html += `<div class="sec"><h3>Selected part</h3>
      <dl class="kv"><dt>Song</dt><dd>${esc(t ? t.title : 'Missing song')}</dd><dt>Starts at</dt><dd>${fmtT(c.at)}</dd><dt>Length</dt><dd>${fmtT(d)}</dd>
      <dt>Song is</dt><dd>${a ? `${songBpm ? songBpm + ' BPM' : 'no steady beat'} · ${esc(a.keyName)}` : analyzing.has(c.trackId) ? 'working it out…' : '—'}</dd></dl>
      <div class="field"><label for="cGain">Volume</label><input id="cGain" type="range" min="0" max="300" value="${Math.round((c.gain ?? 1) * 100)}" data-cf="gain"><output>${Math.round((c.gain ?? 1) * 100)}%</output></div>
      <div class="field"><label for="cFi">Fade in</label><input id="cFi" type="range" min="0" max="${Math.min(10, d).toFixed(1)}" step="0.1" value="${(c.fadeIn || 0).toFixed(1)}" data-cf="fadeIn"><output>${(c.fadeIn || 0).toFixed(1)}s</output></div>
      <div class="field"><label for="cFo">Fade out</label><input id="cFo" type="range" min="0" max="${Math.min(10, d).toFixed(1)}" step="0.1" value="${(c.fadeOut || 0).toFixed(1)}" data-cf="fadeOut"><output>${(c.fadeOut || 0).toFixed(1)}s</output></div>
      <div class="field"><label for="cFxIn">Start style</label><select id="cFxIn" data-cs="fxIn"><option value="fade">Fade</option><option value="filter">Filter sweep</option></select><span></span></div>
      <div class="field"><label for="cFxOut">End style</label><select id="cFxOut" data-cs="fxOut"><option value="fade">Fade</option><option value="filter">Filter sweep</option><option value="echo">Echo out</option></select><span></span></div>
      <div class="btnrow"><button class="btn sm" data-act="split">Split at playhead</button><button class="btn sm" data-act="dup">Copy after</button><button class="btn sm" data-act="del">Delete part</button></div>
      <div class="btnrow"><button class="btn sm primary" data-act="stems" ${t && t.stemOf ? 'disabled title="This part is already a stem"' : ''}>Split into vocals, drums, bass…</button></div>
      <div class="btnrow"><span class="hint" style="align-self:center">Repeat this part</span><button class="btn sm" data-act="loop" data-n="2">×2</button><button class="btn sm" data-act="loop" data-n="4">×4</button><button class="btn sm" data-act="loop" data-n="8">×8</button></div>
      <p class="sub">Speed and key</p>
      <div class="field"><label for="cRate">Speed</label><input id="cRate" type="range" min="50" max="200" value="${Math.round(r * 100)}" data-cf="rate"><output>${Math.round(r * 100)}%</output></div>
      <p class="ana">${nowBpm ? `Plays at ${nowBpm} BPM` : ''}${nowKey ? ` · in ${esc(nowKey)}` : ''}</p>
      <label class="chk"><input type="checkbox" data-cc="keepPitch" ${c.keepPitch !== false ? 'checked' : ''}> Keep the original pitch</label>
      <div class="field"><label for="cSemi">Key</label><input id="cSemi" type="range" min="-6" max="6" value="${c.semi || 0}" data-cf="semi" ${c.keepPitch === false ? 'disabled' : ''}><output>${c.semi > 0 ? '+' : ''}${c.semi || 0}</output></div>
      <div class="btnrow"><button class="btn sm" data-act="matchtempo" ${P.bpm && songBpm ? '' : 'disabled'}>Match mix tempo${P.bpm ? ` (${P.bpm})` : ''}</button><button class="btn sm" data-act="matchkey" ${P.key && a && a.key != null ? '' : 'disabled'}>Match mix key</button></div>
    </div>`;
  } else {
    html += `<div class="sec"><h3>Selected part</h3><p class="hint">Click a part on the timeline to change its volume, fades, speed and key, or to split or repeat it.</p></div>`;
  }
  if (l) {
    const fx = l.fx, f = fx.filter;
    html += `<div class="sec"><h3>Layer: ${esc(l.name)}</h3><p class="hint">Songs you add with “+ End” join the end of this layer. Effects apply to everything on it.</p>
      <div class="field"><label for="fBass">Bass</label><input id="fBass" type="range" min="-12" max="12" value="${fx.bass}" data-lx="bass"><output>${fx.bass > 0 ? '+' : ''}${fx.bass} dB</output></div>
      <div class="field"><label for="fTre">Treble</label><input id="fTre" type="range" min="-12" max="12" value="${fx.treble}" data-lx="treble"><output>${fx.treble > 0 ? '+' : ''}${fx.treble} dB</output></div>
      <div class="field"><label for="fFil">Filter</label><input id="fFil" type="range" min="-100" max="100" value="${f}" data-lx="filter"><output>${f === 0 ? 'off' : f < 0 ? 'muffle ' + -f : 'thin ' + f}</output></div>
      <div class="field"><label for="fEcho">Echo</label><input id="fEcho" type="range" min="0" max="100" value="${fx.echo}" data-lx="echo"><output>${fx.echo}%</output></div>
      <div class="field"><label for="fRev">Reverb</label><input id="fRev" type="range" min="0" max="100" value="${fx.reverb}" data-lx="reverb"><output>${fx.reverb}%</output></div>
      <div class="btnrow"><button class="btn sm" data-act="fxreset">Reset effects</button><button class="btn sm" data-act="closegaps">Close gaps</button></div></div>`;
  }
  const keyOpts = ['<option value="">Not set</option>'].concat([0, 1].flatMap(mi => KEYS.map((k, i) => { const mode = mi ? 'minor' : 'major'; const sel = P.key && P.key.key === i && P.key.mode === mode; return `<option value="${i}|${mode}" ${sel ? 'selected' : ''}>${k} ${mode}</option>`; }))).join('');
  html += `<div class="sec"><h3>Mix</h3>
      <div class="field"><label for="pBpm">Tempo</label><input id="pBpm" type="number" min="40" max="240" step="0.1" value="${P.bpm || ''}" placeholder="auto" data-pf="bpm" style="height:30px;border-radius:7px;border:1px solid var(--line);background:var(--raise);padding:0 6px;width:100%"><output>BPM</output></div>
      <div class="field"><label for="pKey">Key</label><select id="pKey" data-pf="key">${keyOpts}</select><span></span></div>
      <p class="hint">Tempo and key are set from the first song you add. “Match mix tempo” and “Match mix key” bring other parts in line so they fit together.</p>
      <div class="field"><label for="xf">Join fade</label><input id="xf" type="range" min="0" max="4" step="0.1" value="${P.xfade}" data-pf="xfade"><output>${P.xfade.toFixed(1)}s</output></div>
      <label class="chk"><input type="checkbox" data-pc="snap" ${P.snap ? 'checked' : ''}> Snap to the beat</label>
      <label class="chk"><input type="checkbox" data-pc="polish" ${P.polish ? 'checked' : ''}> Polish: make it louder and more even</label>
      <div class="btnrow"><button class="btn sm" data-act="evenout">Even out volume between parts</button></div></div>
    <div class="sec"><h3>Keys</h3><div class="keys"><kbd>Space</kbd> play/pause · <kbd>Home</kbd> start<br><kbd>S</kbd> split · <kbd>Del</kbd> delete part<br><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Y</kbd> redo<br><kbd>+</kbd>/<kbd>−</kbd> zoom · <kbd>Ctrl</kbd>+wheel zoom</div></div>`;
  const ins = $('#insp'), st = ins.scrollTop; ins.innerHTML = html; ins.scrollTop = st;
  if (c) { $('#cFxIn').value = c.fxIn || 'fade'; $('#cFxOut').value = c.fxOut || 'fade'; }
}
function renderLibrary() {
  const q = $('#libQ').value.trim().toLowerCase();
  const list = lib.filter(t => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
  $('#lib').innerHTML = list.length ? list.map(t => { const a = ana[t.id];
    const info = a ? `<span class="bk">${a.bpm ? a.bpm + ' BPM' : 'no steady beat'} · ${esc(a.keyName)}</span>` : analyzing.has(t.id) ? '<span class="bk">finding tempo and key…</span>' : '';
    return `<li><div style="min-width:0"><b title="${esc(t.title)}">${esc(t.title)}</b><span>${esc(t.artist || 'Unknown artist')} · ${fmtT(t.duration).replace(/\.\d$/, '')}</span>${info}</div>
      <div class="acts"><button data-add="append" data-id="${t.id}" title="Add to the end of the selected layer">+ End</button><button data-add="layer" data-id="${t.id}" title="Add as a new layer at the playhead">+ Layer</button></div></li>`; }).join('')
    : `<li class="empty-note">${lib.length ? 'No songs match.' : 'Your library is empty. Add songs in the player first.'}</li>`;
}
function renderTransport() {
  $('#playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#undoBtn').disabled = !hist.length; $('#redoBtn').disabled = !fut.length;
  $('#saveBtn').disabled = !P.clips.length || !!rec;
  $('#snapBtn').setAttribute('aria-pressed', P.snap);
  $('#tempoLbl').textContent = P.bpm ? `${P.bpm} BPM${P.key ? ' · ' + keyName(P.key.key, P.key.mode) : ''}` : '— BPM';
  $('#recBtn').classList.toggle('on', !!rec);
  $('#recLbl').textContent = rec ? `Stop recording ${fmtT((Date.now() - rec.began) / 1000).replace(/\.\d$/, '')}` : 'Record voice';
}
function renderAll() { $('#projName').value = P.name; renderLanes(); drawEditor(); renderInspector(); renderTransport(); }

/* ---------- interaction ---------- */
const acts = {
  play: () => playing ? (rec ? stopRecord() : pause()) : play(), stop: () => { if (rec) return stopRecord(); pause(); seek(0); $('#tl').scrollLeft = 0; },
  undo, redo, save: saveSong, record: toggleRecord,
  zin: () => zoom(1.5), zout: () => zoom(1 / 1.5), fit: fitZoom,
  snap: () => { P.snap = !P.snap; if (P.snap && !P.bpm) toast('Add a song first so the Studio can find the beat.'); commit(P.snap ? 'Snapping to the beat' : 'Snap off'); },
  addlane: () => { const l = newLane(P.lanes.length + 1); P.lanes.push(l); selLane = l.id; commit('Layer added'); },
  selall: () => { const c = clipById(selClip); if (c) { edSel = { a: c.start, b: c.end }; drawEditor(); } },
  prevsel: previewSel, keep: keepSel, remove: removeSel,
  selappend: () => { const c = clipById(selClip); if (c && edSel) addRegion(c.trackId, edSel.a, edSel.b, 'append'); },
  sellayer: () => { const c = clipById(selClip); if (c && edSel) addRegion(c.trackId, edSel.a, edSel.b, 'layer'); },
  split: splitAtPlayhead, dup: dupClip, del: deleteClip, loop: b => loopClip(+b.dataset.n),
  closegaps: () => selLane && closeGaps(selLane),
  matchtempo: matchTempo, matchkey: matchKey, evenout: evenOut, stems: splitStems,
  fxreset: () => { const l = P.lanes.find(x => x.id === selLane); if (l) { l.fx = FX0(); commit('Effects reset'); liveLanes(); } },
  newproj: async () => {
    if (P.clips.length && !(await ask({ title: 'Start a new mix?', text: 'This clears the timeline. Save your current mix as a song first if you want to keep it.', ok: 'Start new mix', danger: true }))) return;
    pause(); P = newProject(); selClip = null; selLane = P.lanes[0].id; edSel = null; playhead = 0; commit();
  },
};
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled && acts[b.dataset.act]) acts[b.dataset.act](b, e); });
$('#lib').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) addRegion(b.dataset.id, 0, null, b.dataset.add); });
$('#libQ').addEventListener('input', renderLibrary);
$('#projName').addEventListener('change', e => { P.name = e.target.value.trim() || 'My mix'; commit(); });

function zoom(f, anchorT) {
  const tl = $('#tl'); const t = anchorT ?? (tl.scrollLeft + (tl.clientWidth - headW()) / 2) / pps;
  pps = clamp(pps * f, 2, 600); renderLanes(); drawEditor();
  tl.scrollLeft = Math.max(0, t * pps - (tl.clientWidth - headW()) / 2);
}
function fitZoom() { const end = Math.max(projectEnd(), 20); pps = clamp(($('#tl').clientWidth - headW() - 40) / end, 2, 600); renderLanes(); $('#tl').scrollLeft = 0; }
$('#tl').addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });

$('#ruler').addEventListener('pointerdown', e => {
  const cv = e.currentTarget; try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const at = ev => (ev.clientX - cv.getBoundingClientRect().left) / pps;
  seek(at(e)); const mv = ev => { playhead = clamp(at(ev), 0, projectEnd()); drawPlayhead(); drawEditor(); };
  cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', () => { cv.removeEventListener('pointermove', mv); seek(playhead); }, { once: true });
});

$('#lanes').addEventListener('input', e => {
  const f = e.target.dataset.lf; if (!f) return; const l = P.lanes.find(x => x.id === e.target.closest('.lane').dataset.lane);
  if (f === 'gain') { l.gain = e.target.value / 100; e.target.nextElementSibling.textContent = e.target.value + '%'; liveLanes(); }
  if (f === 'pan') { l.pan = e.target.value / 100; const v = Math.round(l.pan * 100); e.target.nextElementSibling.textContent = v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(v); liveLanes(); }
});
const quietCommit = () => { const s = JSON.stringify(P); if (s !== last) { hist.push(last); fut = []; last = s; persist(); renderTransport(); } };
$('#lanes').addEventListener('change', e => {
  const f = e.target.dataset.lf; if (!f) return; const l = P.lanes.find(x => x.id === e.target.closest('.lane').dataset.lane);
  if (f === 'name') { l.name = e.target.value.trim() || l.name; quietCommit(); renderInspector(); } else quietCommit();
});
$('#lanes').addEventListener('click', e => {
  const b = e.target.closest('[data-lf]'); const laneEl = e.target.closest('.lane'); if (!laneEl) return;
  const l = P.lanes.find(x => x.id === laneEl.dataset.lane);
  if (b && b.tagName === 'BUTTON') {
    if (b.dataset.lf === 'mute') { l.mute = !l.mute; liveLanes(); quietCommit(); renderLanes(); }
    else if (b.dataset.lf === 'solo') { l.solo = !l.solo; liveLanes(); quietCommit(); renderLanes(); }
    else if (b.dataset.lf === 'del') deleteLane(l.id);
    return;
  }
  if (selLane !== l.id && !e.target.closest('.clip')) { selLane = l.id; renderLanes(); renderInspector(); }
});

$('#lanes').addEventListener('pointerdown', e => {
  const body = e.target.closest('.lane-body'); if (!body || e.button !== 0) return;
  const el = e.target.closest('.clip');
  if (!el) {
    const t = (e.clientX - body.getBoundingClientRect().left) / pps; selLane = body.parentElement.dataset.lane; selClip = null; edSel = null;
    seek(clamp(t, 0, projectEnd())); renderLanes(); drawEditor(); renderInspector(); return;
  }
  const c = clipById(el.dataset.clip); if (!c) return;
  const mode = e.target.dataset.h || 'move';
  if (selClip !== c.id) { selClip = c.id; edSel = null; }
  selLane = c.lane;
  $$('.clip.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
  $$('.lane.on').forEach(x => x.classList.remove('on')); el.closest('.lane').classList.add('on');
  ensureBuf(c.trackId).then(() => drawEditor()).catch(err => toast(err.message, 5000));
  drawEditor(); renderInspector();
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  el.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
  const x0 = e.clientX, o = { at: c.at, start: c.start, end: c.end }, r = c.rate || 1, srcDur = bufs.get(c.trackId)?.buffer.duration ?? c.end;
  const edges = P.clips.filter(x => x !== c).flatMap(x => [x.at, x.at + dur(x)]).concat([0, playhead]);
  const snapEdge = t => { for (const s of edges) if (Math.abs(s - t) * pps < 8) return s; return null; };
  const bl = beatLen();
  let moved = false;
  const mv = ev => {
    const dt = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return;
    if (mode === 'move') {
      let at = Math.max(0, o.at + dt);
      const s1 = snapEdge(at), s2 = snapEdge(at + dur(c));
      if (s1 !== null) at = s1; else if (s2 !== null) at = s2 - dur(c);
      else if (P.snap && bl) at = Math.round(at / bl) * bl;
      c.at = Math.max(0, at);
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane');
      if (under && under.dataset.lane !== c.lane) { c.lane = under.dataset.lane; under.querySelector('.lane-body').appendChild(el); }
      el.style.left = c.at * pps + 'px';
    } else if (mode === 'l') {
      let ns = clamp(o.start + dt * r, 0, o.end - 0.1); ns = snapSrc(c.trackId, ns);
      c.start = ns; c.at = o.at + (ns - o.start) / r;
      if (c.at < 0) { c.start = o.start - o.at * r; c.at = 0; }
      el.style.left = c.at * pps + 'px'; el.style.width = dur(c) * pps + 'px';
    } else {
      c.end = clamp(snapSrc(c.trackId, o.end + dt * r), o.start + 0.1, srcDur); el.style.width = dur(c) * pps + 'px';
    }
  };
  el.addEventListener('pointermove', mv);
  el.addEventListener('pointerup', () => {
    el.removeEventListener('pointermove', mv); el.style.cursor = '';
    if (moved) { selLane = c.lane; commit(); } else renderLanes();
  }, { once: true });
});

$('#edWrap').addEventListener('pointerdown', e => {
  const c = clipById(selClip); if (!c || !edView) return;
  const wrap = e.currentTarget; try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  const tAt = ev => clamp(snapSrc(c.trackId, (ev.clientX - wrap.getBoundingClientRect().left) / edView.w * edView.D), 0, edView.D);
  const a0 = tAt(e); stopPreview();
  const mv = ev => { const b = tAt(ev); edSel = { a: Math.min(a0, b), b: Math.max(a0, b) }; drawEditor(); };
  wrap.addEventListener('pointermove', mv);
  wrap.addEventListener('pointerup', () => { wrap.removeEventListener('pointermove', mv); if (edSel && edSel.b - edSel.a < 0.05) edSel = null; drawEditor(); }, { once: true });
});

/* settings panel */
$('#insp').addEventListener('input', e => {
  const c = clipById(selClip), d = e.target.dataset, out = e.target.nextElementSibling, v = +e.target.value;
  if (d.pf === 'xfade') { P.xfade = v; out.textContent = v.toFixed(1) + 's'; return; }
  if (d.lx) {
    const l = P.lanes.find(x => x.id === selLane); if (!l) return; l.fx[d.lx] = v;
    out.textContent = d.lx === 'bass' || d.lx === 'treble' ? `${v > 0 ? '+' : ''}${v} dB` : d.lx === 'filter' ? (v === 0 ? 'off' : v < 0 ? 'muffle ' + -v : 'thin ' + v) : v + '%';
    liveLanes(); return;
  }
  if (!c || !d.cf) return;
  if (d.cf === 'gain') { c.gain = v / 100; out.textContent = v + '%'; }
  else if (d.cf === 'rate') { out.textContent = v + '%'; }
  else if (d.cf === 'semi') { out.textContent = (v > 0 ? '+' : '') + v; }
  else { c[d.cf] = v; fixFades(c); out.textContent = c[d.cf].toFixed(1) + 's'; const el = $(`.clip[data-clip="${c.id}"] canvas`); if (el) drawClipCanvas(el, c); }
});
$('#insp').addEventListener('change', async e => {
  const c = clipById(selClip), d = e.target.dataset;
  if (d.lx) { quietCommit(); renderLanes(); return; }
  if (d.pf === 'xfade') return commit();
  if (d.pf === 'bpm') { const v = parseFloat(e.target.value); P.bpm = v >= 40 && v <= 240 ? Math.round(v * 10) / 10 : null; commit(P.bpm ? `Mix tempo set to ${P.bpm} BPM` : 'Mix tempo cleared'); liveLanes(); return; }
  if (d.pf === 'key') { const [k, m] = e.target.value.split('|'); P.key = e.target.value ? { key: +k, mode: m } : null; return commit(P.key ? `Mix key set to ${keyName(P.key.key, P.key.mode)}` : 'Mix key cleared'); }
  if (d.pc) { P[d.pc] = e.target.checked; return commit(); }
  if (!c) return;
  if (d.cf === 'rate') return setRate(c, +e.target.value / 100, `Speed set to ${e.target.value}%`);
  if (d.cf === 'semi') { c.semi = +e.target.value; try { await ensureProc(c); } catch (err) { return toast(err.message, 5000); } return commit(); }
  if (d.cc === 'keepPitch') { c.keepPitch = e.target.checked; if (!c.keepPitch) c.semi = 0; try { await ensureProc(c); } catch (err) { return toast(err.message, 5000); } return commit(); }
  if (d.cs) { c[d.cs] = e.target.value; return commit(); }
  if (d.cf) commit();
});

document.addEventListener('keydown', e => {
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(null); return; }
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (k === ' ') { e.preventDefault(); acts.play(); }
  else if (k === 'Home') { e.preventDefault(); seek(0); }
  else if (k === 'Delete' || k === 'Backspace') { if (selClip) { e.preventDefault(); deleteClip(); } }
  else if (k === 's' || k === 'S') splitAtPlayhead();
  else if (k === '+' || k === '=') zoom(1.5);
  else if (k === '-' || k === '_') zoom(1 / 1.5);
  else if (k === 'Escape') { edSel = null; drawEditor(); }
});
window.addEventListener('resize', () => { renderLanes(); drawEditor(); });

/* ---------- dialogs ---------- */
let modalResolve = null; const mInput = $('#mInput');
function ask({ title, text = '', input = null, ok = 'OK', danger = false }) {
  return new Promise(res => {
    $('#mTitle').textContent = title; $('#mText').textContent = text; $('#mText').hidden = !text;
    mInput.hidden = input === null; mInput.value = input || '';
    $('#mOk').textContent = ok; $('#mOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    $('#modal').hidden = false; modalResolve = res;
    setTimeout(() => { if (input === null) $('#mOk').focus(); else { mInput.focus(); mInput.select(); } }, 0);
  });
}
function closeModal(v) { $('#modal').hidden = true; const r = modalResolve; modalResolve = null; if (r) r(v); }
$('#modalForm').addEventListener('submit', e => { e.preventDefault(); if (mInput.hidden) return closeModal(true); const v = mInput.value.trim(); if (!v) return mInput.focus(); closeModal(v); });
$('#mCancel').addEventListener('click', () => closeModal(null));
let toastT; function toast(m, ms = 2600) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }
let busyCancel = null;
function busy(m, opt = {}) {
  $('#busy').hidden = !m; if (!m) { busyCancel = null; return; }
  $('#busyText').textContent = m;
  $('#busyBar').hidden = opt.progress == null; if (opt.progress != null) $('#busyFill').style.width = Math.round(clamp(opt.progress, 0, 1) * 100) + '%';
  busyCancel = opt.onCancel || null; $('#busyCancel').hidden = !busyCancel;
}
$('#busyCancel').addEventListener('click', () => { if (busyCancel) busyCancel(); });

/* ---------- boot ---------- */
(async () => {
  try { db = await idbOpen(); } catch (e) { toast('This browser is blocking storage, so the Studio cannot read your songs.', 8000); }
  await loadLibrary(); renderLibrary();
  const missing = P.clips.filter(c => !libTrack(c.trackId));
  if (missing.length) { P.clips = P.clips.filter(c => libTrack(c.trackId)); last = JSON.stringify(P); persist(); toast(`${missing.length} part${missing.length === 1 ? ' was' : 's were'} removed because the song is no longer in your library.`, 5000); }
  renderAll();
  for (const id of new Set(P.clips.map(c => c.trackId))) { try { await ensureBuf(id); renderLanes(); drawEditor(); } catch (e) {} }
  for (const c of P.clips) { try { await ensureProc(c); } catch (e) {} }
  const add = new URLSearchParams(location.search).get('add');
  if (add && libTrack(add)) { history.replaceState(null, '', location.pathname); await addRegion(add, 0, null, 'append'); }
  if (P.clips.length) fitZoom();
})();
})();
