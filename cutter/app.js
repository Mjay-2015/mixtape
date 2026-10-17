/* Cutter's interface. The model (model.js) holds the rules; the engine (engine.js) touches the media; this file is the
   room: files, parts, the timeline, playback, splitting and export. */
import * as C from './model.js';
import { Media, Player, writeCut, writableTargets, sameTracks, isMediaFile } from './engine.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
let toastT = 0; function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }

/* ---------- state ---------- */
const files = [];            // { id, media, state, error, parts, undo, redo, peaks, detail, keys }
let cur = null, sel = null, ph = 0, view = { t0: 0, t1: 1 };
const S = Object.assign({ mode: 'keep', out: 'each', prec: 'exact', tracks: 'both', fmt: 'same', showKeys: true }, LS.get('cutter:settings', {}));
let destDir = null, targets = [];
const saveSettings = () => LS.set('cutter:settings', { mode: S.mode, out: S.out, prec: S.prec, tracks: S.tracks, fmt: S.fmt, showKeys: S.showKeys });
const dur = () => cur?.media?.duration || 0, fps = () => cur?.media?.fps || null;
const step = () => fps() ? 1 / fps() : 0.01;

/* ---------- time boxes: 00:00:00:00 (frames) for video, 00:00:00.00 for sound; type digits, the cursor moves on ---------- */
const SLOTS = [0, 1, 3, 4, 6, 7, 9, 10];
function timeBox(inp, { onValue, getFps = fps, onEnter }) {
  let slot = 0;
  inp.setAttribute('inputmode', 'numeric'); inp.setAttribute('autocomplete', 'off'); inp.setAttribute('spellcheck', 'false'); inp.classList.add('tbox');
  const sep = () => getFps() ? ':' : '.';
  const digits = () => (inp.value.replace(/\D/g, '') + '00000000').slice(0, 8);
  const show = d => { d = (String(d).replace(/\D/g, '') + '00000000').slice(0, 8); inp.value = `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}${sep()}${d.slice(6, 8)}`; };
  const secondsOf = d => { const f = getFps(), last = +d.slice(6, 8); return +d.slice(0, 2) * 3600 + Math.min(59, +d.slice(2, 4)) * 60 + Math.min(59, +d.slice(4, 6)) + (f ? Math.min(Math.round(f) - 1, last) / Math.round(f) : last / 100); };
  const select = () => { const p = SLOTS[slot]; try { inp.setSelectionRange(p, p + 1); } catch (e) {} };
  const commit = d => { show(d); onValue(secondsOf(digits())); };
  const typeDigit = ch => { const d = digits().split(''), f = getFps(); let v = +ch; if (slot === 2 || slot === 4) v = Math.min(5, v); if (slot === 6 && f) v = Math.min(Math.floor((Math.round(f) - 1) / 10), v); d[slot] = String(v); commit(d.join('')); slot = Math.min(7, slot + 1); select(); };
  const back = () => { const d = digits().split(''); if (slot > 0 && d[slot] === '0') slot--; d[slot] = '0'; commit(d.join('')); select(); };
  inp.addEventListener('focus', () => { slot = 0; setTimeout(select, 0); });
  inp.addEventListener('mouseup', e => { e.preventDefault(); slot = 0; select(); }); // a click always starts at the first digit: type the whole time, left to right
  inp.addEventListener('beforeinput', e => { if (e.inputType.startsWith('insert')) { e.preventDefault(); const txt = e.data || ''; if (/[:.hms]/.test(txt) && txt.length > 2) { const v = C.parseTime(txt, getFps()); if (v != null) { show(C.fmtTime(v, getFps()).replace(/\D/g, '')); onValue(v); } return; } for (const ch of txt) if (/\d/.test(ch)) typeDigit(ch); } else if (e.inputType.startsWith('delete')) { e.preventDefault(); back(); } });
  inp.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; const d = digits().split('');
    if (/^\d$/.test(e.key)) typeDigit(e.key);
    else if (e.key === 'Backspace') back();
    else if (e.key === 'Delete') { d[slot] = '0'; commit(d.join('')); select(); }
    else if (e.key === 'ArrowLeft') { slot = Math.max(0, slot - 1); select(); }
    else if (e.key === 'ArrowRight') { slot = Math.min(7, slot + 1); select(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { const v = secondsOf(digits()) + (e.key === 'ArrowUp' ? 1 : -1) * (slot >= 6 ? (getFps() ? 1 / Math.round(getFps()) : 0.01) : [36000, 3600, 600, 60, 10, 1][slot]); const nv = Math.max(0, v); show(C.fmtTime(nv, getFps()).replace(/\D/g, '')); onValue(nv); select(); }
    else if (e.key === 'Home') { slot = 0; select(); } else if (e.key === 'End') { slot = 7; select(); }
    else if (e.key === 'Enter') { inp.blur(); onEnter && onEnter(); }
    else if (e.key === 'Escape') inp.blur();
    else if (e.key === 'Tab') return;
    else if (e.key.length !== 1) return;
    e.preventDefault();
  });
  inp.addEventListener('paste', e => { e.preventDefault(); const v = C.parseTime((e.clipboardData.getData('text') || '').trim(), getFps()); if (v != null) { show(C.fmtTime(v, getFps()).replace(/\D/g, '')); onValue(v); } });
  return { set(sec) { if (document.activeElement !== inp) inp.value = C.fmtTime(sec, getFps()); }, el: inp };
}

/* ---------- files ---------- */
async function openFiles(list, { show = false } = {}) {
  const add = [...list].filter(f => isMediaFile(f) || !f.type); if (!add.length) return toast('Those are not sound or video files.');
  for (const f of add) {
    const media = new Media(f); if (files.some(x => x.id === media.id)) continue;
    const entry = { id: media.id, media, state: 'opening', parts: [], undo: [], redo: [] }; files.push(entry); renderFiles();
    try {
      await media.open(); entry.state = 'ok'; entry.parts = (LS.get('cutter:parts:' + media.id, []) || []).map(p => C.clampPart(p, media.duration, media.fps));
      media.keyframes().then(k => { entry.keys = k; if (entry === cur) dirty(); }).catch(() => {});
      if (show || !cur || cur.state !== 'ok') select(entry); else renderFiles();
      loadPeaks(entry);
    } catch (e) { entry.state = 'error'; entry.error = e.message || String(e); renderFiles(); if (files.length === 1) toast(entry.error, 6000); }
  }
}
function loadPeaks(entry) {
  const m = entry.media, n = Math.min(30000, Math.max(1500, Math.round(m.duration * 25)));
  let last = 0; m.peaks(n, 0, m.duration, p => { entry.peaks = p; if (entry === cur && performance.now() - last > 250) { last = performance.now(); dirty(); drawOverview(); } }).then(p => { if (p) { entry.peaks = p; if (entry === cur) { dirty(); drawOverview(); } } });
}
function renderFiles() {
  const el = $('#fileList'); $('#filesHint').hidden = files.length > 0; $('#joinBtn').disabled = files.filter(f => f.state === 'ok').length < 2;
  el.innerHTML = files.map((f, i) => `<div class="fi${f === cur ? ' on' : ''}" data-i="${i}" title="${esc(f.media.file.name)}"><span class="k">${f.state === 'ok' ? (f.media.v ? '▣' : '♪') : f.state === 'error' ? '!' : '…'}</span><span class="n">${esc(f.media.file.name)}</span><button class="x" data-x="${i}" title="Close this file" aria-label="Close ${esc(f.media.file.name)}">✕</button>${f.state === 'ok' ? `<span class="d">${C.fmtTime(f.media.duration, f.media.fps)}</span>` : f.state === 'error' ? `<span class="err">${esc(f.error)}</span>` : '<span class="d">opening…</span>'}</div>`).join('');
}
$('#fileList').addEventListener('click', e => {
  const x = e.target.closest('[data-x]'); if (x) { const i = +x.dataset.x, f = files[i]; files.splice(i, 1); if (f === cur) { player.stop(); cur = null; select(files.find(z => z.state === 'ok') || null); } renderFiles(); return; }
  const row = e.target.closest('.fi'); if (row) { const f = files[+row.dataset.i]; if (f.state === 'ok') select(f); }
});
function select(entry) {
  player.stop(); cur = entry; sel = null; ph = 0; renderFiles();
  $('#empty').hidden = !!cur; $('#exportBtn').disabled = !cur;
  if (!cur) { $('#pills').innerHTML = ''; renderParts(); dirty(); return; }
  const m = cur.media; view = { t0: 0, t1: m.duration }; $('#zoom').value = 0;
  const v = m.video, a = m.audio;
  $('#pills').innerHTML = [`<span class="pill name">${esc(m.file.name)}</span>`, `<span class="pill">${m.family.toUpperCase()}${v ? ' · ' + v.codec.toUpperCase() : ''}${a ? ' · ' + a.codec.toUpperCase() : ''}</span>`, v ? `<span class="pill">${v.w}×${v.h} · ${+v.fps.toFixed(3)} fps</span>` : `<span class="pill">${(a.sr / 1000).toFixed(1)} kHz · ${a.ch === 1 ? 'mono' : a.ch === 2 ? 'stereo' : a.ch + ' ch'}</span>`, `<span class="pill">${C.fmtLength(m.duration)} · ${fmtBytes(m.file.size)}</span>`].join('');
  const mon = $('#mon'); mon.hidden = !v; $('#soundcard').hidden = !!v;
  if (v) { const w = Math.min(1280, v.w), h = Math.round(w * v.h / v.w); mon.width = w; mon.height = h; const ctx = mon.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); if (!v.canDecode) { ctx.fillStyle = '#AFC0B5'; ctx.font = '22px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`This browser cannot show ${v.codec.toUpperCase()} pictures. Untouched cuts still work.`, w / 2, h / 2); } }
  else { $('#scName').textContent = m.name; $('#scMeta').textContent = `${a.codec.toUpperCase()} · ${(a.sr / 1000).toFixed(1)} kHz · ${C.fmtTime(m.duration)}`; }
  $('#tl').dataset.h = v ? 168 : 150; sizeCanvases();
  updateExportBar(); renderParts(); movePH(0); dirty(); drawOverview();
}

/* ---------- parts ---------- */
const savePartsLS = () => { if (cur) LS.set('cutter:parts:' + cur.id, cur.parts.map(p => ({ id: p.id, t0: p.t0, t1: p.t1, name: p.name }))); };
function commit(parts, msg) { if (!cur) return; cur.undo.push(cur.parts); if (cur.undo.length > 200) cur.undo.shift(); cur.redo = []; cur.parts = parts; if (sel && !parts.some(p => p.id === sel)) sel = null; savePartsLS(); renderParts(); updateExportBar(); dirty(); drawOverview(); if (msg) toast(msg); }
function undo() { if (!cur || !cur.undo.length) return toast('Nothing to undo.'); cur.redo.push(cur.parts); cur.parts = cur.undo.pop(); savePartsLS(); renderParts(); updateExportBar(); dirty(); drawOverview(); }
function redo() { if (!cur || !cur.redo.length) return; cur.undo.push(cur.parts); cur.parts = cur.redo.pop(); savePartsLS(); renderParts(); updateExportBar(); dirty(); drawOverview(); }
const colourOf = i => C.COLOURS[i % C.COLOURS.length];
const rows = new Map(); // part id -> { el, boxes }
function renderParts() {
  const list = $('#partList'), parts = cur ? cur.parts : [];
  $('#partCount').textContent = parts.length ? `· ${parts.length}` : ''; $('#partsHint').hidden = parts.length > 0;
  for (const [id, r] of rows) if (!parts.some(p => p.id === id)) { r.el.remove(); rows.delete(id); }
  parts.forEach((p, i) => {
    let r = rows.get(p.id);
    if (!r) {
      const el = document.createElement('div'); el.className = 'part'; el.dataset.id = p.id;
      el.innerHTML = `<div class="row1"><span class="num"></span><input class="pname" placeholder="Name (optional)" aria-label="Part name"><button data-a="play" title="Play this part (P)" aria-label="Play this part">▶</button><button data-a="up" title="Earlier in the joined file" aria-label="Move up">↑</button><button data-a="down" title="Later in the joined file" aria-label="Move down">↓</button><button data-a="del" title="Remove this part (Delete)" aria-label="Remove this part">✕</button></div>
        <div class="times"><label>Start<input data-k="t0"></label><label>End<input data-k="t1"></label><label>Length<input data-k="len"></label></div><div class="note" hidden></div>`;
      const id = p.id, boxes = {};
      for (const k of ['t0', 't1', 'len']) boxes[k] = timeBox(el.querySelector(`[data-k="${k}"]`), { onValue: v => { const fn = k === 't0' ? C.setStart : k === 't1' ? C.setEnd : C.setLength; const next = fn(cur.parts, id, v, dur(), fps()); liveEdit(next); if (k !== 'len') { const q = next.find(x => x.id === id); if (q) movePH(k === 't0' ? q.t0 : q.t1); } }, onEnter: () => {} });
      el.querySelector('.pname').addEventListener('change', e => commit(cur.parts.map(x => x.id === id ? { ...x, name: e.target.value.trim() } : x)));
      el.querySelector('.pname').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
      el.addEventListener('focusin', () => { if (sel !== id) { sel = id; markSel(); dirty(); } });
      el.addEventListener('click', e => {
        const a = e.target.closest('[data-a]')?.dataset.a; const q = cur.parts.find(x => x.id === id); if (!q) return;
        if (!a) { if (!e.target.closest('input')) { sel = id; markSel(); movePH(q.t0); revealPart(q); dirty(); } return; }
        if (a === 'play') { sel = id; markSel(); playRange(q.t0, q.t1); }
        else if (a === 'del') commit(C.removePart(cur.parts, id));
        else if (a === 'up' || a === 'down') { const j = cur.parts.findIndex(x => x.id === id); commit(C.movePart(cur.parts, id, j + (a === 'up' ? -1 : 1))); }
      });
      r = { el, boxes }; rows.set(p.id, r);
    }
    if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] || null);
    r.el.style.setProperty('--c', colourOf(i)); r.el.querySelector('.num').textContent = i + 1;
    const nm = r.el.querySelector('.pname'); if (document.activeElement !== nm) nm.value = p.name || '';
    r.boxes.t0.set(p.t0); r.boxes.t1.set(p.t1); r.boxes.len.set(p.t1 - p.t0);
    r.el.querySelector('[data-a="up"]').disabled = i === 0; r.el.querySelector('[data-a="down"]').disabled = i === parts.length - 1;
    const note = r.el.querySelector('.note'), vid = cur.media.v && S.prec === 'copy' && S.fmt === 'same' && S.tracks !== 'audio' && cur.keys;
    const cr = vid ? C.copyRange(p.t0, p.t1, cur.keys, dur()) : null;
    note.hidden = !(cr && cr.moved); if (cr && cr.moved) note.innerHTML = `Untouched, this part runs <span class="tc">${C.fmtTime(cr.t0, fps())}</span> → <span class="tc">${C.fmtTime(cr.t1, fps())}</span> (the keyframes around it).`;
  });
  markSel();
}
function markSel() { for (const [id, r] of rows) r.el.classList.toggle('sel', id === sel); }
let liveBase = null, liveT = 0; // typing in a box: one undo step per burst of typing
function liveEdit(next) { if (!liveBase) liveBase = cur.parts; cur.parts = next; savePartsLS(); renderParts(); updateExportBar(); dirty(); drawOverview(); clearTimeout(liveT); liveT = setTimeout(() => { if (liveBase && liveBase !== cur.parts) { cur.undo.push(liveBase); cur.redo = []; } liveBase = null; }, 900); }
function newPartAtPlayhead() {
  if (!cur) return; const len = Math.min(10, Math.max(step(), dur() - ph)), t0 = Math.min(ph, Math.max(0, dur() - len));
  const parts = C.addPart(cur.parts, t0, t0 + len, dur(), fps()); const added = parts.find(p => !cur.parts.some(q => q.id === p.id)); commit(parts); sel = added.id; markSel(); dirty();
  rows.get(sel)?.el.scrollIntoView({ block: 'nearest' });
}
function markStart() { if (!cur) return; const p = cur.parts.find(x => x.id === sel); if (!p) { newPartAtPlayhead(); return; } commit(C.setStart(cur.parts, p.id, ph, dur(), fps())); }
function markEnd() {
  if (!cur) return; const p = cur.parts.find(x => x.id === sel);
  if (!p) { const parts = C.addPart(cur.parts, Math.max(0, ph - 10), ph, dur(), fps()); const added = parts.find(x => !cur.parts.some(q => q.id === x.id)); commit(parts); sel = added.id; markSel(); return; }
  commit(C.setEnd(cur.parts, p.id, ph, dur(), fps()));
}
function splitAtPlayhead() { if (!cur) return; const next = C.splitPartAt(cur.parts, ph, dur(), fps()); if (next === cur.parts) return toast('Put the playhead inside a part to split it.'); commit(next); }
function revealPart(p) { const span = view.t1 - view.t0; if (p.t0 < view.t0 || p.t1 > view.t1) { if (p.t1 - p.t0 > span) setView(p.t0 - (p.t1 - p.t0) * 0.05, p.t1 + (p.t1 - p.t0) * 0.05); else setView(p.t0 - span * 0.1, p.t0 + span * 0.9); } }
$('#addPart').addEventListener('click', newPartAtPlayhead);
$('#markIn').addEventListener('click', markStart);
$('#markOut').addEventListener('click', markEnd);
$('#splitHere').addEventListener('click', splitAtPlayhead);

/* ---------- playhead, monitor, playback ---------- */
const phBox = timeBox($('#phTime'), { onValue: v => { if (!cur) return; movePH(Math.min(dur(), v)); revealT(ph); } });
const mon = $('#mon'), mctx = mon.getContext('2d');
const player = new Player({
  onFrame: (canvas) => { mctx.drawImage(canvas, 0, 0, mon.width, mon.height); },
  onTime: t => { ph = t; phBox.set(t); $('#tPlay').textContent = '❚❚ Pause'; if (t > view.t1 || t < view.t0) { const span = view.t1 - view.t0; setView(t - span * 0.05, t + span * 0.95); } dirty(); },
  onEnd: () => { $('#tPlay').textContent = '▶ Play'; drawMonitor(); },
});
let monReq = 0;
async function drawMonitor() {
  if (!cur || !cur.media.v || !cur.media.video.canDecode || player.playing) return; const my = ++monReq, t = ph;
  const f = await cur.media.frame(t, mon.width).catch(() => null); if (my !== monReq || !f) return; mctx.drawImage(f.canvas, 0, 0, mon.width, mon.height);
}
function movePH(t) { if (!cur) return; ph = Math.max(0, Math.min(dur(), C.snapFrame(t, fps()))); phBox.set(ph); if (player.playing) playFrom(ph); else drawMonitor(); dirty(); }
function revealT(t) { if (t < view.t0 || t > view.t1) { const span = view.t1 - view.t0; setView(t - span / 2, t + span / 2); } }
function playFrom(t, to) { if (!cur) return; player.play(cur.media, t >= dur() - step() ? 0 : t, to); $('#tPlay').textContent = '❚❚ Pause'; }
function playRange(a, b) { if (!cur) return; ph = a; player.play(cur.media, a, b); $('#tPlay').textContent = '❚❚ Pause'; }
function togglePlay() { if (!cur) return; if (player.playing) { player.stop(); ph = C.snapFrame(player.at ?? ph, fps()); phBox.set(ph); $('#tPlay').textContent = '▶ Play'; drawMonitor(); dirty(); } else playFrom(ph); }
$('#tPlay').addEventListener('click', togglePlay);
$('#tStart').addEventListener('click', () => { movePH(0); revealT(0); });
$('#tEnd').addEventListener('click', () => { movePH(dur()); revealT(dur()); });
$('#tBack').addEventListener('click', e => { movePH(ph - (e.shiftKey ? 1 : step())); revealT(ph); });
$('#tFwd').addEventListener('click', e => { movePH(ph + (e.shiftKey ? 1 : step())); revealT(ph); });
// buttons do not keep focus: Space must reach the player, not press the last button again
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.closest('.sheet')) b.blur(); });

/* ---------- the timeline ---------- */
const tl = $('#tl'), tctx = tl.getContext('2d'), ov = $('#ov'), octx = ov.getContext('2d');
let need = false, hoverT = null; const dirty = () => { if (!need) { need = true; requestAnimationFrame(() => { need = false; drawTL(); }); } };
function sizeCanvases() { const dpr = Math.min(2, devicePixelRatio || 1); for (const c of [tl, ov]) { const w = c.clientWidth; if (!w) continue; const h = +c.dataset.h; c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + 'px'; c._dpr = dpr; } dirty(); drawOverview(); }
new ResizeObserver(sizeCanvases).observe(tl);
const minSpan = () => cur ? Math.min(dur(), cur.media.v ? Math.max(0.5, 30 * step()) : 0.25) : 1;
function setView(a, b, fromSlider = false) {
  if (!cur) return; const D = dur(); let span = Math.max(minSpan(), Math.min(D, b - a)); a = Math.max(0, Math.min(D - span, a)); view = { t0: a, t1: a + span };
  if (!fromSlider) { const z = D <= minSpan() ? 0 : Math.log(D / span) / Math.log(D / minSpan()); $('#zoom').value = Math.round(z * 1000); }
  dirty(); drawOverview(); wantDetail();
}
function zoomAt(t, factor) { const a = t - (t - view.t0) * factor, b = t + (view.t1 - t) * factor; setView(a, b); }
$('#zoom').addEventListener('input', e => { if (!cur) return; const D = dur(), z = +e.target.value / 1000, span = D / Math.pow(D / minSpan(), z), c = player.playing || (ph >= view.t0 && ph <= view.t1) ? ph : (view.t0 + view.t1) / 2; setView(c - span / 2, c + span / 2, true); });
$('#zoomIn').addEventListener('click', () => zoomAt(ph, 0.5));
$('#zoomOut').addEventListener('click', () => zoomAt(ph, 2));
$('#zoomFit').addEventListener('click', () => setView(0, dur()));
$('#showKeys').checked = S.showKeys; $('#showKeys').addEventListener('change', e => { S.showKeys = e.target.checked; saveSettings(); dirty(); });
// lanes
const LANE = () => { const H = +tl.dataset.h, ruler = 22, film = cur?.media.v ? 46 : 0; return { ruler, film, waveTop: ruler + film, waveH: H - ruler - film, H }; };
const xOf = (t, W) => (t - view.t0) / (view.t1 - view.t0) * W, tOf = (x, W) => view.t0 + x / W * (view.t1 - view.t0);
function niceStep(secPerPx) { const want = secPerPx * 90, f = fps(); const steps = [f ? 1 / f : 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400]; return steps.find(s => s >= want) || 14400; }
function rulerLabel(t, st) { const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60), p = n => String(n).padStart(2, '0'); const base = h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`; if (st >= 1) return base; const f = fps(); return f ? `${base}:${p(Math.round((t % 1) * f))}` : `${base}.${p(Math.round((t % 1) * 100))}`; }
function peaksFor(t0, t1) { const d = cur.detail; return d && d.t0 <= t0 + 1e-6 && d.t1 >= t1 - 1e-6 ? d : cur.peaks; }
function drawWave(ctx, pk, x0, W, top, h, a, b, colour) {
  if (!pk) return; const mid = top + h / 2, amp = h / 2 - 2, per = (b - a) / W; ctx.fillStyle = colour;
  for (let x = 0; x < W; x++) {
    const t0 = a + x * per, t1 = t0 + per; let i0 = Math.floor((t0 - pk.t0) / pk.bucketSec), i1 = Math.max(i0 + 1, Math.ceil((t1 - pk.t0) / pk.bucketSec)); if (i1 <= 0 || i0 >= pk.max.length) continue; i0 = Math.max(0, i0); i1 = Math.min(pk.max.length, i1);
    let lo = 0, hi = 0; for (let i = i0; i < i1; i++) { if (pk.min[i] < lo) lo = pk.min[i]; if (pk.max[i] > hi) hi = pk.max[i]; }
    const y0 = mid - Math.sqrt(Math.min(1, hi)) * amp, y1 = mid - Math.sqrt(Math.min(1, -lo)) * -amp; ctx.fillRect(x0 + x, y0, 1, Math.max(1, y1 - y0));
  }
}
function keyBefore(t) { const ks = cur.keys; if (!ks || !ks.length) return null; let lo = 0, hi = ks.length - 1; if (t < ks[0]) return ks[0]; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ks[m] <= t + 1e-6) lo = m; else hi = m - 1; } return ks[lo]; }
function drawTL() {
  const dpr = tl._dpr || 1, W = tl.width / dpr, L = LANE(); tctx.setTransform(dpr, 0, 0, dpr, 0, 0); tctx.clearRect(0, 0, W, L.H);
  tctx.fillStyle = '#0E211C'; tctx.fillRect(0, 0, W, L.H);
  if (!cur) { tctx.fillStyle = '#789086'; tctx.font = '13px "Bricolage Grotesque", sans-serif'; tctx.fillText('The timeline appears when a file is open.', 14, L.H / 2); return; }
  const span = view.t1 - view.t0, spp = span / W, st = niceStep(spp);
  // ruler
  tctx.fillStyle = '#183730'; tctx.fillRect(0, 0, W, L.ruler); tctx.font = '10.5px "Martian Mono", monospace'; tctx.textBaseline = 'middle';
  for (let t = Math.floor(view.t0 / st) * st; t <= view.t1; t += st) { const x = Math.round(xOf(t, W)) + 0.5; tctx.fillStyle = 'rgba(237,230,214,.35)'; tctx.fillRect(x, L.ruler - 7, 1, 7); tctx.fillStyle = 'rgba(237,230,214,.6)'; tctx.fillText(rulerLabel(t + 1e-9, st), x + 4, 9); tctx.fillStyle = 'rgba(237,230,214,.05)'; tctx.fillRect(x, L.ruler, 1, L.H - L.ruler); }
  // keyframes
  if (S.showKeys && cur.keys && cur.keys.length > 1) { const avg = dur() / cur.keys.length; if (avg / spp >= 3) { tctx.fillStyle = 'rgba(255,107,53,.75)'; for (const k of cur.keys) { if (k < view.t0 || k > view.t1) continue; const x = Math.round(xOf(k, W)); tctx.fillRect(x, L.ruler - 4, 1, 4); } } }
  // filmstrip
  if (L.film) {
    const th = L.film - 4, tw = Math.round(th * cur.media.video.w / cur.media.video.h), n = Math.ceil(W / tw);
    for (let i = 0; i < n; i++) {
      const x = i * tw, t = tOf(x + tw / 2, W); if (t > dur()) break;
      const k = keyBefore(t); if (k == null) continue; const e = cur, th0 = (e.thumbs ||= new Map()); let it = th0.get(k);
      if (!it) { it = { v: null }; th0.set(k, it); e.media.thumb(k, th).then(cv => { it.v = cv; if (e === cur) dirty(); }); }
      if (it.v) tctx.drawImage(it.v, x, L.ruler + 2, tw - 1, th);
    }
  }
  // waveform
  const pk = peaksFor(view.t0, view.t1); tctx.fillStyle = '#10261F'; tctx.fillRect(0, L.waveTop, W, L.waveH);
  if (cur.media.a) drawWave(tctx, pk, 0, W, L.waveTop + 2, L.waveH - 4, view.t0, view.t1, '#8FD3C1');
  else { tctx.fillStyle = '#789086'; tctx.font = '12px "Bricolage Grotesque", sans-serif'; tctx.fillText('No sound in this file', 10, L.waveTop + L.waveH / 2); }
  // parts
  const copyish = cur.media.v && S.prec === 'copy' && S.fmt === 'same' && S.tracks !== 'audio' && cur.keys;
  if (S.mode === 'remove') { // what is cut out is shaded; what stays is plain
    for (const p of cur.parts) { const x0 = xOf(p.t0, W), x1 = xOf(p.t1, W); if (x1 < 0 || x0 > W) continue; tctx.fillStyle = 'rgba(8,16,13,.72)'; tctx.fillRect(x0, L.ruler, x1 - x0, L.H - L.ruler); tctx.strokeStyle = 'rgba(255,122,122,.8)'; tctx.lineWidth = 1; tctx.beginPath(); for (let x = Math.floor(x0) - L.H; x < x1; x += 10) { tctx.moveTo(Math.max(x0, x), L.ruler + Math.max(0, x0 - x)); tctx.lineTo(Math.min(x1, x + L.H - L.ruler), L.ruler + Math.min(L.H - L.ruler, x1 - x)); } tctx.stroke(); }
  }
  cur.parts.forEach((p, i) => {
    const x0 = xOf(p.t0, W), x1 = xOf(p.t1, W); if (x1 < -2 || x0 > W + 2) return; const c = colourOf(i), on = p.id === sel;
    if (S.mode === 'keep') { tctx.fillStyle = c + (on ? '38' : '24'); tctx.fillRect(x0, L.ruler, x1 - x0, L.H - L.ruler); }
    tctx.fillStyle = c; tctx.fillRect(x0, L.ruler, Math.max(2, x1 - x0), 3); tctx.fillRect(x0, L.ruler, on ? 3 : 2, L.H - L.ruler); tctx.fillRect(x1 - (on ? 3 : 2), L.ruler, on ? 3 : 2, L.H - L.ruler);
    const label = `${i + 1}${p.name ? ' ' + p.name : ''}`; tctx.font = '600 11px "Bricolage Grotesque", sans-serif'; const lw = tctx.measureText(label).width + 10;
    if (x1 - x0 > 16) { tctx.fillStyle = c; tctx.fillRect(Math.max(0, x0), L.ruler + 3, Math.min(lw, x1 - Math.max(0, x0)), 15); tctx.fillStyle = '#14302A'; tctx.save(); tctx.beginPath(); tctx.rect(Math.max(0, x0), L.ruler + 3, x1 - Math.max(0, x0), 15); tctx.clip(); tctx.fillText(label, Math.max(0, x0) + 5, L.ruler + 11); tctx.restore(); }
    if (copyish && S.mode === 'keep') { const cr = C.copyRange(p.t0, p.t1, cur.keys, dur()); if (cr.moved) { tctx.setLineDash([4, 3]); tctx.strokeStyle = c; tctx.lineWidth = 1.5; tctx.strokeRect(xOf(cr.t0, W) + 0.5, L.ruler + 20, xOf(cr.t1, W) - xOf(cr.t0, W) - 1, L.H - L.ruler - 22); tctx.setLineDash([]); } }
  });
  // hover and playhead
  if (hoverT != null) { const x = Math.round(xOf(hoverT, W)) + 0.5; tctx.fillStyle = 'rgba(237,230,214,.35)'; tctx.fillRect(x, 0, 1, L.H); }
  const px = Math.round(xOf(ph, W)); tctx.fillStyle = '#FF6B35'; tctx.fillRect(px - 1, 0, 2, L.H); tctx.beginPath(); tctx.moveTo(px - 6, 0); tctx.lineTo(px + 6, 0); tctx.lineTo(px, 8); tctx.fill();
}
function drawOverview() {
  const dpr = ov._dpr || 1, W = ov.width / dpr, H = +ov.dataset.h; octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.fillStyle = '#0E211C'; octx.fillRect(0, 0, W, H);
  if (!cur) return; const D = dur();
  if (cur.media.a) drawWave(octx, cur.peaks, 0, W, 1, H - 2, 0, D, 'rgba(143,211,193,.55)');
  cur.parts.forEach((p, i) => { octx.fillStyle = colourOf(i) + (S.mode === 'remove' ? '70' : 'AA'); octx.fillRect(p.t0 / D * W, H - 5, Math.max(2, (p.t1 - p.t0) / D * W), 5); });
  const a = view.t0 / D * W, b = view.t1 / D * W; octx.fillStyle = 'rgba(237,230,214,.10)'; octx.fillRect(a, 0, Math.max(3, b - a), H); octx.strokeStyle = 'rgba(237,230,214,.7)'; octx.lineWidth = 1; octx.strokeRect(a + 0.5, 0.5, Math.max(3, b - a) - 1, H - 1);
  octx.fillStyle = '#FF6B35'; octx.fillRect(ph / D * W - 1, 0, 2, H);
}
// detail peaks for the visible stretch, when the whole-file peaks are too coarse for the zoom
let detT = 0, detRun = 0;
function wantDetail() {
  clearTimeout(detT); if (!cur || !cur.media.a || !cur.peaks) return; const W = tl.clientWidth || 800, span = view.t1 - view.t0;
  if (cur.peaks.bucketSec <= span / W * 1.2 || span > 1800) return;
  const d = cur.detail; if (d && d.t0 <= view.t0 && d.t1 >= view.t1 && d.bucketSec <= span / W * 1.2) return;
  detT = setTimeout(async () => { const my = ++detRun, e = cur, a = Math.max(0, view.t0 - span * 0.5), b = Math.min(dur(), view.t1 + span * 0.5); const p = await e.media.peaks(Math.round(W * 2 * (b - a) / span), a, b, null, () => my !== detRun); if (p && my === detRun && e === cur) { e.detail = p; dirty(); } }, 220);
}
// pointer on the timeline
let drag = null;
function hitPart(x, W) { if (!cur) return null; const L = LANE(); let best = null; cur.parts.forEach(p => { const x0 = xOf(p.t0, W), x1 = xOf(p.t1, W); for (const [edge, xe] of [['t0', x0], ['t1', x1]]) { const d = Math.abs(x - xe); if (d <= 7 && (!best || d < best.d)) best = { p, edge, d }; } }); if (best) return best; const inside = cur.parts.filter(p => x >= xOf(p.t0, W) && x <= xOf(p.t1, W)).sort((a, b) => (a.t1 - a.t0) - (b.t1 - b.t0))[0]; return inside ? { p: inside, edge: null } : null; }
tl.addEventListener('pointerdown', e => {
  if (!cur || e.button !== 0) return; const r = tl.getBoundingClientRect(), W = r.width, x = e.clientX - r.left, y = e.clientY - r.top, L = LANE(), t = tOf(x, W);
  tl.setPointerCapture(e.pointerId);
  if (y < L.ruler) { drag = { kind: 'seek' }; movePH(t); return; }
  const hit = hitPart(x, W);
  if (hit && hit.edge) { sel = hit.p.id; markSel(); drag = { kind: 'edge', id: hit.p.id, edge: hit.edge, base: cur.parts }; return; }
  if (hit) { sel = hit.p.id; markSel(); drag = { kind: 'move', id: hit.p.id, base: cur.parts, t0: t, p0: hit.p, x0: x, moved: false }; rows.get(sel)?.el.scrollIntoView({ block: 'nearest' }); dirty(); return; }
  drag = { kind: 'new', t0: C.snapFrame(t, fps()), x0: x, base: cur.parts };
});
tl.addEventListener('pointermove', e => {
  if (!cur) return; const r = tl.getBoundingClientRect(), W = r.width, x = e.clientX - r.left, y = e.clientY - r.top, t = Math.max(0, Math.min(dur(), tOf(x, W)));
  hoverT = t; $('#tlAt').textContent = C.fmtTime(t, fps());
  if (!drag) { const h = y >= LANE().ruler && hitPart(x, W); tl.style.cursor = h && h.edge ? 'ew-resize' : h ? 'grab' : y < LANE().ruler ? 'pointer' : 'crosshair'; dirty(); return; }
  const snap = v => { // edges stick to the playhead and to keyframes within 6 px
    if (e.altKey) return C.snapFrame(v, fps()); const near = [ph, ...(S.showKeys && cur.keys ? cur.keys.filter(k => Math.abs(xOf(k, W) - xOf(v, W)) < 6) : [])].find(k => Math.abs(xOf(k, W) - xOf(v, W)) < 6); return C.snapFrame(near ?? v, fps()); };
  if (drag.kind === 'seek') movePH(t);
  else if (drag.kind === 'edge') { const fn = drag.edge === 't0' ? C.setStart : C.setEnd; cur.parts = fn(drag.base, drag.id, snap(t), dur(), fps()); renderParts(); updateExportBar(); const q = cur.parts.find(p => p.id === drag.id); if (q) { ph = drag.edge === 't0' ? q.t0 : q.t1; phBox.set(ph); drawMonitor(); } dirty(); }
  else if (drag.kind === 'move') { if (Math.abs(x - drag.x0) < 4 && !drag.moved) return; drag.moved = true; const len = drag.p0.t1 - drag.p0.t0; let a = snap(drag.p0.t0 + (t - drag.t0)); a = Math.max(0, Math.min(dur() - len, a)); cur.parts = C.updatePart(drag.base, drag.id, { t0: a, t1: a + len }, dur(), fps()); renderParts(); updateExportBar(); dirty(); }
  else if (drag.kind === 'new') { if (Math.abs(x - drag.x0) < 5) return; const b = snap(t); cur.parts = C.addPart(drag.base, drag.t0, b, dur(), fps()); drag.made = cur.parts.find(p => !drag.base.some(q => q.id === p.id)); sel = drag.made?.id; renderParts(); updateExportBar(); dirty(); }
});
tl.addEventListener('pointerup', e => {
  if (!drag) return; const d = drag; drag = null;
  if (d.kind === 'new' && !d.made) { movePH(d.t0); return; }
  if (d.kind === 'move' && !d.moved) { const r = tl.getBoundingClientRect(); movePH(tOf(e.clientX - r.left, r.width)); return; }
  if (d.base && d.base !== cur.parts) { const now = cur.parts; cur.parts = d.base; commit(C.sortParts(now)); if (d.kind === 'new') { rows.get(sel)?.el.scrollIntoView({ block: 'nearest' }); } }
});
tl.addEventListener('pointerleave', () => { hoverT = null; $('#tlAt').textContent = ''; dirty(); });
tl.addEventListener('wheel', e => {
  if (!cur) return; e.preventDefault(); const r = tl.getBoundingClientRect(), t = tOf(e.clientX - r.left, r.width), span = view.t1 - view.t0;
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const d = (e.shiftKey ? e.deltaY : e.deltaX) / r.width * span; setView(view.t0 + d, view.t1 + d); }
  else zoomAt(t, Math.pow(1.0015, e.deltaY));
}, { passive: false });
let ovDrag = null;
ov.addEventListener('pointerdown', e => { if (!cur) return; ov.setPointerCapture(e.pointerId); const r = ov.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * dur(), span = view.t1 - view.t0; if (t < view.t0 || t > view.t1) setView(t - span / 2, t + span / 2); ovDrag = { x: e.clientX, a: view.t0 }; ov.style.cursor = 'grabbing'; });
ov.addEventListener('pointermove', e => { if (!ovDrag) return; const r = ov.getBoundingClientRect(), d = (e.clientX - ovDrag.x) / r.width * dur(), span = view.t1 - view.t0; setView(ovDrag.a + d, ovDrag.a + d + span); });
ov.addEventListener('pointerup', () => { ovDrag = null; ov.style.cursor = ''; });

/* ---------- export bar ---------- */
function seg(id, key, after) { const el = $(id); el.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled) return; S[key] = b.dataset.v; saveSettings(); updateExportBar(); renderParts(); dirty(); drawOverview(); after && after(); }); }
seg('#segMode', 'mode'); seg('#segOut', 'out'); seg('#segPrec', 'prec'); seg('#segTracks', 'tracks');
$('#fmtSel').addEventListener('change', e => { S.fmt = e.target.value; saveSettings(); updateExportBar(); renderParts(); dirty(); });
function updateExportBar() {
  const m = cur?.media, video = !!m?.v, hasA = !!m?.a;
  if (m && !video) S.tracksNow = 'audio'; else S.tracksNow = S.tracks;
  if (m && video && !hasA && S.tracksNow !== 'video') S.tracksNow = 'video';
  const tr = S.tracksNow, soundOnly = tr === 'audio';
  for (const [id, key, val] of [['#segMode', 'mode', S.mode], ['#segOut', 'out', S.out], ['#segPrec', 'prec', S.prec], ['#segTracks', 'tracks', tr]]) $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === val));
  $('#segTracks').hidden = !!m && !video; $('#segTracks').querySelector('[data-v="audio"]').disabled = !hasA; $('#segTracks').querySelector('[data-v="both"]').disabled = !hasA;
  // the format list: the original's own, then what this browser can write for the tracks chosen
  const own = m ? `Same as the original` : 'Same as the original';
  const opts = [{ id: 'same', label: own }, ...targets.filter(t => soundOnly || !m ? t.sound || !m : !t.sound)];
  if (!opts.some(o => o.id === S.fmt)) S.fmt = 'same';
  $('#fmtSel').innerHTML = opts.map(o => `<option value="${o.id}"${o.id === S.fmt ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  const conv = S.fmt !== 'same';
  $('#segPrec').querySelectorAll('button').forEach(b => { b.disabled = conv; });
  $('#segPrec').title = conv ? 'A conversion re-encodes everything, so it is always exact.' : '';
  $('#segPrec').querySelector('[data-v="exact"]').title = video && !soundOnly ? 'Cut exactly where you marked. For H.264 video only the frames at the edges are re-encoded; the rest is copied untouched.' : 'Cut exactly to the sample.';
  $('#segPrec').querySelector('[data-v="copy"]').title = video && !soundOnly ? 'Nothing is re-encoded, in any format. The cut moves out to the nearest keyframes.' : 'Nothing is re-encoded. The cut lands within about 20 ms (WAV and other PCM files are always exact).';
  const rs = exportRangesNow(), n = !m ? 0 : S.out === 'join' ? (rs.length ? 1 : 0) : rs.length;
  const total = C.totalLength(rs);
  $('#sum').innerHTML = !m ? '' : !rs.length ? (S.mode === 'remove' && cur.parts.length ? 'The parts cover the whole file: nothing would be left.' : '') : `<b>${n}</b> file${n === 1 ? '' : 's'} · <b>${C.fmtTime(total, fps())}</b>${S.mode === 'keep' && !cur.parts.length ? ' · the whole file' : ''}`;
  $('#exportBtn').disabled = !m || !n; $('#exportBtn').textContent = n > 1 ? `Export ${n} files` : 'Export';
}
function exportRangesNow() { if (!cur) return []; if (S.mode === 'keep' && !cur.parts.length) return [{ t0: 0, t1: dur(), name: '', index: 1 }]; return C.exportRanges(cur.parts, S.mode, dur(), fps()); }

/* ---------- where files go ---------- */
$('#destBtn').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left, r.top - 8, [['Downloads', () => { destDir = null; $('#destBtn').textContent = 'To Downloads'; }], ...(window.showDirectoryPicker ? [['Choose a folder…', async () => { try { destDir = await showDirectoryPicker({ id: 'cutter-out', mode: 'readwrite' }); $('#destBtn').textContent = `To “${destDir.name}”`; } catch (err) {} }]] : [])], true);
});
async function saveFile(file, name) {
  if (window.__cutterSave) return window.__cutterSave(file, name); // tests on this computer only (set from the console on localhost)
  if (destDir) {
    let n = name, i = 2; const base = name.replace(/(\.[^.]+)$/, ''), ext = (name.match(/\.[^.]+$/) || [''])[0];
    for (;;) { try { await destDir.getFileHandle(n); n = `${base} (${i++})${ext}`; } catch (e) { break; } }
    const fh = await destDir.getFileHandle(n, { create: true }), w = await fh.createWritable(); await file.stream().pipeTo(w); return { where: `“${destDir.name}”`, name: n, folder: true };
  }
  const a = document.createElement('a'), url = URL.createObjectURL(file); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10 * 60e3);
  return { where: 'Downloads', name, folder: false };
}

/* ---------- export ---------- */
let exporting = null; const TARGET_SOUND = { m4a: 1, wav: 1, ogg: 1, mp3: 1, flac: 1 };
async function startExport(jobsIn, title) {
  if (exporting) return; if (destDir) { try { if ((await destDir.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await destDir.requestPermission({ mode: 'readwrite' })) !== 'granted') { destDir = null; $('#destBtn').textContent = 'To Downloads'; } } catch (e) {} }
  player.stop(); $('#tPlay').textContent = '▶ Play';
  const ac = new AbortController(); exporting = ac;
  const sh = openSheet(`<h3>${esc(title)}</h3><p class="lead">${destDir ? `Saving into “${esc(destDir.name)}”.` : `Saving to your Downloads${jobsIn.length > 3 ? ' (the browser may ask once to allow several downloads; choosing a folder avoids that)' : ''}.`}</p><div class="jobs">${jobsIn.map((j, i) => `<div class="jobrow" data-j="${i}"><div class="nm">${esc(j.label)}</div><div class="st">Waiting</div><div class="bar"><i></i></div><div class="lk" hidden></div></div>`).join('')}</div><div class="acts"><span class="sp"></span><button id="exCancel">Cancel</button></div>`, { onClose: () => ac.abort() });
  sh.querySelector('#exCancel').addEventListener('click', () => { if (exporting) { ac.abort(); } else closeSheet(); });
  let ok = 0;
  for (let i = 0; i < jobsIn.length; i++) {
    const j = jobsIn[i], row = sh.querySelector(`[data-j="${i}"]`), st = row.querySelector('.st'), bar = row.querySelector('.bar i');
    if (ac.signal.aborted) { st.textContent = 'Cancelled'; continue; }
    st.textContent = 'Starting…'; row.scrollIntoView({ block: 'nearest' });
    try {
      const t0 = performance.now();
      const res = await writeCut({ ...j.spec, signal: ac.signal, onProgress: (v, text) => { bar.style.width = Math.round(v * 100) + '%'; st.textContent = text ? `${Math.round(v * 100)}% · ${text}` : `${Math.round(v * 100)}%`; } });
      const saved = await saveFile(res.file, res.name); if (saved.folder) res.cleanup();
      row.classList.add('done'); bar.style.width = '100%'; row.querySelector('.nm').textContent = saved.name;
      st.innerHTML = `${esc(res.note)} <span style="color:var(--faint)">${fmtBytes(res.file.size)} · ${C.fmtLength(res.length)} · took ${C.fmtLength((performance.now() - t0) / 1000)} · saved to ${esc(saved.where)}</span>`;
      const lk = row.querySelector('.lk'); lk.hidden = false; lk.innerHTML = '<button class="sm" data-open>Open it here to check</button>' + (host ? `<button class="sm" data-lib>Add to my ${esc(host.name)} library</button>` : '');
      if (host) lk.querySelector('[data-lib]').addEventListener('click', async ev => { const b = ev.currentTarget; b.disabled = true; b.textContent = 'Adding…'; try { await host.addToLibrary(res.file, saved.name, { duration: res.length, video: !!j.spec.ranges[0].media.v && (j.spec.tracks || 'both') !== 'audio' && !(TARGET_SOUND[j.spec.format]) }); b.textContent = `In your ${host.name} library ✓`; } catch (err) { b.disabled = false; b.textContent = `Add to my ${host.name} library`; toast(`Could not add it: ${err.message || err}`, 6000); } });
      lk.querySelector('[data-open]').addEventListener('click', () => { closeSheet(); openFiles([new File([res.file], saved.name, { type: res.file.type, lastModified: Date.now() })], { show: true }); });
      ok++; window.__lastExport = res;
    } catch (e) {
      row.classList.add('fail'); st.textContent = e.cancelled || ac.signal.aborted ? 'Cancelled' : `Could not write this one: ${e.message || e}`; if (!e.cancelled && !ac.signal.aborted) console.error(e);
    }
  }
  exporting = null; const c = sh.querySelector('#exCancel'); c.textContent = 'Close'; c.classList.add('primary');
  if (ok) toast(`${ok} file${ok === 1 ? '' : 's'} saved.`);
}
function specBase() { return { precision: S.prec, tracks: S.tracksNow || S.tracks, format: S.fmt }; }
$('#exportBtn').addEventListener('click', () => {
  if (!cur) return; const m = cur.media, rs = exportRangesNow(); if (!rs.length) return toast('Nothing to export.');
  const R = r => ({ media: m, t0: r.t0, t1: r.t1 });
  let jobs;
  if (S.out === 'join' && rs.length > 1) jobs = [{ label: C.fileNameFor(m.name, null, '', true, rs.length), spec: { ...specBase(), ranges: rs.map(R), fileName: ext => C.fileNameFor(m.name, null, ext, true, rs.length) } }];
  else jobs = rs.map(r => ({ label: C.fileNameFor(m.name, r, ''), spec: { ...specBase(), ranges: [R(r)], fileName: ext => (rs.length === 1 && r.t0 === 0 && Math.abs(r.t1 - dur()) < 1e-6 && S.fmt !== 'same') ? `${m.name}${ext}` : C.fileNameFor(m.name, r, ext) } }));
  startExport(jobs, jobs.length > 1 ? `Exporting ${jobs.length} files` : 'Exporting');
});

/* ---------- join files ---------- */
$('#joinBtn').addEventListener('click', () => {
  const ok = files.filter(f => f.state === 'ok'); if (ok.length < 2) return; let order = ok.map(f => ({ f, on: true }));
  const sh = openSheet(`<h3>Join files</h3><p class="lead">The files are joined end to end into one, in this order. The precision, tracks and format below the timeline apply.</p><div class="joinlist" id="jl"></div><div class="warnline" id="jw" hidden></div><div class="acts"><button id="jClose">Close</button><span class="sp"></span><button class="primary" id="jGo">Join</button></div>`);
  const draw = () => {
    sh.querySelector('#jl').innerHTML = order.map((o, i) => `<div class="joinrow"><input type="checkbox" data-c="${i}" ${o.on ? 'checked' : ''} aria-label="Include ${esc(o.f.media.file.name)}"><div><div>${esc(o.f.media.file.name)}</div><div class="d">${C.fmtTime(o.f.media.duration, o.f.media.fps)} · ${o.f.media.v ? `${o.f.media.video.w}×${o.f.media.video.h} ${o.f.media.video.codec.toUpperCase()}` : o.f.media.audio.codec.toUpperCase()}</div></div><button class="sm" data-u="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Earlier">↑</button><button class="sm" data-d="${i}" ${i === order.length - 1 ? 'disabled' : ''} aria-label="Later">↓</button></div>`).join('');
    const sel = order.filter(o => o.on).map(o => o.f.media), w = sh.querySelector('#jw'), mixed = sel.some(m => !!m.v) !== sel.every(m => !!m.v);
    w.hidden = !(sel.length >= 2 && (mixed || (S.prec === 'copy' && S.fmt === 'same' && !sameTracks(sel))));
    w.textContent = mixed ? 'Some of these have a picture and some do not; only their sound can be joined (choose “Sound only”).' : 'These files differ in format or settings, so they cannot be joined untouched; they will be joined exactly (re-encoded where needed).';
    sh.querySelector('#jGo').disabled = sel.length < 2;
  };
  draw();
  sh.querySelector('#jl').addEventListener('click', e => { const u = e.target.dataset.u, d = e.target.dataset.d, c = e.target.dataset.c; if (u != null) { const i = +u; [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); } else if (d != null) { const i = +d; [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); } else if (c != null) { order[+c].on = e.target.checked; draw(); } });
  sh.querySelector('#jClose').addEventListener('click', closeSheet);
  sh.querySelector('#jGo').addEventListener('click', () => {
    const sel = order.filter(o => o.on).map(o => o.f.media), anyV = sel.some(m => m.v), allV = sel.every(m => m.v);
    let tracks = S.tracks; if (!allV) tracks = 'audio'; if (anyV && !allV && S.tracks !== 'audio') { toast('Some files have no picture: joining their sound only.', 5000); }
    const prec = S.prec === 'copy' && sameTracks(sel) ? 'copy' : 'exact', base = sel[0].name;
    closeSheet(); startExport([{ label: `${base} + ${sel.length - 1} more`, spec: { precision: prec, tracks, format: S.fmt, ranges: sel.map(m => ({ media: m, t0: 0, t1: m.duration })), fileName: ext => `${base} + ${sel.length - 1} more (joined)${ext}` } }], 'Joining files');
  });
});

/* ---------- split the whole file ---------- */
$('#splitBtn').addEventListener('click', () => {
  if (!cur) return toast('Open a file first.'); const m = cur.media, video = !!m.v;
  const sh = openSheet(`<h3>Split the file into parts</h3><p class="lead">This replaces the parts you have (Ctrl Z brings them back).</p>
    <div class="opts">
      <label class="opt"><input type="radio" name="how" value="equal" checked><span class="t">Into equal parts</span><span class="s"><input type="number" id="spN" min="2" max="999" value="3"> parts of about <b id="spNl"></b></span></label>
      <label class="opt"><input type="radio" name="how" value="every"><span class="t">Every so often</span><span class="s">a part every <input id="spEvery" value="00:10:00${video ? ':00' : '.00'}"> (the last one takes what is left)</span></label>
      <label class="opt"><input type="radio" name="how" value="silence" ${m.a ? '' : 'disabled'}><span class="t">At the silences</span><span class="s">quieter than <input type="number" id="spDb" min="-80" max="-10" value="-40"> dB for at least <input type="number" id="spMin" min="0.1" max="30" step="0.1" value="0.8"> s. The silences are left out.</span></label>
      ${video ? `<label class="opt"><input type="radio" name="how" value="scene"><span class="t">At the scene changes</span><span class="s">sensitivity <input type="range" id="spSens" min="0" max="100" value="50" style="width:140px;accent-color:var(--accent)"> (reads every frame; a long video takes a while)</span></label>` : ''}
    </div><div class="bar" id="spBar" hidden><i></i></div><div class="hint" id="spSt"></div>
    <div class="acts"><button id="spClose">Close</button><span class="sp"></span><button class="primary" id="spGo">Make the parts</button></div>`);
  const ev = timeBox(sh.querySelector('#spEvery'), { onValue: () => {} });
  const nl = () => { sh.querySelector('#spNl').textContent = C.fmtLength(dur() / Math.max(2, +sh.querySelector('#spN').value || 2)); }; nl(); sh.querySelector('#spN').addEventListener('input', nl);
  for (const el of sh.querySelectorAll('.opt input:not([type=radio])')) el.addEventListener('focus', () => { el.closest('.opt').querySelector('input[type=radio]').checked = true; });
  let busy = null; sh.querySelector('#spClose').addEventListener('click', () => { if (busy) busy.cancel = true; closeSheet(); });
  sh.querySelector('#spGo').addEventListener('click', async () => {
    const how = sh.querySelector('input[name=how]:checked').value, D = dur(), F = fps(), st = sh.querySelector('#spSt'), barW = sh.querySelector('#spBar'), bar = barW.querySelector('i');
    let parts = null;
    if (how === 'equal') parts = C.splitEqual(0, D, Math.max(2, Math.min(999, +sh.querySelector('#spN').value || 2)), F);
    else if (how === 'every') { const e = C.parseTime(sh.querySelector('#spEvery').value, F); if (!(e > 0)) return toast('Type how long each part should be.'); if (D / e > 2000) return toast('That would make more than 2,000 parts.'); parts = C.splitEvery(0, D, e, F); }
    else {
      busy = { cancel: false }; const my = busy; sh.querySelector('#spGo').disabled = true; barW.hidden = false;
      try {
        if (how === 'silence') {
          st.textContent = 'Listening for silences…'; const minS = Math.max(0.1, +sh.querySelector('#spMin').value || 0.8);
          let pk = cur.peaks?.done && cur.peaks.bucketSec <= minS / 6 ? cur.peaks : null;
          if (!pk) pk = await m.peaks(Math.min(2e6, Math.ceil(D / Math.min(0.05, minS / 6))), 0, D, (p, upTo) => { bar.style.width = Math.round(upTo / D * 100) + '%'; }, () => my.cancel);
          if (!pk) return; const sil = C.findSilences(pk, +sh.querySelector('#spDb').value || -40, minS); parts = C.partsBetweenSilences(sil, D, 0.15, F);
          if (!sil.length) { st.textContent = 'No silence that long and that quiet was found. Try a higher level (say −30 dB) or a shorter length.'; return; }
        } else {
          st.textContent = 'Reading every frame…'; const diffs = await m.frameDiffs(v => { bar.style.width = Math.round(v * 100) + '%'; st.textContent = `Reading every frame… ${Math.round(v * 100)}%`; }, () => my.cancel);
          if (!diffs) return; const cuts = C.sceneCuts(diffs, (+sh.querySelector('#spSens').value || 50) / 100); if (!cuts.length) { st.textContent = 'No scene changes were found. Try a higher sensitivity.'; return; } parts = C.splitAtPoints(0, D, cuts, F);
        }
      } finally { busy = null; const g = sh.querySelector('#spGo'); if (g) g.disabled = false; }
    }
    if (!parts || !parts.length) return; closeSheet(); commit(parts, `${parts.length} parts made.`); sel = null; setView(0, D);
  });
});

/* ---------- list menu, snapshot ---------- */
$('#listBtn').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.right - 220, r.bottom + 6, [
    ['Save the list as a spreadsheet (.csv)', async () => { if (!cur || !cur.parts.length) return toast('There are no parts to save.'); await saveFile(new File([C.partsToCsv(cur.parts, fps())], `${cur.media.name} parts.csv`, { type: 'text/csv' }), `${cur.media.name} parts.csv`); toast('The list was saved.'); }],
    ['Load a list (.csv)…', () => { if (!cur) return toast('Open a file first.'); const i = document.createElement('input'); i.type = 'file'; i.accept = '.csv,.txt,text/csv'; i.onchange = async () => { const f = i.files[0]; if (!f) return; const parts = C.partsFromCsv(await f.text(), dur(), fps()); if (!parts.length) return toast('No start and end times were found in that file.', 5000); commit(parts, `${parts.length} parts loaded.`); }; i.click(); }],
    ['Remove all parts', () => { if (cur && cur.parts.length) commit([], 'All parts removed (Ctrl Z brings them back).'); }],
  ]);
});
async function snapshot() {
  if (!cur || !cur.media.v || !cur.media.video.canDecode) return toast('There is no picture to save.'); const f = await cur.media.frame(ph); if (!f) return;
  const blob = await new Promise(r => f.canvas.convertToBlob ? f.canvas.convertToBlob({ type: 'image/png' }).then(r) : f.canvas.toBlob(r, 'image/png'));
  const name = `${cur.media.name} ${C.fmtTime(ph, fps()).replace(/:/g, '.')}.png`, s = await saveFile(new File([blob], name, { type: 'image/png' }), name); toast(`Frame saved to ${s.where}.`);
}
$('#snapBtn').addEventListener('click', snapshot);

/* ---------- sheets and menus ---------- */
let sheetClose = null;
function openSheet(html, { onClose } = {}) { const w = $('#sheet'); w.hidden = false; w.innerHTML = `<div class="sheet" role="dialog">${html}</div>`; sheetClose = onClose || null; return w.querySelector('.sheet'); }
function closeSheet() { const w = $('#sheet'); if (exporting) return; w.hidden = true; w.innerHTML = ''; const f = sheetClose; sheetClose = null; f && f(); }
$('#sheet').addEventListener('pointerdown', e => { if (e.target.id === 'sheet' && !exporting) closeSheet(); });
let menuEl = null;
function menu(x, y, items, above = false) {
  closeMenu(); menuEl = document.createElement('div'); menuEl.className = 'menu'; menuEl.innerHTML = items.map((it, i) => `<button data-m="${i}">${esc(it[0])}</button>`).join(''); document.body.appendChild(menuEl);
  const h = menuEl.offsetHeight, w = menuEl.offsetWidth; menuEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + 'px'; menuEl.style.top = Math.max(8, above ? y - h : y) + 'px';
  menuEl.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; const f = items[+b.dataset.m][1]; closeMenu(); f(); });
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
}
function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } document.removeEventListener('pointerdown', outside); }
$('#helpBtn').addEventListener('click', help);
function help() {
  const sh = openSheet(`<h3>Keys and tips</h3><div class="keys">
    <kbd>Space</kbd><span>Play / pause</span><kbd>P</kbd><span>Play the selected part</span>
    <kbd>← →</kbd><span>One frame back / forward (Shift: one second; Ctrl: ten seconds)</span><kbd>[ ]</kbd><span>Previous / next keyframe</span>
    <kbd>Home End</kbd><span>Start / end of the file</span><kbd>N</kbd><span>A new part at the playhead</span>
    <kbd>I O</kbd><span>The selected part starts / ends at the playhead</span><kbd>B</kbd><span>Split the part under the playhead</span>
    <kbd>↑ ↓</kbd><span>Select the previous / next part</span><kbd>Delete</kbd><span>Remove the selected part</span>
    <kbd>Ctrl Z</kbd><span>Undo (Ctrl Y or Ctrl Shift Z: redo)</span><kbd>+ − 0</kbd><span>Zoom in / out / whole file</span>
    <kbd>S</kbd><span>Save the frame at the playhead as a picture</span><kbd>E</kbd><span>Export</span></div>
    <p class="lead" style="margin-top:14px"><b>Mouse:</b> drag across the timeline to mark a part; drag a part's edges to change it (they stick to the playhead and to keyframes; hold Alt to stop that); the wheel zooms, Shift + wheel moves along.</p>
    <p class="lead"><b>Exact or untouched.</b> Exact cuts where you marked: for H.264 video only the few frames at each edge are re-encoded and the rest is copied as it is. Untouched re-encodes nothing, in any format, but a video cut can only start and end on keyframes (the orange ticks), so it widens to them.</p>
    <p class="lead">Nothing leaves this computer: files are read and written in the browser. Built on mediabunny (MPL-2.0).</p>
    <div class="acts"><span class="sp"></span><button class="primary" id="hClose">Close</button></div>`);
  sh.querySelector('#hClose').addEventListener('click', closeSheet);
}

/* ---------- keys ---------- */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (menuEl) closeMenu(); else if (!$('#sheet').hidden) closeSheet(); return; }
  const tag = e.target.tagName; if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !$('#sheet').hidden) return;
  if (e.key === '?') { help(); e.preventDefault(); return; }
  if (!cur) return; const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (k === 'z' || k === 'Z')) { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }
  if (ctrl && (k === 'y' || k === 'Y')) { redo(); e.preventDefault(); return; }
  if (ctrl && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  const keyAt = dir => { const ks = cur.keys || []; if (dir < 0) { for (let i = ks.length - 1; i >= 0; i--) if (ks[i] < ph - 1e-4) return ks[i]; return 0; } for (const x of ks) if (x > ph + 1e-4) return x; return dur(); };
  const acts = {
    ' ': togglePlay, ArrowLeft: () => { movePH(ph - (ctrl ? 10 : e.shiftKey ? 1 : step())); revealT(ph); }, ArrowRight: () => { movePH(ph + (ctrl ? 10 : e.shiftKey ? 1 : step())); revealT(ph); },
    Home: () => { movePH(0); revealT(0); }, End: () => { movePH(dur()); revealT(dur()); }, '[': () => { movePH(keyAt(-1)); revealT(ph); }, ']': () => { movePH(keyAt(1)); revealT(ph); },
    i: markStart, o: markEnd, b: splitAtPlayhead, n: newPartAtPlayhead, s: snapshot, e: () => $('#exportBtn').click(),
    p: () => { const q = cur.parts.find(x => x.id === sel); if (q) playRange(q.t0, q.t1); else togglePlay(); },
    Delete: () => { if (sel) commit(C.removePart(cur.parts, sel)); }, Backspace: () => { if (sel) commit(C.removePart(cur.parts, sel)); },
    ArrowUp: () => { const i = cur.parts.findIndex(x => x.id === sel), q = cur.parts[Math.max(0, i < 0 ? 0 : i - 1)]; if (q) { sel = q.id; markSel(); movePH(q.t0); revealPart(q); rows.get(sel)?.el.scrollIntoView({ block: 'nearest' }); } },
    ArrowDown: () => { const i = cur.parts.findIndex(x => x.id === sel), q = cur.parts[Math.min(cur.parts.length - 1, i + 1)]; if (q) { sel = q.id; markSel(); movePH(q.t0); revealPart(q); rows.get(sel)?.el.scrollIntoView({ block: 'nearest' }); } },
    '+': () => zoomAt(ph, 0.5), '=': () => zoomAt(ph, 0.5), '-': () => zoomAt(ph, 2), '0': () => setView(0, dur()),
  };
  const f = acts[k] || acts[k.toLowerCase()]; if (f) { e.preventDefault(); f(); }
});
document.addEventListener('keyup', e => { if (e.key === ' ' && e.target.tagName === 'BUTTON') e.preventDefault(); });

/* ---------- opening: button, drop, launch from the OS ---------- */
for (const b of ['#openBtn', '#openBtn2']) $(b).addEventListener('click', () => $('#fileIn').click());
$('#fileIn').addEventListener('change', e => { openFiles(e.target.files); e.target.value = ''; });
let dragN = 0;
addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragN++; $('#dropveil').hidden = false; } });
addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) $('#dropveil').hidden = true; });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragN = 0; $('#dropveil').hidden = true; if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files); });
if ('launchQueue' in window) launchQueue.setConsumer(async p => { const fs = await Promise.all((p.files || []).map(h => h.getFile())); if (fs.length) openFiles(fs); });
addEventListener('beforeunload', e => { if (exporting) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- inside another app (Mixtape): its library in, finished cuts back out ---------- */
const host = window.CUTTER_HOST || null;
if (host) {
  const back = document.createElement('a'); back.className = 'hostback'; back.href = host.backHref; back.title = `Back to ${host.name}`; back.textContent = `← ${host.name}`; $('.brand').before(back);
  const lb = document.createElement('button'); lb.id = 'libBtn'; lb.textContent = 'From my library'; lb.title = `Open a song or video from your ${host.name} library`; $('#openBtn').after(lb); lb.addEventListener('click', openLibrary);
  const lb2 = lb.cloneNode(true); lb2.id = 'libBtn2'; $('#openBtn2').after(lb2); lb2.addEventListener('click', openLibrary);
  const id = new URLSearchParams(location.search).get('song');
  if (id) host.getSong(id).then(f => { if (f) openFiles([f], { show: true }); else toast('That song is no longer in the library.'); }).catch(e => toast(e.message || String(e), 5000));
}
async function openLibrary() {
  let songs; try { songs = await host.listSongs(); } catch (e) { return toast(`Could not read the ${host.name} library: ${e.message || e}`, 6000); }
  if (!songs.length) return toast(`Your ${host.name} library is empty.`);
  const sh = openSheet(`<h3>From my library</h3><input id="libQ" class="libq" type="search" placeholder="Search songs and videos" aria-label="Search the library" autocomplete="off"><div class="liblist" id="libL"></div><div class="acts"><span class="sp"></span><button id="libClose">Close</button></div>`);
  const draw = q => { q = (q || '').toLowerCase(); sh.querySelector('#libL').innerHTML = songs.filter(x => !q || `${x.title} ${x.artist} ${x.album}`.toLowerCase().includes(q)).slice(0, 300).map(x => `<button class="librow" data-id="${esc(x.id)}"><span class="k">${x.video ? '▣' : '♪'}</span><span class="t">${esc(x.title)}${x.artist ? `<small>${esc(x.artist)}</small>` : ''}</span><span class="d">${x.duration ? C.fmtTime(x.duration) : ''}</span></button>`).join('') || '<p class="hint">Nothing matches.</p>'; };
  draw(''); const q = sh.querySelector('#libQ'); q.addEventListener('input', () => draw(q.value)); setTimeout(() => q.focus(), 0);
  sh.querySelector('#libClose').addEventListener('click', closeSheet);
  sh.querySelector('#libL').addEventListener('click', async e => { const b = e.target.closest('[data-id]'); if (!b) return; const f = await host.getSong(b.dataset.id); closeSheet(); if (f) openFiles([f], { show: true }); });
}

/* ---------- start ---------- */
writableTargets().then(t => { targets = t; updateExportBar(); }).catch(() => {});
updateExportBar(); renderParts(); sizeCanvases();
if ('serviceWorker' in navigator && !host && !document.querySelector('base') && location.protocol !== 'file:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) navigator.serviceWorker.register('sw.js').catch(() => {});
// for tests on this computer only
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__cutter = { files, openFiles, get cur() { return cur; }, get ph() { return ph; }, movePH, get sel() { return sel; }, set sel(v) { sel = v; markSel(); dirty(); }, commit, C, get view() { return view; }, setView, S };
