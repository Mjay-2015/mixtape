/* Mixtape transcripts and read-along: click a word, hear it.
   A recording from the library (or a file opened here, which joins the library) is either written down as heard, or
   matched to your own text (an audiobook, a script). The words light up as they are spoken; clicking one plays from it.
   Long recordings are read 30 seconds at a time (mediabunny decodes just that window), so hours are fine, and the work is
   saved as it goes: a recording can be paused and continued later.
   Rules: ../transcript-core.js and ../lyrics-core.js. Recogniser: ../asr-worker.js. Library: Mixtape's IndexedDB. */
import * as M from '../vendor/mediabunny/mediabunny.min.mjs';
const T = window.TranscriptCore;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let toastT = 0; const toast = (m, ms = 3200) => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
/* a pop-up under its button, or above it when there is no room below (a short window), never off the screen */
const below = (m, r) => { const h = m.offsetHeight; let y = r.bottom + 6; if (y + h > innerHeight - 8) y = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.max(8, innerHeight - h - 8); return y + 'px'; };

/* ---------- storage: Mixtape's library (read; files opened here are added), transcripts in their own database ---------- */
function idb(name, version, upgrade) { return new Promise((res, rej) => { const r = indexedDB.open(name, version); r.onupgradeneeded = () => upgrade(r.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('Close other Mixtape tabs and try again.')); }); }
const libDB = () => idb('mixtape-player', 1, d => { if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' }); if (!d.objectStoreNames.contains('lists')) d.createObjectStore('lists', { keyPath: 'id' }); });
// v2 adds 'flags' (per recording: { id, sensitive }), so a recording can be marked before it has a transcript
const trDB = () => idb('mixtape-transcripts', 2, d => { if (!d.objectStoreNames.contains('transcripts')) d.createObjectStore('transcripts', { keyPath: 'id' }); if (!d.objectStoreNames.contains('flags')) d.createObjectStore('flags', { keyPath: 'id' }); });
const allFlags = () => tx(trDB, 'flags', 'readonly', o => o.getAll());
const putFlag = v => tx(trDB, 'flags', 'readwrite', o => o.put(v));
async function tx(open, store, mode, fn) { const d = await open(); return new Promise((res, rej) => { let out; const t = d.transaction(store, mode), r = fn(t.objectStore(store)); r.onsuccess = () => { out = r.result; }; t.oncomplete = () => { d.close(); res(out); }; t.onerror = () => { d.close(); rej(t.error); }; t.onabort = () => { d.close(); rej(t.error); }; }); }
const getTrack = id => tx(libDB, 'tracks', 'readonly', o => o.get(id));
const allTracks = () => tx(libDB, 'tracks', 'readonly', o => o.getAll());
const getTr = id => tx(trDB, 'transcripts', 'readonly', o => o.get(id));
const allTr = () => tx(trDB, 'transcripts', 'readonly', o => o.getAll());
const putTr = v => tx(trDB, 'transcripts', 'readwrite', o => o.put(v));
const blobOf = t => t.blob || (t.buf ? new Blob([t.buf], { type: t.type || '' }) : null);

/* ---------- state ---------- */
let lib = [], trs = new Map(), flags = new Map(), cur = null; // cur: { track, blob, tr: { id, mode, words, upTo, done, duration, updated }, media }
let job = null, hits = [], hitAt = -1, lit = -1, editing = null;

/* ---------- the library rail ---------- */
async function loadLib() {
  const [ts, rs, fs] = await Promise.all([allTracks().catch(() => []), allTr().catch(() => []), allFlags().catch(() => [])]);
  flags = new Map(fs.map(f => [f.id, f]));
  lib = ts.filter(t => !t.stemOf && (t.blob || t.buf)).sort((a, b) => (b.added || 0) - (a.added || 0)); trs = new Map(rs.map(r => [r.id, r])); drawLib(); drawShelf();
}
function drawLib() {
  const q = $('#libQ').value.trim().toLowerCase(), el = $('#libL');
  const rows = lib.filter(t => !q || `${t.title} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q)).sort((a, b) => (trs.has(b.id) - trs.has(a.id)) || 0);
  el.innerHTML = rows.slice(0, 400).map(t => { const r = trs.get(t.id); const st = !r ? '' : r.done ? `<span class="s done">${r.mode === 'text' ? 'Read-along ready' : 'Transcript ready'}</span>` : `<span class="s">${r.mode === 'text' ? 'Read-along' : 'Transcript'} done to ${T.short(r.upTo)}</span>`;
    return `<li data-id="${esc(t.id)}" class="${cur && cur.track.id === t.id ? 'on' : ''}" tabindex="0"><span class="n">${sensitive(t.id) ? '<span class="lock" title="Sensitive: stays on this computer">🔒</span> ' : ''}${t.kind === 'video' ? '▣ ' : ''}${esc(t.title || t.name)}</span><span class="d">${t.duration ? T.short(t.duration) : ''}</span>${st}</li>`; }).join('') || '<li class="s">Nothing in the library yet. Open a file.</li>';
}
$('#libQ').addEventListener('input', drawLib);
$('#libL').addEventListener('click', e => { const li = e.target.closest('[data-id]'); if (li) select(li.dataset.id); });
$('#libL').addEventListener('keydown', e => { if (e.key === 'Enter') { const li = e.target.closest('[data-id]'); if (li) select(li.dataset.id); } });
$('#railBtn').addEventListener('click', () => $('#rail').classList.toggle('open'));
for (const b of ['#openBtn', '#openBtn2']) $(b).addEventListener('click', () => $('#fileIn').click());
$('#fileIn').addEventListener('change', async e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) openPicked(fs); });
/* A recording, or a studio narration: its audio and its .read-along.json picked together (any order). */
async function openPicked(fs, extra = {}) {
  const json = fs.find(f => /\.json$/i.test(f.name)), media = fs.filter(f => !/\.json$/i.test(f.name));
  if (!json) return addFile(media[0]);
  let ra; try { ra = JSON.parse(await json.text()); } catch (e) { return toast('That .json is not a read-along file.'); }
  if (!ra || !Array.isArray(ra.words) || !ra.words.length) return toast('That .json has no words with times in it.');
  const audio = media.find(f => f.name === ra.audio) || media[0];
  if (!audio) return toast(`Pick the recording too: ${ra.audio || 'its .mp3'} together with the .json.`, 6000);
  const id = await addFile(audio, { quiet: true, extra }); if (!id) return;
  // a narration's read-along (mode text), or a transcript made elsewhere (mode heard, e.g. Reverb on your own computer):
  // either way every word has its moment; a transcript keeps the recogniser's confidence, so unsure words show lighter
  const heard = ra.mode === 'heard';
  const words = ra.words.map(w => ({ t: String(w.t), s: w.s == null ? null : +w.s, e: w.e == null ? null : +w.e, ...(w.p ? { p: true } : {}), ...(w.sp ? { sp: w.sp } : {}), ...(heard && w.c != null ? { c: +w.c } : {}) }));
  if (heard && words[0]) words[0].p = true;
  cur.tr = { id, mode: heard ? 'heard' : 'text', words, upTo: ra.duration || cur.track.duration || 0, done: true, duration: ra.duration || cur.track.duration || 0, updated: Date.now(), voice: ra.voice || '' };
  await save(); drawAll(); toast(`Ready: ${words.length.toLocaleString()} words, each with its moment${ra.voice ? `, read by ${String(ra.voice).replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/:.*/, '')}` : ''}. Click any word.`, 6000);
}
async function addFile(f, { quiet = false, extra = {} } = {}) {
  // the file joins the library (album "Recordings"), so its transcript has a home and it can be played in Mixtape too
  const video = /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name);
  const dur = await mediaDuration(f).catch(() => 0);
  const t = { id: uid(), name: f.name, size: f.size, type: f.type || '', title: f.name.replace(/\.[^.]+$/, ''), artist: '', album: 'Recordings', track: 0, duration: dur, added: Date.now(), blob: f, art: null, ...(video ? { kind: 'video' } : {}), ...extra };
  try { await tx(libDB, 'tracks', 'readwrite', o => o.put(t)); try { new BroadcastChannel('mixtape').postMessage({ type: 'library' }); } catch (e) {} } catch (e) { toast(`Could not add it to the library: ${e.message || e}`, 5000); }
  await loadLib(); await select(t.id); return t.id;
}
const mediaDuration = blob => new Promise(res => { const a = document.createElement(/^video\//.test(blob.type) ? 'video' : 'audio'); a.preload = 'metadata'; a.onloadedmetadata = () => { res(isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(a.src); }; a.onerror = () => res(0); a.src = URL.createObjectURL(blob); });

/* ---------- one recording ---------- */
async function select(id) {
  if (job) { toast('Pause the current transcript first.'); return; }
  $('#rail').classList.remove('open'); if (editing) cancelEdit();
  const t = await getTrack(id); if (!t) return toast('That recording is no longer in the library.'); const blob = blobOf(t); if (!blob) return toast('That recording has no sound saved on this device.');
  if (cur && cur.url) URL.revokeObjectURL(cur.url);
  const video = t.kind === 'video' || /^video\//.test(blob.type);
  const media = document.createElement(video ? 'video' : 'audio'); media.preload = 'auto'; media.playsInline = true; const url = URL.createObjectURL(blob); media.src = url;
  $('#vidBox').innerHTML = ''; $('#vidBox').hidden = !video; if (video) $('#vidBox').appendChild(media);
  cur = { track: t, blob, url, media, tr: (await getTr(id)) || null };
  history.replaceState(null, '', `?song=${encodeURIComponent(id)}`);
  wireMedia(media); media.playbackRate = +$('#speed').value;
  $('#empty').hidden = true; $('#head').hidden = false; $('#pb').hidden = false; $('#title').textContent = t.title || t.name;
  drawLib(); drawAll();
}
function drawAll() {
  const r = cur.tr, d = cur.track.duration || cur.media.duration || 0;
  $('#meta').textContent = [d ? T.short(d) : '', cur.track.artist, r ? `${r.mode === 'text' ? 'read-along' : 'transcript'} · ${T.wordCount(r.words).toLocaleString()} words` : ''].filter(Boolean).join(' · ');
  $('#start').hidden = !!r || !!job; $('#estimate').textContent = d ? `This recording is ${T.short(d)} long; on this computer that takes about ${T.short(d * 0.6)} to go through (you can read and click along while it works). The first time, the recogniser (about 80 MB) is downloaded once.` : '';
  $('#cont').hidden = !(r && !r.done && !job); if (r && !r.done) $('#contSt').textContent = `Done up to ${T.short(r.upTo)} of ${T.short(r.duration || d)}.`;
  $('#findBox').hidden = !r; $('#exportBtn').hidden = !r;
  const sb = $('#sensBtn'), on = sensitive(cur.track.id); sb.hidden = false; sb.setAttribute('aria-pressed', on); sb.classList.toggle('on', on);
  sb.innerHTML = on ? '🔒 Sensitive <small>· nothing leaves this computer</small>' : 'Mark sensitive';
  sb.title = on ? 'Sensitive: the AI check is locked and nothing from this recording is sent anywhere, or ever used for training. Click to unmark.' : 'Mark this recording sensitive (court, client, medical, HR…): the AI check is locked so nothing from it leaves this computer, and it is never used for training.';
  drawText();
}
/* view settings, kept per browser: the clean script (fillers hidden), unsure words shown lighter, back up on resume */
const V = Object.assign({ clean: false, unsure: true, backup: true }, (() => { try { return JSON.parse(localStorage.getItem('mixtape-transcript-view')) || {}; } catch (e) { return {}; } })());
const saveV = () => { try { localStorage.setItem('mixtape-transcript-view', JSON.stringify(V)); } catch (e) {} };
const SPK_COLOURS = ['#1F6F78', '#B5523B', '#5B5EA6', '#7A6A1F', '#2F7D4F', '#9C3D7A', '#3A6EA5', '#8A5A2B'];
const spkColour = name => { const names = cur && cur.tr ? T.speakerNames(cur.tr.words) : []; const i = names.indexOf(name); return SPK_COLOURS[(i < 0 ? 0 : i) % SPK_COLOURS.length]; };
function drawText() {
  const el = $('#text'), r = cur && cur.tr; lit = -1;
  drawTools();
  if (!r || !r.words.length) { el.innerHTML = ''; return; }
  const ps = T.paragraphs(r.words), hidden = V.clean ? T.cleanHidden(r.words) : null;
  SUG = sugMap(r); NT = noteMap(r);
  el.classList.toggle('show-unsure', V.unsure);
  el.innerHTML = ps.map((p, pi) => paraHTML(r.words, p, pi, hidden)).join('');
  if (hits.length) markHits();
}
function paraHTML(words, p, pi, hidden) {
  const first = words[p.i0], timed = first.s != null; let cap = false;
  if (hidden) { let any = false; for (let i = p.i0; i < p.i1; i++) if (!hidden.has(i)) { any = true; break; } if (!any) return ''; } // a paragraph that was only "Hmm." is not shown in the clean script
  const ws = [];
  for (let i = p.i0; i < p.i1; i++) {
    const w = words[i], hide = hidden && hidden.has(i);
    // how sure the recogniser was: under 0.5 lightest, under 0.75 lighter (words a person typed carry no score)
    const cls = ['w', w.s == null ? 'un' : '', w.c != null && w.c < 0.5 ? 'q2' : w.c != null && w.c < 0.75 ? 'q1' : '', hide ? 'f' : '', !hide && cap ? 'cap' : '', SUG.word.has(i) ? 'sug' : '', w.ai ? 'aiw' : '', NT.word.has(i) ? 'nt' : ''].filter(Boolean).join(' ');
    if (hide) { if (/^[A-Z]/.test(w.t) && !/^I\b/.test(w.t)) cap = true; } else cap = false;
    const tip = w.ai ? ` title="Heard as “${esc(w.ai)}”; changed after the AI check"` : w.c != null && w.c < 0.75 ? ` title="Not sure (${Math.round(w.c * 100)}%)"` : '';
    const k = SUG.end.get(i), f = k != null && cur.tr.review.fixes[k];
    ws.push(`<span class="${cls}" data-i="${i}"${tip}>${esc(w.t)}</span>${f ? `<button class="sugc" data-fix="${k}" title="AI check: probably “${esc(f.likely)}”. Click to accept it or keep what was heard.">→ ${esc(f.likely)}</button>` : ''}${(NT.end.get(i) || []).map(n => `<button class="ntb" data-note="${esc(n.id)}" title="${esc(n.text || 'Note')}">✎ ${esc(noteLabel(n))}</button>`).join('')}`);
  }
  const col = p.speaker ? spkColour(p.speaker) : '';
  return `<div class="para" data-p="${pi}" data-i0="${p.i0}" data-i1="${p.i1}"><div class="gut">${timed ? `<button class="ts" data-ts="${first.s}" title="Play from here">${T.short(first.s)}</button>` : '<span class="ts">—</span>'}<button class="spk${p.speaker ? '' : ' none'}" data-spk title="Choose or rename the speaker"${col ? ` style="color:${col}"` : ''}>${p.speaker ? esc(p.speaker) : '+ speaker'}</button>${sugSpk(p.i0)}</div><div class="words">${ws.join(' ')}</div><button class="ed" data-ed title="Correct this paragraph (or double-click a word)" aria-label="Correct this paragraph">✎</button></div>`;
}
/* the strip above the text: the switches, the speakers (click to rename everywhere), the keys */
function drawTools() {
  const box = $('#tools'), r = cur && cur.tr; box.hidden = !r || !r.words.length; if (box.hidden) return;
  const names = T.speakerNames(r.words), unsure = r.words.filter(w => w.c != null && w.c < 0.75).length, fillers = T.cleanHidden(r.words).size;
  box.innerHTML = `<label class="sw" title="Hide ums, uhs, false starts (“we, we”) and starters (“So,”, “Well,”) for a cleaner script; exports follow this"><input type="checkbox" data-v="clean"${V.clean ? ' checked' : ''}> Clean script${fillers ? ` <small>(${fillers} hidden)</small>` : ''}</label>`
    + `<label class="sw" title="Words the recogniser was not sure of are lighter: check those first"><input type="checkbox" data-v="unsure"${V.unsure ? ' checked' : ''}> Unsure words lighter${unsure ? ` <small>(${unsure})</small>` : ''}</label>`
    + (r.mode === 'heard' ? `<span class="spks">${names.map(n => `<button class="chip" data-ren="${esc(n)}" title="Rename “${esc(n)}” everywhere" style="--c:${spkColour(n)}">${esc(n)}</button>`).join('')}${names.length ? '' : '<span class="muted">No speakers yet</span>'}</span>` : '')
    + `<span class="sp"></span>${reviewURL() && r.mode === 'heard' && sensitive(cur.track.id) ? `<button class="btn sm aibtn" disabled title="This recording is marked sensitive, so the AI check (which sends the words to Claude through the studio) is locked. Unmark it at the top if you choose to.">🔒 AI check</button>` : ''}${reviewURL() && r.mode === 'heard' && !sensitive(cur.track.id) ? `<button class="btn sm aibtn" data-ai title="A second reader: Claude reads the transcript for sense and suggests where the recogniser most likely misheard (names, places, sound-alikes) and where a speaker looks wrong. Nothing changes until you accept it.">✦ AI check</button>` : ''}<button class="btn sm ntbtn" data-notes title="Notes for the writer: select words, or press N while listening, to mark where something should change">✎ Notes${(r.notes || []).length ? ` (${r.notes.length})` : ''}</button><button class="btn sm ghost" id="keysBtn" title="Keyboard shortcuts (?)">⌨ Keys</button>`
    + aiBar(r);
}

/* ---------- playing: click a word, the spoken word lights ---------- */
function wireMedia(m) {
  m.addEventListener('timeupdate', () => { tick(); });
  m.addEventListener('play', () => { $('#bPlay').textContent = '❚❚'; $('#bPlay').setAttribute('aria-label', 'Pause'); loop(); });
  m.addEventListener('pause', () => { $('#bPlay').textContent = '▶'; $('#bPlay').setAttribute('aria-label', 'Play'); tick(); });
  m.addEventListener('loadedmetadata', tick);
}
let raf = 0; function loop() { cancelAnimationFrame(raf); const go = () => { if (!cur || cur.media.paused) return; tick(); raf = requestAnimationFrame(go); }; raf = requestAnimationFrame(go); }
function tick() {
  if (!cur) return; const m = cur.media, d = m.duration || cur.track.duration || 0;
  $('#tm').textContent = `${T.short(m.currentTime)} / ${T.short(d)}`; if (document.activeElement !== $('#seek')) $('#seek').value = d ? Math.round(m.currentTime / d * 1000) : 0;
  const r = cur.tr; if (!r || !r.words.length) return;
  const k = T.wordAt(r.words, m.currentTime, T.timedUpTo(r.words)); if (k === lit) return;
  const old = lit >= 0 && $(`.w[data-i="${lit}"]`); if (old) old.classList.remove('on'); lit = k;
  const el = k >= 0 && $(`.w[data-i="${k}"]`); if (el) { el.classList.add('on'); if ($('#follow').checked && !m.paused && !editing) keepInView(el); }
}
let scrolledAt = 0; $('#doc').addEventListener('wheel', () => { scrolledAt = performance.now(); }, { passive: true }); $('#doc').addEventListener('touchmove', () => { scrolledAt = performance.now(); }, { passive: true });
function keepInView(el) { if (performance.now() - scrolledAt < 5000) return; const box = $('#doc').getBoundingClientRect(), r = el.getBoundingClientRect(); if (r.top < box.top + box.height * 0.2 || r.bottom > box.top + box.height * 0.7) $('#doc').scrollBy({ top: r.top - box.top - box.height * 0.35, behavior: 'smooth' }); }
function playAt(t) { if (!cur) return; cur.media.currentTime = Math.max(0, t); justSeeked = false; cur.media.play().catch(() => {}); scrolledAt = 0; }
let justSeeked = false;
const togglePlay = () => { if (!cur) return; const m = cur.media; if (m.paused) { if (V.backup && !justSeeked && m.currentTime > 1) m.currentTime -= 1; justSeeked = false; m.play().catch(() => {}); } else m.pause(); };
const back = sec => { if (cur) { cur.media.currentTime = Math.max(0, cur.media.currentTime - sec); justSeeked = true; } };
const fwd = sec => { if (cur) { cur.media.currentTime = Math.min(cur.media.duration || 1e9, cur.media.currentTime + sec); justSeeked = true; } };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const speedBy = d => { const sel = $('#speed'), i = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(+sel.value) + d)); if (!sel.querySelector(`option[value="${SPEEDS[i]}"]`)) sel.insertAdjacentHTML('beforeend', `<option value="${SPEEDS[i]}">${SPEEDS[i]}×</option>`); sel.value = String(SPEEDS[i]); if (cur) cur.media.playbackRate = SPEEDS[i]; toast(`Speed ${SPEEDS[i]}×`, 1200); };
$('#bPlay').addEventListener('click', togglePlay);
$('#bBack').addEventListener('click', () => back(5));
$('#bFwd').addEventListener('click', () => fwd(5));
$('#seek').addEventListener('input', e => { if (cur && cur.media.duration) { cur.media.currentTime = e.target.value / 1000 * cur.media.duration; justSeeked = true; } });
$('#speed').addEventListener('change', e => { if (cur) cur.media.playbackRate = +e.target.value; });
$('#text').addEventListener('dblclick', e => { const p = e.target.closest('.para'); if (p && e.target.closest('.w') && !editing) { e.preventDefault(); startEdit(p, +e.target.closest('.w').dataset.i); } });
$('#text').addEventListener('click', e => {
  const nb = e.target.closest('[data-note]'); if (nb) return openNote(nb.dataset.note, nb);
  const sf = e.target.closest('[data-fix]'); if (sf) return fixMenu(sf, +sf.dataset.fix);
  const ss = e.target.closest('[data-sfix]'); if (ss) return speakerFixMenu(ss, +ss.dataset.sfix);
  const w = e.target.closest('.w'); if (w && !w.classList.contains('un')) { const r = cur.tr.words[+w.dataset.i]; playAt(r.s); return; }
  const ts = e.target.closest('[data-ts]'); if (ts) return playAt(+ts.dataset.ts);
  const p = e.target.closest('.para'); if (!p) return;
  if (e.target.closest('[data-ed]')) return startEdit(p);
  if (e.target.closest('[data-spk]')) return nameSpeaker(p, e.target.closest('[data-spk]'));
});

/* ---------- correcting the words, naming the speakers ---------- */
function startEdit(p, atWord) {
  if (editing) cancelEdit(); if (job) return toast('Pause first, then correct the text.');
  const i0 = +p.dataset.i0, i1 = +p.dataset.i1, words = cur.tr.words, text = words.slice(i0, i1).map(w => w.t).join(' ');
  const box = p.querySelector('.words'); editing = { p, i0, i1, html: box.innerHTML };
  box.innerHTML = `<div class="edit"><textarea aria-label="Correct the paragraph">${esc(text)}</textarea><div class="row"><span class="hint">Words you keep keep their timing. A blank line splits the paragraph. <b>Tab</b> plays / pauses.</span><span class="sp"></span><button class="btn sm" data-x="cancel">Cancel</button><button class="btn sm primary" data-x="save">Save</button></div></div>`;
  const ta = box.querySelector('textarea'); ta.focus(); let caret = ta.value.length; if (atWord != null && atWord >= i0) { caret = words.slice(i0, atWord).map(w => w.t).join(' ').length + (atWord > i0 ? 1 : 0); } ta.setSelectionRange(caret, caret);
  ta.addEventListener('keydown', ev => { if (ev.key === 'Tab') { ev.preventDefault(); ev.stopPropagation(); ev.shiftKey ? back(5) : togglePlay(); } else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); saveEdit(ta.value); } });
  box.querySelector('[data-x="cancel"]').addEventListener('click', cancelEdit); box.querySelector('[data-x="save"]').addEventListener('click', () => saveEdit(ta.value));
}
function cancelEdit() { if (!editing) return; editing.p.querySelector('.words').innerHTML = editing.html; editing = null; }
async function saveEdit(text) {
  const { i0, i1 } = editing; editing = null; remember();
  const before = cur.tr.words.length; cur.tr.words = T.editParagraph(cur.tr.words, i0, i1, text); shiftNotes(i0, i1, cur.tr.words.length - before); await save(); drawAll(); toast('Corrected.');
}
/* a paragraph's speaker: pick one already there, add a new one, or rename this one everywhere */
function nameSpeaker(p, btn) {
  const i0 = +p.dataset.i0, now = T.speakerAt(cur.tr.words, i0), names = T.speakerNames(cur.tr.words);
  const set = async name => { remember(); cur.tr.words = T.setSpeaker(cur.tr.words, i0, name); await save(); drawText(); };
  menu(btn, [['This paragraph is said by', null], ...names.filter(n => n !== now).map(n => [n, () => set(n)]),
    ['New speaker…', () => askName(btn, 'New speaker', '', n => set(n))],
    ...(now ? [[`Rename “${now}” everywhere…`, () => askName(btn, `Rename “${now}” everywhere`, now, n => renameAll(now, n))], ['No speaker for this paragraph', () => set('')]] : [])], { left: true });
}
async function renameAll(from, to) { if (!to || to === from) return; remember(); cur.tr.words = T.renameSpeaker(cur.tr.words, cur.tr.voices, from, to); await save(); drawText(); toast(`“${from}” is now “${to}” everywhere.`); }
function askName(anchor, title, value, done) {
  const m = $('#menu'); m.innerHTML = `<div class="lbl">${esc(title)}</div><input class="nm" value="${esc(value)}" placeholder="Name" aria-label="${esc(title)}" list="spkNames"><div class="row"><span class="sp"></span><button class="btn sm primary" data-ok>OK</button></div>`; m.hidden = false;
  let dlist = $('#spkNames'); if (!dlist) { dlist = document.createElement('datalist'); dlist.id = 'spkNames'; document.body.appendChild(dlist); } dlist.innerHTML = T.speakerNames(cur.tr.words).map(n => `<option value="${esc(n)}">`).join('');
  const r = anchor.getBoundingClientRect(); m.style.top = below(m, r); m.style.left = Math.max(8, Math.min(innerWidth - 260, r.left)) + 'px';
  const inp = m.querySelector('input'); inp.focus(); inp.select();
  const ok = () => { const v = inp.value.trim(); m.hidden = true; if (v) done(v); };
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); ok(); } else if (ev.key === 'Escape') { ev.preventDefault(); m.hidden = true; } });
  m.onclick = ev => { if (ev.target.closest('[data-ok]')) ok(); };
}
/* undo: every change to the words is a step back (Ctrl Z) */
const undoStack = []; function remember() { if (cur && cur.tr) { undoStack.push(JSON.stringify({ words: cur.tr.words, review: cur.tr.review || null, notes: cur.tr.notes || [] })); if (undoStack.length > 60) undoStack.shift(); } }
async function undo() { if (!undoStack.length || !cur || !cur.tr) return toast('Nothing to undo.'); const u = JSON.parse(undoStack.pop()); cur.tr.words = u.words; cur.tr.notes = u.notes || []; if (u.review) cur.tr.review = u.review; else delete cur.tr.review; await save(); drawText(); toast('Undone.'); }
$('#tools').addEventListener('change', e => { const k = e.target.dataset.v; if (!k) return; V[k] = e.target.checked; saveV(); drawText(); });
$('#tools').addEventListener('click', e => { if (aiClick(e)) return; const nl = e.target.closest('[data-notes]'); if (nl) return notesList(nl); const c = e.target.closest('[data-ren]'); if (c) return askName(c, `Rename “${c.dataset.ren}” everywhere`, c.dataset.ren, n => renameAll(c.dataset.ren, n)); if (e.target.closest('#keysBtn')) keysHelp(); });

/* ---------- sensitive recordings: nothing leaves this computer ----------
   Court, client, medical, HR… A recording marked sensitive has the AI check locked (the only thing on this page that
   sends anything out: its words, to Claude through the studio), is marked in exports, and is never used for training.
   Recognising, speakers, cutting and exports all run here in the browser either way. */
const sensitive = id => !!(flags.get(id) || {}).sensitive;
$('#sensBtn').addEventListener('click', async () => {
  if (!cur) return; const id = cur.track.id, on = !sensitive(id);
  if (!on && !confirm(`Unmark “${cur.track.title}” as sensitive? The AI check will then be able to send its words to Claude through the studio.`)) return;
  const f = { id, sensitive: on, at: Date.now() }; await putFlag(f); flags.set(id, f);
  if (cur.tr) { if (on) cur.tr.sensitive = true; else delete cur.tr.sensitive; await save(); }
  drawLib(); drawAll(); toast(on ? 'Marked sensitive: nothing from this recording leaves this computer.' : 'No longer marked sensitive.');
});

/* ---------- the second reader: the studio's AI check ----------
   The recogniser writes what it hears; Claude (through the studio, /studio/api/transcript/review) reads it for sense and
   suggests where it most likely misheard, where a paragraph's speaker looks wrong, and who a speaker is when the talk
   says so. Suggestions only: each is accepted or kept as heard, against the sound. Only inside the studio. */
const reviewURL = () => window.MIXTAPE_REVIEW_URL || (location.pathname.startsWith('/studio/') ? '/studio/api/transcript/review' : '');
let SUG = { word: new Set(), end: new Map(), para: new Map() };
function sugMap(r) {
  const out = { word: new Set(), end: new Map(), para: new Map() }, rv = r.review; if (!rv) return out;
  (rv.fixes || []).forEach((f, k) => { const i = T.locateFix(r.words, f); if (i < 0) return; f.at = i; for (let g = i; g < i + f.n; g++) out.word.add(g); out.end.set(i + f.n - 1, k); });
  (rv.speakers || []).forEach((s, k) => { if (r.words[s.at] && (s.at === 0 || r.words[s.at].p) && T.speakerAt(r.words, s.at) !== s.speaker) out.para.set(s.at, k); });
  return out;
}
function sugSpk(i0) { const k = SUG.para.get(i0); if (k == null) return ''; const s = cur.tr.review.speakers[k]; return `<button class="sugs" data-sfix="${k}" title="AI check: ${esc(s.why)}">→ ${esc(s.speaker)}?</button>`; }
const pending = rv => !rv ? 0 : (rv.fixes || []).length + (rv.speakers || []).length + (rv.names || []).length;
function aiBar(r) {
  const rv = r.review; if (!rv || !reviewURL()) return '';
  if (rv.running) return `<div class="aibar"><b>✦ AI check</b><span>${esc(rv.running)}</span></div>`;
  const nf = (rv.fixes || []).length, ns = (rv.speakers || []).length;
  if (!pending(rv)) return `<div class="aibar"><b>✦ AI check</b><span>${rv.found ? 'All its suggestions are dealt with.' : 'Nothing looked misheard.'}</span><span class="sp"></span><button class="btn sm ghost" data-aiclear>Close</button></div>`;
  return `<div class="aibar"><b>✦ AI check</b><span>${[nf ? `${nf} word${nf > 1 ? 's' : ''} probably misheard` : '', ns ? `${ns} speaker${ns > 1 ? 's' : ''} to look at` : ''].filter(Boolean).join(' · ') || 'Names to confirm'}${nf + ns ? ': click the ochre marks' : ''}</span>`
    + (rv.names || []).map((n, k) => `<span class="nmc" title="${esc(n.evidence)}">${esc(n.label)} is ${esc(n.name)}?<button data-nameok="${k}" title="Rename “${esc(n.label)}” to “${esc(n.name)}” everywhere">✓</button><button data-nameno="${k}" title="No">✕</button></span>`).join('')
    + `<span class="sp"></span>${nf + ns ? `<button class="btn sm" data-aiall title="Accept every word and speaker suggestion (names stay one by one). Ctrl + Z undoes.">Accept all</button>` : ''}<button class="btn sm ghost" data-aiclear title="Keep everything as heard">Dismiss all</button></div>`;
}
function aiClick(e) {
  const t = e.target;
  if (t.closest('[data-ai]')) { askReview(t.closest('[data-ai]')); return true; }
  if (t.closest('[data-aiall]')) { acceptAll(); return true; }
  if (t.closest('[data-aiclear]')) { remember(); delete cur.tr.review; save(); drawText(); return true; }
  const ok = t.closest('[data-nameok]'), no = t.closest('[data-nameno]');
  if (ok || no) {
    const k = +(ok ? ok.dataset.nameok : no.dataset.nameno), n = cur.tr.review.names[k]; remember(); cur.tr.review.names.splice(k, 1);
    if (ok) { cur.tr.words = T.renameSpeaker(cur.tr.words, cur.tr.voices, n.label, n.name); for (const s of cur.tr.review.speakers) if (s.speaker === n.label) s.speaker = n.name; toast(`“${n.label}” is now “${n.name}” everywhere.`); }
    save(); drawText(); return true;
  }
  return false;
}
/* before it runs: what you know helps (names, places, the topic), and what it costs */
function askReview(btn) {
  if (job) return toast('Wait for the transcript to finish first.');
  if (sensitive(cur.track.id)) return toast('This recording is marked sensitive: nothing from it is sent anywhere.');
  const r = cur.tr, n = r.words.length, est = Math.max(0.01, n / 1000 * 0.07);
  const m = $('#menu'); m.innerHTML = `<div class="lbl">AI check: a second reader for the recogniser</div><div class="why">Claude reads the transcript for sense and marks the words that were probably misheard, and speakers that look wrong. It never rewrites what people said, and fillers stay. You accept or keep each one.</div><textarea class="notes" placeholder="Optional: names, places or the topic, so it can spell them (e.g. “Interview with Thandi Nkosi in Soweto about the 1995 floodlights”)">${esc(r.reviewNotes || '')}</textarea><div class="why">${n.toLocaleString()} words · about $${est.toFixed(2)} · goes through the studio and is costed there.</div><div class="sugrow"><span class="sp"></span><button class="btn sm" data-x>Cancel</button><button class="btn sm primary" data-go>Check it</button></div>`; m.hidden = false;
  const rc = btn.getBoundingClientRect(); m.style.top = below(m, rc); m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, rc.right - m.offsetWidth)) + 'px';
  const ta = m.querySelector('textarea'); ta.focus();
  m.onclick = ev => { if (ev.target.closest('[data-x]')) m.hidden = true; else if (ev.target.closest('[data-go]')) { m.hidden = true; runReview(ta.value.trim()); } };
}
async function runReview(notes) {
  if (sensitive(cur.track.id)) return toast('This recording is marked sensitive: nothing from it is sent anywhere.'); // checked again at the moment of sending
  const r = cur.tr, stretches = T.reviewStretches(r.words), speakers = T.speakerNames(r.words); r.reviewNotes = notes;
  remember(); const rv = r.review = { fixes: [], speakers: [], names: [], running: '', found: 0 }; job = { review: true };
  let failed = '';
  try {
    for (let k = 0; k < stretches.length; k++) {
      rv.running = stretches.length > 1 ? `Reading part ${k + 1} of ${stretches.length}…` : 'Reading it…'; drawTools();
      const res = await fetch(reviewURL(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paras: stretches[k], speakers, context: notes, title: cur.track.title }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { failed = out.error || `the studio answered ${res.status}`; break; }
      rv.fixes.push(...out.fixes); rv.speakers.push(...out.speakers);
      for (const n of out.names) if (!rv.names.some(x => x.label === n.label)) rv.names.push(n);
      drawText();
    }
  } catch (e) { failed = e.message || String(e); }
  finally { job = null; rv.running = ''; rv.found = pending(rv); await save(); drawText(); }
  if (failed) toast(`The AI check stopped: ${failed}`, 7000);
  else toast(rv.found ? `${rv.found} suggestion${rv.found > 1 ? 's' : ''}. Click each ochre mark to hear it and decide.` : 'Nothing looked misheard.', 5000);
}
function takeFix(k) {
  const rv = cur.tr.review, f = rv.fixes[k]; rv.fixes.splice(k, 1); const a = T.applyFix(cur.tr.words, f);
  if (a.at < 0) return false; cur.tr.words = a.words; shiftNotes(a.at, a.at + 1, a.delta); rv.fixes = T.shiftFixes(rv.fixes, a.at, a.delta); rv.speakers = T.shiftFixes(rv.speakers, a.at, a.delta); return true;
}
function fixMenu(btn, k) {
  const f = cur.tr.review.fixes[k]; if (!f) return; const at = T.locateFix(cur.tr.words, f);
  const m = $('#menu'); m.innerHTML = `<div class="lbl">Heard “${esc(f.heard)}” · probably “${esc(f.likely)}”</div><div class="why">${esc(f.why)}</div><div class="sugrow"><button class="btn sm" data-hear>▶ Hear it</button><span class="sp"></span><button class="btn sm" data-keep>Keep as heard</button><button class="btn sm primary" data-take>Accept</button></div>`; m.hidden = false;
  const rc = btn.getBoundingClientRect(); m.style.top = below(m, rc); m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, rc.left)) + 'px';
  m.onclick = async ev => {
    if (ev.target.closest('[data-hear]')) { if (at >= 0 && cur.tr.words[at].s != null) playAt(Math.max(0, cur.tr.words[at].s - 1.5)); return; }
    const take = ev.target.closest('[data-take]'), keep = ev.target.closest('[data-keep]'); if (!take && !keep) return; m.hidden = true; remember();
    if (take) { if (!takeFix(k)) toast('Those words have changed since; the suggestion was dropped.'); } else cur.tr.review.fixes.splice(k, 1);
    await save(); drawText();
  };
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.hidden = true; document.removeEventListener('pointerdown', off); } }), 0);
}
function speakerFixMenu(btn, k) {
  const s = cur.tr.review.speakers[k]; if (!s) return; const now = T.speakerAt(cur.tr.words, s.at);
  const drop = async take => { remember(); cur.tr.review.speakers.splice(k, 1); if (take) cur.tr.words = T.setSpeaker(cur.tr.words, s.at, s.speaker); await save(); drawText(); };
  menu(btn, [[`Said by ${now || 'nobody yet'}; probably ${s.speaker}. ${s.why}`, null], [`Yes, ${s.speaker}`, () => drop(true)], [`No, keep ${now || 'it as it is'}`, () => drop(false)], ['▶ Hear it', () => playAt(cur.tr.words[s.at].s)]], { left: true });
}
async function acceptAll() {
  remember(); const rv = cur.tr.review; let n = 0;
  while (rv.fixes.length) if (takeFix(0)) n++;
  for (const s of rv.speakers.splice(0)) if (cur.tr.words[s.at]) { cur.tr.words = T.setSpeaker(cur.tr.words, s.at, s.speaker); n++; }
  await save(); drawText(); toast(`${n} change${n === 1 ? '' : 's'} made. Ctrl + Z undoes them all.`);
}

/* ---------- From the studio: narrations it made, ready to add ----------
   The studio keeps its narrations (an mp3 and its read-along) in its store; inside the studio this page lists them, and
   adding one copies both into this browser's library, so it plays offline afterwards like anything else here. */
const shelfURL = () => window.MIXTAPE_NARRATIONS_URL || (location.pathname.startsWith('/studio/') ? '/studio/api/narrations' : '');
let shelf = [];
async function loadShelf() { const u = shelfURL(); if (!u) return; try { const r = await fetch(u); if (!r.ok) return; shelf = (await r.json()).narrations || []; drawShelf(); } catch (e) { /* offline: the shelf waits */ } }
function drawShelf() {
  const el = $('#shelf'); if (!shelf.length) { el.hidden = true; return; } el.hidden = false;
  el.innerHTML = `<div class="lbl">From the studio</div>` + shelf.map((n, k) => { const have = lib.find(t => t.studio === n.title);
    return `<button class="sh${have ? ' have' : ''}" data-sh="${k}" title="${have ? 'In your library: open it' : 'Add it to this computer: it plays offline afterwards'}"><span class="n">${esc(n.title)}</span><span class="d">${have ? 'In your library' : `+ Add · ${Math.max(1, Math.round(n.size / 1e6))} MB`}</span></button>`; }).join('');
}
$('#shelf').addEventListener('click', async e => { const b = e.target.closest('[data-sh]'); if (!b || b.disabled) return; const n = shelf[+b.dataset.sh], have = lib.find(t => t.studio === n.title); if (have) return select(have.id); await addFromStudio(n, b); });
async function addFromStudio(n, btn) {
  if (job) return toast('Pause the current transcript first.');
  btn.disabled = true; btn.querySelector('.d').textContent = 'Fetching…';
  try {
    const [a, j] = await Promise.all([fetch(n.audio), fetch(n.readAlong)]); if (!a.ok || !j.ok) throw new Error(`the studio answered ${a.ok ? j.status : a.status}`);
    const ra = await j.json(), blob = await a.blob();
    await openPicked([new File([blob], ra.audio || `${n.title}.mp3`, { type: 'audio/mpeg' }), new File([JSON.stringify(ra)], `${n.title}.read-along.json`, { type: 'application/json' })], { studio: n.title });
  } catch (e) { toast(`Could not fetch it: ${e.message || e}`, 6000); }
  finally { btn.disabled = false; drawShelf(); }
}

/* ---------- notes for the writer: mark where something should change, while listening ----------
   Select words (or press N while it reads: the sentence being read is taken), say what should change, and it is kept
   with the read-along. The list can be saved as a file or, inside the studio, sent to the writers. */
let NT = { word: new Map(), end: new Map() };
function noteMap(r) { const m = { word: new Map(), end: new Map() }; for (const n of r.notes || []) { for (let i = n.i0; i <= n.i1; i++) m.word.set(i, n.id); const e = m.end.get(n.i1) || []; e.push(n); m.end.set(n.i1, e); } return m; }
const noteNo = n => [...(cur.tr.notes || [])].sort((a, b) => a.i0 - b.i0).indexOf(n) + 1;
const noteLabel = n => String(noteNo(n));
const quoteOf = n => cur.tr.words.slice(n.i0, n.i1 + 1).map(w => w.t).join(' ');
const noteTime = n => { const w = cur.tr.words[n.i0]; return w && w.s != null ? w.s : 0; };
function selRange() {
  const sel = getSelection(); if (!sel || sel.isCollapsed || !$('#text').contains(sel.anchorNode)) return null;
  let a = Infinity, b = -1; for (const el of $('#text').querySelectorAll('.w')) if (sel.containsNode(el, true)) { const i = +el.dataset.i; if (i < a) a = i; if (i > b) b = i; }
  return b < 0 ? null : [a, b];
}
function sentenceAround(k) {
  const ws = cur.tr.words, end = i => /[.!?…]["”’)]*$/.test(ws[i].t); let a = k, b = k;
  while (a > 0 && !end(a - 1) && !ws[a].p) a--; while (b < ws.length - 1 && !end(b)) b++; return [a, b];
}
function newNote() {
  if (!cur || !cur.tr || !cur.tr.words.length) return toast('Open a read-along or a transcript first.');
  let rg = selRange();
  if (!rg) { let k = lit >= 0 ? lit : T.wordAt(cur.tr.words, cur.media.currentTime, T.timedUpTo(cur.tr.words)); rg = sentenceAround(Math.max(0, k)); }
  const playing = !cur.media.paused; cur.media.pause(); getSelection().removeAllRanges();
  noteBox({ id: uid(), i0: rg[0], i1: rg[1], text: '', made: Date.now() }, true, playing);
}
function openNote(id, anchor) { const n = (cur.tr.notes || []).find(x => x.id === id); if (n) noteBox(n, false, false, anchor); }
function noteBox(n, isNew, resume, anchor) {
  const m = $('#menu');
  m.innerHTML = `<div class="ntbox"><div class="lbl">${isNew ? 'A note for the writer' : `Note ${noteLabel(n)}`} · at ${T.short(noteTime(n))}</div><blockquote class="nq">${esc(quoteOf(n))}</blockquote><textarea class="notes nt" placeholder="What should change here? (Ctrl + Enter saves, Esc cancels)">${esc(n.text)}</textarea><div class="sugrow"><button class="btn sm" data-hear title="Play from the start of these words">▶ Hear it</button>${isNew ? '' : '<button class="btn sm" data-del>Delete</button>'}<span class="sp"></span><button class="btn sm" data-x>Cancel</button><button class="btn sm primary" data-save>Save</button></div></div>`;
  m.hidden = false;
  const at = anchor || $(`.w[data-i="${n.i0}"]`) || $('#bPlay'), rc = at.getBoundingClientRect();
  m.style.top = below(m, rc); m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, rc.left)) + 'px';
  const ta = m.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  let done = false;
  const close = async how => {
    if (done) return; done = true; m.hidden = true; document.removeEventListener('pointerdown', off);
    if (how === 'save') {
      const text = ta.value.trim(); if (!text && isNew) { if (resume) cur.media.play().catch(() => {}); return; }
      remember(); const ns = cur.tr.notes || (cur.tr.notes = []); n.text = text; n.edited = Date.now(); if (isNew) ns.push(n);
      await save(); drawText(); drawTools(); toast(isNew ? `Noted (${ns.length}). It is kept with this read-along.` : 'Note saved.', 2200);
    } else if (how === 'del') { remember(); cur.tr.notes = (cur.tr.notes || []).filter(x => x.id !== n.id); await save(); drawText(); drawTools(); toast('Note deleted. Ctrl + Z brings it back.'); }
    if (resume) cur.media.play().catch(() => {});
  };
  ta.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); close('save'); } else if (ev.key === 'Escape') { ev.preventDefault(); close('cancel'); } });
  m.onclick = ev => { if (ev.target.closest('[data-save]')) close('save'); else if (ev.target.closest('[data-x]')) close('cancel'); else if (ev.target.closest('[data-del]')) close('del'); else if (ev.target.closest('[data-hear]')) playAt(Math.max(0, noteTime(n) - 0.3)); };
  const off = ev => { if (!m.contains(ev.target)) close(ta.value.trim() && ta.value.trim() !== n.text ? 'save' : 'cancel'); };
  setTimeout(() => document.addEventListener('pointerdown', off), 0);
}
function shiftNotes(i0, i1, delta) { // words i0..i1 (end exclusive) were replaced and the text grew by delta words
  if (!cur.tr.notes || !delta) return; const last = cur.tr.words.length - 1;
  for (const n of cur.tr.notes) { if (n.i0 >= i1) n.i0 += delta; if (n.i1 >= i1 - 1) n.i1 += delta; n.i0 = Math.max(0, Math.min(n.i0, last)); n.i1 = Math.max(n.i0, Math.min(n.i1, last)); }
}
function notesList(btn) {
  const r = cur.tr, ns = [...(r.notes || [])].sort((a, b) => a.i0 - b.i0), m = $('#menu');
  const head = ns.length ? `${ns.length} note${ns.length > 1 ? 's' : ''} for the writer` : 'No notes yet';
  m.innerHTML = `<div class="ntbox"><div class="lbl">${head}</div>${ns.length ? '' : '<div class="why">While it reads, press <b>N</b> to note the sentence being read, or select some words first and press N (or this button’s ✎ in the bar below). Say what should change; it is kept here.</div>'}<div class="nlist">${ns.map((n, k) => `<button class="nli" data-go="${esc(n.id)}"><span class="t">${k + 1} · ${T.short(noteTime(n))}</span><span class="q">“${esc(quoteOf(n).slice(0, 110))}${quoteOf(n).length > 110 ? '…' : ''}”</span><span class="x">${esc(n.text)}</span></button>`).join('')}</div>${ns.length ? `<div class="sugrow"><button class="btn sm" data-md>Save as a file (.md)</button><span class="sp"></span>${shelfURL() ? `<button class="btn sm primary" data-send title="The writers pick them up from the studio">Send to the studio</button>` : ''}</div>${r.notesSent ? `<div class="why">Last sent to the studio ${new Date(r.notesSent).toLocaleString()}.</div>` : ''}` : ''}</div>`;
  m.hidden = false; const rc = btn.getBoundingClientRect(); m.style.top = below(m, rc); m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, rc.right - m.offsetWidth)) + 'px';
  m.onclick = async ev => {
    const g = ev.target.closest('[data-go]'); if (g) { m.hidden = true; const n = ns.find(x => x.id === g.dataset.go), el = $(`.w[data-i="${n.i0}"]`); if (el) { scrolledAt = performance.now(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } setTimeout(() => openNote(n.id), 350); return; }
    if (ev.target.closest('[data-md]')) { m.hidden = true; dl(notesMD(), `${(cur.track.title || 'notes').replace(/[\\/:*?"<>|]+/g, '-')} (notes).md`); return; }
    if (ev.target.closest('[data-send]')) { m.hidden = true; sendNotes(); }
  };
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.hidden = true; document.removeEventListener('pointerdown', off); } }), 0);
}
function notesMD() {
  const ns = [...(cur.tr.notes || [])].sort((a, b) => a.i0 - b.i0);
  return `# Notes on “${cur.track.title}”\n\n${ns.length} note${ns.length === 1 ? '' : 's'}, ${new Date().toLocaleString()}\n\n` + ns.map((n, k) => `## ${k + 1}. At ${T.short(noteTime(n))}\n\n> ${quoteOf(n)}\n\n${n.text}\n`).join('\n');
}
async function sendNotes() {
  const ns = [...(cur.tr.notes || [])].sort((a, b) => a.i0 - b.i0);
  try {
    const res = await fetch('/studio/api/narrations/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: cur.track.studio || cur.track.title, notes: ns.map(n => ({ at: noteTime(n), quote: quoteOf(n), text: n.text })), md: notesMD() }) });
    const out = await res.json().catch(() => ({})); if (!res.ok) throw new Error(out.error || `the studio answered ${res.status}`);
    cur.tr.notesSent = Date.now(); await save(); toast(`Sent ${out.saved} note${out.saved === 1 ? '' : 's'} to the studio.`, 4000);
  } catch (e) { toast(`Could not send them: ${e.message || e}. Save them as a file instead.`, 7000); }
}
$('#bNote').addEventListener('click', newNote);

/* ---------- find ---------- */
$('#q').addEventListener('input', () => { hits = cur && cur.tr ? T.search(cur.tr.words, $('#q').value) : []; hitAt = -1; markHits(); $('#qn').textContent = $('#q').value.trim() ? `${hits.length}` : ''; });
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && hits.length) { e.preventDefault(); hitAt = (hitAt + (e.shiftKey ? -1 : 1) + hits.length) % hits.length; $('#qn').textContent = `${hitAt + 1} of ${hits.length}`; const el = $(`.w[data-i="${hits[hitAt]}"]`); if (el) { scrolledAt = performance.now(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } } else if (e.key === 'Escape') { $('#q').value = ''; $('#q').dispatchEvent(new Event('input')); $('#q').blur(); } });
function markHits() { document.querySelectorAll('.w.hit').forEach(x => x.classList.remove('hit')); const n = Math.max(1, cur && cur.tr ? window.LyricsCore.tokens($('#q').value).length : 1); for (const i of hits) for (let k = 0; k < n; k++) { const el = $(`.w[data-i="${i + k}"]`); if (el) el.classList.add('hit'); } }

/* ---------- export ---------- */
$('#exportBtn').addEventListener('click', e => {
  const r = cur.tr, base = (cur.track.title || 'transcript').replace(/[\\/:*?"<>|]+/g, '-'), timedWords = r.words.slice(0, T.timedUpTo(r.words));
  menu(e.currentTarget, [[V.clean ? 'Save the clean script as' : 'Save the text (full verbatim) as', null],
    ['Text with timestamps (.txt)', () => dl(T.toTxt(r.words.map(w => w.s == null ? { ...w, s: 0 } : w), { clean: V.clean }), base + (V.clean ? ' (clean)' : '') + '.txt')],
    ['Plain text (.txt)', () => dl(T.toTxt(r.words.map(w => w.s == null ? { ...w, s: 0 } : w), { timestamps: false, clean: V.clean }), base + (V.clean ? ' (clean, plain)' : ' (plain)') + '.txt')],
    ['Subtitles (.srt)', () => dl(T.toSrt(timedWords, V.clean), base + '.srt')],
    ['Web subtitles (.vtt)', () => dl(T.toVtt(timedWords, V.clean), base + '.vtt')],
    ['Words with times (.json)', () => dl(JSON.stringify({ title: cur.track.title, mode: r.mode, ...(sensitive(cur.track.id) ? { sensitive: true } : {}), words: r.words }, null, 1), base + '.json')],
    ['Start again…', null],
    ['Start again (this transcript is deleted)', async () => { if (!confirm(`Delete the ${r.mode === 'text' ? 'read-along' : 'transcript'} of “${cur.track.title}” and start again? Save it as a file first if you want to keep it.`)) return; await tx(trDB, 'transcripts', 'readwrite', o => o.delete(r.id)); trs.delete(r.id); cur.tr = null; hits = []; drawLib(); drawAll(); }]]);
});
function dl(text, name) { const a = document.createElement('a'), u = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 60e3); }
function menu(anchor, items, opt = {}) {
  const m = $('#menu'); m.innerHTML = items.map(([l, f], i) => f ? `<button data-m="${i}">${esc(l)}</button>` : `<div class="lbl">${esc(l)}</div>`).join(''); m.hidden = false;
  const r = anchor.getBoundingClientRect(); m.style.top = below(m, r); m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, opt.left ? r.left : r.right - m.offsetWidth)) + 'px';
  m.onclick = ev => { const b = ev.target.closest('[data-m]'); if (!b) return; m.hidden = true; items[+b.dataset.m][1](); };
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.hidden = true; document.removeEventListener('pointerdown', off); } }), 0);
}

/* ---------- making it: 30 seconds at a time ---------- */
$('#goHeard').addEventListener('click', () => start('heard'));
$('#goText').addEventListener('click', () => { const tx = $('#ownText').value.trim(); if (!tx) return toast('Paste the text first (or load a .txt).'); start('text', tx); });
$('#loadTxt').addEventListener('click', () => $('#txtIn').click());
$('#txtIn').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { $('#ownText').value = /\.docx$/i.test(f.name) ? await docxText(f) : await f.text(); toast(`${f.name} loaded.`); } catch (err) { toast(`Could not read ${f.name}: ${err.message || err}`, 6000); } });
/* The words of a Word file: a .docx is a zip, and word/document.xml holds one <w:p> per paragraph. The browser's own
   DecompressionStream unzips it, so no library is needed. */
async function docxText(file) {
  const b = new Uint8Array(await file.arrayBuffer()), dv = new DataView(b.buffer); let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('it is not a Word (.docx) file');
  let p = dv.getUint32(eocd + 16, true); const n = dv.getUint16(eocd + 10, true);
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    if (new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl)) === 'word/document.xml') {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true), data = b.subarray(start, start + size);
      const raw = method === 0 ? data : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      const xml = new TextDecoder().decode(raw), paras = [];
      for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) { const t = m[0].replace(/<w:tab\/>|<w:br\/>|<w:cr\/>/g, ' ').replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_a, x) => x ?? ''); const el = document.createElement('textarea'); el.innerHTML = t; const s = el.value.replace(/\s+/g, ' ').trim(); if (s) paras.push(s); }
      return paras.join('\n\n');
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error('no text was found in it');
}
$('#contBtn').addEventListener('click', () => start(cur.tr.mode));
$('#stopBtn').addEventListener('click', () => { if (job) { job.stop = true; $('#runSt').textContent = 'Pausing after this part…'; } });
async function save() { cur.tr.updated = Date.now(); await putTr(cur.tr); trs.set(cur.tr.id, cur.tr); drawLib(); }
async function start(mode, text) {
  if (job) return; const d = cur.track.duration || cur.media.duration || 0;
  if (!cur.tr) cur.tr = { id: cur.track.id, mode, words: mode === 'text' ? T.fromText(text) : [], upTo: 0, done: false, duration: d, updated: Date.now() };
  const tr = cur.tr; job = { stop: false }; $('#start').hidden = true; $('#cont').hidden = true; $('#run').hidden = false; drawAll(); $('#start').hidden = true; $('#cont').hidden = true;
  const st = $('#runSt'), bar = $('#runBar');
  let worker, spkWorker;
  try {
    const input = new M.Input({ source: new M.BlobSource(cur.blob), formats: M.ALL_FORMATS }), a = await input.getPrimaryAudioTrack(); if (!a) throw new Error('this file has no sound');
    if (!(await a.canDecode())) throw new Error(`this browser cannot decode its sound (${a.codec})`);
    const dur = await a.computeDuration(); tr.duration = dur;
    worker = new Worker('../asr-worker.js', { type: 'module' }); const files = {};
    const hear = msg => new Promise((res, rej) => { worker.onmessage = m => { const x = m.data; if (x.type === 'load') { files[x.file] = x; const tot = Object.values(files).reduce((s, f) => s + (f.total || 0), 0), got = Object.values(files).reduce((s, f) => s + (f.loaded || 0), 0); st.textContent = `Getting the recogniser (once only): ${Math.round(got / 1e6)} of ${Math.round(tot / 1e6)} MB`; bar.style.width = (tot ? got / tot * 100 : 0) + '%'; } else if (x.type === 'window') res(x.words); else if (x.type === 'error') rej(new Error(x.message)); }; worker.onerror = e => rej(new Error(e.message || 'the recogniser could not start')); worker.postMessage(msg, [msg.audio.buffer]); });
    // who speaks when: a second worker, in step with the recogniser (transcripts only; a read-along has one narrator)
    const findSpeakers = tr.mode === 'heard' && tr.speakers !== false; tr.voices ||= [];
    if (findSpeakers) spkWorker = new Worker('../speaker-worker.js', { type: 'module' });
    const sfiles = {};
    const speakers = msg => !spkWorker ? Promise.resolve(null) : new Promise(res => { spkWorker.onmessage = m => { const x = m.data; if (x.type === 'load') { sfiles[x.what] = x; } else if (x.type === 'speakers') res(x); else if (x.type === 'error') { console.warn('speakers:', x.message); res(null); } }; spkWorker.onerror = e => { console.warn('speakers:', e.message); res(null); }; spkWorker.postMessage(msg, [msg.audio.buffer]); });
    let ptr = tr.mode === 'text' ? T.timedUpTo(tr.words) : 0, from = tr.upTo || 0, t0 = performance.now();
    for (let w0 = Math.max(0, from - 2.5); w0 < dur; w0 += 25) {
      const w1 = Math.min(dur, w0 + 30), keepFrom = w0 <= from ? from : w0 + 2.5, keepTo = w1 >= dur ? Infinity : w0 + 27.5;
      const pcm = await window16k(a, w0, w1);
      const kf = keepFrom === 0 ? -1 : keepFrom, big = pcm.length > 8000;
      const [heard0, sp] = big ? await Promise.all([hear({ window: true, audio: pcm.slice(), offset: w0, keepFrom: kf, keepTo }), findSpeakers ? speakers({ audio: pcm, offset: w0, keepFrom: kf, keepTo }) : null]) : [[], null];
      let heard = heard0;
      if (sp && sp.turns.length) { // each voiceprint joins the speaker it sounds like, or becomes a new one
        const names = sp.prints.map(pr => T.clusterVoice(tr.voices, pr).name);
        heard = T.labelHeard(heard, sp.turns.map(t => ({ s: t.s, e: t.e, name: t.g >= 0 ? names[t.g] : null })));
      }
      if (tr.mode === 'text') ptr = T.matchBatch(tr.words, ptr, heard).ptr; else tr.words = T.append(tr.words, heard);
      tr.upTo = Math.min(dur, keepTo); tr.done = w1 >= dur || (tr.mode === 'text' && ptr >= tr.words.length);
      await save(); appendRender();
      const el = (performance.now() - t0) / 1000, doneSec = tr.upTo - from, left = doneSec > 0 ? (dur - tr.upTo) * el / doneSec : 0;
      st.textContent = tr.mode === 'text' ? `Matching the text: up to ${T.short(tr.upTo)} of ${T.short(dur)} · ${Math.round(ptr / tr.words.length * 100)}% of the words${left > 5 ? ` · about ${T.short(left)} left` : ''}` : `Writing it down: ${T.short(tr.upTo)} of ${T.short(dur)}${left > 5 ? ` · about ${T.short(left)} left` : ''}`;
      bar.style.width = Math.round(tr.upTo / dur * 100) + '%';
      if (tr.done || job.stop) break;
    }
    if (tr.mode === 'text' && tr.done) { const up = T.timedUpTo(tr.words); if (up < tr.words.length) toast(`The recording ended before the text did: the last ${(tr.words.length - up).toLocaleString()} words were not heard.`, 7000); }
    toast(tr.done ? (tr.mode === 'text' ? 'Read-along ready. Click any word to hear it.' : 'Transcript ready. Click any word to hear it.') : `Paused at ${T.short(tr.upTo)}. Continue any time.`, 5000);
  } catch (e) { toast(`Stopped: ${e.message || e}`, 7000); console.error(e); }
  finally { if (worker) worker.terminate(); if (spkWorker) spkWorker.terminate(); job = null; $('#run').hidden = true; await save().catch(() => {}); drawAll(); }
}
let rendered = 0;
function appendRender() { // the text grows as it is made: redraw, keeping the reader's place
  const doc = $('#doc'), y = doc.scrollTop; drawText(); doc.scrollTop = y; $('#meta').textContent = `${T.short(cur.tr.duration)} · ${cur.tr.mode === 'text' ? 'read-along' : 'transcript'} · ${T.wordCount(cur.tr.words).toLocaleString()} words`; tick();
}
/* the sound from w0 to w1, mono at 16 kHz (each output sample the average of the input samples it covers) */
async function window16k(track, w0, w1) {
  const sink = new M.AudioSampleSink(track), n = Math.max(0, Math.round((w1 - w0) * 16000)), out = new Float32Array(n), cnt = new Float32Array(n);
  for await (const s of sink.samples(w0, w1)) {
    const sr = s.sampleRate, ch = s.numberOfChannels, f = s.numberOfFrames, buf = new Float32Array(f * ch); s.copyTo(buf, { planeIndex: 0, format: 'f32' }); const ts = s.timestamp; s.close();
    for (let i = 0; i < f; i++) { const k = Math.floor((ts + i / sr - w0) * 16000); if (k < 0 || k >= n) continue; let v = 0; for (let c = 0; c < ch; c++) v += buf[i * ch + c]; out[k] += v / ch; cnt[k]++; }
  }
  for (let k = 0; k < n; k++) if (cnt[k]) out[k] /= cnt[k]; else if (k) out[k] = out[k - 1];
  return out;
}

/* ---------- keys: the transcription editors' way (Temi, Rev, Happy Scribe) ---------- */
const KEYS = [['Tab', 'Play / pause — anywhere, even while typing'], ['Shift + Tab', 'Back 5 seconds'], ['Ctrl + →  /  Ctrl + ←', 'Forward / back 5 seconds'], ['← →', 'Forward / back 5 seconds (when not typing)'], ['Ctrl + ↑  /  Ctrl + ↓', 'Faster / slower'], ['Click a word', 'Play from that word'], ['Double-click a word', 'Correct its paragraph (Ctrl + Enter saves, Esc cancels)'], ['N', 'Note for the writer: on the words you selected, or the sentence being read (Ctrl + Enter saves)'], ['Ctrl + Z', 'Undo the last change'], ['Ctrl + F', 'Find in the text (Enter: next, Shift + Enter: previous)'], ['Space', 'Play / pause (when not typing)'], ['?', 'These keys']];
function keysHelp() {
  const m = $('#menu'); m.innerHTML = `<div class="lbl">Keys</div><table class="keys">${KEYS.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table><label class="sw"><input type="checkbox" id="bkp"${V.backup ? ' checked' : ''}> Back up 1 second when playing again after a pause</label>`; m.hidden = false;
  const b = $('#keysBtn') || $('#bPlay'), r = b.getBoundingClientRect(); m.style.top = Math.max(8, Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 6)) + 'px'; m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
  m.querySelector('#bkp').addEventListener('change', e => { V.backup = e.target.checked; saveV(); });
  m.onclick = null; setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.hidden = true; document.removeEventListener('pointerdown', off); } }), 0);
}
document.addEventListener('keydown', e => {
  const typing = !!e.target.closest('input, textarea, select'), ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Tab' && cur && !e.target.closest('.menu')) { e.preventDefault(); e.shiftKey ? back(5) : togglePlay(); return; }
  if (ctrl && e.key === 'f' && cur && cur.tr) { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  if (ctrl && (e.key === 'z' || e.key === 'Z') && !typing) { e.preventDefault(); undo(); return; }
  if (ctrl && e.key === 'ArrowRight') { e.preventDefault(); fwd(5); return; }
  if (ctrl && e.key === 'ArrowLeft') { e.preventDefault(); back(5); return; }
  if (ctrl && e.key === 'ArrowUp') { e.preventDefault(); speedBy(1); return; }
  if (ctrl && e.key === 'ArrowDown') { e.preventDefault(); speedBy(-1); return; }
  if (typing || !cur) return;
  if (e.key === ' ') { if (e.target.closest('button')) return; e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); back(5); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); fwd(5); }
  else if (e.key === '?') { e.preventDefault(); keysHelp(); }
  else if ((e.key === 'n' || e.key === 'N') && !ctrl && !e.altKey) { e.preventDefault(); newNote(); }
});
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.closest('.edit')) b.blur(); });
addEventListener('resize', () => { $('#menu').hidden = true; }); // a pop-up placed for the old window size would hang off the new one
addEventListener('beforeunload', e => { if (job) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- start ---------- */
await loadLib(); loadShelf();
const want = new URLSearchParams(location.search).get('song'); if (want) select(want);
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__tr = { get cur() { return cur; }, select, start, T, get job() { return job; }, openPicked, docxText };
