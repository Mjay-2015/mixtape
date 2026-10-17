/* Mixtape transcripts: the rules, with no page and no audio (checked by node transcript-check.cjs).
   A transcript is a list of words: { t: text as shown (with its punctuation), s: start, e: end (seconds), p?: true when
   the word opens a paragraph, sp?: the speaker's name, on a paragraph's first word }.
   Loaded as a classic script (window.TranscriptCore) and by Node; uses LyricsCore's word matching. */
(function (root) {
  const LC = root.LyricsCore;
  const pad = n => String(n).padStart(2, '0');
  const hms = s => { s = Math.max(0, Math.floor(s || 0)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
  const short = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600); return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const sub = (s, sep) => { const ms = Math.round(Math.max(0, s) * 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${String(ms % 1000).padStart(3, '0')}`; };
  const endsSentence = t => /[.!?]["')\]]?$/.test(t);

  /* the recogniser sometimes stretches a word back over the silence (or music) before it: the first word after an intro
     reads 0.4 s → 6.3 s, then the next word starts at 6.3. Such a word starts just before it ends. */
  function tidyHeard(heard) {
    return heard.map((h, i) => { const e = h.end ?? h.start, nx = heard[i + 1]; return e - h.start > 1.5 && nx && nx.start - e < 0.15 ? { ...h, start: +(e - 0.35).toFixed(3) } : h; });
  }
  /* heard words → transcript words, with paragraphs where the speaker pauses (a long pause, or a sentence end after a
     shorter one), or when a paragraph runs long */
  function fromHeard(heard, opts = {}) {
    const longPause = opts.longPause ?? 1.4, sentencePause = opts.sentencePause ?? 0.7, maxWords = opts.maxWords ?? 90;
    const out = []; let n = 0;
    let spk = opts.lastSpeaker || '';
    tidyHeard(heard).forEach((h, i) => {
      const text = String(h.text).trim(); if (!text) return;
      const prev = out[out.length - 1], gap = prev ? h.start - prev.e : Infinity, who = h.spk || spk;
      // a new speaker always starts a new paragraph
      const brk = !prev || (who && who !== spk) || gap >= longPause || (gap >= sentencePause && endsSentence(prev.t)) || (n >= maxWords && endsSentence(prev.t)) || n >= maxWords * 1.6;
      const w = { t: text, s: +h.start.toFixed(3), e: +Math.max(h.start, h.end ?? h.start).toFixed(3) };
      if (h.c != null) w.c = +h.c.toFixed(2);
      if (brk) { w.p = true; n = 0; if (who) w.sp = who; }
      spk = who; out.push(w); n++;
    });
    return out;
  }
  /* new heard words added after the ones already there (a transcript that grows as it is made, or is continued) */
  function append(words, heard, opts = {}) {
    const lastSpeaker = speakerAt(words, words.length - 1);
    const more = fromHeard(heard, { ...opts, lastSpeaker }); if (!words.length) return more;
    if (more.length) {
      const last = words[words.length - 1], gap = more[0].s - last.e, sameSpeaker = !more[0].sp || more[0].sp === lastSpeaker;
      if (sameSpeaker && !(gap >= (opts.longPause ?? 1.4) || (gap >= 0.7 && endsSentence(last.t)))) { delete more[0].p; delete more[0].sp; }
      else if (more[0].p && !more[0].sp && lastSpeaker) more[0].sp = lastSpeaker; // a new paragraph by the same speaker keeps the name
    }
    return words.concat(more);
  }
  /* the speaker of word i: the name on its paragraph's first word */
  function speakerAt(words, i) { for (let k = i; k >= 0; k--) if (words[k].p || k === 0) return words[k].sp || ''; return ''; }

  /* ---- speakers ---- */
  /* heard words get the speaker of the turn they overlap most (turns: [{ s, e, name }]); a word in no turn keeps the
     speaker of the word before (a breath, a short word between turns) */
  function labelHeard(heard, turns) {
    let prev = '';
    return heard.map(h => {
      const s = h.start, e = Math.max(h.end ?? s, s + 0.05); let best = null, ov = 0;
      for (const t of turns) { if (!t.name) continue; const o = Math.min(e, t.e) - Math.max(s, t.s); if (o > ov) { ov = o; best = t; } }
      if (!best) { let d = Infinity; for (const t of turns) { if (!t.name) continue; const dd = Math.min(Math.abs(t.s - s), Math.abs(t.e - s)); if (dd < d && dd < 0.6) { d = dd; best = t; } } }
      const spk = best ? best.name : prev; prev = spk; return spk ? { ...h, spk } : h;
    });
  }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const unit = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
  /* a voice (a speaker embedding) matched to the voices met so far: the closest one when it is close enough, otherwise
     a new speaker. voices: [{ name, c: centroid, n }] is updated (the centroid drifts toward each voice it takes in). */
  function clusterVoice(voices, emb, threshold = 0.35) {
    const e = unit(Array.from(emb)); let best = null, sim = -1;
    for (const v of voices) { const s = dot(v.c, e); if (s > sim) { sim = s; best = v; } }
    if (best && sim >= threshold) { best.c = unit(best.c.map((x, i) => x * best.n + e[i])); best.n++; return { name: best.name, sim }; }
    let k = voices.length + 1; while (voices.some(v => v.name === `Speaker ${k}`)) k++;
    const v = { name: `Speaker ${k}`, c: e, n: 1 }; voices.push(v); return { name: v.name, sim, isNew: true };
  }
  /* a speaker renamed everywhere (Rev's way): every paragraph with that name, and the voice it belongs to */
  function renameSpeaker(words, voices, from, to) {
    to = String(to || '').trim(); if (!to || to === from) return words;
    const out = words.map(w => w.sp === from ? { ...w, sp: to } : w); for (const v of voices || []) if (v.name === from) v.name = to; return out;
  }
  const speakerNames = words => [...new Set(words.filter(w => w.sp).map(w => w.sp))];

  /* ---- clean verbatim: fillers, false starts and starters can be hidden ---- */
  const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'uhm']);
  const STARTERS = new Set(['so', 'well', 'okay', 'ok', 'like', 'right', 'now', 'oh', 'yeah']);
  const bare = t => String(t).toLowerCase().replace(/[^a-z']/g, '');
  /* the words a clean script leaves out: fillers anywhere; a word said twice in a row ("we, we"), the first time; and a
     starter ("So,", "Well,") that opens a sentence with a comma after it. "You know," and "I mean," at a sentence start too. */
  function cleanHidden(words) {
    const hide = new Set();
    for (let i = 0; i < words.length; i++) {
      const w = words[i], b = bare(w.t), prev = words[i - 1], next = words[i + 1], startsSentence = i === 0 || w.p || (prev && endsSentence(prev.t));
      if (FILLERS.has(b)) { hide.add(i); continue; }
      if (next && b && bare(next.t) === b && !next.p && /[,-]$|^\w+$/.test(w.t) && b.length < 12) { hide.add(i); continue; }
      if (startsSentence && /,$/.test(w.t) && STARTERS.has(b)) { hide.add(i); continue; }
      if (startsSentence && next && /,$/.test(next.t) && ((b === 'you' && bare(next.t) === 'know') || (b === 'i' && bare(next.t) === 'mean'))) { hide.add(i); hide.add(i + 1); i++; }
    }
    return hide;
  }
  /* the text of a run of words, without the hidden ones, the next word capitalised where a hidden one opened a sentence */
  function joinShown(words, i0, i1, hidden) {
    const out = []; let cap = false;
    for (let i = i0; i < i1; i++) {
      const w = words[i];
      if (hidden && hidden.has(i)) { if (/^[A-Z]/.test(w.t) && !/^I\b/.test(w.t)) cap = true; if (/[.!?]$/.test(w.t) && out.length) out[out.length - 1] = out[out.length - 1].replace(/,$/, '') + w.t.slice(-1); continue; }
      let t = w.t; if (cap) { t = t.charAt(0).toUpperCase() + t.slice(1); cap = false; } out.push(t);
    }
    return out.join(' ');
  }
  function paragraphs(words) {
    const out = []; words.forEach((w, i) => { if (i === 0 || w.p) out.push({ i0: i, i1: i + 1, start: w.s, speaker: w.sp || '' }); else out[out.length - 1].i1 = i + 1; });
    out.forEach(p => { p.end = words[p.i1 - 1].e; }); return out;
  }
  /* the word being spoken at time t: the last word that has started (the one before, in a gap between words) */
  function wordAt(words, t, upto = words.length) {
    let lo = 0, hi = upto - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].s <= t + 0.02) { k = m; lo = m + 1; } else hi = m - 1; } return k;
  }
  /* a paragraph's text edited: the new words keep the times of the old words they match; new or changed words are
     placed between their matched neighbours. A blank line in the new text starts a new paragraph. */
  function editParagraph(words, i0, i1, text) {
    const old = words.slice(i0, i1), head = old[0] || {}, out = [];
    const chunks = String(text).replace(/\r/g, '').split(/\n\s*\n/).map(c => c.trim().split(/\s+/).filter(Boolean)).filter(c => c.length);
    const flat = []; chunks.forEach((c, ci) => c.forEach((t, k) => flat.push({ t, newPara: k === 0 && ci > 0 })));
    if (!flat.length) return words.slice(0, i0).concat(words.slice(i1).map((w, k) => k === 0 && i0 < words.length && head.p !== undefined ? { ...w, p: true, ...(head.sp && !w.sp ? { sp: head.sp } : {}) } : w));
    // word-level alignment: one "line" per new word, matched against the old words as heard words
    const al = LC.align(flat.map(x => ({ text: x.t })), old.map(w => ({ text: w.t, start: w.s, end: w.e })), old.length ? old[old.length - 1].e : 0);
    const t0 = old.length ? old[0].s : 0, t1 = old.length ? old[old.length - 1].e : t0;
    flat.forEach((x, k) => {
      let s = al[k].t; if (s == null) s = t0 + (t1 - t0) * k / flat.length;
      s = Math.max(t0, Math.min(t1, s)); const w = { t: x.t, s: +s.toFixed(3), e: +s.toFixed(3) };
      if (k === 0) { if (head.p || i0 === 0) w.p = true; if (head.sp) w.sp = head.sp; } else if (x.newPara) w.p = true;
      out.push(w);
    });
    for (let k = 1; k < out.length; k++) if (out[k].s < out[k - 1].s) out[k].s = out[k - 1].s; // keep the order
    // new words that landed on the same moment share out the time up to the next word
    for (let k = 0; k < out.length;) { let j = k; while (j + 1 < out.length && out[j + 1].s === out[k].s) j++; if (j > k) { const next = j + 1 < out.length ? out[j + 1].s : Math.max(out[k].s + 0.3 * (j - k + 1), t1); for (let g = k; g <= j; g++) out[g].s = +(out[k].s + (next - out[k].s) * (g - k) / (j - k + 1)).toFixed(3); } k = j + 1; }
    for (let k = 0; k < out.length; k++) out[k].e = +Math.max(out[k].s, k + 1 < out.length ? Math.min(out[k + 1].s, out[k].s + 1.5) : t1).toFixed(3);
    return words.slice(0, i0).concat(out, words.slice(i1));
  }
  function setSpeaker(words, i0, name) { const w = words.slice(); w[i0] = { ...w[i0], p: true }; if (name) w[i0].sp = name; else delete w[i0].sp; return w; }
  /* where a phrase occurs: the index of each first word */
  function search(words, q) {
    const qt = LC.tokens(q); if (!qt.length) return []; const norm = words.map(w => LC.tokens(w.t).join(' ')), out = [];
    for (let i = 0; i < words.length; i++) { let ok = true; for (let k = 0; k < qt.length; k++) { const n = norm[i + k]; if (n == null || !(k === qt.length - 1 ? n.startsWith(qt[k]) : n === qt[k])) { ok = false; break; } } if (ok) out.push(i); }
    return out;
  }
  function toTxt(words, opts = {}) {
    const hidden = opts.clean ? cleanHidden(words) : null, ps = paragraphs(words);
    return ps.map(p => ({ p, text: joinShown(words, p.i0, p.i1, hidden) })).filter(x => x.text).map(({ p, text }) => `${opts.timestamps === false ? '' : `[${hms(p.start)}] `}${p.speaker ? p.speaker + ': ' : ''}${text}`).join('\n\n') + '\n';
  }
  /* subtitle cues: at most `maxWords` words and `maxDur` seconds each, broken at sentence ends and pauses */
  function cues(words, maxWords = 14, maxDur = 6, clean = false) {
    const out = []; let c = null; const hidden = clean ? cleanHidden(words) : null;
    words.forEach((w, i) => {
      if (hidden && hidden.has(i)) return;
      if (!c || w.p || c.n >= maxWords || w.s - c.start >= maxDur || w.s - c.end > 1) { if (c) out.push(c); c = { start: w.s, end: w.e, text: w.t, n: 1 }; }
      else { c.text += ' ' + w.t; c.end = Math.max(c.end, w.e); c.n++; }
      if (endsSentence(w.t) && c.n >= 4) { out.push(c); c = null; }
    });
    if (c) out.push(c); out.forEach((x, i) => { const nx = out[i + 1]; if (x.end - x.start < 0.8) x.end = Math.min(x.start + 0.8, nx ? nx.start : x.start + 0.8); });
    return out;
  }
  const toSrt = (words, clean) => cues(words, 14, 6, clean).map((c, i) => `${i + 1}\n${sub(c.start, ',')} --> ${sub(c.end, ',')}\n${c.text}\n`).join('\n');
  const toVtt = (words, clean) => 'WEBVTT\n\n' + cues(words, 14, 6, clean).map(c => `${sub(c.start, '.')} --> ${sub(c.end, '.')}\n${c.text}\n`).join('\n');
  const wordCount = words => words.length;

  /* ---- your own text (a book, a script): its words, waiting for the narration's times ---- */
  function fromText(text) {
    const out = [];
    String(text || '').replace(/\r/g, '').split(/\n\s*\n/).forEach(par => { const ws = par.trim().split(/\s+/).filter(Boolean); ws.forEach((t, k) => out.push(k === 0 ? { t, s: null, e: null, p: true } : { t, s: null, e: null })); });
    return out;
  }
  /* One batch of heard words (a window of the narration) matched into the text, from `ptr` (the first word not yet
     timed). Only a stretch ahead of ptr is searched, so a ten-hour book costs no more per window than a short one; if
     nothing matches there (the narrator read something the text does not have, or the text has pages the narrator
     skipped), a longer stretch is tried. Words between matched words are placed in proportion; returns the new ptr. */
  function matchBatch(words, ptr, heard) {
    if (!heard.length || ptr >= words.length) return { ptr, matched: 0 };
    const H = tidyHeard(heard).map(h => ({ w: LC.tokens(h.text).join(''), s: h.start })).filter(h => h.w);
    if (!H.length) return { ptr, matched: 0 };
    /* a "fitting" alignment: every heard word is placed, the text is read from ptr on, and the text after the last word
       read costs nothing (it simply has not been read yet). On a tie the earlier place wins, so a word that comes again
       later in the book is not jumped to. */
    const fit = span => {
      const n = Math.min(words.length - ptr, span), m = H.length, X = []; for (let i = 0; i < n; i++) X.push(LC.tokens(words[ptr + i].t).join(''));
      const SKIP = -0.4, EXTRA = -0.25, MISS = -0.6, S = new Float32Array((n + 1) * (m + 1)), Bk = new Uint8Array((n + 1) * (m + 1)), at = (i, j) => i * (m + 1) + j;
      for (let i = 1; i <= n; i++) { S[at(i, 0)] = i * SKIP; Bk[at(i, 0)] = 1; } for (let j = 1; j <= m; j++) { S[at(0, j)] = j * EXTRA; Bk[at(0, j)] = 2; }
      for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
        const sim = LC.similar(X[i - 1], H[j - 1].w), d = S[at(i - 1, j - 1)] + (sim ? 2 * sim : MISS), u = S[at(i - 1, j)] + SKIP, l = S[at(i, j - 1)] + EXTRA;
        if (d >= u && d >= l) { S[at(i, j)] = d; Bk[at(i, j)] = sim ? 3 : 0; } else if (u >= l) { S[at(i, j)] = u; Bk[at(i, j)] = 1; } else { S[at(i, j)] = l; Bk[at(i, j)] = 2; }
      }
      let best = 0; for (let i = 1; i <= n; i++) if (S[at(i, m)] > S[at(best, m)] + 1e-6) best = i; // the earliest best end
      const time = new Array(best).fill(null); let matched = 0, last = -1;
      // a misheard word paired with a text word (a name the recogniser did not know) still says when that word was read
      for (let i = best, j = m; i > 0 || j > 0;) { const b = Bk[at(i, j)]; if (i > 0 && j > 0 && (b === 3 || b === 0)) { time[i - 1] = H[j - 1].s; if (b === 3) { matched++; if (last < 0) last = i - 1; } i--; j--; } else if (i > 0 && (b === 1 || j === 0)) i--; else j--; }
      return { time, matched, last };
    };
    let r = fit(Math.max(80, H.length * 3)); if (!r.matched) r = fit(Math.max(1500, H.length * 20)); if (!r.matched) return { ptr, matched: 0 };
    // timed up to the last word matched; words in between matched ones (misread, or not heard) placed in proportion
    const floor = ptr > 0 && words[ptr - 1].s != null ? words[ptr - 1].s : (r.time.find(x => x != null) ?? 0);
    let prevK = -1, prevT = floor;
    for (let k = 0; k <= r.last; k++) {
      if (r.time[k] == null) continue; const tk = Math.max(prevT, r.time[k]);
      // unheard words between two heard ones: across a pause, the words after a sentence end belong at the end of the
      // pause (just before the next heard word), the rest just after the previous one; otherwise spread evenly
      let cut = prevK; if (tk - prevT > 1.5) for (let g = prevK; g < k; g++) if (g >= 0 && endsSentence(words[ptr + g].t)) cut = g;
      for (let g = prevK + 1; g < k; g++) words[ptr + g].s = +(prevK < 0 ? Math.max(floor, tk - (k - g) * 0.3) : tk - prevT > 1.5 ? (g > cut ? Math.max(prevT, tk - (k - g) * 0.3) : Math.min(tk, prevT + (g - prevK) * 0.3)) : prevT + (tk - prevT) * (g - prevK) / (k - prevK)).toFixed(3);
      words[ptr + k].s = +tk.toFixed(3); prevK = k; prevT = tk;
    }
    for (let k = 1; k <= r.last; k++) if (words[ptr + k].s < words[ptr + k - 1].s) words[ptr + k].s = words[ptr + k - 1].s;
    for (let k = 0; k <= r.last; k++) { const w = words[ptr + k], nx = words[ptr + k + 1]; w.e = +Math.max(w.s, k < r.last ? Math.min(nx.s, w.s + 1.5) : w.s + 0.4).toFixed(3); }
    return { ptr: ptr + r.last + 1, matched: r.matched };
  }
  /* how far a matched text has got: the index after the last timed word */
  const timedUpTo = words => { let i = words.length; while (i > 0 && words[i - 1].s == null) i--; return i; };

  const api = { speakerAt, labelHeard, clusterVoice, renameSpeaker, speakerNames, cleanHidden, joinShown, FILLERS, tidyHeard, fromText, matchBatch, timedUpTo, fromHeard, append, paragraphs, wordAt, editParagraph, setSpeaker, search, toTxt, toSrt, toVtt, cues, hms, short, wordCount };
  root.TranscriptCore = api; if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
