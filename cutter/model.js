/* Cutter's model: times, parts and the ways of splitting a file into parts. Pure: no browser, no media, so every rule
   here is checked in Node (check.mjs). Times are seconds (floats); a video's times sit on its frame grid. */

export const EPS = 1e-6;

/* ---------- times ---------- */
const pad = (n, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, '0');
/* hh:mm:ss:ff for a video (ff = frame), hh:mm:ss.cc for sound (cc = hundredths). */
export function fmtTime(s, fps = null) {
  s = Math.max(0, s || 0);
  if (fps) { const f = Math.round(s * fps), per = Math.round(fps), ff = f % per, whole = Math.floor(f / per); return `${pad(whole / 3600)}:${pad(whole / 60 % 60)}:${pad(whole % 60)}:${pad(ff)}`; }
  const cs = Math.round(s * 100), whole = Math.floor(cs / 100); return `${pad(whole / 3600)}:${pad(whole / 60 % 60)}:${pad(whole % 60)}.${pad(cs % 100)}`;
}
/* A short, friendly length: "2 h 05 min", "4 min 12 s", "12.4 s". */
export function fmtLength(s) {
  s = Math.max(0, s || 0); if (s < 60) return `${s < 10 ? s.toFixed(2).replace(/\.?0+$/, '') : s.toFixed(1).replace(/\.0$/, '')} s`;
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = Math.round(s % 60);
  return h ? `${h} h ${pad(m)} min` : `${m} min ${pad(x)} s`;
}
/* Reads what people type: "1:02:03", "62", "90.5", "1:02.25", "00:01:02:12" (with fps), "1h2m3s", "10m", "45s". */
export function parseTime(str, fps = null) {
  if (str == null) return null; const t = String(str).trim().toLowerCase(); if (!t) return null;
  const units = t.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/);
  if (units && (units[1] || units[2] || units[3])) return (+units[1] || 0) * 3600 + (+units[2] || 0) * 60 + (+units[3] || 0);
  if (!/^[\d:.]+$/.test(t)) return null;
  const parts = t.split(':'); if (parts.some(p => p === '' || isNaN(+p))) return null;
  if (parts.length === 4) { const [h, m, s, f] = parts.map(Number); return h * 3600 + m * 60 + s + (fps ? f / Math.round(fps) : 0); }
  if (parts.length > 4) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}
/* The frame grid. */
export const snapFrame = (t, fps) => fps ? Math.round(t * fps) / fps : t;
export const minPart = fps => fps ? 1 / fps : 0.01;
/* Where a cut that copies whole groups of frames really starts and ends: the keyframe at or before the start, and the
   keyframe at or after the end (or the end of the file). keys: sorted keyframe times. */
export function copyRange(t0, t1, keys, duration) {
  if (!keys || !keys.length) return { t0, t1, moved: false };
  let a = keys[0]; for (const k of keys) { if (k <= t0 + EPS) a = k; else break; }
  let b = duration; if (t1 < duration - EPS) for (const k of keys) { if (k >= t1 - EPS) { b = k; break; } }
  return { t0: a, t1: b, moved: Math.abs(a - t0) > 1e-3 || Math.abs(b - t1) > 1e-3 };
}

/* ---------- parts ---------- */
let seq = 0;
export const newId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;
export const COLOURS = ['#F2C14E', '#5BC0BE', '#F28AB2', '#A3D65C', '#FF8C5A', '#9D8CFF', '#56CCF2', '#E8E36B'];
/* A part: { id, t0, t1, name }. clampPart keeps it inside the file, on the frame grid, and at least one frame long. */
export function clampPart(p, duration, fps = null) {
  const m = minPart(fps); let t0 = snapFrame(Math.max(0, Math.min(duration - m, p.t0)), fps), t1 = snapFrame(Math.max(0, Math.min(duration, p.t1)), fps);
  if (t1 > duration) t1 = duration; if (t1 - t0 < m - EPS) t1 = Math.min(duration, t0 + m); if (t1 - t0 < m - EPS) t0 = Math.max(0, t1 - m);
  return { ...p, t0, t1 };
}
export function addPart(parts, t0, t1, duration, fps = null, name = '') {
  const p = clampPart({ id: newId(), t0: Math.min(t0, t1), t1: Math.max(t0, t1), name }, duration, fps);
  return sortParts([...parts, p]);
}
export const sortParts = parts => parts.slice().sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
export function updatePart(parts, id, change, duration, fps = null) {
  return parts.map(p => p.id === id ? clampPart({ ...p, ...change }, duration, fps) : p);
}
/* Start and end typed into the boxes: a start past the end pushes the end along by the part's length; an end before the
   start pulls the start back. A length moves the end. */
export function setStart(parts, id, t, duration, fps = null) {
  const p = parts.find(x => x.id === id); if (!p) return parts; const len = p.t1 - p.t0;
  return updatePart(parts, id, t < p.t1 - EPS ? { t0: t } : { t0: t, t1: t + len }, duration, fps);
}
export function setEnd(parts, id, t, duration, fps = null) {
  const p = parts.find(x => x.id === id); if (!p) return parts; const len = p.t1 - p.t0;
  return updatePart(parts, id, t > p.t0 + EPS ? { t1: t } : { t0: Math.max(0, t - len), t1: t }, duration, fps);
}
export function setLength(parts, id, len, duration, fps = null) {
  const p = parts.find(x => x.id === id); if (!p) return parts;
  return updatePart(parts, id, { t1: p.t0 + Math.max(minPart(fps), len) }, duration, fps);
}
export const removePart = (parts, id) => parts.filter(p => p.id !== id);
/* Cuts the part that holds t in two at t (on the frame grid). */
export function splitPartAt(parts, t, duration, fps = null) {
  t = snapFrame(t, fps); const m = minPart(fps), p = parts.find(x => t > x.t0 + m / 2 && t < x.t1 - m / 2); if (!p) return parts;
  const a = { ...p, t1: t }, b = { ...p, id: newId(), t0: t, name: p.name ? `${p.name} (2)` : '' };
  return sortParts([...parts.filter(x => x.id !== p.id), a, b]);
}
/* Moves a part in the output order (for joining), without changing its times. */
export function movePart(parts, id, to) {
  const i = parts.findIndex(p => p.id === id); if (i < 0) return parts; const out = parts.slice(), [p] = out.splice(i, 1); out.splice(Math.max(0, Math.min(out.length, to)), 0, p); return out;
}
/* Overlapping or touching ranges merged, in time order. */
export function mergeRanges(ranges) {
  const r = ranges.map(x => ({ t0: x.t0, t1: x.t1 })).filter(x => x.t1 > x.t0 + EPS).sort((a, b) => a.t0 - b.t0), out = [];
  for (const x of r) { const last = out[out.length - 1]; if (last && x.t0 <= last.t1 + EPS) last.t1 = Math.max(last.t1, x.t1); else out.push({ ...x }); }
  return out;
}
/* "Cut these parts out": what is left of the file. */
export function invertRanges(parts, duration, fps = null) {
  const m = mergeRanges(parts), out = []; let at = 0;
  for (const x of m) { if (x.t0 > at + minPart(fps) / 2) out.push({ t0: at, t1: x.t0 }); at = Math.max(at, x.t1); }
  if (duration > at + minPart(fps) / 2) out.push({ t0: at, t1: duration });
  return out;
}
/* What gets exported: a list of { t0, t1, name, index } per mode. 'keep' keeps the parts in list order; 'remove' keeps
   what is between them (in time order). */
export function exportRanges(parts, mode, duration, fps = null) {
  if (mode === 'remove') return invertRanges(parts, duration, fps).map((r, i) => ({ ...r, name: '', index: i + 1 }));
  return parts.map((p, i) => ({ t0: p.t0, t1: p.t1, name: p.name || '', index: i + 1 }));
}
export const totalLength = ranges => ranges.reduce((s, r) => s + Math.max(0, r.t1 - r.t0), 0);

/* ---------- ways of splitting ---------- */
/* n equal parts of [a, b) on the frame grid. */
export function splitEqual(a, b, n, fps = null) {
  n = Math.max(1, Math.floor(n)); const out = [];
  for (let i = 0; i < n; i++) out.push({ id: newId(), t0: snapFrame(a + (b - a) * i / n, fps), t1: i === n - 1 ? b : snapFrame(a + (b - a) * (i + 1) / n, fps), name: '' });
  return out.filter(p => p.t1 > p.t0 + EPS);
}
/* Parts every `every` seconds of [a, b); the last one takes what is left. */
export function splitEvery(a, b, every, fps = null) {
  if (!(every > 0)) return []; const out = [];
  for (let t = a; t < b - EPS; t += every) { const t0 = snapFrame(t, fps), t1 = Math.min(b, snapFrame(t + every, fps)); if (t1 > t0 + EPS) out.push({ id: newId(), t0, t1, name: '' }); }
  return out;
}
/* Parts between the given cut points. */
export function splitAtPoints(a, b, points, fps = null) {
  const cuts = [...new Set(points.map(t => snapFrame(t, fps)).filter(t => t > a + EPS && t < b - EPS))].sort((x, y) => x - y), edges = [a, ...cuts, b], out = [];
  for (let i = 0; i < edges.length - 1; i++) if (edges[i + 1] > edges[i] + EPS) out.push({ id: newId(), t0: edges[i], t1: edges[i + 1], name: '' });
  return out;
}
/* Silences from the waveform's peaks ({ min, max, bucketSec, t0? }): stretches quieter than thresholdDb for at least
   minSec. Returns [{ t0, t1 }]. */
export function findSilences(peaks, thresholdDb = -40, minSec = 0.8) {
  const { min, max, bucketSec } = peaks, base = peaks.t0 || 0, lim = Math.pow(10, thresholdDb / 20), out = []; let start = -1;
  for (let i = 0; i <= max.length; i++) {
    const quiet = i < max.length && Math.max(Math.abs(min[i]), Math.abs(max[i])) < lim;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) { const t0 = base + start * bucketSec, t1 = base + i * bucketSec; if (t1 - t0 >= minSec - EPS) out.push({ t0, t1 }); start = -1; }
  }
  return out;
}
/* Parts with the silences taken out: each stretch of sound becomes a part (edges padded by `pad` seconds into the
   silence so words are not clipped). */
export function partsBetweenSilences(silences, duration, pad = 0.15, fps = null) {
  const out = []; let at = 0;
  for (const s of silences) { const t0 = Math.max(0, at), t1 = Math.min(duration, s.t0 + pad); if (t1 > t0 + 0.05) out.push({ id: newId(), t0: snapFrame(t0, fps), t1: snapFrame(t1, fps), name: '' }); at = s.t1 - pad; }
  if (duration > at + 0.05) out.push({ id: newId(), t0: snapFrame(Math.max(0, at), fps), t1: duration, name: '' });
  return out;
}
/* Scene changes from a run of frame differences [{ t, d }] (d: 0..1, how different frame t is from the one before).
   A change is a difference well above its neighbours' (sensitivity 0..1: higher finds more), at least minGap apart. */
export function sceneCuts(diffs, sensitivity = 0.5, minGap = 0.5) {
  if (diffs.length < 3) return []; const ds = diffs.map(x => x.d), sorted = ds.slice().sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)] || 0;
  const floor = 0.32 - 0.24 * Math.max(0, Math.min(1, sensitivity)), out = []; let last = -Infinity;
  for (let i = 1; i < diffs.length; i++) { const d = diffs[i].d, local = Math.max(ds[i - 1] || 0, ds[i + 1] || 0); if (d >= floor && d >= med * 4 && d >= local * 1.6 - 1e-9 && diffs[i].t - last >= minGap) { out.push(diffs[i].t); last = diffs[i].t; } }
  return out;
}

/* ---------- names and lists ---------- */
const safe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
const nameTime = s => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = Math.floor(s % 60), cs = Math.round((s % 1) * 100) % 100; return (h ? `${h}.` : '') + `${pad(m)}.${pad(x)}` + (cs ? `.${pad(cs)}` : ''); };
/* "Interview (01.02.03-01.05.00).mp4", or "Interview - Chorus.mp4" when the part has a name. */
export function fileNameFor(base, r, ext, joined = false, count = 1) {
  const b = safe(base) || 'cut';
  if (joined) return `${b} (${count} part${count === 1 ? '' : 's'} joined)${ext}`;
  return r.name ? `${b} - ${safe(r.name)}${ext}` : `${b} (${nameTime(r.t0)}-${nameTime(r.t1)})${ext}`;
}
/* A list of parts as CSV (start, end, name in seconds) and back: for keeping a list or bringing one from a spreadsheet. */
export function partsToCsv(parts, fps = null) {
  const q = s => /[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s;
  return 'start,end,name\n' + parts.map(p => `${fmtTime(p.t0, fps)},${fmtTime(p.t1, fps)},${q(p.name || '')}`).join('\n') + '\n';
}
export function partsFromCsv(text, duration, fps = null) {
  const rows = [], lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim());
  for (const line of lines) {
    const cells = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) { const ch = line[i]; if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; } else if (ch === '"') inQ = true; else if (ch === ',' || ch === '\t' || ch === ';') { cells.push(cur); cur = ''; } else cur += ch; }
    cells.push(cur);
    const a = parseTime(cells[0], fps), b = parseTime(cells[1], fps); if (a == null || b == null) continue; // a header or a broken row
    rows.push(clampPart({ id: newId(), t0: Math.min(a, b), t1: Math.max(a, b), name: (cells[2] || '').trim() }, duration, fps));
  }
  return sortParts(rows);
}
