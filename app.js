(() => {
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const fmt = s => { s = isFinite(s) && s > 0 ? Math.floor(s) : 0; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fmtLong = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const hueOf = str => { let h = 0; for (const c of String(str || '')) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };
const shuffled = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---------- storage ---------- */
const LS_KEY = 'mixtape-player-v1';
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } };
const lsSet = o => { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {} };
let db = null;
function idbOpen() {
  return new Promise((res, rej) => {
    let r; try { r = indexedDB.open('mixtape-player', 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => { const d = r.result;
      if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('lists')) d.createObjectStore('lists', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
    setTimeout(() => rej(new Error('timeout')), 6000);
  });
}
function req(store, mode, fn) {
  if (!db) return mode === 'readonly' ? Promise.resolve([]) : Promise.reject(new Error('no storage'));
  return new Promise((res, rej) => { let out;
    try { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    } catch (e) { rej(e); } });
}
const dbAll = s => req(s, 'readonly', o => o.getAll()).catch(() => []);
const dbPut = (s, v) => req(s, 'readwrite', o => o.put(v));
const dbDel = (s, k) => req(s, 'readwrite', o => o.delete(k)).catch(() => {});
async function saveTrack(t) {
  try { await dbPut('tracks', t); }
  catch (e) { const buf = await t.blob.arrayBuffer(); const copy = { ...t, buf }; delete copy.blob; await dbPut('tracks', copy); }
}

/* ---------- state ---------- */
const tracks = new Map(); let lists = []; let favs = new Set();
const S = Object.assign({ vol: 80, muted: false, shuffle: false, repeat: 'off', speed: 1, sort: 'added', view: { type: 'all' },
  lastId: null, pos: 0, queue: [], orig: [], qi: -1, ctx: 'All songs' }, lsGet());
const save = () => lsSet(S);
let query = '', curId = null, curUrl = null, seeking = false, lastSave = 0, booted = false;
let sleepAt = 0, sleepEnd = false, sleepT = null;
const audio = $('#audio');

/* ---------- artwork ---------- */
const artUrls = new Map();
function artUrl(t) { if (!t || !t.art) return null; let u = artUrls.get(t.id); if (!u) { try { u = URL.createObjectURL(t.art); artUrls.set(t.id, u); } catch (e) { return null; } } return u; }
function artHTML(t) {
  if (!t) return `<span class="ph" style="--h:270">♪</span>`;
  const u = artUrl(t); if (u) return `<img src="${u}" alt="">`;
  return `<span class="ph" style="--h:${hueOf(t.album || t.title)}">${esc((t.title || '?').trim().charAt(0).toUpperCase() || '♪')}</span>`;
}

/* ---------- views ---------- */
const curList = () => S.view.type === 'list' ? lists.find(l => l.id === S.view.id) : null;
function viewName(v = S.view) { if (v.type === 'fav') return 'Favorites'; if (v.type === 'list') { const l = lists.find(x => x.id === v.id); return l ? l.name : 'Playlist'; } return 'All songs'; }
/* Stems made in the Studio are working files: they stay out of the song list */
const songIds = () => [...tracks.keys()].filter(id => !tracks.get(id).stemOf && tracks.get(id).kind !== 'video');
function baseIds() {
  if (S.view.type === 'fav') return songIds().filter(id => favs.has(id));
  if (S.view.type === 'list') { const l = curList(); return l ? l.ids.filter(id => tracks.has(id)) : []; }
  return songIds();
}
function visibleIds() {
  let ids = baseIds(); const T = id => tracks.get(id);
  if (query) { const w = query.toLowerCase().split(/\s+/).filter(Boolean);
    ids = ids.filter(id => { const t = T(id); const hay = `${t.title} ${t.artist} ${t.album} ${t.name}`.toLowerCase(); return w.every(x => hay.includes(x)); }); }
  const cmp = (a, b) => String(a || '￿').localeCompare(String(b || '￿'), undefined, { sensitivity: 'base', numeric: true });
  const by = S.sort;
  if (by === 'added') { if (S.view.type !== 'list') ids.sort((a, b) => T(b).added - T(a).added); }
  else if (by === 'title') ids.sort((a, b) => cmp(T(a).title, T(b).title));
  else if (by === 'artist') ids.sort((a, b) => cmp(T(a).artist, T(b).artist) || cmp(T(a).title, T(b).title));
  else if (by === 'album') ids.sort((a, b) => cmp(T(a).album, T(b).album) || (T(a).track || 0) - (T(b).track || 0) || cmp(T(a).title, T(b).title));
  else if (by === 'dur') ids.sort((a, b) => (T(a).duration || 0) - (T(b).duration || 0));
  return ids;
}
function setView(v) { S.view = v; save(); render(); window.scrollTo({ top: 0 }); }

/* ---------- render ---------- */
function renderNav() {
  const chip = (type, id, label, n) => { const on = S.view.type === type && (type !== 'list' || S.view.id === id);
    return `<button class="chip" data-act="view" data-type="${type}" data-id="${id || ''}" aria-current="${on}">${esc(label)} <span class="n">${n}</span></button>`; };
  const live = ids => ids.filter(id => tracks.has(id)).length;
  $('#nav').innerHTML = chip('all', '', 'All songs', songIds().length) + chip('fav', '', 'Favorites', live([...favs]))
    + lists.map(l => chip('list', l.id, l.name, live(l.ids))).join('')
    + `<button class="chip ghost" data-act="newlist">+ New playlist</button>`;
  $('#libCount').textContent = booted ? `${plural(songIds().length, 'song')} · ${plural(lists.length, 'playlist')}` : 'Loading your library…';
}
function rowHTML(t, n) {
  const cur = t.id === curId;
  return `<li class="row${cur ? ' is-cur' : ''}" data-id="${t.id}" tabindex="0">
    <span class="idx">${cur ? '<span class="eq"><i></i><i></i><i></i></span>' : n}</span>
    <span class="art sm">${artHTML(t)}</span>
    <span class="meta"><b>${esc(t.title)}</b><span>${esc(t.artist || 'Unknown artist')}${t.album ? ' · ' + esc(t.album) : ''}</span></span>
    <button class="ib fav${favs.has(t.id) ? ' on' : ''}" data-row="fav" aria-label="${favs.has(t.id) ? 'Remove from favorites' : 'Add to favorites'}"><svg class="i heart"><use href="#i-heart"/></svg></button>
    <span class="dur">${fmt(t.duration)}</span>
    <button class="ib" data-row="more" aria-label="More options for ${esc(t.title)}"><svg class="i"><use href="#i-more"/></svg></button></li>`;
}
function renderList() {
  const ids = visibleIds(), list = $('#list'), empty = $('#empty');
  list.innerHTML = ids.map((id, i) => rowHTML(tracks.get(id), i + 1)).join('');
  list.classList.toggle('paused', audio.paused);
  $('#viewTitle').textContent = viewName();
  const total = ids.reduce((s, id) => s + (tracks.get(id).duration || 0), 0);
  $('#viewSub').textContent = ids.length ? `${plural(ids.length, 'song')} · ${fmtLong(total)}${query ? ` matching “${query}”` : ''}` : '';
  $('#playAllBtn').disabled = $('#shufAllBtn').disabled = !ids.length;
  $('#listMoreBtn').hidden = S.view.type !== 'list';
  $('#sort').value = S.sort;
  $('#sort').options[0].textContent = S.view.type === 'list' ? 'Playlist order' : 'Recently added';
  const touch = matchMedia('(pointer:coarse)').matches;
  let html = '';
  if (!booted) html = '';
  else if (!tracks.size) html = `<h3>Your songs live here</h3>
      <p>Add the music files you have on this ${touch ? 'phone' : 'computer'}. They're saved in this browser, so they're still here the next time you open the player.${touch ? '' : ' You can also drag files or a whole folder onto this page.'}</p>
      <div class="btns"><button class="btn primary" data-act="add"><svg class="i"><use href="#i-plus"/></svg>Add songs</button>
      ${touch ? '' : '<button class="btn" data-act="folder"><svg class="i"><use href="#i-folder"/></svg>Add folder</button>'}
      <button class="btn" data-act="demo">Try a demo track</button></div>`;
  else if (!ids.length && query) html = `<h3>No songs match “${esc(query)}”</h3><p>Try part of a title, artist or album name.</p>`;
  else if (!ids.length && S.view.type === 'fav') html = `<h3>No favorites yet</h3><p>Tap the heart on any song and it shows up here.</p>`;
  else if (!ids.length) html = `<h3>This playlist is empty</h3><p>Open a song's ⋯ menu and choose Add to playlist.</p>`;
  empty.innerHTML = html; empty.hidden = !html;
}
function renderTransport() {
  const playing = !audio.paused;
  document.body.classList.toggle('playing', playing);
  $('#list').classList.toggle('paused', !playing);
  $$('.js-play-icon').forEach(u => u.setAttribute('href', playing ? '#i-pause' : '#i-play'));
  $$('[data-act="toggle"]').forEach(b => b.setAttribute('aria-label', playing ? 'Pause' : 'Play'));
  $$('[data-act="shuffle"]').forEach(b => { b.classList.toggle('on', S.shuffle); b.setAttribute('aria-pressed', S.shuffle); b.setAttribute('aria-label', S.shuffle ? 'Shuffle is on' : 'Shuffle is off'); });
  $$('[data-act="repeat"]').forEach(b => { b.classList.toggle('on', S.repeat !== 'off'); b.setAttribute('aria-label', { off: 'Repeat is off', all: 'Repeating all', one: 'Repeating this song' }[S.repeat]); });
  $$('.js-rep-icon').forEach(u => u.setAttribute('href', S.repeat === 'one' ? '#i-repeat1' : '#i-repeat'));
  const fav = !!curId && favs.has(curId);
  $$('[data-act="fav"]').forEach(b => { b.classList.toggle('on', fav); b.disabled = !curId; b.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites'); });
  $('#speedBtn').textContent = `${S.speed}× speed`; $('#speedBtn').classList.toggle('on', S.speed !== 1);
  renderSleep(); applyLoop();
}
function renderPlayer() {
  const t = tracks.get(curId);
  $('#barArt').innerHTML = $('#nowArt').innerHTML = artHTML(t);
  $('#barTitle').textContent = $('#nowTitle').textContent = t ? t.title : 'Nothing playing';
  $('#barArtist').textContent = t ? (t.artist || 'Unknown artist') : 'Pick a song to start';
  $('#nowArtist').textContent = t ? [t.artist || 'Unknown artist', t.album].filter(Boolean).join(' · ') : '';
  $('#nowCtx').textContent = t ? `Playing from ${S.ctx}` : 'Now Playing';
  $('#now').style.setProperty('--nh', t ? hueOf(t.album || t.title) : 270);
  if (t && !isFinite(audio.duration)) $$('.js-dur').forEach(e => e.textContent = fmt(t.duration));
  renderTransport(); renderUpNext();
}
function renderUpNext() {
  const rest = S.queue.slice(S.qi + 1);
  $('#upCount').textContent = rest.length ? plural(rest.length, 'song') : '';
  $('#upList').innerHTML = rest.length ? rest.slice(0, 150).map((id, k) => { const t = tracks.get(id); if (!t) return '';
    return `<li class="row" data-qi="${S.qi + 1 + k}" tabindex="0"><span class="art sm">${artHTML(t)}</span>
      <span class="meta"><b>${esc(t.title)}</b><span>${esc(t.artist || 'Unknown artist')}</span></span>
      <button class="ib" data-up="rm" aria-label="Remove from queue"><svg class="i"><use href="#i-close"/></svg></button></li>`; }).join('')
    : `<li class="upempty">${!curId ? 'Play a song and the rest of the list lines up here.' : S.repeat === 'all' ? 'Repeat is on, so the list starts over after this song.' : 'Nothing after this song.'}</li>`;
}
function render() { renderNav(); renderList(); renderPlayer(); }

/* ---------- playback ---------- */
function loadTrack(id, autoplay, startAt = 0) {
  const t = tracks.get(id); if (!t) return;
  curId = id; S.lastId = id; S.pos = startAt;
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = URL.createObjectURL(t.blob);
  audio.src = curUrl; audio.defaultPlaybackRate = S.speed; audio.playbackRate = S.speed;
  if (startAt > 0) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = Math.min(startAt, Math.max(0, audio.duration - 1)); } catch (e) {} }, { once: true });
  setSeekUI(0, startAt);
  if (autoplay) { const p = audio.play(); if (p) p.catch(err => { if (err.name !== 'AbortError') toast(`Couldn't start “${t.title}”. Tap play to try again.`); }); }
  setMeta(t); renderList(); renderPlayer(); save();
}
function playFrom(ids, startId) {
  if (!ids.length) return;
  S.orig = ids.slice(); S.ctx = query ? `search “${query}”` : viewName();
  if (!startId) startId = S.shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
  S.queue = S.shuffle ? [startId, ...shuffled(ids.filter(x => x !== startId))] : ids.slice();
  S.qi = S.queue.indexOf(startId);
  loadTrack(startId, true);
}
function togglePlay() {
  if (!curId) { const ids = visibleIds(); if (ids.length) playFrom(ids); else if (!tracks.size) toast('Add some songs first.'); return; }
  if (audio.paused) { const p = audio.play(); if (p) p.catch(() => toast('Playback was blocked. Tap play again.')); } else audio.pause();
}
function next(auto) {
  if (!S.queue.length) return;
  if (S.qi < S.queue.length - 1) S.qi++;
  else if (S.repeat === 'all' || !auto) {
    if (S.shuffle && S.orig.length > 2) { const last = S.queue[S.qi]; const nq = shuffled(S.orig); if (nq[0] === last) nq.push(nq.shift()); S.queue = nq; }
    S.qi = 0;
  } else { S.qi = 0; loadTrack(S.queue[0], false); toast('That was the last song. Turn on repeat to keep going.'); return; }
  loadTrack(S.queue[S.qi], true);
}
function prev() {
  if (audio.currentTime > 3 || !S.queue.length) { audio.currentTime = 0; return; }
  if (S.qi > 0) S.qi--; else if (S.repeat === 'all') S.qi = S.queue.length - 1; else { audio.currentTime = 0; return; }
  loadTrack(S.queue[S.qi], true);
}
function seekBy(d) { if (!curId || !isFinite(audio.duration)) return; audio.currentTime = Math.max(0, Math.min(audio.duration - 0.25, audio.currentTime + d)); }
function toggleShuffle() {
  S.shuffle = !S.shuffle;
  if (curId && S.queue.length) {
    if (S.shuffle) { S.queue = [curId, ...shuffled(S.orig.filter(x => x !== curId))]; S.qi = 0; }
    else { S.queue = S.orig.slice(); S.qi = Math.max(0, S.queue.indexOf(curId)); }
  }
  toast(S.shuffle ? 'Shuffle on' : 'Shuffle off'); renderTransport(); renderUpNext(); save();
}
function cycleRepeat() {
  S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat] || 'off';
  toast({ off: 'Repeat off', all: 'Repeating all songs', one: 'Repeating this song' }[S.repeat]);
  renderTransport(); renderUpNext(); save();
}
const applyLoop = () => { audio.loop = S.repeat === 'one' && !sleepEnd; };
function cycleSpeed() { const sp = [0.75, 1, 1.25, 1.5, 2]; S.speed = sp[(sp.indexOf(S.speed) + 1) % sp.length]; audio.defaultPlaybackRate = audio.playbackRate = S.speed; renderTransport(); save(); }
function applyVol() {
  audio.volume = S.vol / 100; audio.muted = S.muted;
  const v = S.muted ? 0 : S.vol;
  $$('.vol').forEach(r => { r.value = v; r.style.setProperty('--p', v + '%'); });
  $$('.js-vol-icon').forEach(u => u.setAttribute('href', v === 0 ? '#i-mute' : '#i-vol'));
  $$('[data-act="mute"]').forEach(b => b.setAttribute('aria-label', v === 0 ? 'Unmute' : 'Mute'));
}
function toggleMute() { if (S.muted || S.vol === 0) { S.muted = false; if (S.vol === 0) S.vol = 60; } else S.muted = true; applyVol(); save(); }
function setVol(v) { S.vol = Math.max(0, Math.min(100, Math.round(v))); S.muted = false; applyVol(); save(); }
function setSeekUI(v, t) { $$('.seek').forEach(r => { r.value = v; r.style.setProperty('--p', v / 10 + '%'); }); $$('.js-cur').forEach(e => e.textContent = fmt(t)); }

/* queue edits */
function playNext(id) { if (!curId) return playFrom([id], id); S.queue.splice(S.qi + 1, 0, id); S.orig.splice(S.orig.indexOf(curId) + 1, 0, id); toast(`“${tracks.get(id).title}” plays next`); renderUpNext(); save(); }
function addToQueue(id) { if (!curId) return playFrom([id], id); S.queue.push(id); S.orig.push(id); toast(`Added “${tracks.get(id).title}” to the queue`); renderUpNext(); save(); }
function removeFromQueue(i) { if (i <= S.qi) return; const id = S.queue.splice(i, 1)[0]; const oi = S.orig.lastIndexOf(id); if (oi > -1) S.orig.splice(oi, 1); renderUpNext(); save(); }

/* sleep timer */
function setSleep(m) {
  clearTimeout(sleepT); sleepT = null; sleepAt = 0; sleepEnd = false;
  if (m === 'end') { sleepEnd = true; toast('Music stops after this song'); }
  else if (m) { sleepAt = Date.now() + m * 60000; sleepT = setTimeout(() => { audio.pause(); setSleep(0); toast('Sleep timer: music paused'); }, m * 60000); toast(`Music stops in ${m} minutes`); }
  renderTransport();
}
function renderSleep() {
  const on = sleepEnd || sleepAt > 0;
  $('#sleepLbl').textContent = sleepEnd ? 'Stops after this song' : sleepAt ? `Stops in ${Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000))} min` : 'Sleep timer';
  $('#sleepBtn').classList.toggle('on', on);
}

/* media session: lock screen, headphones, keyboard media keys */
function setMeta(t) {
  if (!('mediaSession' in navigator)) return;
  try { const u = artUrl(t);
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '', artwork: u ? [{ src: u, sizes: '512x512', type: t.art.type || 'image/jpeg' }] : [] });
  } catch (e) {}
}
if ('mediaSession' in navigator) {
  [['play', () => audio.play().catch(() => {})], ['pause', () => audio.pause()], ['previoustrack', prev], ['nexttrack', () => next(false)],
   ['seekbackward', d => seekBy(-(d.seekOffset || 10))], ['seekforward', d => seekBy(d.seekOffset || 10)],
   ['seekto', d => { if (isFinite(d.seekTime)) audio.currentTime = d.seekTime; }]]
    .forEach(([a, h]) => { try { navigator.mediaSession.setActionHandler(a, h); } catch (e) {} });
}
function setPosState() {
  try { if (navigator.mediaSession && navigator.mediaSession.setPositionState && isFinite(audio.duration) && audio.duration > 0)
    navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) }); } catch (e) {}
}

audio.addEventListener('play', () => { renderTransport(); try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {} });
audio.addEventListener('pause', () => { renderTransport(); S.pos = audio.currentTime; save(); try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {} });
audio.addEventListener('ended', () => {
  if (sleepEnd) { setSleep(0); audio.currentTime = 0; toast('Sleep timer: music stopped'); return; }
  next(true);
});
audio.addEventListener('loadedmetadata', () => {
  $$('.js-dur').forEach(e => e.textContent = fmt(audio.duration));
  const t = tracks.get(curId);
  if (t && isFinite(audio.duration) && Math.abs((t.duration || 0) - audio.duration) > 1) { t.duration = audio.duration; saveTrack(t).catch(() => {}); }
  setPosState();
});
audio.addEventListener('timeupdate', () => {
  const d = audio.duration;
  if (!seeking && isFinite(d) && d > 0) setSeekUI(Math.round(audio.currentTime / d * 1000), audio.currentTime);
  const now = Date.now();
  if (now - lastSave > 4000) { lastSave = now; S.pos = audio.currentTime; save(); setPosState(); if (sleepAt) renderSleep(); }
});
audio.addEventListener('error', () => {
  const t = tracks.get(curId);
  if (t && audio.getAttribute('src')) toast(`This browser can't play “${t.title}”. Try an MP3 or M4A copy of it.`, 5000);
});

/* ---------- library edits ---------- */
function toggleFav(id) {
  const t = tracks.get(id); if (!t) return;
  if (favs.has(id)) { favs.delete(id); toast('Removed from favorites'); } else { favs.add(id); toast('Added to favorites'); }
  dbPut('lists', { id: '__fav', ids: [...favs] }).catch(() => {});
  renderNav(); renderList(); renderTransport();
}
async function newList(addId) {
  const name = await ask({ title: 'New playlist', input: '', placeholder: 'Name it, e.g. Morning run', ok: 'Create playlist' });
  if (!name) return;
  const l = { id: uid(), name, ids: addId ? [addId] : [], created: Date.now() };
  lists.push(l); dbPut('lists', l).catch(() => {});
  if (addId) { toast(`Added to ${name}`); renderNav(); } else setView({ type: 'list', id: l.id });
}
function addToList(l, id) {
  if (l.ids.includes(id)) return toast(`Already in ${l.name}`);
  l.ids.push(id); dbPut('lists', l).catch(() => {}); toast(`Added to ${l.name}`); renderNav(); if (curList() === l) renderList();
}
function removeFromList(l, id) { l.ids = l.ids.filter(x => x !== id); dbPut('lists', l).catch(() => {}); toast(`Removed from ${l.name}`); renderNav(); renderList(); }
async function renameList(l) {
  const name = await ask({ title: 'Rename playlist', input: l.name, ok: 'Save' }); if (!name) return;
  l.name = name; dbPut('lists', l).catch(() => {}); render();
}
async function deleteList(l) {
  const ok = await ask({ title: `Delete “${l.name}”?`, text: 'The playlist goes away. The songs stay in your library.', ok: 'Delete playlist', danger: true });
  if (!ok) return; lists = lists.filter(x => x !== l); dbDel('lists', l.id); setView({ type: 'all' }); toast('Playlist deleted');
}
async function deleteTrack(id) {
  const t = tracks.get(id); if (!t) return;
  const ok = await ask({ title: 'Remove from library?', text: `“${t.title}” is removed from this player and from every playlist. The original file on your device is not touched.`, ok: 'Remove song', danger: true });
  if (!ok) return;
  const wasCur = id === curId, wasPlaying = wasCur && !audio.paused;
  if (wasCur) { audio.pause(); audio.removeAttribute('src'); audio.load(); curId = null; S.lastId = null; }
  const before = S.queue.slice(0, S.qi).filter(x => x === id).length;
  S.queue = S.queue.filter(x => x !== id); S.orig = S.orig.filter(x => x !== id); S.qi -= before;
  if (wasCur) { if (S.queue.length) { S.qi = Math.min(Math.max(S.qi, 0), S.queue.length - 1); loadTrack(S.queue[S.qi], wasPlaying); } else S.qi = -1; }
  tracks.delete(id); favs.delete(id); dbPut('lists', { id: '__fav', ids: [...favs] }).catch(() => {});
  lists.forEach(l => { if (l.ids.includes(id)) { l.ids = l.ids.filter(x => x !== id); dbPut('lists', l).catch(() => {}); } });
  const u = artUrls.get(id); if (u) { URL.revokeObjectURL(u); artUrls.delete(id); }
  for (const s of [...tracks.values()].filter(x => x.stemOf === id)) { tracks.delete(s.id); dbDel('tracks', s.id); }
  dbDel('tracks', id); save(); render(); updateStorage(); toast('Song removed');
}

/* ---------- importing ---------- */
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|weba|aif|aiff|caf)$/i;
const isAudio = f => f && ((f.type || '').startsWith('audio/') || AUDIO_EXT.test(f.name || ''));
const clean = s => typeof s === 'string' ? s.replace(/\0/g, '').trim() : '';
function parseName(n) {
  let b = n.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  b = b.replace(/^\d{1,3}\s*[-.)]\s*/, '').replace(/^\d{2}\s+(?=\D)/, '');
  const m = b.split(/\s+[-–—]\s+/);
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { artist: '', title: b || n };
}
/* Built-in tag reader (works offline): ID3v2.2/2.3/2.4 and ID3v1, which covers MP3 files. Other formats fall back to the filename. */
const syncsafe = (b, o) => (b[o] & 127) << 21 | (b[o + 1] & 127) << 14 | (b[o + 2] & 127) << 7 | (b[o + 3] & 127);
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function unsync(b) { const out = []; for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xFF && b[i + 1] === 0) i++; } return new Uint8Array(out); }
function decodeText(b, enc) {
  try {
    if (enc === 0) return new TextDecoder('iso-8859-1').decode(b);
    if (enc === 3) return new TextDecoder('utf-8').decode(b);
    if (enc === 2) return new TextDecoder('utf-16be').decode(b);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    return new TextDecoder('utf-16le').decode(b);
  } catch (e) { return ''; }
}
const frameText = f => decodeText(f.subarray(1), f[0]).split('\0').filter(Boolean)[0] || '';
function framePic(f, v22) {
  const enc = f[0]; let i = 1, mime;
  if (v22) { mime = 'image/' + String.fromCharCode(f[1], f[2], f[3]).toLowerCase().replace('jpg', 'jpeg'); i = 4; }
  else { while (i < f.length && f[i] !== 0) i++; mime = String.fromCharCode(...f.subarray(1, i)).toLowerCase(); i++; }
  i++; /* picture type */
  if (enc === 1 || enc === 2) { while (i + 1 < f.length && !(f[i] === 0 && f[i + 1] === 0)) i += 2; i += 2; }
  else { while (i < f.length && f[i] !== 0) i++; i++; }
  if (!mime.includes('/')) mime = 'image/' + (mime.replace('jpg', 'jpeg') || 'jpeg');
  return { data: f.subarray(i), format: mime };
}
async function readTags(file) {
  try {
    const h = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return await readID3v1(file);
    const ver = h[3], flags = h[5], size = syncsafe(h, 6);
    let d = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    if ((flags & 0x80) && ver < 4) d = unsync(d);
    let p = 0; if ((flags & 0x40) && ver > 2) p = ver === 3 ? u32(d, 0) + 4 : syncsafe(d, 0);
    const v22 = ver === 2, hs = v22 ? 6 : 10, out = {};
    const map = v22 ? { TT2: 'title', TP1: 'artist', TAL: 'album', TRK: 'track' } : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TRCK: 'track' };
    while (p + hs <= d.length) {
      const id = String.fromCharCode(...d.subarray(p, p + (v22 ? 3 : 4)));
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const fs = v22 ? (d[p + 3] << 16 | d[p + 4] << 8 | d[p + 5]) : ver === 4 ? syncsafe(d, p + 4) : u32(d, p + 4);
      const ff = v22 ? 0 : d[p + 9]; p += hs;
      if (fs <= 0 || p + fs > d.length) break;
      let f = d.subarray(p, p + fs); p += fs;
      if (ver === 4 && (ff & 0x02)) f = unsync(f);
      if (ver === 4 && (ff & 0x01)) f = f.subarray(4);
      if (map[id] && !out[map[id]]) out[map[id]] = frameText(f);
      else if ((id === 'APIC' || id === 'PIC') && !out.picture) out.picture = framePic(f, v22);
    }
    if (!out.title && !out.artist) { const v1 = await readID3v1(file); return { ...v1, ...out, title: out.title || v1.title, artist: out.artist || v1.artist }; }
    return out;
  } catch (e) { return {}; }
}
async function readID3v1(file) {
  try {
    if (file.size < 128) return {};
    const b = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
    if (b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return {};
    const s = (o, n) => decodeText(b.subarray(o, o + n), 0).split('\0')[0].trim();
    return { title: s(3, 30), artist: s(33, 30), album: s(63, 30) };
  } catch (e) { return {}; }
}
function pictureBlob(p) { try { if (!p || !p.data || !p.data.length) return null; const f = String(p.format || ''); return new Blob([new Uint8Array(p.data)], { type: f.includes('/') ? f : 'image/jpeg' }); } catch (e) { return null; } }
function probeDuration(blob) {
  return new Promise(res => { const a = new Audio(); const u = URL.createObjectURL(blob); let done = false;
    const fin = d => { if (done) return; done = true; URL.revokeObjectURL(u); a.removeAttribute('src'); res(isFinite(d) ? d : 0); };
    a.preload = 'metadata'; a.onloadedmetadata = () => fin(a.duration); a.onerror = () => fin(0); setTimeout(() => fin(0), 8000); a.src = u; });
}
let importing = false;
/* ---------- moving songs between phone and laptop ----------
   One file carries the songs, their details and artwork, favourites and playlists. Send it to the
   other device however suits (USB cable, Google Drive, a message to yourself) and open it there.
   Nothing goes through any server. */
const PACK_MAGIC = 'MIXTAPE-PACK-1\n';
function download(blob, name) { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }
function buildPack() {
  const ids = songIds(), keep = new Set(ids);
  const head = { format: 'mixtape-pack/1', exportedAt: new Date().toISOString(), tracks: [],
    lists: lists.map(l => ({ name: l.name, ids: l.ids.filter(id => keep.has(id)) })), favs: [...favs].filter(id => keep.has(id)) };
  const parts = []; let off = 0;
  for (const id of ids) {
    const { blob, art, buf, ...meta } = tracks.get(id);
    head.tracks.push({ ...meta, offset: off, bytes: blob.size, artType: art ? art.type : null, artBytes: art ? art.size : 0 });
    parts.push(blob); off += blob.size; if (art) { parts.push(art); off += art.size; }
  }
  const hb = new TextEncoder().encode(JSON.stringify(head)), len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, hb.length);
  return { blob: new Blob([PACK_MAGIC, len, hb, ...parts], { type: 'application/octet-stream' }), count: ids.length };
}
function exportPack() {
  if (!songIds().length) return toast('There are no songs to move yet.');
  const { blob, count } = buildPack();
  download(blob, `Mixtape songs ${new Date().toISOString().slice(0, 10)}.mixtape`);
  toast(`Put ${plural(count, 'song')} (${Math.max(1, Math.round(blob.size / 1048576))} MB) into one file. Send it to your other device and open it there with Move songs → Get songs from a file.`, 8000);
}
async function importPack(file) {
  const ml = PACK_MAGIC.length;
  if (await file.slice(0, ml).text() !== PACK_MAGIC) return toast('That file is not a Mixtape songs file.', 4000);
  const hl = new DataView(await file.slice(ml, ml + 4).arrayBuffer()).getUint32(0), base = ml + 4 + hl;
  let head; try { head = JSON.parse(await file.slice(ml + 4, base).text()); } catch (e) { return toast('That songs file is damaged.', 4000); }
  if (head.format !== 'mixtape-pack/1') return toast('That songs file was made by a newer Mixtape. Update this one first.', 5000);
  const have = new Map([...tracks.values()].map(t => [t.name + '|' + t.size, t.id])), idMap = new Map();
  let added = 0, dup = 0, lost = 0;
  for (const [i, m] of head.tracks.entries()) {
    toast(`Getting ${i + 1} of ${head.tracks.length}: ${m.title}`, 0);
    if (tracks.has(m.id)) { idMap.set(m.id, m.id); dup++; continue; }
    const key = m.name + '|' + m.size; if (have.has(key)) { idMap.set(m.id, have.get(key)); dup++; continue; }
    const s = base + m.offset;
    // copied out of the file, so the songs stay after the file is deleted
    const blob = new Blob([await file.slice(s, s + m.bytes).arrayBuffer()], { type: m.type || '' });
    const art = m.artBytes ? new Blob([await file.slice(s + m.bytes, s + m.bytes + m.artBytes).arrayBuffer()], { type: m.artType || 'image/jpeg' }) : null;
    const { offset, bytes, artType, artBytes, ...meta } = m; void offset; void bytes; void artType; void artBytes;
    const t = { ...meta, blob, art };
    tracks.set(t.id, t); idMap.set(m.id, t.id);
    try { await saveTrack(t); added++; } catch (e) { lost++; }
    if (i % 5 === 0) { renderNav(); renderList(); }
  }
  for (const pl of head.lists || []) { // playlists join up by name
    let l = lists.find(x => x.name === pl.name); if (!l) { l = { id: uid(), name: pl.name, ids: [], created: Date.now() }; lists.push(l); }
    for (const id of pl.ids.map(x => idMap.get(x)).filter(Boolean)) if (!l.ids.includes(id)) l.ids.push(id);
    await dbPut('lists', l).catch(() => {});
  }
  for (const id of head.favs || []) { const n = idMap.get(id); if (n) favs.add(n); }
  await dbPut('lists', { id: '__fav', ids: [...favs] }).catch(() => {});
  render(); updateStorage();
  try { new BroadcastChannel('mixtape').postMessage({ type: 'library' }); } catch (e) {}
  const bits = [`Added ${plural(added, 'song')}`]; if (dup) bits.push(`${dup} you already had`); if ((head.lists || []).length) bits.push('playlists joined up'); if (lost) bits.push(`${lost} could not be saved on this device`);
  toast(bits.join(' · '), lost ? 7000 : 4500);
}
async function importFiles(list) {
  const files = [...list].filter(isAudio);
  if (!files.length) { toast('No songs found there. Pick audio files such as MP3, M4A, WAV, OGG or FLAC.', 4500); return []; }
  if (importing) { toast('Still adding the last batch. Try again in a moment.'); return []; }
  importing = true;
  const seen = new Map([...tracks.values()].map(t => [t.name + '|' + t.size, t.id]));
  const ids = [];
  let added = 0, dup = 0, lost = 0; const base = Date.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; toast(`Adding ${i + 1} of ${files.length}: ${f.name}`, 0);
    const key = f.name + '|' + f.size; if (seen.has(key)) { dup++; ids.push(seen.get(key)); continue; }
    const tags = await readTags(f), guess = parseName(f.name);
    const t = { id: uid(), name: f.name, size: f.size, type: f.type || '', title: clean(tags.title) || guess.title, artist: clean(tags.artist) || guess.artist,
      album: clean(tags.album), track: parseInt(tags.track, 10) || 0, duration: await probeDuration(f), added: base - i, blob: f, art: pictureBlob(tags.picture) };
    tracks.set(t.id, t); seen.set(key, t.id); ids.push(t.id);
    try { await saveTrack(t); } catch (e) { lost++; }
    added++;
    if (i % 5 === 0) { renderNav(); renderList(); }
  }
  importing = false; render(); updateStorage();
  const parts = [`Added ${plural(added, 'song')}`];
  if (dup) parts.push(`${dup} already in your library`);
  if (lost) parts.push(`${lost} couldn't be saved here and will be gone when you close the page`);
  toast(parts.join(' · '), lost ? 7000 : 3500);
  return ids;
}
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(en) {
    if (en.isFile) { const f = await new Promise(r => en.file(r, () => r(null))); if (f) out.push(f); }
    else if (en.isDirectory) { const rd = en.createReader(); let batch;
      do { batch = await new Promise(r => rd.readEntries(r, () => r([]))); for (const b of batch) await walk(b); } while (batch.length); }
  }
  for (const en of entries) await walk(en);
  return out;
}
function makeDemoWav() {
  const sr = 22050, eighth = 60 / 112 / 2;
  const mel = [72, 74, 76, 79, 76, 74, 72, 69, 72, 74, 76, 79, 81, 79, 76, 74, 76, 79, 81, 84, 81, 79, 76, 74, 72, 74, 72, 69, 67, 69, 72, 0];
  const bass = [48, 45, 41, 43];
  const loops = 2, len = mel.length * eighth * loops + 1.5, n = Math.ceil(sr * len), buf = new Float32Array(n);
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const note = (m, start, dur, amp, decay, bright) => { if (!m) return; const f = hz(m), s0 = Math.floor(start * sr), cnt = Math.floor(dur * sr);
    for (let k = 0; k < cnt && s0 + k < n; k++) { const t = k / sr; const env = Math.min(1, k / (0.008 * sr)) * Math.exp(-decay * t) * Math.min(1, (cnt - k) / (0.02 * sr));
      buf[s0 + k] += amp * env * (Math.sin(2 * Math.PI * f * t) + bright * Math.sin(4 * Math.PI * f * t) + bright * .4 * Math.sin(6 * Math.PI * f * t)); } };
  for (let L = 0; L < loops; L++) {
    const off = L * mel.length * eighth;
    mel.forEach((m, i) => note(m, off + i * eighth, eighth * 1.6, .2, 3.2, .35));
    for (let b = 0; b < mel.length / 4; b++) note(bass[b % 4], off + b * 4 * eighth, eighth * 4, .22, 1.2, .15);
  }
  const fade = sr * 1.2; for (let k = 0; k < fade; k++) buf[n - 1 - k] *= k / fade;
  const ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let k = 0; k < n; k++) v.setInt16(44 + k * 2, Math.max(-1, Math.min(1, buf[k])) * 32000, true);
  return new Blob([ab], { type: 'audio/wav' });
}
async function updateStorage() {
  const el = $('#storeNote');
  if (!db) { el.textContent = 'This browser is blocking storage, so songs stay only until you close the page.'; return; }
  let used = '';
  try { const e = await navigator.storage.estimate(); used = ` · ${Math.round(e.usage / 1048576)} MB used`; } catch (e) {}
  el.textContent = `Songs are saved in this browser on this device${used}. Add them again on each phone or computer you use.`;
}

/* ---------- menus, dialogs, toast ---------- */
const menu = $('#menu'); let menuItems = [];
function openMenu(anchor, items) {
  menuItems = items;
  menu.innerHTML = items.map((it, i) => it.sep ? '<hr>' : it.lbl ? `<div class="lbl">${esc(it.lbl)}</div>` : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
  menu.hidden = false;
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(Math.max(8, r.right - mw), innerWidth - mw - 8), top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  const first = menu.querySelector('button'); if (first) first.focus({ preventScroll: true });
}
const closeMenu = () => { menu.hidden = true; };
menu.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; const it = menuItems[+b.dataset.i]; closeMenu(); it.act(); });
document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('resize', closeMenu);

function trackMenu(id, anchor) {
  const t = tracks.get(id); if (!t) return;
  const items = [{ lbl: t.title }, { label: 'Play next', act: () => playNext(id) }, { label: 'Add to queue', act: () => addToQueue(id) }, { sep: 1 },
    { label: favs.has(id) ? 'Remove from favorites' : 'Add to favorites', act: () => toggleFav(id) },
    { label: 'Add to playlist…', act: () => openMenu(anchor, [{ lbl: 'Add to playlist' }, ...lists.map(l => ({ label: l.name, act: () => addToList(l, id) })), ...(lists.length ? [{ sep: 1 }] : []), { label: 'New playlist…', act: () => newList(id) }]) }];
  const l = curList(); if (l && l.ids.includes(id)) items.push({ label: `Remove from ${l.name}`, act: () => removeFromList(l, id) });
  if (matchMedia('(min-width: 900px) and (pointer: fine)').matches) items.push({ label: 'Open in Studio', act: () => { location.href = 'studio.html?add=' + encodeURIComponent(id); } });
  items.push({ sep: 1 }, { label: 'Remove from library', danger: 1, act: () => deleteTrack(id) });
  openMenu(anchor, items);
}

const modal = $('#modal'), mInput = $('#mInput'); let modalResolve = null;
function ask({ title, text = '', input = null, placeholder = '', ok = 'OK', danger = false }) {
  return new Promise(res => {
    $('#mTitle').textContent = title; $('#mText').textContent = text; $('#mText').hidden = !text;
    mInput.hidden = input === null; mInput.value = input || ''; mInput.placeholder = placeholder;
    $('#mOk').textContent = ok; $('#mOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    modal.hidden = false; modalResolve = res;
    setTimeout(() => (input === null ? $('#mOk') : mInput).focus(), 0);
  });
}
function closeModal(v) { modal.hidden = true; const r = modalResolve; modalResolve = null; if (r) r(v); }
$('#modalForm').addEventListener('submit', e => { e.preventDefault(); if (mInput.hidden) return closeModal(true); const v = mInput.value.trim(); if (!v) return mInput.focus(); closeModal(v); });
$('#mCancel').addEventListener('click', () => closeModal(null));
modal.addEventListener('click', e => { if (e.target === modal) closeModal(null); });

const toastEl = $('#toast'); let toastT = null;
function toast(msg, ms = 2600) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastT); if (ms) toastT = setTimeout(() => { toastEl.hidden = true; }, ms); }

function openNow() { if (!curId) { if (tracks.size) togglePlay(); else return toast('Add some songs first.'); } $('#now').hidden = false; document.body.style.overflow = 'hidden'; renderPlayer(); $('#now [data-act="close"]').focus(); }
function closeNow() { $('#now').hidden = true; document.body.style.overflow = ''; }

/* ---------- wiring ---------- */
const acts = {
  toggle: togglePlay, prev, next: () => next(false), shuffle: toggleShuffle, repeat: cycleRepeat, mute: toggleMute,
  fav: () => curId && toggleFav(curId), open: openNow, close: closeNow, speed: cycleSpeed,
  sleep: b => openMenu(b, [{ lbl: 'Stop the music after' }, ...[15, 30, 45, 60].map(m => ({ label: `${m} minutes`, act: () => setSleep(m) })),
    { label: 'End of this song', act: () => setSleep('end') }, ...((sleepAt || sleepEnd) ? [{ sep: 1 }, { label: 'Turn off timer', act: () => { setSleep(0); toast('Sleep timer off'); } }] : [])]),
  add: () => $('#fileIn').click(), folder: () => $('#dirIn').click(),
  move: b => openMenu(b, [{ lbl: 'Move songs to your other device' }, { label: 'Put all my songs into one file', act: exportPack }, { label: 'Get songs from a file…', act: () => $('#packIn').click() }]),
  demo: () => importFiles([new File([makeDemoWav()], 'Example - Demo tune.wav', { type: 'audio/wav' })]),
  playall: () => playFrom(visibleIds()), shuffleall: () => { if (!S.shuffle) { S.shuffle = true; renderTransport(); } playFrom(visibleIds()); },
  newlist: () => newList(), view: b => setView(b.dataset.type === 'list' ? { type: 'list', id: b.dataset.id } : { type: b.dataset.type }),
  listmore: b => { const l = curList(); if (l) openMenu(b, [{ label: 'Rename playlist', act: () => renameList(l) }, { label: 'Delete playlist', danger: 1, act: () => deleteList(l) }]); },
  nowmore: b => curId && trackMenu(curId, b),
};
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled && acts[b.dataset.act]) acts[b.dataset.act](b, e); });

function rowActivate(e) {
  const row = e.target.closest('.row'); if (!row) return;
  const id = row.dataset.id, b = e.target.closest('[data-row]');
  if (b) { if (b.dataset.row === 'fav') toggleFav(id); else trackMenu(id, b); return; }
  if (id === curId) togglePlay(); else playFrom(visibleIds(), id);
}
$('#list').addEventListener('click', rowActivate);
$('#list').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('row')) rowActivate(e); });
$('#upList').addEventListener('click', e => {
  const row = e.target.closest('.row'); if (!row) return; const i = +row.dataset.qi;
  if (e.target.closest('[data-up="rm"]')) return removeFromQueue(i);
  S.qi = i; loadTrack(S.queue[i], true);
});
$('#upList').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('row')) { S.qi = +e.target.dataset.qi; loadTrack(S.queue[S.qi], true); } });

$$('.seek').forEach(r => {
  r.addEventListener('input', () => { seeking = true; setSeekUI(+r.value, r.value / 1000 * (audio.duration || 0)); });
  r.addEventListener('change', () => { if (isFinite(audio.duration)) audio.currentTime = r.value / 1000 * audio.duration; seeking = false; setPosState(); });
});
$$('.vol').forEach(r => r.addEventListener('input', () => setVol(+r.value)));
$('#q').addEventListener('input', e => { query = e.target.value.trim(); renderList(); });
$('#sort').addEventListener('change', e => { S.sort = e.target.value; save(); renderList(); });
$('#fileIn').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; importFiles(fs); });
$('#packIn').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPack(f); });
$('#dirIn').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; importFiles(fs); });
if (matchMedia('(pointer:coarse)').matches) $('#folderBtn').hidden = true;

let dragDepth = 0; const drop = $('#drop');
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; drop.hidden = false; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.hidden = true; });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; drop.hidden = true;
  const fs = await filesFromDrop(e.dataTransfer), packs = fs.filter(f => /\.mixtape$/i.test(f.name));
  for (const p of packs) await importPack(p);
  const rest = fs.filter(f => !packs.includes(f)); if (rest.length) importFiles(rest);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!modal.hidden) return closeModal(null); if (!menu.hidden) return closeMenu(); if (!$('#now').hidden) return closeNow(); }
  if (!modal.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key;
  if (k === ' ' || k === 'k') { if (e.target.closest('button') || e.target.classList.contains('row')) return; e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? next(false) : seekBy(5); }
  else if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? prev() : seekBy(-5); }
  else if (k === 'ArrowUp' && !e.target.closest('.menu')) { e.preventDefault(); setVol(S.vol + 5); }
  else if (k === 'ArrowDown' && !e.target.closest('.menu')) { e.preventDefault(); setVol(S.vol - 5); }
  else if (k === 'n' || k === 'N') next(false);
  else if (k === 'p' || k === 'P') prev();
  else if (k === 's' || k === 'S') toggleShuffle();
  else if (k === 'r' || k === 'R') cycleRepeat();
  else if (k === 'm' || k === 'M') toggleMute();
  else if ((k === 'l' || k === 'L') && curId) toggleFav(curId);
  else if (k === '/') { e.preventDefault(); closeNow(); $('#q').focus(); }
});

/* ---------- boot ---------- */
(async () => {
  applyVol(); renderTransport(); render();
  try { db = await idbOpen(); try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch (e) {} } catch (e) { db = null; }
  for (const t of await dbAll('tracks')) { if (!t.blob && t.buf) { t.blob = new Blob([t.buf], { type: t.type || '' }); delete t.buf; } if (t.blob) tracks.set(t.id, t); }
  for (const l of await dbAll('lists')) { if (l.id === '__fav') favs = new Set(l.ids || []); else lists.push(l); }
  lists.sort((a, b) => a.created - b.created);
  if (S.view.type === 'list' && !lists.some(l => l.id === S.view.id)) S.view = { type: 'all' };
  booted = true; bootDone();
  if (S.lastId && tracks.has(S.lastId)) {
    S.queue = S.queue.filter(id => tracks.has(id)); S.orig = S.orig.filter(id => tracks.has(id));
    let qi = S.qi >= 0 && S.queue[S.qi] === S.lastId ? S.qi : S.queue.indexOf(S.lastId);
    if (qi < 0) { S.queue = [S.lastId]; S.orig = [S.lastId]; qi = 0; }
    S.qi = qi; loadTrack(S.lastId, false, S.pos || 0);
  } else { S.queue = []; S.orig = []; S.qi = -1; S.lastId = null; render(); }
  updateStorage();
})();

/* songs saved in the Studio appear here straight away */
try {
  new BroadcastChannel('mixtape').onmessage = async e => {
    if (!e.data || e.data.type !== 'library') return;
    for (const t of await dbAll('tracks')) { if (tracks.has(t.id)) continue; if (!t.blob && t.buf) { t.blob = new Blob([t.buf], { type: t.type || '' }); delete t.buf; } if (t.blob) tracks.set(t.id, t); }
    render(); updateStorage();
  };
} catch (e) {}

/* "Open with Mixtape" from Windows: add the song(s) to the library if new, then play */
let bootDone; const bootReady = new Promise(r => { bootDone = r; });
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__player = { buildPack, importPack, get tracks() { return tracks; }, get lists() { return lists; }, get favs() { return favs; }, songIds };
async function openLaunched(files) {
  await bootReady;
  const audio = files.filter(isAudio);
  if (!audio.length) return toast('Mixtape can only open music files.', 4000);
  const ids = await importFiles(audio);
  if (!ids.length) return;
  closeNow(); query = ''; $('#q').value = '';
  if (S.view.type !== 'all') setView({ type: 'all' });
  playFrom(ids, ids[0]);
  if (ids.length === 1) toast(`Playing “${tracks.get(ids[0]).title}”`);
}
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files || !params.files.length) return;
    const files = [];
    for (const h of params.files) { try { files.push(await h.getFile()); } catch (e) {} }
    if (files.length) openLaunched(files);
  });
}

/* offline app: cache the player so it opens with no internet, and offer to install it */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
let installEvt = null; const installBtn = $('#installBtn');
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; installBtn.hidden = false; });
installBtn.addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) {} installEvt = null; installBtn.hidden = true; });
window.addEventListener('appinstalled', () => { installBtn.hidden = true; toast('Installed. Open Mixtape from your home screen or app list.', 4000); });
})();
