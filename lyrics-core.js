/* Mixtape lyrics: the rules, with no page and no audio, so every one is checked in Node (node lyrics-check.js).
   A song's lyrics are { lines: [{ text, t, end?, conf?, gap? }] }: t is when the line starts (seconds; null until
   timed), gap marks a blank line before it (a new verse), conf (0..1) how sure an automatic timing is.
   Loaded as a classic script (window.LyricsCore) and by Node (module.exports). */
(function (root) {
  const fmtClock = (s, cs = true) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), x = s - m * 60; return `${String(m).padStart(2, '0')}:${cs ? x.toFixed(2).padStart(5, '0') : String(Math.floor(x)).padStart(2, '0')}`; };
  const fmtSub = (s, sep) => { s = Math.max(0, s || 0); const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60, f = ms % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}${sep}${String(f).padStart(3, '0')}`; };

  /* plain words: one line per line; blank lines start a new verse */
  function fromText(text) {
    const out = []; let gap = false;
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) { const line = raw.trim(); if (!line) { gap = out.length > 0; continue; } out.push({ text: line, t: null, ...(gap ? { gap: true } : {}) }); gap = false; }
    return out;
  }
  const toText = lines => lines.map(l => (l.gap ? '\n' : '') + l.text).join('\n');
  /* "m:ss", "m:ss.cc", "h:mm:ss", "1:02.5", "62.3" → seconds */
  function parseClock(s) {
    s = String(s || '').trim(); if (!s) return null; if (/^\d+(\.\d+)?$/.test(s)) return +s;
    const m = s.match(/^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:[.,]\d+)?)$/); if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3].replace(',', '.'));
  }

  /* ---------- files ---------- */
  function parseLRC(text) {
    const out = []; let offset = 0;
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i); if (off) { offset = +off[1] / 1000; continue; }
      const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)]; if (!tags.length) continue;
      const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
      for (const g of tags) { const t = +g[1] * 60 + parseFloat(g[2].replace(':', '.')); out.push({ text: words, t: Math.max(0, t - offset) }); }
    }
    return out.sort((a, b) => a.t - b.t).filter(l => l.text);
  }
  function parseCues(text) { // SRT and WebVTT
    const out = [], blocks = String(text).replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\n\s*\n/);
    for (const b of blocks) {
      const ls = b.split('\n').filter(x => x.trim()); const i = ls.findIndex(x => /-->/.test(x)); if (i < 0) continue;
      const [a, z] = ls[i].split('-->').map(x => x.trim().split(/\s+/)[0]); const t = parseClock(a.replace(',', '.')), end = parseClock(z.replace(',', '.'));
      const words = ls.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim(); if (t == null || !words) continue;
      out.push({ text: words, t, ...(end != null ? { end } : {}) });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  /* any of .lrc, .srt, .vtt or plain words, by content (and name, when given) */
  function parseAny(text, name = '') {
    const n = String(name).toLowerCase();
    if (/\.lrc$/.test(n) || /^\s*\[(\d{1,3}:\d|ar:|ti:|al:|offset:)/im.test(text)) { const l = parseLRC(text); if (l.length) return { lines: l, kind: 'lrc' }; }
    if (/\.(srt|vtt)$/.test(n) || /-->/.test(text)) { const l = parseCues(text); if (l.length) return { lines: l, kind: /\.vtt$/.test(n) || /^WEBVTT/.test(text) ? 'vtt' : 'srt' }; }
    return { lines: fromText(text), kind: 'text' };
  }
  /* where each line ends: the next line's start, but no line shows longer than `hold` seconds */
  function ends(lines, duration, hold = 6) {
    return lines.map((l, i) => { const nx = lines.slice(i + 1).find(x => x.t != null); const lim = (nx ? nx.t : (duration || l.t + hold)); return Math.max(l.t + 0.3, Math.min(l.end ?? Infinity, lim, l.t + hold)); });
  }
  function toLRC(lines, meta = {}) {
    const head = [meta.title ? `[ti:${meta.title}]` : '', meta.artist ? `[ar:${meta.artist}]` : '', meta.album ? `[al:${meta.album}]` : '', '[re:Mixtape]'].filter(Boolean);
    return head.concat(lines.filter(l => l.t != null).map(l => `[${fmtClock(l.t)}]${l.text}`)).join('\n') + '\n';
  }
  function toSRT(lines, duration) { const L = lines.filter(l => l.t != null), E = ends(L, duration); return L.map((l, i) => `${i + 1}\n${fmtSub(l.t, ',')} --> ${fmtSub(E[i], ',')}\n${l.text}\n`).join('\n'); }
  function toVTT(lines, duration) { const L = lines.filter(l => l.t != null), E = ends(L, duration); return 'WEBVTT\n\n' + L.map((l, i) => `${fmtSub(l.t, '.')} --> ${fmtSub(E[i], '.')}\n${l.text}\n`).join('\n'); }

  /* the line showing at time t (lines in time order; a line shows from its start until the next one) */
  function lineAt(lines, t) { let k = -1; for (let i = 0; i < lines.length; i++) { if (lines[i].t == null) continue; if (lines[i].t <= t + 0.05) k = i; else break; } return k; }
  const timed = lines => lines.length > 0 && lines.every(l => l.t != null);

  /* ---------- automatic timing: your words, matched to the words the recogniser heard ---------- */
  const norm = w => String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '');
  const tokens = text => String(text).split(/[\s\-–—/]+/).map(norm).filter(Boolean);
  function similar(a, b) {
    if (a === b) return 1; if (!a || !b) return 0;
    if (a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a))) return 0.8; // singin / singing
    const m = a.length, n = b.length; if (Math.abs(m - n) > 3) return 0; let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    const s = 1 - prev[n] / Math.max(m, n); return s >= 0.6 ? s : 0;
  }
  /* lines: [{text}], words: [{ text, start, end }] in time order → lines with t and conf. Global alignment
     (Needleman-Wunsch) of the two word lists, so repeated choruses keep their order; each line starts at its first
     matched word, less the time its unmatched leading words take; lines nothing matched are placed in proportion
     between their neighbours. */
  function align(linesIn, wordsIn, duration) {
    const lines = linesIn.map(l => ({ ...l })); const L = []; lines.forEach((l, li) => tokens(l.text).forEach((w, k) => L.push({ w, li, k })));
    const W = wordsIn.map(x => ({ w: norm(x.text), start: x.start, end: x.end ?? x.start })).filter(x => x.w);
    const n = L.length, m = W.length; if (!n) return lines;
    const GAP_L = -0.4, GAP_W = -0.25; // a lyric word the recogniser missed costs more than an extra heard word (ad libs, repeats)
    const S = new Float32Array((n + 1) * (m + 1)), B = new Uint8Array((n + 1) * (m + 1)); const at = (i, j) => i * (m + 1) + j;
    for (let i = 1; i <= n; i++) { S[at(i, 0)] = i * GAP_L; B[at(i, 0)] = 1; } for (let j = 1; j <= m; j++) { S[at(0, j)] = j * GAP_W; B[at(0, j)] = 2; }
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const sim = similar(L[i - 1].w, W[j - 1].w), d = S[at(i - 1, j - 1)] + (sim ? 2 * sim : -0.6), u = S[at(i - 1, j)] + GAP_L, l = S[at(i, j - 1)] + GAP_W;
      if (d >= u && d >= l) { S[at(i, j)] = d; B[at(i, j)] = sim ? 3 : 0; } else if (u >= l) { S[at(i, j)] = u; B[at(i, j)] = 1; } else { S[at(i, j)] = l; B[at(i, j)] = 2; }
    }
    const match = new Array(n).fill(-1); for (let i = n, j = m; i > 0 || j > 0;) { const b = B[at(i, j)]; if (i > 0 && j > 0 && (b === 3 || b === 0)) { if (b === 3) match[i - 1] = j - 1; i--; j--; } else if (i > 0 && (b === 1 || j === 0)) i--; else j--; }
    // per line: start from its first matched word; confidence = share of its words matched
    const perWord = W.length > 1 ? Math.max(0.15, Math.min(0.6, (W[W.length - 1].end - W[0].start) / W.length)) : 0.35;
    const byLine = lines.map(() => ({ n: 0, hit: 0, first: null, hits: [] }));
    L.forEach((x, i) => { const b = byLine[x.li]; b.n++; if (match[i] >= 0) { b.hit++; b.hits.push({ k: x.k, t: W[match[i]].start }); } });
    // the line's first word must fit the words after it: the recogniser sometimes stamps a song's first word at the very
    // start, under the intro; a word that comes far too early for its neighbours is passed over
    for (const b of byLine) { const h = b.hits; for (let j = 0; j < h.length; j++) { const nx = h[j + 1]; if (!nx || nx.t - h[j].t <= 1.2 + 0.7 * (nx.k - h[j].k)) { b.first = h[j]; break; } } }
    lines.forEach((l, li) => { const b = byLine[li]; l.conf = b.n ? +(b.hit / b.n).toFixed(2) : 0; l.t = b.first && b.hit / b.n >= 0.25 ? Math.max(0, b.first.t - b.first.k * perWord) : null; });
    // keep the order: a line cannot start before the one above it
    for (let i = 1; i < lines.length; i++) if (lines[i].t != null) { let p = i - 1; while (p >= 0 && lines[p].t == null) p--; if (p >= 0 && lines[i].t <= lines[p].t) { if (lines[i].conf >= lines[p].conf) lines[p].t = null; else lines[i].t = null; } }
    fill(lines, duration);
    return lines;
  }
  /* lines with no time are placed between their timed neighbours, in proportion to their length */
  function fill(lines, duration) {
    const len = l => Math.max(1, tokens(l.text).length);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t != null) continue; let j = i; while (j < lines.length && lines[j].t == null) j++;
      const a = i > 0 ? lines[i - 1] : null, b = j < lines.length ? lines[j] : null;
      const t0 = a ? a.t + len(a) * 0.35 : (b ? Math.max(0, b.t - (j - i) * 3) : 0), t1 = b ? b.t : (duration || t0 + (j - i) * 3);
      const weights = lines.slice(i, j).map(len), tot = weights.reduce((x, y) => x + y, 0) + (b ? 0 : 0); let acc = 0;
      for (let k = i; k < j; k++) { lines[k].t = +(Math.min(t1 - 0.05, t0 + (t1 - t0) * acc / Math.max(1, tot))).toFixed(2); lines[k].conf = 0; acc += weights[k - i]; }
      i = j;
    }
    return lines;
  }
  /* the recogniser's words as draft lyrics: a new line at every pause longer than `pause` seconds (or after 10 words) */
  function draftFromWords(words, pause = 0.6) {
    const out = []; let cur = null;
    for (const w of words) { const txt = String(w.text).trim(); if (!txt) continue; if (!cur || w.start - cur.endT > pause || cur.n >= 10) { if (cur) out.push({ text: cur.text, t: cur.t, conf: 1 }); cur = { text: txt, t: w.start, endT: w.end ?? w.start, n: 1 }; } else { cur.text += ' ' + txt; cur.endT = w.end ?? w.start; cur.n++; } }
    if (cur) out.push({ text: cur.text, t: cur.t, conf: 1 });
    return out;
  }

  const api = { fromText, toText, parseClock, fmtClock, parseLRC, parseCues, parseAny, toLRC, toSRT, toVTT, ends, lineAt, timed, tokens, similar, align, fill, draftFromWords };
  root.LyricsCore = api; if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
