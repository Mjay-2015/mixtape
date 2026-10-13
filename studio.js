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
  if (!trackId) return Promise.resolve(null); // instrument (MIDI) parts have no audio
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
  if (c.kind === 'midi' || c.kind === 'pattern' || c.kind === 'riser') return Promise.resolve(null);
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
const PALETTE = ['#4F8EF7', '#F5A524', '#2EC4B6', '#E5649A', '#8B7CF6', '#7BC96F', '#F2734B', '#46B8E8'];
const NAME_COLORS = { Vocals: '#E5649A', Drums: '#F5A524', Bass: '#4F8EF7', 'Other instruments': '#2EC4B6', Voice: '#8B7CF6' };
const newLane = (n, color) => ({ id: uid(), name: typeof n === 'string' ? n : `Track ${n}`, gain: 1, pan: 0, mute: false, solo: false, fx: FX0(), auto: { show: null, vol: [], pan: [] }, chain: [], type: 'track', sends: {}, out: null,
  color: color || (typeof n === 'string' ? (NAME_COLORS[n] || PALETTE[4]) : PALETTE[(n - 1) % PALETTE.length]) });
const newProject = () => ({ name: 'My mix', lanes: [newLane(1)], clips: [], xfade: 0.5, bpm: null, key: null, snap: false, polish: false, loop: null, loopOn: false });
function normalize(p) {
  if (!p || !p.lanes || !p.lanes.length) return newProject();
  p.masterChain = Array.isArray(p.masterChain) ? p.masterChain : []; p.mastering = { preset: 'none', lufs: -14, ceiling: -1, gainDb: 0, ...(p.mastering || {}) };
  p.lanes.forEach((l, i) => { l.fx = { ...FX0(), ...(l.fx || {}) }; l.auto = { show: null, vol: [], pan: [], ...(l.auto || {}) };
    // one effect per track became a chain of effects; an older single effect moves into the chain
    if (!Array.isArray(l.chain)) l.chain = l.tfx && l.tfx.type && l.tfx.type !== 'none' ? [{ id: uid(), on: true, amt: 0.5, mix: 0.5, ...l.tfx }] : [];
    delete l.tfx; l.type = l.type || 'track'; l.sends = l.sends || {}; l.out = l.out || null; if (!l.color) l.color = NAME_COLORS[l.name] || PALETTE[i % PALETTE.length]; });
  p.clips.forEach(c => { if (c.rate == null) c.rate = 1; if (c.semi == null) c.semi = 0; if (c.keepPitch == null) c.keepPitch = true; c.fxIn = c.fxIn || 'fade'; c.fxOut = c.fxOut || 'fade'; });
  p.xfade = p.xfade ?? 0.5; p.snap = !!p.snap; p.polish = !!p.polish; p.bpm = p.bpm || null; p.key = p.key || null;
  p.loop = p.loop && p.loop.b > p.loop.a ? p.loop : null; p.loopOn = !!p.loopOn && !!p.loop;
  p.metro = !!p.metro; p.master = p.master ?? 1; p.limit = { on: false, ceiling: -1, ...(p.limit || {}) };
  p.tempoChanges = Array.isArray(p.tempoChanges) ? p.tempoChanges : [];
  p.link = p.link && Array.isArray(p.link.cues) ? p.link : null;
  p.video = p.video && p.video.id ? p.video : null; p.markers = Array.isArray(p.markers) ? p.markers : [];
  return p;
}
/* Projects: every mix is kept separately; the open one is remembered */
const LSP_INDEX = 'mixtape-studio-projects', LSP_CUR = 'mixtape-studio-current', LSP_ONE = id => 'mixtape-studio-project:' + id;
const loadIndex = () => { try { return JSON.parse(localStorage.getItem(LSP_INDEX)) || []; } catch (e) { return []; } };
const saveIndex = list => { try { localStorage.setItem(LSP_INDEX, JSON.stringify(list)); } catch (e) {} };
let P, projId = null;
{
  let list = loadIndex();
  if (!list.length) { // the mix from before projects existed becomes the first project
    let old = null; try { old = JSON.parse(localStorage.getItem(LSP)); } catch (e) {}
    const p = normalize(old), id = uid();
    try { localStorage.setItem(LSP_ONE(id), JSON.stringify(p)); localStorage.removeItem(LSP); } catch (e) {}
    list = [{ id, name: p.name || 'My mix', updated: Date.now() }]; saveIndex(list);
  }
  projId = localStorage.getItem(LSP_CUR); if (!list.some(x => x.id === projId)) projId = list[0].id;
  try { P = normalize(JSON.parse(localStorage.getItem(LSP_ONE(projId)))); } catch (e) { P = newProject(); }
  try { localStorage.setItem(LSP_CUR, projId); } catch (e) {}
}
let selClip = null, selLane = P.lanes[0].id, playhead = 0, pps = 24, edSel = null;
let hist = [], fut = [], last = JSON.stringify(P);
let savedT = null;
const persist = () => {
  try { localStorage.setItem(LSP_ONE(projId), last); const s = document.getElementById('savedLbl'); if (s) { s.textContent = 'Saved'; s.classList.add('on'); clearTimeout(savedT); savedT = setTimeout(() => s.classList.remove('on'), 1600); } }
  catch (e) { toast('This laptop’s browser storage is full, so the last change could not be saved.', 6000); }
  const list = loadIndex(), it = list.find(x => x.id === projId);
  if (it) { it.name = P.name || 'My mix'; it.updated = Date.now(); } else list.unshift({ id: projId, name: P.name || 'My mix', updated: Date.now() });
  saveIndex(list);
};
const UI_KEY = 'mixtape-studio-ui';
let UI = { lib: true, insp: true, h: 'm', mixer: false, bars: false, clock: 'time', vwin: true }; try { UI = { ...UI, ...(JSON.parse(localStorage.getItem(UI_KEY)) || {}) }; } catch (e) {}
const saveUI = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(UI)); } catch (e) {} };
let tlSel = null;      // a stretch selected right on the timeline: { clipId, a, b } in timeline seconds
let edOpen = false;    // the detailed part editor is open (double-click a part)
let clipboard = null;  // last copied part or stretch
const clipById = id => P.clips.find(c => c.id === id);
const laneColor = id => { const l = P.lanes.find(x => x.id === id); return (l && l.color) || PALETTE[0]; };
const withAlpha = (hex, a) => hex + Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');
const dur = c => (c.end - c.start) / (c.rate || 1);
const tlOf = (c, src) => c.at + (src - c.start) / (c.rate || 1);
const projectEnd = () => Math.max(P.clips.reduce((m, c) => Math.max(m, c.at + dur(c)), 0), P.video ? P.video.at + P.video.end - P.video.start : 0);
const laneClips = id => P.clips.filter(c => c.lane === id).sort((a, b) => a.at - b.at);
const laneLast = id => laneClips(id).reduce((m, c) => (!m || c.at + dur(c) > m.at + dur(m) ? c : m), null);
const beatLen = () => P.bpm ? 60 / P.bpm : 0;
/* ---------- tempo map: the mix tempo (P.bpm) from 0:00, plus tempo changes later in the cue ---------- */
function tempoSegs() {
  if (!P.bpm) return [];
  const g0 = P.beat0 || 0; // where bar 1 starts
  const ch = (P.tempoChanges || []).filter(x => x.t > g0 + 0.001 && x.bpm >= 20 && x.bpm <= 400).sort((a, b) => a.t - b.t);
  const segs = [{ t0: g0, bpm: P.bpm, b0: 0 }];
  for (const c of ch) { const s = segs[segs.length - 1]; segs.push({ t0: c.t, bpm: c.bpm, b0: s.b0 + (c.t - s.t0) * s.bpm / 60 }); }
  return segs;
}
function beatAt(t) { const S = tempoSegs(); if (!S.length) return 0; let s = S[0]; for (const x of S) if (x.t0 <= t) s = x; return s.b0 + (t - s.t0) * s.bpm / 60; }
function timeAtBeat(b) { const S = tempoSegs(); if (!S.length) return 0; let s = S[0]; for (const x of S) if (x.b0 <= b) s = x; return s.t0 + (b - s.b0) * 60 / s.bpm; }
function tempoAt(t) { const S = tempoSegs(); let s = S[0]; for (const x of S) if (x.t0 <= t) s = x; return s ? s.bpm : 0; }
const snapBeat = t => P.bpm ? timeAtBeat(Math.round(beatAt(t))) : t;
const effFo = c => c.fxOut === 'echo' && !(c.fadeOut > 0) ? Math.min(1, dur(c) / 3) : (c.fadeOut || 0);
function fixFades(c) { const d = dur(c); c.fadeIn = clamp(c.fadeIn || 0, 0, d); c.fadeOut = clamp(c.fadeOut || 0, 0, d - c.fadeIn); }
function fixSel() {
  if (tlSel && !clipById(tlSel.clipId)) tlSel = null;
  if (selClip && !clipById(selClip)) selClip = null;
  if (!P.lanes.some(l => l.id === selLane)) selLane = P.lanes[0] ? P.lanes[0].id : null;
}
// The mix takes its tempo and key from the first song in it that has them (songs analysed earlier included)
function adoptTempoKey() {
  for (const c of P.clips) { const a = ana[c.trackId]; if (!a) continue;
    if (!P.bpm && a.bpm) P.bpm = a.bpm;
    if (!P.key && a.key != null) P.key = { key: a.key, mode: a.mode };
    if (P.bpm && P.key) break; }
}
/* What a locked track holds: its parts and its automation. Volume, pan, mute and solo stay free for mixing. */
function lockedSig(p, ids) { return JSON.stringify(ids.map(id => { const l = p.lanes.find(x => x.id === id); return [id, !!l, l ? l.auto : null, p.clips.filter(c => c.lane === id).map(c => JSON.stringify(c)).sort()]; })); }
/* A pinned part is anchored to a moment of the picture (or of the timeline, with no picture) */
const pinAnchor = c => ({ id: c.id, vt: P.video ? c.at - P.video.at + P.video.start : null, at: c.at });
function holdPins(prev) {
  let snapped = 0;
  // a locked picture keeps its place and its trims, whatever tried to move it
  if (prev && prev.video && prev.video.locked && P.video && P.video.id === prev.video.id && ['at', 'start', 'end'].some(k => Math.abs((P.video[k] || 0) - (prev.video[k] || 0)) > 1e-6)) {
    P.video.at = prev.video.at; P.video.start = prev.video.start; P.video.end = prev.video.end; snapped = -1;
  }
  for (const c of P.clips) {
    if (!c.pin) continue;
    if (c.pin.id !== c.id) { c.pin = pinAnchor(c); continue; } // a piece cut or copied from a pinned part is pinned where it now sits
    if (P.video && c.pin.vt == null) c.pin = pinAnchor(c);
    const want = P.video && c.pin.vt != null ? P.video.at + (c.pin.vt - P.video.start) : c.pin.at;
    if (Math.abs(c.at - want) > 1e-6) { const moverWasPicture = prev && prev.video && P.video && Math.abs(prev.video.at - P.video.at) > 1e-6; c.at = Math.max(0, want); c.pin.at = c.at; if (!moverWasPicture && snapped >= 0) snapped++; }
  }
  return snapped;
}
function commit(msg) {
  adoptTempoKey();
  P.clips.forEach(c => { if (c.kind === 'pattern' || c.kind === 'riser') syncPattern(c); });
  P.clips.forEach(fixFades);
  { let prev = null; try { prev = JSON.parse(last); } catch (e) {}
    const s = holdPins(prev);
    if (s === -1) msg = 'The picture is locked, so it stayed where it was. Unlock it on the Picture track to move or trim it.';
    else if (s > 0) msg = `${s === 1 ? 'A pinned part' : `${s} pinned parts`} stayed on ${P.video ? 'the picture' : 'its spot'}. Unpin it (right-click) to move it.`; }
  // a change that touches a locked track is undone, whatever made it
  const lockedIds = P.lanes.filter(l => l.locked).map(l => l.id);
  if (lockedIds.length) {
    let prev = null; try { prev = JSON.parse(last); } catch (e) {}
    if (prev && lockedSig(prev, lockedIds) !== lockedSig(P, lockedIds)) {
      const names = P.lanes.filter(l => l.locked && lockedSig(prev, [l.id]) !== lockedSig(P, [l.id])).map(l => `“${l.name}”`).join(', ') || 'That track';
      P = normalize(prev); P.lanes.forEach(l => { if (lockedIds.includes(l.id)) l.locked = true; }); fixSel(); renderAll();
      return toast(`${names} is locked, so nothing on it was changed. Click its padlock to unlock it.`, 4500);
    }
  }
  const s = JSON.stringify(P); if (s === last) { renderAll(); if (msg) toast(msg); return; }
  hist.push(last); if (hist.length > 150) hist.shift(); fut = []; last = s; persist();
  fixSel(); renderAll(); restartIfPlaying(); if (msg) toast(msg);
  if (typeof scheduleHitPoints === 'function') scheduleHitPoints();
}
function undo() { if (!hist.length) return; fut.push(last); last = hist.pop(); P = normalize(JSON.parse(last)); fixSel(); persist(); renderAll(); restartIfPlaying(); toast('Undone'); }
function redo() { if (!fut.length) return; hist.push(last); last = fut.pop(); P = normalize(JSON.parse(last)); fixSel(); persist(); renderAll(); restartIfPlaying(); toast('Redone'); }
function ripple(laneId, from, shift, skip = []) {
  for (const c of P.clips) if (c.lane === laneId && !c.pin && !skip.includes(c.id) && c.at >= from - 1e-3) c.at = Math.max(0, c.at + shift);
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
  commit(mode === 'layer' ? 'Added on a new track' : xf ? `Joined with a ${xf.toFixed(1)}s fade` : 'Added to the track');
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
function splitClipAt(c, t) {
  if (!c || t <= c.at + 0.03 || t >= c.at + dur(c) - 0.03) return null;
  const srcT = c.start + (t - c.at) * (c.rate || 1);
  const c2 = { ...c, id: uid(), start: srcT, at: t, fadeIn: 0, fxIn: 'fade' };
  c.end = srcT; c.fadeOut = 0; c.fxOut = 'fade'; P.clips.push(c2); return c2;
}
function selSource() {
  const c = tlSel && clipById(tlSel.clipId); if (!c) return null;
  const r = c.rate || 1;
  return { c, a: c.start + (tlSel.a - c.at) * r, b: c.start + (tlSel.b - c.at) * r };
}
function removeStretch() {
  const s = selSource(); if (!s) return;
  selClip = s.c.id; edSel = { a: s.a, b: s.b }; tlSel = null; removeSel();
}
function keepStretch() {
  const s = selSource(); if (!s) return;
  s.c.at = tlSel.a; s.c.start = s.a; s.c.end = s.b; selClip = s.c.id; tlSel = null; commit('Kept only the selected stretch');
}
function splitHere() {
  if (!tlSel) return splitAtPlayhead();
  const c = clipById(tlSel.clipId); if (!c) return;
  splitClipAt(c, tlSel.b);
  const mid = splitClipAt(c, tlSel.a) || c;
  selClip = mid.id; tlSel = null; commit('Split. The selected stretch is now its own part.');
}
function repeatStretch() {
  if (!tlSel) return dupClip();
  const s = selSource(); if (!s) return;
  const len = tlSel.b - tlSel.a;
  splitClipAt(s.c, tlSel.b);
  ripple(s.c.lane, tlSel.b - 1e-3, len, [s.c.id]);
  P.clips.push({ ...s.c, id: uid(), start: s.a, end: s.b, at: tlSel.b, fadeIn: Math.min(0.01, len / 4), fadeOut: Math.min(0.01, len / 4), fxIn: 'fade', fxOut: 'fade' });
  tlSel = { clipId: tlSel.clipId, a: tlSel.b, b: tlSel.b + len };
  const copy = P.clips[P.clips.length - 1]; tlSel.clipId = copy.id; selClip = copy.id;
  commit('Repeated the stretch. Press Ctrl+D again to repeat it once more.');
}
function copySel() {
  const s = selSource();
  if (s) clipboard = { ...s.c, start: s.a, end: s.b };
  else { const c = clipById(selClip); if (!c) return; clipboard = { ...c }; }
  toast('Copied. Move the red playhead and press Ctrl+V to paste.');
}
function pasteAtPlayhead() {
  if (!clipboard || !libTrack(clipboard.trackId)) return toast('Copy a part or a stretch first (Ctrl+C).');
  const laneId = selLane && P.lanes.some(l => l.id === selLane) ? selLane : P.lanes[0].id;
  const c = { ...clipboard, id: uid(), lane: laneId, at: playhead, mute: false };
  P.clips.push(c); selClip = c.id; tlSel = null; commit(`Pasted at ${fmtT(playhead)}`);
}
function toggleMutePart() { const c = clipById(selClip); if (!c) return; c.mute = !c.mute; commit(c.mute ? 'Part muted' : 'Part unmuted'); }
const loopActive = () => !!(P.loopOn && P.loop && P.loop.b - P.loop.a > 0.2);
function setLoop(a, b, msg) { P.loop = { a: Math.max(0, Math.min(a, b)), b: Math.max(a, b) }; P.loopOn = true; quietCommit(); renderLoop(); renderTransport(); renderRuler(); if (msg) toast(msg); }
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
/* Nothing you trim is lost: the whole song is still there behind the part, in the same place in time */
function restoreWhole(c) {
  const e = bufs.get(c.trackId); if (!e) return;
  const r = c.rate || 1, songStartAt = c.at - c.start / r;
  c.start = 0; c.end = e.buffer.duration; c.at = Math.max(0, songStartAt);
  if (songStartAt < 0) c.start = -songStartAt * r;
  commit('The whole song is back on this part. Ctrl + Z undoes it.');
}
function togglePin(c) {
  if (c.pin) { delete c.pin; commit('Unpinned: the part moves freely again.'); }
  else { c.pin = pinAnchor(c); commit(P.video ? `Pinned at ${tc(c.pin.vt)} on the picture. Cuts, gap-closing and repeats around it leave it there, and it moves with the picture.` : 'Pinned: edits around it leave it where it is.'); }
}
$('#insp').addEventListener('click', e => {
  const dvb = e.target.closest('[data-dv]');
  if (dvb) {
    const box = dvb.closest('[data-dev]'), hit = box && findDev(box.dataset.dev); if (!hit) return; const { l, d } = hit, ch = l.chain, i = ch.indexOf(d), a = dvb.dataset.dv;
    if (a === 'on') { d.on = !d.on; commit(`${FX_TYPES[d.type]} ${d.on ? 'on' : 'bypassed'}`); }
    else if (a === 'up' && i > 0) { ch.splice(i - 1, 0, ch.splice(i, 1)[0]); commit(); }
    else if (a === 'down' && i < ch.length - 1) { ch.splice(i + 1, 0, ch.splice(i, 1)[0]); commit(); }
    else if (a === 'del') { l.chain = ch.filter(x => x !== d); commit(`${FX_TYPES[d.type]} removed`); }
    renderInspector(); return;
  }
});
function addGroup() {
  const n = P.lanes.filter(x => x.type === 'group').length + 1, g = newLane(`Group ${n}`, '#9AA4B2'); g.type = 'group';
  const sel = P.lanes.find(x => x.id === selLane && x.type === 'track'); if (sel) sel.out = g.id;
  P.lanes.push(g); selLane = g.id;
  commit(sel ? `Group added, and “${sel.name}” now plays through it. On other tracks, choose Output → ${g.name}.` : `Group added. On each track you want in it, choose Output → ${g.name}.`);
}
function addReturn(type) {
  if (type !== 'hall' && !HAS_TONE) type = 'hall';
  const r = newLane(type === 'hall' ? 'Reverb return' : 'Delay return', '#6FA8DC'); r.type = 'return';
  const d = newDevice(type); d.mix = 1; d.amt = type === 'hall' ? 0.6 : 0.45; r.chain = [d];
  P.lanes.push(r); selLane = r.id;
  commit(`${r.name} added. Raise the “Send” slider on any track to send some of it here.`);
}
function closeGaps(laneId) {
  let t = 0; for (const c of laneClips(laneId)) { if (c.at > t && !c.pin) c.at = t; t = Math.max(t, c.at + dur(c)); }
  commit('Gaps closed');
}
async function deleteLane(id) {
  const l = P.lanes.find(x => x.id === id); if (!l) return;
  if (l.locked) return toast(`“${l.name}” is locked. Unlock it first to delete it.`, 3500);
  const n = P.clips.filter(c => c.lane === id).length;
  if (n && !(await ask({ title: `Delete “${l.name}”?`, text: `Its ${n} part${n === 1 ? '' : 's'} go too. You can undo this.`, ok: 'Delete track', danger: true }))) return;
  P.lanes = P.lanes.filter(x => x !== l); P.clips = P.clips.filter(c => c.lane !== id);
  if (!P.lanes.length) P.lanes.push(newLane(1));
  commit('Track deleted');
}

/* speed, key, beat */
function nearestRate(songBpm, atTime = 0) {
  if (!P.bpm || !songBpm) return 1;
  const target = tempoAt(atTime);
  return [0.5, 1, 2].map(m => target / (songBpm * m)).reduce((b, r) => Math.abs(Math.log(r)) < Math.abs(Math.log(b)) ? r : b);
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
  const tgt = tempoAt(c.at); return setRate(c, nearestRate(a.bpm, c.at), `Now plays at ${Math.round(tgt * 10) / 10} BPM`);
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
let hall = null;
function getHall(ac) {
  if (hall && hall.sampleRate === ac.sampleRate) return hall;
  const len = Math.floor(ac.sampleRate * 5.5), b = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < len; i++) { lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; d[i] = lp * Math.pow(1 - i / len, 2.2) * (i < ac.sampleRate * 0.02 ? i / (ac.sampleRate * 0.02) : 1); } }
  return (hall = b);
}
const laneHasFx = t => [...P.lanes.map(l => l.chain || []), P.masterChain || []].some(ch => ch.some(d => d.on && d.type === t));
const hasHall = () => laneHasFx('hall');
const echoTime = () => P.bpm ? clamp(0.75 * 60 / P.bpm, 0.08, 1.5) : 0.36;
function setFilter(node, v) {
  if (v < 0) { node.type = 'lowpass'; node.frequency.value = 20000 * Math.pow(2, v / 100 * 9.4); node.Q.value = 0.9; }
  else if (v > 0) { node.type = 'highpass'; node.frequency.value = 20 * Math.pow(2, v / 100 * 9.4); node.Q.value = 0.9; }
  else { node.type = 'lowpass'; node.frequency.value = 22000; node.Q.value = 0.0001; }
}
function laneAudible(l) {
  if (l.mute) return false;
  if (!P.lanes.some(x => x.solo) || l.solo) return true;
  if (l.type === 'return') return true; // shared effects keep sounding for whatever is soloed
  if (l.type === 'group' && P.lanes.some(x => x.out === l.id && x.solo)) return true;
  const g = l.out && P.lanes.find(x => x.id === l.out); return !!(g && g.solo);
}
function buildLane(ac, l, master, force) {
  const g = ac.createGain(); g.gain.value = force || laneAudible(l) ? l.gain : 0;
  const ag = ac.createGain(); // automation rides on top of the fader
  const pg = ac.createGain(); // sidechain pump from the drum machine's kick
  const bass = ac.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 150; bass.gain.value = l.fx.bass;
  const treble = ac.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 5000; treble.gain.value = l.fx.treble;
  const filt = ac.createBiquadFilter(); setFilter(filt, l.fx.filter);
  const pan = ac.createStereoPanner(); pan.pan.value = l.pan;
  g.connect(ag); ag.connect(pg); pg.connect(bass); bass.connect(treble); treble.connect(filt);
  // the effect chain, in order; switched-off effects are skipped
  let node = filt; const devs = {}, toneFx = [];
  for (const dev of (l.chain || [])) {
    if (!dev.on) continue; let d; try { d = buildDevice(ac, dev); } catch (e) { continue; }
    link(node, d.in); node = d.out; devs[dev.id] = d; if (d.tone) toneFx.push(d.tone);
  }
  link(node, pan);
  const echoSend = ac.createGain(); echoSend.gain.value = l.fx.echo / 100;
  const delay = ac.createDelay(2); delay.delayTime.value = echoTime();
  const fb = ac.createGain(); fb.gain.value = 0.42; const dl = ac.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 3500;
  filt.connect(echoSend); echoSend.connect(delay); delay.connect(dl); dl.connect(fb); fb.connect(delay); dl.connect(pan);
  const revSend = ac.createGain(); revSend.gain.value = l.fx.reverb / 100 * 0.8;
  const conv = ac.createConvolver(); conv.buffer = getImpulse(ac);
  filt.connect(revSend); revSend.connect(conv); conv.connect(pan);
  // where the lane's sound goes (the master, or a group) is wired up in buildGraph, once every lane exists
  const meter = ac.createAnalyser(); meter.fftSize = 2048; pan.connect(meter); keepAlive(ac, meter);
  return { g, ag, pg, bass, treble, filt, pan, echoSend, delay, revSend, meter, devs, toneFx };
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
/* ---------- automation: volume and pan that change over time, per track ---------- */
const AUTO = { vol: { name: 'Volume', min: 0, max: 1.5, def: 1 }, pan: { name: 'Pan', min: -1, max: 1, def: 0 } };
function autoValue(pts, t, def) {
  if (!pts.length) return def;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return b.t - a.t < 1e-6 ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t); }
  return pts[pts.length - 1].v;
}
function scheduleAuto(param, pts, startPos, when0, def) {
  pts = [...pts].sort((a, b) => a.t - b.t);
  param.setValueAtTime(autoValue(pts, startPos, def), when0);
  for (const p of pts) if (p.t > startPos) param.linearRampToValueAtTime(p.v, when0 + p.t - startPos);
}
const autoLabel = (kind, v) => kind === 'vol' ? (v <= 0.001 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`) : (Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
function drawAuto(laneEl, l, readout) {
  const body = laneEl.querySelector('.lane-body'); body.querySelector('svg.auto')?.remove();
  const kind = l.auto.show; if (!kind || l.folded) return;
  const A = AUTO[kind], pts = [...l.auto[kind]].sort((a, b) => a.t - b.t), w = body.clientWidth, h = body.clientHeight, pad = 8;
  const y = v => pad + (1 - (v - A.min) / (A.max - A.min)) * (h - 2 * pad);
  const flat = kind === 'pan' ? l.pan : A.def;
  const line = pts.length ? [[0, pts[0].v], ...pts.map(p => [p.t * pps, p.v]), [w, pts[pts.length - 1].v]] : [[0, flat], [w, flat]];
  const ref = kind === 'vol' ? 1 : 0;
  body.insertAdjacentHTML('beforeend', `<svg class="auto" data-kind="${kind}" width="${w}" height="${h}" role="img" aria-label="${A.name} automation. Click to add a point, drag to move it, double-click to remove it.">
    <line class="unity" x1="0" x2="${w}" y1="${y(ref)}" y2="${y(ref)}"/>
    <polyline points="${line.map(([x, v]) => `${x.toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>
    ${pts.map(p => `<circle data-pt="${p.id}" cx="${(p.t * pps).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="5"><title>${fmtT(p.t)} · ${autoLabel(kind, p.v)}</title></circle>`).join('')}
    ${readout ? `<text class="aread" x="${readout.t * pps + 9}" y="14">${fmtT(readout.t)} · ${autoLabel(kind, readout.v)}</text>` : ''}</svg>`);
}
function autoPointer(e, svg, l) {
  const kind = svg.dataset.kind, A = AUTO[kind], r = svg.getBoundingClientRect(), h = r.height, pad = 8, laneEl = svg.closest('.lane');
  const tAt = ev => clamp((ev.clientX - r.left) / pps, 0, 36000);
  const vAt = ev => clamp(A.min + (1 - (ev.clientY - r.top - pad) / (h - 2 * pad)) * (A.max - A.min), A.min, A.max);
  const snapV = v => kind === 'vol' && Math.abs(v - 1) < 0.03 ? 1 : kind === 'pan' && Math.abs(v) < 0.03 ? 0 : v;
  let pt = l.auto[kind].find(p => p.id === e.target.dataset?.pt);
  if (e.detail >= 2 && pt) { l.auto[kind] = l.auto[kind].filter(p => p !== pt); commit('Point removed'); return; }
  if (!pt) { pt = { id: uid(), t: tAt(e), v: snapV(vAt(e)) }; if (P.snap && beatLen()) pt.t = snapBeat(pt.t); l.auto[kind].push(pt); }
  const others = l.auto[kind].filter(p => p !== pt).sort((a, b) => a.t - b.t);
  const lo = (others.filter(p => p.t <= pt.t).pop() || { t: 0 }).t, hi = (others.find(p => p.t > pt.t) || { t: 36000 }).t;
  drawAuto(laneEl, l, pt);
  const mv = ev => { let t = tAt(ev); if (P.snap && beatLen()) t = snapBeat(t); pt.t = clamp(t, lo, hi); pt.v = snapV(vAt(ev)); drawAuto(laneEl, l, pt); };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); commit(); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
function autoMenu(btn, l) {
  const others = P.lanes.filter(x => x !== l);
  const items = [...others.map(x => ({ label: `Duck under “${x.name}”`, act: () => duckUnder(l, x) })),
    { label: `Clear ${AUTO[l.auto.show || 'vol'].name.toLowerCase()} automation`, act: () => { l.auto[l.auto.show || 'vol'] = []; commit('Automation cleared'); } }];
  const r = btn.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, items);
}
/* Duck under: dip this track wherever another track (usually dialogue) is sounding */
async function duckUnder(l, key, depthDb = -10) {
  if (!P.clips.some(c => c.lane === key.id && !c.mute)) return toast(`“${key.name}” has nothing on it to duck under.`);
  busy(`Listening to “${key.name}”…`);
  try {
    const { buffer } = await renderMix({ lane: key.id, from: 0, to: projectEnd() });
    const win = Math.round(buffer.sampleRate * 0.05), chs = [...Array(buffer.numberOfChannels)].map((_, i) => buffer.getChannelData(i));
    const on = [];
    for (let s = 0; s + win <= buffer.length; s += win) { let e = 0; for (const d of chs) for (let i = s; i < s + win; i++) e += d[i] * d[i]; on.push(10 * Math.log10(e / (win * chs.length) + 1e-12) > -40); }
    const spans = []; let a = null;
    on.forEach((x, i) => { const t = i * 0.05; if (x && a === null) a = t; if (!x && a !== null) { spans.push([a, t]); a = null; } });
    if (a !== null) spans.push([a, on.length * 0.05]);
    const merged = []; for (const sp of spans) { const m = merged[merged.length - 1]; if (m && sp[0] - m[1] < 0.5) m[1] = sp[1]; else merged.push([...sp]); }
    const kept = merged.filter(([x, y]) => y - x >= 0.15);
    if (!kept.length) return toast(`“${key.name}” is too quiet to duck under.`);
    const dip = Math.pow(10, depthDb / 20), pts = [];
    for (const [x, y] of kept) pts.push({ id: uid(), t: Math.max(0, x - 0.15), v: 1 }, { id: uid(), t: x, v: dip }, { id: uid(), t: y, v: dip }, { id: uid(), t: y + 0.4, v: 1 });
    for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[i - 1].t + 0.01) pts[i].t = pts[i - 1].t + 0.01;
    l.auto.vol = pts; l.auto.show = 'vol';
    commit(`“${l.name}” now dips ${-depthDb} dB under “${key.name}” in ${kept.length} place${kept.length === 1 ? '' : 's'}.`);
  } finally { busy(null); }
}
/* ---------- Tone.js (MIT, vendor/tone): drum machine voices, extra synths and track effects ----------
   Tone runs on Studio's own AudioContext (and on each OfflineAudioContext when saving), and Studio does the timing:
   every note is triggered at an exact time we work out from the tempo map, so the two never drift apart. */
const HAS_TONE = typeof Tone !== 'undefined';
const toneCtxs = new WeakMap();
function toneFor(ac) {
  if (!HAS_TONE) return null;
  let t = toneCtxs.get(ac); if (t) return t;
  t = new Tone.Context({ context: ac, clockSource: ac === ctx ? 'timeout' : 'offline', lookAhead: 0 });
  toneCtxs.set(ac, t); return t;
}
const tconnect = (src, dst) => Tone.connect(src, dst);
/* ---- drum kits, built from synthesis only (no recordings, so nothing to license) ---- */
const DRUM_ROWS = [['kick', 'Kick'], ['snare', 'Snare'], ['clap', 'Clap'], ['chh', 'Closed hat'], ['ohh', 'Open hat'], ['tom', 'Tom'], ['rim', 'Rim'], ['cow', 'Cowbell']];
const KITS = { '909': '909-style', '808': '808-style' };
function makeKit(tctx, kit, dest) {
  const o = { context: tctx }, nodes = [], is808 = kit === '808';
  const out = new Tone.Gain({ ...o, gain: 0.5 }); nodes.push(out); tconnect(out, dest); // headroom: a kit at full level clips once other tracks join it
  const add = n => { nodes.push(n); return n; };
  const kick = add(new Tone.MembraneSynth({ ...o, pitchDecay: is808 ? 0.07 : 0.035, octaves: is808 ? 5 : 4, oscillator: { type: 'sine' }, envelope: { attack: 0.001, decay: is808 ? 0.9 : 0.38, sustain: 0.01, release: is808 ? 0.6 : 0.12 }, volume: is808 ? -1 : 0 })); kick.connect(out);
  const kclickF = add(new Tone.Filter({ ...o, type: 'highpass', frequency: 2500 })); kclickF.connect(out);
  const kclick = add(new Tone.NoiseSynth({ ...o, noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.008, sustain: 0 }, volume: is808 ? -40 : -14 })); kclick.connect(kclickF);
  const snT = add(new Tone.MembraneSynth({ ...o, pitchDecay: 0.01, octaves: 1.5, envelope: { attack: 0.001, decay: is808 ? 0.14 : 0.1, sustain: 0 }, volume: is808 ? -6 : -10 })); snT.connect(out);
  const snF = add(new Tone.Filter({ ...o, type: 'bandpass', frequency: is808 ? 2600 : 3200, Q: 0.7 })); snF.connect(out);
  const snN = add(new Tone.NoiseSynth({ ...o, noise: { type: 'white' }, envelope: { attack: 0.001, decay: is808 ? 0.16 : 0.22, sustain: 0 }, volume: is808 ? -8 : -4 })); snN.connect(snF);
  const clF = add(new Tone.Filter({ ...o, type: 'bandpass', frequency: 1150, Q: 1.6 })); clF.connect(out);
  const clN = add(new Tone.NoiseSynth({ ...o, noise: { type: 'pink' }, envelope: { attack: 0.001, decay: 0.012, sustain: 0 }, volume: 2 })); clN.connect(clF);
  const clT = add(new Tone.NoiseSynth({ ...o, noise: { type: 'pink' }, envelope: { attack: 0.002, decay: 0.2, sustain: 0 }, volume: 0 })); clT.connect(clF);
  const chF = add(new Tone.Filter({ ...o, type: 'highpass', frequency: is808 ? 7500 : 8800 })); chF.connect(out);
  const ch = add(new Tone.NoiseSynth({ ...o, noise: { type: 'white' }, envelope: { attack: 0.001, decay: is808 ? 0.035 : 0.05, sustain: 0 }, volume: -10 })); ch.connect(chF);
  const ohF = add(new Tone.Filter({ ...o, type: 'highpass', frequency: is808 ? 7000 : 8000 })); ohF.connect(out);
  const oh = add(new Tone.NoiseSynth({ ...o, noise: { type: 'white' }, envelope: { attack: 0.001, decay: is808 ? 0.3 : 0.38, sustain: 0 }, volume: -12 })); oh.connect(ohF);
  const tom = add(new Tone.MembraneSynth({ ...o, pitchDecay: 0.05, octaves: 2, envelope: { attack: 0.001, decay: 0.42, sustain: 0 }, volume: -4 })); tom.connect(out);
  const rimF = add(new Tone.Filter({ ...o, type: 'highpass', frequency: 1200 })); rimF.connect(out);
  const rim = add(new Tone.MembraneSynth({ ...o, pitchDecay: 0.004, octaves: 1, envelope: { attack: 0.001, decay: 0.035, sustain: 0 }, volume: -6 })); rim.connect(rimF);
  const cowF = add(new Tone.Filter({ ...o, type: 'bandpass', frequency: 800, Q: 2 })); cowF.connect(out);
  const cow1 = add(new Tone.Synth({ ...o, oscillator: { type: 'square' }, envelope: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.05 }, volume: -16 })); cow1.connect(cowF);
  const cow2 = add(new Tone.Synth({ ...o, oscillator: { type: 'square' }, envelope: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.05 }, volume: -16 })); cow2.connect(cowF);
  const safe = f => { try { f(); } catch (e) {} };
  return {
    nodes,
    hit(row, t, v) {
      const vel = clamp(v / 127, 0.05, 1);
      if (row === 'kick') { safe(() => kick.triggerAttackRelease(is808 ? 'G1' : 'A1', 0.3, t, vel)); safe(() => kclick.triggerAttackRelease(0.01, t, vel)); }
      else if (row === 'snare') { safe(() => snT.triggerAttackRelease(is808 ? 'E3' : 'D3', 0.08, t, vel)); safe(() => snN.triggerAttackRelease(0.1, t, vel)); }
      else if (row === 'clap') { [0, 0.011, 0.022].forEach(d => safe(() => clN.triggerAttackRelease(0.008, t + d, vel))); safe(() => clT.triggerAttackRelease(0.1, t + 0.03, vel)); }
      else if (row === 'chh') safe(() => ch.triggerAttackRelease(0.02, t, vel));
      else if (row === 'ohh') safe(() => oh.triggerAttackRelease(0.2, t, vel));
      else if (row === 'tom') safe(() => tom.triggerAttackRelease('A2', 0.2, t, vel));
      else if (row === 'rim') safe(() => rim.triggerAttackRelease('E5', 0.02, t, vel));
      else if (row === 'cow') { safe(() => cow1.triggerAttackRelease(540, 0.12, t, vel)); safe(() => cow2.triggerAttackRelease(800, 0.12, t, vel)); }
    },
  };
}
/* ---- extra synths for instrument parts ---- */
const TONE_INSTS = { bass808: '808 bass (glide)', acid: 'Acid bass', supersaw: 'Supersaw lead', housepad: 'House pad', fmkeys: 'FM keys', plucky: 'Pluck synth', sub: 'Sub bass' };
const hzOf = p => 440 * Math.pow(2, (p - 69) / 12);
const TONE_PROGRAM = { bass808: 38, acid: 38, supersaw: 81, housepad: 89, fmkeys: 4, plucky: 25, sub: 38 };
if (HAS_TONE) { Object.assign(MixtapeMIDI.INSTRUMENTS, TONE_INSTS); Object.assign(MixtapeMIDI.PROGRAM, TONE_PROGRAM); }
/* ---------- the orchestra: recorded instruments from VSCO 2 Community Edition (CC0), in orch/ ----------
   Each instrument downloads the first time it is used and is then kept for offline use. */
let ORCH = null; // orch/index.json
const ARTS = { sus: 'Sustained (long notes)', short: 'Short (staccato / spiccato)', pizz: 'Plucked (pizzicato)', pluck: 'Plucked', hit: 'Struck' };
// whole sections: each note goes to the instrument whose range it sits in
const SECTIONS = {
  o_strings: { name: 'Strings (whole section)', parts: [['bass', 43], ['cellos', 55], ['violas', 64], ['violins', 999]] },
  o_brass: { name: 'Brass (whole section)', parts: [['tuba', 41], ['trombone', 55], ['horn', 65], ['trumpet', 999]] },
  o_winds: { name: 'Woodwinds (whole section)', parts: [['bassoon', 55], ['clarinet', 65], ['oboe', 74], ['flute', 999]] },
};
const ORCH_PROGRAM = { violins: 48, violas: 48, cellos: 48, bass: 43, harp: 46, horn: 60, trumpet: 56, trombone: 57, tuba: 58, flute: 73, oboe: 68, clarinet: 71, bassoon: 70, timpani: 47, glock: 9, o_strings: 48, o_brass: 61, o_winds: 73 };
const isOrch = inst => !!(inst && (inst.startsWith('o_') && (SECTIONS[inst] || (ORCH && ORCH.instruments[inst.slice(2)]))));
const orchParts = inst => SECTIONS[inst] ? SECTIONS[inst].parts.map(p => p[0]) : [inst.slice(2)];
function orchArts(inst) { const a = new Set(); for (const p of orchParts(inst)) Object.keys((ORCH && ORCH.instruments[p] && ORCH.instruments[p].arts) || {}).forEach(k => a.add(k)); return [...a]; }
const orchArtOf = c => { const arts = orchArts(c.inst); return arts.includes(c.art) ? c.art : arts[0]; };
fetch('orch/index.json').then(r => r.ok ? r.json() : null).then(j => {
  if (!j || !j.instruments) return; ORCH = j;
  for (const [k, v] of Object.entries(j.instruments)) { MixtapeMIDI.INSTRUMENTS['o_' + k] = `${v.name} · orchestra`; MixtapeMIDI.PROGRAM['o_' + k] = ORCH_PROGRAM[k] ?? 48; }
  for (const [k, v] of Object.entries(SECTIONS)) { MixtapeMIDI.INSTRUMENTS[k] = `${v.name} · orchestra`; MixtapeMIDI.PROGRAM[k] = ORCH_PROGRAM[k]; }
  renderInspector();
}).catch(() => {});
const orchBufs = new Map(), orchLoading = new Map();
async function loadOrchSet(part, art) {
  const key = `${part}/${art}`; if (orchBufs.has(key)) return orchBufs.get(key); if (orchLoading.has(key)) return orchLoading.get(key);
  const a = ORCH && ORCH.instruments[part] && ORCH.instruments[part].arts[art]; if (!a) return null;
  const p = (async () => {
    busy(`Loading the ${ORCH.instruments[part].name.toLowerCase()} (${(ARTS[art] || art).toLowerCase()})…`);
    try {
      const set = { kind: a.kind, notes: {} };
      for (const [midi, path] of Object.entries(a.notes)) { const r = await fetch('orch/' + path); if (!r.ok) throw new Error(`missing ${path}`); set.notes[midi] = await ctx.decodeAudioData(await r.arrayBuffer()); }
      orchBufs.set(key, set); return set;
    } finally { busy(null); orchLoading.delete(key); }
  })();
  orchLoading.set(key, p); return p;
}
async function ensureOrch(c) {
  if (!isOrch(c.inst)) return; const art = orchArtOf(c);
  for (const part of orchParts(c.inst)) { const arts = Object.keys(ORCH.instruments[part].arts); await loadOrchSet(part, arts.includes(art) ? art : arts[0]); }
}
/* A sampler per instrument in the part, made on whichever context is playing or saving */
function makeOrch(tctx, c, dest) {
  const art = orchArtOf(c), nodes = [], players = [];
  for (const [i, part] of orchParts(c.inst).entries()) {
    const arts = Object.keys(ORCH.instruments[part].arts), a = arts.includes(art) ? art : arts[0], set = orchBufs.get(`${part}/${a}`); if (!set) continue;
    const urls = {}; for (const [m, b] of Object.entries(set.notes)) urls[+m] = b;
    const s = new Tone.Sampler({ context: tctx, urls, attack: set.kind === 'sustain' ? 0.04 : 0, release: set.kind === 'sustain' ? 0.6 : 0.4, volume: -3 });
    tconnect(s, dest); nodes.push(s);
    const top = SECTIONS[c.inst] ? SECTIONS[c.inst].parts[i][1] : 999;
    players.push({ top, s, ring: set.kind === 'sustain' ? 0 : set.kind === 'short' ? 1.4 : 2.8 });
  }
  const pick = p => players.find(x => p < x.top) || players[players.length - 1];
  return { nodes, play(p, t, d, vel) { const x = pick(p); if (!x) return; try { x.s.triggerAttackRelease(440 * Math.pow(2, (p - 69) / 12), Math.max(d, x.ring, 0.05), t, clamp(vel / 127, 0.05, 1)); } catch (e) {} },
    on(p, t, vel) { const x = pick(p); if (x) try { x.s.triggerAttack(hzOf(p), t, clamp(vel / 127, 0.05, 1)); } catch (e) {} },
    off(p, t) { const x = pick(p); if (x && !x.ring) try { x.s.triggerRelease(hzOf(p), t); } catch (e) {} } }; // short and plucked notes ring out by themselves
}
/* ---------- recorded instruments: the Salamander grand piano (CC-BY 3.0, Alexander Holm) and the
   GeneralUser GS bank (S. Christian Collins), every General MIDI sound and 13 drum kits ----------
   An instrument downloads the first time a part uses it, and is then kept for offline use. */
const SAMP = {};
const isSamp = inst => !!(inst && inst.startsWith('s_') && SAMP[inst.slice(2)]);
const isKit = inst => inst === 'drums' || (isSamp(inst) && SAMP[inst.slice(2)].kind === 'drums');
const sampName = k => k === 'piano' ? 'Grand piano · recorded' : SAMP[k].kind === 'drums' ? `${SAMP[k].name} drum kit · recorded` : `${SAMP[k].name} · recorded`;
const takeOf = (p, t) => { const x = Math.sin(p * 12.9898 + t * 78.233) * 43758.5453; return x - Math.floor(x); }; // which of several recorded takes plays: varies note to note, the same on every render
for (const url of ['piano/index.json', 'gm/index.json', 'drums/index.json']) fetch(url).then(r => r.ok ? r.json() : null).then(j => {
  if (!j || !j.instruments) return;
  for (const [k, v] of Object.entries(j.instruments)) {
    SAMP[k] = { ...v, credit: v.credit || j.credit }; MixtapeMIDI.INSTRUMENTS['s_' + k] = sampName(k); MixtapeMIDI.PROGRAM['s_' + k] = k === 'piano' ? 0 : v.program;
    if (v.kind === 'drums') KITS['s:' + k] = `${v.name} (recorded)`;
  }
  renderInspector();
}).catch(() => {});
const sampBufs = new Map(), sampLoading = new Map();
const sampReady = id => !!SAMP[id] && SAMP[id].zones.every(z => sampBufs.has(SAMP[id].dir + z.file));
function loadSamp(id) {
  const def = SAMP[id]; if (!def) return Promise.resolve();
  if (sampLoading.has(id)) return sampLoading.get(id);
  const files = [...new Set(def.zones.map(z => def.dir + z.file))].filter(f => !sampBufs.has(f)); if (!files.length) return Promise.resolve();
  const p = (async () => {
    busy(`Loading the ${id === 'piano' ? 'grand piano' : def.name.toLowerCase()}…`);
    try { let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < files.length) { const f = files[i++]; const r = await fetch(f); if (!r.ok) throw new Error(`missing ${f}`); sampBufs.set(f, await ctx.decodeAudioData(await r.arrayBuffer())); } })); }
    finally { busy(null); sampLoading.delete(id); }
  })();
  sampLoading.set(id, p); return p;
}
const ensureSamp = c => c && isSamp(c.inst) ? loadSamp(c.inst.slice(2)) : Promise.resolve();
// a MIDI file's instrument, played by the matching recorded General MIDI sound when there is one
function gmFor(tr) {
  if (!SAMP.gm0) return tr.inst;
  if (tr.channel === 9) return 's_kit0';
  if (tr.program == null || tr.program <= 1) return SAMP.piano ? 's_piano' : 's_gm0';
  return SAMP['gm' + tr.program] ? 's_gm' + tr.program : tr.inst;
}
// SoundFont modulator curves, so harder playing is louder and brighter the way the bank intends
const conc = x => x <= 0 ? 0 : x >= 1 ? 1 : Math.min(1, -20 / 96 * Math.log10((1 - x) ** 2));
const sCurve = (x, type) => { x = clamp(x, 0, 1); return type === 1 ? conc(x) : type === 2 ? 1 - conc(1 - x) : type === 3 ? (x >= 0.5 ? 1 : 0) : x; };
function zoneMods(z, p, vel) {
  let att = 0, fc = 0, mfc = 0;
  for (const [dst, src, flip, bip, curve, amt] of (z.mods || [])) {
    let x = src === 2 ? vel / 127 : p / 127; if (flip) x = 1 - x; let y = sCurve(x, curve); if (bip) y = 2 * y - 1;
    if (dst === 48) att += amt * y; else if (dst === 8) fc += amt * y; else if (dst === 11) mfc += amt * y;
  }
  return { att, fc, mfc };
}
function makeSampled(ac, id, dest) {
  const def = SAMP[id], drums = def.kind === 'drums', held = new Map(), excl = new Map();
  const out = ac.createGain(); out.gain.value = def.gain ?? (id === 'piano' ? 0.8 : 1); out.connect(dest);
  const hz = c => clamp(8.176 * Math.pow(2, c / 1200), 20, Math.min(20000, ac.sampleRate / 2 - 100));
  function voice(z, p, t, vel) {
    const buf = sampBufs.get(def.dir + z.file); if (!buf) return null;
    const m = zoneMods(z, p, vel), env = z.env || [0.002, 0, 0, 1, def.release || 0.3], [a, h, d, s, r] = env;
    const src = ac.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = Math.pow(2, ((p - z.root) * (z.track ?? 1) * 100 + (z.tune || 0)) / 1200);
    if (z.loop) { src.loop = true; src.loopStart = z.loop[0]; src.loopEnd = z.loop[1]; }
    let peak = Math.pow(10, -((z.att || 0) + m.att / 10) / 20);
    if (!z.mods) peak *= Math.pow(clamp(vel / 127, 0.01, 1), 2 * (z.vt ?? def.veltrack ?? 0.73));
    let node = src, f = null;
    if (z.fcc != null) {
      f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = z.q || 0; src.connect(f); node = f;
      const base = z.fcc + m.fc, top = base + (z.mfc || 0) + m.mfc;
      if (z.menv && Math.abs(top - base) > 1) { // the filter envelope: brighter at the attack, mellowing as the note rings
        const [md, ma, mh, mdc, ms] = z.menv, sus = base + (top - base) * ms;
        f.frequency.setValueAtTime(hz(base), t); f.frequency.setValueAtTime(hz(base), t + md); f.frequency.linearRampToValueAtTime(hz(top), t + md + ma);
        f.frequency.setValueAtTime(hz(top), t + md + ma + mh); f.frequency.setTargetAtTime(hz(sus), t + md + ma + mh, Math.max(0.001, mdc) / 5);
      } else f.frequency.value = hz(base);
    }
    const g = ac.createGain(); node.connect(g);
    if (z.pan) { const pn = ac.createStereoPanner(); pn.pan.value = z.pan; g.connect(pn); pn.connect(out); } else g.connect(out);
    const t0 = t + (z.del || 0), tauD = Math.max(0.001, d) / 11.5;
    g.gain.setValueAtTime(0, t); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + a); g.gain.setValueAtTime(peak, t0 + a + h);
    if (s < 1) g.gain.setTargetAtTime(peak * s, t0 + a + h, tauD);
    src.start(t, z.off || 0); if (!z.loop) src.stop(t + buf.duration / src.playbackRate.value + 0.05);
    const v = { src, g, t0, a, h, s, r, peak, tauD, z, ended: false };
    if (z.excl) { for (const o of (excl.get(z.excl) || [])) release(o, t, 0.02); excl.set(z.excl, [v]); } // an open hi-hat is cut by the closed one
    return v;
  }
  const level = (v, u) => u <= 0 ? 0 : u < v.a ? v.peak * u / v.a : u < v.a + v.h || v.s >= 1 ? v.peak : v.peak * v.s + (v.peak - v.peak * v.s) * Math.exp(-(u - v.a - v.h) / v.tauD);
  function release(v, T, fast) { // fast: a choke (a closed hi-hat cutting an open one), which also cuts a note already fading out
    if (!v || (v.ended && !fast)) return;
    const r = fast || Math.max(0.01, v.r), now = v.ended && T > v.relT ? v.relLvl * Math.exp(-(T - v.relT) / (v.relR / 6)) : level(v, T - v.t0);
    v.ended = true; v.relT = T; v.relLvl = now; v.relR = r;
    try { v.g.gain.cancelScheduledValues(T); v.g.gain.setValueAtTime(now, T); v.g.gain.setTargetAtTime(0, T, r / 6); v.src.stop(T + r + 0.1); } catch (e) {}
  }
  const zonesFor = (p, vel) => def.zones.filter(z => p >= z.lo && p <= z.hi && vel >= z.vlo && vel <= z.vhi);
  const start = (p, t, vel) => {
    let zs = zonesFor(p, clamp(Math.round(vel), 1, 127));
    if (zs.some(z => z.rlo != null)) { const r = takeOf(p, t); zs = zs.filter(z => z.rlo == null || (r >= z.rlo && (r < z.rhi || z.rhi >= 1))); } // alternate takes, so repeated hits are not identical
    return zs.map(z => voice(z, p, t, vel)).filter(Boolean);
  };
  return { nodes: [],
    play(p, t, d, vel) { const vs = start(p, t, vel); if (!drums || vs.some(v => v.z.loop)) vs.forEach(v => release(v, t + Math.max(0.02, d))); },
    on(p, t, vel) { const vs = start(p, t, vel); if (!drums) held.set(p, [...(held.get(p) || []), ...vs]); },
    off(p, t) { (held.get(p) || []).forEach(v => release(v, t)); held.delete(p); } };
}
// the drum machine's rows on a recorded kit
const KIT_NOTES = { kick: 36, snare: 38, clap: 39, chh: 42, ohh: 46, tom: 45, rim: 37, cow: 56 };
const kitHas = (id, n) => SAMP[id].zones.some(z => n >= z.lo && n <= z.hi);
const kitGaps = id => Object.values(KIT_NOTES).some(n => !kitHas(id, n)); // e.g. the Salamander kit has no hand clap
function sampKit(ac, id, dest) {
  const g = ac.createGain(); g.gain.value = 0.8; g.connect(dest); const k = makeSampled(ac, id, g);
  const fb = id !== 'kit0' && SAMP.kit0 && kitGaps(id) ? makeSampled(ac, 'kit0', g) : null; // borrow what this kit lacks from the standard kit
  return { nodes: [], hit(row, t, v) { const n = KIT_NOTES[row] || 38; (kitHas(id, n) || !fb ? k : fb).play(n, t, 0.1, v); } };
}
function sampAudition(inst, p) {
  const id = inst.slice(2); ctx.resume(); sampAudition.v = sampAudition.v || {};
  if (!sampReady(id)) { loadSamp(id).then(() => sampAudition(inst, p)).catch(() => {}); return; }
  if (!sampAudition.v[id]) sampAudition.v[id] = makeSampled(ctx, id, ctx.destination);
  sampAudition.v[id].play(p, ctx.currentTime + 0.02, 0.7, 100);
}
function instOptions(cur) { // the Sound list, in groups
  const I = MixtapeMIDI.INSTRUMENTS, opt = k => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(I[k])}</option>`, grp = (label, ks) => ks.length ? `<optgroup label="${label}">${ks.map(opt).join('')}</optgroup>` : '';
  const FAM = ['Pianos', 'Bells and mallets', 'Organs', 'Guitars', 'Basses', 'Solo strings', 'String and choir ensembles', 'Brass', 'Reeds', 'Pipes and flutes', 'Synth leads', 'Synth pads', 'Synth effects', 'World', 'Percussive', 'Sound effects'];
  const ks = Object.keys(I), gm = ks.filter(k => isSamp(k) && SAMP[k.slice(2)].kind === 'gm');
  return grp('Grand piano (recorded)', ks.filter(k => k === 's_piano'))
    + grp('Orchestra (recorded)', ks.filter(k => k.startsWith('o_')))
    + FAM.map((f, i) => grp(`${f} (recorded)`, gm.filter(k => Math.floor(SAMP[k.slice(2)].program / 8) === i))).join('')
    + grp('Drum kits (recorded)', ks.filter(k => isSamp(k) && SAMP[k.slice(2)].kind === 'drums'))
    + grp('Synths', ks.filter(k => TONE_INSTS[k]))
    + grp('Simple built-in sounds (light, instant)', ks.filter(k => !k.startsWith('o_') && !k.startsWith('s_') && !TONE_INSTS[k]))
    + (ks.includes(cur) ? '' : opt(cur));
}
function makeToneInst(tctx, inst, dest) {
  const o = { context: tctx }, nodes = [];
  const add = n => { nodes.push(n); return n; };
  let v, tail = null;
  if (inst === 'bass808') {
    // one voice that slides from note to note when they overlap (the hip-hop 808 glide)
    const m = add(new Tone.MonoSynth({ ...o, portamento: 0.07, oscillator: { type: 'sine' }, filter: { type: 'lowpass', frequency: 2400, Q: 0.5 }, filterEnvelope: { baseFrequency: 2400, octaves: 0 }, envelope: { attack: 0.003, decay: 1.4, sustain: 0.55, release: 0.25 }, volume: -4 }));
    const drive = add(new Tone.Distortion({ ...o, distortion: 0.18, wet: 0.35 })); m.connect(drive); tconnect(drive, dest);
    const f = p => 440 * Math.pow(2, (p - 69) / 12);
    return { nodes, play(p, t, d, vel) { try { m.triggerAttackRelease(f(p), Math.max(0.03, d), t, clamp(vel / 127, 0.05, 1)); } catch (e) {} },
      on(p, t, vel) { try { m.triggerAttack(f(p), t, clamp(vel / 127, 0.05, 1)); } catch (e) {} }, off(p, t) { try { m.triggerRelease(t); } catch (e) {} },
      playSeq(evs) {
        const seq = [...evs].sort((a, b) => a.when - b.when).filter((e, i, a) => !i || e.when > a[i - 1].when + 1e-4);
        seq.forEach((e, i) => { const end = e.when + Math.max(0.03, e.d), next = seq[i + 1];
          try { m.triggerAttack(f(e.p), e.when, clamp(e.v / 127, 0.05, 1)); if (!next || next.when > end - 1e-4) m.triggerRelease(end); } catch (err) {} });
      } };
  }
  if (inst === 'acid') v = add(new Tone.PolySynth({ ...o, voice: Tone.MonoSynth, maxPolyphony: 8, options: { oscillator: { type: 'sawtooth' }, filter: { Q: 7, type: 'lowpass', rolloff: -24 }, filterEnvelope: { attack: 0.001, decay: 0.18, sustain: 0.15, release: 0.2, baseFrequency: 160, octaves: 3.6 }, envelope: { attack: 0.002, decay: 0.2, sustain: 0.6, release: 0.08 } }, volume: -10 }));
  else if (inst === 'supersaw') { v = add(new Tone.PolySynth({ ...o, voice: Tone.Synth, options: { oscillator: { type: 'fatsawtooth', count: 5, spread: 35 }, envelope: { attack: 0.01, decay: 0.3, sustain: 0.65, release: 0.45 } }, volume: -16 })); tail = add(new Tone.Filter({ ...o, type: 'lowpass', frequency: 6500 })); }
  else if (inst === 'housepad') { v = add(new Tone.PolySynth({ ...o, voice: Tone.Synth, options: { oscillator: { type: 'fatsawtooth', count: 3, spread: 22 }, envelope: { attack: 0.45, decay: 0.5, sustain: 0.85, release: 1.6 } }, volume: -18 })); tail = add(new Tone.Filter({ ...o, type: 'lowpass', frequency: 1800, Q: 0.6 })); }
  else if (inst === 'fmkeys') v = add(new Tone.PolySynth({ ...o, voice: Tone.FMSynth, options: { harmonicity: 3, modulationIndex: 9, envelope: { attack: 0.005, decay: 0.7, sustain: 0.2, release: 0.9 }, modulationEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.1, release: 0.5 } }, volume: -12 }));
  else if (inst === 'plucky') v = add(new Tone.PolySynth({ ...o, voice: Tone.MonoSynth, options: { oscillator: { type: 'square' }, filter: { Q: 2, type: 'lowpass' }, filterEnvelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1, baseFrequency: 400, octaves: 4 }, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.15 } }, volume: -12 }));
  else v = add(new Tone.PolySynth({ ...o, voice: Tone.Synth, options: { oscillator: { type: 'sine' }, envelope: { attack: 0.005, decay: 0.1, sustain: 0.9, release: 0.2 } }, volume: -6 }));
  if (tail) { v.connect(tail); tconnect(tail, dest); } else tconnect(v, dest);
  return { nodes, play(p, t, d, vel) { try { v.triggerAttackRelease(440 * Math.pow(2, (p - 69) / 12), Math.max(0.03, d), t, clamp(vel / 127, 0.05, 1)); } catch (e) {} },
    on(p, t, vel) { try { v.triggerAttack(hzOf(p), t, clamp(vel / 127, 0.05, 1)); } catch (e) {} }, off(p, t) { try { v.triggerRelease(hzOf(p), t); } catch (e) {} } };
}
/* ---- playing live from a MIDI keyboard or the computer keys, and recording what is played ---- */
function builtinVoice(inst, dest) { // the browser-made instruments, held for as long as the key is down
  const held = new Map();
  return { nodes: [],
    on(p, t, vel) { const g = ctx.createGain(); g.connect(dest); held.set(p, { g, srcs: MixtapeMIDI.playNote(ctx, g, inst, p, t, inst === 'drums' ? 0.1 : 8, vel) }); },
    off(p, t) { const h = held.get(p); if (!h || inst === 'drums') return; held.delete(p); h.g.gain.setTargetAtTime(0, t, 0.05); h.srcs.forEach(s => { try { s.stop(t + 0.4); } catch (e) {} }); setTimeout(() => { try { h.g.disconnect(); } catch (e) {} }, 1500); } };
}
let midiAccess = null, mon = null, recNotes = null, sustain = false, qwerty = false, qOct = 0;
const liveHeld = new Set(), sustained = new Set(), qHeld = new Map();
const livePart = () => { const c = clipById(recNotes ? recNotes.clip : selClip); return c && c.kind === 'midi' ? c : null; };
function monitorVoice(c) {
  const inst = c ? c.inst || 'piano' : 'piano', key = inst + '|' + (c && isOrch(inst) ? orchArtOf(c) : '');
  if (mon && mon.key === key && !mon.stale) return mon;
  if (mon) { const old = mon; setTimeout(() => { (old.v.nodes || []).forEach(n => { try { n.dispose(); } catch (e) {} }); try { old.bus.disconnect(); } catch (e) {} }, 3000); }
  const bus = ctx.createGain(); bus.connect(ctx.destination); let v;
  if (isSamp(inst)) { v = makeSampled(ctx, inst.slice(2), bus); if (!sampReady(inst.slice(2))) loadSamp(inst.slice(2)).then(() => { if (mon) mon.stale = true; }).catch(() => {}); }
  else if (HAS_TONE && c && isOrch(inst)) { v = makeOrch(toneFor(ctx), c, bus); if (!v.nodes.length) ensureOrch(c).then(() => { if (mon) mon.stale = true; }).catch(() => {}); }
  else if (HAS_TONE && TONE_INSTS[inst]) v = makeToneInst(toneFor(ctx), inst, bus);
  else v = builtinVoice(inst, bus);
  mon = { key, v, bus }; return mon;
}
/* ---- an outside instrument (Spitfire LABS, Splice INSTRUMENT, any synth) played over MIDI ----
   A track can send its notes out of a MIDI port (a loopback cable such as loopMIDI or a Windows MIDI
   loopback) to another app that makes the sound. Mixtape times each note to when its own audio is heard. */
const moutOf = l => { if (!l || !l.mout || !midiAccess) return null; const o = midiAccess.outputs.get(l.mout.id) || [...midiAccess.outputs.values()].find(x => x.name === l.mout.name); return o ? { o, ch: clamp((l.mout.ch || 1) - 1, 0, 15), delay: l.mout.delay || 0, inside: !!l.mout.inside } : null; };
const moutNames = () => new Set(P.lanes.filter(l => l.mout).map(l => l.mout.name));
// when Mixtape's own sound for that moment reaches the speakers: the browser pairs its audio clock with real time at the output
const outStamp = () => { const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null; return ts && ts.performanceTime > 0 && ts.contextTime > 0 && performance.now() - ts.performanceTime < 100 ? ts : null; }; // a stamp left over from before a pause is stale
const ctxToPerf = when => { const ts = outStamp(); return ts ? ts.performanceTime + (when - ts.contextTime) * 1000 : performance.now() + (when - ctx.currentTime) * 1000 + ((ctx.outputLatency || ctx.baseLatency || 0) * 1000); };
function msend(mo, data, perf) { const at = perf == null ? undefined : Math.max(performance.now(), perf + mo.delay); try { mo.o.send(data, at); } catch (e) {} return at || performance.now(); }
function scheduleMidiOut(gr, horizon) { // like the drum machine: a third of a second ahead, so a pause stops it cleanly
  if (ctx.getOutputTimestamp && !outStamp()) return; // the audio clock has not started yet: wait, or the first notes go out early
  for (const m of gr.mout || []) {
    const stopWhen = gr.pat ? gr.pat.when0 + (gr.pat.stopAt - gr.pat.startPos) : Infinity;
    while (m.i < m.evs.length && m.evs[m.i].when < horizon) {
      const e = m.evs[m.i++]; let when = e.when;
      if (when >= stopWhen) { if (e.kind !== 'off') continue; when = stopWhen; } // past the loop's end: only let held notes go
      if (e.kind === 'on') { m.on.set(e.p, (m.on.get(e.p) || 0) + 1); m.last = Math.max(m.last || 0, msend(m.mo, [0x90 | m.mo.ch, e.p, clamp(e.v, 1, 127)], ctxToPerf(when))); }
      else if (e.kind === 'off') { if (!m.on.get(e.p)) continue; m.on.set(e.p, m.on.get(e.p) - 1); msend(m.mo, [0x80 | m.mo.ch, e.p, 0], ctxToPerf(when)); }
      else msend(m.mo, [0xb0 | m.mo.ch, e.cc, clamp(Math.round(e.v), 0, 127)], ctxToPerf(when));
    }
  }
}
function midiOutSilence(gr) { // stop: let every held note go, then "all notes off", after any note already sent ahead
  for (const m of gr.mout || []) { const at = Math.max(performance.now(), (m.last || 0) + 2) - m.mo.delay; for (const [p, n] of m.on) if (n > 0) msend(m.mo, [0x80 | m.mo.ch, p, 0], at); m.on.clear(); msend(m.mo, [0xb0 | m.mo.ch, 123, 0], at); m.i = m.evs.length; }
}
async function ensureMidiAccess(quiet) {
  if (midiAccess) return midiAccess; if (!navigator.requestMIDIAccess) { if (!quiet) toast('This browser cannot use MIDI. Use Chrome or Edge.', 5000); return null; }
  try { midiAccess = await navigator.requestMIDIAccess(); } catch (e) { if (!quiet) toast('MIDI was not allowed. Click the keyboard icon in the address bar to allow it, then try again.', 7000); return null; }
  const hook = () => { for (const inp of midiAccess.inputs.values()) inp.onmidimessage = e => { if (!moutNames().has(inp.name)) onMidiMsg(e); }; }; // never listen to the cable Mixtape is sending into
  hook(); midiAccess.onstatechange = () => { hook(); renderInspector(); };
  return midiAccess;
}
function liveLaneOut() { const c = livePart(), l = P.lanes.find(x => x.id === (c ? c.lane : selLane)); return moutOf(l); }
function noteIn(p, vel, on) {
  ctx.resume(); const c = livePart(), mo = liveLaneOut(), m = mo && !mo.inside ? null : monitorVoice(c), now = ctx.currentTime + 0.005, q = clamp(p + (c ? c.semi || 0 : 0), 0, 127);
  if (on) {
    if (liveHeld.has(p)) release(p); sustained.delete(p); liveHeld.add(p);
    if (mo) msend(mo, [0x90 | mo.ch, q, clamp(vel, 1, 127)]);
    if (m) try { m.v.on ? m.v.on(q, now, vel) : m.v.play(q, now, 0.6, vel); } catch (e) {}
    if (recNotes && playing) recNotes.open.set(p, { p, v: vel, tl: curPos() });
  } else if (sustain) sustained.add(p); else release(p);
}
function release(p) {
  const c = livePart(), mo = liveLaneOut(); liveHeld.delete(p);
  if (mo) msend(mo, [0x80 | mo.ch, clamp(p + (c ? c.semi || 0 : 0), 0, 127), 0]);
  try { mon && mon.v.off && mon.v.off(clamp(p + (c ? c.semi || 0 : 0), 0, 127), ctx.currentTime + 0.005); } catch (e) {}
  closeRecNote(p);
}
function pedal(down) { const mo = liveLaneOut(); if (mo) msend(mo, [0xb0 | mo.ch, 64, down ? 127 : 0]); sustain = down; if (!down) { [...sustained].forEach(release); sustained.clear(); } }
function ccIn(v) { // the mod wheel: heard at once, and recorded into the part's dynamics
  const mo = liveLaneOut(); if (mo) msend(mo, [0xb0 | mo.ch, 1, Math.round(v * 127)]);
  if (mon) mon.bus.gain.setTargetAtTime(dynGain(v), ctx.currentTime, 0.02);
  if (!recNotes || !playing) return; const c = clipById(recNotes.clip); if (!c) return;
  const t = c.start + (curPos() - c.at) * (c.rate || 1), last = recNotes.dyn[recNotes.dyn.length - 1];
  if (t < c.start) return; if (!last || t - last.t > 0.03) recNotes.dyn.push({ t, v }); else last.v = v;
}
function onMidiMsg(e) {
  const [s, a, b] = e.data, cmd = s & 0xf0;
  if (cmd === 0x90 && b > 0) noteIn(a, b, true);
  else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) noteIn(a, 0, false);
  else if (cmd === 0xb0 && a === 64) pedal(b >= 64);
  else if (cmd === 0xb0 && (a === 1 || a === 11)) ccIn(b / 127);
}
const midiNames = () => midiAccess ? [...midiAccess.inputs.values()].map(i => i.name).filter(n => !moutNames().has(n)) : [];
async function connectMidi() {
  if (!navigator.requestMIDIAccess) return toast('This browser cannot use MIDI keyboards. Use Chrome or Edge, or play with the computer keys.', 6000);
  if (!(await ensureMidiAccess())) return;
  const n = midiNames(); toast(n.length ? `Keyboard connected: ${n.join(', ')}. Play it to hear the selected part’s sound.` : 'No MIDI keyboard found yet. Plug one in and it connects by itself.', 5000); renderInspector();
}
async function toggleRecNotes() {
  if (recNotes) return finishRecNotes(true);
  let c = clipById(selClip);
  if (!c || c.kind !== 'midi') {
    const l = P.lanes.find(x => x.id === selLane && x.type !== 'group' && x.type !== 'return'); if (!l) return toast('Select an instrument part, or a track to record a new part onto.');
    c = newMidiClip(l.id, playhead, [], { inst: 'piano', name: 'Recorded' }); P.clips.push(c); selClip = c.id; edOpen = true; quietCommit(); renderAll();
  }
  if (!midiAccess && !qwerty) { await connectMidi(); if (!midiNames().length) { qwerty = true; toast('No MIDI keyboard, so the computer keys play notes: A W S E D F T G Y H U J K. Z and X change octave.', 7000); } }
  if (playing) pause();
  c.notes = c.notes.map(n => ({ ...n }));
  recNotes = { clip: c.id, open: new Map(), n: 0, dyn: [] };
  if (P.bpm) playhead = Math.max(0, playhead - 4 * 60 / tempoAt(playhead)); // one bar to come in on
  renderInspector(); await play();
}
function closeRecNote(p) {
  const r = recNotes, o = r && r.open.get(p); if (!o) return; r.open.delete(p);
  const c = clipById(r.clip); if (!c) return; const rate = c.rate || 1;
  let t = c.start + (o.tl - c.at) * rate; if (t < c.start - 0.05) return; // played during the count-in
  t = Math.max(c.start, UI.recQ ? snapNoteT(c, t) : t); const d = Math.max(0.03, (curPos() - o.tl) * rate);
  c.notes.push({ id: uid(), p: o.p, t, d, v: o.v }); r.n++; if (t + d > c.end) c.end = t + d;
  if (edOpen) drawEditor(); const el = $(`.clip[data-clip="${c.id}"] canvas`); if (el) drawClipCanvas(el, c);
}
function finishRecNotes(stopPlay) {
  const r = recNotes; if (!r) return;
  for (const p of [...r.open.keys()]) closeRecNote(p);
  recNotes = null; if (stopPlay && playing) pause();
  const c = clipById(r.clip);
  if (c && r.dyn.length) { const a = r.dyn[0].t, b = r.dyn[r.dyn.length - 1].t; c.dyn = thinDyn([...(c.dyn || []).filter(x => x.t < a || x.t > b), ...r.dyn].sort((x, y) => x.t - y.t)); }
  setTimeout(() => commit(r.n ? `Recorded ${r.n} note${r.n === 1 ? '' : 's'} into “${c ? midiName(c) : 'the part'}”.` : 'Recording stopped. No notes were played.'), 0); // after playback has fully stopped
}
// the computer keys as a piano: the bottom two rows of letters, Z and X for octaves
const QWERTY = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };
window.addEventListener('keydown', e => {
  if (!qwerty || e.ctrlKey || e.metaKey || e.altKey || !$('#modal').hidden || (e.target.closest && e.target.closest('input, select, textarea'))) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { qwerty = false; renderInspector(); return toast('The computer keys work as shortcuts again.'); }
  if (k === 'z' || k === 'x') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) { qOct = clamp(qOct + (k === 'x' ? 1 : -1), -3, 3); toast(`The computer keys now start at C${4 + qOct}.`, 1500); } return; }
  if (!(k in QWERTY)) return; e.preventDefault(); e.stopImmediatePropagation();
  if (!e.repeat && !qHeld.has(k)) { const p = 60 + 12 * qOct + QWERTY[k]; qHeld.set(k, p); noteIn(p, e.shiftKey ? 120 : 96, true); }
}, true);
window.addEventListener('keyup', e => { const p = qHeld.get(e.key.toLowerCase()); if (p == null) return; qHeld.delete(e.key.toLowerCase()); noteIn(p, 0, false); }, true);
/* ---- effect chains: each track runs its sound through these, top to bottom ---- */
const FX_TYPES = { eq: 'EQ', comp: 'Compressor', sat: 'Saturation (tape / tube warmth)', lofi: 'Lo-fi (bit crush, old sampler)', distortion: 'Distortion (fuzz)', chorus: 'Chorus', phaser: 'Phaser', pingpong: 'Ping-pong delay', hall: 'Big reverb (hall)', gate: 'Trance gate', autofilter: 'Auto-filter sweep' };
const EQ_DEFAULT = () => [{ t: 'hp', f: 30, on: false }, { t: 'ls', f: 120, g: 0, on: true }, { t: 'pk', f: 400, g: 0, q: 1, on: true }, { t: 'pk', f: 2500, g: 0, q: 1, on: true }, { t: 'hs', f: 8000, g: 0, on: true }, { t: 'lp', f: 18000, on: false }];
const BAND_TYPE = { hp: 'highpass', ls: 'lowshelf', pk: 'peaking', hs: 'highshelf', lp: 'lowpass' };
const BAND_NAME = { hp: 'Low cut', ls: 'Low shelf', pk: 'Bell', hs: 'High shelf', lp: 'High cut' };
function newDevice(type) {
  const d = { id: uid(), type, on: true, amt: 0.5, mix: 0.5 };
  if (type === 'eq') d.bands = EQ_DEFAULT();
  if (type === 'comp') Object.assign(d, { th: -18, ratio: 4, att: 10, rel: 120, knee: 6, makeup: 0, mix: 1 });
  if (type === 'sat') Object.assign(d, { mode: 'tape', amt: 0.25, tone: 0.8, mix: 1 });
  if (type === 'lofi') Object.assign(d, { bits: 8, rate: 11025, tone: 0.6, mix: 1 });
  if (type === 'gate') Object.assign(d, { gate: 'classic', amt: 0.9 });
  if (type === 'hall') d.mix = 0.4;
  return d;
}
const toneHz = t => 1000 * Math.pow(20, clamp(t, 0, 1)); // Tone: 1 kHz (dark) to 20 kHz (open)
const satK = d => Math.pow(10, clamp(d.amt ?? 0.35, 0, 1) * 30 / 20); // Drive: up to 30 dB into the curve
const satShape = (mode, u) => mode === 'tube' ? Math.tanh(u + 0.35) - Math.tanh(0.35) : mode === 'hard' ? u / Math.pow(1 + Math.pow(Math.abs(u), 8), 1 / 8) : Math.tanh(u);
const satCache = new Map();
function satCurve(mode, k) {
  const key = mode + k.toFixed(3); if (satCache.has(key)) return satCache.get(key).curve;
  const n = 4096, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = satShape(mode, k * (i / (n - 1) * 2 - 1));
  // the average gain for tones from -20 to -3 dBFS, taken back off, so Drive changes the colour more than the volume
  let sum = 0; const amps = [0.1, 0.18, 0.3, 0.45, 0.7];
  for (const A of amps) { let a = 0, b = 0; for (let i = 0; i < 512; i++) { const x = A * Math.sin(i / 512 * 2 * Math.PI), y = satShape(mode, k * x); a += x * x; b += y * y; } sum += Math.log(Math.sqrt(b / a) || 1); }
  satCache.set(key, { curve: c, level: Math.exp(sum / amps.length) }); return c;
}
const satLevel = (mode, k) => { satCurve(mode, k); return satCache.get(mode + k.toFixed(3)).level; };
// the lo-fi effect runs in lofi-worklet.js, loaded into each audio context before it is used
const lofiOk = new WeakSet(), lofiLoading = new WeakMap();
function ensureLofi(ac) {
  if (!ac.audioWorklet) return Promise.resolve(false);
  if (!lofiLoading.has(ac)) lofiLoading.set(ac, ac.audioWorklet.addModule('lofi-worklet.js').then(() => { lofiOk.add(ac); return true; }, () => false));
  return lofiLoading.get(ac);
}
function setBand(n, b) { n.type = BAND_TYPE[b.t]; n.frequency.value = clamp(b.f, 20, 20000); n.Q.value = b.t === 'pk' ? clamp(b.q || 1, 0.2, 12) : 0.707; n.gain.value = b.t === 'hp' || b.t === 'lp' ? 0 : clamp(b.g || 0, -24, 24); }
function applyComp(x, d) {
  x.comp.threshold.value = d.th; x.comp.ratio.value = d.ratio; x.comp.attack.value = d.att / 1000; x.comp.release.value = d.rel / 1000; x.comp.knee.value = d.knee ?? 6;
  // the browser's compressor quietly adds its own makeup gain (0.6 of what it takes off a full-scale signal); take it back out, so only our Makeup slider adds level
  const hidden = 0.6 * Math.max(0, -d.th) * (1 - 1 / Math.max(1, d.ratio));
  x.mk.gain.value = Math.pow(10, ((d.makeup || 0) - hidden) / 20); const m = clamp(d.mix ?? 1, 0, 1); x.dry.gain.value = 1 - m; x.wet.gain.value = m;
}
const link = (a, b) => (HAS_TONE ? Tone.connect(a, b) : a.connect(b));
function buildDevice(ac, dev) {
  if (dev.type === 'eq') {
    const ns = dev.bands.map(b => { if (!b.on) return null; const n = ac.createBiquadFilter(); setBand(n, b); return n; });
    // a low or high cut is two filters in a row (24 dB per octave), steeper than one
    const chain = []; ns.forEach((n, i) => { if (!n) return; chain.push(n); if (dev.bands[i].t === 'hp' || dev.bands[i].t === 'lp') { const n2 = ac.createBiquadFilter(); setBand(n2, dev.bands[i]); chain.push(n2); ns[i] = [n, n2]; } });
    if (!chain.length) { const p = ac.createGain(); return { in: p, out: p, eqNodes: ns }; }
    for (let i = 1; i < chain.length; i++) chain[i - 1].connect(chain[i]);
    return { in: chain[0], out: chain[chain.length - 1], eqNodes: ns };
  }
  if (dev.type === 'comp') {
    const x = { in: ac.createGain(), out: ac.createGain(), dry: ac.createGain(), wet: ac.createGain(), mk: ac.createGain(), comp: ac.createDynamicsCompressor() };
    x.in.connect(x.dry); x.dry.connect(x.out); x.in.connect(x.comp); x.comp.connect(x.mk); x.mk.connect(x.wet); x.wet.connect(x.out); applyComp(x, dev); return x;
  }
  if (dev.type === 'sat') { // tape or tube warmth: a soft curve pushed harder by Drive, then levelled so it gets warmer, not just louder
    const x = { in: ac.createGain(), out: ac.createGain() }, sh = ac.createWaveShaper(), hp = ac.createBiquadFilter(), tone = ac.createBiquadFilter(), lev = ac.createGain(), dry = ac.createGain(), wet = ac.createGain();
    const mode = dev.mode || 'tape', k = satK(dev); sh.curve = satCurve(mode, k); sh.oversample = '4x';
    hp.type = 'highpass'; hp.frequency.value = 15; tone.type = 'lowpass'; tone.frequency.value = toneHz(dev.tone ?? 0.8); lev.gain.value = 1 / satLevel(mode, k);
    const m = clamp(dev.mix ?? 1, 0, 1); dry.gain.value = 1 - m; wet.gain.value = m;
    x.in.connect(dry); dry.connect(x.out); x.in.connect(sh); sh.connect(hp); hp.connect(tone); tone.connect(lev); lev.connect(wet); wet.connect(x.out); return x;
  }
  if (dev.type === 'lofi') { // fewer bits and a slower sample clock, like an old sampler
    const x = { in: ac.createGain(), out: ac.createGain() }, dry = ac.createGain(), wet = ac.createGain(), tone = ac.createBiquadFilter();
    const m = clamp(dev.mix ?? 1, 0, 1); dry.gain.value = 1 - m; wet.gain.value = m; tone.type = 'lowpass'; tone.frequency.value = toneHz(dev.tone ?? 0.6);
    x.in.connect(dry); dry.connect(x.out);
    if (lofiOk.has(ac)) {
      const n = new AudioWorkletNode(ac, 'mixtape-lofi', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      n.parameters.get('bits').value = clamp(dev.bits ?? 8, 2, 16); n.parameters.get('rate').value = clamp(dev.rate ?? 11025, 1000, 48000);
      x.in.connect(n); n.connect(tone); x.worklet = n;
    } else x.in.connect(tone);
    tone.connect(wet); wet.connect(x.out); return x;
  }
  if (dev.type === 'gate') { const g = ac.createGain(); return { in: g, out: g, gate: g }; }
  if (dev.type === 'hall') { // pre-delay, then a 5.5-second tail under the dry sound (all wet when the mix is at 100%, as on a return)
    const mix = clamp(dev.mix ?? 0.4, 0, 1), x = { in: ac.createGain(), out: ac.createGain() }, dry = ac.createGain(), wet = ac.createGain(), pre = ac.createDelay(0.2), cv = ac.createConvolver();
    dry.gain.value = mix >= 0.99 ? 0 : 1 - mix * 0.5; wet.gain.value = mix * (0.5 + (dev.amt ?? 0.5)); pre.delayTime.value = 0.03; cv.buffer = getHall(ac);
    x.in.connect(dry); dry.connect(x.out); x.in.connect(pre); pre.connect(cv); cv.connect(wet); wet.connect(x.out); return x;
  }
  if (HAS_TONE) { const t = makeTrackFx(toneFor(ac), dev); if (t) return { in: t, out: t, tone: t }; }
  const p = ac.createGain(); return { in: p, out: p };
}
const GATES = { classic: 'x.x.xx.x.x.xx.xx', offbeat: '.x.x.x.x.x.x.x.x', stutter: 'xxx.xxx.xx.xxx.x', eighths: 'x.x.x.x.x.x.x.x.', pulse: 'xxxxxxxxxxxxxxxx' };
function makeTrackFx(tctx, dev) {
  const f = dev || {}, o = { context: tctx, wet: clamp(f.mix ?? 0.5, 0, 1) }, beat = 60 / (P.bpm || 120), amt = clamp(f.amt ?? 0.5, 0, 1);
  if (f.type === 'chorus') return new Tone.Chorus({ ...o, frequency: 0.6 + amt * 2, delayTime: 3.5, depth: 0.4 + amt * 0.6 }).start();
  if (f.type === 'phaser') return new Tone.Phaser({ ...o, frequency: 0.2 + amt * 1.5, octaves: 3, baseFrequency: 350 });
  if (f.type === 'pingpong') return new Tone.PingPongDelay({ ...o, delayTime: 0.75 * beat, feedback: 0.2 + amt * 0.5 });
  if (f.type === 'distortion') return new Tone.Distortion({ ...o, distortion: 0.1 + amt * 0.8, oversample: '2x' });
  if (f.type === 'autofilter') return new Tone.AutoFilter({ ...o, frequency: 1 / (beat * (8 - amt * 6)), baseFrequency: 180, octaves: 4.5 }).start();
  return null;
}
/* ---- drum machine parts: a looping pattern of 16th-note steps ---- */
const patStepBeats = 0.25; // a part's length moves in 16ths
const RES = { '16': { beats: 1 / 4, label: '16ths' }, '32': { beats: 1 / 8, label: '32nds (hi-hat rolls)' }, '16t': { beats: 1 / 6, label: '16th triplets' }, '8t': { beats: 1 / 3, label: '8th triplets' } };
const stepB = c => (RES[c.pat.res] || RES['16']).beats;
const patN = c => Math.round(4 / stepB(c)) * (c.pat.bars || 1);
function patSec(c) { const B0 = beatAt(c.at); return timeAtBeat(B0 + c.beats) - c.at; }
// keep a pattern's length in beats and in seconds in step with each other and with the tempo map
function syncPattern(c) {
  if (!P.bpm) P.bpm = 124;
  if (c.lenSet != null && Math.abs(dur(c) - c.lenSet) > 1e-3) c.beats = Math.max(patStepBeats, Math.round((beatAt(c.at + dur(c)) - beatAt(c.at)) / patStepBeats) * patStepBeats);
  c.end = c.start + patSec(c); c.lenSet = dur(c);
}
function housePattern(bars = 1) {
  const n = 16 * bars, rows = {}; DRUM_ROWS.forEach(([k]) => { rows[k] = Array(n).fill(0); });
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) rows.kick[i] = 120;
    if (i % 8 === 4) rows.clap[i] = 110;
    if (i % 4 === 2) rows.ohh[i] = 90; else rows.chh[i] = i % 2 ? 55 : 70;
  }
  return rows;
}
function newRiser(dir = 'up') {
  if (!P.bpm) P.bpm = 124;
  const laneId = (P.lanes.find(l => l.name === 'FX') || (() => { const l = newLane('FX', PALETTE[5]); P.lanes.push(l); return l; })()).id;
  const beats = 8, at = dir === 'up' ? Math.max(0, timeAtBeat(Math.round(beatAt(playhead)) - beats)) : snapBeat(playhead);
  const c = { id: uid(), kind: 'riser', dir, trackId: null, lane: laneId, at, start: 0, end: 1, beats, gain: 1, fadeIn: 0, fadeOut: 0, rate: 1, semi: 0, keepPitch: true, fxIn: 'fade', fxOut: 'fade', name: dir === 'up' ? 'Riser' : 'Downlifter' };
  syncPattern(c); P.clips.push(c); selLane = laneId; selClip = c.id;
  commit(dir === 'up' ? 'Riser added: it builds for 2 bars and ends at the playhead, ready for the drop. Drag its right edge to change its length.' : 'Downlifter added at the playhead: it falls away over 2 bars.');
}
function scheduleRiser(ac, dest, c, startPos, when0) {
  const d = dur(c), u0 = Math.max(0, startPos - c.at); if (u0 >= d) return [];
  const T = u => when0 + (c.at + u - startPos), up = c.dir !== 'down', f = x => clamp(x, 0, 1);
  const frac = u => up ? f(u / d) : f(1 - u / d);
  const noise = ac.createBufferSource(); noise.buffer = noiseBuf(ac); noise.loop = true;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
  const fq = x => 250 * Math.pow(9000 / 250, x);
  bp.frequency.setValueAtTime(fq(frac(u0)), T(u0)); bp.frequency.exponentialRampToValueAtTime(fq(frac(d)), T(d));
  const g = ac.createGain(), lv = x => 0.0005 + 0.6 * x * x;
  g.gain.setValueAtTime(lv(frac(u0)), T(u0)); g.gain.linearRampToValueAtTime(lv(frac(d)), T(d)); g.gain.setTargetAtTime(0.0001, T(d), 0.02);
  noise.connect(bp); bp.connect(g); g.connect(dest);
  const o = ac.createOscillator(); o.type = 'sawtooth'; const og = ac.createGain(), ol = ac.createBiquadFilter(); ol.type = 'lowpass'; ol.frequency.value = 3000;
  const pf = x => 90 * Math.pow(2, x * 3.2);
  o.frequency.setValueAtTime(pf(frac(u0)), T(u0)); o.frequency.exponentialRampToValueAtTime(pf(frac(d)), T(d));
  og.gain.setValueAtTime(0.06 * frac(u0) + 0.0005, T(u0)); og.gain.linearRampToValueAtTime(0.06 * frac(d) + 0.0005, T(d));
  o.connect(ol); ol.connect(og); og.connect(dest);
  noise.start(T(u0)); noise.stop(T(d) + 0.1); o.start(T(u0)); o.stop(T(d) + 0.1);
  return [noise, o];
}
let noiseB = null;
function noiseBuf(ac) { if (noiseB && noiseB.sampleRate === ac.sampleRate) return noiseB; const b = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1; return (noiseB = b); }
function newDrumMachine() {
  if (!HAS_TONE) return toast('The drum machine needs the sound engine file, which did not load. Reload the page.');
  if (!P.bpm) P.bpm = 124;
  const l = newLane('Drum machine', PALETTE[1]); P.lanes.push(l);
  const at = snapBeat(playhead);
  const c = { id: uid(), kind: 'pattern', trackId: null, lane: l.id, at, start: 0, end: 1, beats: 16, gain: 1, fadeIn: 0, fadeOut: 0, rate: 1, semi: 0, keepPitch: true, fxIn: 'fade', fxOut: 'fade', name: 'House beat', pat: { kit: '909', bars: 1, swing: 0, rows: housePattern(1) } };
  syncPattern(c); P.clips.push(c); selLane = l.id; selClip = c.id; edOpen = true; if (UI.edFold) UI.edFold = false;
  commit(`Drum machine added at ${P.bpm} BPM with a house beat. Click squares in the grid below to change it; you hear changes on the next pass without stopping.`);
}
/* Pattern hits are scheduled a moment ahead while playing (so editing the grid is heard on the next pass, with no restart),
   and all at once when saving. The kick also drives the "pump" on tracks that ask for it. */
function schedulePatterns(gr, until) {
  const S = gr.pat; if (!S || until <= S.upto) return;
  const from = S.upto, end = Math.min(until, S.stopAt);
  const kicks = [];
  for (const c of P.clips) {
    if (c.kind !== 'pattern' || c.mute) continue;
    // the kick drives the pump even when its own track is not part of this render (a stem of the bass, say)
    const voices = S.voices.get(c.id), l = P.lanes.find(x => x.id === c.lane); if (!l || (!voices && !S.pumps.size)) continue;
    const audible = laneAudible(l);
    const cEnd = c.at + dur(c), B0 = beatAt(c.at - c.start), n = patN(c), sb = stepB(c), straight = !String(c.pat.res || '16').endsWith('t'), sw = straight ? clamp((c.pat.swing || 0) / 100, 0, 0.6) : 0;
    const a = Math.max(from, c.at), z = Math.min(end, cEnd); if (z <= a) continue;
    for (let k = Math.max(0, Math.floor((beatAt(a) - B0) / sb) - 1); k < 200000; k++) {
      const t = timeAtBeat(B0 + k * sb + (k % 2 ? sw * sb : 0));
      if (t >= z) break; if (t < a - 1e-6) continue;
      const when = S.when0 + (t - S.startPos);
      for (const [row] of DRUM_ROWS) { const v = (c.pat.rows[row] || [])[k % n]; if (v > 0) { if (voices) voices.hit(row, when, v); if (row === 'kick' && audible) kicks.push(when); } }
    }
  }
  // the trance gate: open or shut on every 16th of the bar, following the tempo map
  for (const [, gt] of S.gates) {
    if (!P.bpm) { gt.node.gain.setValueAtTime(1, S.when0); continue; }
    for (let k = Math.max(0, Math.floor(beatAt(from) * 4) - 1); k < 400000; k++) {
      const t = timeAtBeat(k / 4); if (t >= end) break; if (t < from - 1e-6) continue;
      const when = S.when0 + (t - S.startPos), open = gt.steps[k % 16] === 'x', v = open ? 1 : 1 - gt.depth;
      gt.node.gain.setValueAtTime(gt.last ?? 1, Math.max(0, when - 0.003)); gt.node.gain.linearRampToValueAtTime(v, when + 0.002); gt.last = v;
    }
  }
  if (kicks.length && S.pumps.size) for (const [, p] of S.pumps) for (const w of kicks.sort((x, y) => x - y)) {
    p.pg.gain.setValueAtTime(1 - p.depth, w); p.pg.gain.setTargetAtTime(1, w + 0.008, p.release / 3);
  }
  S.upto = end;
}
function drumAudition(row, kit) {
  if (String(kit).startsWith('s:')) { const id = kit.slice(2), n = KIT_NOTES[row] || 38; return sampAudition('s_' + (SAMP[id] && !kitHas(id, n) && SAMP.kit0 ? 'kit0' : id), n); }
  if (!HAS_TONE) return; ctx.resume();
  drumAudition.kits = drumAudition.kits || {};
  if (!drumAudition.kits[kit]) { const g = ctx.createGain(); g.connect(ctx.destination); drumAudition.kits[kit] = makeKit(toneFor(ctx), kit, g); }
  drumAudition.kits[kit].hit(row, ctx.currentTime + 0.02, 110);
}
async function orchAudition(c, p) {
  if (!ORCH) return; try { await ensureOrch(c); } catch (e) { return; } ctx.resume();
  const key = c.inst + '|' + orchArtOf(c); orchAudition.v = orchAudition.v || {};
  if (!orchAudition.v[key]) { const g = ctx.createGain(); g.connect(ctx.destination); orchAudition.v[key] = makeOrch(toneFor(ctx), c, g); }
  orchAudition.v[key].play(p, ctx.currentTime + 0.02, 0.6, 100);
}
function toneAudition(inst, p) {
  if (!HAS_TONE) return; ctx.resume();
  toneAudition.v = toneAudition.v || {};
  if (!toneAudition.v[inst]) { const g = ctx.createGain(); g.connect(ctx.destination); toneAudition.v[inst] = makeToneInst(toneFor(ctx), inst, g); }
  toneAudition.v[inst].play(p, ctx.currentTime + 0.02, 0.35, 96);
}
/* ---- the pattern grid in the part editor ---- */
function drawPatternGrid(c, g, w, h) {
  const LW = 78, rows = DRUM_ROWS, n = patN(c), rh = h / rows.length, cw = (w - LW) / n, col = laneColor(c.lane);
  edView = { pattern: true, LW, rh, cw, n, w, h };
  rows.forEach(([key, label], r) => {
    g.fillStyle = r % 2 ? 'rgba(255,255,255,.02)' : 'rgba(255,255,255,.045)'; g.fillRect(0, r * rh, w, rh);
    g.fillStyle = css('--muted'); g.font = `600 ${Math.min(11, rh - 3)}px ${css('--f-mono')}`; g.textBaseline = 'middle'; g.fillText(label, 6, r * rh + rh / 2);
    for (let i = 0; i < n; i++) {
      const v = (c.pat.rows[key] || [])[i] || 0, x = LW + i * cw;
      g.fillStyle = i % Math.round(1 / stepB(c)) === 0 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.05)'; g.fillRect(x + 1, r * rh + 1.5, Math.max(1, cw - 2), rh - 3);
      if (v > 0) { g.fillStyle = withAlpha(col, 0.35 + 0.65 * v / 127); g.fillRect(x + 1, r * rh + 1.5, Math.max(1, cw - 2), rh - 3); }
    }
  });
  const perBeat = Math.round(1 / stepB(c)), perBar = perBeat * 4;
  for (let i = 0; i <= n; i += perBeat) { g.fillStyle = i % perBar === 0 ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.16)'; g.fillRect(LW + i * cw - 0.5, 0, 1, h); }
  // where the music is in the pattern right now
  if (playing) { const p = curPos(); if (p >= c.at && p < c.at + dur(c)) { const k = Math.floor((beatAt(p) - beatAt(c.at - c.start)) / stepB(c)) % n; g.strokeStyle = css('--ink'); g.lineWidth = 2; g.strokeRect(LW + k * cw + 1, 1, cw - 2, h - 2); } }
}
function patternPointer(e, wrap, c) {
  const V = edView, r = wrap.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const row = Math.floor(y / V.rh); if (row < 0 || row >= DRUM_ROWS.length) return;
  const key = DRUM_ROWS[row][0];
  if (x < V.LW) return drumAudition(key, c.pat.kit);
  const at = ev => clamp(Math.floor((ev.clientX - r.left - V.LW) / V.cw), 0, V.n - 1);
  c.pat.rows[key] = (c.pat.rows[key] || Array(V.n).fill(0)).slice();
  const i0 = at(e), setTo = c.pat.rows[key][i0] > 0 ? 0 : (e.shiftKey ? 127 : 100);
  const paint = i => { c.pat.rows[key][i] = setTo; };
  paint(i0); if (setTo) drumAudition(key, c.pat.kit);
  patLive(c);
  try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  let last = i0;
  const mv = ev => { const i = at(ev); if (i === last) return; const [a, b] = i > last ? [last, i] : [i, last]; for (let k = a; k <= b; k++) paint(k); last = i; patLive(c); };
  wrap.addEventListener('pointermove', mv);
  wrap.addEventListener('pointerup', () => wrap.removeEventListener('pointermove', mv), { once: true });
}
// a change to the grid is saved and heard on the next pass, without stopping the music
function patLive(c) { quietCommit(); drawEditor(); const el = $(`.clip[data-clip="${c.id}"] canvas`); if (el) drawClipCanvas(el, c); }
function patternInspectorHTML(c) {
  const kits = Object.entries(KITS).map(([k, v]) => `<option value="${k}" ${c.pat.kit === k ? 'selected' : ''}>${v}</option>`).join('');
  const bars = [1, 2, 4].map(b => `<option value="${b}" ${c.pat.bars === b ? 'selected' : ''}>${b} bar${b > 1 ? 's' : ''}</option>`).join('');
  return `<div class="sec"><h3>Drum machine</h3>
    <dl class="kv"><dt>Part</dt><dd>${esc(c.name || 'Pattern')}</dd><dt>Starts at</dt><dd>${fmtT(c.at)}</dd><dt>Length</dt><dd>${c.beats / 4} bar${c.beats === 4 ? '' : 's'}</dd></dl>
    <div class="field"><label for="pKit">Kit</label><select id="pKit" data-cf="kit">${kits}</select><span></span></div>
    <div class="field"><label for="pBars">Pattern</label><select id="pBars" data-cf="bars">${bars}</select><span></span></div>
    <div class="field"><label for="pRes">Steps</label><select id="pRes" data-cf="res">${Object.entries(RES).map(([k, v]) => `<option value="${k}" ${(c.pat.res || '16') === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select><span></span></div>
    <div class="field"><label for="pSwing">Swing</label><input id="pSwing" type="range" min="0" max="60" value="${c.pat.swing || 0}" data-cf="swing"><output>${c.pat.swing || 0}%</output></div>
    <div class="field"><label for="cGain">Volume</label><input id="cGain" type="range" min="0" max="300" value="${Math.round((c.gain ?? 1) * 100)}" data-cf="gain"><output>${Math.round((c.gain ?? 1) * 100)}%</output></div>
    <p class="hint">Click squares in the grid to add or remove hits (Shift + click: an accent). Drag across to paint. Click a drum’s name to hear it. Changes play on the next pass without stopping. Drag the part’s right edge to repeat the pattern for longer.</p>
    <p class="hint">Sounds are made by Tone.js (MIT licence) from synthesis, not recordings, so they are free to use in anything you release.</p>
    <div class="btnrow"><button class="btn sm" data-act="pathouse">House beat</button><button class="btn sm" data-act="patclear">Clear</button></div></div>`;
}
/* ---------- instrument (MIDI) parts ---------- */
// A part holds notes {id, p: pitch, t: seconds into the part's own material, d: length, v: velocity}.
// start/end window those notes the way an audio part windows its song, so trim, split and loop work the same.
/* The notes a part plays, on the timeline: as written, or turned into an arpeggio */
const ARP = { rates: { '4': 1, '8': 1 / 2, '16': 1 / 4, '32': 1 / 8, '8t': 1 / 3, '16t': 1 / 6 }, modes: { up: 'Up', down: 'Down', updown: 'Up and down', random: 'Random', order: 'As played' } };
function midiEvents(c) {
  const r = c.rate || 1, semi = c.semi || 0, held = [];
  for (const n of c.notes) { if (n.t < c.start - 1e-6 || n.t >= c.end) continue; held.push({ p: n.p + semi, a: c.at + (n.t - c.start) / r, b: c.at + (Math.min(n.t + n.d, c.end) - c.start) / r, v: n.v, t0: n.t }); }
  const arp = c.arp; if (!arp || !arp.on || !held.length) return held.map(h => ({ p: h.p, tl: h.a, d: h.b - h.a, v: h.v }));
  const rb = ARP.rates[arp.rate] || 1 / 4, oct = clamp(arp.oct || 1, 1, 3), gate = clamp(arp.gate ?? 0.6, 0.1, 1), out = [];
  const end = c.at + dur(c); let i = 0;
  for (let k = Math.ceil(beatAt(c.at) / rb - 1e-6); k < 100000; k++) {
    const tl = timeAtBeat(k * rb); if (tl >= end) break; if (tl < c.at - 1e-6) continue;
    const on = held.filter(h => h.a <= tl + 1e-4 && tl < h.b - 1e-4); if (!on.length) { i = 0; continue; }
    const base = arp.mode === 'order' ? [...on].sort((x, y) => x.t0 - y.t0).map(h => h.p) : [...new Set(on.map(h => h.p))].sort((x, y) => x - y);
    const pool = []; for (let o = 0; o < oct; o++) for (const p of base) pool.push(p + 12 * o);
    let idx;
    if (arp.mode === 'down') idx = pool.length - 1 - (i % pool.length);
    else if (arp.mode === 'updown') { const cyc = Math.max(1, pool.length * 2 - 2), j = i % cyc; idx = j < pool.length ? j : cyc - j; }
    else if (arp.mode === 'random') { let x = (k * 2654435761) >>> 0; x ^= x >>> 13; idx = x % pool.length; } // repeatable, so the same song renders the same
    else idx = i % pool.length;
    const stepSec = timeAtBeat((k + 1) * rb) - tl, v = Math.max(...on.map(h => h.v));
    out.push({ p: pool[idx], tl, d: Math.min(stepSec * gate, end - tl), v }); i++;
  }
  return out;
}
function scheduleMidi(ac, dest, c, startPos, when0) {
  const out = [];
  for (const e of midiEvents(c)) { if (e.tl < startPos - 1e-6) continue; out.push(...MixtapeMIDI.playNote(ac, dest, c.inst || 'piano', e.p, when0 + (e.tl - startPos), e.d, e.v)); }
  return out;
}
const midiName = c => c.name || MixtapeMIDI.INSTRUMENTS[c.inst] || 'Instrument';
function newMidiClip(lane, at, notes, extra = {}) {
  const end = Math.max(notes.reduce((m, n) => Math.max(m, n.t + n.d), 0), P.bpm ? 16 * 60 / P.bpm : 8);
  return { id: uid(), kind: 'midi', trackId: null, lane, at, start: 0, end, gain: 1, fadeIn: 0, fadeOut: 0, rate: 1, semi: 0, keepPitch: true, fxIn: 'fade', fxOut: 'fade', inst: 'piano', notes, ...extra };
}
/* A short groove built from the built-in instruments, so there is something to play and try things on at once */
function loadDemo() {
  const bpm = 96, b = 60 / bpm, bars = 8, prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], roots = [45, 41, 36, 43];
  const notes = { drums: [], bass: [], piano: [] };
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * b, ch = prog[bar % 4], root = roots[bar % 4];
    for (let q = 0; q < 8; q++) notes.drums.push({ id: uid(), p: 42, t: t0 + q * b / 2, d: 0.05, v: q % 2 ? 70 : 95 });
    [0, 2].forEach(q => notes.drums.push({ id: uid(), p: 36, t: t0 + q * b, d: 0.1, v: 120 }));
    [1, 3].forEach(q => notes.drums.push({ id: uid(), p: 38, t: t0 + q * b, d: 0.1, v: 110 }));
    [0, 1.5, 2, 3, 3.5].forEach((q, i) => notes.bass.push({ id: uid(), p: root + (i === 4 ? 12 : 0), t: t0 + q * b, d: b * 0.45, v: 100 }));
    ch.forEach(p => notes.piano.push({ id: uid(), p, t: t0, d: b * 1.8, v: 78 }, { id: uid(), p, t: t0 + 2 * b, d: b * 1.8, v: 70 }));
  }
  const p = newProject(); p.name = 'Demo groove'; p.bpm = bpm; p.lanes = []; p.clips = [];
  [['drums', 'Drums'], ['bass', 'Bass'], ['piano', 'Piano']].forEach(([inst, name], i) => {
    const l = newLane(name, PALETTE[(i * 3) % PALETTE.length]); p.lanes.push(l);
    p.clips.push({ ...newMidiClip(l.id, 0, notes[inst], { inst, name }), end: bars * 4 * b });
  });
  openProject(uid(), p);
  toast('Demo loaded. Press Space to play it, then try dragging parts, zooming with Ctrl + scroll, or double-click a part to edit its notes.', 7000);
}
function newInstrumentTrack(inst = SAMP.piano ? 's_piano' : 'piano') {
  const l = newLane((MixtapeMIDI.INSTRUMENTS[inst] || 'Instrument').replace(' · orchestra', '')); P.lanes.push(l);
  const c = newMidiClip(l.id, playhead, [], { inst, name: MixtapeMIDI.INSTRUMENTS[inst] });
  P.clips.push(c); selLane = l.id; selClip = c.id; edOpen = true;
  commit('New instrument track. Click in the note editor below to add notes.');
}
async function importMidi(file, at = playhead) {
  let m; try { m = MixtapeMIDI.parse(await file.arrayBuffer()); } catch (e) { return toast(`Could not read “${file.name}”: ${e.message}`, 6000); }
  if (!m.tracks.length) return toast(`“${file.name}” has no notes in it.`);
  let tempoMsg = '';
  if (!P.bpm || !P.clips.length) {
    P.bpm = m.tempos[0].bpm; P.tempoChanges = m.tempos.slice(1).map(x => ({ id: uid(), t: at + x.sec, bpm: x.bpm }));
    tempoMsg = ` Mix tempo set from the file: ${P.bpm} BPM${P.tempoChanges.length ? ` with ${P.tempoChanges.length} change${P.tempoChanges.length === 1 ? '' : 's'}` : ''}.`;
  } else if (Math.abs(m.tempos[0].bpm - P.bpm) > 0.05 || m.tempos.length > 1) tempoMsg = ` The file is at ${m.tempos[0].bpm} BPM; your mix tempo (${P.bpm}) was kept.`;
  let first = null; const emptyFirst = P.lanes.length === 1 && !P.clips.some(c => c.lane === P.lanes[0].id) ? P.lanes[0].id : null;
  m.tracks.forEach((tr, i) => {
    const l = newLane(tr.name, PALETTE[(P.lanes.length + i) % PALETTE.length]); P.lanes.push(l);
    const c = newMidiClip(l.id, at, tr.notes.map(n => ({ id: uid(), ...n })), { inst: gmFor(tr), name: tr.name, ...(tr.dyn ? { dyn: tr.dyn } : {}) });
    c.end = tr.notes.reduce((mx, n) => Math.max(mx, n.t + n.d), 0.5);
    P.clips.push(c); if (!first) first = c;
  });
  if (emptyFirst) P.lanes = P.lanes.filter(l => l.id !== emptyFirst); // the empty starter track is not needed
  selClip = first.id; selLane = first.lane;
  commit(`Imported “${file.name}”: ${m.tracks.length} instrument track${m.tracks.length === 1 ? '' : 's'}, ${m.tracks.reduce((s, t) => s + t.notes.length, 0)} notes.${tempoMsg}`);
  fitZoom();
}
function midiTickAt(ppq) { return t => Math.max(0, Math.round((P.bpm ? beatAt(t) - beatAt(0) : t * 2) * ppq)); }
function exportMidi() {
  const parts = P.clips.filter(c => c.kind === 'midi' && !c.mute);
  if (!parts.length) return toast('There are no instrument parts to export.');
  const byLane = new Map(); for (const c of parts) { if (!byLane.has(c.lane)) byLane.set(c.lane, []); byLane.get(c.lane).push(c); }
  let ch = 0;
  const tracks = [...byLane].map(([laneId, cs]) => {
    const l = P.lanes.find(x => x.id === laneId), drums = isKit(cs[0].inst), channel = drums ? 9 : (ch === 9 ? ++ch : ch++) % 16;
    const notes = cs.flatMap(c => c.notes.filter(n => n.t >= c.start && n.t < c.end).map(n => ({ p: n.p + (c.semi || 0), t: c.at + (n.t - c.start) / (c.rate || 1), d: Math.min(n.d, c.end - n.t) / (c.rate || 1), v: n.v })));
    return { name: l ? l.name : 'Instrument', channel, program: MixtapeMIDI.PROGRAM[cs[0].inst] ?? 0, notes, cc: cs.flatMap(dynCC) };
  });
  const tempos = P.bpm ? tempoSegs().map((s, i) => ({ sec: i ? s.t0 : 0, bpm: s.bpm })) : [{ sec: 0, bpm: 120 }];
  const bytes = MixtapeMIDI.write({ ppq: 480, tempos, tracks, tickAt: midiTickAt(480) });
  downloadBlob(new Blob([bytes], { type: 'audio/midi' }), safeName(P.name || 'My mix') + '.mid');
  toast(`Exported ${tracks.length} instrument track${tracks.length === 1 ? '' : 's'} as a MIDI file.`);
}
const gridLen = () => P.bpm ? 60 / P.bpm / 4 : 0.125;
function snapNoteT(c, t) { // to the nearest sixteenth of the mix tempo, in the part's own time
  const r = c.rate || 1, tl = c.at + (t - c.start) / r;
  const q = P.bpm ? timeAtBeat(Math.round(beatAt(tl) * 4) / 4) : Math.round(tl / 0.125) * 0.125;
  return c.start + (q - c.at) * r;
}
function quantize() {
  const c = clipById(selClip); if (!c || c.kind !== 'midi') return;
  c.notes = c.notes.map(n => ({ ...n, t: Math.max(0, snapNoteT(c, n.t)) }));
  commit(`Snapped ${c.notes.length} note${c.notes.length === 1 ? '' : 's'} to sixteenths`);
}
/* ---- scales and chords for the note editor ---- */
const SCALES = { major: ['Major', [0, 2, 4, 5, 7, 9, 11]], minor: ['Minor', [0, 2, 3, 5, 7, 8, 10]], harm: ['Harmonic minor', [0, 2, 3, 5, 7, 8, 11]], dorian: ['Dorian', [0, 2, 3, 5, 7, 9, 10]], mixo: ['Mixolydian', [0, 2, 4, 5, 7, 9, 10]], phryg: ['Phrygian', [0, 1, 3, 5, 7, 8, 10]], pmaj: ['Major pentatonic', [0, 2, 4, 7, 9]], pmin: ['Minor pentatonic', [0, 3, 5, 7, 10]], blues: ['Blues', [0, 3, 5, 6, 7, 10]] };
const pc = p => ((p % 12) + 12) % 12;
function partScale(c) { // the part's own scale, or else the mix key
  const s = c.scale || (P.key ? { root: P.key.key, type: P.key.mode === 'minor' ? 'minor' : 'major' } : null);
  if (!s || !SCALES[s.type]) return null; const steps = SCALES[s.type][1];
  return { root: s.root, type: s.type, steps, has: p => steps.includes(pc(p - s.root)) };
}
function nearestInScale(sc, p) { if (!sc) return p; for (let d = 0; d < 7; d++) { if (sc.has(p - d)) return p - d; if (sc.has(p + d)) return p + d; } return p; }
const CHORD_TOOLS = { '': 'Single notes', triad: 'Chords (3 notes, in the scale)', seventh: '7th chords (4 notes)', ninth: '9th chords (5 notes)', sus2: 'Sus2 chords', sus4: 'Sus4 chords', power: 'Power chords (root and 5th)', octave: 'Octaves' };
function chordAt(sc, p, kind) {
  if (kind === 'power') return [p, p + 7, p + 12];
  if (kind === 'octave') return [p, p + 12];
  const n = { triad: 3, seventh: 4, ninth: 5, sus2: 3, sus4: 3 }[kind]; if (!n) return [p];
  if (!sc || sc.steps.length !== 7) return { triad: [0, 4, 7], seventh: [0, 4, 7, 10], ninth: [0, 4, 7, 10, 14], sus2: [0, 2, 7], sus4: [0, 5, 7] }[kind].map(i => p + i);
  const deg = sc.steps.indexOf(pc(p - sc.root)); if (deg < 0) return [p];
  const at = k => p - sc.steps[deg] + sc.steps[(deg + k) % 7] + 12 * Math.floor((deg + k) / 7); // stack notes of the scale
  return (kind === 'sus2' ? [0, 1, 4] : kind === 'sus4' ? [0, 3, 4] : [0, 2, 4, 6, 8].slice(0, n)).map(at);
}
const CHORD_SHAPES = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]], ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['m7♭5', [0, 3, 6, 10]], ['dim7', [0, 3, 6, 9]], ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]], ['add9', [0, 2, 4, 7]], ['m(add9)', [0, 2, 3, 7]], ['9', [0, 2, 4, 7, 10]], ['maj9', [0, 2, 4, 7, 11]], ['m9', [0, 2, 3, 7, 10]], ['5', [0, 7]]];
function chordName(ps) {
  const pcs = [...new Set(ps.map(pc))]; if (pcs.length < 2) return null; const bass = pc(Math.min(...ps));
  for (const r of [bass, ...pcs.filter(x => x !== bass)]) {
    const set = pcs.map(x => pc(x - r)).sort((a, b) => a - b).join(), hit = CHORD_SHAPES.find(([, s]) => s.join() === set);
    if (hit) return KEYS[r] + hit[0] + (r !== bass ? '/' + KEYS[bass] : '');
  }
  return null;
}
const PROGS = { pop: ['Pop anthem · 1–5–6–4', [0, 4, 5, 3]], emo: ['Emotional · 6–4–1–5', [5, 3, 0, 4]], fifties: ['Fifties · 1–6–4–5', [0, 5, 3, 4]], jazz: ['Jazz · 2–5–1', [1, 4, 0, 0]], epic: ['Epic film · 1–6–3–7 (best in a minor key)', [0, 5, 2, 6]], andal: ['Dark, Spanish · 1–7–6–5 (minor)', [0, 6, 5, 4]], house: ['Deep house vamp · 1–4', [0, 3, 0, 3]], canon: ['Canon · 1–5–6–3–4–1–4–5', [0, 4, 5, 2, 3, 0, 3, 4]], blues: ['Twelve-bar blues', [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4]] };
const RHYTHMS = { hold: 'Held, one chord per bar', half: 'Held, two chords per bar', stabs: 'House stabs (off the beat)', pulse: 'Eighth-note pulse', arp: 'Held, with the arpeggiator on' };
async function writeChords() {
  const c = clipById(selClip); if (!c || c.kind !== 'midi') return toast('Select an instrument part first.');
  let sc = partScale(c); const noKey = !sc || sc.steps.length !== 7;
  const ch = await ask({ title: 'Write a chord progression', text: noKey ? 'This part has no 7-note scale, so the chords are in C major. Set a key or a scale in the settings to change that.' : `In ${KEYS[sc.root]} ${SCALES[sc.type][0].toLowerCase()}. The chords are spread so each one moves as little as possible from the last.`, ok: 'Write chords',
    extra: `<fieldset class="opts"><legend>Progression</legend><select name="prog">${Object.entries(PROGS).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select></fieldset>
      <fieldset class="opts"><legend>Rhythm</legend><select name="rh">${Object.entries(RHYTHMS).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></fieldset>
      <fieldset class="opts"><legend>Sound</legend><label><input type="checkbox" name="sev"> 7th chords (richer, jazzier)</label><label><input type="checkbox" name="bass" checked> Add the root note low in the bass</label><label><input type="checkbox" name="rep" ${c.notes.length ? '' : 'checked'}> Replace the notes already in this part</label>
      <label>Register <select name="reg"><option value="48">Low</option><option value="60" selected>Middle</option><option value="72">High</option></select></label></fieldset>`,
    read: f => ({ prog: f.querySelector('[name=prog]').value, rh: f.querySelector('[name=rh]').value, sev: f.querySelector('[name=sev]').checked, bass: f.querySelector('[name=bass]').checked, rep: f.querySelector('[name=rep]').checked, reg: +f.querySelector('[name=reg]').value }) });
  if (!ch || !ch.prog) return;
  if (noKey) sc = { root: 0, type: 'major', steps: SCALES.major[1], has: p => SCALES.major[1].includes(pc(p)) };
  const degs = PROGS[ch.prog][1], span = ch.rh === 'half' ? 2 : 4, r = c.rate || 1;
  const at = b => { const tl = P.bpm ? timeAtBeat(beatAt(c.at) + b) : c.at + b * 0.5; return c.start + (tl - c.at) * r; };
  const notes = ch.rep ? [] : c.notes.map(n => ({ ...n })), names = []; let prev = null;
  degs.forEach((d, i) => {
    const root = ch.reg + sc.root + sc.steps[d % 7], base = chordAt(sc, root, ch.sev ? 'seventh' : 'triad').sort((a, b) => a - b);
    const cands = []; let v = base; for (let k = 0; k < base.length; k++) { for (const sh of [-12, 0, 12]) cands.push(v.map(x => x + sh)); v = [...v.slice(1), v[0] + 12]; }
    const cost = a => prev ? a.reduce((s, x, j) => s + Math.abs(x - prev[j]), 0) : Math.abs(a[0] - ch.reg);
    const best = cands.filter(a => a[0] >= ch.reg - 7 && a[a.length - 1] <= ch.reg + 19).sort((x, y) => cost(x) - cost(y))[0] || base; prev = best;
    const b0 = i * span, hits = ch.rh === 'stabs' ? [0.5, 1.5, 2.5, 3.5].filter(x => x < span).map(x => [x, 0.25]) : ch.rh === 'pulse' ? [...Array(span * 2).keys()].map(k => [k / 2, 0.4]) : [[0, span * 0.98]];
    for (const [o, len] of hits) for (const p of best) notes.push({ id: uid(), p, t: at(b0 + o), d: at(b0 + o + len) - at(b0 + o), v: ch.rh === 'stabs' ? 100 : 84 });
    let bp = null; if (ch.bass) { bp = root - 12; while (bp >= best[0]) bp -= 12; notes.push({ id: uid(), p: bp, t: at(b0), d: at(b0 + span * 0.98) - at(b0), v: 90 }); }
    names.push(chordName(bp == null ? best : [bp, ...best]) || '?');
  });
  c.notes = notes; c.end = Math.max(c.end, at(degs.length * span));
  if (ch.rh === 'arp') c.arp = { mode: 'up', rate: '16', oct: 1, gate: 0.6, ...(c.arp || {}), on: true };
  edOpen = true; commit(`Wrote ${names.join(' – ')}`);
}
function fitToScale() {
  const c = clipById(selClip), sc = c && partScale(c); if (!sc) return toast('Set a key or a scale for this part first.');
  let n = 0; c.notes = c.notes.map(x => { const p = nearestInScale(sc, x.p); if (p !== x.p) n++; return { ...x, p }; });
  commit(n ? `Moved ${n} note${n === 1 ? '' : 's'} into ${KEYS[sc.root]} ${SCALES[sc.type][0].toLowerCase()}` : 'Every note is already in the scale');
}
/* ---- dynamics: an expression curve per part (like a mod wheel), louder and brighter as it rises ---- */
const dynGain = v => v <= 0.001 ? 0 : Math.pow(10, -30 * (1 - clamp(v, 0, 1)) / 20); // 0 is 30 dB down, 1 is full
const dynHz = v => 700 * Math.pow(20000 / 700, clamp(v, 0, 1));
const brightens = inst => isOrch(inst) || ['strings', 'brass', 'pad', 'lead'].includes(inst) || (isSamp(inst) && SAMP[inst.slice(2)].kind === 'gm' && SAMP[inst.slice(2)].program >= 40 && SAMP[inst.slice(2)].program < 80);
function dynamics(ac, c, src, startPos, when0) {
  if (!c.dyn || !c.dyn.length) return src;
  const r = c.rate || 1, raw = c.dyn.map(p => ({ t: c.at + (p.t - c.start) / r, v: p.v })).sort((a, b) => a.t - b.t);
  // follow the curve in small steps, so a swell rises evenly in loudness (decibels) rather than jumping up early
  const pts = []; for (let i = 0; i < raw.length; i++) { pts.push(raw[i]); const nx = raw[i + 1]; if (nx) for (let t = raw[i].t + 0.05; t < nx.t - 1e-3; t += 0.05) pts.push({ t, v: raw[i].v + (nx.v - raw[i].v) * (t - raw[i].t) / (nx.t - raw[i].t) }); }
  const dg = ac.createGain(); src.connect(dg); scheduleAuto(dg.gain, pts.map(p => ({ t: p.t, v: dynGain(p.v) })), startPos, when0, 1);
  if (!brightens(c.inst)) return dg;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; dg.connect(lp);
  scheduleAuto(lp.frequency, pts.map(p => ({ t: p.t, v: dynHz(p.v) })), startPos, when0, 20000); return lp;
}
function dynCC(c) { // the curve as MIDI controller 1 (mod wheel) for the exported file
  if (!c.dyn || !c.dyn.length) return [];
  const r = c.rate || 1, pts = [...c.dyn].sort((a, b) => a.t - b.t), out = []; let last = -1;
  for (let t = c.start; t <= c.end + 1e-6; t += 0.05 * r) { const v = Math.round(autoValue(pts, t, 1) * 127); if (v !== last) { out.push({ t: c.at + (t - c.start) / r, c: 1, v }); last = v; } }
  return out;
}
const thinDyn = pts => pts.filter((p, i, a) => !i || i === a.length - 1 || Math.abs(p.t - a[i - 1].t) > 0.02);
function dynPointer(e, wrap, c, V, rect) {
  if (e.clientX - rect.left < V.KW) { UI.dynMode = UI.dynMode === 'vel' ? 'dyn' : 'vel'; saveUI(); drawEditor(); return; }
  const vel = UI.dynMode === 'vel';
  const tAt = ev => V.t0 + (ev.clientX - rect.left - V.KW) / (V.w - V.KW) * (V.t1 - V.t0), vAt = ev => clamp(1 - (ev.clientY - rect.top - V.dynY0 - 3) / (V.DH - 6), 0, 1);
  if (!vel && e.detail >= 2) { delete c.dyn; commit('Dynamics cleared: the part plays at full volume'); return; }
  c.notes = c.notes.map(n => ({ ...n })); if (!vel) c.dyn = (c.dyn || []).map(p => ({ ...p }));
  let last = { t: tAt(e), v: vAt(e) };
  const apply = ev => {
    const t = tAt(ev), v = vAt(ev), a = Math.min(last.t, t), b = Math.max(last.t, t);
    if (vel) { const tol = (V.t1 - V.t0) / (V.w - V.KW) * 6; for (const n of c.notes) if (n.t >= a - tol && n.t <= b + tol) n.v = Math.max(1, Math.round(v * 127)); }
    else {
      c.dyn = c.dyn.filter(p => p.t < a - 1e-4 || p.t > b + 1e-4);
      if (b - a > 1e-4) c.dyn.push({ t: a, v: t < last.t ? v : last.v }, { t: b, v: t < last.t ? last.v : v }); else c.dyn.push({ t, v });
      c.dyn.sort((p, q) => p.t - q.t);
    }
    last = { t, v }; drawEditor();
  };
  apply(e);
  try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  const mv = ev => apply(ev);
  wrap.addEventListener('pointermove', mv);
  wrap.addEventListener('pointerup', () => { wrap.removeEventListener('pointermove', mv); if (!vel) c.dyn = thinDyn(c.dyn); commit(vel ? 'Note velocities changed' : 'Dynamics drawn'); }, { once: true });
}
let edNote = null, rollRange = null;
function drawPianoRoll(c, g, w, h) {
  // the pitch range holds still while you edit, and only grows when a note goes past it
  const ps = c.notes.map(n => n.p); let lo = ps.length ? Math.min(...ps) - 3 : 48, hi = ps.length ? Math.max(...ps) + 3 : 72;
  if (hi - lo < 24) { const mid = Math.round((hi + lo) / 2); lo = mid - 12; hi = mid + 12; }
  if (rollRange && rollRange.id === c.id) { lo = Math.min(lo, rollRange.lo); hi = Math.max(hi, rollRange.hi); if (ps.length && Math.min(...ps) >= rollRange.lo && Math.max(...ps) <= rollRange.hi) { lo = rollRange.lo; hi = rollRange.hi; } }
  lo = Math.max(0, lo); hi = Math.min(127, hi); rollRange = { id: c.id, lo, hi };
  const DH = h >= 120 ? Math.round(clamp(h * 0.24, 30, 80)) : 0, hr = h - DH; // the strip under the notes: dynamics or velocity
  const KW = 38, rows = hi - lo + 1, rowH = hr / rows, t0 = c.start, t1 = Math.max(c.end, t0 + 0.5);
  const X = t => KW + (t - t0) / (t1 - t0) * (w - KW), Y = p => (hi - p) * rowH;
  edView = { midi: true, lo, hi, KW, rowH, t0, t1, w, h, X, Y, dynY0: hr, DH };
  const black = p => [1, 3, 6, 8, 10].includes(p % 12), col = laneColor(c.lane), sc = partScale(c);
  for (let p = lo; p <= hi; p++) {
    g.fillStyle = black(p) ? 'rgba(0,0,0,.28)' : 'rgba(255,255,255,.025)'; g.fillRect(KW, Y(p), w - KW, rowH);
    if (sc && sc.has(p)) { g.fillStyle = pc(p - sc.root) === 0 ? 'rgba(255,196,64,.14)' : 'rgba(255,196,64,.055)'; g.fillRect(KW, Y(p), w - KW, rowH); } // notes of the scale glow
    g.fillStyle = black(p) ? '#1A1E25' : '#C9CED6'; g.fillRect(0, Y(p) + 0.5, KW - 2, Math.max(1, rowH - 1));
    if (p % 12 === 0 && rowH >= 7) { g.fillStyle = '#0D0F13'; g.font = `${Math.min(10, rowH)}px ${css('--f-mono')}`; g.textBaseline = 'middle'; g.fillText(`C${p / 12 - 1}`, 3, Y(p) + rowH / 2); }
    else if (sc && pc(p - sc.root) === 0 && rowH >= 7) { g.fillStyle = black(p) ? '#FFC440' : '#7A5A00'; g.font = `${Math.min(10, rowH)}px ${css('--f-mono')}`; g.textBaseline = 'middle'; g.fillText(KEYS[pc(p)], 3, Y(p) + rowH / 2); }
  }
  // beat lines in the part's own time
  if (P.bpm) {
    const r = c.rate || 1, tlA = c.at, tlB = c.at + (t1 - t0) / r;
    for (let b = Math.ceil(beatAt(tlA) * 4); b <= beatAt(tlB) * 4 + 1e-6 && b < 100000; b++) {
      const x = X(t0 + (timeAtBeat(b / 4) - c.at) * r); g.fillStyle = b % 16 === 0 ? 'rgba(255,255,255,.22)' : b % 4 === 0 ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.035)'; g.fillRect(Math.round(x), 0, 1, h);
    }
  }
  for (const n of c.notes) {
    const x = X(n.t), x2 = X(n.t + n.d); if (x2 < KW || x > w) continue;
    g.fillStyle = withAlpha(col, 0.45 + 0.55 * n.v / 127); g.fillRect(Math.max(KW, x), Y(n.p) + 1, Math.max(3, x2 - Math.max(KW, x) - 1), Math.max(2, rowH - 2));
    if (n.id === edNote) { g.strokeStyle = css('--ink'); g.lineWidth = 1.5; g.strokeRect(Math.max(KW, x) + 0.5, Y(n.p) + 1.5, Math.max(3, x2 - Math.max(KW, x) - 2), Math.max(2, rowH - 3)); }
    else if (sc && !sc.has(n.p)) { g.strokeStyle = 'rgba(255,110,110,.85)'; g.lineWidth = 1; g.setLineDash([2, 2]); g.strokeRect(Math.max(KW, x) + 0.5, Y(n.p) + 1.5, Math.max(3, x2 - Math.max(KW, x) - 2), Math.max(2, rowH - 3)); g.setLineDash([]); }
  }
  // chord names over notes that start together
  { const groups = new Map(); for (const n of c.notes) { const k = Math.round(n.t * 50); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n.p); }
    g.font = `600 10px ${css('--f-mono')}`; g.textBaseline = 'top'; let lastX = -99;
    for (const [k, st] of [...groups].sort((a, b) => a[0] - b[0])) { if (st.length < 2) continue; const tt = k / 50 + 0.01, ps = c.notes.filter(n => n.t <= tt && n.t + n.d > tt).map(n => n.p); const nm = chordName(ps), x = X(k / 50); if (!nm || x < KW || x > w - 10 || x - lastX < 34) continue; g.fillStyle = 'rgba(13,15,19,.75)'; g.fillRect(x + 1, 1, g.measureText(nm).width + 6, 13); g.fillStyle = '#FFD27A'; g.fillText(nm, x + 4, 2); lastX = x; }
    g.textBaseline = 'alphabetic'; }
  if (DH) { // the strip under the notes
    const y0 = hr, vel = UI.dynMode === 'vel', Yv = v => y0 + 3 + (1 - v) * (DH - 6);
    g.fillStyle = '#0B0D11'; g.fillRect(0, y0, w, DH); g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(0, y0, w, 1);
    g.fillStyle = css('--ink'); g.font = `700 9px ${css('--f-mono')}`; g.textBaseline = 'middle'; g.fillText(vel ? 'VEL' : 'DYN', 6, y0 + DH / 2 - 6);
    g.fillStyle = css('--muted'); g.font = `8px ${css('--f-mono')}`; g.fillText(vel ? '▸ dyn' : '▸ vel', 4, y0 + DH / 2 + 6);
    if (vel) for (const n of c.notes) { const x = Math.round(X(n.t)); if (x < KW || x > w) continue; const y = Yv(n.v / 127); g.fillStyle = withAlpha(col, .9); g.fillRect(x, y, 2, y0 + DH - y); g.fillRect(x - 2, y - 1, 6, 3); }
    else {
      const pts = [...(c.dyn || [])].sort((a, b) => a.t - b.t);
      if (!pts.length) { g.strokeStyle = 'rgba(255,255,255,.25)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(KW, Yv(1)); g.lineTo(w, Yv(1)); g.stroke(); g.setLineDash([]); g.fillStyle = css('--dim'); g.fillText('Full volume. Drag here to draw swells and fades; double-click to reset.', KW + 8, y0 + DH / 2 + 2); }
      else {
        const line = () => { g.moveTo(KW, Yv(pts[0].v)); for (const p of pts) g.lineTo(clamp(X(p.t), KW, w), Yv(p.v)); g.lineTo(w, Yv(pts[pts.length - 1].v)); };
        g.beginPath(); line(); g.lineTo(w, y0 + DH); g.lineTo(KW, y0 + DH); g.closePath(); g.fillStyle = withAlpha(col, .3); g.fill();
        g.beginPath(); line(); g.strokeStyle = col; g.lineWidth = 1.5; g.stroke();
      }
    }
    g.textBaseline = 'alphabetic';
  }
  const p = curPos() - c.at; if (p >= 0 && p <= dur(c)) { g.fillStyle = css('--danger'); g.fillRect(X(c.start + p * (c.rate || 1)), 0, 2, h); }
}
function pianoPointer(e, wrap, c) {
  const V = edView, rect = wrap.getBoundingClientRect(), free = e.altKey;
  const tAt = ev => V.t0 + (ev.clientX - rect.left - V.KW) / (V.w - V.KW) * (V.t1 - V.t0), pAt = ev => clamp(V.hi - Math.floor((ev.clientY - rect.top) / V.rowH), 0, 127);
  const sn = t => free ? t : snapNoteT(c, t), audition = p => { if (isSamp(c.inst)) return sampAudition(c.inst, p + (c.semi || 0)); if (HAS_TONE && isOrch(c.inst)) return orchAudition(c, p + (c.semi || 0)); if (HAS_TONE && TONE_INSTS[c.inst]) return toneAudition(c.inst, p + (c.semi || 0)); ctx.resume(); MixtapeMIDI.playNote(ctx, ctx.destination, c.inst || 'piano', p + (c.semi || 0), ctx.currentTime + 0.01, 0.35, 96); };
  if (V.DH && e.clientY - rect.top >= V.dynY0) return dynPointer(e, wrap, c, V, rect);
  if (e.clientX - rect.left < V.KW) return audition(pAt(e));
  const sc = partScale(c), sp = q => c.scaleLock && sc ? nearestInScale(sc, q) : q; let group = null;
  c.notes = c.notes.map(n => ({ ...n })); // parts split from one another share notes until one is edited
  const t = tAt(e), p = pAt(e);
  // a click can sit up to half a sixteenth before the note it snapped to, so allow for that
  const half = free ? 0 : gridLen() * (c.rate || 1) / 2;
  const hit = c.notes.find(n => n.p === p && t >= n.t && t <= n.t + n.d) || c.notes.find(n => n.p === p && t >= n.t - half - 1e-6 && t <= n.t + n.d + 1e-6);
  if (hit && e.detail >= 2) { c.notes = c.notes.filter(n => n !== hit); edNote = null; commit('Note removed'); return; }
  let n = hit, mode = 'move';
  if (n && V.X(n.t + n.d) - (e.clientX - rect.left) < 7) mode = 'len';
  if (!n) { // a new note, or a whole chord when the chord tool is on
    const t1 = Math.max(c.start, sn(t)), d1 = P.bpm ? 60 / P.bpm : 0.5, ps = chordAt(sc, sp(p), UI.chord || '');
    group = ps.map(q => ({ id: uid(), p: clamp(q, 0, 127), t: t1, d: d1, v: 96 })); n = group[0]; if (n.t >= c.end) c.end = n.t + n.d;
    c.notes.push(...group); mode = 'len'; group.forEach(x => audition(x.p)); if (group.length === 1) group = null;
  }
  edNote = n.id;
  const o = { t: n.t, p: n.p, d: n.d }, t0 = t, p0 = p;
  try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  const mv = ev => {
    if (mode === 'move') { n.t = Math.max(0, sn(o.t + tAt(ev) - t0)); const np = clamp(sp(o.p + pAt(ev) - p0), 0, 127); if (np !== n.p) { n.p = np; audition(np); } }
    else { n.d = Math.max(free ? 0.02 : gridLen() * (c.rate || 1), sn(tAt(ev)) - n.t); if (group) group.forEach(x => { x.d = n.d; }); }
    if (n.t + n.d > c.end) c.end = n.t + n.d;
    drawEditor();
  };
  wrap.addEventListener('pointermove', mv);
  wrap.addEventListener('pointerup', () => { wrap.removeEventListener('pointermove', mv); commit(); }, { once: true });
  drawEditor();
}
function midiInspectorHTML(c) {
  const opts = instOptions(c.inst);
  const semi = c.semi || 0, inWin = c.notes.filter(n => n.t >= c.start && n.t < c.end).length;
  return `<div class="sec"><h3>Instrument part</h3>
    <dl class="kv"><dt>Part</dt><dd>${esc(midiName(c))}</dd><dt>Notes</dt><dd>${inWin}</dd><dt>Starts at</dt><dd>${fmtT(c.at)}</dd><dt>Length</dt><dd>${fmtT(dur(c))}</dd></dl>
    <div class="field"><label for="cInst">Sound</label><select id="cInst" data-cf="inst">${opts}</select><span></span></div>
    ${isOrch(c.inst) ? `<div class="field"><label for="cArt">Playing</label><select id="cArt" data-cf="art">${orchArts(c.inst).map(a => `<option value="${a}" ${orchArtOf(c) === a ? 'selected' : ''}>${ARTS[a] || a}</option>`).join('')}</select><span></span></div>
    <p class="hint">Recorded orchestra: VSCO 2 Community Edition by Versilian Studios (Sam Gossner) and Ivy Audio (Simon Dalzell), public domain (CC0). Free to use in anything you make. Long notes last up to about 4 seconds.</p>` : ''}
    <div class="field"><label for="cGain">Volume</label><input id="cGain" type="range" min="0" max="300" value="${Math.round((c.gain ?? 1) * 100)}" data-cf="gain"><output>${Math.round((c.gain ?? 1) * 100)}%</output></div>
    <label class="chk"><input type="checkbox" data-pin ${c.pin ? 'checked' : ''}> Pin to the picture (stays on its cut)</label>
    ${isSamp(c.inst) ? `<p class="hint">Recorded: ${esc(SAMP[c.inst.slice(2)].credit)}. Free to use in anything you make.</p>` : ''}
    <label class="chk"><input type="checkbox" data-arp="on" ${c.arp && c.arp.on ? 'checked' : ''}> Arpeggiator: play held chords as rolling notes</label>
    ${c.arp && c.arp.on ? `<div class="field"><label for="aMode">Pattern</label><select id="aMode" data-arp="mode">${Object.entries(ARP.modes).map(([k, v]) => `<option value="${k}" ${c.arp.mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>
    <div class="field"><label for="aRate">Speed</label><select id="aRate" data-arp="rate">${[['4', 'Quarter notes'], ['8', '8ths'], ['16', '16ths'], ['32', '32nds'], ['8t', '8th triplets'], ['16t', '16th triplets']].map(([k, v]) => `<option value="${k}" ${c.arp.rate === k ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>
    <div class="field"><label for="aOct">Octaves</label><select id="aOct" data-arp="oct">${[1, 2, 3].map(n => `<option value="${n}" ${c.arp.oct === n ? 'selected' : ''}>${n}</option>`).join('')}</select><span></span></div>
    <div class="field"><label for="aGate">Note length</label><input id="aGate" type="range" min="10" max="100" value="${Math.round((c.arp.gate ?? 0.6) * 100)}" data-arp="gate"><output>${Math.round((c.arp.gate ?? 0.6) * 100)}%</output></div>` : ''}
    <div class="field"><label for="cSemiM">Transpose</label><input id="cSemiM" type="range" min="-24" max="24" value="${semi}" data-cf="semi"><output>${semi > 0 ? '+' : ''}${semi}</output></div>
    <p class="sub">Scale and chords</p>
    ${(() => { const sc = c.scale; const fol = P.key ? keyName(P.key.key, P.key.mode) : 'not set'; return `<div class="field"><label for="cScale">Scale</label><select id="cScale" data-cscale="type"><option value="" ${!sc ? 'selected' : ''}>The mix key (${fol})</option><option value="none" ${sc && sc.type === 'none' ? 'selected' : ''}>No scale</option>${Object.entries(SCALES).map(([k, [n]]) => `<option value="${k}" ${sc && sc.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select><span></span></div>
    ${sc && SCALES[sc.type] ? `<div class="field"><label for="cRoot">Key note</label><select id="cRoot" data-cscale="root">${KEYS.map((k, i) => `<option value="${i}" ${sc.root === i ? 'selected' : ''}>${k}</option>`).join('')}</select><span></span></div>` : ''}`; })()}
    <label class="chk"><input type="checkbox" data-cscale="lock" ${c.scaleLock ? 'checked' : ''}> Keep new and moved notes in the scale</label>
    <div class="field"><label for="cChord">Click adds</label><select id="cChord" data-uichord>${Object.entries(CHORD_TOOLS).map(([k, v]) => `<option value="${k}" ${(UI.chord || '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>
    <div class="btnrow"><button class="btn sm" data-act="writechords">Write a chord progression…</button><button class="btn sm" data-act="fitscale">Move stray notes into the scale</button></div>
    <p class="sub">Dynamics</p>
    <div class="btnrow"><button class="btn sm" data-act="dynp" data-k="swell" title="Start soft and grow">Swell</button><button class="btn sm" data-act="dynp" data-k="fade" title="Start full and die away">Fade</button><button class="btn sm" data-act="dynp" data-k="hairpin" title="Grow to the middle, then die away">Swell, then fade</button><button class="btn sm" data-act="dynp" data-k="clear" title="Back to full volume">Full</button></div>
    <p class="hint">Or draw it in the strip under the notes. Softer also means darker, the way real ${isOrch(c.inst) ? 'orchestral players sound' : 'instruments sound'}. Click the strip’s label to edit each note’s velocity instead.</p>
    <p class="sub">Play and record</p>
    <div class="btnrow"><button class="btn sm" data-act="midiconnect">${midiNames().length ? `Keyboard: ${esc(midiNames().join(', '))}` : 'Connect a MIDI keyboard'}</button><button class="btn sm tgl" data-act="qwerty" aria-pressed="${qwerty}" title="A W S E D F T G Y H U J K play notes; Z and X change octave; Esc stops">Play with computer keys</button></div>
    <div class="btnrow"><button class="btn sm rec${recNotes ? ' on' : ''}" data-act="recnotes"><span class="dot"></span>${recNotes ? 'Stop recording' : 'Record notes into this part'}</button></div>
    <label class="chk"><input type="checkbox" data-uiset="recQ" ${UI.recQ ? 'checked' : ''}> Snap recorded notes to 1/16</label>
    <label class="chk"><input type="checkbox" data-uiset="recClick" ${UI.recClick !== false ? 'checked' : ''}> Click while recording</label>
    <p class="hint">Recording starts one bar early so you can come in on time. Press Space to stop. The sustain pedal works, and the mod wheel records into the dynamics.</p>
    <p class="hint">Double-click the part to open the note editor. Click to add a note, drag to move it, drag its right edge to lengthen it, double-click to remove it. Notes snap to sixteenths; hold Alt to place them freely. Click the keyboard to hear a pitch.</p>
    <p class="hint">These built-in sounds are for writing and placing. The production studio renders the finished parts with sampled instruments from the MIDI file.</p>
    <div class="btnrow"><button class="btn sm" data-act="quantize">Snap notes to 1/16</button><button class="btn sm" data-act="exportmidi">Export MIDI</button></div></div>`;
}
function buildGraph(ac, startPos, when0, opts = {}) {
  const master = ac.createGain(); master.gain.value = P.master ?? 1;
  let out = master; const masterDevs = {}, live = ac === ctx, ms = MS(), mastered = ms.preset !== 'none' && !opts.lane;
  if (!opts.lane) for (const dev of (P.masterChain || [])) { // the master's own effects (stems are printed before them)
    if (!dev.on) continue; let d; try { d = buildDevice(ac, dev); } catch (e) { continue; }
    link(out, d.in); out = d.out; masterDevs[dev.id] = d;
  }
  if (P.polish) { // one-tap mastering: gentle compression, more level, peak catcher
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -20; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.006; comp.release.value = 0.2;
    const make = ac.createGain(); make.gain.value = 1.9;
    const lim = ac.createDynamicsCompressor(); lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    out.connect(comp); comp.connect(make); make.connect(lim); out = lim;
  }
  if (mastered && live) { // hear it as loud as the export will be: the gain "Check the master" found, then a fast peak catcher
    const mg = ac.createGain(); mg.gain.value = Math.pow(10, (ms.gainDb || 0) / 20);
    const lim = ac.createDynamicsCompressor(); lim.threshold.value = ms.ceiling - 0.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
    out.connect(mg); mg.connect(lim); out = lim;
  } else if (P.limit.on && !opts.lane) { // while playing: a fast compressor near the ceiling; saving and delivering use the exact true-peak limiter
    const lim = ac.createDynamicsCompressor(); lim.threshold.value = P.limit.ceiling - 0.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
    out.connect(lim); out = lim;
  }
  let monoSw = null;
  if (live) { // the Mono button: the same mix folded to one channel, swapped in without a restart
    const st = ac.createGain(), mono = ac.createGain(), mg = ac.createGain();
    mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
    st.gain.value = monoOn ? 0 : 1; mg.gain.value = monoOn ? 1 : 0;
    out.connect(st); st.connect(ac.destination); out.connect(mono); mono.connect(mg); mg.connect(ac.destination); monoSw = { st, mg };
  } else out.connect(ac.destination);
  const lanes = new Map();
  // one track on its own (a stem) is printed through its whole path: its group and the shared effects it sends to,
  // so the stems add up to the mix. A group on its own brings the tracks that feed it.
  const only = opts.lane && P.lanes.find(x => x.id === opts.lane);
  let want = P.lanes;
  if (only) {
    const set = new Set([only]), grp = only.out && P.lanes.find(x => x.id === only.out && x.type === 'group');
    if (only.type === 'group') P.lanes.filter(x => x.out === only.id).forEach(x => set.add(x));
    if (grp) set.add(grp);
    for (const x of [...set]) for (const [rid, lv] of Object.entries(x.sends || {})) { const R = lv > 0 && P.lanes.find(y => y.id === rid && y.type === 'return'); if (R) set.add(R); }
    want = P.lanes.filter(x => set.has(x));
  }
  for (const l of want) {
    const ln = buildLane(ac, l, master, !!only && (l === only || !l.mute)); lanes.set(l.id, ln); // a muted group or return stays muted in a stem
    scheduleAuto(ln.ag.gain, l.auto.vol, startPos, when0, 1);
    if (l.auto.pan.length) scheduleAuto(ln.pan.pan, l.auto.pan, startPos, when0, l.pan);
  }
  for (const l of want) {
    const ln = lanes.get(l.id), grp = l.type !== 'group' && l.out && P.lanes.find(x => x.id === l.out && x.type === 'group');
    ln.pan.connect(grp && lanes.get(grp.id) ? lanes.get(grp.id).g : master);
    for (const [rid, lv] of Object.entries(l.sends || {})) { // sends after the fader, to shared effect returns
      const R = P.lanes.find(x => x.id === rid && x.type === 'return'), rl = lanes.get(rid); if (!R || !rl || rid === l.id || !(lv > 0)) continue;
      const s = ac.createGain(); s.gain.value = lv; ln.pan.connect(s); s.connect(rl.g);
    }
  }
  const srcs = [], toneNodes = [...lanes.values()].flatMap(x => x.toneFx || []), mouts = [];
  const pat = { startPos, when0, upto: startPos, stopAt: Infinity, voices: new Map(), pumps: new Map(), gates: new Map() };
  for (const l of P.lanes) { const ln = lanes.get(l.id); if (!ln) continue; for (const dev of (l.chain || [])) { const d = ln.devs[dev.id]; if (d && d.gate) pat.gates.set(dev.id, { node: d.gate, steps: GATES[dev.gate || 'classic'] || GATES.classic, depth: clamp(dev.amt ?? 0.9, 0.1, 1) }); } }
  for (const l of P.lanes) { const ln = lanes.get(l.id); if (ln && l.pump && l.pump.on) pat.pumps.set(l.id, { pg: ln.pg, depth: clamp(l.pump.depth ?? 0.7, 0.1, 0.95), release: 0.45 * 60 / (P.bpm || 124) }); }
  for (const c of P.clips) {
    if (c.mute) continue;
    if (c.kind === 'riser') {
      const ln = lanes.get(c.lane); if (!ln || c.at + dur(c) <= startPos) continue;
      const g = ac.createGain(); envelope(g.gain, c, startPos, when0); g.connect(ln.g);
      srcs.push(...scheduleRiser(ac, g, c, startPos, when0)); continue;
    }
    if (c.kind === 'pattern') {
      const ln = lanes.get(c.lane); if (!ln || !HAS_TONE || c.at + dur(c) <= startPos) continue;
      const g = ac.createGain(); envelope(g.gain, c, startPos, when0); g.connect(ln.g);
      const kit = String(c.pat.kit).startsWith('s:') && SAMP[c.pat.kit.slice(2)] ? sampKit(ac, c.pat.kit.slice(2), g) : makeKit(toneFor(ac), c.pat.kit || '909', g); pat.voices.set(c.id, kit); toneNodes.push(...kit.nodes); continue;
    }
    if (c.kind === 'midi') {
      const ln = lanes.get(c.lane); if (!ln || c.at + dur(c) <= startPos) continue;
      const mo = ac === ctx && laneAudible(P.lanes.find(x => x.id === c.lane) || {}) ? moutOf(P.lanes.find(x => x.id === c.lane)) : null;
      if (mo) { // played by the outside instrument (saving still uses Mixtape's own sound for this part)
        const evs = [];
        for (const e of midiEvents(c)) if (e.tl >= startPos - 1e-6) { const w = when0 + (e.tl - startPos), p = clamp(e.p, 0, 127); evs.push({ kind: 'on', when: w, p, v: e.v }, { kind: 'off', when: w + Math.max(0.01, e.d) - 0.001, p }); }
        for (const x of dynCC(c)) if (x.t >= startPos - 0.05) evs.push({ kind: 'cc', when: when0 + Math.max(0, x.t - startPos), cc: x.c, v: x.v });
        evs.sort((a, b) => a.when - b.when || (a.kind === 'off' ? -1 : 1));
        mouts.push({ mo, evs, i: 0, on: new Map() });
        if (!mo.inside) continue;
      }
      const g = ac.createGain(); envelope(g.gain, c, startPos, when0); dynamics(ac, c, g, startPos, when0).connect(ln.g);
      if (isSamp(c.inst)) { // recorded instruments
        const v = makeSampled(ac, c.inst.slice(2), g);
        for (const e of midiEvents(c)) if (e.tl >= startPos - 1e-6) v.play(e.p, when0 + (e.tl - startPos), e.d, e.v);
        continue;
      }
      if (HAS_TONE && (TONE_INSTS[c.inst] || isOrch(c.inst))) { // Tone.js synths and the orchestra
        const v = isOrch(c.inst) ? makeOrch(toneFor(ac), c, g) : makeToneInst(toneFor(ac), c.inst, g); toneNodes.push(...v.nodes);
        const evs = midiEvents(c).filter(e => e.tl >= startPos - 1e-6).map(e => ({ ...e, when: when0 + (e.tl - startPos) }));
        if (v.playSeq) v.playSeq(evs); else for (const e of evs) v.play(e.p, e.when, e.d, e.v);
        continue;
      }
      srcs.push(...scheduleMidi(ac, g, c, startPos, when0)); continue;
    }
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
  if (opts.metro) srcs.push(...scheduleClicks(ac, ac.destination, startPos, when0, projectEnd() + 1));
  const mmeter = ac.createAnalyser(); mmeter.fftSize = 2048; out.connect(mmeter); keepAlive(ac, mmeter);
  const worklets = [...[...lanes.values()].flatMap(x => Object.values(x.devs || {})), ...Object.values(masterDevs)].map(d => d.worklet).filter(Boolean);
  const gr = { master, out, lanes, srcs, mmeter, toneNodes, pat, forceLane: opts.lane || null, masterDevs, monoSw, worklets, mout: mouts };
  // saving: every hit now. Playing: the first moment now, the rest just ahead of the music (see tick)
  schedulePatterns(gr, ac === ctx ? startPos + 0.35 : startPos + 36000);
  if (mouts.length) scheduleMidiOut(gr, when0 + 0.35);
  return gr;
}
// Level meters must be wired through to the output (silently) or the browser skips measuring them
function keepAlive(ac, node) { const z = ac.createGain(); z.gain.value = 0; node.connect(z); z.connect(ac.destination); }
/* metronome: a short click on every beat, higher on the first beat of each bar */
function clickAt(ac, dest, when, accent) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = accent ? 1760 : 1100; o.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.start(when); o.stop(when + 0.06); return o;
}
function scheduleClicks(ac, dest, startPos, when0, until) {
  if (!P.bpm) return [];
  const out = []; let b = Math.ceil(beatAt(startPos) - 1e-6);
  for (let t = timeAtBeat(b); t < until && out.length < 4000; b++, t = timeAtBeat(b)) out.push(clickAt(ac, dest, when0 + (t - startPos), b % 4 === 0));
  return out;
}
const hasTails = () => P.clips.some(c => c.fxOut === 'echo') || P.lanes.some(l => l.fx.echo > 0 || l.fx.reverb > 0 || (l.chain || []).some(d => d.on && ['hall', 'pingpong'].includes(d.type))) || (P.masterChain || []).some(d => d.on && ['hall', 'pingpong'].includes(d.type));

/* ---------- playback ---------- */
let playing = false, pos0 = 0, t0 = 0, graph = null, preview = null, tickT = null, previewT = null, pendingLoop = null;
async function ensureAll() {
  for (const id of new Set(P.clips.map(c => c.trackId).filter(Boolean))) await ensureBuf(id);
  for (const c of P.clips) await ensureProc(c);
  for (const c of P.clips) if (c.kind === 'midi' && !c.mute) await ensureOrch(c);
  for (const c of P.clips) if (!c.mute) { if (c.kind === 'midi') await ensureSamp(c); if (c.kind === 'pattern' && String(c.pat.kit).startsWith('s:') && SAMP[c.pat.kit.slice(2)]) { await loadSamp(c.pat.kit.slice(2)); if (kitGaps(c.pat.kit.slice(2))) await loadSamp('kit0'); } }
  if (laneHasFx('lofi')) await ensureLofi(ctx);
}
async function play() {
  stopPreview();
  if (!P.clips.length && !P.video) { toast('Add a song from the left to start.'); return false; }
  try { await ensureAll(); } catch (err) { toast(err.message, 5000); return false; }
  await ctx.resume();
  if (playhead >= projectEnd() - 0.02) playhead = 0;
  if (loopActive() && (playhead < P.loop.a || playhead >= P.loop.b - 0.05)) playhead = P.loop.a;
  pendingLoop = null;
  pos0 = playhead; t0 = ctx.currentTime + (P.lanes.some(l => moutOf(l)) ? 0.3 : 0.05); // an outside instrument needs a moment so its first notes are not late
  graph = buildGraph(ctx, pos0, t0, { metro: P.metro || (!!recNotes && UI.recClick !== false) }); playing = true; renderTransport(); clearInterval(tickT); tickT = setInterval(tick, 33);
  if (P.video) { await ensureVideoEl(); syncVideo(); }
  return true;
}
function pause() {
  if (recNotes) finishRecNotes(false);
  if (!playing) return;
  playhead = curPos(); playing = false; clearInterval(tickT);
  for (const gr of [graph, pendingLoop && pendingLoop.graph]) if (gr) { midiOutSilence(gr); gr.srcs.forEach(s => { try { s.stop(); } catch (e) {} }); try { gr.out.disconnect(); gr.master.disconnect(); } catch (e) {} disposeTone(gr); }
  graph = null; pendingLoop = null; if (vidFor && !vid.paused) vid.pause(); renderTransport(); drawPlayhead();
}
const curPos = () => playing ? pos0 + Math.max(0, ctx.currentTime - t0) : playhead;
function disposeTone(gr) { (gr.worklets || []).forEach(n => { try { n.port.postMessage('end'); n.disconnect(); } catch (e) {} }); gr.worklets = []; const ns = gr.toneNodes || []; gr.toneNodes = []; setTimeout(() => ns.forEach(n => { try { n.dispose(); } catch (e) {} }), 1500); }
function restartIfPlaying() { if (playing && !rec) { pause(); play(); } }
function tick() {
  if (!playing) return clearInterval(tickT);
  if (loopActive() && graph && !rec) {
    const L = P.loop, now = ctx.currentTime;
    // schedule the next pass a moment early so the loop is seamless
    if (!pendingLoop && pos0 < L.b && pos0 + (now - t0) >= L.b - 0.3) {
      const tEnd = t0 + (L.b - pos0);
      graph.srcs.forEach(s => { try { s.stop(tEnd); } catch (e) {} });
      if (graph.pat) graph.pat.stopAt = L.b;
      pendingLoop = { graph: buildGraph(ctx, L.a, tEnd, { metro: P.metro || (!!recNotes && UI.recClick !== false) }), t0: tEnd };
    }
    if (pendingLoop && now >= pendingLoop.t0) {
      const old = graph; graph = pendingLoop.graph; pos0 = L.a; t0 = pendingLoop.t0; pendingLoop = null;
      setTimeout(() => { try { old.out.disconnect(); old.master.disconnect(); } catch (e) {} disposeTone(old); }, 400);
    }
  }
  // drum machine hits, scheduled a third of a second ahead of the music
  for (const gr of [graph, pendingLoop && pendingLoop.graph]) if (gr && gr.pat) schedulePatterns(gr, gr.pat.startPos + (ctx.currentTime + 0.35 - gr.pat.when0));
  for (const gr of [graph, pendingLoop && pendingLoop.graph]) if (gr && gr.mout && gr.mout.length) scheduleMidiOut(gr, ctx.currentTime + 0.35);
  const p = curPos();
  if (edOpen && clipById(selClip)?.kind === 'pattern') drawEditor();
  if (p >= projectEnd() && !rec && !loopActive()) { pause(); playhead = projectEnd(); drawPlayhead(); return; }
  drawPlayhead(p); followPlayhead(p); if (rec || (P.tempoChanges || []).length) renderTransport(); if (P.video) syncVideo();
  if (UI.mixer) updateMeters();
  updateDeviceMeters();
}
function liveLanes() {
  if (!graph) return; const now = ctx.currentTime;
  graph.master.gain.setTargetAtTime(P.master ?? 1, now, 0.02);
  for (const l of P.lanes) {
    const n = graph.lanes.get(l.id); if (!n) continue;
    n.g.gain.setTargetAtTime(laneAudible(l) ? l.gain : 0, now, 0.02); if (!l.auto.pan.length) n.pan.pan.setTargetAtTime(l.pan, now, 0.02);
    n.bass.gain.setTargetAtTime(l.fx.bass, now, 0.02); n.treble.gain.setTargetAtTime(l.fx.treble, now, 0.02);
    setFilter(n.filt, l.fx.filter); n.echoSend.gain.setTargetAtTime(l.fx.echo / 100, now, 0.02); n.revSend.gain.setTargetAtTime(l.fx.reverb / 100 * 0.8, now, 0.02);
    n.delay.delayTime.setTargetAtTime(echoTime(), now, 0.05);
  }
}
/* A click on the timeline: outside a running loop, the loop switches off so playback goes where you clicked */
function seekClick(t) {
  if (loopActive() && P.loopLock && (t < P.loop.a - 1e-3 || t >= P.loop.b)) { if (performance.now() - (seekClick.told || 0) > 3000) { seekClick.told = performance.now(); toast('The loop is locked, so playback stays in it. Click inside the loop, or press Lock to unlock.', 3500); } return; }
  if (loopActive() && (t < P.loop.a - 1e-3 || t >= P.loop.b)) { P.loopOn = false; quietCommit(); renderLoop(); renderRuler(); renderTransport(); toast('Loop off. Press L to turn it back on.', 2500); }
  seek(t);
}
function seek(t) {
  const to = clamp(t, 0, Math.max(projectEnd(), 0));
  // stopping remembers where playback was, so set the new spot after stopping, not before
  if (playing && !rec) { pause(); playhead = to; play(); } else { playhead = to; drawPlayhead(); }
}
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
  // one bar of count-in clicks; the recording is trimmed to start when the music starts
  { const bl = P.bpm ? 60 / tempoAt(playhead) : 0.6; await ctx.resume(); const t = ctx.currentTime + 0.05;
    for (let i = 0; i < 4; i++) clickAt(ctx, ctx.destination, t + i * bl, i === 0);
    toast('Count-in: 1, 2, 3, 4…', bl * 4 * 1000); await new Promise(r => setTimeout(r, (bl * 4 + 0.05) * 1000)); }
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
    commit(`Saved “${title}” and added it on a new track`);
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
  let stems = stemsOf(src.id), choice = null;
  if (stems) {
    choice = await ask({ title: `Split “${src.title}”`, ok: 'Add tracks', text: 'This song is already split, so this is instant.', extra: stemChoiceHTML(), read: readStemChoice });
    if (!choice) return;
  }
  if (!stems) {
    const saved = await modelSaved();
    let speed = 0; try { speed = +localStorage.getItem(SPEED_KEY) || 0; } catch (e) {}
    const songMin = (src.duration || 180) / 60;
    const howLong = speed
      ? `Last time, this laptop needed about ${Math.max(1, Math.round(speed))} minutes for every minute of music, so this song should take about ${Math.max(1, Math.round(speed * songMin))} minutes.`
      : 'This is heavy work for a laptop: expect several minutes for every minute of music, and the first section is the slowest while the AI warms up.';
    choice = await ask({ title: `Split “${src.title}”?`, ok: 'Split song',
      text: (saved ? '' : 'The first time, Mixtape downloads the AI model (181 MB). After that it works offline. ')
        + howLong + ' Keep Mixtape open and in front while it works. You can cancel at any time, and each song only needs splitting once.',
      extra: stemChoiceHTML(), read: readStemChoice });
    if (!choice) return;
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
  // Put each chosen stem on its own track, lined up exactly where the part was
  const keys = choice.stems, at = P.lanes.findIndex(l => l.id === c.lane);
  const newLanes = keys.map(k => newLane(STEMS[k]));
  P.lanes.splice(at + 1, 0, ...newLanes);
  keys.forEach((k, i) => P.clips.push({ ...c, id: uid(), trackId: stems[k].id, lane: newLanes[i].id, mute: false }));
  if (choice.orig === 'replace') P.clips = P.clips.filter(x => x !== c); else c.mute = true;
  selClip = null; selLane = newLanes[0].id; tlSel = null;
  for (const k of keys) { try { await ensureBuf(stems[k].id); } catch (e) {} }
  commit(`Added ${keys.length === 1 ? 'a ' + STEMS[keys[0]].toLowerCase() + ' track' : keys.length + ' tracks'}.${choice.orig === 'replace' ? '' : ' The original part is muted; right-click it to unmute.'}`);
}


/* ---------- saving the mix as a song ---------- */
function encodeWav(buf, scale, wav) {
  const data = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) data.push(buf.getChannelData(c));
  return encodeWavData(data, buf.sampleRate, scale, wav);
}
// 16-bit by default; deliveries are 24-bit with a Broadcast WAV "bext" chunk saying where the first sample sits in the programme
function encodeWavData(data, sr, scale = 1, { bits = 16, bext = null } = {}) {
  const ch = data.length, n = data[0].length, bps = bits / 8, dataLen = n * ch * bps, bextLen = bext ? 602 : 0;
  const total = 12 + 24 + (bext ? 8 + bextLen : 0) + 8 + dataLen;
  const ab = new ArrayBuffer(total), v = new DataView(ab);
  const w = (o, s, max = s.length) => { for (let i = 0; i < Math.min(s.length, max); i++) v.setUint8(o + i, s.charCodeAt(i) & 0x7f); };
  w(0, 'RIFF'); v.setUint32(4, total - 8, true); w(8, 'WAVE');
  let o = 12;
  w(o, 'fmt '); v.setUint32(o + 4, 16, true); v.setUint16(o + 8, 1, true); v.setUint16(o + 10, ch, true); v.setUint32(o + 12, sr, true);
  v.setUint32(o + 16, sr * ch * bps, true); v.setUint16(o + 20, ch * bps, true); v.setUint16(o + 22, bits, true); o += 24;
  if (bext) {
    w(o, 'bext'); v.setUint32(o + 4, bextLen, true); const b = o + 8, now = new Date(), p2 = x => String(x).padStart(2, '0');
    w(b, bext.description || '', 256); w(b + 256, bext.originator || 'Mixtape Studio', 32); w(b + 288, bext.originatorRef || '', 32);
    w(b + 320, `${now.getFullYear()}:${p2(now.getMonth() + 1)}:${p2(now.getDate())}`, 10); w(b + 330, `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`, 8);
    const tr = Math.max(0, Math.round(bext.timeReference || 0));
    v.setUint32(b + 338, tr % 4294967296, true); v.setUint32(b + 342, Math.floor(tr / 4294967296), true); v.setUint16(b + 346, 1, true);
    o += 8 + bextLen;
  }
  w(o, 'data'); v.setUint32(o + 4, dataLen, true); o += 8;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = clamp(data[c][i] * scale, -1, 1);
    if (bits === 24) { const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    else { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
async function renderMix(opts = {}) {
  await ensureAll();
  const from = opts.from || 0, to = opts.to ?? projectEnd();
  const end = (to - from) + (hasTails() ? (hasHall() ? 6 : 2.5) : 0), sr = ctx.sampleRate; // a big hall rings for about 5.5 s
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(end * sr)), sr);
  if (laneHasFx('lofi')) await ensureLofi(oc);
  buildGraph(oc, from, 0, { lane: opts.lane });
  const out = await oc.startRendering();
  const chs = [...Array(out.numberOfChannels)].map((_, i) => out.getChannelData(i));
  let limited = null, gainDb = opts.gainDb || 0, lufs0 = NaN;
  if (!opts.lane && opts.normalizeTo != null) { const m = measureLoudness(out); lufs0 = m.lufs; if (Number.isFinite(m.lufs)) gainDb = opts.normalizeTo - m.lufs; }
  // cue deliveries pass noLimit: loudness belongs to the final mix, and a limited cue leaves the mixer nothing to work with
  if (!opts.lane && !opts.noLimit && (P.limit.on || opts.ceiling != null)) {
    if (opts.normalizeTo != null && Number.isFinite(lufs0)) { const r = limitToTarget(chs, out.sampleRate, opts.normalizeTo, opts.ceiling ?? P.limit.ceiling, lufs0); limited = { gainDb: r.gainDb, maxReductionDb: r.maxReductionDb }; gainDb = r.gainDb; }
    else limited = MixtapeDSP.limit(chs, out.sampleRate, { gainDb, ceilingDb: opts.ceiling ?? P.limit.ceiling });
  }
  else if (gainDb) { const g = Math.pow(10, gainDb / 20); for (const d of chs) for (let i = 0; i < d.length; i++) d[i] *= g; }
  let peak = 0; for (const d of chs) for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  // a limited mix is already under its ceiling; anything else is turned down just enough not to clip
  const scale = !limited && !opts.noScale && peak > 0.98 ? 0.98 / peak : 1;
  return { blob: encodeWav(out, scale, opts.wav), duration: out.duration, buffer: out, scale, limited, gainDb };
}
const bufOf = (chs, sr) => ({ sampleRate: sr, numberOfChannels: chs.length, length: chs[0].length, getChannelData: i => chs[i] });
function limitToTarget(chs, sr, target, ceiling, lufs0) { // limit, then nudge once or twice so the result lands on the target even though the limiter took some off
  const orig = chs.map(c => c.slice()); let gain = target - lufs0, res = null, m = null;
  for (let pass = 0; pass < 3; pass++) {
    if (pass) chs.forEach((c, i) => c.set(orig[i]));
    res = MixtapeDSP.limit(chs, sr, { gainDb: gain, ceilingDb: ceiling });
    m = measureLoudness(bufOf(chs, sr)); if (!Number.isFinite(m.lufs) || Math.abs(m.lufs - target) < 0.15) break;
    gain += target - m.lufs;
  }
  return { gainDb: Math.round(gain * 100) / 100, maxReductionDb: res.maxReductionDb, after: m };
}
/* ---- mastering: a loudness target per destination, a check, and a mono listen ---- */
const MASTER_PRESETS = {
  none: { name: 'Off (no loudness target)' },
  stream: { name: 'Streaming: Spotify, YouTube, Tidal', lufs: -14, ceiling: -1 },
  apple: { name: 'Apple Music', lufs: -16, ceiling: -1 },
  club: { name: 'Club and DJ sets (loud)', lufs: -9, ceiling: -0.5 },
  podcast: { name: 'Podcast or spoken word', lufs: -16, ceiling: -1.5 },
  film: { name: 'Film and TV (EBU R128)', lufs: -23, ceiling: -1 },
};
let masterReport = null, monoOn = false;
function masterStarter(k) { // a gentle place to start: rumble cut and a glue compressor (plus a touch of tape for club)
  const eq = newDevice('eq'); eq.bands[0].on = true; eq.bands[0].f = 25;
  const glue = newDevice('comp'); Object.assign(glue, { th: -16, ratio: 2, att: 30, rel: 150, knee: 6, makeup: 0, mix: 1 });
  const ch = [eq, glue]; if (k === 'club') { const s = newDevice('sat'); s.amt = 0.15; ch.push(s); }
  return ch;
}
function masteringHTML() {
  const ms = MS(), on = ms.preset !== 'none';
  return `<div class="sec"><h3>Mastering</h3>
    <div class="field"><label for="mPre">Made for</label><select id="mPre" data-mpreset>${Object.entries(MASTER_PRESETS).map(([k, v]) => `<option value="${k}" ${ms.preset === k ? 'selected' : ''}>${v.name}${v.lufs ? ` · ${v.lufs} LUFS` : ''}</option>`).join('')}</select><span></span></div>
    <p class="hint">${on ? `Exports come out at ${ms.lufs} LUFS with the true peak under ${ms.ceiling} dBTP. Press <b>Check the master</b> to hear playback at that loudness too, and to see what the limiter and a mono speaker do to your mix.` : 'Pick where the song is going, and every export is made the right loudness for it.'}</p>
    <div class="btnrow"><button class="btn sm${on ? ' primary' : ''}" data-act="checkmaster">Check the master</button><button class="btn sm" data-act="mono" aria-pressed="${monoOn}">${monoOn ? 'Back to stereo' : 'Listen in mono'}</button></div>
    ${masterReport || ''}
    ${chainHTML(MASTER_L).replace('<p class="sub">Effects', '<p class="sub">Master effects')}
    <p class="hint">Master effects work on the whole mix. Stems (one file per track) are exported before them.</p></div>`;
}
function masterReportHTML({ raw, after, gain, red, corr, monoLoss, ms }) {
  const f1 = x => (x > 0 ? '+' : '') + x.toFixed(1), rows = [], notes = [];
  rows.push(`<dt>Your mix now</dt><dd>${Number.isFinite(raw.lufs) ? raw.lufs.toFixed(1) + ' LUFS' : 'silent'} · peak ${raw.truePeakDb.toFixed(1)} dBTP</dd>`);
  if (after) rows.push(`<dt>Mastered</dt><dd>${after.lufs.toFixed(1)} LUFS · peak ${after.truePeakDb.toFixed(1)} dBTP (${f1(gain)} dB)</dd>`, `<dt>Limiter</dt><dd>takes off up to ${red.toFixed(1)} dB</dd>`);
  rows.push(`<dt>Range</dt><dd>${raw.lra.toFixed(1)} LU from quiet to loud</dd>`, `<dt>In mono</dt><dd>${Number.isFinite(monoLoss) ? f1(monoLoss) + ' dB' : 'cancels to silence'} · left/right match ${corr.toFixed(2)}</dd>`);
  if (after && red > 6) notes.push(['warn', `The limiter is squashing the loudest moments by ${red.toFixed(1)} dB, which can sound flat and tiring. Turn down the loudest part, or pick a quieter target.`]);
  else if (after) notes.push(['ok', red > 0.5 ? 'The limiter only catches the peaks: a clean master.' : 'The limiter barely has to work: a clean master.']);
  if (after && gain < -3) notes.push(['ok', `Your mix is louder than ${ms.lufs} LUFS, so it is turned down ${(-gain).toFixed(1)} dB. The streaming service would do the same.`]);
  if (corr < 0) notes.push(['bad', 'Left and right are fighting each other (out of phase). On a phone, in a club or on a TV in mono, parts will disappear. Press “Listen in mono” to find which.']);
  else if (monoLoss < -3) notes.push(['warn', `It gets ${(-monoLoss).toFixed(1)} dB quieter in mono, so some parts are very wide. Listen in mono and narrow anything that vanishes.`]);
  else notes.push(['ok', 'It holds up in mono: nothing important cancels out.']);
  if (raw.lra > 15 && ms.preset !== 'film') notes.push(['warn', 'There is a big gap between the quiet and loud parts. On headphones on the bus, the quiet parts may get lost.']);
  return `<dl class="kv mrep">${rows.join('')}</dl>${notes.map(([k, t]) => `<p class="mnote ${k}">${t}</p>`).join('')}`;
}
async function checkMaster() {
  if (!P.clips.length) return toast('There is nothing to check yet.');
  const ms = MS(); pause(); busy('Listening to the whole mix…');
  try {
    const { buffer: buf } = await renderMix({ noLimit: true, noScale: true }), n = buf.length, sr = buf.sampleRate;
    const raw = measureLoudness(buf), L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    let lr = 0, ll = 0, rr = 0; for (let i = 0; i < n; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
    const corr = ll && rr ? lr / Math.sqrt(ll * rr) : 1, M = new Float32Array(n); for (let i = 0; i < n; i++) M[i] = (L[i] + R[i]) / 2;
    const monoLoss = Number.isFinite(raw.lufs) ? measureLoudness(bufOf([M, M], sr)).lufs - raw.lufs : 0;
    let after = null, red = 0, gain = 0;
    if (ms.preset !== 'none' && Number.isFinite(raw.lufs)) {
      const chs = [new Float32Array(L), new Float32Array(R)], r = limitToTarget(chs, sr, ms.lufs, ms.ceiling, raw.lufs);
      after = r.after; red = r.maxReductionDb; gain = r.gainDb; ms.gainDb = Math.round(gain * 10) / 10; quietCommit();
    }
    masterReport = masterReportHTML({ raw, after, gain, red, corr, monoLoss, ms });
    if (!UI.insp) { UI.insp = true; applyUI(); }
    renderInspector(); document.querySelector('.mrep')?.scrollIntoView({ block: 'center' });
    toast(after ? `Checked. Playback is now as loud as the export will be (${after.lufs.toFixed(1)} LUFS).` : 'Checked. Pick a target under Mastering to have exports made to it.', 5000);
  } catch (err) { toast('Could not check the master: ' + err.message, 6000); } finally { busy(null); }
}
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const safeName = s => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'My mix';
async function saveSong() {
  if (!P.clips.length) return toast('There is nothing to export yet. Add a song first.');
  const hasLoop = !!P.loop, v = P.video;
  const sceneFrom = v ? v.at - v.start : 0, sceneTo = v ? v.at - v.start + v.dur : 0;
  const choice = await ask({ title: 'Export', text: 'Name it, then choose the stretch, the files and where they go. Your original songs stay as they are.', input: P.name || 'My mix', ok: 'Export',
    extra: `<fieldset class="opts"><legend>Stretch</legend>
      <label><input type="radio" name="what" value="mix" checked> The whole mix (${fmtT(projectEnd())})</label>
      <label class="${hasLoop ? '' : 'dis'}"><input type="radio" name="what" value="loop" ${hasLoop ? '' : 'disabled'}> Only the looped section${hasLoop ? ` (${fmtT(P.loop.a)}–${fmtT(P.loop.b)})` : ' (mark a loop on the ruler first)'}</label>
      <label class="${v ? '' : 'dis'}"><input type="radio" name="what" value="scene" ${v ? '' : 'disabled'}> Exactly the scene${v ? ` (${tc(v.dur)}${v.start > 0.05 ? ', lead-in included' : ''})` : ' (add a scene video first)'}</label></fieldset>
      <fieldset class="opts"><legend>Files</legend>
      <label><input type="radio" name="files" value="one" checked> One mixed file</label>
      <label><input type="radio" name="files" value="tracks"> One file per track (stems)</label></fieldset>
      <fieldset class="opts"><legend>Where</legend>
      <label><input type="checkbox" name="where" value="lib" checked> Add to my Mixtape library on this laptop</label>
      <label><input type="checkbox" name="where" value="file" checked> Download as a WAV file, to share or to add to Mixtape on your phone</label></fieldset>`,
    read: f => {
      const where = [...f.querySelectorAll('[name=where]:checked')].map(x => x.value);
      if (!where.length) { toast('Tick at least one place to export to.'); return undefined; }
      return { what: f.querySelector('[name=what]:checked').value, files: f.querySelector('[name=files]:checked').value, where };
    } });
  if (!choice) return;
  const name = choice.input || 'My mix';
  const range = choice.what === 'loop' ? { from: P.loop.a, to: P.loop.b, tag: ' (loop)' } : choice.what === 'scene' ? { from: sceneFrom, to: sceneTo, tag: ' (scene)' } : { from: 0, to: projectEnd(), tag: '' };
  const jobs = choice.files === 'tracks'
    ? P.lanes.filter(l => P.clips.some(c => c.lane === l.id && !c.mute)).map(l => ({ title: `${name}${range.tag} - ${l.name}`, lane: l.id, from: range.from, to: range.to }))
    : [{ title: name + range.tag, from: range.from, to: range.to, ...(MS().preset !== 'none' ? { normalizeTo: MS().lufs, ceiling: MS().ceiling } : {}) }];
  pause(); let done = 0, loud = null;
  try {
    for (const j of jobs) {
      busy(jobs.length > 1 ? `Mixing ${done + 1} of ${jobs.length}: “${j.title}”…` : 'Mixing your song…', { progress: done / jobs.length });
      const { blob, duration, buffer, scale } = await renderMix(j);
      if (jobs.length === 1) { loud = measureLoudness(buffer); const d = 20 * Math.log10(scale); loud.lufs += d; loud.truePeakDb += d; }
      if (choice.where.includes('lib')) await saveToLibrary({ id: uid(), name: j.title + '.wav', size: blob.size, type: 'audio/wav', title: j.title, artist: 'My mixes', album: 'Mixtape Studio', track: 0, duration, added: Date.now(), blob, art: null });
      if (choice.where.includes('file')) downloadBlob(blob, safeName(j.title) + '.wav');
      done++;
    }
    const where = choice.where.length === 2 ? 'saved to your library and downloaded' : choice.where[0] === 'lib' ? 'saved to your library' : 'downloaded to your Downloads folder';
    toast(`${jobs.length === 1 ? `“${jobs[0].title}”` : `${jobs.length} files`} ${where}.${loud && Number.isFinite(loud.lufs) ? ` ${loud.lufs.toFixed(1)} LUFS, true peak ${loud.truePeakDb.toFixed(1)} dBTP.` : ''}`, 6000);
  } catch (err) { toast(`Couldn't export: ${err.message || 'your browser may be out of storage space'}.`, 6000); }
  finally { busy(null); }
}

/* ---------- drawing ---------- */
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const waveColor = (h, alpha = 1) => `hsl(${h} 45% ${css('--wave-l')} / ${alpha})`;
function drawWave(g, e, ta, tb, x0, w, h, color, amp = UI.amp || 1) {
  const { min, max, rate } = e.peaks, mid = h / 2; g.fillStyle = color;
  const span = tb - ta;
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((ta + span * x / w) * rate), i1 = Math.max(i0 + 1, Math.ceil((ta + span * (x + 1) / w) * rate));
    let lo = 0, hi = 0; for (let i = Math.max(0, i0); i < Math.min(min.length, i1); i++) { if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i]; }
    hi = Math.min(1, hi * amp); lo = Math.max(-1, lo * amp);
    g.fillRect(x0 + x, mid - hi * mid * 0.92, 1, Math.max(1, (hi - lo) * mid * 0.92));
  }
}
function drawClipCanvas(cv, c) {
  const e = bufs.get(c.trackId), r = dpr();
  const wCss = Math.max(1, dur(c) * pps), hCss = cv.clientHeight || 64;
  const w = Math.min(16000, Math.round(wCss * r)), h = Math.round(hCss * r);
  cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
  if (c.kind === 'riser') { // a wedge that grows (or shrinks) across the part
    g.fillStyle = withAlpha(laneColor(c.lane), .8); g.beginPath();
    if (c.dir === 'down') { g.moveTo(0, 0); g.lineTo(w, h); g.lineTo(0, h); } else { g.moveTo(0, h); g.lineTo(w, 0); g.lineTo(w, h); }
    g.closePath(); g.fill(); return;
  }
  if (c.kind === 'pattern') { // the hits as dots, one row per drum, repeated along the part
    const n = patN(c), steps = Math.round(c.beats / stepB(c)), rowsUsed = DRUM_ROWS.filter(([k]) => (c.pat.rows[k] || []).some(v => v > 0));
    if (!rowsUsed.length) return;
    const rh = h / rowsUsed.length, sw = w / Math.max(1, steps);
    g.fillStyle = withAlpha(laneColor(c.lane), .95);
    rowsUsed.forEach(([k], r) => { const a = c.pat.rows[k]; for (let s = 0; s < steps; s++) if (a[s % n] > 0) g.fillRect(s * sw + 1, r * rh + rh * 0.2, Math.max(1.5 * dpr(), sw - 2), Math.max(1.5, rh * 0.6)); });
    return;
  }
  if (c.kind === 'midi') { // notes as small bars, highest pitch at the top
    const ns = c.notes.filter(n => n.t < c.end && n.t + n.d > c.start); if (!ns.length) return;
    const lo = Math.min(...ns.map(n => n.p)), hi = Math.max(...ns.map(n => n.p)), span = Math.max(12, hi - lo + 1), rh = Math.max(1.5, h / (span + 1));
    g.fillStyle = withAlpha(laneColor(c.lane), .95);
    for (const n of ns) { const x = (n.t - c.start) / (c.end - c.start) * w, x2 = (n.t + n.d - c.start) / (c.end - c.start) * w; g.fillRect(x, h - ((n.p - lo + 1) / (span + 1)) * h, Math.max(2 * dpr(), x2 - x - 1), rh); }
    return;
  }
  if (!e) return;
  drawWave(g, e, c.start, c.end, 0, w, h, withAlpha(laneColor(c.lane), .95));
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
  const gridCls = '', gridVars = '';
  $('#lanes').innerHTML = P.lanes.map(l => {
    const fxOn = Object.values(l.fx).some(v => v);
    return `
    <div class="lane${l.id === selLane ? ' on' : ''}${l.folded ? ' folded' : ''}${l.locked ? ' locked' : ''}${l.type === 'group' ? ' group' : l.type === 'return' ? ' ret' : ''}" data-lane="${l.id}" style="--c:${l.color || PALETTE[0]};${!l.folded && l.h ? `height:${l.h}px` : ''}">
      <div class="lane-head">
        <div class="lh-slim" title="${esc(l.name)}"><b>${esc(l.name.slice(0, 2))}</b><button class="tg m${l.mute ? ' on' : ''}" data-lf="mute" title="Mute ${esc(l.name)}" aria-pressed="${l.mute}">M</button><button class="tg s${l.solo ? ' on' : ''}" data-lf="solo" title="Hear only ${esc(l.name)}" aria-pressed="${l.solo}">S</button><button class="tg lk${l.locked ? ' on' : ''}" data-lf="lock" title="${l.locked ? 'Unlock' : 'Lock'} ${esc(l.name)}" aria-pressed="${!!l.locked}"><svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.4"/></svg></button></div>
        <div class="lh-top">
          <button class="fold" data-lf="fold" aria-expanded="${!l.folded}" title="${l.folded ? 'Open this track' : 'Fold this track to a slim bar'} (Alt+click: all tracks)">${l.folded ? '▸' : '▾'}</button>
          ${l.type === 'group' ? '<span class="ltag" title="Group track">GRP</span>' : l.type === 'return' ? '<span class="ltag" title="Effect return">RTN</span>' : l.out ? '<span class="ltag dim" title="Plays through a group">→</span>' : ''}<input value="${esc(l.name)}" data-lf="name" aria-label="Track name" maxlength="40">
          <button class="tg m${l.mute ? ' on' : ''}" data-lf="mute" title="Mute this track" aria-pressed="${l.mute}">M</button>
          <button class="tg s${l.solo ? ' on' : ''}" data-lf="solo" title="Hear only this track" aria-pressed="${l.solo}">S</button>
          <button class="tg a${l.auto.show ? ' on' : ''}${l.auto.vol.length || l.auto.pan.length ? ' has' : ''}" data-lf="auto" title="Automation: draw how the volume or pan changes over time" aria-pressed="${!!l.auto.show}">A</button>
          <button class="tg lk${l.locked ? ' on' : ''}" data-lf="lock" title="${l.locked ? 'Unlock this track' : 'Lock this track: its parts cannot be moved, trimmed, cut or deleted'}" aria-pressed="${!!l.locked}"><svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.4"/></svg></button>
          <button class="tg x" data-lf="del" title="Delete track" aria-label="Delete track">✕</button>
        </div>
        <div class="lh-row"><span>VOL</span><input type="range" min="0" max="150" value="${Math.round(l.gain * 100)}" data-lf="gain" aria-label="Track volume"><output>${Math.round(l.gain * 100)}%</output></div>
        <div class="lh-row"><span>L·R</span><input type="range" min="-100" max="100" value="${Math.round(l.pan * 100)}" data-lf="pan" aria-label="Track left-right balance"><output>${l.pan === 0 ? 'C' : (l.pan < 0 ? 'L' : 'R') + Math.abs(Math.round(l.pan * 100))}</output></div>
        ${l.auto.show ? `<div class="lh-row auto-row"><span>AUT</span><select data-lf="autokind" aria-label="Which setting to automate"><option value="vol"${l.auto.show === 'vol' ? ' selected' : ''}>Volume${l.auto.vol.length ? ' •' : ''}</option><option value="pan"${l.auto.show === 'pan' ? ' selected' : ''}>Pan${l.auto.pan.length ? ' •' : ''}</option></select><button class="mini" data-lf="automenu" title="Duck under another track, or clear">⋯</button></div>` : ''}
        ${fxOn ? '<div class="lh-row"><span>FX</span><span style="grid-column:2/4;color:var(--accent)">effects on</span></div>' : ''}
      </div>
      <div class="lane-grip" data-grip="${l.id}" title="Drag to make this track taller or smaller"></div>
      <div class="lane-body${gridCls}" style="${gridVars}width:${timelineWidth()}px;${anySolo && !l.solo || l.mute ? 'opacity:.45' : ''}">
        ${P.clips.filter(c => c.lane === l.id).map(c => {
          const t = libTrack(c.trackId), name = c.kind === 'riser' ? (c.name || 'Riser') : c.kind === 'pattern' ? `${c.name || 'Drum machine'} · ${KITS[c.pat.kit] || ''}` : c.kind === 'midi' ? midiName(c) : t ? t.title : 'Missing song';
          const sel = tlSel && tlSel.clipId === c.id ? `<span class="tlsel" style="left:${(tlSel.a - c.at) * pps}px;width:${(tlSel.b - tlSel.a) * pps}px"></span>` : '';
          return `<div class="clip${c.id === selClip ? ' sel' : ''}${c.mute ? ' muted' : ''}${c.pin ? ' pinned' : ''}${c.kind === 'pattern' || c.kind === 'riser' ? ' pattern' : ''}" data-clip="${c.id}" style="left:${c.at * pps}px;width:${Math.max(4, dur(c) * pps)}px">
            <canvas></canvas><span class="cl" title="Drag here to move · ${esc(name)} · ${fmtT(dur(c))}${esc(clipBadge(c))}">${esc(name)}${esc(clipBadge(c))}</span>${sel}
            <span class="fh l" data-fade="in" style="left:${(c.fadeIn || 0) * pps}px" title="Drag to fade in"></span><span class="fh r" data-fade="out" style="right:${(c.fadeOut || 0) * pps}px" title="Drag to fade out"></span>
            <span class="h l" data-h="l" title="${UI.edgeMode === 'stretch' ? 'Drag to stretch from the start' : 'Drag to trim the start'}"></span><span class="h r" data-h="r" title="${UI.edgeMode === 'stretch' ? 'Drag to stretch' : 'Drag to trim the end'}"></span></div>`;
        }).join('')}
      </div>
    </div>`; }).join('');
  $('#tlInner').style.width = (headW() + timelineWidth()) + 'px';
  $('#tlEmpty').hidden = P.clips.length > 0 || !!P.video;
  renderVideoRow(); renderMarkerLines(); renderVideoWindow(); renderGrid();
  $('#lanes').dataset.h = UI.h;
  document.documentElement.classList.toggle('slimhead', !!UI.slimHead);
  { const b = $('#headBtn'); if (b) { b.textContent = UI.slimHead ? '▸' : '◂'; b.title = UI.slimHead ? 'Show the track names and sliders' : 'Fold the track names away for more room'; b.setAttribute('aria-pressed', !!UI.slimHead); } }
  renderLoop();
  $$('.clip').forEach(el => drawClipCanvas(el.querySelector('canvas'), clipById(el.dataset.clip)));
  $$('#lanes .lane').forEach(el => { const l = P.lanes.find(x => x.id === el.dataset.lane); if (l) drawAuto(el, l); });
  renderRuler(); drawPlayhead(); drawOverview();
}
function renderRuler() {
  const cv = $('#ruler'), r = dpr(), w = timelineWidth(), h = 28;
  cv.style.width = w + 'px'; cv.width = Math.min(32000, Math.round(w * r)); cv.height = h * r;
  const g = cv.getContext('2d'); g.setTransform(cv.width / w, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  const bl = beatLen();
  if (bl && bl * pps >= 5) { g.fillStyle = css('--line'); for (let b = Math.ceil(beatAt(0) - 1e-6), n = 0, x = timeAtBeat(b) * pps; x < w && n < 20000; b++, n++, x = timeAtBeat(b) * pps) g.fillRect(Math.round(x), ((b % 4) + 4) % 4 ? 23 : 19, 1, ((b % 4) + 4) % 4 ? 5 : 9); }
  for (const c of (P.tempoChanges || [])) { const x = c.t * pps; g.fillStyle = '#4FD1A5'; g.fillRect(Math.round(x), 0, 2, 30); g.font = `600 10px ${css('--f-mono')}`; g.textBaseline = 'middle'; g.fillText(`♩${Math.round(c.bpm * 10) / 10}`, x + 4, 22); }
  if (P.loop) { g.fillStyle = P.loopOn ? css('--accent') : css('--line-2'); g.fillRect(P.loop.a * pps, 0, (P.loop.b - P.loop.a) * pps, 5); }
  g.fillStyle = css('--muted'); g.strokeStyle = css('--line'); g.font = `11px ${css('--f-mono')}`; g.textBaseline = 'middle';
  const mode = clockMode();
  if (mode === 'bars') {
    const barW = 4 * 60 / Math.max(...tempoSegs().map(s => s.bpm)) * pps, every = [1, 2, 4, 8, 16, 32].find(n => n * barW >= 44) || 64;
    for (let b = Math.ceil(beatAt(0) / 4 / every - 1e-6) * every, n = 0, x = timeAtBeat(b * 4) * pps; x < w && n < 5000; b += every, n++, x = timeAtBeat(b * 4) * pps) { const xx = Math.round(x) + .5; g.beginPath(); g.moveTo(xx, 12); g.lineTo(xx, h); g.stroke(); g.fillText(String(b + 1), xx + 4, 8); }
  } else {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120]; const step = steps.find(s => s * pps >= (mode === 'tc' ? 110 : 64)) || 300;
    for (let t = 0; t * pps < w; t += step) {
      const x = Math.round(t * pps) + .5; g.beginPath(); g.moveTo(x, 14); g.lineTo(x, h); g.stroke();
      const m = Math.floor(t / 60), s = t % 60; g.fillText(mode === 'tc' ? tc(t) : `${m}:${String(Math.floor(s)).padStart(2, '0')}${step < 1 && s % 1 ? '.5' : ''}`, x + 4, 8);
    }
  }
  drawCuesOnRuler(g, w);
  drawMarkersOnRuler(g, w);
}
function clockMode() { const m = UI.clock || (UI.bars ? 'bars' : 'time'); if (m === 'bars' && !beatLen()) return 'time'; return m; }
function fmtBars(t) { const bt = beatAt(t); const beats = Math.floor(bt + 1e-6); const frac = bt - beats; return `${Math.floor(beats / 4) + 1}.${(beats % 4) + 1}.${Math.floor(frac * 4) + 1}`; }
function renderLoop() {
  const b = $('#loopBand'); if (!P.loop) { b.hidden = true; return; }
  b.hidden = false; b.classList.toggle('off', !P.loopOn);
  b.style.left = (headW() + P.loop.a * pps) + 'px'; b.style.width = ((P.loop.b - P.loop.a) * pps) + 'px';
}
function drawPlayhead(p = curPos()) {
  $('#playhead').style.left = (headW() + p * pps) + 'px';
  const fm = clockMode() === 'bars' ? fmtBars : clockMode() === 'tc' ? tc : fmtT;
  $('#clock').innerHTML = `${fm(p)} <span>/ ${fm(projectEnd())}</span>`;
  if (P.video) { $('#vtc').textContent = tc(p); if (!playing) scrubVideo(p); }
}
function followPlayhead(p) {
  if (UI.follow === false || performance.now() - navAt < 4000) return;
  const tl = $('#tl'), x = headW() + p * pps;
  if (x > tl.scrollLeft + tl.clientWidth - 40 || x < tl.scrollLeft + headW()) { progScroll = true; tl.scrollLeft = x - headW() - 40; }
}
function scrollToTime(t) { const tl = $('#tl'); const x = t * pps; if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - headW() - 60) tl.scrollLeft = Math.max(0, x - 60); }

let edView = null;
let edWin = null; // { clipId, v0, v1 }: the stretch of the song the part editor shows
function edWindow(c, D) {
  if (!edWin || edWin.clipId !== c.id) { const pad = Math.max(0.5, (c.end - c.start) * 0.08); edWin = { clipId: c.id, v0: Math.max(0, c.start - pad), v1: Math.min(D, c.end + pad) }; }
  edWin.v0 = clamp(edWin.v0, 0, D); edWin.v1 = clamp(edWin.v1, edWin.v0 + 0.02, D);
  return edWin;
}
function edZoom(f, anchorFrac = 0.5) {
  const c = clipById(selClip); if (!c || !edView || edView.midi) return;
  const D = edView.D, span = edWin.v1 - edWin.v0, ns = clamp(span * f, 0.05, D), at = edWin.v0 + span * anchorFrac;
  let v0 = at - ns * anchorFrac; v0 = clamp(v0, 0, D - ns); edWin.v0 = v0; edWin.v1 = v0 + ns; drawEditor();
}
function edFit(what) {
  const c = clipById(selClip); if (!c || !edView || edView.midi) return;
  if (what === 'all') { edWin.v0 = 0; edWin.v1 = edView.D; } else { const pad = Math.max(0.5, (c.end - c.start) * 0.08); edWin.v0 = Math.max(0, c.start - pad); edWin.v1 = Math.min(edView.D, c.end + pad); }
  drawEditor();
}
function drawEditor() {
  const c = clipById(selClip), cv = $('#edCanvas'), wrap = $('#edWrap');
  $('#edEmpty').hidden = !!c;
  const show = !!c && edOpen, ed = $('.editor'); if (ed.hidden !== !show) { ed.hidden = !show; requestAnimationFrame(() => { renderRuler(); renderLoop(); }); }
  ed.classList.toggle('folded', !!UI.edFold); ed.style.setProperty('--ed-h', (UI.edH || 112) + 'px');
  { const b = $('#edFoldBtn'); b.textContent = UI.edFold ? '▸' : '▾'; b.setAttribute('aria-pressed', !!UI.edFold); b.title = UI.edFold ? 'Open the part editor again' : 'Fold the part editor down to this bar for more room'; }
  ['keep', 'remove', 'selappend', 'sellayer'].forEach(a => { const b = $(`[data-act="${a}"]`); if (b) b.disabled = !c || !edSel; });
  $('[data-act="selall"]').disabled = $('[data-act="prevsel"]').disabled = !c;
  if (!preview) $('[data-act="prevsel"]').textContent = edSel ? 'Play selection' : 'Play part';
  const r = dpr(), w = wrap.clientWidth, h = wrap.clientHeight;
  cv.width = Math.round(w * r); cv.height = Math.round(h * r);
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  if (!c) { $('#edTitle').textContent = 'Part editor'; $('#edInfo').textContent = ''; $('#selInfo').textContent = 'No part selected'; edView = null; return; }
  if (c.kind === 'riser') { $('#edTitle').textContent = c.name || 'Riser'; $('#edInfo').textContent = `${c.beats / 4} bars of build-up`; $('#selInfo').textContent = 'Drag the part’s right edge on the timeline to change its length.'; edView = null; return; }
  if (c.kind === 'pattern') {
    ['keep', 'remove', 'selappend', 'sellayer', 'selall'].forEach(a => { const b = $(`[data-act="${a}"]`); if (b) b.disabled = true; });
    $('#edTitle').textContent = c.name || 'Drum machine'; $('#edInfo').textContent = `${KITS[c.pat.kit]} · ${patN(c)} steps of ${(RES[c.pat.res] || RES['16']).label}${c.pat.swing ? ` · swing ${c.pat.swing}%` : ''}`;
    $('#selInfo').textContent = 'Click a square to add or remove a hit · drag to paint · Shift + click for an accent · click a drum’s name to hear it';
    drawPatternGrid(c, g, w, h); return;
  }
  if (c.kind === 'midi') {
    ['keep', 'remove', 'selappend', 'sellayer', 'selall'].forEach(a => { const b = $(`[data-act="${a}"]`); if (b) b.disabled = true; });
    $('#edTitle').textContent = midiName(c); $('#edInfo').textContent = `${c.notes.length} note${c.notes.length === 1 ? '' : 's'} · ${MixtapeMIDI.INSTRUMENTS[c.inst] || ''}${c.semi ? ` · transposed ${c.semi > 0 ? '+' : ''}${c.semi}` : ''}`;
    $('#selInfo').textContent = `Click to add ${UI.chord ? CHORD_TOOLS[UI.chord].toLowerCase() : 'a note'} · drag to move · drag the right edge to lengthen · double-click to remove · Alt: no snapping · bottom strip: ${UI.dynMode === 'vel' ? 'velocity' : 'dynamics'} (click its label to switch)`;
    drawPianoRoll(c, g, w, h); return;
  }
  const t = libTrack(c.trackId), e = bufs.get(c.trackId), a = ana[c.trackId];
  $('#edTitle').textContent = t ? t.title : 'Missing song';
  $('#edInfo').textContent = `part ${fmtT(c.start)}–${fmtT(c.end)} of ${e ? fmtT(e.buffer.duration) : '?'}${a ? ` · ${a.bpm ? a.bpm + ' BPM' : 'no steady beat'} · ${a.keyName}` : analyzing.has(c.trackId) ? ' · finding tempo and key…' : ''}`;
  $('#selInfo').textContent = edSel ? `Selected ${fmtT(edSel.a)}–${fmtT(edSel.b)} (${(edSel.b - edSel.a).toFixed(1)}s)` : P.snap ? 'Drag to select (snaps to the beat)' : 'Drag across the waveform to select';
  if (!e) return;
  const D = e.buffer.duration, W = edWindow(c, D), span = W.v1 - W.v0, OV = 14; // the top strip is an overview of the whole song
  edView = { D, w, v0: W.v0, v1: W.v1, ov: OV };
  const X = s => (s - W.v0) / span * w, col = laneColor(c.lane), hh = h - OV;
  g.save(); g.translate(0, OV);
  g.fillStyle = withAlpha(col, .12); g.fillRect(X(c.start), 0, X(c.end) - X(c.start), hh);
  drawWave(g, e, W.v0, W.v1, 0, w, hh, withAlpha(col, .3));
  g.save(); g.beginPath(); g.rect(X(c.start), 0, X(c.end) - X(c.start), hh); g.clip(); drawWave(g, e, W.v0, W.v1, 0, w, hh, col); g.restore();
  const sb = songBeats(c.trackId);
  if (sb && sb.len / span * w >= 3) { g.fillStyle = css('--muted'); const b0 = Math.max(0, Math.floor((W.v0 - sb.off) / sb.len)); for (let b = b0, tb = sb.off + b0 * sb.len; tb < W.v1; b++, tb += sb.len) g.fillRect(Math.round(X(tb)), 0, 1, b % 4 ? 4 : 9); }
  // time labels along the bottom, so you always know where you are
  { const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60], st = steps.find(s => s / span * w >= 70) || 120; g.fillStyle = css('--muted'); g.font = `10px ${css('--f-mono')}`; g.textBaseline = 'bottom';
    for (let t = Math.ceil(W.v0 / st) * st; t < W.v1; t += st) { const x = Math.round(X(t)); g.fillRect(x, hh - 5, 1, 5); g.fillText(st < 1 ? t.toFixed(2) : fmtT(t), x + 3, hh - 1); } }
  g.fillStyle = css('--accent'); g.fillRect(X(c.start) - 1, 0, 2, hh); g.fillRect(X(c.end) - 1, 0, 2, hh);
  if (edSel) { g.fillStyle = css('--sel'); g.fillRect(X(edSel.a), 0, X(edSel.b) - X(edSel.a), hh); g.fillStyle = css('--ink'); g.fillRect(X(edSel.a), 0, 1, hh); g.fillRect(X(edSel.b), 0, 1, hh); }
  if (preview) { const p = preview.a + (ctx.currentTime - preview.st); g.fillStyle = css('--danger'); g.fillRect(X(clamp(p, preview.a, preview.b)), 0, 2, hh); }
  else { const p = curPos() - c.at; if (p >= 0 && p <= dur(c)) { g.fillStyle = css('--danger'); g.fillRect(X(c.start + p * (c.rate || 1)), 0, 2, hh); } }
  g.restore();
  // overview strip: the whole song, the part in colour, a box round what is shown
  const O = s => s / D * w;
  g.fillStyle = css('--raise'); g.fillRect(0, 0, w, OV - 2);
  drawWave(g, e, 0, D, 0, w, OV - 2, withAlpha(col, .45), 1);
  g.fillStyle = withAlpha(col, .35); g.fillRect(O(c.start), 0, O(c.end) - O(c.start), OV - 2);
  g.strokeStyle = css('--ink'); g.lineWidth = 1; g.strokeRect(O(W.v0) + 0.5, 0.5, Math.max(3, O(W.v1) - O(W.v0)) - 1, OV - 3);
  $('#edZoomLbl').textContent = span >= D - 0.01 ? 'whole song' : `${span < 10 ? span.toFixed(2) : fmtT(span)} shown`;
}

function moutHTML(l) {
  const has = P.clips.some(c => c.lane === l.id && c.kind === 'midi'); if (!has && !l.mout) return '';
  const m = l.mout, outs = midiAccess ? [...midiAccess.outputs.values()] : [], found = m && outs.some(o => o.id === m.id || o.name === m.name);
  let h = `<p class="sub">Outside instrument <span class="hint" style="font-weight:400">· LABS, Splice INSTRUMENT or any synth app</span></p>`;
  if (!midiAccess) h += `<div class="btnrow"><button class="btn sm" data-act="midiouts">Play this track with an outside instrument…</button><button class="btn sm ghost" data-act="labshelp">How to set up LABS</button></div>`;
  else {
    h += `<div class="field"><label for="mOut">Send to</label><select id="mOut" data-mout="port"><option value="">Off: Mixtape’s own sound</option>${outs.map(o => `<option value="${esc(o.id)}" ${m && (m.id === o.id || m.name === o.name) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}${m && !found ? `<option value="__missing" selected>${esc(m.name)} (not connected)</option>` : ''}</select><span></span></div>`;
    if (!outs.length) h += `<p class="hint">No MIDI outputs yet. Make a loopback cable first (see How to set up LABS), then press Look again.</p>`;
    if (m) h += `<div class="field"><label for="mCh">Channel</label><select id="mCh" data-mout="ch">${Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}" ${(m.ch || 1) === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select><span></span></div>
      <div class="field"><label for="mDel">Line up</label><input id="mDel" type="range" min="-200" max="200" step="5" value="${m.delay || 0}" data-mout="delay" title="If the outside instrument sounds late, move this left; if early, move it right"><output>${(m.delay || 0) > 0 ? '+' : ''}${m.delay || 0} ms</output></div>
      <label class="chk"><input type="checkbox" data-mout="inside" ${m.inside ? 'checked' : ''}> Also play Mixtape’s own sound</label>
      <p class="hint">Mixtape sends the notes, velocity, dynamics (as the mod wheel), the sustain pedal and live keyboard playing. The sound comes out of the other app, so exports use Mixtape’s own sound for this track; record the other app’s output there for the real thing.</p>`;
    h += `<div class="btnrow"><button class="btn sm" data-act="midiouts">Look again</button><button class="btn sm" data-act="mouttest" ${m && found ? '' : 'disabled'}>Send a test note</button><button class="btn sm ghost" data-act="labshelp">How to set up LABS</button></div>`;
  }
  return h;
}
function labsHelp() {
  ask({ title: 'Playing Spitfire LABS from Mixtape', ok: 'Got it', text: 'LABS runs as its own app, so Mixtape sends it the notes through a virtual MIDI cable and LABS plays them out of your speakers. Set this up once:',
    extra: `<ol class="steps">
      <li><b>Get the sounds.</b> Install <b>Splice INSTRUMENT</b> (free, splice.com/instrument). It is LABS’s replacement and includes the LABS sounds. Spitfire stops LABS itself on 31 October 2026, so download every LABS pack you want before then.</li>
      <li><b>Make a virtual MIDI cable.</b> Either open Windows’ <b>MIDI Settings</b> app and add a loopback, or install the free <b>loopMIDI</b> (tobias-erichsen.de) and press + to add a port.</li>
      <li><b>Open INSTRUMENT on its own</b> (no DAW needed), pick a LABS sound, and in its settings choose the virtual cable as the MIDI input.</li>
      <li><b>In Mixtape,</b> select the track, press <i>Play this track with an outside instrument</i>, and choose the same cable under <i>Send to</i>. Press <i>Send a test note</i>: you should hear INSTRUMENT play it.</li>
      <li><b>Line up.</b> Play with the click on. If the outside sound is late, drag <i>Line up</i> to the left until it sits on the beat.</li></ol>
      <p class="hint">If INSTRUMENT’s own window has no MIDI input setting, load it as a plugin in a free host such as Carla, set the host’s MIDI input to the cable, and it works the same way. The sounds may be used in your music, including film, but may not be copied into other apps or sample libraries.</p>` });
}
function routingHTML(l) {
  const groups = P.lanes.filter(x => x.type === 'group' && x.id !== l.id), returns = P.lanes.filter(x => x.type === 'return' && x.id !== l.id);
  let h = '';
  if (l.type === 'group') { const kids = P.lanes.filter(x => x.out === l.id); h += `<p class="hint"><b>Group track.</b> ${kids.length ? `${kids.map(k => esc(k.name)).join(', ')} play${kids.length === 1 ? 's' : ''} through it` : 'No tracks play through it yet: on another track, set Output to this group'}. Its effects and volume apply to all of them together.</p>`; }
  if (l.type === 'return') h += `<p class="hint"><b>Effect return.</b> Tracks send some of their sound here with their “Send” sliders, so one reverb or delay can be shared. Keep its effect fully wet (Mix 100%).</p>`;
  if (l.type !== 'group' && l.type !== 'return' && groups.length) h += `<div class="field"><label for="lOut">Output</label><select id="lOut" data-lroute><option value="">Master</option>${groups.map(g => `<option value="${g.id}" ${l.out === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select><span></span></div>`;
  if (l.type !== 'return') for (const R of returns) { const v = Math.round(((l.sends || {})[R.id] || 0) * 100); h += `<div class="field"><label for="snd${R.id}">Send</label><input id="snd${R.id}" type="range" min="0" max="100" value="${v}" data-lsend="${R.id}" title="How much of this track goes to ${esc(R.name)}"><output>${v}% → ${esc(R.name)}</output></div>`; }
  return h;
}
function chainHTML(l) {
  const ch = l.chain || [], n = ch.length;
  const pct = x => Math.round((x ?? 0.5) * 100);
  const sl = (d, k, label, min, max, step, val, fmt) => `<div class="field"><label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-dvp="${k}"><output>${fmt(val)}</output></div>`;
  const body = d => {
    if (d.type === 'eq') return `<canvas class="eqcv" data-eq="${d.id}" aria-label="EQ curve"></canvas><p class="hint eqread" data-eqread="${d.id}">Drag a dot: left and right moves it, up and down boosts or cuts. Turn the wheel on a dot to make a bell narrower or wider. Double-click a dot to switch it on or off.</p>`;
    if (d.type === 'comp') return sl(d, 'th', 'Threshold', -60, 0, 1, d.th, v => `${v} dB`) + sl(d, 'ratio', 'Ratio', 1, 20, 0.5, d.ratio, v => `${v}:1`) + sl(d, 'att', 'Attack', 0.5, 100, 0.5, d.att, v => `${v} ms`) + sl(d, 'rel', 'Release', 20, 1000, 5, d.rel, v => `${v} ms`) + sl(d, 'makeup', 'Makeup', 0, 24, 0.5, d.makeup, v => `+${v} dB`) + sl(d, 'mix', 'Mix', 0, 100, 1, pct(d.mix), v => `${v}%`)
      + `<div class="field"><label>Squeeze</label><div class="gr" title="How much the compressor is turning the sound down right now"><i data-gr="${d.id}"></i></div><output data-grv="${d.id}">0 dB</output></div>`;
    if (d.type === 'sat') return `<div class="field"><label>Character</label><select data-dvp="mode">${[['tape', 'Tape: smooth and warm'], ['tube', 'Tube: rich, a little gritty'], ['hard', 'Hard clip: edgy']].map(([k, v]) => `<option value="${k}" ${(d.mode || 'tape') === k ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>`
      + sl(d, 'amt', 'Drive', 0, 100, 1, pct(d.amt), v => `${v}%`) + sl(d, 'tone', 'Tone', 0, 100, 1, pct(d.tone), v => `${v}%`) + sl(d, 'mix', 'Mix', 0, 100, 1, pct(d.mix), v => `${v}%`);
    if (d.type === 'lofi') return sl(d, 'bits', 'Bits', 2, 16, 1, d.bits ?? 8, v => `${v}-bit`) + sl(d, 'rate', 'Sample rate', 2000, 44100, 100, d.rate ?? 11025, v => `${(v / 1000).toFixed(1)} kHz`) + sl(d, 'tone', 'Tone', 0, 100, 1, pct(d.tone), v => `${v}%`) + sl(d, 'mix', 'Mix', 0, 100, 1, pct(d.mix), v => `${v}%`)
      + (ctx.audioWorklet ? '' : '<p class="hint">This browser cannot run the lo-fi effect, so it only darkens the sound here.</p>');
    if (d.type === 'gate') return `<div class="field"><label>Rhythm</label><select data-dvp="gate">${Object.keys(GATES).map(k => `<option value="${k}" ${(d.gate || 'classic') === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)} · ${GATES[k].replace(/x/g, '■').replace(/\./g, '·')}</option>`).join('')}</select><span></span></div>` + sl(d, 'amt', 'Depth', 0, 100, 1, pct(d.amt), v => `${v}%`);
    return sl(d, 'amt', 'Amount', 0, 100, 1, pct(d.amt), v => `${v}%`) + sl(d, 'mix', 'Mix', 0, 100, 1, pct(d.mix), v => `${v}%`);
  };
  return `<p class="sub">Effects <span class="hint" style="font-weight:400">· the sound runs through them from top to bottom</span></p>
    ${ch.map((d, i) => `<div class="dev${d.on ? '' : ' off'}" data-dev="${d.id}"><div class="dev-h"><button class="dvon" data-dv="on" aria-pressed="${d.on}" title="${d.on ? 'Switch off (bypass)' : 'Switch on'}">${d.on ? '●' : '○'}</button><b>${FX_TYPES[d.type] || d.type}</b><span class="sp"></span><button data-dv="up" ${i ? '' : 'disabled'} title="Move up">↑</button><button data-dv="down" ${i < n - 1 ? '' : 'disabled'} title="Move down">↓</button><button data-dv="del" title="Remove">✕</button></div>${d.on ? body(d) : ''}</div>`).join('')}
    <select class="addfx" data-dvadd data-owner="${l.id}" aria-label="Add an effect"><option value="">+ Add an effect…</option>${Object.entries(FX_TYPES).filter(([k]) => HAS_TONE || ['eq', 'comp', 'sat', 'lofi', 'gate', 'hall'].includes(k)).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`;
}
/* ---- the EQ: draw the curve over the track's live spectrum, and drag its dots ---- */
const eqX = (f, w) => Math.log(f / 20) / Math.log(1000) * w, eqF = (x, w) => 20 * Math.pow(1000, clamp(x / w, 0, 1));
const EQG = 18, eqY = (g, h) => h / 2 - g / EQG * (h / 2 - 8), eqG = (y, h) => clamp((h / 2 - y) / (h / 2 - 8) * EQG, -EQG, EQG);
const MS = () => P.mastering || (P.mastering = { preset: 'none', lufs: -14, ceiling: -1, gainDb: 0 });
// the master shows up in the effect code as one more lane, whose chain is the project's master chain
const MASTER_L = { id: 'master', name: 'Master', type: 'master', color: '#E8B931', get chain() { return P.masterChain || (P.masterChain = []); }, set chain(v) { P.masterChain = v; } };
function findDev(id) { for (const l of P.lanes) { const d = (l.chain || []).find(x => x.id === id); if (d) return { l, d }; } const md = (P.masterChain || []).find(x => x.id === id); return md ? { l: MASTER_L, d: md } : null; }
const devsOf = id => !graph ? null : id === 'master' ? graph.masterDevs : (graph.lanes.get(id) || {}).devs;
function bandPos(b, w, h) { return [eqX(b.f, w), b.t === 'hp' || b.t === 'lp' ? eqY(0, h) : eqY(b.g || 0, h)]; }
function drawEQ(cv) {
  const hit = findDev(cv.dataset.eq); if (!hit) return; const { l, d } = hit;
  const r = dpr(), w = cv.clientWidth || 260, h = cv.clientHeight || 130; cv.width = Math.round(w * r); cv.height = Math.round(h * r);
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  g.fillStyle = css('--bg'); g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.fillStyle = css('--dim'); g.font = `9px ${css('--f-mono')}`;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(eqX(f, w)) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, h - 3); }
  for (const db of [-12, -6, 0, 6, 12]) { const y = Math.round(eqY(db, h)) + .5; g.strokeStyle = db ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  // the track's sound right now, behind the curve
  const an = graph && (l.id === 'master' ? graph.mmeter : (graph.lanes.get(l.id) || {}).meter);
  if (playing && an) { const bins = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(bins); const ny = ctx.sampleRate / 2;
    g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += 2) { const f = eqF(x, w), i = Math.min(bins.length - 1, Math.round(f / ny * bins.length)); const v = clamp((bins[i] + 100) / 80, 0, 1); g.lineTo(x, h - v * h * 0.9); } g.lineTo(w, h); g.closePath(); g.fillStyle = withAlpha(l.color || PALETTE[0], 0.22); g.fill(); }
  // the curve
  const N = 160, freqs = new Float32Array(N), mag = new Float32Array(N), tmp = new Float32Array(N), ph = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = eqF(i / (N - 1) * w, w);
  for (const b of d.bands) { if (!b.on) continue; const reps = b.t === 'hp' || b.t === 'lp' ? 2 : 1; const n = ctx.createBiquadFilter(); setBand(n, b); n.getFrequencyResponse(freqs, tmp, ph); for (let i = 0; i < N; i++) mag[i] += reps * 20 * Math.log10(tmp[i] + 1e-9); }
  g.beginPath(); for (let i = 0; i < N; i++) { const x = i / (N - 1) * w, y = eqY(clamp(mag[i], -EQG - 6, EQG + 6), h); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.strokeStyle = css('--accent'); g.lineWidth = 2; g.stroke();
  d.bands.forEach((b, i) => { const [x, y] = bandPos(b, w, h); g.beginPath(); g.arc(x, y, i === +cv.dataset.sel ? 6 : 5, 0, Math.PI * 2); g.fillStyle = b.on ? css('--accent') : css('--raise'); g.fill(); g.strokeStyle = css('--ink'); g.lineWidth = 1.2; g.stroke(); g.fillStyle = b.on ? css('--accent-ink') : css('--muted'); g.font = `600 8px ${css('--f-mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), x, y + 0.5); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; });
}
function eqLive(l, d, i) { // change the playing sound straight away, without restarting
  const x = (devsOf(l.id) || {})[d.id]; if (!x || !x.eqNodes) return;
  const n = x.eqNodes[i]; if (!n) return; (Array.isArray(n) ? n : [n]).forEach(m => setBand(m, d.bands[i]));
}
function eqReadout(d, i) { const b = d.bands[i], el = document.querySelector(`[data-eqread="${d.id}"]`); if (!el || !b) return; el.textContent = `${i + 1} · ${BAND_NAME[b.t]} ${b.f >= 1000 ? (b.f / 1000).toFixed(2) + ' kHz' : Math.round(b.f) + ' Hz'}${b.t === 'hp' || b.t === 'lp' ? '' : ` · ${b.g > 0 ? '+' : ''}${(b.g || 0).toFixed(1)} dB`}${b.t === 'pk' ? ` · width ${(b.q || 1).toFixed(2)}` : ''}${b.on ? '' : ' · off'}`; }
document.addEventListener('pointerdown', e => {
  const cv = e.target.closest && e.target.closest('canvas.eqcv'); if (!cv) return;
  const hit = findDev(cv.dataset.eq); if (!hit) return; const { l, d } = hit;
  const r = cv.getBoundingClientRect(), w = r.width, h = r.height, x = e.clientX - r.left, y = e.clientY - r.top;
  let best = -1, bd = 14; d.bands.forEach((b, i) => { const [bx, by] = bandPos(b, w, h); const dd = Math.hypot(bx - x, by - y); if (dd < bd) { bd = dd; best = i; } });
  if (best < 0) return; cv.dataset.sel = best; eqReadout(d, best);
  if (e.detail >= 2) { d.bands[best].on = !d.bands[best].on; commit(`EQ dot ${best + 1} ${d.bands[best].on ? 'on' : 'off'}`); return; }
  const b = d.bands[best]; try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const mv = ev => { const xx = ev.clientX - r.left, yy = ev.clientY - r.top; b.f = Math.round(eqF(xx, w)); if (b.t !== 'hp' && b.t !== 'lp') b.g = Math.round(eqG(yy, h) * 2) / 2; eqLive(l, d, best); drawEQ(cv); eqReadout(d, best); };
  cv.addEventListener('pointermove', mv);
  cv.addEventListener('pointerup', () => { cv.removeEventListener('pointermove', mv); quietCommit(); drawEQ(cv); }, { once: true });
  drawEQ(cv);
});
document.addEventListener('wheel', e => {
  const cv = e.target.closest && e.target.closest('canvas.eqcv'); if (!cv) return; const hit = findDev(cv.dataset.eq); if (!hit) return;
  const i = +cv.dataset.sel; const b = hit.d.bands[i]; if (!b || b.t !== 'pk') return; e.preventDefault();
  b.q = clamp((b.q || 1) * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.2, 12); eqLive(hit.l, hit.d, i); drawEQ(cv); eqReadout(hit.d, i); clearTimeout(drawEQ.t); drawEQ.t = setTimeout(quietCommit, 400);
}, { passive: false });
let meterTick = 0;
function updateDeviceMeters() { // the compressor's squeeze and the EQ's live spectrum, while playing
  if (!UI.insp || !graph || ++meterTick % 3) return;
  document.querySelectorAll('[data-gr]').forEach(i => { const hit = findDev(i.dataset.gr), x = hit && (devsOf(hit.l.id) || {})[i.dataset.gr]; if (x && x.comp) { const red = x.comp.reduction || 0; i.style.width = clamp(-red / 24, 0, 1) * 100 + '%'; const o = document.querySelector(`[data-grv="${i.dataset.gr}"]`); if (o) o.textContent = `${red.toFixed(1)} dB`; } });
  document.querySelectorAll('canvas.eqcv').forEach(drawEQ);
}
/* ---- the settings panel: a text size, folding sections, and a search that finds any setting ---- */
const textScale = () => UI.ts || 1.15;
function applyTextScale() { document.documentElement.style.setProperty('--ts', textScale()); }
const secKey = h => h.textContent.split(':')[0].trim().toLowerCase();
function foldSections() {
  const F = UI.secFold || { keys: true };
  $$('#insp .sec').forEach(s => { const h = s.querySelector(':scope > h3'); if (!h) return; s.classList.toggle('folded', !!F[secKey(h)]); h.tabIndex = 0; h.setAttribute('role', 'button'); h.setAttribute('aria-expanded', !F[secKey(h)]); h.title = 'Click to fold or open this section'; });
}
function toggleSection(h) { const F = { keys: true, ...(UI.secFold || {}) }, k = secKey(h); F[k] = !F[k]; UI.secFold = F; saveUI(); foldSections(); }
let findQ = '', findHits = [], findSel = 0;
// what people call things, and where a setting lives when it is not on screen
const FIND_SAY = { labs: 'outside instrument', 'midi out': 'outside instrument', loopmidi: 'outside instrument', splice: 'outside instrument', loudness: 'mastering', lufs: 'mastering', loud: 'mastering', bpm: 'tempo', pitch: 'key', stretch: 'speed', 'time stretch': 'speed', eq: 'add an effect', equaliser: 'add an effect', equalizer: 'add an effect', compressor: 'add an effect', saturation: 'add an effect', 'lo-fi': 'add an effect', lofi: 'add an effect', chorus: 'add an effect', delay: 'add an effect', sidechain: 'pump', duck: 'dialogue', mono: 'listen in mono', 'mod wheel': 'dynamics', velocity: 'dynamics', crescendo: 'dynamics', chords: 'chord', group: 'output', bus: 'output', send: 'send', 'reverb return': 'add track' };
const FIND_WHERE = [
  [/outside|labs|midi out|loopmidi|splice/i, 'The outside instrument is in the settings of a track that has notes on it: click that track’s name on the left of the timeline.'],
  [/effect|eq|equali|compress|satur|lo-?fi|distort|chorus|phaser|delay|gate|filter sweep/i, 'Effects are in each track’s settings: click a track’s name, then use “+ Add an effect…”.'],
  [/speed|stretch|key|fade|split/i, 'That is in a song part’s settings: click a part on the timeline.'],
  [/chord|scale|dynamic|velocity|swell|arpegg|record notes|keyboard|instrument|sound/i, 'That is in an instrument part’s settings: click a part with notes (or add one with Instruments & MIDI).'],
  [/send|output|group|return/i, 'Sends and outputs are in a track’s settings; groups and reverb returns come from “+ Add track ▾”.'],
];
function findTargets() { return [...$('#insp').querySelectorAll('.sec > h3, .sub, .field > label, label.chk, .btnrow .btn, .dev-h b, select.addfx, select[data-mpreset]')].filter(el => el.offsetParent !== null || el.closest('.sec.folded')); }
function runFind() {
  const box = $('#inspFind'), list = $('#findList'); if (!box || !list) return;
  findQ = box.value; const q = findQ.trim().toLowerCase(); if (!q) { list.hidden = true; findHits = []; return; }
  const alias = Object.entries(FIND_SAY).find(([k]) => q.includes(k)), words = [q, ...(alias ? [alias[1]] : [])];
  const textOf = el => (el.matches('select') ? el.getAttribute('aria-label') || el.options[0].textContent : el.textContent).replace(/\s+/g, ' ').trim();
  // best first: a label that starts with the words, then section and group headings, then anything containing them
  const score = el => { const t = textOf(el).toLowerCase(); return (words.some(w => t.startsWith(w)) ? 0 : 2) + (el.matches('.sub, .sec > h3') ? 0 : 1); };
  findHits = findTargets().filter(el => words.some(w => textOf(el).toLowerCase().includes(w))).map((el, i) => ({ el, k: score(el) * 1000 + i })).sort((a, b) => a.k - b.k).map(x => x.el).slice(0, 8);
  findSel = 0;
  if (!findHits.length) { const where = FIND_WHERE.find(([re]) => re.test(q)); list.innerHTML = `<p class="findnone">${where ? where[1] : `Nothing called “${esc(findQ)}” here. The settings change with what is selected: click a part or a track first.`}</p>`; list.hidden = false; return; }
  list.innerHTML = findHits.map((el, i) => { const sec = el.closest('.sec')?.querySelector(':scope > h3'); return `<button class="findhit${i === findSel ? ' on' : ''}" data-hit="${i}"><b>${esc(textOf(el).slice(0, 60))}</b>${sec && sec !== el ? `<span>${esc(sec.textContent.trim())}</span>` : ''}</button>`; }).join('');
  list.hidden = false;
}
function revealHit(i) {
  const el = findHits[i]; if (!el) return; const sec = el.closest('.sec');
  if (sec && sec.classList.contains('folded')) toggleSection(sec.querySelector(':scope > h3'));
  const box = el.closest('.field, .chk, .dev, .btnrow, .sub, .sec > h3') || el;
  $('#findList').hidden = true;
  const ins = $('#insp'), r = box.getBoundingClientRect(), pr = ins.getBoundingClientRect(), bar = $('.insp-tools').getBoundingClientRect().bottom - pr.top; // centre it in the panel, below the search bar
  ins.scrollTop = Math.max(0, ins.scrollTop + (r.top - pr.top) - bar - Math.max(0, (pr.height - bar - r.height) / 2));
  $$('#insp .flash').forEach(x => x.classList.remove('flash')); void box.offsetWidth; box.classList.add('flash'); setTimeout(() => box.classList.remove('flash'), 2200);
  const ctl = box.querySelector('input:not([type=search]), select, button') || (box.matches('button, select') ? box : null); if (ctl) setTimeout(() => ctl.focus({ preventScroll: true }), 350);
}
$('#insp').addEventListener('input', e => { if (e.target.id === 'inspFind') runFind(); });
$('#insp').addEventListener('keydown', e => {
  if (e.target.id === 'inspFind') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!findHits.length) return; findSel = (findSel + (e.key === 'ArrowDown' ? 1 : -1) + findHits.length) % findHits.length; $$('#findList .findhit').forEach((b, i) => b.classList.toggle('on', i === findSel)); }
    else if (e.key === 'Enter') { e.preventDefault(); revealHit(findSel); }
    else if (e.key === 'Escape') { e.target.value = ''; findQ = ''; runFind(); e.target.blur(); }
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.sec > h3')) { e.preventDefault(); toggleSection(e.target); }
});
$('#insp').addEventListener('click', e => {
  const hit = e.target.closest('[data-hit]'); if (hit) { revealHit(+hit.dataset.hit); return; }
  const h = e.target.closest('.sec > h3'); if (h) toggleSection(h);
});
document.addEventListener('keydown', e => { // "/" jumps to the search, from anywhere that is not a text box
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || (e.target.closest && e.target.closest('input, select, textarea')) || !$('#modal').hidden) return;
  e.preventDefault(); if (!UI.insp) { UI.insp = true; applyUI(); renderInspector(); } const f = $('#inspFind'); if (f) { f.focus(); f.select(); }
});
function renderInspector() {
  const c = clipById(selClip), l = P.lanes.find(x => x.id === selLane);
  let html = '';
  if (c && c.kind === 'riser') html += `<div class="sec"><h3>${esc(c.name || 'Riser')}</h3><dl class="kv"><dt>Starts at</dt><dd>${fmtT(c.at)}</dd><dt>Length</dt><dd>${c.beats / 4} bar${c.beats === 4 ? '' : 's'}</dd></dl>
    <div class="field"><label for="rDir">Direction</label><select id="rDir" data-cf="dir"><option value="up" ${c.dir !== 'down' ? 'selected' : ''}>Up (a build into the drop)</option><option value="down" ${c.dir === 'down' ? 'selected' : ''}>Down (after the drop)</option></select><span></span></div>
    <div class="field"><label for="cGain">Volume</label><input id="cGain" type="range" min="0" max="300" value="${Math.round((c.gain ?? 1) * 100)}" data-cf="gain"><output>${Math.round((c.gain ?? 1) * 100)}%</output></div>
    <p class="hint">White noise and a rising tone, sweeping up over the part. Drag its right edge to make it longer; put it right before the drop.</p></div>`;
  else if (c && c.kind === 'pattern') html += patternInspectorHTML(c);
  else if (c && c.kind === 'midi') html += midiInspectorHTML(c);
  else if (c) {
    const t = libTrack(c.trackId), d = dur(c), a = ana[c.trackId], { r } = clipParams(c);
    const songBpm = a && a.bpm ? a.bpm : null, nowBpm = songBpm ? Math.round(songBpm * r * 10) / 10 : null;
    const nowKey = a && a.key != null ? keyName(a.key + (c.keepPitch === false ? Math.round(12 * Math.log2(r)) : c.semi), a.mode) : null;
    html += `<div class="sec"><h3>Selected part</h3>
      <dl class="kv"><dt>Song</dt><dd>${esc(t ? t.title : 'Missing song')}</dd><dt>Starts at</dt><dd>${fmtT(c.at)}</dd><dt>Length</dt><dd>${fmtT(d)}</dd>
      <dt>Song is</dt><dd>${a ? `${songBpm ? songBpm + ' BPM' : 'no steady beat'} · ${esc(a.keyName)}` : analyzing.has(c.trackId) ? 'working it out…' : '—'}</dd></dl>
      <div class="field"><label for="cGain">Volume</label><input id="cGain" type="range" min="0" max="300" value="${Math.round((c.gain ?? 1) * 100)}" data-cf="gain"><output>${Math.round((c.gain ?? 1) * 100)}%</output></div>
    <label class="chk"><input type="checkbox" data-pin ${c.pin ? 'checked' : ''}> Pin to the picture (stays on its cut)</label>
      <div class="field"><label for="cFi">Fade in</label><input id="cFi" type="range" min="0" max="${Math.min(10, d).toFixed(1)}" step="0.1" value="${(c.fadeIn || 0).toFixed(1)}" data-cf="fadeIn"><output>${(c.fadeIn || 0).toFixed(1)}s</output></div>
      <div class="field"><label for="cFo">Fade out</label><input id="cFo" type="range" min="0" max="${Math.min(10, d).toFixed(1)}" step="0.1" value="${(c.fadeOut || 0).toFixed(1)}" data-cf="fadeOut"><output>${(c.fadeOut || 0).toFixed(1)}s</output></div>
      <div class="field"><label for="cFxIn">Start style</label><select id="cFxIn" data-cs="fxIn"><option value="fade">Fade</option><option value="filter">Filter sweep</option></select><span></span></div>
      <div class="field"><label for="cFxOut">End style</label><select id="cFxOut" data-cs="fxOut"><option value="fade">Fade</option><option value="filter">Filter sweep</option><option value="echo">Echo out</option></select><span></span></div>
      <p class="hint">Drag across the waveform to select a stretch: <b>Delete</b> removes it, <b>K</b> keeps only it, <b>Ctrl+E</b> splits it off, <b>Ctrl+D</b> repeats it. Double-click the part for the detailed editor.</p>
      <div class="btnrow"><button class="btn sm" data-act="split">Split at playhead</button><button class="btn sm" data-act="dup">Copy after</button><button class="btn sm" data-act="mutepart">${c.mute ? 'Unmute part' : 'Mute part'}</button><button class="btn sm" data-act="del">Delete part</button></div>
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
    html += `<div class="sec"><h3>Selected part</h3><p class="hint">Click a part to change its volume, speed and key. To cut, drag across a part's waveform and press Delete. Drag a part's name bar to move it.</p></div>`;
  }
  if (l) {
    const fx = l.fx, f = fx.filter;
    html += `<div class="sec"><h3>Track: ${esc(l.name)}</h3><p class="hint">Songs you press “Add” on go to the end of this track. Effects apply to everything on it.</p>
      <div class="field"><label for="fBass">Bass</label><input id="fBass" type="range" min="-12" max="12" value="${fx.bass}" data-lx="bass"><output>${fx.bass > 0 ? '+' : ''}${fx.bass} dB</output></div>
      <div class="field"><label for="fTre">Treble</label><input id="fTre" type="range" min="-12" max="12" value="${fx.treble}" data-lx="treble"><output>${fx.treble > 0 ? '+' : ''}${fx.treble} dB</output></div>
      <div class="field"><label for="fFil">Filter</label><input id="fFil" type="range" min="-100" max="100" value="${f}" data-lx="filter"><output>${f === 0 ? 'off' : f < 0 ? 'muffle ' + -f : 'thin ' + f}</output></div>
      <div class="field"><label for="fEcho">Echo</label><input id="fEcho" type="range" min="0" max="100" value="${fx.echo}" data-lx="echo"><output>${fx.echo}%</output></div>
      <div class="field"><label for="fRev">Reverb</label><input id="fRev" type="range" min="0" max="100" value="${fx.reverb}" data-lx="reverb"><output>${fx.reverb}%</output></div>
      ${routingHTML(l)}
      ${l.type !== 'group' && l.type !== 'return' ? moutHTML(l) : ''}
      ${chainHTML(l)}
      ${HAS_TONE ? `<label class="chk"><input type="checkbox" data-lpump ${l.pump && l.pump.on ? 'checked' : ''}> Pump to the drum machine’s kick (sidechain)</label>
      ${l.pump && l.pump.on ? `<div class="field"><label for="tPump">Depth</label><input id="tPump" type="range" min="10" max="95" value="${Math.round((l.pump.depth ?? 0.7) * 100)}" data-lpumpd><output>${Math.round((l.pump.depth ?? 0.7) * 100)}%</output></div>` : ''}` : ''}
      <label class="chk"><input type="checkbox" data-lrole="dialogue" ${l.role === 'dialogue' ? 'checked' : ''}> This is the dialogue (for loudness measured on speech, and for ducking)</label>
      <div class="btnrow"><button class="btn sm" data-act="fxreset">Reset effects</button><button class="btn sm" data-act="closegaps">Close gaps</button></div></div>`;
  }
  html += linkSectionHTML();
  html += sceneSectionHTML();
  const keyOpts = ['<option value="">Not set</option>'].concat([0, 1].flatMap(mi => KEYS.map((k, i) => { const mode = mi ? 'minor' : 'major'; const sel = P.key && P.key.key === i && P.key.mode === mode; return `<option value="${i}|${mode}" ${sel ? 'selected' : ''}>${k} ${mode}</option>`; }))).join('');
  html += `<div class="sec"><h3>Mix</h3>
      <div class="field"><label for="pBpm">Tempo</label><input id="pBpm" type="number" min="40" max="240" step="0.1" value="${P.bpm || ''}" placeholder="auto" data-pf="bpm" style="height:30px;border-radius:7px;border:1px solid var(--line);background:var(--raise);padding:0 6px;width:100%"><output>BPM</output></div>
      ${tempoMapHTML()}
      <div class="field"><label for="pKey">Key</label><select id="pKey" data-pf="key">${keyOpts}</select><span></span></div>
      <p class="hint">Tempo and key are set from the first song you add. “Match mix tempo” and “Match mix key” bring other parts in line so they fit together.</p>
      <div class="field"><label for="xf">Join fade</label><input id="xf" type="range" min="0" max="4" step="0.1" value="${P.xfade}" data-pf="xfade"><output>${P.xfade.toFixed(1)}s</output></div>
      <label class="chk"><input type="checkbox" data-uiset="wheelZoom" ${UI.wheelZoom !== false ? 'checked' : ''}> The mouse wheel zooms over waveforms (off: it scrolls; Ctrl + wheel always zooms)</label>
      <label class="chk"><input type="checkbox" data-pc="snap" ${P.snap ? 'checked' : ''}> Snap to the beat</label>
      <label class="chk"><input type="checkbox" data-pc="polish" ${P.polish ? 'checked' : ''}> Polish: make it louder and more even</label>
      <label class="chk"><input type="checkbox" data-pc="limit" ${P.limit.on ? 'checked' : ''}> Limiter: keep the true peak under</label>
      <div class="field"><label for="pCeil">Ceiling</label><input id="pCeil" type="range" min="-6" max="0" step="0.1" value="${P.limit.ceiling}" data-pf="ceiling" ${P.limit.on ? '' : 'disabled'}><output>${P.limit.ceiling.toFixed(1)} dBTP</output></div>
      <div class="btnrow"><button class="btn sm" data-act="evenout">Even out volume between parts</button></div></div>
    ${masteringHTML()}
    <div class="sec"><h3>Keys</h3><div class="keys"><kbd>Space</kbd> play/pause · <kbd>Home</kbd> start · <kbd>L</kbd> loop<br><kbd>Del</kbd> remove selection or part · <kbd>K</kbd> keep only<br><kbd>Ctrl</kbd>+<kbd>E</kbd> split · <kbd>Ctrl</kbd>+<kbd>D</kbd> repeat<br><kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy/paste · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo<br><kbd>B</kbd> library · <kbd>I</kbd> settings · <kbd>X</kbd> mixer<br><kbd>M</kbd> hit point · <kbd>V</kbd> video · <kbd>T</kbd> tempo change<br><kbd>C</kbd> click · <kbd>+</kbd>/<kbd>−</kbd> zoom · click the time for bars</div></div>`;
  html = `<button class="rail" data-act="toggleinsp" title="Show the settings (I)"><span>◂</span><span class="rl">Settings</span></button>
    <div class="insp-tools"><button class="headbtn" data-act="toggleinsp" title="Fold the settings away for more room (I)">▸</button>
      <div class="findwrap"><input id="inspFind" type="search" placeholder="Find a setting  ( / )" aria-label="Find a setting" autocomplete="off" value="${esc(findQ)}"><div class="findlist" id="findList" hidden></div></div>
      <button class="btn sm ghost tsz" data-act="txtsize" data-d="-1" title="Smaller settings text" aria-label="Smaller settings text">A−</button><button class="btn sm ghost tsz" data-act="txtsize" data-d="1" title="Bigger settings text" aria-label="Bigger settings text">A+</button></div>` + html;
  const ins = $('#insp'), st = ins.scrollTop, hadFind = document.activeElement && document.activeElement.id === 'inspFind'; applyTextScale(); ins.innerHTML = html; foldSections(); if (hadFind) { const f = $('#inspFind'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); runFind(); } requestAnimationFrame(() => document.querySelectorAll('canvas.eqcv').forEach(drawEQ)); ins.scrollTop = st; applyTips();
  if (c && !['midi', 'pattern', 'riser'].includes(c.kind)) { $('#cFxIn').value = c.fxIn || 'fade'; $('#cFxOut').value = c.fxOut || 'fade'; }
}
function renderMixer() {
  $('#mixer').hidden = !UI.mixer; if (!UI.mixer) return;
  const anySolo = P.lanes.some(l => l.solo);
  $('#strips').innerHTML = P.lanes.map(l => {
    const fxOn = Object.values(l.fx).some(v => v), v = Math.round(l.gain * 100);
    return `<div class="strip" data-lane="${l.id}" style="--c:${l.color || PALETTE[0]};${anySolo && !l.solo || l.mute ? 'opacity:.55' : ''}" title="${esc(l.name)}">
      <span class="nm">${esc(l.name)}</span>
      <div class="fdr"><input class="vert" type="range" min="0" max="150" value="${v}" data-mx="gain" aria-label="${esc(l.name)} volume"><div class="meter"><i></i></div></div>
      <output>${v}%</output>
      <input class="pan" type="range" min="-100" max="100" value="${Math.round(l.pan * 100)}" data-mx="pan" aria-label="${esc(l.name)} left-right balance" title="Left-right balance">
      <div class="ms"><button class="tg m${l.mute ? ' on' : ''}" data-mx="mute" title="Mute this track">M</button><button class="tg s${l.solo ? ' on' : ''}" data-mx="solo" title="Hear only this track">S</button></div>
      <button class="fxb${fxOn ? ' on' : ''}" data-mx="fx" title="Bass, treble, filter, echo and reverb for this track">${fxOn ? 'Effects on' : 'Effects'}</button>
    </div>`; }).join('') + `<div class="strip master" data-lane="master" title="Master: the volume of the whole mix">
      <span class="nm">Master</span>
      <div class="fdr"><input class="vert" type="range" min="0" max="150" value="${Math.round((P.master ?? 1) * 100)}" data-mx="master" aria-label="Master volume"><div class="meter"><i></i></div></div>
      <output>${Math.round((P.master ?? 1) * 100)}%</output>
      <span class="hint" style="font-size:10px;text-align:center">${P.limit.on ? `Limit ${P.limit.ceiling.toFixed(1)}` : 'Whole mix'}</span></div>`;
}
const meterBuf = new Float32Array(512);
function peakOf(an) { an.getFloatTimeDomainData(meterBuf); let p = 0; for (let i = 0; i < meterBuf.length; i++) { const a = Math.abs(meterBuf[i]); if (a > p) p = a; } return p; }
function updateMeters() {
  if (!graph) return;
  $$('#strips .strip').forEach(st => {
    const id = st.dataset.lane, an = id === 'master' ? graph.mmeter : graph.lanes.get(id)?.meter; if (!an) return;
    const db = 20 * Math.log10(peakOf(an) + 1e-6), pct = clamp((db + 48) / 48, 0, 1) * 100;
    st.querySelector('.meter i').style.height = pct + '%';
  });
}
$('#strips').addEventListener('input', e => {
  const st = e.target.closest('.strip'), k = e.target.dataset.mx; if (!st || !k) return;
  if (k === 'master') { P.master = e.target.value / 100; st.querySelector('output').textContent = e.target.value + '%'; liveLanes(); return; }
  const l = P.lanes.find(x => x.id === st.dataset.lane); if (!l) return;
  if (k === 'gain') { l.gain = e.target.value / 100; st.querySelector('output').textContent = e.target.value + '%'; }
  if (k === 'pan') l.pan = e.target.value / 100;
  liveLanes();
});
$('#strips').addEventListener('change', e => { if (e.target.dataset.mx) { quietCommit(); renderLanes(); } });
$('#strips').addEventListener('click', e => {
  const b = e.target.closest('button[data-mx]'), st = e.target.closest('.strip'); if (!b || !st) return;
  const l = P.lanes.find(x => x.id === st.dataset.lane); if (!l) return;
  if (b.dataset.mx === 'mute') l.mute = !l.mute;
  else if (b.dataset.mx === 'solo') l.solo = !l.solo;
  else if (b.dataset.mx === 'fx') { selLane = l.id; selClip = null; if (!UI.insp) { UI.insp = true; applyUI(); } renderLanes(); renderInspector(); $('#insp').scrollTop = 0; return; }
  liveLanes(); quietCommit(); renderLanes(); renderMixer();
});
/* Listening in the library: one song at a time, from a little way in, click again to stop */
let libPrev = null;
function stopLibPrev() { if (!libPrev) return; libPrev.audio.pause(); URL.revokeObjectURL(libPrev.url); libPrev = null; renderLibrary(); }
function toggleLibPrev(id) {
  const same = libPrev && libPrev.id === id; stopLibPrev(); if (same) return;
  const t = libTrack(id); if (!t) return;
  pause(); stopPreview();
  const url = URL.createObjectURL(t.blob), audio = new Audio(url);
  audio.addEventListener('loadedmetadata', () => { if (audio.duration > 40) audio.currentTime = audio.duration * 0.3; }, { once: true });
  audio.addEventListener('ended', stopLibPrev, { once: true });
  audio.play().catch(() => {}); libPrev = { id, audio, url }; renderLibrary();
}
function renderLibrary() {
  const q = $('#libQ').value.trim().toLowerCase();
  const list = lib.filter(t => !t.stemOf && t.kind !== 'video' && (!q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)));
  $('#lib').innerHTML = list.length ? list.map(t => { const a = ana[t.id];
    const info = a ? `<span class="bk">${a.bpm ? a.bpm + ' BPM' : 'no steady beat'} · ${esc(a.keyName)}</span>` : analyzing.has(t.id) ? '<span class="bk busy">finding tempo and key…</span>' : '';
    return `<li draggable="true" data-drag="${t.id}" title="Drag onto a track"><button class="lp${libPrev && libPrev.id === t.id ? ' on' : ''}" data-libprev="${t.id}" title="${libPrev && libPrev.id === t.id ? 'Stop listening' : 'Listen'}" aria-label="${libPrev && libPrev.id === t.id ? 'Stop listening to' : 'Listen to'} ${esc(t.title)}">${libPrev && libPrev.id === t.id ? '■' : '▶'}</button><div style="min-width:0"><b title="${esc(t.title)}">${esc(t.title)}</b><span class="li-sub">${esc(t.artist || 'Unknown artist')} · ${fmtT(t.duration).replace(/\.\d$/, '')}</span>${info}</div>
      <div class="acts"><button data-add="append" data-id="${t.id}" title="Add to the end of the selected track">Add</button><button data-add="layer" data-id="${t.id}" title="Put it on a new track at the playhead">New track</button></div></li>`; }).join('')
    : `<li class="empty-note">${lib.length ? 'No songs match your search.' : 'No songs yet. Press “Import audio files” above, or drop music files onto the timeline.'}</li>`;
  const n = lib.filter(t => !t.stemOf && t.kind !== 'video').length; $('#libCount').textContent = `${n} song${n === 1 ? '' : 's'}`;
}
function renderTransport() {
  $('#playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#undoBtn').disabled = !hist.length; $('#redoBtn').disabled = !fut.length;
  $('#saveBtn').disabled = !P.clips.length || !!rec;
  $('#loopBtn').setAttribute('aria-pressed', !!(P.loopOn && P.loop));
  $('#loopLockBtn').setAttribute('aria-pressed', !!(P.loopLock && P.loopOn && P.loop)); $('#loopLockBtn').classList.toggle('dim', !P.loop);
  $('#metroBtn').setAttribute('aria-pressed', !!P.metro); $('#vidBtn').setAttribute('aria-pressed', !!(P.video && UI.vwin)); $('#mixBtn').setAttribute('aria-pressed', !!UI.mixer);
  $('#libBtn').setAttribute('aria-pressed', UI.lib); $('#inspBtn').setAttribute('aria-pressed', UI.insp);
  $$('.hsz button').forEach(b => b.setAttribute('aria-pressed', b.dataset.h === UI.h));
  $('#snapBtn').setAttribute('aria-pressed', P.snap);
  $('#edgeTrim').setAttribute('aria-pressed', UI.edgeMode !== 'stretch'); $('#edgeStretch').setAttribute('aria-pressed', UI.edgeMode === 'stretch'); $('#tl').classList.toggle('stretchmode', UI.edgeMode === 'stretch'); $('#monoBtn').setAttribute('aria-pressed', monoOn); $('#followBtn').setAttribute('aria-pressed', UI.follow !== false);
  $('#tempoLbl').textContent = P.bpm ? `${Math.round(tempoAt(curPos()) * 10) / 10} BPM${(P.tempoChanges || []).length ? ' (map)' : ''}${P.key ? ' · ' + keyName(P.key.key, P.key.mode) : ''}` : '— BPM';
  $('#recBtn').classList.toggle('on', !!rec);
  $('#recLbl').textContent = rec ? `Stop recording ${fmtT((Date.now() - rec.began) / 1000).replace(/\.\d$/, '')}` : 'Record voice';
}
function renderAll() { $('#projName').value = P.name; $('#ampBtn').textContent = `Wave ×${UI.amp || 1}`; renderLanes(); drawEditor(); renderInspector(); renderTransport(); renderMixer(); applyTips(); }

/* ---------- interaction ---------- */
const acts = {
  play: () => playing ? (rec ? stopRecord() : pause()) : play(), stop: () => { if (rec) return stopRecord(); pause(); seek(0); $('#tl').scrollLeft = 0; },
  undo, redo, save: saveSong, record: toggleRecord,
  edfold: () => { UI.edFold = !UI.edFold; saveUI(); drawEditor(); requestAnimationFrame(() => { renderRuler(); renderLoop(); drawOverview(); }); },
  slimhead: () => { UI.slimHead = !UI.slimHead; saveUI(); renderLanes(); renderVideoRow(); toast(UI.slimHead ? 'Track names folded away. Hover a track’s colour to see its name; click ▸ to bring them back.' : 'Track names back.'); },
  zin: () => { pushZoom(true); zoom(1.5); }, zout: () => { pushZoom(true); zoom(1 / 1.5); }, fit: fitZoom, zsel: zoomToSelection, zprev: prevZoom, amp: cycleAmp, demo: () => loadDemo(), shortcuts: showShortcuts, tour: () => startTour(true),
  edzin: () => edZoom(1 / 1.6), edzout: () => edZoom(1.6), edfit: () => edFit('part'), edall: () => edFit('all'),
  snap: () => { P.snap = !P.snap; if (P.snap && !P.bpm) toast('Add a song first so the Studio can find the beat.'); commit(P.snap ? 'Snapping to the beat' : 'Snap off'); },
  addlane: b => { const r = b.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, [
    { label: 'Track', act: () => { const l = newLane(P.lanes.length + 1); P.lanes.push(l); selLane = l.id; commit('Track added'); } },
    { label: 'Group track (several tracks through one fader and effects)', act: () => addGroup() },
    { sep: true },
    { label: 'Reverb return (one shared reverb)', act: () => addReturn('hall') },
    { label: 'Delay return (one shared delay)', act: () => addReturn('pingpong') },
  ]); },
  selall: () => { const c = clipById(selClip); if (c) { edSel = { a: c.start, b: c.end }; drawEditor(); } },
  prevsel: previewSel, keep: keepSel, remove: removeSel,
  selappend: () => { const c = clipById(selClip); if (c && edSel) addRegion(c.trackId, edSel.a, edSel.b, 'append'); },
  sellayer: () => { const c = clipById(selClip); if (c && edSel) addRegion(c.trackId, edSel.a, edSel.b, 'layer'); },
  split: splitAtPlayhead, dup: dupClip, del: deleteClip, loop: b => loopClip(+b.dataset.n),
  closegaps: () => selLane && closeGaps(selLane),
  matchtempo: matchTempo, matchkey: matchKey, evenout: evenOut, stems: splitStems,
  import: () => $('#fileIn').click(),
  mutepart: toggleMutePart,
  linkfolder: linkFolder, relink: reconnectFolder, unlink: unlinkFolder, syncnow: () => syncPackage(true), deliverfinal: deliverFinal,
  addtempo: () => addTempoChange(curPos()), fittempo: fitTempoToHits,
  video: () => { if (!P.video) return $('#vidIn').click(); UI.vwin = !UI.vwin; saveUI(); renderVideoWindow(); renderTransport(); if (UI.vwin) { ensureVideoEl().then(() => scrubVideo(curPos())); } },
  vwclose: force => { UI.vwin = force === true ? !UI.vwin : false; saveUI(); renderVideoWindow(); renderTransport(); if (UI.vwin) ensureVideoEl().then(() => scrubVideo(curPos())); },
  vfull: () => { const w = $('#vwin'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else w.requestFullscreen?.().catch(() => toast('Full screen is not available here.')); },
  addhit: () => addMarker(curPos()), findcuts: findCuts, savehits: exportMarkers, loadhits: () => $('#mkIn').click(), fit: fitBetween,
  actionzero: () => { if (!P.video) return; if (P.video.locked) return toast('The picture is locked. Unlock it first.'); const d = P.video.at; P.video.at = 0; P.clips.forEach(c => { c.at = Math.max(0, c.at - d); }); (P.markers || []).forEach(m => { if (m.vt == null) m.t = Math.max(0, m.t - d); }); commit('The action now starts at 0:00. Export can put the lead-in back.'); },
  togglemixer: () => { UI.mixer = !UI.mixer; saveUI(); renderMixer(); renderTransport(); requestAnimationFrame(() => { renderLanes(); }); },
  metro: () => { if (!P.bpm) return toast('Set the mix tempo first: add a song with a beat, or type a tempo under Mix on the right.', 5000); P.metro = !P.metro; quietCommit(); renderTransport(); restartIfPlaying(); toast(P.metro ? `Click on at ${P.bpm} BPM` : 'Click off'); },
  rulermode: () => {
    const modes = ['time'].concat(beatLen() ? ['bars'] : [], ['tc']); const i = modes.indexOf(clockMode());
    UI.clock = modes[(i + 1) % modes.length]; UI.bars = UI.clock === 'bars'; saveUI(); renderRuler(); drawPlayhead();
    toast({ time: 'Showing minutes and seconds', bars: 'Showing bars and beats', tc: `Showing film time (hours:minutes:seconds:frames at ${fpsOf()} fps)` }[UI.clock]);
  },
  showlib: () => { if (!UI.lib) { UI.lib = true; applyUI(); } const f = $('.lib li[draggable]'); if (f) { f.animate([{ outline: '2px solid #F5A524' }, { outline: '2px solid transparent' }], { duration: 1400 }); } else toast('Your library is empty. Use “Import songs” first.'); },
  togglelib: () => { UI.lib = !UI.lib; applyUI(); },
  toggleinsp: () => { UI.insp = !UI.insp; applyUI(); },
  lh: b => { UI.h = b.dataset.h; P.lanes.forEach(l => { l.h = null; l.folded = false; }); quietCommit(); applyUI(); },
  follow: () => { UI.follow = UI.follow === false; saveUI(); renderTransport(); toast(UI.follow ? 'Follow on: the view scrolls along with playback.' : 'Follow off: the view stays where you put it while the music plays.', 3500); },
  looplock: () => {
    if (!P.loop) return toast('Mark a loop first: drag along the time ruler above the tracks.', 4500);
    P.loopLock = !P.loopLock; if (P.loopLock) P.loopOn = true;
    quietCommit(); renderLoop(); renderRuler(); renderTransport(); restartIfPlaying();
    toast(P.loopLock ? 'Loop locked: playback stays in it wherever you click.' : 'Loop unlocked: a click outside it turns the loop off and plays from there.', 4000);
  },
  looptoggle: () => {
    if (!P.loop) { if (tlSel) return setLoop(tlSel.a, tlSel.b, 'Looping the selected stretch'); return toast('Drag along the time ruler above the tracks to mark the section to loop.', 4500); }
    P.loopOn = !P.loopOn; quietCommit(); renderLoop(); renderRuler(); renderTransport(); toast(P.loopOn ? 'Loop on' : 'Loop off');
  },
  edclose: () => { edOpen = false; edSel = null; stopPreview(); drawEditor(); },
  fxreset: () => { const l = P.lanes.find(x => x.id === selLane); if (l) { l.fx = FX0(); commit('Effects reset'); liveLanes(); } },
  newproj: () => newMix(),
  pathouse: () => { const c = clipById(selClip); if (c && c.kind === 'pattern') { c.pat.rows = housePattern(c.pat.bars || 1); patLive(c); renderInspector(); toast('House beat: kick on every beat, clap on 2 and 4, open hats on the off-beats.'); } },
  patclear: () => { const c = clipById(selClip); if (c && c.kind === 'pattern') { for (const [k] of DRUM_ROWS) c.pat.rows[k] = Array(patN(c)).fill(0); patLive(c); } },
  drummachine: () => newDrumMachine(),
  edgemode: b => { UI.edgeMode = b.dataset.m; saveUI(); renderTransport(); renderLanes(); toast(UI.edgeMode === 'stretch' ? 'Stretch: dragging a part’s edge now makes it play faster or slower to fill the length (pitch kept). The edges turn orange.' : 'Trim: dragging a part’s edge now shows more or less of it.', 5000); },
  txtsize: b => { const S = [0.9, 1, 1.15, 1.3, 1.5, 1.75], i = S.indexOf(textScale()), j = clamp((i < 0 ? 2 : i) + (+b.dataset.d), 0, S.length - 1); UI.ts = S[j]; saveUI(); applyTextScale(); renderInspector(); toast(`Settings text ${Math.round(S[j] * 100)}%`, 1500); },
  midiouts: async () => { if (await ensureMidiAccess()) { const n = midiAccess.outputs.size; toast(n ? `Found ${n} MIDI output${n === 1 ? '' : 's'}: ${[...midiAccess.outputs.values()].map(o => o.name).join(', ')}.` : 'No MIDI outputs found. Make a loopback cable first: see How to set up LABS.', 6000); } renderInspector(); },
  labshelp: () => labsHelp(),
  mouttest: () => { const l = P.lanes.find(x => x.id === selLane), mo = moutOf(l); if (!mo) return toast('That MIDI output is not connected.'); [60, 64, 67].forEach((p, i) => { msend(mo, [0x90 | mo.ch, p, 96], performance.now() + i * 250); msend(mo, [0x80 | mo.ch, p, 0], performance.now() + i * 250 + 600); }); toast(`Sent C, E, G to ${l.mout.name} on channel ${l.mout.ch || 1}. If you heard nothing, check the other app’s MIDI input.`, 6000); },
  mono: () => {
    monoOn = !monoOn;
    for (const gr of [graph, pendingLoop && pendingLoop.graph]) if (gr && gr.monoSw) { const now = ctx.currentTime; gr.monoSw.st.gain.setTargetAtTime(monoOn ? 0 : 1, now, 0.01); gr.monoSw.mg.gain.setTargetAtTime(monoOn ? 1 : 0, now, 0.01); }
    renderTransport(); renderInspector(); toast(monoOn ? 'Mono: this is the mix as one speaker plays it. If a part gets much quieter or vanishes, it is out of phase.' : 'Back to stereo.', 4500);
  },
  checkmaster: () => checkMaster(),
  writechords: () => writeChords(), fitscale: () => fitToScale(),
  dynp: b => {
    const c = clipById(selClip); if (!c || c.kind !== 'midi') return; const a = c.start, z = c.end, m = (a + z) / 2, k = b.dataset.k;
    const d = { swell: [{ t: a, v: 0.3 }, { t: z, v: 1 }], fade: [{ t: a, v: 1 }, { t: z, v: 0.3 }], hairpin: [{ t: a, v: 0.3 }, { t: m, v: 1 }, { t: z, v: 0.3 }] }[k];
    if (d) c.dyn = d; else delete c.dyn; edOpen = true; commit({ swell: 'Dynamics: a swell', fade: 'Dynamics: a fade', hairpin: 'Dynamics: swell, then fade' }[k] || 'Dynamics cleared: full volume');
  },
  midiconnect: () => connectMidi(),
  qwerty: () => { qwerty = !qwerty; renderInspector(); toast(qwerty ? 'The computer keys play notes: A W S E D F T G Y H U J K (black keys on the row above). Z and X change octave, Shift plays louder, Esc stops.' : 'The computer keys work as shortcuts again.', 6000); },
  recnotes: () => toggleRecNotes(),
  orchmenu: b => { if (!ORCH) return toast('The orchestra could not be found. Reload the page.'); const r = b.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, [...Object.entries(SECTIONS).map(([k, v]) => ({ label: `New ${v.name.toLowerCase()} track`, act: () => newInstrumentTrack(k) })), { sep: true }, ...Object.entries(ORCH.instruments).map(([k, v]) => ({ label: `New ${v.name.toLowerCase()} track`, act: () => newInstrumentTrack('o_' + k) }))]); },
  instmenu: b => { const r = b.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, [{ label: 'New drum machine (house beat)', act: newDrumMachine }, { label: 'New orchestral track…', act: () => acts.orchmenu(b) }, { label: 'New riser (build-up into the playhead)', act: () => newRiser('up') }, { label: 'New downlifter (after the playhead)', act: () => newRiser('down') }, { label: 'Import a MIDI file…', act: () => $('#midiIn').click() }, { sep: true },
    ...[['s_piano', 'grand piano'], ['s_gm4', 'electric piano'], ['s_gm25', 'acoustic guitar'], ['s_gm33', 'bass guitar'], ['s_gm48', 'string ensemble'], ['s_gm52', 'choir'], ['s_gm89', 'warm pad'], ['s_kit0', 'drum kit']].filter(([k]) => MixtapeMIDI.INSTRUMENTS[k]).map(([k, n]) => ({ label: `New ${n} track (recorded)`, act: () => newInstrumentTrack(k) })),
    { label: 'New track with any other sound… (pick it in the track’s settings)', act: () => newInstrumentTrack() }]); },
  quantize, exportmidi: exportMidi, findtempo: findTempo,
  projects: b => projectsMenu(b),
};
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled && acts[b.dataset.act]) acts[b.dataset.act](b, e); });
$('#lib').addEventListener('click', e => {
  const p = e.target.closest('[data-libprev]'); if (p) return toggleLibPrev(p.dataset.libprev);
  const b = e.target.closest('[data-add]'); if (b) { stopLibPrev(); addRegion(b.dataset.id, 0, null, b.dataset.add); }
});
$('#libQ').addEventListener('input', renderLibrary);
$('#projName').addEventListener('change', e => { P.name = e.target.value.trim() || 'My mix'; commit(); });

function applyUI() {
  saveUI();
  $('.work').classList.toggle('nolib', !UI.lib); $('.work').classList.toggle('noinsp', !UI.insp);
  renderTransport(); requestAnimationFrame(() => { renderLanes(); drawEditor(); });
}
const TIPS = {
  split: 'Split the part at the red playhead (S)', dup: 'Copy this part right after itself', del: 'Delete this part (Delete)', stems: 'Split into vocals, drums, bass and other instruments',
  loop: 'Repeat this part', closegaps: 'Slide parts on this track together so there are no silences', fxreset: 'Set all effects on this track back to zero',
  evenout: 'Make every part about as loud as the others', matchtempo: 'Speed this part up or down to the mix tempo', matchkey: 'Shift this part into the mix key',
  selall: 'Select the whole part in the editor', prevsel: 'Hear the selection on its own', keep: 'Keep only the selected stretch (K)', remove: 'Remove the selected stretch and close the gap (Delete)',
  selappend: 'Copy the selection to the end of this track', sellayer: 'Copy the selection onto a new track', addlane: 'Add a track, a group track or a shared reverb/delay', mutepart: 'Mute or unmute this part',
  import: 'Pick music files from this computer', showlib: 'Show your library on the left', record: 'Record your voice over the mix, with a one-bar count-in',
};
document.addEventListener('mouseover', e => {
  const bar = document.getElementById('hintbar'); if (!bar || !e.target.closest) return;
  let tip = '';
  const z = e.target.closest('[data-h],[data-fade],.cl,.clip,svg.auto,.lane-grip,#ruler,#overview,#edWrap,.lane-body,[title],[aria-label]');
  if (z) {
    if (z.dataset && z.dataset.h) tip = UI.edgeMode === 'stretch' ? 'Drag to stretch the part: it plays faster or slower to fill the new length (Stretch mode, top bar).' : 'Drag to trim this end of the part (Trim mode, top bar).';
    else if (z.dataset && z.dataset.fade) tip = `Drag to fade ${z.dataset.fade === 'in' ? 'in' : 'out'}.`;
    else if (z.classList.contains('cl')) tip = 'Drag the name bar to move the part, even onto another track. Double-click to open it in the part editor.';
    else if (z.classList.contains('clip')) tip = 'Drag across the waveform to select a stretch, then Delete removes it or K keeps only it. Right-click for more.';
    else if (z.matches('svg.auto')) tip = 'Click to add a point, drag to move it, double-click to remove it.';
    else if (z.classList.contains('lane-grip')) tip = 'Drag to make this track taller or shorter.';
    else if (z.id === 'ruler') tip = 'Click to move the playhead. Drag sideways to mark a loop; drag up or down to zoom.';
    else if (z.id === 'overview') tip = 'The whole mix. Drag the box to move around, drag its edges to zoom.';
    else if (z.id === 'edWrap') tip = 'Drag to select. The wheel zooms where the mouse is; Shift + wheel moves along the song. Click the strip at the top to jump.';
    else if (z.classList.contains('lane-body')) tip = 'Click to move the playhead here. The wheel zooms where the mouse is; Shift + wheel moves sideways; Alt + wheel makes waveforms taller.';
    else tip = z.getAttribute('title') || z.getAttribute('aria-label') || '';
  }
  bar.textContent = tip || 'Press ? to see every shortcut.';
});
function showShortcuts() {
  const g = (h, rows) => `<div class="kgroup"><h4>${h}</h4>${rows.map(([k, d]) => `<div class="krow"><span class="keys">${k.split(' ').map(x => `<kbd>${x}</kbd>`).join(' ')}</span><span>${d}</span></div>`).join('')}</div>`;
  ask({ title: 'Shortcuts', ok: 'Close', extra: `<div class="ksheet">
    ${g('Play', [['Space', 'Play or pause'], ['Home', 'Back to the start'], ['L', 'Loop on or off'], ['F', 'Follow the playhead on or off'], ['C', 'Click track']])}
    ${g('See', [['Wheel', 'Zoom where the mouse is, over a waveform (or pinch)'], ['Shift wheel', 'Move along the timeline'], ['Wheel on names', 'Scroll up and down the tracks'], ['+ −', 'Zoom in and out'], ['Z', 'Zoom to the selection'], ['Shift Z', 'Back to the previous zoom'], ['Alt wheel', 'Taller or shorter waveforms'], ['B', 'Library'], ['I', 'Settings'], ['X', 'Mixer'], ['V', 'Video window']])}
    ${g('Edit', [['Del', 'Remove the selected stretch or part'], ['K', 'Keep only the selection'], ['Ctrl E', 'Split it off'], ['S', 'Split at the playhead (or around the selection)'], ['Ctrl D', 'Repeat'], ['Ctrl C', 'Copy'], ['Ctrl V', 'Paste at the playhead'], ['Ctrl Z', 'Undo (Ctrl Y redoes)']])}
    ${g('Score to picture', [['M', 'Hit point at the playhead'], ['T', 'Tempo change at the playhead']])}
  </div>
  <div class="credits"><h4>Made with</h4>
    <p>Tone.js by Yotam Mann (MIT licence): drum machine, synths and effects.</p>
    <p>VSCO 2 Community Edition by Versilian Studios (Sam Gossner) and Ivy Audio (Simon Dalzell) (CC0, public domain): the orchestra.</p>
    <p>Salamander Grand Piano V3 by Alexander Holm (CC-BY 3.0): the grand piano.</p>
    <p>GeneralUser GS by S. Christian Collins (GeneralUser GS licence v2.0): the recorded General MIDI instruments and drum kits.</p>
    <p>Salamander Drumkit by Alexander Holm, kinwie and Jesse Chappell (CC BY-SA 3.0): the Salamander acoustic kit.</p>
    <p>ONNX Runtime Web (MIT) and Demucs by Meta AI, via demucs-web (MIT): splitting songs into stems.</p>
    <p>Everything you make with these is yours to release and sell.</p></div>` });
}
/* First visit: three short pointers, then out of the way for good */
function startTour(force) {
  if (!force && UI.toured) return;
  const steps = [
    { el: '#lib', text: 'Your songs. Press ▶ to listen, then drag one onto a track, or press Add.' },
    { el: '#tl', text: 'The timeline. Turn the mouse wheel over a waveform to zoom in and out where the mouse is; Shift + wheel moves sideways. Drag a part’s name bar to move it; drag across its waveform to select a stretch.' },
    { el: '#playBtn', text: 'Space plays and pauses. Everything you do is saved as you go, and Ctrl + Z undoes it. Press ? any time for the shortcuts.' },
  ];
  let i = 0; const tip = document.getElementById('coach');
  const show = () => {
    const s = steps[i], t = $(s.el); if (!t || t.offsetParent === null) return next();
    const r = t.getBoundingClientRect();
    tip.querySelector('p').textContent = s.text; tip.querySelector('.cstep').textContent = `${i + 1} of ${steps.length}`;
    tip.querySelector('[data-coach="next"]').textContent = i === steps.length - 1 ? 'Got it' : 'Next';
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x, y;
    if (r.height > innerHeight * 0.35) { // a tall panel: sit beside it, near its top, so what it describes stays visible
      x = r.right + 12 + tw < innerWidth ? r.right + 12 : Math.max(12, r.left - tw - 12); y = clamp(r.top + 60, 12, innerHeight - th - 12);
      if (r.width > innerWidth * 0.5) { x = clamp(r.left + 60, 12, innerWidth - tw - 12); y = clamp(r.top + 110, 12, innerHeight - th - 12); }
    } else { x = clamp(r.left + r.width / 2 - tw / 2, 12, innerWidth - tw - 12); y = r.bottom + 12; if (y + th > innerHeight - 12) y = Math.max(12, r.top - th - 12); }
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    $$('.coach-target').forEach(x => x.classList.remove('coach-target')); t.classList.add('coach-target');
  };
  const done = () => { tip.hidden = true; $$('.coach-target').forEach(x => x.classList.remove('coach-target')); UI.toured = true; saveUI(); };
  const next = () => { i++; if (i >= steps.length) return done(); show(); };
  tip.onclick = e => { const b = e.target.closest('[data-coach]'); if (!b) return; b.dataset.coach === 'skip' ? done() : next(); };
  show();
}
function applyTips() { $$('[data-act]').forEach(b => { if (!b.title && TIPS[b.dataset.act]) b.title = TIPS[b.dataset.act]; }); }
/* Zoom keeps the moment under the pointer (or the middle of the view) where it is, like Audacity */
const PPS_MIN = 2, PPS_MAX = 800;
const zoomHist = []; let zoomHistAt = 0;
function pushZoom(force) {
  const now = performance.now(); if (!force && now - zoomHistAt < 700) return; zoomHistAt = now;
  const tl = $('#tl'), top = zoomHist[zoomHist.length - 1];
  if (top && Math.abs(top.pps - pps) < 1e-6 && Math.abs(top.sl - tl.scrollLeft) < 2) return;
  zoomHist.push({ pps, sl: tl.scrollLeft }); if (zoomHist.length > 40) zoomHist.shift();
}
function prevZoom() {
  const z = zoomHist.pop(); if (!z) return toast('No earlier zoom to go back to.');
  pps = z.pps; renderLanes(); drawEditor(); $('#tl').scrollLeft = z.sl; zoomHistAt = 0; syncZoomUI();
}
// when you are working in the timeline, playback stops dragging the view away from you for a few seconds
let navAt = 0, progScroll = false;
const userNav = () => { navAt = performance.now(); };
function zoom(f, anchorT, anchorX) {
  const tl = $('#tl'), viewW = tl.clientWidth - headW(), ax = anchorX ?? viewW / 2;
  const t = anchorT ?? (tl.scrollLeft + ax) / pps;
  const next = clamp(pps * f, PPS_MIN, PPS_MAX); if (Math.abs(next - pps) < 1e-9) return;
  pps = next; renderLanes(); drawEditor();
  tl.scrollLeft = Math.max(0, t * pps - ax);
  syncZoomUI();
}
const AMPS = [1, 2, 4, 8];
function setAmp(a) {
  UI.amp = clamp(a, 1, 8); saveUI(); renderLanes(); drawEditor();
  const b = $('#ampBtn'); if (b) b.textContent = `Wave ×${UI.amp}`;
}
function cycleAmp() { const i = AMPS.indexOf(UI.amp || 1); setAmp(AMPS[(i + 1) % AMPS.length]); toast(UI.amp === 1 ? 'Waveforms at true size' : `Waveforms drawn ${UI.amp}× taller. The sound is unchanged.`); }
function fitZoom() { pushZoom(true); const end = Math.max(projectEnd(), 20); pps = clamp(($('#tl').clientWidth - headW() - 40) / end, PPS_MIN, PPS_MAX); renderLanes(); $('#tl').scrollLeft = 0; syncZoomUI(); }
function zoomToRange(a, b) {
  pushZoom(true); userNav();
  const tl = $('#tl'), viewW = tl.clientWidth - headW();
  pps = clamp((viewW - 60) / Math.max(0.05, b - a), PPS_MIN, PPS_MAX); renderLanes(); drawEditor();
  tl.scrollLeft = Math.max(0, a * pps - 30); syncZoomUI();
}
function zoomToSelection() {
  if (tlSel) return zoomToRange(tlSel.a, tlSel.b);
  const c = clipById(selClip); if (c) return zoomToRange(c.at, c.at + dur(c));
  if (loopActive()) return zoomToRange(P.loop.a, P.loop.b);
  toast('Select a part or drag across a stretch first, then press Z to zoom to it.');
}
const ppsToSlider = v => Math.round(1000 * Math.log(v / PPS_MIN) / Math.log(PPS_MAX / PPS_MIN));
const sliderToPps = s => PPS_MIN * Math.pow(PPS_MAX / PPS_MIN, s / 1000);
function syncZoomUI() { const s = $('#zoomSlider'); if (s) s.value = ppsToSlider(pps); drawOverview(); }
$('#zoomSlider').addEventListener('pointerdown', () => pushZoom(true));
$('#zoomSlider').addEventListener('input', e => { userNav(); zoom(sliderToPps(+e.target.value) / pps); });
// Ctrl/Cmd + scroll or a trackpad pinch zooms at the pointer; Shift + scroll moves along the timeline; plain scroll moves up and down
$('#tl').addEventListener('wheel', e => {
  userNav();
  if (e.altKey && !(e.ctrlKey || e.metaKey)) { e.preventDefault(); return setAmp((UI.amp || 1) * (e.deltaY < 0 ? 2 : 0.5)); } // Alt + scroll: taller or shorter waveforms
  // The wheel zooms over the waveforms (unless switched off in Settings); over the track names it scrolls up and down; Shift moves sideways
  const overWave = e.target.closest && e.target.closest('.lane-body,#ruler,.vlane,#vrow') && !e.target.closest('.lane-head');
  const zoomIt = e.ctrlKey || e.metaKey || (UI.wheelZoom !== false && overWave && !e.shiftKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX));
  if (!zoomIt) return;
  e.preventDefault(); pushZoom();
  const r = $('#tl').getBoundingClientRect(), ax = clamp(e.clientX - r.left - headW(), 0, r.width);
  zoom(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), undefined, ax);
}, { passive: false });
$('#tl').addEventListener('scroll', () => { if (progScroll) progScroll = false; else userNav(); drawOverview(); }, { passive: true });
$('#lanes').addEventListener('pointerdown', userNav, true);
/* The overview: the whole mix in one thin strip, with a box showing the part you are looking at. Drag the box to move, drag its edges to zoom. */
function drawOverview() {
  const box = $('#overview'); if (!box) return;
  const show = P.clips.length > 0; box.hidden = !show; if (!show) return;
  const cv = $('#ovCanvas'), r = dpr(), w = box.clientWidth, h = box.clientHeight, end = Math.max(projectEnd(), 1) * 1.02;
  cv.width = Math.round(w * r); cv.height = Math.round(h * r);
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  const n = Math.max(1, P.lanes.length), lh = (h - 4) / n;
  P.lanes.forEach((l, i) => {
    g.fillStyle = withAlpha(l.color || PALETTE[0], laneAudible(l) ? 0.85 : 0.3);
    for (const c of P.clips) if (c.lane === l.id) g.fillRect(c.at / end * w, 2 + i * lh, Math.max(1, dur(c) / end * w), Math.max(1, lh - 1));
  });
  const tl = $('#tl'), a = tl.scrollLeft / pps, b = a + (tl.clientWidth - headW()) / pps;
  const x0 = clamp(a / end * w, 0, w), x1 = clamp(b / end * w, 0, w);
  g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(x0, 0, Math.max(4, x1 - x0), h);
  g.strokeStyle = css('--ink'); g.lineWidth = 1.5; g.strokeRect(x0 + 0.75, 0.75, Math.max(4, x1 - x0) - 1.5, h - 1.5);
  const p = curPos() / end * w; g.fillStyle = css('--danger'); g.fillRect(p, 0, 1.5, h);
  box.dataset.x0 = x0; box.dataset.x1 = x1; box.dataset.end = end;
}
$('#overview').addEventListener('pointerdown', e => {
  pushZoom(true); userNav();
  const box = e.currentTarget, rect = box.getBoundingClientRect(), w = rect.width, end = +box.dataset.end;
  const x0 = +box.dataset.x0, x1 = +box.dataset.x1, x = e.clientX - rect.left, tl = $('#tl');
  const mode = Math.abs(x - x0) < 6 ? 'l' : Math.abs(x - x1) < 6 ? 'r' : (x > x0 && x < x1) ? 'move' : 'jump';
  try { box.setPointerCapture(e.pointerId); } catch (_) {}
  const startA = x0 / w * end, startB = x1 / w * end, grab = x / w * end - startA;
  const apply = (a, b) => { a = Math.max(0, a); b = Math.max(a + 0.2, b); pps = clamp((tl.clientWidth - headW()) / (b - a), PPS_MIN, PPS_MAX); renderLanes(); tl.scrollLeft = a * pps; syncZoomUI(); };
  const mv = ev => {
    const t = clamp((ev.clientX - rect.left) / w, 0, 1) * end;
    if (mode === 'l') apply(Math.min(t, startB - 0.2), startB);
    else if (mode === 'r') apply(startA, Math.max(t, startA + 0.2));
    else { tl.scrollLeft = Math.max(0, (t - (mode === 'jump' ? (startB - startA) / 2 : grab)) * pps); drawOverview(); }
  };
  mv(e);
  box.addEventListener('pointermove', mv);
  box.addEventListener('pointerup', () => box.removeEventListener('pointermove', mv), { once: true });
});
$('#overview').addEventListener('pointermove', e => {
  const box = e.currentTarget, x = e.clientX - box.getBoundingClientRect().left;
  box.style.cursor = Math.abs(x - +box.dataset.x0) < 6 || Math.abs(x - +box.dataset.x1) < 6 ? 'ew-resize' : (x > +box.dataset.x0 && x < +box.dataset.x1) ? 'grab' : 'pointer';
});

$('#ruler').addEventListener('pointerdown', e => {
  const cv = e.currentTarget; try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  { const x = e.clientX - cv.getBoundingClientRect().left, hit = visibleMarkers().find(m => Math.abs(mT(m) * pps - x) <= 6);
    if (hit && P.markersLocked) { selMarker = hit.id; seekClick(mT(hit)); renderMarkerLines(); renderRuler(); renderInspector(); return; }
    if (hit) {
      selMarker = hit.id; let moved = false; const x0 = e.clientX; if (P.video && !UI.vwin) { UI.vwin = true; saveUI(); renderVideoWindow(); }
      const mv = ev => { if (Math.abs(ev.clientX - x0) > 2) moved = true; if (!moved) return; const t = Math.max(0, (ev.clientX - cv.getBoundingClientRect().left) / pps); setMarkerTime(hit, t); renderMarkerLines(); renderRuler(); scrubVideo(t); $('#vtc').textContent = tc(t); };
      cv.addEventListener('pointermove', mv);
      cv.addEventListener('pointerup', () => { cv.removeEventListener('pointermove', mv); if (moved) commit(`Moved “${hit.label}” to ${P.video ? tc(mT(hit)) : fmtT(mT(hit))}`); else { seek(mT(hit)); renderMarkerLines(); renderRuler(); renderInspector(); } }, { once: true });
      return;
    } }
  const bl = beatLen();
  const at = ev => { let t = Math.max(0, (ev.clientX - cv.getBoundingClientRect().left) / pps); if (P.snap && bl) t = snapBeat(t); return t; };
  const x0 = e.clientX, y0 = e.clientY, a0 = at(e); let dragging = false, zooming = false, lastY = y0;
  const tAt0 = (e.clientX - cv.getBoundingClientRect().left) / pps, viewX = e.clientX - $('#tl').getBoundingClientRect().left - headW();
  const mv = ev => {
    // up or down zooms around where you grabbed; sideways marks a loop
    if (!dragging && !zooming && Math.abs(ev.clientY - y0) > 6 && Math.abs(ev.clientY - y0) > Math.abs(ev.clientX - x0)) { zooming = true; pushZoom(true); userNav(); }
    if (zooming) { zoom(Math.exp((ev.clientY - lastY) * 0.012), tAt0, viewX); lastY = ev.clientY; return; }
    if (!dragging && Math.abs(ev.clientX - x0) > 4) dragging = true;
    if (dragging) { P.loop = { a: Math.min(a0, at(ev)), b: Math.max(a0, at(ev)) }; P.loopOn = true; renderLoop(); renderRuler(); }
  };
  cv.addEventListener('pointermove', mv);
  cv.addEventListener('pointerup', ev => {
    cv.removeEventListener('pointermove', mv);
    if (zooming) return;
    if (dragging && P.loop && P.loop.b - P.loop.a > 0.2) { quietCommit(); renderTransport(); restartIfPlaying(); toast(`Looping ${fmtT(P.loop.a)}–${fmtT(P.loop.b)}. Press L to turn the loop off.`, 3500); }
    else if (dragging) { P.loop = null; P.loopOn = false; renderLoop(); renderRuler(); }
    else seekClick((ev.clientX - cv.getBoundingClientRect().left) / pps);
  }, { once: true });
});

$('#lanes').addEventListener('input', e => {
  const f = e.target.dataset.lf; if (!f) return; const l = P.lanes.find(x => x.id === e.target.closest('.lane').dataset.lane);
  if (f === 'gain') { l.gain = e.target.value / 100; e.target.nextElementSibling.textContent = e.target.value + '%'; liveLanes(); }
  if (f === 'pan') { l.pan = e.target.value / 100; const v = Math.round(l.pan * 100); e.target.nextElementSibling.textContent = v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(v); liveLanes(); }
});
const quietCommit = () => { const s = JSON.stringify(P); if (s !== last) { hist.push(last); fut = []; last = s; persist(); renderTransport(); } };
$('#lanes').addEventListener('change', e => {
  const f = e.target.dataset.lf; if (!f) return; const l = P.lanes.find(x => x.id === e.target.closest('.lane').dataset.lane);
  if (f === 'name') { l.name = e.target.value.trim() || l.name; quietCommit(); renderInspector(); }
  else if (f === 'autokind') { l.auto.show = e.target.value; quietCommit(); renderLanes(); }
  else quietCommit();
});
$('#lanes').addEventListener('click', e => {
  const b = e.target.closest('[data-lf]'); const laneEl = e.target.closest('.lane'); if (!laneEl) return;
  const l = P.lanes.find(x => x.id === laneEl.dataset.lane);
  if (b && b.tagName === 'BUTTON') {
    if (b.dataset.lf === 'mute') { l.mute = !l.mute; liveLanes(); quietCommit(); renderLanes(); renderMixer(); }
    else if (b.dataset.lf === 'solo') { l.solo = !l.solo; liveLanes(); quietCommit(); renderLanes(); renderMixer(); }
    else if (b.dataset.lf === 'del') deleteLane(l.id);
    else if (b.dataset.lf === 'lock') { l.locked = !l.locked; quietCommit(); renderLanes(); toast(l.locked ? `“${l.name}” locked: its parts stay exactly as they are. You can still change its volume, pan, mute and solo.` : `“${l.name}” unlocked.`, 4000); }
    else if (b.dataset.lf === 'auto') { l.auto.show = l.auto.show ? null : (l.auto.pan.length && !l.auto.vol.length ? 'pan' : 'vol'); if (l.folded) l.folded = false; quietCommit(); renderLanes(); }
    else if (b.dataset.lf === 'automenu') autoMenu(b, l);
    else if (b.dataset.lf === 'fold') { const v = !l.folded; (e.altKey ? P.lanes : [l]).forEach(x => { x.folded = v; }); quietCommit(); renderLanes(); }
    return;
  }
  if (selLane !== l.id && !e.target.closest('.clip')) { selLane = l.id; renderLanes(); renderInspector(); }
});

$('#lanes').addEventListener('pointerdown', e => {
  const grip = e.target.closest('.lane-grip');
  if (grip && e.button === 0) {
    e.preventDefault(); const l = P.lanes.find(x => x.id === grip.dataset.grip); if (!l) return;
    const laneEl = grip.closest('.lane'), y0 = e.clientY, h0 = laneEl.offsetHeight; grip.classList.add('on');
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    if (l.folded) { l.folded = false; laneEl.classList.remove('folded'); }
    const mv = ev => { l.h = Math.round(clamp(h0 + ev.clientY - y0, 40, 360)); laneEl.style.height = l.h + 'px'; };
    grip.addEventListener('pointermove', mv);
    grip.addEventListener('pointerup', () => { grip.removeEventListener('pointermove', mv); grip.classList.remove('on'); quietCommit(); renderLanes(); }, { once: true });
    return;
  }
  const body = e.target.closest('.lane-body'); if (!body || e.button !== 0) return;
  const asvg = e.target.closest('svg.auto');
  if (asvg) { e.preventDefault(); const l = P.lanes.find(x => x.id === body.parentElement.dataset.lane); if (l && l.locked) return toast(`“${l.name}” is locked. Click its padlock to change its automation.`, 3000); if (l) autoPointer(e, asvg, l); return; }
  const el = e.target.closest('.clip');
  if (!el) {
    const t = (e.clientX - body.getBoundingClientRect().left) / pps; selLane = body.parentElement.dataset.lane; selClip = null; edSel = null;
    seekClick(clamp(t, 0, projectEnd())); renderLanes(); drawEditor(); renderInspector(); return;
  }
  const c = clipById(el.dataset.clip); if (!c) return;
  const lockedLane = P.lanes.find(l => l.id === c.lane && l.locked);
  if (lockedLane) { // on a locked track a click only moves the playhead
    selClip = c.id; selLane = c.lane; markSelected(el, c);
    seekClick(c.at + clamp((e.clientX - el.getBoundingClientRect().left) / pps, 0, dur(c))); drawEditor(); renderInspector();
    if (e.target.dataset.h || e.target.dataset.fade || e.target.classList.contains('cl')) toast(`“${lockedLane.name}” is locked. Click its padlock to move or trim its parts.`, 3000);
    return;
  }
  if ((c.kind === 'pattern' || c.kind === 'riser') && e.target.dataset.h === 'l') return toast('A drum machine part starts on its first step. Drag its right edge to make it longer or shorter.', 3500);
  if (c.pin && (e.target.classList.contains('cl') || e.target.dataset.h === 'l')) {
    selClip = c.id; markSelected(el, c); seekClick(c.at + clamp((e.clientX - el.getBoundingClientRect().left) / pps, 0, dur(c))); renderInspector();
    return toast(`This part is pinned to ${P.video ? 'the picture' : 'its place'}, so it cannot be moved. Right-click it and choose Unpin to move it.`, 3500);
  }
  const mode = e.target.dataset.h || (e.target.dataset.fade ? 'fade-' + e.target.dataset.fade : e.target.classList.contains('cl') ? 'move' : 'select');
  if (selClip !== c.id) { selClip = c.id; edSel = null; }
  if (mode === 'select') return selectStretch(e, el, c);
  if (mode.startsWith('fade')) return dragFade(e, el, c, mode === 'fade-in');
  selLane = c.lane;
  $$('.clip.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
  $$('.lane.on').forEach(x => x.classList.remove('on')); el.closest('.lane').classList.add('on');
  ensureBuf(c.trackId).then(() => drawEditor()).catch(err => toast(err.message, 5000));
  drawEditor(); renderInspector();
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  el.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
  const r0left = el.getBoundingClientRect().left;
  const x0 = e.clientX, o = { at: c.at, start: c.start, end: c.end }, r = c.rate || 1, srcDur = ['midi', 'pattern', 'riser'].includes(c.kind) ? 36000 : bufs.get(c.trackId)?.buffer.duration ?? c.end;
  const edges = P.clips.filter(x => x !== c).flatMap(x => [x.at, x.at + dur(x)]).concat([0, playhead], visibleMarkers().map(mT));
  const snapEdge = t => { for (const s of edges) if (Math.abs(s - t) * pps < 8) return s; return null; };
  const bl = beatLen();
  let moved = false;
  const fixedLen = ['pattern', 'riser'].includes(c.kind), stretching = UI.edgeMode === 'stretch' && (mode === 'l' || mode === 'r') && !fixedLen;
  if (UI.edgeMode === 'stretch' && fixedLen && (mode === 'l' || mode === 'r')) toast('Drum machine parts and risers follow the tempo, so they are not stretched; this drag trims instead.', 4000);
  const mv = ev => {
    const dt = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return;
    if (mode === 'move') {
      let at = Math.max(0, o.at + dt);
      const s1 = snapEdge(at), s2 = snapEdge(at + dur(c));
      if (s1 !== null) at = s1; else if (s2 !== null) at = s2 - dur(c);
      else if (P.snap && bl) at = snapBeat(at);
      c.at = Math.max(0, at);
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane');
      if (under && under.dataset.lane !== c.lane) { c.lane = under.dataset.lane; under.querySelector('.lane-body').appendChild(el); }
      el.style.left = c.at * pps + 'px';
    } else if (stretching) { // Stretch mode: the part keeps all its material and plays faster or slower to fill the new length
      const span = o.end - o.start, d0 = span / r; let dNew = mode === 'r' ? d0 + dt : d0 - dt;
      const edgeAt = mode === 'r' ? o.at + dNew : o.at + d0 - dNew, s = snapEdge(edgeAt) ?? (P.snap && bl ? snapBeat(edgeAt) : null);
      if (s !== null) dNew = mode === 'r' ? s - o.at : o.at + d0 - s;
      let rate = span / Math.max(0.05, dNew); const lim = clamp(rate, 0.5, 2);
      if (lim !== rate) edgeLimit(el, mode, 'Stretched as far as it goes: from half speed to double speed. For more, split the part or change the tempo.');
      c.rate = Math.round(lim * 10000) / 10000; const dd = span / c.rate;
      if (mode === 'l') c.at = Math.max(0, o.at + d0 - dd);
      el.style.left = c.at * pps + 'px'; el.style.width = dd * pps + 'px';
    } else if (mode === 'l') {
      const want = o.start + dt * r;
      // snap first, then hold it inside the song: snapping after the limit could reach before the song's first second
      let ns = clamp(snapSrc(c.trackId, want), 0, o.end - 0.1);
      c.start = ns; c.at = o.at + (ns - o.start) / r;
      if (c.at < 0) { c.start = o.start - o.at * r; c.at = 0; }
      el.style.left = c.at * pps + 'px'; el.style.width = dur(c) * pps + 'px';
      if (want < -0.05) edgeLimit(el, 'l', c.kind === 'midi' ? 'This part starts at its first note.' : 'That is the very start of the song. There is no more of it before this.');
      else if (c.at === 0 && want < c.start - 0.05) edgeLimit(el, 'l', 'The part has reached the start of the timeline.');
    } else {
      const want = o.end + dt * r;
      c.end = clamp(snapSrc(c.trackId, want), o.start + 0.1, srcDur); el.style.width = dur(c) * pps + 'px';
      if (want > srcDur + 0.05) edgeLimit(el, 'r', 'That is the end of the song. There is no more of it after this. To make it longer, repeat it (Ctrl + D) or add another part.');
    }
  };
  el.addEventListener('pointermove', mv);
  el.addEventListener('pointerup', () => {
    el.removeEventListener('pointermove', mv); el.style.cursor = '';
    if (moved) { selLane = c.lane; tlSel = null; commit(stretching ? `Stretched: it plays at ${Math.round(c.rate * 100)}% speed${c.kind === 'midi' || c.keepPitch !== false ? ', same pitch' : ', and the pitch follows'}. Trim / Stretch in the top bar switches back to trimming.` : undefined); } else { tlSel = null; el.querySelectorAll('.tlsel').forEach(x => x.remove()); if (mode === 'move') seekClick(o.at + (x0 - r0left) / pps); }
  }, { once: true });
});

/* When a drag reaches the end of the material, say so instead of silently stopping */
let edgeToastAt = 0;
function edgeLimit(el, side, msg) {
  const h = el.querySelector(`.h.${side}`); if (h) { h.classList.add('limit'); setTimeout(() => h.classList.remove('limit'), 500); }
  const now = performance.now(); if (now - edgeToastAt > 2500) { edgeToastAt = now; toast(msg, 3500); }
}
function markSelected(el, c) {
  selLane = c.lane;
  $$('.clip.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
  $$('.lane.on').forEach(x => x.classList.remove('on')); el.closest('.lane').classList.add('on');
}
function selectStretch(e, el, c) {
  markSelected(el, c);
  ensureBuf(c.trackId).catch(err => toast(err.message, 5000));
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  const r0 = el.getBoundingClientRect(), bl = beatLen();
  const tAt = ev => { let t = c.at + clamp((ev.clientX - r0.left) / pps, 0, dur(c)); if (P.snap && bl) t = clamp(snapBeat(t), c.at, c.at + dur(c)); return t; };
  const a0 = tAt(e); let ov = null;
  el.querySelectorAll('.tlsel').forEach(x => x.remove()); tlSel = null;
  const mv = ev => {
    const b = tAt(ev); const a = Math.min(a0, b), z = Math.max(a0, b);
    if ((z - a) * pps < 3) return;
    tlSel = { clipId: c.id, a, b: z };
    if (!ov) { ov = document.createElement('span'); ov.className = 'tlsel'; el.appendChild(ov); }
    ov.style.left = (a - c.at) * pps + 'px'; ov.style.width = (z - a) * pps + 'px';
  };
  el.addEventListener('pointermove', mv);
  el.addEventListener('pointerup', () => {
    el.removeEventListener('pointermove', mv);
    if (!tlSel) seekClick(a0); // a click on a part moves the playhead there, playing or not
    else toast(`Selected ${(tlSel.b - tlSel.a).toFixed(1)}s. Delete removes it · K keeps only it · Ctrl+E splits · Ctrl+D repeats · right-click for more`, 4500);
    if (edOpen && tlSel) { const s = selSource(); if (s) edSel = { a: s.a, b: s.b }; }
    drawEditor(); renderInspector();
  }, { once: true });
}
function dragFade(e, el, c, isIn) {
  markSelected(el, c);
  try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
  const h = e.target, x0 = e.clientX, o = isIn ? (c.fadeIn || 0) : (c.fadeOut || 0), cv = el.querySelector('canvas');
  const mv = ev => {
    const d = clamp(o + (isIn ? 1 : -1) * (ev.clientX - x0) / pps, 0, dur(c) - (isIn ? (c.fadeOut || 0) : (c.fadeIn || 0)));
    if (isIn) { c.fadeIn = d; h.style.left = d * pps + 'px'; } else { c.fadeOut = d; h.style.right = d * pps + 'px'; }
    drawClipCanvas(cv, c);
  };
  h.addEventListener('pointermove', mv);
  h.addEventListener('pointerup', () => { h.removeEventListener('pointermove', mv); commit(`Fade ${isIn ? 'in' : 'out'}: ${(isIn ? c.fadeIn : c.fadeOut).toFixed(1)}s`); }, { once: true });
}
$('#lanes').addEventListener('dblclick', e => {
  const el = e.target.closest('.clip'); if (!el || e.target.closest('.h,.fh')) return;
  const c = clipById(el.dataset.clip); if (!c) return;
  selClip = c.id; edOpen = true; if (UI.edFold) { UI.edFold = false; saveUI(); }
  const s = selSource(); edSel = s && s.c.id === c.id ? { a: s.a, b: s.b } : null;
  ensureBuf(c.trackId).then(() => drawEditor()).catch(() => {});
  drawEditor(); renderInspector();
});
/* Drag the top edge of the part editor to make it taller or shorter */
$('#edGrip').addEventListener('pointerdown', e => {
  const g = e.currentTarget, y0 = e.clientY, h0 = UI.edH || 112; try { g.setPointerCapture(e.pointerId); } catch (_) {}
  if (UI.edFold) { UI.edFold = false; }
  g.classList.add('on');
  const mv = ev => { UI.edH = Math.round(clamp(h0 - (ev.clientY - y0), 60, Math.max(120, innerHeight * 0.6))); drawEditor(); };
  g.addEventListener('pointermove', mv);
  g.addEventListener('pointerup', () => { g.removeEventListener('pointermove', mv); g.classList.remove('on'); saveUI(); renderRuler(); renderLoop(); drawOverview(); }, { once: true });
});
$('#edWrap').addEventListener('wheel', e => {
  const c = clipById(selClip); if (!c || !edView || edView.midi) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect(), frac = clamp((e.clientX - r.left) / r.width, 0, 1);
  if (e.altKey) return setAmp((UI.amp || 1) * (e.deltaY < 0 ? 2 : 0.5));
  const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (e.ctrlKey || e.metaKey || (UI.wheelZoom !== false && !sideways)) return edZoom(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), frac);
  // Shift + scroll (or the wheel, when wheel zoom is off) moves along the song
  const span = edWin.v1 - edWin.v0, d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 16 : 1) / r.width * span;
  const v0 = clamp(edWin.v0 + d, 0, edView.D - span); edWin.v0 = v0; edWin.v1 = v0 + span; drawEditor();
}, { passive: false });
$('#edWrap').addEventListener('pointerdown', e => {
  const c = clipById(selClip); if (!c || !edView) return;
  if (c.kind === 'pattern') { if (edView.pattern) patternPointer(e, e.currentTarget, c); return; }
  if (c.kind === 'midi') { if (edView.midi) pianoPointer(e, e.currentTarget, c); return; }
  const wrap = e.currentTarget, rect = wrap.getBoundingClientRect();
  // a click in the overview strip moves the view there
  if (e.clientY - rect.top < edView.ov) {
    const span = edWin.v1 - edWin.v0, at = (e.clientX - rect.left) / rect.width * edView.D, v0 = clamp(at - span / 2, 0, edView.D - span);
    edWin.v0 = v0; edWin.v1 = v0 + span; drawEditor(); return;
  }
  try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  const tAt = ev => clamp(snapSrc(c.trackId, edView.v0 + (ev.clientX - wrap.getBoundingClientRect().left) / edView.w * (edView.v1 - edView.v0)), 0, edView.D);
  const a0 = tAt(e); stopPreview();
  const mv = ev => { const b = tAt(ev); edSel = { a: Math.min(a0, b), b: Math.max(a0, b) }; drawEditor(); };
  wrap.addEventListener('pointermove', mv);
  wrap.addEventListener('pointerup', () => { wrap.removeEventListener('pointermove', mv); if (edSel && edSel.b - edSel.a < 0.05) edSel = null; drawEditor(); }, { once: true });
});

/* settings panel */
$('#insp').addEventListener('input', e => {
  const c = clipById(selClip), d = e.target.dataset, out = e.target.nextElementSibling, v = +e.target.value;
  if (d.pf === 'xfade') { P.xfade = v; out.textContent = v.toFixed(1) + 's'; return; }
  if (e.target.matches('[data-dvp]') && out) {
    const box = e.target.closest('[data-dev]'), hit = box && findDev(box.dataset.dev), k = e.target.dataset.dvp;
    out.textContent = { th: `${v} dB`, ratio: `${v}:1`, att: `${v} ms`, rel: `${v} ms`, makeup: `+${v} dB`, bits: `${v}-bit`, rate: `${(v / 1000).toFixed(1)} kHz` }[k] || `${v}%`;
    if (hit && hit.d.type === 'comp') { hit.d[k] = k === 'mix' ? v / 100 : v; const x = (devsOf(hit.l.id) || {})[hit.d.id]; if (x) applyComp(x, hit.d); } // heard straight away
    return;
  }
  if (e.target.matches('[data-lsend]') && out) { const R = P.lanes.find(x => x.id === e.target.dataset.lsend); out.textContent = `${v}% → ${R ? R.name : ''}`; return; }
  if (e.target.matches('[data-lpumpd]') && out) { out.textContent = v + '%'; return; }
  if (d.lx) {
    const l = P.lanes.find(x => x.id === selLane); if (!l) return; l.fx[d.lx] = v;
    out.textContent = d.lx === 'bass' || d.lx === 'treble' ? `${v > 0 ? '+' : ''}${v} dB` : d.lx === 'filter' ? (v === 0 ? 'off' : v < 0 ? 'muffle ' + -v : 'thin ' + v) : v + '%';
    liveLanes(); return;
  }
  if (!c || !d.cf) return;
  if (d.cf === 'gain') { c.gain = v / 100; out.textContent = v + '%'; }
  else if (d.cf === 'rate') { out.textContent = v + '%'; }
  else if (d.cf === 'swing') { out.textContent = v + '%'; }
  else if (d.arp === 'gate') { out.textContent = v + '%'; }
  else if (d.cf === 'semi') { out.textContent = (v > 0 ? '+' : '') + v; }
  else { c[d.cf] = v; fixFades(c); out.textContent = c[d.cf].toFixed(1) + 's'; const el = $(`.clip[data-clip="${c.id}"] canvas`); if (el) drawClipCanvas(el, c); }
});
$('#insp').addEventListener('change', async e => {
  const c = clipById(selClip), d = e.target.dataset;
  if (d.lx) { quietCommit(); renderLanes(); return; }
  if (d.pf === 'xfade') return commit();
  if (d.pf === 'bpm') { const v = parseFloat(e.target.value); P.bpm = v >= 40 && v <= 240 ? Math.round(v * 10) / 10 : null; commit(P.bpm ? `Mix tempo set to ${P.bpm} BPM` : 'Mix tempo cleared'); liveLanes(); return; }
  if (d.pf === 'key') { const [k, m] = e.target.value.split('|'); P.key = e.target.value ? { key: +k, mode: m } : null; return commit(P.key ? `Mix key set to ${keyName(P.key.key, P.key.mode)}` : 'Mix key cleared'); }
  if (e.target.matches('[data-pin]')) { const pc = clipById(selClip); if (pc && !!pc.pin !== e.target.checked) togglePin(pc); return; }
  if (e.target.matches('[data-vlock]')) { if (P.video) { P.video.locked = e.target.checked; quietCommit(); renderVideoRow(); toast(P.video.locked ? 'Picture locked: it cannot be moved or trimmed.' : 'Picture unlocked.'); } return; }
  if (e.target.matches('[data-mklock]')) { P.markersLocked = e.target.checked; quietCommit(); renderRuler(); return toast(P.markersLocked ? 'Hit points locked: clicking one jumps to it, and dragging does nothing.' : 'Hit points unlocked: drag one along the ruler to move it.'); }
  if (e.target.matches('[data-mout]')) {
    const l = P.lanes.find(x => x.id === selLane); if (!l) return; const k = e.target.dataset.mout, v = e.target.value;
    if (k === 'port') { if (v === '__missing') return; if (!v) { l.mout = null; commit(`“${l.name}” plays Mixtape’s own sound again.`); renderInspector(); return; }
      const o = midiAccess && midiAccess.outputs.get(v); l.mout = { ch: 1, delay: 0, inside: false, ...(l.mout || {}), id: v, name: o ? o.name : v };
      commit(`“${l.name}” now plays through ${l.mout.name}. Press “Send a test note”.`); renderInspector(); return; }
    if (!l.mout) return;
    if (k === 'ch') l.mout.ch = +v; else if (k === 'delay') l.mout.delay = +v; else if (k === 'inside') l.mout.inside = e.target.checked;
    commit(); return;
  }
  if (e.target.matches('[data-cscale]')) {
    const c = clipById(selClip); if (!c) return; const k = e.target.dataset.cscale, v = e.target.value;
    if (k === 'type') c.scale = v === '' ? null : v === 'none' ? { type: 'none' } : { root: c.scale && c.scale.root != null ? c.scale.root : (P.key ? P.key.key : 0), type: v };
    else if (k === 'root') c.scale = { ...c.scale, root: +v };
    else if (k === 'lock') c.scaleLock = e.target.checked;
    if (!c.scale) delete c.scale; commit(); renderInspector(); return;
  }
  if (e.target.matches('[data-uichord]')) { UI.chord = e.target.value; saveUI(); drawEditor(); return toast(UI.chord ? `Clicking in the note editor now adds ${CHORD_TOOLS[UI.chord].toLowerCase()}.` : 'Clicking adds single notes again.'); }
  if (e.target.matches('[data-mpreset]')) {
    const k = e.target.value, pr = MASTER_PRESETS[k], ms = MS(), fresh = k !== 'none' && !(P.masterChain || []).length;
    ms.preset = k; if (pr.lufs != null) { ms.lufs = pr.lufs; ms.ceiling = pr.ceiling; } ms.gainDb = 0; masterReport = null;
    if (fresh) P.masterChain = masterStarter(k);
    commit(k === 'none' ? 'Mastering off: exports keep the mix’s own loudness.' : `Mastering for ${pr.name}: ${pr.lufs} LUFS.${fresh ? ' A gentle starting chain was added to the master.' : ''} Press “Check the master”.`); renderInspector(); return;
  }
  if (d.uiset && d.uiset !== 'wheelZoom') { UI[d.uiset] = e.target.checked; saveUI(); return; }
  if (d.uiset) { UI[d.uiset] = e.target.checked; saveUI(); return toast(e.target.checked ? 'The mouse wheel now zooms over waveforms. Shift + wheel moves sideways.' : 'The mouse wheel now scrolls. Hold Ctrl to zoom.'); }
  if (d.linkset && P.link) {
    if (d.linkset === 'profile') { P.link.profileChoice = e.target.value; return commit(`Deliveries now aim at ${PROFILES[e.target.value].name}.`); }
    if (d.linkset === 'tc') { if (tcToSec(e.target.value) == null) { e.target.value = startTC(); return toast('Write the start as hh:mm:ss:ff, for example 10:00:00:00.'); } P.link.tcChoice = e.target.value.trim(); return commit(`Programme starts at ${P.link.tcChoice}.`); }
  }
  if (e.target.matches('[data-dvadd]')) { const l = e.target.dataset.owner === 'master' ? MASTER_L : P.lanes.find(x => x.id === selLane); if (!l || !e.target.value) return; const dv = newDevice(e.target.value); if (l.type === 'return' && ['hall', 'pingpong', 'chorus'].includes(dv.type)) dv.mix = 1; l.chain = [...(l.chain || []), dv]; commit(`${FX_TYPES[dv.type]} added to “${l.name}”`); renderInspector(); return; }
  if (e.target.matches('[data-dvp]')) { const box = e.target.closest('[data-dev]'), hit = box && findDev(box.dataset.dev); if (!hit) return; const k = e.target.dataset.dvp; hit.d[k] = ['gate', 'mode'].includes(k) ? e.target.value : ['amt', 'mix', 'tone'].includes(k) ? +e.target.value / 100 : +e.target.value; if (hit.d.type === 'comp') { quietCommit(); return; } commit(); return; }
  if (e.target.matches('[data-lroute]')) { const l = P.lanes.find(x => x.id === selLane); if (!l) return; l.out = e.target.value || null; const gname = l.out && P.lanes.find(x => x.id === l.out).name; commit(gname ? `“${l.name}” now plays through “${gname}”.` : `“${l.name}” goes straight to the master.`); renderInspector(); return; }
  if (e.target.matches('[data-lsend]')) { const l = P.lanes.find(x => x.id === selLane); if (!l) return; l.sends = { ...(l.sends || {}), [e.target.dataset.lsend]: +e.target.value / 100 }; commit(); return; }
  if (e.target.matches('[data-lpump]')) { const l = P.lanes.find(x => x.id === selLane); if (!l) return; l.pump = { depth: 0.7, ...(l.pump || {}), on: e.target.checked }; commit(l.pump.on ? `“${l.name}” now ducks on every kick of the drum machine.` : 'Pump off'); renderInspector(); return; }
  if (e.target.matches('[data-lpumpd]')) { const l = P.lanes.find(x => x.id === selLane); if (!l) return; l.pump.depth = +e.target.value / 100; commit(); return; }
  if (d.lrole) { const l = P.lanes.find(x => x.id === selLane); if (!l) return; P.lanes.forEach(x => { if (x.role === 'dialogue') x.role = null; }); if (e.target.checked) l.role = 'dialogue'; return commit(e.target.checked ? `“${l.name}” is the dialogue: Netflix-style loudness is measured where it speaks.` : 'No dialogue track marked.'); }
  if (d.pc === 'limit') { P.limit.on = e.target.checked; return commit(P.limit.on ? `Limiter on: true peak held under ${P.limit.ceiling.toFixed(1)} dBTP when you save or deliver.` : 'Limiter off'); }
  if (d.pf === 'ceiling') { P.limit.ceiling = Math.round(+e.target.value * 10) / 10; return commit(); }
  if (d.pc) { P[d.pc] = e.target.checked; return commit(); }
  if (!c) return;
  if (c.kind === 'riser' && d.cf === 'dir') { c.dir = e.target.value; c.name = c.dir === 'down' ? 'Downlifter' : 'Riser'; return commit(); }
  if (c.kind === 'pattern' && d.cf === 'kit') { c.pat.kit = e.target.value; return commit(`Now plays the ${KITS[c.pat.kit]} kit`); }
  if (c.kind === 'pattern' && d.cf === 'res') { const nr = e.target.value, sb0 = stepB(c), n0 = patN(c); c.pat.res = nr; const sb1 = stepB(c), n1 = patN(c);
    // each hit moves to the nearest step of the new grid
    for (const [k] of DRUM_ROWS) { const a = c.pat.rows[k] || []; const b = Array(n1).fill(0); a.forEach((v, i) => { if (v > 0) { const j = Math.round(i * sb0 / sb1); if (j < n1) b[j] = Math.max(b[j], v); } }); c.pat.rows[k] = b; }
    void n0; return commit(`Grid now in ${RES[nr].label}`); }
  if (c.kind === 'pattern' && d.cf === 'bars') { const nb = +e.target.value, n0 = patN(c), n1 = Math.round(4 / stepB(c)) * nb; for (const [k] of DRUM_ROWS) { const a = c.pat.rows[k] || Array(n0).fill(0); c.pat.rows[k] = Array.from({ length: n1 }, (_, i) => a[i % n0] || 0); } c.pat.bars = nb; return commit(`The pattern is now ${nb} bar${nb > 1 ? 's' : ''} long`); }
  if (c.kind === 'pattern' && d.cf === 'swing') { c.pat.swing = +e.target.value; return patLive(c); }
  if (d.cf === 'art' && c.kind === 'midi') { c.art = e.target.value; try { await ensureOrch(c); } catch (err) { return toast('Could not load that playing style: ' + err.message, 5000); } return commit(`Now plays ${(ARTS[c.art] || c.art).toLowerCase()}`); }
  if (d.arp && c.kind === 'midi') {
    c.arp = { on: false, mode: 'up', rate: '16', oct: 1, gate: 0.6, ...(c.arp || {}) };
    if (d.arp === 'on') c.arp.on = e.target.checked; else if (d.arp === 'gate') c.arp.gate = +e.target.value / 100; else if (d.arp === 'oct') c.arp.oct = +e.target.value; else c.arp[d.arp] = e.target.value;
    commit(d.arp === 'on' ? (c.arp.on ? 'Arpeggiator on: hold a chord in the note editor and it rolls.' : 'Arpeggiator off') : undefined); renderInspector(); return;
  }
  if (d.cf === 'inst' && isSamp(e.target.value)) { c.inst = e.target.value; try { await loadSamp(c.inst.slice(2)); } catch (err) { return toast('Could not load that instrument: ' + err.message, 5000); } return commit(`Now plays as ${MixtapeMIDI.INSTRUMENTS[c.inst]}`); }
  if (d.cf === 'inst' && isOrch(e.target.value)) { c.inst = e.target.value; try { await ensureOrch(c); } catch (err) { return toast('Could not load that instrument: ' + err.message, 5000); } return commit(`Now plays as ${MixtapeMIDI.INSTRUMENTS[c.inst]}`); }
  if (d.cf === 'inst') { c.inst = e.target.value; return commit(`Now plays as ${MixtapeMIDI.INSTRUMENTS[c.inst]}`); }
  if (d.cf === 'rate') return setRate(c, +e.target.value / 100, `Speed set to ${e.target.value}%`);
  if (d.cf === 'semi') { c.semi = +e.target.value; try { await ensureProc(c); } catch (err) { return toast(err.message, 5000); } return commit(); }
  if (d.cc === 'keepPitch') { c.keepPitch = e.target.checked; if (!c.keepPitch) c.semi = 0; try { await ensureProc(c); } catch (err) { return toast(err.message, 5000); } return commit(); }
  if (d.cs) { c[d.cs] = e.target.value; return commit(); }
  if (d.cf) commit();
});

document.addEventListener('keydown', e => {
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(null); return; }
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey, kl = k.toLowerCase();
  if (mod && kl === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && kl === 'y') { e.preventDefault(); redo(); }
  else if (mod && kl === 'e') { e.preventDefault(); splitHere(); }
  else if (mod && kl === 'd') { e.preventDefault(); repeatStretch(); }
  else if (mod && kl === 'c') { if (tlSel || selClip) { e.preventDefault(); copySel(); } }
  else if (mod && kl === 'v') { e.preventDefault(); pasteAtPlayhead(); }
  else if (mod && kl === 'l') { e.preventDefault(); acts.looptoggle(); }
  else if (mod || e.altKey) return;
  else if (k === '?') { e.preventDefault(); showShortcuts(); }
  else if (k === ' ') { e.preventDefault(); acts.play(); }
  else if (k === 'Home') { e.preventDefault(); seek(0); }
  else if ((k === 'Delete' || k === 'Backspace') && edOpen && edNote && clipById(selClip)?.kind === 'midi') { e.preventDefault(); const c = clipById(selClip); c.notes = c.notes.filter(n => n.id !== edNote); edNote = null; commit('Note removed'); }
  else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); if (tlSel) removeStretch(); else if (selMarker && !selClip) deleteMarker(selMarker); else if (selClip) deleteClip(); }
  else if (kl === 'k') keepStretch();
  else if (kl === 'z' && !(e.ctrlKey || e.metaKey)) { if (e.shiftKey) prevZoom(); else zoomToSelection(); }
  else if (kl === 's') splitHere();
  else if (kl === 'l') acts.looptoggle();
  else if (kl === 'f') acts.follow();
  else if (kl === 'b') acts.togglelib();
  else if (kl === 'x') acts.togglemixer();
  else if (kl === 'm') addMarker(curPos());
  else if (kl === 't') addTempoChange(curPos());
  else if (kl === 'v') acts.video();
  else if (kl === 'c') acts.metro();
  else if (kl === 'i') acts.toggleinsp();
  else if (k === '+' || k === '=') zoom(1.5);
  else if (k === '-' || k === '_') zoom(1 / 1.5);
  else if (k === 'Escape') { edSel = null; tlSel = null; $$('.tlsel').forEach(x => x.remove()); drawEditor(); }
});
window.addEventListener('resize', () => { renderLanes(); drawEditor(); });


/* ---------- drag and drop onto the timeline ---------- */
let dragTrack = null;
const AUDIO_RE = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|weba|aif|aiff)$/i;
const isFileDrag = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
function dropTarget(e) {
  const laneEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.lane');
  const r = $('#tlInner').getBoundingClientRect();
  let at = Math.max(0, (e.clientX - r.left - headW()) / pps);
  const bl = beatLen(); if (P.snap && bl) at = snapBeat(at);
  return { lane: laneEl ? laneEl.dataset.lane : null, laneEl, at };
}
function showDrop(tg, len) {
  const m = $('#dropMark'), lanes = $('#lanes');
  m.hidden = false;
  m.style.left = (headW() + tg.at * pps) + 'px';
  m.style.width = Math.max(6, len * pps) + 'px';
  m.style.top = (tg.laneEl ? tg.laneEl.offsetTop + 5 : lanes.offsetTop + lanes.offsetHeight + 5) + 'px';
  m.style.height = (tg.laneEl ? tg.laneEl.offsetHeight - 10 : 70) + 'px';
  const l = tg.lane && P.lanes.find(x => x.id === tg.lane);
  $('#dropLbl').textContent = `${l ? l.name : 'New track'} · ${fmtT(tg.at)}`;
}
function hideDrop() { $('#dropMark').hidden = true; $('#tl').classList.remove('dragover'); }
async function placeSongs(ids, tg) {
  let laneId = tg.lane;
  if (!laneId) { const l = newLane(P.lanes.length + 1); P.lanes.push(l); laneId = l.id; }
  let at = tg.at, lastClip = null;
  for (const id of ids) {
    let e; try { e = await ensureBuf(id); } catch (err) { toast(err.message, 5000); continue; }
    const t = libTrack(id);
    if (t && !(t.duration > 0)) { t.duration = e.buffer.duration; req('tracks', 'readwrite', o => o.put(t)).catch(() => {}); }
    const c = newClip(id, laneId, at, 0, e.buffer.duration); P.clips.push(c); lastClip = c; at += dur(c);
  }
  if (!lastClip) return;
  selClip = lastClip.id; selLane = laneId; edSel = null;
  const first = libTrack(ids[0]);
  commit(ids.length === 1 ? `Added “${first ? first.title : 'song'}” at ${fmtT(tg.at)}` : `Added ${ids.length} songs, one after another`);
}
async function importDropped(files) {
  const ids = [], seen = new Map(lib.map(t => [t.name + '|' + t.size, t.id]));
  for (const f of files) {
    if (!((f.type || '').startsWith('audio/') || AUDIO_RE.test(f.name))) continue;
    const key = f.name + '|' + f.size;
    if (seen.has(key)) { ids.push(seen.get(key)); continue; }
    const base = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim(), parts = base.split(/\s+[-–—]\s+/);
    const t = { id: uid(), name: f.name, size: f.size, type: f.type || '', title: parts.length > 1 ? parts.slice(1).join(' - ') : base,
      artist: parts.length > 1 ? parts[0] : '', album: '', track: 0, duration: 0, added: Date.now(), blob: f, art: null };
    try { await req('tracks', 'readwrite', o => o.put(t)); } catch (e) { toast(`Couldn't save “${f.name}” in this browser.`, 5000); continue; }
    ids.push(t.id); seen.set(key, t.id);
  }
  if (!ids.length) { toast('Only music files can go on the timeline (MP3, M4A, WAV, FLAC, OGG…).', 4500); return ids; }
  await loadLibrary(); renderLibrary();
  try { new BroadcastChannel('mixtape').postMessage({ type: 'library' }); } catch (e) {}
  return ids;
}
$('#lib').addEventListener('dragstart', e => {
  const li = e.target.closest('[data-drag]'); if (!li) return;
  dragTrack = li.dataset.drag; li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', (libTrack(dragTrack) || {}).title || 'song');
});
$('#lib').addEventListener('dragend', e => { const li = e.target.closest('[data-drag]'); if (li) li.classList.remove('dragging'); dragTrack = null; hideDrop(); });
$('#tl').addEventListener('dragover', e => {
  if (!dragTrack && !isFileDrag(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  $('#tl').classList.add('dragover');
  const t = dragTrack && libTrack(dragTrack);
  showDrop(dropTarget(e), t && t.duration > 0 ? t.duration : 8);
});
$('#tl').addEventListener('dragleave', e => { if (!e.relatedTarget || !$('#tl').contains(e.relatedTarget)) hideDrop(); });
$('#tl').addEventListener('drop', async e => {
  if (!dragTrack && !isFileDrag(e)) return;
  e.preventDefault(); hideDrop();
  const tg = dropTarget(e), id = dragTrack; dragTrack = null;
  if (id) return placeSongs([id], tg);
  let all = [...e.dataTransfer.files]; const vf = all.find(f => (f.type || '').startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(f.name));
  if (vf) { await importVideo(vf); if (all.length === 1) return; }
  for (const mf of all.filter(f => /\.midi?$/i.test(f.name))) await importMidi(mf, tg.at ?? playhead);
  all = all.filter(f => f !== vf && !/\.midi?$/i.test(f.name)); if (!all.length) return;
  const ids = await importDropped(all);
  if (ids.length) placeSongs(ids, tg);
});
$('#midiIn').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importMidi(f, playhead); });
$('#fileIn').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
  const ids = await importDropped(files);
  if (ids.length) placeSongs(ids, { lane: null, at: playhead });
});
// Files dropped anywhere else must not make the browser leave the Studio
window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', e => { if (isFileDrag(e) && !e.target.closest('#tl')) { e.preventDefault(); toast('Drop music files on the timeline to add them.'); } });

/* ---------- right-click menu on a part ---------- */
const menu = $('#menu'); let menuItems = [];
function openMenu(x, y, items) {
  menuItems = items;
  menu.innerHTML = items.map((it, i) => it.sep ? '<hr>' : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('');
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, innerWidth - mw - 8) + 'px'; menu.style.top = Math.min(y, innerHeight - mh - 8) + 'px';
  const first = menu.querySelector('button:not(:disabled)'); if (first) first.focus({ preventScroll: true });
}
const closeMenu = () => { menu.hidden = true; };
menu.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b || b.disabled) return; const it = menuItems[+b.dataset.i]; closeMenu(); it.act(); });
document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); }, true);
$('#tl').addEventListener('scroll', closeMenu);
$('#lanes').addEventListener('contextmenu', e => {
  const el = e.target.closest('.clip'); if (!el) return;
  e.preventDefault();
  const c = clipById(el.dataset.clip); if (!c) return;
  const r0 = el.getBoundingClientRect(), tClick = c.at + (e.clientX - r0.left) / pps;
  const inSel = tlSel && tlSel.clipId === c.id && tClick >= tlSel.a - 0.05 && tClick <= tlSel.b + 0.05;
  if (!inSel) tlSel = null;
  selClip = c.id; selLane = c.lane; edSel = null;
  ensureBuf(c.trackId).then(() => drawEditor()).catch(() => {});
  renderLanes(); drawEditor(); renderInspector();
  const t = libTrack(c.trackId), a = ana[c.trackId];
  if (inSel) return openMenu(e.clientX, e.clientY, [
    { label: 'Remove this stretch   Del', act: removeStretch },
    { label: 'Keep only this stretch   K', act: keepStretch },
    { label: 'Split it off   Ctrl+E', act: splitHere },
    { label: 'Repeat it   Ctrl+D', act: repeatStretch },
    { label: 'Copy   Ctrl+C', act: copySel },
    { label: 'Loop this stretch', act: () => setLoop(tlSel.a, tlSel.b, 'Looping the selected stretch') },
    { sep: 1 },
    { label: 'Play from here', act: () => { seek(tlSel.a); if (!playing) play(); } },
  ]);
  openMenu(e.clientX, e.clientY, [
    { label: 'Open the detailed editor', act: () => { edOpen = true; drawEditor(); } },
    { label: 'Play from here', act: () => { seek(c.at); if (!playing) play(); } },
    { label: 'Split at the red playhead', act: splitAtPlayhead, disabled: !(playhead > c.at && playhead < c.at + dur(c)) },
    { label: 'Copy after', act: dupClip },
    { label: 'Repeat ×2', act: () => loopClip(2) },
    { label: 'Repeat ×4', act: () => loopClip(4) },
    { sep: 1 },
    { label: 'Fit between hit points…', act: fitBetween, disabled: visibleMarkers().length < 2 },
    ...(!['midi', 'pattern', 'riser'].includes(c.kind) ? [{ label: 'Bring back the whole song', act: () => restoreWhole(c), disabled: !(c.start > 0.01 || c.end < ((bufs.get(c.trackId) && bufs.get(c.trackId).buffer.duration) || c.end) - 0.01) }] : []),
    { label: 'Split into vocals, drums, bass…', act: splitStems, disabled: ['midi', 'pattern', 'riser'].includes(c.kind) || !!(t && t.stemOf) },
    ...(c.kind === 'midi' ? [{ label: 'Snap notes to 1/16', act: quantize }, { label: 'Export MIDI', act: exportMidi }] : []),
    { label: 'Match mix tempo', act: matchTempo, disabled: !(P.bpm && a && a.bpm) },
    { label: 'Match mix key', act: matchKey, disabled: !(P.key && a && a.key != null) },
    { sep: 1 },
    { label: c.mute ? 'Unmute part' : 'Mute part', act: toggleMutePart },
    { label: 'Paste at the playhead   Ctrl+V', act: pasteAtPlayhead, disabled: !clipboard },
    { label: c.pin ? 'Unpin from the picture' : (P.video ? 'Pin to the picture (stays on its cut)' : 'Pin in place'), act: () => togglePin(c) },
    { label: 'Delete part', danger: 1, act: deleteClip },
  ]);
});


/* ---------- scoring to picture: scene video, hit points, timecode ---------- */
const vid = $('#vid');
let vidFor = null, vidUrl = null, vidSrcNode = null, vidGain = null, selMarker = null;
const thumbs = new Map();
const once = (el, ev, ms = 8000) => new Promise(r => { let done = false; const f = () => { if (!done) { done = true; r(true); } }; el.addEventListener(ev, f, { once: true }); setTimeout(() => { if (!done) { done = true; r(false); } }, ms); });
const vLen = () => P.video ? P.video.end - P.video.start : 0;
const videoEnd = () => P.video ? P.video.at + vLen() : 0;
function videoTimeAt(t) { const v = P.video; if (!v) return null; const u = t - v.at; return u < 0 || u > vLen() ? null : v.start + u; }
const fpsOf = () => (P.video && P.video.fps) || (P.link && P.link.fps) || 24;
function tc(t) {
  const fps = fpsOf(), nom = Math.round(fps), neg = t < 0; let f = Math.floor(Math.abs(t) * fps + 1e-6);
  const ff = f % nom; f = Math.floor(f / nom); const ss = f % 60; f = Math.floor(f / 60); const mm = f % 60, hh = Math.floor(f / 60);
  const p = n => String(n).padStart(2, '0'); return `${neg ? '-' : ''}${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}
function parseTime(s) {
  if (typeof s === 'number') return s;
  s = String(s || '').trim(); let m;
  if ((m = s.match(/^(\d+):(\d+):(\d+)[:;.](\d+)$/)) && s.split(/[:;]/).length === 4) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / Math.round(fpsOf());
  if ((m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/))) return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  const n = parseFloat(s); return isFinite(n) ? n : null;
}
async function mediaDuration(el) {
  if (!(await once(el, 'loadedmetadata'))) return 0;
  if (isFinite(el.duration) && el.duration > 0) return el.duration;
  el.currentTime = 1e9; await once(el, 'timeupdate', 4000); const d = el.duration; el.currentTime = 0; return isFinite(d) ? d : 0;
}
async function ensureVideoEl() {
  const v = P.video;
  if (!v) { if (vidFor) { vid.pause(); vid.removeAttribute('src'); vid.load(); vidFor = null; } return false; }
  if (vidFor === v.id) return true;
  const t = libTrack(v.id); if (!t) return false;
  if (vidUrl) URL.revokeObjectURL(vidUrl);
  vidUrl = URL.createObjectURL(t.blob); vid.src = vidUrl; vidFor = v.id;
  await once(vid, 'loadedmetadata');
  if (!vidSrcNode) { try { vidSrcNode = ctx.createMediaElementSource(vid); vidGain = ctx.createGain(); vidSrcNode.connect(vidGain); vidGain.connect(ctx.destination); } catch (e) {} }
  applySceneVol(); return true;
}
function applySceneVol() { if (vidGain) vidGain.gain.value = P.video ? (P.video.vol ?? 0.8) : 0; }
function syncVideo() {
  if (!P.video || !vidFor) return;
  const vt = videoTimeAt(curPos());
  $('#vwOut').hidden = vt != null;
  if (vt == null) { if (!vid.paused) vid.pause(); return; }
  // show the frame you are hearing: allow for the delay before sound reaches the speakers
  const target = vt - (ctx.outputLatency || ctx.baseLatency || 0), diff = vid.currentTime - target;
  if (Math.abs(diff) > 0.25) { vid.currentTime = Math.max(0, target); vid.playbackRate = 1; }
  else vid.playbackRate = Math.abs(diff) > 0.02 ? clamp(1 - diff * 0.8, 0.9, 1.1) : 1;   // nudge gently instead of jumping
  if (vid.paused) vid.play().catch(() => {});
}
function scrubVideo(t) {
  if (!P.video || !vidFor) return;
  const vt = videoTimeAt(t); $('#vwOut').hidden = vt != null; if (vt == null) return;
  if (!vid.paused) vid.pause();
  if (Math.abs(vid.currentTime - vt) > 0.5 / fpsOf()) vid.currentTime = vt;
}
async function importVideo(file, opts = {}) {
  if (P.video && !opts.silent && !(await ask({ title: 'Replace the scene video?', text: 'The new video takes the place of the current one. Hit points on the old video are removed. You can undo this.', ok: 'Replace video' }))) return;
  busy('Adding the scene video…');
  try {
    const probe = document.createElement('video'); probe.muted = true; probe.preload = 'metadata';
    const url = URL.createObjectURL(file); probe.src = url;
    const d = await mediaDuration(probe); URL.revokeObjectURL(url); probe.removeAttribute('src');
    if (!d) { busy(null); return toast('This browser can’t open that video. MP4 (H.264) or WebM videos work best.', 6000); }
    const t = { id: uid(), kind: 'video', name: file.name, size: file.size, type: file.type || 'video/mp4', title: file.name.replace(/\.[^.]+$/, ''), artist: '', album: 'Scenes', track: 0, duration: d, added: Date.now(), blob: file, art: null };
    await req('tracks', 'readwrite', o => o.put(t)); await loadLibrary();
    P.video = { id: t.id, at: 0, start: 0, end: d, dur: d, fps: +opts.fps || 24, vol: 0.8 };
    P.markers = (P.markers || []).filter(m => m.vt == null || m.src === 'pkg');
    UI.vwin = true; saveUI();
    vidFor = null; await ensureVideoEl(); scrubVideo(playhead);
    if (!opts.silent) commit(`Added the scene “${t.title}” (${fmtT(d)}). Press M to mark a hit point at the playhead.`);
    makeThumbs();
  } catch (err) { toast('Could not add the video: ' + (err.message || 'your browser may be out of storage space'), 6000); }
  finally { busy(null); }
}
async function makeThumbs() {
  const v = P.video; if (!v || thumbs.has(v.id)) return;
  const t = libTrack(v.id); if (!t) return;
  const el = document.createElement('video'); el.muted = true; el.preload = 'auto';
  const url = URL.createObjectURL(t.blob); el.src = url; await once(el, 'loadedmetadata');
  const step = Math.max(0.5, v.dur / 160), frames = [], entry = { step, frames }; thumbs.set(v.id, entry);
  for (let s = 0; s < v.dur; s += step) {
    el.currentTime = Math.min(s + 0.01, v.dur - 0.05); if (!(await once(el, 'seeked', 3000))) break;
    const c = document.createElement('canvas'); c.width = 96; c.height = 54; c.getContext('2d').drawImage(el, 0, 0, 96, 54); frames.push(c);
    if (frames.length % 20 === 0) drawFilmstrip();
  }
  URL.revokeObjectURL(url); el.removeAttribute('src'); drawFilmstrip();
}
function drawFilmstrip() {
  const v = P.video, cv = $('#vrow canvas'); if (!v || !cv) return;
  const r = dpr(), w = Math.max(1, vLen() * pps), h = cv.clientHeight || 48;
  cv.width = Math.min(16000, Math.round(w * r)); cv.height = Math.round(h * r);
  const g = cv.getContext('2d'); g.setTransform(cv.width / w, 0, 0, r, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  const th = thumbs.get(v.id); if (!th || !th.frames.length) return;
  const fw = h * 16 / 9;
  for (let x = 0; x < w; x += fw) { const i = Math.min(th.frames.length - 1, Math.round((v.start + x / pps) / th.step)); g.drawImage(th.frames[i], x, 0, fw, h); }
}
function renderVideoRow() {
  const row = $('#vrow'), v = P.video;
  if (!v) { row.hidden = true; row.innerHTML = ''; return; }
  const t = libTrack(v.id), name = t ? t.title : 'Missing video';
  row.hidden = false;
  row.innerHTML = `<div class="vlane"><div class="lane-head"><div class="lh-top"><span class="vname">Picture</span>
      <button class="tg" data-vact="win" title="Show or hide the video window (V)">▣</button><button class="tg lk${v.locked ? ' on' : ''}" data-vact="lock" aria-pressed="${!!v.locked}" title="${v.locked ? 'Unlock the picture' : 'Lock the picture: it cannot be moved or trimmed by accident'}"><svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.4"/></svg></button><button class="tg x" data-vact="remove" title="Remove the scene video">✕</button></div>
      <div class="lh-row vsub"><span title="${esc(name)}">${esc(name)} · ${fpsOf()} fps</span></div></div>
    <div class="lane-body" style="width:${timelineWidth()}px"><div class="vclip" style="left:${v.at * pps}px;width:${Math.max(4, vLen() * pps)}px">
      <span class="vcl" title="Drag to move the scene · ${esc(name)}">${esc(name)}${v.start > 0.05 ? ` · lead-in trimmed ${v.start.toFixed(1)}s` : ''}</span><canvas></canvas>
      <span class="h l" data-vh="l" title="Drag to trim the start (for example a countdown lead-in)"></span><span class="h r" data-vh="r" title="Drag to trim the end"></span></div></div></div>`;
  drawFilmstrip();
}
$('#vrow').addEventListener('click', e => {
  const b = e.target.closest('[data-vact]'); if (!b) return;
  if (b.dataset.vact === 'win') acts.vwclose(true);
  if (b.dataset.vact === 'remove') { if (P.video.locked) return toast('The picture is locked. Unlock it first to remove it.'); removeVideo(); }
  if (b.dataset.vact === 'lock') { P.video.locked = !P.video.locked; quietCommit(); renderVideoRow(); renderInspector(); toast(P.video.locked ? 'Picture locked: it cannot be moved or trimmed. Music can still be edited around it.' : 'Picture unlocked.'); }
});
$('#vrow').addEventListener('pointerdown', e => {
  const v = P.video; if (!v || e.button !== 0) return;
  const body = e.target.closest('.lane-body'); if (!body) return;
  const vh = e.target.dataset.vh, isBar = e.target.classList.contains('vcl');
  if (!vh && !isBar) { seekClick(clamp((e.clientX - body.getBoundingClientRect().left) / pps, 0, projectEnd())); return; }
  if (v.locked) { seekClick(clamp((e.clientX - body.getBoundingClientRect().left) / pps, 0, projectEnd())); return toast('The picture is locked. Click its padlock to move or trim it.', 3000); }
  const el = e.target.closest('.vclip'); try { el.setPointerCapture(e.pointerId); } catch (_) {}
  const x0 = e.clientX, o = { at: v.at, start: v.start, end: v.end }; let moved = false;
  const mv = ev => {
    const dt = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return;
    if (isBar) v.at = Math.max(0, o.at + dt);
    else if (vh === 'l') { const ns = clamp(o.start + dt, 0, o.end - 0.5); v.start = ns; v.at = Math.max(0, o.at + (ns - o.start)); }
    else v.end = clamp(o.end + dt, o.start + 0.5, v.dur);
    el.style.left = v.at * pps + 'px'; el.style.width = vLen() * pps + 'px';
    renderMarkerLines(); scrubVideo(vh === 'r' ? videoEnd() - 0.01 : v.at + 0.001);
  };
  el.addEventListener('pointermove', mv);
  el.addEventListener('pointerup', () => { el.removeEventListener('pointermove', mv); if (moved) commit(); }, { once: true });
});
async function removeVideo() {
  if (!P.video) return;
  if (!(await ask({ title: 'Remove the scene video?', text: 'The video leaves this mix, and so do its hit points. The music stays. You can undo this.', ok: 'Remove video', danger: true }))) return;
  P.video = null; P.markers = (P.markers || []).filter(m => m.vt == null); UI.vwin = false; saveUI(); await ensureVideoEl(); commit('Scene video removed');
}
/* hit points (markers) */
const mT = m => (m.vt != null && P.video) ? P.video.at + (m.vt - P.video.start) : m.t;
const visibleMarkers = () => (P.markers || []).filter(m => m.vt == null || (P.video && m.vt >= P.video.start - 1e-3 && m.vt <= P.video.end + 1e-3)).sort((a, b) => mT(a) - mT(b));
function addMarker(t = playhead, label) {
  P.markers = P.markers || [];
  const vt = videoTimeAt(t), n = P.markers.length + 1;
  const m = vt != null ? { id: uid(), vt, label: label || `Hit ${n}` } : { id: uid(), t, label: label || `Marker ${n}` };
  P.markers.push(m); selMarker = m.id; commit(`Added “${m.label}” at ${P.video ? tc(t) : fmtT(t)}. Drag it on the ruler, or rename it under Scene on the right.`);
}
function setMarkerTime(m, t) { const vt = videoTimeAt(t); if (m.vt != null && vt != null) m.vt = vt; else { delete m.vt; m.t = Math.max(0, t); } }
function deleteMarker(id) { if (P.markersLocked) return toast('Hit points are locked. Unlock them in Settings → Scene to remove one.', 3500); P.markers = (P.markers || []).filter(m => m.id !== id); if (selMarker === id) selMarker = null; commit('Hit point removed'); }
function renderMarkerLines() {
  $('#mklines').innerHTML = visibleMarkers().map(m => `<div class="mk${m.id === selMarker ? ' sel' : ''}" style="left:${headW() + mT(m) * pps}px"></div>`).join('');
}
function drawMarkersOnRuler(g, w) {
  const ms = visibleMarkers(); let lastX = -1e9;
  g.font = `600 10px ${css('--f-ui')}`; g.textBaseline = 'middle';
  for (const m of ms) {
    const x = mT(m) * pps; if (x < -10 || x > w + 10) continue;
    g.fillStyle = m.id === selMarker ? '#E9E3FF' : '#A78BFA';
    g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 8); g.closePath(); g.fill();
    if (x - lastX > 60) { g.fillText(m.label.slice(0, 18), x + 7, 22); lastX = x; }
  }
}
async function findCuts() {
  const v = P.video; if (!v) return toast('Add a scene video first.');
  const t = libTrack(v.id); if (!t) return;
  const el = document.createElement('video'); el.muted = true; el.preload = 'auto';
  const url = URL.createObjectURL(t.blob); el.src = url; await once(el, 'loadedmetadata');
  const W = 48, H = 27, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const grab = async s => { el.currentTime = s; if (!(await once(el, 'seeked', 3000))) return null; g.drawImage(el, 0, 0, W, H); const d = g.getImageData(0, 0, W, H).data, cur = new Float32Array(W * H); for (let i = 0; i < cur.length; i++) cur[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; return cur; };
  const diffOf = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
  const step = 0.2, diffs = []; let prev = null, cancelled = false;
  busy('Looking for cuts in the scene…', { progress: 0, onCancel: () => { cancelled = true; } });
  for (let s = v.start; s < v.end && !cancelled; s += step) {
    const cur = await grab(s); if (!cur) continue;
    if (prev) diffs.push({ s0: s - step, s, diff: diffOf(cur, prev) });
    prev = cur;
    busy('Looking for cuts in the scene…', { progress: (s - v.start) / vLen() * 0.85, onCancel: () => { cancelled = true; } });
  }
  if (cancelled) { URL.revokeObjectURL(url); el.removeAttribute('src'); busy(null); return toast('Stopped looking for cuts.'); }
  if (diffs.length < 3) { URL.revokeObjectURL(url); el.removeAttribute('src'); busy(null); return toast('The scene is too short to look for cuts.'); }
  // A cut is a frame change much bigger than what is normal around it (camera moves, actors walking)
  const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const found = [];
  diffs.forEach((x, i) => {
    const around = diffs.slice(Math.max(0, i - 5), i + 6).filter((_, j) => j !== Math.min(i, 5)).map(y => y.diff);
    const local = med(around);
    if (x.diff >= Math.max(12, 3 * local + 4) && x.diff >= (diffs[i - 1]?.diff ?? 0) && x.diff >= (diffs[i + 1]?.diff ?? 0)) found.push(x);
  });
  // Narrow each cut down to the exact frame
  const cuts = [], frame = 1 / fpsOf();
  for (const [k, x] of found.entries()) {
    busy(`Pinning cut ${k + 1} of ${found.length} to the exact frame…`, { progress: 0.85 + 0.15 * k / found.length });
    let a = x.s0, b = x.s; const A = await grab(a), B = await grab(b);
    if (A && B) for (let n = 0; n < 8 && b - a > frame; n++) { const m = (a + b) / 2, M = await grab(m); if (!M) break; if (diffOf(M, A) < diffOf(M, B)) a = m; else b = m; }
    if (!cuts.length || b - cuts[cuts.length - 1] > 0.5) cuts.push(b);
  }
  URL.revokeObjectURL(url); el.removeAttribute('src'); busy(null);
  P.markers = P.markers || [];
  let added = 0;
  for (const s of cuts) {
    if (P.markers.some(m => m.vt != null && Math.abs(m.vt - s) < 0.25)) continue;
    P.markers.push({ id: uid(), vt: s, label: `Cut ${++added}` });
  }
  commit(added ? `Found ${added} cut${added === 1 ? '' : 's'} and marked ${added === 1 ? 'it' : 'them'} as hit points.` : 'No clear cuts found in this scene.');
}
function exportMarkers() {
  const ms = visibleMarkers(); if (!ms.length) return toast('There are no hit points to save yet. Press M to add one.');
  const t = P.video && libTrack(P.video.id);
  const data = { app: 'Mixtape Studio', scene: t ? t.title : P.name, fps: fpsOf(), hitPoints: ms.map(m => ({ label: m.label, seconds: +(m.vt != null ? m.vt : m.t).toFixed(3), timecode: tc(m.vt != null ? m.vt : m.t), relativeTo: m.vt != null ? 'video' : 'timeline' })) };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), safeName((t ? t.title : P.name) + ' hit points') + '.json');
  toast(`Saved ${ms.length} hit point${ms.length === 1 ? '' : 's'} as a file.`);
}
async function importMarkers(file) {
  const text = await file.text(); let rows = [];
  try {
    const j = JSON.parse(text), list = Array.isArray(j) ? j : (j.hitPoints || j.markers || j.cues || []);
    if (j.fps && P.video) P.video.fps = +j.fps || P.video.fps;
    rows = list.map(x => ({ time: x.seconds ?? x.time ?? x.t ?? x.timecode ?? x.tc, label: x.label ?? x.name ?? x.title }));
  } catch (e) {
    rows = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^time\b/i.test(l)).map(l => { const i = l.search(/[,\t;]/); return i < 0 ? { time: l } : { time: l.slice(0, i), label: l.slice(i + 1).replace(/^["']|["']$/g, '').trim() }; });
  }
  P.markers = P.markers || []; let n = 0, skipped = 0;
  for (const r of rows) {
    const s = parseTime(r.time); if (s == null || s < 0) continue;
    const label = String(r.label || `Hit ${P.markers.length + 1}`).slice(0, 60);
    if (P.markers.some(m => Math.abs((P.video ? m.vt : m.t) - s) <= 1 / fpsOf() + 1e-6)) { skipped++; continue; }
    P.markers.push(P.video ? { id: uid(), vt: s, label } : { id: uid(), t: s, label }); n++;
  }
  commit(n || skipped ? `Imported ${n} hit point${n === 1 ? '' : 's'}${skipped ? ` (${skipped} already there)` : ''}.` : 'No times found in that file. Use JSON, or CSV lines like “00:00:12:05, Door slams”.');
}
async function fitBetween() {
  const c = clipById(selClip); if (!c) return;
  const ms = visibleMarkers(); if (ms.length < 2) return toast('Add at least two hit points first (press M at the playhead).', 4500);
  const startDef = ms.findIndex(m => mT(m) >= c.at - 0.3), i0 = startDef < 0 ? 0 : Math.min(startDef, ms.length - 2);
  const opt = sel => ms.map((m, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(m.label)} · ${P.video ? tc(mT(m)) : fmtT(mT(m))}</option>`).join('');
  const ch = await ask({ title: 'Fit between hit points', ok: 'Fit part', text: 'The part is moved to the first hit point and sped up or slowed down, keeping its pitch, so it ends exactly on the second.',
    extra: `<fieldset class="opts"><legend>Start on</legend><select name="a">${opt(i0)}</select></fieldset><fieldset class="opts"><legend>End on</legend><select name="b">${opt(i0 + 1)}</select></fieldset>`,
    read: f => { const a = +f.querySelector('[name=a]').value, b = +f.querySelector('[name=b]').value; if (mT(ms[b]) <= mT(ms[a]) + 0.1) { toast('The end hit point must come after the start.'); return undefined; } return { a, b }; } });
  if (!ch) return;
  const A = mT(ms[ch.a]), B = mT(ms[ch.b]), want = (c.end - c.start) / (B - A), r = clamp(want, 0.5, 2);
  c.at = A; c.keepPitch = true; c.rate = r;
  try { await ensureProc(c); } catch (e) { return toast('Could not change the speed: ' + e.message, 5000); }
  commit(r === want ? `Fitted between “${ms[ch.a].label}” and “${ms[ch.b].label}” (speed ${Math.round(r * 100)}%)` : `That needed ${Math.round(want * 100)}% speed, so it was limited to ${Math.round(r * 100)}%. Trim the part first for an exact fit.`);
}
/* the floating video window: drag by its title bar, double-click for full screen */
(() => {
  const w = $('#vwin');
  $('#vwHead').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = w.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    const mv = ev => { w.style.left = clamp(ev.clientX - x0, 0, innerWidth - 120) + 'px'; w.style.top = clamp(ev.clientY - y0, 0, innerHeight - 60) + 'px'; w.style.right = 'auto'; w.style.bottom = 'auto'; };
    e.currentTarget.addEventListener('pointermove', mv);
    e.currentTarget.addEventListener('pointerup', () => e.currentTarget.removeEventListener('pointermove', mv), { once: true });
  });
  vid.addEventListener('dblclick', () => acts.vfull());
})();
function renderVideoWindow() {
  const show = !!(P.video && UI.vwin); $('#vwin').hidden = !show;
  const t = P.video && libTrack(P.video.id); $('#vwName').textContent = t ? t.title : '';
}
$('#vidIn').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importVideo(f); });
$('#mkIn').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importMarkers(f); });


/* ---------- tempo from hit points ----------
   Bar 1 starts on the first hit; every tempo from 40 to 220 BPM is tried in 0.01 steps, and each is scored by how
   many of the other hits land within a frame of a beat (or of an eighth note), then by how far the worst one misses. */
function solveTempo(hits, fps = fpsOf(), { min = 40, max = 220, tolFrames = 1 } = {}) {
  hits = [...hits].sort((a, b) => a - b); if (hits.length < 2) return [];
  const o = hits[0], rest = hits.slice(1), tol = tolFrames / fps + 1e-9, out = [];
  for (let k = Math.round(min * 100); k <= Math.round(max * 100); k++) {
    const bpm = k / 100, res = {};
    for (const sub of [1, 2]) {
      const p = 60 / bpm / sub; let caught = 0, worst = 0, sum = 0;
      for (const h of rest) { const x = (h - o) / p, e = Math.abs(x - Math.round(x)) * p; if (e <= tol) caught++; worst = Math.max(worst, e); sum += e; }
      res[sub] = { caught, worst: worst * fps, mean: sum / rest.length * fps };
    }
    out.push({ bpm, beat: res[1], eighth: res[2] });
  }
  // most hits on a beat first; then most on an eighth (a hit on the 'and' is still a musical hit); then the smallest average miss
  out.sort((a, b) => b.beat.caught - a.beat.caught || b.eighth.caught - a.eighth.caught || (a.beat.mean + a.eighth.mean) - (b.beat.mean + b.eighth.mean));
  const picks = [];
  const near = (x, y) => Math.abs(x - y) <= Math.max(0.6, y * 0.006);
  for (const c of out) { if (picks.some(p => near(p.bpm, c.bpm) || near(p.bpm * 2, c.bpm) || near(p.bpm / 2, c.bpm))) continue; picks.push(c); if (picks.length >= 8) break; }
  return picks.map(c => ({ ...c, of: rest.length }));
}
async function findTempo() {
  const ms = visibleMarkers(); if (ms.length < 3) return toast('Mark at least three hit points first: the first is where bar 1 starts, the others are what the tempo has to catch.', 5000);
  const inLoop = loopActive() ? ms.filter(m => mT(m) >= P.loop.a - 1e-3 && mT(m) <= P.loop.b + 1e-3) : ms, use = inLoop.length >= 3 ? inLoop : ms;
  const hits = use.map(mT), picks = solveTempo(hits), fps = fpsOf(), f1 = n => n.toFixed(1);
  const rows = picks.map((c, i) => `<label class="trow"><input type="radio" name="bpm" value="${c.bpm}" ${i ? '' : 'checked'}><b>${c.bpm.toFixed(2)} BPM</b><span>${c.beat.caught}/${c.of} on a beat · worst ${f1(c.beat.worst)} fr</span><span class="dim">${c.eighth.caught}/${c.of} on an eighth</span></label>`).join('');
  const ch = await ask({ title: 'Tempo from hit points', ok: 'Use this tempo',
    text: `Bar 1 starts on “${use[0].label}” (${tc(hits[0])}). These tempos catch the most of the other ${hits.length - 1} hit points within one frame at ${fps} fps.${use !== ms ? ' Only the hit points inside the loop were used.' : ''}`,
    extra: `<div class="tempo-picks">${rows}</div>`, read: f => { const v = f.querySelector('[name=bpm]:checked'); return v ? { bpm: +v.value } : undefined; } });
  if (!ch || !ch.bpm) return;
  const bpm = ch.bpm;
  P.bpm = bpm; P.tempoChanges = []; P.beat0 = hits[0];
  const c = picks.find(x => x.bpm === bpm);
  commit(`Mix tempo ${bpm.toFixed(2)} BPM, bar 1 on “${use[0].label}”: ${c.beat.caught} of ${c.of} hit points land on a beat.`);
}
function sceneSectionHTML() {
  const v = P.video, ms = visibleMarkers();
  const fpsOpts = [23.976, 24, 25, 29.97, 30].map(f => `<option value="${f}" ${v && +v.fps === f ? 'selected' : ''}>${f} fps</option>`).join('');
  const hits = ms.length ? `<div class="hits">${ms.map(m => `<div class="hit${m.id === selMarker ? ' sel' : ''}" data-mk="${m.id}">
      <span class="tc" data-mkgo title="Jump here">${v ? tc(mT(m)) : fmtT(mT(m))}</span><input value="${esc(m.label)}" data-mkname aria-label="Hit point name" maxlength="60">
      <button data-mkgo title="Jump to this hit point">▶</button><button data-mkdel title="Remove this hit point">✕</button></div>`).join('')}</div>`
    : `<p class="hint">No hit points yet. Press <b>M</b> at the moment the music should land, for example a cut or a door slam.</p>`;
  if (!v) return `<div class="sec"><h3>Scene</h3><p class="hint">Score to picture: add the scene's video, then mark hit points the music must land on.</p>
    <div class="btnrow"><button class="btn sm primary" data-act="video">Add a scene video</button><button class="btn sm" data-act="loadhits">Import hit points</button>${ms.length >= 3 ? '<button class="btn sm" data-act="findtempo">Tempo from hits</button>' : ''}</div>${ms.length ? hits : ''}</div>`;
  const t = libTrack(v.id);
  return `<div class="sec"><h3>Scene</h3>
    <dl class="kv"><dt>Video</dt><dd>${esc(t ? t.title : 'Missing')}</dd><dt>Length</dt><dd>${tc(vLen())}</dd>${v.start > 0.05 ? `<dt>Lead-in</dt><dd>${v.start.toFixed(2)}s trimmed</dd>` : ''}</dl>
    <div class="field"><label for="sFps">Frame rate</label><select id="sFps" data-sf="fps">${fpsOpts}</select><span></span></div>
    <div class="field"><label for="sVol">Scene sound</label><input id="sVol" type="range" min="0" max="100" value="${Math.round((v.vol ?? 0.8) * 100)}" data-sf="vol"><output>${Math.round((v.vol ?? 0.8) * 100)}%</output></div>
    <label class="chk"><input type="checkbox" data-vlock ${v.locked ? 'checked' : ''}> Lock the picture (it cannot be moved or trimmed)</label>
    <div class="btnrow"><button class="btn sm" data-act="video">${UI.vwin ? 'Hide video' : 'Show video'}</button><button class="btn sm" data-act="actionzero" ${v.at > 0.01 ? '' : 'disabled'}>Start the action at 0:00</button></div>
    <p class="sub">Hit points</p>${hits}
    <label class="chk"><input type="checkbox" data-mklock ${P.markersLocked ? 'checked' : ''}> Lock hit points (they cannot be dragged or removed; you can still add new ones)</label>
    <div class="btnrow"><button class="btn sm primary" data-act="addhit">+ Hit point (M)</button><button class="btn sm" data-act="findcuts">Find cuts</button><button class="btn sm" data-act="findtempo" ${ms.length >= 3 ? '' : 'disabled'} title="Find the tempos that land the most hit points on a beat">Tempo from hits</button></div>
    <div class="btnrow"><button class="btn sm" data-act="loadhits">Import hit points</button><button class="btn sm" data-act="savehits" ${ms.length ? '' : 'disabled'}>Save hit points</button></div>
    <p class="hint">Right-click a part and choose “Fit between hit points” to make it start and end exactly on two of them. Scene sound plays while you work but is never mixed into exports.</p></div>`;
}
$('#insp').addEventListener('click', e => {
  const row = e.target.closest('[data-mk]'); if (!row) return;
  const m = (P.markers || []).find(x => x.id === row.dataset.mk); if (!m) return;
  if (e.target.closest('[data-mkdel]')) return deleteMarker(m.id);
  if (e.target.closest('[data-mkgo]')) { selMarker = m.id; seek(mT(m)); renderMarkerLines(); renderRuler(); renderInspector(); }
});
$('#insp').addEventListener('change', e => {
  if (e.target.matches('[data-mkname]')) { const m = (P.markers || []).find(x => x.id === e.target.closest('[data-mk]').dataset.mk); if (m) { m.label = e.target.value.trim() || m.label; quietCommit(); renderRuler(); } return; }
  if (e.target.dataset.sf === 'fps' && P.video) { P.video.fps = +e.target.value; commit(`Frame rate set to ${P.video.fps} fps`); }
  if (e.target.dataset.sf === 'vol' && P.video) quietCommit();
});
$('#insp').addEventListener('input', e => {
  if (e.target.dataset.sf === 'vol' && P.video) { P.video.vol = e.target.value / 100; e.target.nextElementSibling.textContent = e.target.value + '%'; applySceneVol(); }
});


/* ---------- tempo changes ---------- */
function tempoMapHTML() {
  if (!P.bpm) return '';
  const ch = [...(P.tempoChanges || [])].sort((a, b) => a.t - b.t);
  const fmt = t => clockMode() === 'tc' ? tc(t) : clockMode() === 'bars' ? fmtBars(t) : fmtT(t);
  return `<p class="sub">Tempo changes</p>
    ${ch.length ? `<div class="hits">${ch.map(c => `<div class="hit" data-tc="${c.id}"><span class="tc" data-tcgo title="Jump here">${fmt(c.t)}</span>
      <input type="number" min="20" max="400" step="0.1" value="${c.bpm}" data-tcbpm aria-label="Tempo from here"><span class="ana">BPM</span><button data-tcdel title="Remove this tempo change">✕</button></div>`).join('')}</div>`
      : `<p class="hint">The whole cue runs at ${P.bpm} BPM. Press <b>T</b> to change tempo at the playhead.</p>`}
    <div class="btnrow"><button class="btn sm" data-act="addtempo">+ Tempo change (T)</button><button class="btn sm" data-act="fittempo" ${visibleMarkers().length >= 2 ? '' : 'disabled'} title="Choose a tempo so a whole number of bars fits exactly between two hit points">Fit tempo to hit points…</button></div>`;
}
function addTempoChange(t, bpm) {
  if (!P.bpm) return toast('Set the mix tempo first: add a song with a beat, or type a tempo under Mix.', 5000);
  if (t < 0.05) return toast('Move the playhead later than 0:00. The mix tempo above sets the start.');
  P.tempoChanges = (P.tempoChanges || []).filter(c => Math.abs(c.t - t) > 0.01);
  const v = Math.round((bpm || tempoAt(t)) * 10) / 10;
  P.tempoChanges.push({ id: uid(), t, bpm: v });
  commit(`Tempo change at ${fmtT(t)}: ${v} BPM. Type the new tempo under Mix on the right.`);
}
async function fitTempoToHits() {
  const ms = visibleMarkers(); if (ms.length < 2 || !P.bpm) return toast('Add two hit points and a mix tempo first.');
  const opt = sel => ms.map((m, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(m.label)} · ${P.video ? tc(mT(m)) : fmtT(mT(m))}</option>`).join('');
  const ch = await ask({ title: 'Fit tempo to hit points', ok: 'Set tempo',
    text: 'Pick two hit points and how many bars of music should fit between them. The tempo changes at the first hit point so bar lines land exactly on both.',
    extra: `<fieldset class="opts"><legend>From</legend><select name="a">${opt(0)}</select></fieldset><fieldset class="opts"><legend>To</legend><select name="b">${opt(1)}</select></fieldset>
      <fieldset class="opts"><legend>Bars between them</legend><input name="bars" type="number" min="1" max="200" step="1" value="${Math.max(1, Math.round((mT(ms[1]) - mT(ms[0])) * tempoAt(mT(ms[0])) / 240))}"></fieldset>`,
    read: f => { const a = +f.querySelector('[name=a]').value, b = +f.querySelector('[name=b]').value, bars = +f.querySelector('[name=bars]').value;
      if (mT(ms[b]) <= mT(ms[a]) + 0.2) { toast('The second hit point must come after the first.'); return undefined; }
      if (!(bars >= 1)) { toast('Enter at least one bar.'); return undefined; } return { a, b, bars }; } });
  if (!ch) return;
  const A = mT(ms[ch.a]), B = mT(ms[ch.b]), bpm = Math.round(ch.bars * 4 * 60 / (B - A) * 1000) / 1000;
  if (bpm < 20 || bpm > 400) return toast(`That needs ${bpm.toFixed(1)} BPM, which is outside 20–400. Try a different number of bars.`, 5000);
  P.tempoChanges = (P.tempoChanges || []).filter(c => c.t <= A - 0.01 || c.t >= B + 0.01);
  if (A < 0.05) P.bpm = bpm; else P.tempoChanges.push({ id: uid(), t: A, bpm });
  commit(`${ch.bars} bar${ch.bars === 1 ? '' : 's'} at ${Math.round(bpm * 100) / 100} BPM now fit exactly from “${ms[ch.a].label}” to “${ms[ch.b].label}”.`);
}
function renderGrid() {
  let g = $('#gridlines'); if (!g) { g = document.createElement('div'); g.id = 'gridlines'; $('#tlInner').prepend(g); }
  if (!P.snap || !P.bpm) { g.innerHTML = ''; return; }
  const w = timelineWidth(), out = [];
  for (let b = Math.ceil(beatAt(0) - 1e-6), n = 0, t = timeAtBeat(b); t * pps < w && n < 8000; b++, n++, t = timeAtBeat(b)) {
    const bar = ((b % 4) + 4) % 4 === 0; if (!bar && (timeAtBeat(b + 1) - t) * pps < 6) continue;
    out.push(`<i class="${bar ? 'bar' : ''}" style="left:${headW() + t * pps}px"></i>`);
  }
  g.innerHTML = out.join('');
}
$('#insp').addEventListener('click', e => {
  const row = e.target.closest('[data-tc]'); if (!row) return;
  const c = (P.tempoChanges || []).find(x => x.id === row.dataset.tc); if (!c) return;
  if (e.target.closest('[data-tcdel]')) { P.tempoChanges = P.tempoChanges.filter(x => x !== c); commit('Tempo change removed'); }
  else if (e.target.closest('[data-tcgo]')) seek(c.t);
});
$('#insp').addEventListener('change', e => {
  if (!e.target.matches('[data-tcbpm]')) return;
  const c = (P.tempoChanges || []).find(x => x.id === e.target.closest('[data-tc]').dataset.tc); if (!c) return;
  const v = parseFloat(e.target.value); if (!(v >= 20 && v <= 400)) return toast('Use a tempo between 20 and 400 BPM.');
  c.bpm = Math.round(v * 10) / 10; commit(`From ${fmtT(c.t)} the tempo is ${c.bpm} BPM`);
});


/* ---------- the production studio's score package ----------
   Contract (format "mindcraft.score-package/1"), one folder per locked cut:
     score-package.json  { format, production:{id,title,kind}, cut:{id,version,stage,lockedAt,runningTimeSec},
                           fps, picture, scenes:[{index,title,startSec,endSec}],
                           shots:[{id,sceneIndex,order,startSec,endSec,placeholder}],
                           cues:[{ref,title,origin,startSec,endSec,notes}], hitPoints:[{label,seconds}] }
     picture.mp4         the cut, optional
     deliveries/<cue ref>/mix.wav, stems/<track>.wav, delivery.json   written by Mixtape
   All times are seconds in the cut. Mixtape re-reads the package every few seconds while linked. */
const LINK_DB = 'mixtape-studio-links';
let linkDir = null, linkTimer = null, linkBusy = false;
function linkStore(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(LINK_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => { try { const t = r.result.transaction('handles', mode), q = fn(t.objectStore('handles')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); } catch (e) { rej(e); } };
    r.onerror = () => rej(r.error);
  });
}
const cutOffset = () => P.video ? P.video.at - P.video.start : 0;          // cut seconds -> timeline seconds
const cueRange = c => ({ a: c.startSec + cutOffset(), b: c.endSec + cutOffset() });
async function readPackage(dir) {
  const fh = await dir.getFileHandle('score-package.json'), f = await fh.getFile();
  const pkg = JSON.parse(await f.text());
  if (!String(pkg.format || '').startsWith('mindcraft.score-package/')) throw new Error('This folder’s score-package.json is not a Mindcraft score package.');
  return { pkg, modified: f.lastModified };
}
async function linkFolder() {
  if (!window.showDirectoryPicker) return toast('Linking a folder needs Chrome or Edge on a laptop.', 5000);
  let dir; try { dir = await window.showDirectoryPicker({ id: 'mixtape-score', mode: 'readwrite' }); } catch (e) { return; }
  try { await readPackage(dir); } catch (e) { return toast(e.name === 'NotFoundError' ? 'That folder has no score-package.json in it. Pick the folder the production studio made for the cut.' : e.message, 6000); }
  linkDir = dir; takesSig = ''; try { await linkStore('readwrite', s => s.put(dir, 'score')); } catch (e) {}
  P.link = P.link && P.link.folder === dir.name ? { ...P.link, modified: 0 } : { folder: dir.name, modified: 0, cues: [], shots: [], scenes: [] };
  await syncPackage(true); startWatch();
}
async function reconnectFolder() {
  let dir = null; try { dir = await linkStore('readonly', s => s.get('score')); } catch (e) {}
  if (!dir) return linkFolder();
  try { if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') return toast('Mixtape needs permission to read and write that folder.'); } catch (e) { return linkFolder(); }
  linkDir = dir; await syncPackage(true); startWatch();
}
/* ---------- projects ---------- */
function openProject(id, p) {
  pause(); stopWatch(); linkDir = null;
  projId = id; try { localStorage.setItem(LSP_CUR, id); } catch (e) {}
  P = normalize(p || JSON.parse(localStorage.getItem(LSP_ONE(id)) || 'null'));
  hist = []; fut = []; last = JSON.stringify(P); persist();
  selClip = null; selLane = P.lanes[0].id; edSel = null; tlSel = null; playhead = 0;
  renderAll(); if (P.clips.length) fitZoom();
  toast(`Opened “${P.name}”${P.link ? '. Reconnect its score folder in Settings to keep it in sync.' : ''}`);
}
function newMix() {
  const list = loadIndex(), base = 'My mix'; let name = base, n = 2;
  while (list.some(x => x.name === name)) name = `${base} ${n++}`;
  const p = newProject(); p.name = name; openProject(uid(), p);
}
async function projectsMenu(btn) {
  const list = loadIndex().sort((a, b) => b.updated - a.updated);
  const when = t => { const d = new Date(t), today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };
  const items = [{ label: 'New mix', act: newMix },
    { label: `Duplicate “${P.name}”`, act: () => { const p = JSON.parse(JSON.stringify(P)); p.name = P.name + ' copy'; p.link = null; openProject(uid(), p); } },
    { label: `Delete “${P.name}”…`, danger: true, act: deleteProject },
    { sep: true },
    ...list.map(x => ({ label: `${x.id === projId ? '● ' : '   '}${x.name}  ·  ${when(x.updated)}`, disabled: x.id === projId, act: () => openProject(x.id) }))];
  const r = btn.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, items);
}
async function deleteProject() {
  if (!(await ask({ title: `Delete “${P.name}”?`, text: 'The mix goes, not the songs in it: they stay in your library. This cannot be undone.', ok: 'Delete mix', danger: true }))) return;
  const list = loadIndex().filter(x => x.id !== projId); try { localStorage.removeItem(LSP_ONE(projId)); } catch (e) {}
  saveIndex(list);
  if (list.length) openProject(list.sort((a, b) => b.updated - a.updated)[0].id); else newMix();
}
function unlinkFolder() { stopWatch(); linkDir = null; P.link = null; P.markers = (P.markers || []).filter(m => m.src !== 'pkg'); commit('Unlinked from the production studio. Your music stays.'); }
// Every 4 s while you are looking at Mixtape, every 15 s while it is hidden behind another tab, and at once when you come back
let linkTicks = 0;
function startWatch() { stopWatch(); linkTimer = setInterval(() => { linkTicks++; if (document.visibilityState === 'visible' || linkTicks % 4 === 0) syncPackage(false); }, 4000); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && linkDir) syncPackage(false); });
function stopWatch() { clearInterval(linkTimer); linkTimer = null; }
/* Which cues does a new version of the cut actually move? Only those whose shots changed. */
function staleReasons(oldShots, newShots, cue) {
  const byId = new Map(newShots.map(s => [s.id, s])), frame = 1 / fpsOf() + 1e-6, out = [];
  for (const s of oldShots) {
    if (s.endSec <= cue.startSec || s.startSec >= cue.endSec) continue;
    const n = byId.get(s.id);
    if (!n) out.push(`shot ${s.order ?? s.id} was cut`);
    else if (Math.abs(n.startSec - s.startSec) > frame || Math.abs(n.endSec - s.endSec) > frame) out.push(`shot ${s.order ?? s.id} moved ${(n.startSec - s.startSec >= 0 ? '+' : '') + (n.startSec - s.startSec).toFixed(2)}s, now ${(n.endSec - n.startSec).toFixed(2)}s long`);
  }
  return out;
}
async function syncPackage(first) {
  if (!linkDir || linkBusy) return; linkBusy = true;
  try {
    const { pkg, modified } = await readPackage(linkDir);
    if (!first && P.link && modified === P.link.modified) { if (await refreshTakes()) renderInspector(); return; }
    const L = P.link || { cues: [], shots: [] }, oldShots = L.shots || [], oldCues = new Map((L.cues || []).map(c => [c.ref, c]));
    const newVersion = L.cutVersion != null && pkg.cut && pkg.cut.version !== L.cutVersion;
    // picture
    if (pkg.picture) {
      try {
        const f = await (await linkDir.getFileHandle(pkg.picture)).getFile();
        if (!P.video || L.picture !== f.name + '|' + f.size + '|' + f.lastModified) { await importVideo(f, { silent: true, fps: pkg.fps }); L.picture = f.name + '|' + f.size + '|' + f.lastModified; }
      } catch (e) { toast(`The package names a picture file (${pkg.picture}) that is not in the folder.`, 5000); }
    }
    if (P.video && pkg.fps) P.video.fps = +pkg.fps;
    // cues: carry delivery history, mark only the ones whose picture moved
    const moved = [];
    L.cues = (pkg.cues || []).map(c => {
      const old = oldCues.get(c.ref), cue = { ref: String(c.ref), title: String(c.title || c.ref), origin: c.origin || 'WRITTEN', startSec: +c.startSec, endSec: +c.endSec, notes: c.notes || '', delivered: old ? old.delivered || 0 : 0, lastLoudness: old ? old.lastLoudness : undefined, stale: old ? old.stale || [] : [] };
      if (old && newVersion) {
        const why = staleReasons(oldShots, pkg.shots || [], old);
        if (Math.abs(old.startSec - cue.startSec) > 1e-3 || Math.abs(old.endSec - cue.endSec) > 1e-3) why.unshift(`cue moved to ${fmtT(cue.startSec)}–${fmtT(cue.endSec)}`);
        if (why.length) { cue.stale = why; moved.push(cue.ref); }
      }
      return cue;
    });
    L.shots = (pkg.shots || []).map(s => ({ id: s.id, order: s.order, sceneIndex: s.sceneIndex, startSec: +s.startSec, endSec: +s.endSec, placeholder: !!s.placeholder }));
    L.scenes = (pkg.scenes || []).map(s => ({ index: s.index, title: s.title || '', startSec: +s.startSec, endSec: +s.endSec }));
    Object.assign(L, { folder: linkDir.name, modified, production: pkg.production || {}, cutId: pkg.cut && pkg.cut.id, cutVersion: pkg.cut && pkg.cut.version, stage: pkg.cut && pkg.cut.stage, lockedAt: pkg.cut && pkg.cut.lockedAt, runningTimeSec: pkg.cut && +pkg.cut.runningTimeSec || null, fps: +pkg.fps || null,
      deliveryProfile: PROFILES[pkg.deliveryProfile] ? pkg.deliveryProfile : null, timecode: pkg.timecode || null, rights: pkg.rights || null });
    P.link = L; await refreshTakes();
    // scene starts and the package's hit points become hit points that follow the picture
    P.markers = (P.markers || []).filter(m => m.src !== 'pkg');
    const mk = (sec, label) => P.markers.push(P.video ? { id: uid(), vt: sec + (P.video.start || 0) * 0, label, src: 'pkg' } : { id: uid(), t: sec, label, src: 'pkg' });
    L.scenes.forEach(s => mk(s.startSec, `Sc ${s.index}${s.title ? ' · ' + s.title : ''}`));
    // hit points marked by:'composer' are the ones Mixtape wrote back; they are already here as your own
    (pkg.hitPoints || []).filter(h => h.by !== 'composer').forEach(h => { const s = parseTime(h.seconds ?? h.timecode ?? h.time); if (s != null) mk(s, String(h.label || 'Hit')); });
    const unlocked = L.stage && !/LOCK/i.test(L.stage) && !L.lockedAt;
    commit(first ? `Linked to “${(L.production && L.production.title) || L.folder}”, cut v${L.cutVersion ?? '?'}: ${L.cues.length} cue${L.cues.length === 1 ? '' : 's'}, ${L.scenes.length} scene${L.scenes.length === 1 ? '' : 's'}.${unlocked ? ' This cut is not locked yet, so expect it to change.' : ''}`
      : newVersion ? (moved.length ? `The cut changed to v${L.cutVersion}. Picture moved under ${moved.length} cue${moved.length === 1 ? '' : 's'}: ${moved.join(', ')}. The others still fit.` : `The cut changed to v${L.cutVersion}, but no cue’s picture moved.`)
      : 'The score package was updated.');
  } catch (e) { if (first) toast('Could not read the score package: ' + e.message, 6000); }
  finally { linkBusy = false; }
}
/* EBU R128 / ITU-R BS.1770 integrated loudness, sample peak and true peak (4x oversampled) of a rendered buffer */
/* K-weighted energy per 100 ms hop, summed over the first two channels (shared by everything below) */
function kHops(buf) {
  const sr = buf.sampleRate, chs = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  const biq = (b0, b1, b2, a1, a2) => x => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; } return y; };
  let K = Math.tan(Math.PI * 1681.974450955533 / sr), Q = 0.7071752369554196, Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416), a0 = 1 + K / Q + K * K;
  const shelf = biq((Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  K = Math.tan(Math.PI * 38.13547087602444 / sr); Q = 0.5003270373238773; a0 = 1 + K / Q + K * K;
  const hp = biq(1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  const w = chs.map(x => hp(shelf(x))), hop = Math.round(0.1 * sr), H = Math.floor((w[0] ? w[0].length : 0) / hop), E = new Float64Array(H);
  for (let k = 0; k < H; k++) { let e = 0; for (const y of w) for (let i = k * hop; i < (k + 1) * hop; i++) e += y[i] * y[i]; E[k] = e; }
  return { E, hop, chs };
}
const LK = v => -0.691 + 10 * Math.log10(v + 1e-20);
const r1 = x => Math.round(x * 10) / 10;
/* mean-square of each window of `span` hops, stepping one hop (400 ms blocks = 4 hops, 3 s short-term = 30 hops) */
function windows(E, hop, span) { const out = []; let acc = 0; for (let k = 0; k < E.length; k++) { acc += E[k]; if (k >= span) acc -= E[k - span]; if (k >= span - 1) out.push(acc / (span * hop)); } return out; }
/* EBU R128 / ITU-R BS.1770 integrated loudness, true peak (4x), and EBU Tech 3342 loudness range of a rendered buffer */
function measureLoudness(buf) {
  const { E, hop, chs } = kHops(buf), z = windows(E, hop, 4), st = windows(E, hop, 30);
  const truePeakDb = MixtapeDSP.truePeak(chs), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let peak = 0; for (const x of chs) for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  const peakDb = r1(20 * Math.log10(peak + 1e-12));
  const abs = z.filter(v => LK(v) > -70); if (!abs.length) return { lufs: -Infinity, peakDb, truePeakDb, lra: 0, maxMomentary: -Infinity, maxShortTerm: -Infinity };
  const rel = LK(mean(abs)) - 10, gated = abs.filter(v => LK(v) > rel);
  // loudness range: short-term values, absolute gate −70, relative gate 20 LU under their energy mean, 95th minus 10th percentile
  let lra = 0; const sa = st.filter(v => LK(v) > -70);
  if (sa.length) { const g2 = LK(mean(sa)) - 20, kept = sa.map(LK).filter(x => x > g2).sort((a, b) => a - b); if (kept.length) { const at = p => kept[Math.max(0, Math.ceil(p * kept.length) - 1)]; lra = r1(at(0.95) - at(0.10)); } }
  return { lufs: r1(LK(mean(gated))), peakDb, truePeakDb, lra, maxMomentary: r1(Math.max(...z.map(LK))), maxShortTerm: st.length ? r1(Math.max(...st.map(LK))) : null };
}
/* Loudness of the mix measured only where someone is speaking: blocks where the marked dialogue track is above −70 LUFS
   and within 10 LU of its own gated level. Our approximation of Dolby Dialogue Intelligence, which Netflix and US broadcast use. */
function dialogueGated(mixBuf, dlgBuf) {
  const m = kHops(mixBuf), d = kHops(dlgBuf), zm = windows(m.E, m.hop, 4), zd = windows(d.E, d.hop, 4), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const absd = zd.filter(v => LK(v) > -70); if (!absd.length) return null;
  const gate = LK(mean(absd)) - 10, speech = [];
  for (let k = 0; k < Math.min(zm.length, zd.length); k++) if (LK(zd[k]) > -70 && LK(zd[k]) > gate) speech.push(zm[k]);
  return speech.length ? r1(LK(mean(speech))) : null;
}
/* ---------- delivery profiles: where the film is going decides how loud the final mix must be ---------- */
const PROFILES = {
  sabc: { name: 'SABC (South Africa)', target: -23, tol: 1, ceiling: -1, dialogue: false, lra: 18, start: '10:00:00:00' },
  r128: { name: 'EBU R128 (Europe)', target: -23, tol: 0.5, ceiling: -1, dialogue: false },
  netflix: { name: 'Netflix', target: -27, tol: 2, ceiling: -2, dialogue: true },
  atsc: { name: 'US broadcast (ATSC A/85)', target: -24, tol: 2, ceiling: -2, dialogue: true },
  paramount: { name: 'Paramount', target: -24, tol: 2, ceiling: -2, dialogue: false },
};
const profileId = () => (P.link && (P.link.profileChoice || P.link.deliveryProfile)) || 'sabc';
const startTC = () => (P.link && (P.link.tcChoice || (P.link.timecode && P.link.timecode.start))) || (PROFILES[profileId()].start || '01:00:00:00');
/* Programme timecode to seconds; correct at 23.976 (01:00:00:00 there is 3603.6 s of real time) */
function tcToSec(s, fps = fpsOf()) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(String(s || '').trim()); if (!m) return null;
  const nom = Math.round(fps); return (((+m[1] * 60 + +m[2]) * 60 + +m[3]) * nom + +m[4]) / fps;
}
const dialogueLane = () => P.lanes.find(l => l.role === 'dialogue');
/* What a person did to this stretch, so the studio can show human authorship alongside generated material */
function humanEdits(a, b) {
  const cs = P.clips.filter(c => !c.mute && c.at < b && c.at + dur(c) > a);
  const trimmed = cs.filter(c => c.kind === 'midi' ? false : (c.start > 0.01 || c.end < ((bufs.get(c.trackId) && bufs.get(c.trackId).buffer.duration) || c.end) - 0.01)).length;
  const lanes = new Set(cs.map(c => c.lane));
  const autos = P.lanes.filter(l => lanes.has(l.id)).reduce((n, l) => n + [...l.auto.vol, ...l.auto.pan].filter(p => p.t >= a && p.t <= b).length, 0);
  const notes = cs.filter(c => c.kind === 'midi').reduce((n, c) => n + c.notes.filter(x => x.t >= c.start && x.t < c.end).length, 0);
  return { parts: cs.length, trimmedParts: trimmed, fades: cs.filter(c => (c.fadeIn || 0) > 0 || (c.fadeOut || 0) > 0).length, automationPoints: autos, midiNotes: notes, tracks: lanes.size };
}
/* Generated takes: music the production studio made for a cue, waiting in generated/<cue>/takes.json */
let takesSig = '';
async function readText(dir, path) {
  const parts = path.split('/'), name = parts.pop(); let d = dir;
  for (const p of parts) d = await d.getDirectoryHandle(p);
  return (await (await d.getFileHandle(name)).getFile());
}
async function refreshTakes() {
  const L = P.link; if (!L || !linkDir) return false;
  const found = {};
  for (const c of L.cues) {
    try { const f = await readText(linkDir, `generated/${safeName(c.ref)}/takes.json`); const j = JSON.parse(await f.text()); if (j && Array.isArray(j.takes) && j.takes.length) found[c.ref] = j.takes; } catch (e) {}
  }
  const sig = JSON.stringify(found); if (sig === takesSig) return false;
  takesSig = sig; L.takes = found; return true;
}
async function placeTake(cue, take) {
  busy(`Bringing in the ${take.model} take…`);
  try {
    const f = await readText(linkDir, `generated/${safeName(cue.ref)}/${take.file}`);
    const done = lib.find(t => t.generatedBy && t.generatedBy.takeId === take.id);
    let id = done && done.id;
    if (!id) {
      id = uid();
      const blob = new Blob([await f.arrayBuffer()], { type: f.type || (take.file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav') });
      await saveToLibrary({ id, name: take.file, size: blob.size, type: blob.type, title: `${cue.ref} · ${take.model}`, artist: 'Generated', album: P.link.production?.title || 'Score', track: 0, duration: take.seconds || 0, added: Date.now(), blob, art: null,
        generatedBy: { takeId: take.id, model: take.model, endpoint: take.endpoint, prompt: take.prompt, seed: take.seed, terms: take.terms } });
    }
    const e = await ensureBuf(id), { a, b } = cueRange(cue);
    const l = newLane(`${cue.ref} ${take.model}`, PALETTE[P.lanes.length % PALETTE.length]); P.lanes.push(l);
    const c = newClip(id, l.id, a, 0, Math.min(e.buffer.duration, b - a + 2)); P.clips.push(c); selClip = c.id; selLane = l.id;
    const terms = take.terms && take.terms.commercial, forSale = P.link.rights && P.link.rights.forSale;
    commit(`Placed the ${take.model} take at ${cue.ref}.${forSale && terms !== 'yes' ? ' This film is marked for sale and this model is not cleared for that: the production studio will refuse a delivery that uses it.' : terms === 'check' ? ' Its terms still need clearing before the film is sold; the delivery will say so.' : terms === 'no' ? ' Its terms do not allow a sold film: the production studio will refuse a delivery that uses it.' : ''}`);
  } catch (err) { toast(`Could not bring in that take: ${err.message}`, 6000); }
  finally { busy(null); }
}
/* Which generated takes went into a stretch of the timeline, so the studio can check their terms */
function sourcesIn(a, b) {
  const seen = new Map();
  for (const c of P.clips) { if (c.mute || c.at >= b || c.at + dur(c) <= a) continue; const t = libTrack(c.trackId); if (t && !seen.has(t.id)) seen.set(t.id, { title: t.title, ...(t.generatedBy ? { generatedBy: t.generatedBy } : {}) }); }
  return [...seen.values()];
}
/* The whole cut, at the delivery spec: −23 LUFS integrated, true peak no higher than −1 dBTP (EBU R128) */
async function deliverFinal() {
  const L = P.link; if (!L || !linkDir) return toast('Link the score folder first.');
  if (!L.runningTimeSec) return toast('The score package does not say how long the cut is. Ask for it to be written again.');
  if (!P.clips.some(c => !c.mute)) return toast('There is nothing on the timeline to deliver yet.');
  const opts = Object.entries(PROFILES).map(([k, p]) => `<option value="${k}" ${k === profileId() ? 'selected' : ''}>${p.name}: ${p.target} LUFS${p.dialogue ? ' on dialogue' : ''}, peak ${p.ceiling} dBTP</option>`).join('');
  const choice = await ask({ title: 'Deliver the final mix', ok: 'Deliver',
    text: `The whole cut, ${fmtT(L.runningTimeSec)}, brought to the loudness the destination asks for, with a 24-bit file per track stamped with its programme timecode.`,
    extra: `<fieldset class="opts"><legend>Destination</legend><select name="prof">${opts}</select></fieldset><fieldset class="opts"><legend>Programme starts at</legend><input name="tc" value="${esc(startTC())}" style="font-family:var(--f-mono)"></fieldset>`,
    read: f => { const prof = f.querySelector('[name=prof]').value, tcs = f.querySelector('[name=tc]').value.trim(); if (tcToSec(tcs) == null) { toast('Write the start as hh:mm:ss:ff, for example 10:00:00:00.'); return undefined; } return { prof, tcs }; } });
  if (!choice) return;
  L.profileChoice = choice.prof; L.tcChoice = choice.tcs;
  const prof = PROFILES[choice.prof], a = cutOffset(), b = a + L.runningTimeSec, dl = dialogueLane();
  if (prof.dialogue && !dl) return toast(`${prof.name} measures loudness on the dialogue. Mark the dialogue track first: select it and tick “This is the dialogue” in Settings.`, 7000);
  const lanes = P.lanes.filter(l => P.clips.some(c => c.lane === l.id && !c.mute && c.at < b && c.at + dur(c) > a));
  pause();
  try {
    busy(`Final mix: measuring against ${prof.name}…`, { progress: 0 });
    const raw = await renderMix({ from: a, to: b, noLimit: true, noScale: true });
    let measured = measureLoudness(raw.buffer).lufs;
    if (prof.dialogue) { const d = await renderMix({ from: a, to: b, lane: dl.id, noScale: true }); measured = dialogueGated(raw.buffer, d.buffer); if (measured == null) return toast('The dialogue track is silent across the cut, so there is nothing to measure on.', 6000); }
    if (!Number.isFinite(measured)) return toast('The mix is silent.');
    const gain = prof.target - measured;
    busy(`Final mix: bringing it to ${prof.target} LUFS…`, { progress: 0.2 });
    const sr = ctx.sampleRate, t0 = tcToSec(choice.tcs), tr = Math.round(t0 * sr);
    const wav = name => ({ bits: 24, bext: { timeReference: tr, description: `${L.production?.title || 'Film'} final mix ${name}`, originatorRef: 'final' } });
    const mix = await renderMix({ from: a, to: b, gainDb: gain, ceiling: prof.ceiling - 0.1, wav: wav('mix') }), loud = measureLoudness(mix.buffer);
    const stems = []; let dlgBuf = null;
    for (const [i, l] of lanes.entries()) {
      busy(`Final mix: track ${i + 1} of ${lanes.length} (${l.name})…`, { progress: 0.2 + 0.8 * (i + 1) / (lanes.length + 1) });
      const s = await renderMix({ from: a, to: b, lane: l.id, gainDb: gain, noScale: true, wav: wav(l.name) });
      stems.push({ name: l.name, file: `stems/${safeName(l.name)}.wav`, blob: s.blob, lane: l.id }); if (dl && l.id === dl.id) dlgBuf = s.buffer;
    }
    const dg = dlgBuf ? dialogueGated(mix.buffer, dlgBuf) : null, judged = prof.dialogue ? dg : loud.lufs;
    const manifest = { format: 'mindcraft.mix-delivery/1', production: L.production, cutId: L.cutId, cutVersion: L.cutVersion, startSec: 0, endSec: L.runningTimeSec, sampleRate: sr,
      mix: 'mix.wav', stems: stems.map(s => ({ name: s.name, file: s.file })),
      loudness: { integratedLUFS: loud.lufs, samplePeakDbFS: loud.peakDb, truePeakDbTP: loud.truePeakDb, loudnessRangeLU: loud.lra, maxMomentaryLUFS: loud.maxMomentary, maxShortTermLUFS: loud.maxShortTerm,
        dialogueGatedLUFS: dg, dialogueStem: dlgBuf ? stems.find(s => s.lane === dl.id).file : null, method: 'ITU-R BS.1770-4 integrated, gated; true peak 4x oversampled; EBU Tech 3342 range; dialogue gating approximates Dolby Dialogue Intelligence' },
      profile: choice.prof, normalisedTo: prof.target, ceilingDbTP: prof.ceiling,
      bwf: { timeReference: tr, startTimecode: choice.tcs, fps: fpsOf(), sampleRate: sr, bitDepth: 24 },
      humanEdits: humanEdits(a, b), sources: sourcesIn(a, b), deliveredAt: new Date().toISOString(), deliveredBy: 'Mixtape Studio' };
    await writeFile(linkDir, 'deliveries/_final/mix.wav', mix.blob);
    for (const s of stems) await writeFile(linkDir, `deliveries/_final/${s.file}`, s.blob);
    await writeFile(linkDir, 'deliveries/_final/delivery.json', new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
    L.finalDelivered = { at: manifest.deliveredAt, lufs: judged, truePeak: loud.truePeakDb, profile: prof.name };
    const off = Math.abs(judged - prof.target) > prof.tol, wide = prof.lra && loud.lra > prof.lra;
    commit(`Final mix for ${prof.name}: ${judged} LUFS${prof.dialogue ? ' on dialogue' : ''}, true peak ${loud.truePeakDb} dBTP, range ${loud.lra} LU.${off ? ` The limiter pulled it outside ±${prof.tol}: turn the loudest moments down and deliver again.` : ''}${wide ? ` The loudness range is over ${prof.lra} LU, which ${prof.name} will reject.` : ''}`);
  } catch (e) { toast('Could not deliver the final mix: ' + e.message, 6000); }
  finally { busy(null); }
}
/* Hit points you add go back to the production studio, so they survive the next package */
let hitWritten = null, hitTimer = null;
function hitPointsJSON() {
  const L = P.link; if (!L) return null;
  const off = cutOffset();
  const hitPoints = (P.markers || []).filter(m => m.src !== 'pkg').map(m => { const s = +(mT(m) - off).toFixed(3); return { label: m.label || 'Hit', seconds: s, timecode: tc(s) }; }).filter(h => h.seconds >= 0).sort((x, y) => x.seconds - y.seconds);
  return JSON.stringify({ format: 'mindcraft.hit-points/1', fps: fpsOf(), cutId: L.cutId, cutVersion: L.cutVersion, hitPoints }, null, 2);
}
function scheduleHitPoints() {
  if (!linkDir || !P.link) return;
  clearTimeout(hitTimer);
  hitTimer = setTimeout(async () => { const j = hitPointsJSON(); if (!j || j === hitWritten) return; try { await writeFile(linkDir, 'hitpoints.json', new Blob([j], { type: 'application/json' })); hitWritten = j; } catch (e) {} }, 800);
}
async function writeFile(dir, path, blob) {
  const parts = path.split('/'), name = parts.pop(); let d = dir;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(name, { create: true }), w = await fh.createWritable(); await w.write(blob); await w.close();
}
async function deliverCue(ref) {
  const L = P.link, cue = L && L.cues.find(c => c.ref === ref); if (!cue) return;
  if (!P.clips.some(c => !c.mute)) return toast('There is no music on the timeline to deliver yet.');
  const { a, b } = cueRange(cue), folder = `deliveries/${safeName(cue.ref)}`, dl = dialogueLane();
  const lanes = P.lanes.filter(l => P.clips.some(c => c.lane === l.id && !c.mute && c.at < b && c.at + dur(c) > a));
  const sr = ctx.sampleRate, tcs = startTC(), tr = Math.round(((tcToSec(tcs) || 0) + cue.startSec) * sr);
  const wav = name => ({ bits: 24, bext: { timeReference: tr, description: `${cue.ref} ${cue.title} ${name}`, originatorRef: cue.ref } });
  pause();
  try {
    busy(`Delivering ${cue.ref}: mixing…`, { progress: 0 });
    // not limited and not normalised: the re-recording mixer sets the level in the final mix
    const mix = await renderMix({ from: a, to: b, noLimit: true, wav: wav('mix') }), loud = measureLoudness(mix.buffer);
    // if the file was turned down to stop it clipping, state the loudness of the file, not of the mix before it
    if (mix.scale !== 1) { const db = 20 * Math.log10(mix.scale); for (const k of ['lufs', 'peakDb', 'truePeakDb', 'maxMomentary', 'maxShortTerm']) if (Number.isFinite(loud[k])) loud[k] = r1(loud[k] + db); }
    const stems = []; let dlgBuf = null;
    for (const [i, l] of lanes.entries()) {
      busy(`Delivering ${cue.ref}: stem ${i + 1} of ${lanes.length} (${l.name})…`, { progress: (i + 1) / (lanes.length + 1) });
      const s = await renderMix({ from: a, to: b, lane: l.id, gainDb: mix.scale !== 1 ? 20 * Math.log10(mix.scale) : 0, noScale: true, wav: wav(l.name) });
      stems.push({ name: l.name, file: `stems/${safeName(l.name)}.wav`, blob: s.blob, lane: l.id }); if (dl && l.id === dl.id) dlgBuf = s.buffer;
    }
    const dg = dlgBuf ? dialogueGated(mix.buffer, dlgBuf) : null;
    const manifest = { format: 'mindcraft.cue-delivery/1', cueRef: cue.ref, title: cue.title, origin: cue.origin, production: L.production, cutId: L.cutId, cutVersion: L.cutVersion,
      startSec: cue.startSec, endSec: cue.endSec, durationSec: +(cue.endSec - cue.startSec).toFixed(3), sampleRate: sr,
      mix: 'mix.wav', stems: stems.map(s => ({ name: s.name, file: s.file })),
      loudness: { integratedLUFS: loud.lufs, samplePeakDbFS: loud.peakDb, truePeakDbTP: loud.truePeakDb, loudnessRangeLU: loud.lra, maxMomentaryLUFS: loud.maxMomentary, maxShortTermLUFS: loud.maxShortTerm,
        dialogueGatedLUFS: dg, dialogueStem: dlgBuf ? stems.find(s => s.lane === dl.id).file : null, method: 'ITU-R BS.1770-4 integrated, gated; true peak 4x oversampled; EBU Tech 3342 range' },
      bwf: { timeReference: tr, startTimecode: tcs, fps: fpsOf(), sampleRate: sr, bitDepth: 24 },
      humanEdits: humanEdits(a, b), sources: sourcesIn(a, b),
      tempo: P.bpm ? { startBpm: P.bpm, barOneAtSec: +((P.beat0 || 0) - cutOffset()).toFixed(3), changes: (P.tempoChanges || []).map(c => ({ atSec: +(c.t - cutOffset()).toFixed(3), bpm: c.bpm })) } : null,
      deliveredAt: new Date().toISOString(), deliveredBy: 'Mixtape Studio' };
    if (linkDir) {
      await writeFile(linkDir, `${folder}/mix.wav`, mix.blob);
      for (const s of stems) await writeFile(linkDir, `${folder}/${s.file}`, s.blob);
      await writeFile(linkDir, `${folder}/delivery.json`, new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
    } else {
      downloadBlob(mix.blob, `${safeName(cue.ref)} mix.wav`); for (const s of stems) downloadBlob(s.blob, `${safeName(cue.ref)} ${safeName(s.name)}.wav`);
      downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), `${safeName(cue.ref)} delivery.json`);
    }
    cue.delivered = (cue.delivered || 0) + 1; cue.stale = []; cue.lastLoudness = loud.lufs;
    commit(`Delivered ${cue.ref} with ${stems.length} stem${stems.length === 1 ? '' : 's'} at ${tc(tr / sr)}: ${loud.lufs} LUFS, peak ${loud.truePeakDb} dBTP, not limited${linkDir ? ' — written to the score folder' : ' — downloaded'}.`);
  } catch (e) { toast(`Could not deliver ${cue.ref}: ${e.message}`, 6000); }
  finally { busy(null); }
}
function linkSectionHTML() {
  const L = P.link;
  if (!L) return `<div class="sec"><h3>Production studio</h3><p class="hint">Link the score folder the production studio makes for a locked cut. Mixtape loads the picture, scenes, hit points and cue placements, watches for re-cuts, and delivers each cue’s mix and stems back into the folder.</p>
    <div class="btnrow"><button class="btn sm primary" data-act="linkfolder">Link a score folder</button>${(window.showDirectoryPicker && 'indexedDB' in window) ? '<button class="btn sm" data-act="relink">Reconnect last folder</button>' : ''}</div></div>`;
  const fmt = t => P.video ? tc(t) : fmtT(t);
  return `<div class="sec"><h3>Production studio</h3>
    <dl class="kv"><dt>Production</dt><dd>${esc((L.production && L.production.title) || '—')}</dd><dt>Cut</dt><dd>v${esc(L.cutVersion ?? '?')} · ${esc(L.stage || '')}${L.lockedAt ? ' · locked' : ''}</dd><dt>Folder</dt><dd>${esc(L.folder)}${linkDir ? '' : ' (not connected)'}</dd></dl>
    ${linkDir ? '' : '<div class="btnrow"><button class="btn sm primary" data-act="relink">Reconnect the folder</button></div>'}
    <p class="sub">Cues</p>
    ${L.cues.length ? `<div class="hits">${L.cues.map(c => `<div class="hit cuerow${c.stale && c.stale.length ? ' stale' : ''}" data-cue="${esc(c.ref)}" title="${esc(c.notes || '')}">
      <span class="tc" data-cuego title="Loop this cue">${esc(c.ref)}</span><span class="cuetitle">${esc(c.title)} · ${fmt(c.startSec)}–${fmt(c.endSec)}${c.stale && c.stale.length ? `<b>Picture moved: ${esc(c.stale.join('; '))}</b>` : c.delivered ? `<em>Delivered${c.lastLoudness != null ? ' · ' + c.lastLoudness + ' LUFS' : ''}</em>` : ''}</span>
      ${(L.takes && L.takes[c.ref] || []).length ? `<button data-cuetakes title="Music the production studio generated for this cue">♪${L.takes[c.ref].length}</button>` : ''}<button data-cuego title="Loop this cue">⟲</button><button data-cuedeliver title="Deliver this cue: mix, stems and loudness into the folder">⇪</button></div>`).join('')}</div>` : '<p class="hint">The package has no cue placements yet.</p>'}
    <div class="field"><label for="lProf">Delivers to</label><select id="lProf" data-linkset="profile">${Object.entries(PROFILES).map(([k, p]) => `<option value="${k}" ${k === profileId() ? 'selected' : ''}>${p.name}</option>`).join('')}</select><span></span></div>
    <div class="field"><label for="lTc">Starts at</label><input id="lTc" data-linkset="tc" value="${esc(startTC())}" style="font-family:var(--f-mono);height:28px;border-radius:6px;border:1px solid var(--line);background:var(--raise);padding:0 6px;width:100%"><span></span></div>
    ${L.rights && L.rights.forSale ? '<p class="hint">This film is marked for sale: only music models cleared for that can go into deliveries.</p>' : ''}
    ${L.finalDelivered ? `<p class="hint">Final mix delivered ${new Date(L.finalDelivered.at).toLocaleString()}${L.finalDelivered.profile ? ` for ${esc(L.finalDelivered.profile)}` : ''}: ${L.finalDelivered.lufs} LUFS, true peak ${L.finalDelivered.truePeak} dBTP.</p>` : ''}
    <div class="btnrow"><button class="btn sm primary" data-act="deliverfinal" ${linkDir ? '' : 'disabled'} title="The whole cut at −23 LUFS, true peak under −1 dBTP, with a file per track">Deliver final mix</button><button class="btn sm" data-act="syncnow">Check now</button><button class="btn sm" data-act="unlink">Unlink</button></div></div>`;
}
$('#insp').addEventListener('click', e => {
  const row = e.target.closest('[data-cue]'); if (!row || !P.link) return;
  const cue = P.link.cues.find(c => c.ref === row.dataset.cue); if (!cue) return;
  if (e.target.closest('[data-cuedeliver]')) return deliverCue(cue.ref);
  const tb = e.target.closest('[data-cuetakes]');
  if (tb) {
    const takes = (P.link.takes && P.link.takes[cue.ref]) || [], r = tb.getBoundingClientRect();
    const label = t => `${t.model}${t.instrumental ? ' · instrumental' : ''} · ${Math.round(t.seconds || 0)}s${t.terms && t.terms.commercial !== 'yes' ? ` · terms: ${t.terms.commercial}` : ''} — “${String(t.prompt || '').slice(0, 40)}”`;
    return openMenu(r.left, r.bottom + 4, takes.map(t => ({ label: label(t), act: () => placeTake(cue, t) })));
  }
  if (e.target.closest('[data-cuego]')) { const r = cueRange(cue); setLoop(r.a, r.b, `Looping ${cue.ref}`); seek(r.a); }
});
function drawCuesOnRuler(g, w) {
  if (!P.link) return;
  for (const c of P.link.cues) { const r = cueRange(c), x = r.a * pps, xe = r.b * pps; if (xe < 0 || x > w) continue; g.fillStyle = c.stale && c.stale.length ? '#FF5F5F' : '#2EC4B6'; g.fillRect(x, 27, Math.max(2, xe - x), 3); }
}

/* ---------- dialogs ---------- */
let modalResolve = null, modalRead = null; const mInput = $('#mInput');
function ask({ title, text = '', input = null, ok = 'OK', danger = false, extra = '', read = null }) {
  return new Promise(res => {
    $('#mTitle').textContent = title; $('#mText').textContent = text; $('#mText').hidden = !text;
    mInput.hidden = input === null; mInput.value = input || '';
    $('#mExtra').innerHTML = extra; modalRead = read;
    $('#mOk').textContent = ok; $('#mOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    $('#modal').hidden = false; modalResolve = res;
    setTimeout(() => { if (input === null) $('#mOk').focus(); else { mInput.focus(); mInput.select(); } }, 0);
  });
}
function closeModal(v) { $('#modal').hidden = true; $('#mExtra').innerHTML = ''; modalRead = null; const r = modalResolve; modalResolve = null; if (r) r(v); }
$('#modalForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = mInput.value.trim();
  if (!mInput.hidden && !v) return mInput.focus();
  if (modalRead) { const r = modalRead($('#mExtra')); if (r === undefined) return; return closeModal({ ...r, input: v }); }
  closeModal(mInput.hidden ? true : v);
});
function stemChoiceHTML() {
  return `<fieldset class="opts"><legend>Which parts</legend>
    ${Object.keys(STEMS).map(k => `<label><input type="checkbox" name="stem" value="${k}" checked> ${STEMS[k]}</label>`).join('')}</fieldset>
    <fieldset class="opts"><legend>The original part</legend>
    <label><input type="radio" name="orig" value="mute" checked> Keep it, muted, so you can compare</label>
    <label><input type="radio" name="orig" value="replace"> Replace it with the new tracks</label></fieldset>`;
}
function readStemChoice(f) {
  const stems = [...f.querySelectorAll('[name=stem]:checked')].map(x => x.value);
  if (!stems.length) { toast('Tick at least one part.'); return undefined; }
  return { stems, orig: f.querySelector('[name=orig]:checked').value };
}
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
  const gone = c => !['midi', 'pattern', 'riser'].includes(c.kind) && !libTrack(c.trackId); // instrument and drum machine parts have no song to lose
  const missing = P.clips.filter(gone);
  if (missing.length) { P.clips = P.clips.filter(c => !gone(c)); last = JSON.stringify(P); persist(); toast(`${missing.length} part${missing.length === 1 ? ' was' : 's were'} removed because the song is no longer in your library.`, 5000); }
  if (!P.clips.length && !P.video) UI.lib = true;
  if (P.video) { ensureVideoEl().then(() => { scrubVideo(playhead); makeThumbs(); }); }
  if (P.link) { try { const d = await linkStore('readonly', s => s.get('score')); if (d && (await d.queryPermission({ mode: 'readwrite' })) === 'granted') { linkDir = d; startWatch(); syncPackage(false); renderInspector(); } } catch (e) {} }
  $('.work').classList.toggle('nolib', !UI.lib); $('.work').classList.toggle('noinsp', !UI.insp);
  renderAll();
  for (const id of new Set(P.clips.map(c => c.trackId).filter(Boolean))) { try { await ensureBuf(id); renderLanes(); drawEditor(); } catch (e) {} }
  for (const c of P.clips) { try { await ensureProc(c); } catch (e) {} }
  const add = new URLSearchParams(location.search).get('add');
  if (add && libTrack(add)) { history.replaceState(null, '', location.pathname); await addRegion(add, 0, null, 'append'); }
  if (P.clips.length) fitZoom();
  setTimeout(() => startTour(false), 600);
})();
// Test hook: only on this computer (localhost), never on the published site
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__studio = {
  get projId() { return projId; }, normalize, runFind, revealHit, get findHits() { return findHits; }, textScale, set midiAccess(v) { midiAccess = v; }, get midiAccess() { return midiAccess; }, scheduleMidiOut, moutOf, SAMP, loadSamp, makeSampled, isSamp, sampReady, gmFor, sampAudition, instOptions, partScale, chordAt, chordName, nearestInScale, noteIn, pedal, ccIn, toggleRecNotes, get recNotes() { return recNotes; }, get monoOn() { return monoOn; }, set qwerty(v) { qwerty = v; }, checkMaster, limitToTarget, MASTER_PRESETS, ensureLofi, lofiOk, satLevel, dynGain, writeChords, get masterReport() { return masterReport; }, newDevice, addGroup, addReturn, laneAudible, findDev, get ORCH() { return ORCH; }, ensureOrch, isOrch, midiEvents, newRiser, getHall, newDrumMachine, schedulePatterns, get graph() { return graph; }, HAS_TONE, makeKit, toneFor, togglePin, closeGaps: id => closeGaps(id), removeStretch, splitHere, prevZoom, setAmp, loadDemo, restoreWhole, get navAt() { return navAt; }, get pps() { return pps; }, zoom, zoomToSelection, edZoom, edFit, get edWin() { return edWin; }, drawOverview, refreshTakes, solveTempo, findTempo, beatAt, timeAtBeat, dialogueGated, tcToSec, humanEdits, PROFILES, deliverCue, deliverFinal, get linkDir() { return linkDir; }, loadIndex, openProject, newMix, importMidi, exportMidi, newInstrumentTrack, quantize, drawEditor, renderInspector,
  get edNote() { return edNote; }, set selClip(v) { selClip = v; }, set edOpen(v) { edOpen = v; },
  get P() { return P; }, set P(v) { P = v; },
  commit, renderMix, duckUnder, newLane, newClip, saveToLibrary, encodeWavData, uid, measureLoudness, renderAll,
};
})();
