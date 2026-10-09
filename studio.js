(() => {
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtT = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const hueOf = str => { let h = 0; for (const c of String(str || '')) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };

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

/* ---------- audio ---------- */
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const bufs = new Map();
const loading = new Map();
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
      const ab = await t.blob.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);
      const e = { buffer, peaks: computePeaks(buffer) }; bufs.set(trackId, e); return e;
    } catch (err) { throw new Error(`Couldn't open “${t.title}”. The file may be damaged or in a format this browser can't edit.`); }
    finally { busy(null); loading.delete(trackId); }
  })();
  loading.set(trackId, p); return p;
}

/* ---------- project ---------- */
const LSP = 'mixtape-studio-project-v1';
const newLane = n => ({ id: uid(), name: `Layer ${n}`, gain: 1, pan: 0, mute: false, solo: false });
const newProject = () => ({ name: 'My mix', lanes: [newLane(1)], clips: [], xfade: 0.5 });
let P; try { P = JSON.parse(localStorage.getItem(LSP)) || newProject(); } catch (e) { P = newProject(); }
if (!P.lanes || !P.lanes.length) P = newProject();
let selClip = null, selLane = P.lanes[0].id, playhead = 0, pps = 24, edSel = null;
let hist = [], fut = [], last = JSON.stringify(P);
const persist = () => { try { localStorage.setItem(LSP, last); } catch (e) {} };
const clipById = id => P.clips.find(c => c.id === id);
const dur = c => c.end - c.start;
const projectEnd = () => P.clips.reduce((m, c) => Math.max(m, c.at + dur(c)), 0);
const laneClips = id => P.clips.filter(c => c.lane === id).sort((a, b) => a.at - b.at);
const laneLast = id => laneClips(id).reduce((m, c) => (!m || c.at + dur(c) > m.at + dur(m) ? c : m), null);
function fixFades(c) { const d = dur(c); c.fadeIn = clamp(c.fadeIn || 0, 0, d); c.fadeOut = clamp(c.fadeOut || 0, 0, d - c.fadeIn); }
function fixSel() {
  if (selClip && !clipById(selClip)) selClip = null;
  if (!P.lanes.some(l => l.id === selLane)) selLane = P.lanes[0] ? P.lanes[0].id : null;
}
function commit(msg) {
  P.clips.forEach(fixFades);
  const s = JSON.stringify(P); if (s === last) { renderAll(); return; }
  hist.push(last); if (hist.length > 150) hist.shift(); fut = []; last = s; persist();
  fixSel(); renderAll(); restartIfPlaying(); if (msg) toast(msg);
}
function undo() { if (!hist.length) return; fut.push(last); last = hist.pop(); P = JSON.parse(last); fixSel(); persist(); renderAll(); restartIfPlaying(); toast('Undone'); }
function redo() { if (!fut.length) return; hist.push(last); last = fut.pop(); P = JSON.parse(last); fixSel(); persist(); renderAll(); restartIfPlaying(); toast('Redone'); }
function ripple(laneId, from, shift, skip = []) {
  for (const c of P.clips) if (c.lane === laneId && !skip.includes(c.id) && c.at >= from - 1e-3) c.at = Math.max(0, c.at + shift);
}

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
  const c = { id: uid(), trackId, lane: laneId, at, start: a, end: b, gain: 1, fadeIn: xf, fadeOut: 0 };
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
  const a = Math.max(edSel.a, c.start), b = Math.min(edSel.b, c.end);
  if (b - a < 0.05) return toast('Select a section inside the highlighted part first.');
  const origEnd = c.at + dur(c), cut = b - a;
  if (a <= c.start + 0.02 && b >= c.end - 0.02) { P.clips = P.clips.filter(x => x !== c); ripple(c.lane, origEnd, -cut); selClip = null; }
  else if (a <= c.start + 0.02) { c.start = b; ripple(c.lane, origEnd, -cut, [c.id]); }
  else if (b >= c.end - 0.02) { c.end = a; ripple(c.lane, origEnd, -cut, [c.id]); }
  else {
    const xf = Math.min(P.xfade, (a - c.start) / 2, (c.end - b) / 2);
    const c2 = { ...c, id: uid(), start: b, at: c.at + (a - c.start) - xf, fadeIn: xf };
    c.end = a; c.fadeOut = xf; P.clips.push(c2);
    ripple(c.lane, origEnd, -(cut + xf), [c.id, c2.id]);
  }
  edSel = null; commit('Removed. The gap closes up with a smooth fade.');
}
function splitAtPlayhead() {
  const c = clipById(selClip) || P.clips.find(x => x.lane === selLane && playhead > x.at && playhead < x.at + dur(x));
  if (!c) return toast('Put the red playhead over a part to split it.');
  const t = playhead - c.at;
  if (t <= 0.05 || t >= dur(c) - 0.05) return toast('Move the playhead inside the part to split it.');
  const c2 = { ...c, id: uid(), start: c.start + t, at: playhead, fadeIn: 0 };
  c.end = c.start + t; c.fadeOut = 0; P.clips.push(c2); selClip = c2.id; commit('Split in two');
}
function loopClip(n) {
  const c = clipById(selClip); if (!c) return;
  const d = dur(c), after = c.at + d, edge = Math.min(0.01, d / 4), lastFade = c.fadeOut;
  ripple(c.lane, after, (n - 1) * d, [c.id]);
  c.fadeOut = edge;
  for (let k = 1; k < n; k++) P.clips.push({ ...c, id: uid(), at: c.at + k * d, fadeIn: edge, fadeOut: k === n - 1 ? lastFade : edge });
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

/* ---------- playback ---------- */
let playing = false, pos0 = 0, t0 = 0, graph = null, preview = null, tickT = null;
const laneAudible = l => !l.mute && (!P.lanes.some(x => x.solo) || l.solo);
function envelope(param, c, startPos, when0) {
  const d = dur(c), fi = c.fadeIn || 0, fo = c.fadeOut || 0, g = c.gain ?? 1;
  const v = u => g * Math.min(1, fi > 0 ? u / fi : 1, fo > 0 ? (d - u) / fo : 1);
  const T = u => when0 + (c.at + u - startPos);
  const u0 = Math.max(0, startPos - c.at);
  param.setValueAtTime(Math.max(0, v(u0)), Math.max(when0, T(u0)));
  if (fi > 0 && u0 < fi) param.linearRampToValueAtTime(v(fi), T(fi));
  if (fo > 0) {
    if (u0 < d - fo) param.setValueAtTime(v(d - fo), T(d - fo));
    param.linearRampToValueAtTime(0, T(d));
  }
}
function buildGraph(ac, startPos, when0) {
  const master = ac.createGain(); master.connect(ac.destination);
  const lanes = new Map();
  for (const l of P.lanes) {
    const g = ac.createGain(); g.gain.value = laneAudible(l) ? l.gain : 0;
    const p = ac.createStereoPanner(); p.pan.value = l.pan; g.connect(p); p.connect(master);
    lanes.set(l.id, { g, p });
  }
  const srcs = [];
  for (const c of P.clips) {
    const e = bufs.get(c.trackId), ln = lanes.get(c.lane); if (!e || !ln) continue;
    const d = dur(c); if (c.at + d <= startPos) continue;
    const off = Math.max(0, startPos - c.at), when = when0 + Math.max(0, c.at - startPos);
    const s = ac.createBufferSource(); s.buffer = e.buffer;
    const g = ac.createGain(); s.connect(g); g.connect(ln.g);
    envelope(g.gain, c, startPos, when0);
    s.start(when, c.start + off, d - off); srcs.push(s);
  }
  return { master, lanes, srcs };
}
async function ensureAll() { for (const id of new Set(P.clips.map(c => c.trackId))) await ensureBuf(id); }
async function play() {
  stopPreview();
  if (!P.clips.length) return toast('Add a song from the left to start.');
  try { await ensureAll(); } catch (err) { return toast(err.message, 5000); }
  await ctx.resume();
  if (playhead >= projectEnd() - 0.02) playhead = 0;
  pos0 = playhead; t0 = ctx.currentTime + 0.05;
  graph = buildGraph(ctx, pos0, t0); playing = true; renderTransport(); clearInterval(tickT); tickT = setInterval(tick, 33);
}
function pause() {
  if (!playing) return;
  playhead = curPos(); playing = false; clearInterval(tickT);
  graph.srcs.forEach(s => { try { s.stop(); } catch (e) {} }); try { graph.master.disconnect(); } catch (e) {}
  graph = null; renderTransport(); drawPlayhead();
}
const curPos = () => playing ? pos0 + Math.max(0, ctx.currentTime - t0) : playhead;
function restartIfPlaying() { if (playing) { pause(); play(); } }
function tick() {
  if (!playing) return clearInterval(tickT);
  const p = curPos();
  if (p >= projectEnd()) { pause(); playhead = projectEnd(); drawPlayhead(); return; }
  drawPlayhead(p); followPlayhead(p);
}
function liveLanes() { if (!graph) return; for (const l of P.lanes) { const n = graph.lanes.get(l.id); if (n) { n.g.gain.setTargetAtTime(laneAudible(l) ? l.gain : 0, ctx.currentTime, 0.02); n.p.pan.setTargetAtTime(l.pan, ctx.currentTime, 0.02); } } }
function seek(t) { playhead = clamp(t, 0, Math.max(projectEnd(), 0)); if (playing) { pause(); play(); } else drawPlayhead(); }
async function previewSel() {
  if (preview) return stopPreview();
  const c = clipById(selClip); if (!c) return;
  const e = bufs.get(c.trackId); if (!e) return;
  const a = edSel ? edSel.a : c.start, b = edSel ? edSel.b : c.end;
  pause(); await ctx.resume();
  const s = ctx.createBufferSource(); s.buffer = e.buffer; s.connect(ctx.destination);
  const st = ctx.currentTime + 0.03; s.start(st, a, b - a);
  preview = { s, a, b, st }; s.onended = () => { if (preview && preview.s === s) stopPreview(); };
  $('[data-act="prevsel"]').textContent = 'Stop'; requestAnimationFrame(drawEditor);
}
function stopPreview() { if (!preview) return; try { preview.s.stop(); } catch (e) {} preview = null; const b = $('[data-act="prevsel"]'); if (b) b.textContent = edSel ? 'Play selection' : 'Play part'; drawEditor(); }

/* ---------- saving the mix as a song ---------- */
function encodeWav(buf, scale) {
  const ch = Math.min(2, buf.numberOfChannels), n = buf.length, sr = buf.sampleRate;
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
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
  const end = projectEnd(), sr = ctx.sampleRate;
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(end * sr)), sr);
  buildGraph(oc, 0, 0);
  const out = await oc.startRendering();
  let peak = 0; for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
  return { blob: encodeWav(out, peak > 0.98 ? 0.98 / peak : 1), duration: end };
}
async function saveSong() {
  if (!P.clips.length) return toast('There is nothing to save yet. Add a song first.');
  const name = await ask({ title: 'Save as a song', text: 'Your mix is added to your library as a new song. The original songs stay as they are.', input: P.name || 'My mix', ok: 'Save song' });
  if (!name) return;
  pause(); busy('Mixing your song…');
  try {
    const { blob, duration } = await renderMix();
    const t = { id: uid(), name: name + '.wav', size: blob.size, type: 'audio/wav', title: name, artist: 'My mixes', album: 'Mixtape Studio',
      track: 0, duration, added: Date.now(), blob, art: null };
    await req('tracks', 'readwrite', o => o.put(t));
    try { new BroadcastChannel('mixtape').postMessage({ type: 'library' }); } catch (e) {}
    await loadLibrary(); renderLibrary();
    toast(`Saved “${name}” to your library (${(blob.size / 1048576).toFixed(1)} MB).`, 4500);
  } catch (err) { toast(`Couldn't save the mix: ${err.message || 'your browser may be out of storage space'}.`, 6000); }
  finally { busy(null); }
}

/* ---------- drawing ---------- */
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
function waveColor(h, alpha = 1) { return `hsl(${h} 45% ${css('--wave-l')} / ${alpha})`; }
function drawWave(g, e, ta, tb, x0, w, h, color) {
  const { min, max, rate } = e.peaks, mid = h / 2; g.fillStyle = color;
  const span = tb - ta;
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((ta + span * x / w) * rate), i1 = Math.max(i0 + 1, Math.ceil((ta + span * (x + 1) / w) * rate));
    let lo = 0, hi = 0; for (let i = Math.max(0, i0); i < Math.min(min.length, i1); i++) { if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i]; }
    const y = mid - hi * mid * 0.92, hh = Math.max(1, (hi - lo) * mid * 0.92); g.fillRect(x0 + x, y, 1, hh);
  }
}
function drawClipCanvas(cv, c) {
  const e = bufs.get(c.trackId), r = dpr();
  const wCss = Math.max(1, dur(c) * pps), hCss = cv.parentElement.clientHeight || 80;
  const w = Math.min(16000, Math.round(wCss * r)), h = Math.round(hCss * r);
  cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
  if (!e) return;
  const hue = hueOf(c.trackId);
  drawWave(g, e, c.start, c.end, 0, w, h, waveColor(hue, .9));
  // fades drawn as shaded corners
  g.fillStyle = css('--bg'); g.globalAlpha = .55;
  const fi = (c.fadeIn || 0) / dur(c) * w, fo = (c.fadeOut || 0) / dur(c) * w;
  if (fi > 1) { g.beginPath(); g.moveTo(0, 0); g.lineTo(fi, 0); g.lineTo(0, h); g.closePath(); g.fill(); }
  if (fo > 1) { g.beginPath(); g.moveTo(w, 0); g.lineTo(w - fo, 0); g.lineTo(w, h); g.closePath(); g.fill(); }
  g.globalAlpha = 1;
}

/* timeline */
const headW = () => parseFloat(css('--head-w')) || 200;
function timelineWidth() { return Math.max($('#tl').clientWidth - headW(), (projectEnd() + 30) * pps); }
function renderLanes() {
  const anySolo = P.lanes.some(l => l.solo);
  $('#lanes').innerHTML = P.lanes.map(l => `
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
      </div>
      <div class="lane-body" style="width:${timelineWidth()}px;${anySolo && !l.solo || l.mute ? 'opacity:.45' : ''}">
        ${P.clips.filter(c => c.lane === l.id).map(c => {
          const t = libTrack(c.trackId);
          return `<div class="clip${c.id === selClip ? ' sel' : ''}" data-clip="${c.id}" style="left:${c.at * pps}px;width:${Math.max(4, dur(c) * pps)}px;--h:${hueOf(c.trackId)}" title="${esc(t ? t.title : 'Missing song')} · ${fmtT(dur(c))}">
            <canvas></canvas><span class="cl">${esc(t ? t.title : 'Missing song')}</span><span class="h l" data-h="l"></span><span class="h r" data-h="r"></span></div>`;
        }).join('')}
      </div>
    </div>`).join('');
  $('#tlInner').style.width = (headW() + timelineWidth()) + 'px';
  $$('.clip').forEach(el => drawClipCanvas(el.querySelector('canvas'), clipById(el.dataset.clip)));
  renderRuler(); drawPlayhead();
}
function renderRuler() {
  const cv = $('#ruler'), r = dpr(), w = timelineWidth(), h = 28;
  cv.style.width = w + 'px'; cv.width = Math.min(32000, Math.round(w * r)); cv.height = h * r;
  const g = cv.getContext('2d'); g.setTransform(cv.width / w, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120]; const step = steps.find(s => s * pps >= 64) || 300;
  g.fillStyle = css('--muted'); g.strokeStyle = css('--line'); g.font = `11px ${css('--f-mono')}`; g.textBaseline = 'middle';
  for (let t = 0; t * pps < w; t += step) {
    const x = Math.round(t * pps) + .5; g.beginPath(); g.moveTo(x, 16); g.lineTo(x, h); g.stroke();
    const m = Math.floor(t / 60), s = t % 60; g.fillText(`${m}:${String(Math.floor(s)).padStart(2, '0')}${step < 1 && s % 1 ? '.5' : ''}`, x + 4, 9);
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

/* part editor */
let edView = null;
function drawEditor() {
  const c = clipById(selClip), cv = $('#edCanvas'), wrap = $('#edWrap');
  $('#edEmpty').hidden = !!c;
  const acts = ['keep', 'remove', 'selappend', 'sellayer'];
  acts.forEach(a => { const b = $(`[data-act="${a}"]`); if (b) b.disabled = !c || !edSel; });
  $('[data-act="selall"]').disabled = $('[data-act="prevsel"]').disabled = !c;
  if (!preview) $('[data-act="prevsel"]').textContent = edSel ? 'Play selection' : 'Play part';
  const r = dpr(), w = wrap.clientWidth, h = wrap.clientHeight;
  cv.width = Math.round(w * r); cv.height = Math.round(h * r);
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  if (!c) { $('#edTitle').textContent = 'Part editor'; $('#edInfo').textContent = ''; $('#selInfo').textContent = 'No part selected'; edView = null; return; }
  const t = libTrack(c.trackId), e = bufs.get(c.trackId);
  $('#edTitle').textContent = t ? t.title : 'Missing song';
  $('#edInfo').textContent = `part ${fmtT(c.start)}–${fmtT(c.end)} of ${e ? fmtT(e.buffer.duration) : '?'} · ${fmtT(dur(c))} long`;
  $('#selInfo').textContent = edSel ? `Selected ${fmtT(edSel.a)}–${fmtT(edSel.b)} (${(edSel.b - edSel.a).toFixed(1)}s)` : 'Drag across the waveform to select';
  if (!e) return;
  const D = e.buffer.duration; edView = { D, w };
  const X = s => s / D * w, hue = hueOf(c.trackId);
  g.fillStyle = waveColor(hue, .12); g.fillRect(X(c.start), 0, X(c.end) - X(c.start), h);
  drawWave(g, e, 0, D, 0, w, h, waveColor(hue, .35));
  g.save(); g.beginPath(); g.rect(X(c.start), 0, X(c.end) - X(c.start), h); g.clip(); drawWave(g, e, 0, D, 0, w, h, waveColor(hue, 1)); g.restore();
  g.fillStyle = css('--accent'); g.fillRect(X(c.start) - 1, 0, 2, h); g.fillRect(X(c.end) - 1, 0, 2, h);
  if (edSel) { g.fillStyle = css('--sel'); g.fillRect(X(edSel.a), 0, X(edSel.b) - X(edSel.a), h); g.fillStyle = css('--ink'); g.fillRect(X(edSel.a), 0, 1, h); g.fillRect(X(edSel.b), 0, 1, h); }
  if (preview) { const p = preview.a + (ctx.currentTime - preview.st); g.fillStyle = css('--danger'); g.fillRect(X(clamp(p, preview.a, preview.b)), 0, 2, h); requestAnimationFrame(drawEditor); }
  else if (playing || playhead) { const p = curPos() - c.at; if (p >= 0 && p <= dur(c)) { g.fillStyle = css('--danger'); g.fillRect(X(c.start + p), 0, 2, h); } }
}

/* inspector */
function renderInspector() {
  const c = clipById(selClip), l = P.lanes.find(x => x.id === selLane);
  let html = '';
  if (c) {
    const t = libTrack(c.trackId), d = dur(c);
    html += `<div class="sec"><h3>Selected part</h3>
      <dl class="kv"><dt>Song</dt><dd>${esc(t ? t.title : 'Missing song')}</dd><dt>Starts at</dt><dd>${fmtT(c.at)}</dd><dt>Length</dt><dd>${fmtT(d)}</dd></dl>
      <div class="field"><label for="cGain">Volume</label><input id="cGain" type="range" min="0" max="200" value="${Math.round((c.gain ?? 1) * 100)}" data-cf="gain"><output>${Math.round((c.gain ?? 1) * 100)}%</output></div>
      <div class="field"><label for="cFi">Fade in</label><input id="cFi" type="range" min="0" max="${Math.min(10, d).toFixed(1)}" step="0.1" value="${(c.fadeIn || 0).toFixed(1)}" data-cf="fadeIn"><output>${(c.fadeIn || 0).toFixed(1)}s</output></div>
      <div class="field"><label for="cFo">Fade out</label><input id="cFo" type="range" min="0" max="${Math.min(10, d).toFixed(1)}" step="0.1" value="${(c.fadeOut || 0).toFixed(1)}" data-cf="fadeOut"><output>${(c.fadeOut || 0).toFixed(1)}s</output></div>
      <div class="btnrow"><button class="btn sm" data-act="split">Split at playhead</button><button class="btn sm" data-act="dup">Copy after</button><button class="btn sm" data-act="del">Delete part</button></div>
      <div class="btnrow"><span class="hint" style="align-self:center">Repeat this part</span><button class="btn sm" data-act="loop" data-n="2">×2</button><button class="btn sm" data-act="loop" data-n="4">×4</button><button class="btn sm" data-act="loop" data-n="8">×8</button></div>
    </div>`;
  } else {
    html += `<div class="sec"><h3>Selected part</h3><p class="hint">Click a part on the timeline to change its volume and fades, split it, or repeat it.</p></div>`;
  }
  if (l) html += `<div class="sec"><h3>Layer: ${esc(l.name)}</h3><p class="hint">New songs you add with “+ End” join the end of this layer.</p>
      <div class="btnrow"><button class="btn sm" data-act="closegaps">Close gaps</button></div></div>`;
  html += `<div class="sec"><h3>Joins</h3>
      <div class="field"><label for="xf">Fade length</label><input id="xf" type="range" min="0" max="4" step="0.1" value="${P.xfade}" data-pf="xfade"><output>${P.xfade.toFixed(1)}s</output></div>
      <p class="hint">When you join two parts or remove a section, they blend over this many seconds so the change doesn't sound abrupt. Set it to 0 for a hard cut.</p></div>
    <div class="sec"><h3>Keys</h3><div class="keys"><kbd>Space</kbd> play/pause · <kbd>Home</kbd> start<br><kbd>S</kbd> split · <kbd>Del</kbd> delete part<br><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Y</kbd> redo<br><kbd>+</kbd>/<kbd>−</kbd> zoom · <kbd>Ctrl</kbd>+wheel zoom</div></div>`;
  $('#insp').innerHTML = html;
}
function renderLibrary() {
  const q = $('#libQ').value.trim().toLowerCase();
  const list = lib.filter(t => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
  $('#lib').innerHTML = list.length ? list.map(t => `<li><div style="min-width:0"><b title="${esc(t.title)}">${esc(t.title)}</b><span>${esc(t.artist || 'Unknown artist')} · ${fmtT(t.duration).replace(/\.\d$/, '')}</span></div>
      <div class="acts"><button data-add="append" data-id="${t.id}" title="Add to the end of the selected layer">+ End</button><button data-add="layer" data-id="${t.id}" title="Add as a new layer at the playhead">+ Layer</button></div></li>`).join('')
    : `<li class="empty-note">${lib.length ? 'No songs match.' : 'Your library is empty. Add songs in the player first.'}</li>`;
}
function renderTransport() {
  $('#playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#undoBtn').disabled = !hist.length; $('#redoBtn').disabled = !fut.length;
  $('#saveBtn').disabled = !P.clips.length;
}
function renderAll() { $('#projName').value = P.name; renderLanes(); drawEditor(); renderInspector(); renderTransport(); }

/* ---------- interaction ---------- */
const acts = {
  play: () => playing ? pause() : play(), stop: () => { pause(); seek(0); $('#tl').scrollLeft = 0; },
  undo, redo, save: saveSong,
  zin: () => zoom(1.5), zout: () => zoom(1 / 1.5), fit: fitZoom,
  addlane: () => { const l = newLane(P.lanes.length + 1); P.lanes.push(l); selLane = l.id; commit('Layer added'); },
  selall: () => { const c = clipById(selClip); if (c) { edSel = { a: c.start, b: c.end }; drawEditor(); } },
  prevsel: previewSel, keep: keepSel, remove: removeSel,
  selappend: () => { const c = clipById(selClip); if (c && edSel) addRegion(c.trackId, edSel.a, edSel.b, 'append'); },
  sellayer: () => { const c = clipById(selClip); if (c && edSel) addRegion(c.trackId, edSel.a, edSel.b, 'layer'); },
  split: splitAtPlayhead, dup: dupClip, del: deleteClip, loop: b => loopClip(+b.dataset.n),
  closegaps: () => selLane && closeGaps(selLane),
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

/* ruler seek */
$('#ruler').addEventListener('pointerdown', e => {
  const cv = e.currentTarget; try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const at = ev => (ev.clientX - cv.getBoundingClientRect().left) / pps;
  seek(at(e)); const mv = ev => { playhead = clamp(at(ev), 0, projectEnd()); drawPlayhead(); drawEditor(); };
  cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', () => { cv.removeEventListener('pointermove', mv); seek(playhead); }, { once: true });
});

/* lane header controls */
$('#lanes').addEventListener('input', e => {
  const f = e.target.dataset.lf; if (!f) return; const l = P.lanes.find(x => x.id === e.target.closest('.lane').dataset.lane);
  if (f === 'gain') { l.gain = e.target.value / 100; e.target.nextElementSibling.textContent = e.target.value + '%'; liveLanes(); }
  if (f === 'pan') { l.pan = e.target.value / 100; const v = Math.round(l.pan * 100); e.target.nextElementSibling.textContent = v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(v); liveLanes(); }
});
$('#lanes').addEventListener('change', e => {
  const f = e.target.dataset.lf; if (!f) return; const l = P.lanes.find(x => x.id === e.target.closest('.lane').dataset.lane);
  if (f === 'name') l.name = e.target.value.trim() || l.name;
  const s = JSON.stringify(P); if (s !== last) { hist.push(last); fut = []; last = s; persist(); renderTransport(); renderInspector(); }
});
$('#lanes').addEventListener('click', e => {
  const b = e.target.closest('[data-lf]'); const laneEl = e.target.closest('.lane'); if (!laneEl) return;
  const l = P.lanes.find(x => x.id === laneEl.dataset.lane);
  if (b && b.tagName === 'BUTTON') {
    if (b.dataset.lf === 'mute') { l.mute = !l.mute; commit(); liveLanes(); }
    else if (b.dataset.lf === 'solo') { l.solo = !l.solo; commit(); liveLanes(); }
    else if (b.dataset.lf === 'del') deleteLane(l.id);
    return;
  }
  if (selLane !== l.id && !e.target.closest('.clip')) { selLane = l.id; renderLanes(); renderInspector(); }
});

/* dragging parts: move, change layer, trim edges */
$('#lanes').addEventListener('pointerdown', e => {
  const body = e.target.closest('.lane-body'); if (!body || e.button !== 0) return;
  const el = e.target.closest('.clip');
  if (!el) { // click empty space: move playhead, pick layer
    const t = (e.clientX - body.getBoundingClientRect().left) / pps; selLane = body.parentElement.dataset.lane; selClip = null; edSel = null;
    seek(clamp(t, 0, projectEnd())); renderLanes(); drawEditor(); renderInspector(); return;
  }
  const c = clipById(el.dataset.clip); if (!c) return;
  const mode = e.target.dataset.h || 'move';
  if (selClip !== c.id) { selClip = c.id; edSel = null; }
  selLane = c.lane;
  $$('.clip.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
  $$('.lane.on').forEach(x => x.classList.remove('on')); el.closest('.lane').classList.add('on');
  ensureBuf(c.trackId).then(() => { drawEditor(); }).catch(err => toast(err.message, 5000));
  drawEditor(); renderInspector();
  try { el.setPointerCapture(e.pointerId); } catch (_) {} el.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
  const x0 = e.clientX, o = { at: c.at, start: c.start, end: c.end, lane: c.lane }, srcDur = bufs.get(c.trackId)?.buffer.duration ?? c.end;
  const edges = P.clips.filter(x => x !== c).flatMap(x => [x.at, x.at + dur(x)]).concat([0, playhead]);
  const snap = t => { for (const s of edges) if (Math.abs(s - t) * pps < 8) return s; return t; };
  let moved = false;
  const mv = ev => {
    const dt = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return;
    if (mode === 'move') {
      let at = Math.max(0, o.at + dt); const sEnd = snap(at + dur(c)); at = snap(at) !== at ? snap(at) : sEnd !== at + dur(c) ? sEnd - dur(c) : at;
      c.at = Math.max(0, at);
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane');
      if (under && under.dataset.lane !== c.lane) { c.lane = under.dataset.lane; under.querySelector('.lane-body').appendChild(el); }
      el.style.left = c.at * pps + 'px';
    } else if (mode === 'l') {
      const ns = clamp(o.start + dt, 0, o.end - 0.1); c.start = ns; c.at = Math.max(0, o.at + (ns - o.start));
      if (o.at + (ns - o.start) < 0) { c.start = o.start - o.at; c.at = 0; }
      el.style.left = c.at * pps + 'px'; el.style.width = dur(c) * pps + 'px';
    } else {
      c.end = clamp(o.end + dt, o.start + 0.1, srcDur); el.style.width = dur(c) * pps + 'px';
    }
  };
  el.addEventListener('pointermove', mv);
  el.addEventListener('pointerup', () => {
    el.removeEventListener('pointermove', mv); el.style.cursor = '';
    if (moved) { selLane = c.lane; commit(); } else { renderLanes(); }
  }, { once: true });
});

/* selecting inside the part editor */
$('#edWrap').addEventListener('pointerdown', e => {
  const c = clipById(selClip); if (!c || !edView) return;
  const wrap = e.currentTarget; try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  const tAt = ev => clamp((ev.clientX - wrap.getBoundingClientRect().left) / edView.w * edView.D, 0, edView.D);
  const a0 = tAt(e); stopPreview();
  const mv = ev => { const b = tAt(ev); edSel = { a: Math.min(a0, b), b: Math.max(a0, b) }; drawEditor(); };
  wrap.addEventListener('pointermove', mv);
  wrap.addEventListener('pointerup', () => { wrap.removeEventListener('pointermove', mv); if (edSel && edSel.b - edSel.a < 0.05) edSel = null; drawEditor(); }, { once: true });
});

/* part settings */
$('#insp').addEventListener('input', e => {
  const c = clipById(selClip), f = e.target.dataset.cf, pf = e.target.dataset.pf, out = e.target.nextElementSibling;
  if (pf === 'xfade') { P.xfade = +e.target.value; out.textContent = P.xfade.toFixed(1) + 's'; return; }
  if (!c || !f) return;
  if (f === 'gain') { c.gain = e.target.value / 100; out.textContent = e.target.value + '%'; }
  else { c[f] = +e.target.value; fixFades(c); out.textContent = c[f].toFixed(1) + 's'; const el = $(`.clip[data-clip="${c.id}"] canvas`); if (el) drawClipCanvas(el, c); }
});
$('#insp').addEventListener('change', e => { if (e.target.dataset.cf || e.target.dataset.pf) commit(); });

/* keyboard */
document.addEventListener('keydown', e => {
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(null); return; }
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (k === ' ') { e.preventDefault(); playing ? pause() : play(); }
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
function busy(m) { $('#busy').hidden = !m; if (m) $('#busyText').textContent = m; }

/* ---------- boot ---------- */
(async () => {
  try { db = await idbOpen(); } catch (e) { toast('This browser is blocking storage, so the Studio cannot read your songs.', 8000); }
  await loadLibrary(); renderLibrary();
  const missing = P.clips.filter(c => !libTrack(c.trackId));
  if (missing.length) { P.clips = P.clips.filter(c => libTrack(c.trackId)); last = JSON.stringify(P); persist(); toast(`${missing.length} part${missing.length === 1 ? ' was' : 's were'} removed because the song is no longer in your library.`, 5000); }
  renderAll();
  for (const id of new Set(P.clips.map(c => c.trackId))) { try { await ensureBuf(id); renderLanes(); drawEditor(); } catch (e) {} }
  const add = new URLSearchParams(location.search).get('add');
  if (add && libTrack(add)) { history.replaceState(null, '', location.pathname); await addRegion(add, 0, null, 'append'); }
  if (P.clips.length) fitZoom();
})();
})();
