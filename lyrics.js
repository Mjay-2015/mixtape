/* Mixtape lyrics: words that light up line by line as the song plays, like YouTube's.
   - Now Playing gets a Lyrics tab beside Up next: the line being sung is lit and kept in view; tap a line to jump there.
   - The lyrics editor (song menu → Add lyrics / Edit lyrics): paste the words, or load a .lrc / .srt / .vtt / .txt file;
     then time them automatically (Whisper hears the song and your lines are matched to what it hears), by tapping along,
     or line by line. Lines it is unsure of are marked to check. Saves to the song; exports .lrc, .srt and .vtt.
   Rules live in lyrics-core.js (checked by lyrics-check.cjs); the recogniser runs in asr-worker.js.
   Talks to the player only through window.MixtapeApp. */
(function () {
  const A = window.MixtapeApp, L = window.LyricsCore; if (!A || !L) return;
  const $ = s => document.querySelector(s), esc = A.esc, audio = A.audio;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const clock = s => s == null ? '--:--.--' : L.fmtClock(s);

  /* ---------------- Now Playing: the Lyrics tab ---------------- */
  const up = $('.upnext'); let tab = lsGet('mixtape-lyrics-tab', 'up'), shown = -2, userScrolled = 0, raf = 0;
  if (up) {
    const h3 = up.querySelector('h3'); const tabs = document.createElement('div'); tabs.className = 'uptabs'; tabs.setAttribute('role', 'tablist');
    tabs.innerHTML = '<button role="tab" data-ltab="up">Up next</button><button role="tab" data-ltab="lyr">Lyrics</button>';
    h3.before(tabs); const view = document.createElement('div'); view.id = 'lyrView'; view.className = 'lyrview'; view.setAttribute('aria-live', 'off'); up.appendChild(view);
    tabs.addEventListener('click', e => { const b = e.target.closest('[data-ltab]'); if (b) { b.blur(); tab = b.dataset.ltab; lsSet('mixtape-lyrics-tab', tab); paintTab(); } });
    view.addEventListener('click', e => { const l = e.target.closest('[data-lt]'); if (l) { audio.currentTime = +l.dataset.lt; if (audio.paused) audio.play().catch(() => {}); return; } const b = e.target.closest('[data-lact]'); if (b && A.curId) edit(A.curId, b.dataset.lact === 'time' ? { autoStart: false } : {}); });
    view.addEventListener('wheel', () => { userScrolled = performance.now(); }, { passive: true }); view.addEventListener('touchmove', () => { userScrolled = performance.now(); }, { passive: true });
  }
  function paintTab() {
    if (!up) return; up.querySelectorAll('[data-ltab]').forEach(b => { const on = b.dataset.ltab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    up.querySelector('h3').hidden = tab !== 'up'; $('#upList').hidden = tab !== 'up'; $('#lyrView').hidden = tab !== 'lyr';
    if (tab === 'lyr') paintLyrics(); loop();
  }
  function paintLyrics() {
    const v = $('#lyrView'), t = A.tracks.get(A.curId), ly = t && t.lyrics; shown = -2;
    if (!t) { v.innerHTML = '<p class="lyrnone">Play a song to see its lyrics.</p>'; return; }
    if (!ly || !ly.lines || !ly.lines.length) { v.innerHTML = `<div class="lyrnone"><p>No lyrics for “${esc(t.title)}” yet.</p><button class="btn primary" data-lact="add">Add lyrics</button></div>`; return; }
    const isTimed = L.timed(ly.lines);
    v.innerHTML = (isTimed ? '' : `<div class="lyrnote">These words are not timed yet, so they cannot follow the song. <button class="btn sm" data-lact="time">Time them</button></div>`) +
      `<ol class="lyrlines${isTimed ? ' timed' : ''}">${ly.lines.map((l, i) => `<li${l.gap ? ' class="gap"' : ''}${isTimed ? ` data-lt="${l.t}" data-li="${i}" tabindex="0"` : ''}>${esc(l.text)}</li>`).join('')}</ol>` +
      `<div class="lyrfoot"><button class="btn sm" data-lact="edit">Edit lyrics</button></div>`;
    follow(true);
  }
  function follow(force) {
    const t = A.tracks.get(A.curId), ly = t && t.lyrics; if (!ly || !L.timed(ly.lines || [])) return;
    const k = L.lineAt(ly.lines, audio.currentTime); if (k === shown && !force) return; shown = k;
    const v = $('#lyrView'); v.querySelectorAll('li.on').forEach(x => x.classList.remove('on')); const li = v.querySelector(`li[data-li="${k}"]`);
    v.querySelectorAll('li[data-li]').forEach(x => x.classList.toggle('past', +x.dataset.li < k));
    if (li) { li.classList.add('on'); if (performance.now() - userScrolled > 4000) { const box = v.getBoundingClientRect(), r = li.getBoundingClientRect(); v.scrollBy({ top: r.top - box.top - box.height * 0.38, behavior: force ? 'auto' : 'smooth' }); } }
  }
  function loop() { cancelAnimationFrame(raf); const go = () => { if ($('#now').hidden || tab !== 'lyr') return; follow(false); raf = requestAnimationFrame(go); }; if (!$('#now').hidden && tab === 'lyr') raf = requestAnimationFrame(go); }
  new MutationObserver(() => loop()).observe($('#now'), { attributes: true, attributeFilter: ['hidden'] });
  // the audio's own clock too: animation frames stop when the window is in the background
  for (const ev of ['timeupdate', 'seeked']) audio.addEventListener(ev, () => { if (!$('#now').hidden && tab === 'lyr') follow(ev === 'seeked'); });
  let lastTrack = null;
  function onTrack() { if (A.curId !== lastTrack) { lastTrack = A.curId; userScrolled = 0; } if (up) paintTab(); }

  /* ---------------- the editor ---------------- */
  let E = null; // the open editor: { id, t, lines, el, source }
  function edit(id, opts = {}) {
    const t = A.tracks.get(id); if (!t) return; if (E) close(true);
    const lines = t.lyrics && t.lyrics.lines ? t.lyrics.lines.map(l => ({ ...l })) : [];
    const wrap = document.createElement('div'); wrap.className = 'lyrwrap'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-label', 'Lyrics');
    wrap.innerHTML = `<div class="lyr">
      <header class="lyr-h"><div><h3>Lyrics</h3><p>${esc(t.title)}${t.artist ? ' · ' + esc(t.artist) : ''}</p></div><span class="sp"></span><button class="ib" data-e="close" aria-label="Close the lyrics editor" title="Close (Esc)">✕</button></header>
      <div class="lyr-b">
        <section class="lyr-words"><label for="lyrText">The words</label>
          <textarea id="lyrText" spellcheck="true" placeholder="Paste or type the words, one line per line. A blank line starts a new verse."></textarea>
          <div class="lyr-row"><button class="btn sm" data-e="file">Load a file…</button><button class="btn sm" data-e="draft" title="Let the recogniser write down what it hears, as a first draft to correct">Write them from the song</button><input type="file" id="lyrFile" accept=".lrc,.srt,.vtt,.txt,text/plain" hidden></div>
          <p class="lyr-hint">Load a file: .lrc, .srt or .vtt keep their times; .txt is just the words.</p></section>
        <section class="lyr-times"><div class="lyr-row"><button class="btn primary" data-e="auto">Time them automatically</button><button class="btn" data-e="tap" title="Play the song and tap at the start of each line">Tap along</button><span class="sp"></span><button class="btn sm ghost" data-e="clear" title="Forget the times, keep the words">Clear times</button></div>
          <div class="lyr-status" id="lyrStatus" aria-live="polite"></div><div class="lyr-bar" id="lyrBar" hidden><i></i></div>
          <ol class="lyr-lines" id="lyrLines"></ol>
          <div class="lyr-tap" id="lyrTap" hidden></div></section>
      </div>
      <footer class="lyr-f"><button class="ib play" data-e="play" aria-label="Play the song here" title="Play / pause"><svg class="i"><use class="js-lyr-play" href="#i-play"/></svg></button><span class="t" id="lyrClock">0:00</span>
        <span class="sp"></span><button class="btn sm" data-e="export">Save as a file ▾</button><button class="btn sm ghost" data-e="remove">Remove lyrics</button><button class="btn primary" data-e="save">Save</button></footer></div>`;
    document.body.appendChild(wrap);
    E = { id, t, lines, el: wrap, source: (t.lyrics && t.lyrics.source) || 'text', dirty: false };
    const ta = wrap.querySelector('#lyrText'); ta.value = L.toText(lines);
    ta.addEventListener('input', () => { clearTimeout(E.ti); E.ti = setTimeout(() => { E.lines = keepTimes(E.lines, L.fromText(ta.value)); E.dirty = true; drawLines(); }, 250); });
    wrap.addEventListener('click', onClick);
    wrap.querySelector('#lyrFile').addEventListener('change', async ev => { const f = ev.target.files[0]; ev.target.value = ''; if (!f) return; const r = L.parseAny(await f.text(), f.name); if (!r.lines.length) return A.toast('No words were found in that file.'); E.lines = r.lines; E.source = r.kind === 'text' ? 'text' : 'file'; E.dirty = true; ta.value = L.toText(E.lines); drawLines(); status(r.kind === 'text' ? `${r.lines.length} lines loaded. Now time them.` : `${r.lines.length} timed lines loaded from the ${r.kind.toUpperCase()} file.`); });
    wrap.querySelector('#lyrLines').addEventListener('change', ev => { const i = ev.target.closest('[data-i]'); if (!i || !ev.target.matches('input')) return; const v = L.parseClock(ev.target.value); E.lines[+i.dataset.i].t = v; E.lines[+i.dataset.i].conf = v == null ? 0 : 1; E.dirty = true; drawLines(); });
    audio.addEventListener('timeupdate', tick); audio.addEventListener('play', tick); audio.addEventListener('pause', tick);
    drawLines(); tick(); if (!lines.length) setTimeout(() => ta.focus(), 0);
    if (A.curId !== id) A.loadTrack(id, false);
  }
  function keepTimes(old, fresh) { // the words changed: lines that are still there keep their times
    let j = 0; return fresh.map(l => { for (let k = j; k < Math.min(old.length, j + 4); k++) if (old[k].text === l.text) { j = k + 1; return { ...l, t: old[k].t, conf: old[k].conf }; } return l; });
  }
  function status(s) { if (E) E.el.querySelector('#lyrStatus').textContent = s || ''; }
  function bar(v) { const b = E.el.querySelector('#lyrBar'); b.hidden = v == null; if (v != null) b.querySelector('i').style.width = Math.round(v * 100) + '%'; }
  function drawLines() {
    const ol = E.el.querySelector('#lyrLines'), now = audio.currentTime, k = L.timed(E.lines) ? L.lineAt(E.lines, now) : -1;
    if (!E.lines.length) { ol.innerHTML = '<li class="lyr-empty">The lines appear here once there are words.</li>'; return; }
    ol.innerHTML = E.lines.map((l, i) => `<li data-i="${i}" class="${l.gap ? 'gap ' : ''}${l.t != null && l.conf != null && l.conf < 0.5 ? 'check ' : ''}${i === k ? 'on' : ''}"><input class="lt" value="${l.t == null ? '' : clock(l.t)}" placeholder="--:--.--" aria-label="Start of line ${i + 1}" inputmode="decimal"><button class="ib sm" data-e="from" title="Play from this line" aria-label="Play from this line">▶</button><button class="ib sm" data-e="now" title="This line starts now (at the playing time)" aria-label="Starts now">⤓</button><span class="lx">${esc(l.text)}${l.t != null && l.conf != null && l.conf < 0.5 ? '<em>check</em>' : ''}</span></li>`).join('');
  }
  function tick() {
    if (!E) return; E.el.querySelector('#lyrClock').textContent = `${A.fmt(audio.currentTime)} / ${A.fmt(audio.duration || E.t.duration || 0)}`;
    E.el.querySelectorAll('.js-lyr-play').forEach(u => u.setAttribute('href', audio.paused ? '#i-play' : '#i-pause'));
    if (L.timed(E.lines)) { const k = L.lineAt(E.lines, audio.currentTime); E.el.querySelectorAll('#lyrLines li').forEach((li, i) => li.classList.toggle('on', i === k)); }
  }
  async function onClick(ev) {
    const b = ev.target.closest('[data-e]'); if (!b || !E) return; const what = b.dataset.e, li = b.closest('[data-i]'), i = li ? +li.dataset.i : -1;
    if (what === 'close') return close();
    if (what === 'file') return E.el.querySelector('#lyrFile').click();
    if (what === 'play') { if (A.curId !== E.id) A.loadTrack(E.id, false); audio.paused ? audio.play().catch(() => {}) : audio.pause(); return; }
    if (what === 'from') { const l = E.lines[i]; if (l.t == null) return A.toast('This line has no time yet.'); audio.currentTime = Math.max(0, l.t - 0.6); audio.play().catch(() => {}); return; }
    if (what === 'now') { E.lines[i].t = +audio.currentTime.toFixed(2); E.lines[i].conf = 1; E.dirty = true; drawLines(); return; }
    if (what === 'clear') { E.lines = E.lines.map(l => ({ text: l.text, t: null, ...(l.gap ? { gap: true } : {}) })); E.dirty = true; drawLines(); status('Times cleared; the words are kept.'); return; }
    if (what === 'auto') return autoTime(false);
    if (what === 'draft') return autoTime(true);
    if (what === 'tap') return tapAlong();
    if (what === 'export') return exportMenu(b);
    if (what === 'remove') { if (!(await A.ask({ title: 'Remove the lyrics?', text: `The words and times for “${E.t.title}” are removed from this song.`, ok: 'Remove', danger: true }))) return; delete E.t.lyrics; await A.saveTrack(E.t); E.dirty = false; close(true); A.toast('Lyrics removed.'); onTrack(); return; }
    if (what === 'save') return save();
  }
  async function save() {
    if (!E.lines.length) return A.toast('There are no words to save.');
    E.t.lyrics = { lines: E.lines.map(l => ({ text: l.text, t: l.t == null ? null : +l.t.toFixed(2), ...(l.gap ? { gap: true } : {}), ...(l.conf != null && l.conf < 1 ? { conf: l.conf } : {}) })), source: E.source, updated: Date.now() };
    try { await A.saveTrack(E.t); } catch (e) { return A.toast(`Could not save: ${e.message || e}`, 5000); }
    E.dirty = false; const timedNow = L.timed(E.lines); close(true); onTrack();
    A.toast(timedNow ? 'Lyrics saved. They follow the song in Now Playing.' : 'Words saved. Time them to make them follow the song.', 4000);
  }
  async function close(force) {
    if (!E) return; if (!force && E.dirty && !(await A.ask({ title: 'Close without saving?', text: 'Your changes to these lyrics are not saved yet.', ok: 'Close', danger: true }))) return;
    audio.removeEventListener('timeupdate', tick); audio.removeEventListener('play', tick); audio.removeEventListener('pause', tick);
    if (E.worker) E.worker.terminate(); if (E.tapKeys) document.removeEventListener('keydown', E.tapKeys, true);
    E.el.remove(); E = null;
  }
  function exportMenu(anchor) {
    if (!L.timed(E.lines)) return A.toast('Time every line first; a lyrics file needs the times.', 4000);
    const base = (E.t.title || 'lyrics').replace(/[\\/:*?"<>|]+/g, '-'), d = audio.duration || E.t.duration || 0, meta = { title: E.t.title, artist: E.t.artist, album: E.t.album };
    A.openMenu(anchor, [{ lbl: 'Save the timed lyrics as' },
      { label: '.lrc (music players, karaoke)', act: () => A.download(new Blob([L.toLRC(E.lines, meta)], { type: 'text/plain' }), base + '.lrc') },
      { label: '.srt (YouTube, video editors)', act: () => A.download(new Blob([L.toSRT(E.lines, d)], { type: 'text/plain' }), base + '.srt') },
      { label: '.vtt (web video)', act: () => A.download(new Blob([L.toVTT(E.lines, d)], { type: 'text/vtt' }), base + '.vtt') }]);
  }

  /* ---- automatic: hear the song, match the lines ---- */
  async function pcm16k(blob) { // the song as mono 16 kHz samples, as the recogniser wants it
    const buf = await blob.arrayBuffer(); const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 16000 });
    const ab = await ctx.decodeAudioData(buf); const out = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels; }
    return out;
  }
  async function autoTime(draft) {
    if (!draft && !E.lines.length) return A.toast('Paste the words first, or use “Write them from the song”.', 4500);
    if (draft && E.lines.length && !(await A.ask({ title: 'Replace the words?', text: 'The recogniser’s draft takes the place of the words in the box. You can correct it afterwards.', ok: 'Write a draft' }))) return;
    const btns = E.el.querySelectorAll('[data-e="auto"],[data-e="draft"],[data-e="tap"]'); btns.forEach(x => x.disabled = true);
    // a split vocal stem, when the song has one, is far easier to hear than the full mix
    const stem = [...A.tracks.values()].find(x => x.stemOf === E.id && x.stemName === 'vocals'), src = stem || E.t;
    try {
      status(`Reading ${stem ? 'the vocals stem of ' : ''}the song…`); bar(0);
      const pcm = await pcm16k(src.blob);
      const words = await new Promise((res, rej) => {
        const w = new Worker('asr-worker.js', { type: 'module' }); E.worker = w; const files = {};
        w.onmessage = m => { const d = m.data;
          if (d.type === 'load') { files[d.file] = d; const tot = Object.values(files).reduce((s, f) => s + (f.total || 0), 0), got = Object.values(files).reduce((s, f) => s + (f.loaded || 0), 0); status(`Getting the recogniser (one time only): ${Math.round(got / 1e6)} of ${Math.round(tot / 1e6)} MB`); bar(tot ? got / tot : 0); }
          else if (d.type === 'progress') { status(`Listening… ${Math.round(d.done * 100)}%`); bar(d.done); }
          else if (d.type === 'done') { w.terminate(); E && (E.worker = null); res(d.words); }
          else if (d.type === 'error') { w.terminate(); E && (E.worker = null); rej(new Error(d.message)); } };
        w.onerror = e => { w.terminate(); rej(new Error(e.message || 'the recogniser could not start')); };
        status('Starting the recogniser…'); w.postMessage({ audio: pcm }, [pcm.buffer]);
      });
      if (!E) return; bar(null);
      if (!words.length) { status('No words were heard in this song. Try tapping along instead.'); return; }
      if (draft) { E.lines = L.draftFromWords(words); E.source = 'heard'; E.el.querySelector('#lyrText').value = L.toText(E.lines); E.dirty = true; drawLines(); status(`A draft of ${E.lines.length} lines, timed as heard. Correct the words in the box; the times stay with their lines.`); return; }
      E.lines = L.align(E.lines, words, audio.duration || E.t.duration); E.source = 'auto'; E.dirty = true; drawLines();
      const unsure = E.lines.filter(l => l.conf < 0.5).length;
      status(unsure ? `Timed. ${unsure} of ${E.lines.length} lines are marked “check”: the recogniser did not hear them clearly, so their times are estimates. Play them and fix any that are off.` : `Timed all ${E.lines.length} lines. Play it through to check.`);
    } catch (e) { bar(null); status(`Automatic timing failed: ${e.message || e}. Tapping along always works.`); console.error(e); }
    finally { btns.forEach(x => x.disabled = false); }
  }

  /* ---- tap along: play the song, tap when each line starts ---- */
  function tapAlong() {
    if (!E.lines.length) return A.toast('Paste the words first.');
    const box = E.el.querySelector('#lyrTap'), list = E.el.querySelector('#lyrLines'); let i = Math.max(0, E.lines.findIndex(l => l.t == null)); if (i < 0) i = 0;
    const startAt = i > 0 && E.lines[i - 1].t != null ? Math.max(0, E.lines[i - 1].t - 2) : 0;
    if (A.curId !== E.id) A.loadTrack(E.id, false);
    box.hidden = false; list.hidden = true;
    const draw = () => { const p = E.lines[i - 1], c = E.lines[i], n = E.lines[i + 1];
      box.innerHTML = c ? `<p class="tp-prev">${p ? esc(p.text) : '&nbsp;'}</p><p class="tp-cur">${esc(c.text)}</p><p class="tp-next">${n ? esc(n.text) : '&nbsp;'}</p><button class="btn primary tp-btn" data-tap="go">Tap when this line starts <kbd>Space</kbd></button><p class="lyr-hint">Line ${i + 1} of ${E.lines.length} · <kbd>Backspace</kbd> takes the last tap back · <kbd>Esc</kbd> stops</p>`
        : `<p class="tp-cur">All ${E.lines.length} lines are timed.</p><button class="btn primary" data-tap="end">Done</button>`; };
    const tap = () => { if (!E.lines[i]) return; E.lines[i].t = +Math.max(0, audio.currentTime - 0.15).toFixed(2); E.lines[i].conf = 1; E.dirty = true; i++; E.source = 'tap'; draw(); if (!E.lines[i]) end(); };
    const back = () => { if (i === 0) return; i--; E.lines[i].t = null; audio.currentTime = Math.max(0, (E.lines[i - 1] && E.lines[i - 1].t != null ? E.lines[i - 1].t : audio.currentTime - 4) - 1); draw(); };
    const end = () => { document.removeEventListener('keydown', E.tapKeys, true); E.tapKeys = null; audio.pause(); box.hidden = true; list.hidden = false; drawLines(); status(L.timed(E.lines) ? 'Every line is timed. Play it through to check, then Save.' : 'Stopped. The lines you tapped keep their times.'); };
    E.tapKeys = ev => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); tap(); } else if (ev.key === 'Backspace') { ev.preventDefault(); ev.stopPropagation(); back(); } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(); } };
    document.addEventListener('keydown', E.tapKeys, true);
    box.onclick = ev => { const t = ev.target.closest('[data-tap]'); if (!t) return; t.blur(); if (t.dataset.tap === 'go') tap(); else end(); };
    draw(); audio.currentTime = startAt; audio.play().catch(() => {}); status('Tap along: press Space (or the button) the moment each line starts.');
  }

  // Esc closes the editor before the player sees it; Space in the editor must not reach the player's shortcut
  document.addEventListener('keydown', ev => { if (!E || E.tapKeys) return; if (ev.key === 'Escape' && $('#modal').hidden && $('#menu').hidden) { ev.stopPropagation(); close(); } else if (ev.key === ' ' && !ev.target.closest('input, textarea, button')) { ev.preventDefault(); ev.stopPropagation(); audio.paused ? audio.play().catch(() => {}) : audio.pause(); } }, true);

  window.MixtapeLyrics = { edit, onTrack, get open() { return E; } };
  onTrack();
})();
