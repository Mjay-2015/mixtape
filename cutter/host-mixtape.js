/* Cutter inside Mixtape: reads songs from Mixtape's library and adds finished cuts to it.
   Mixtape keeps its library in this site's IndexedDB ('mixtape-player', store 'tracks'), so the Cutter, served from the
   same site, reads and writes it directly. Loaded only in Mixtape's copy of the Cutter (a classic script, before app.js). */
(function () {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('mixtape-player', 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' }); if (!d.objectStoreNames.contains('lists')) d.createObjectStore('lists', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('Mixtape is busy upgrading its library; close other Mixtape tabs and try again.'));
  });
  const tx = async (mode, fn) => { const d = await open(); return new Promise((res, rej) => { let out; const t = d.transaction('tracks', mode), r = fn(t.objectStore('tracks')); r.onsuccess = () => { out = r.result; }; t.oncomplete = () => { d.close(); res(out); }; t.onerror = () => { d.close(); rej(t.error); }; t.onabort = () => { d.close(); rej(t.error); }; }); };
  const blobOf = t => t.blob || (t.buf ? new Blob([t.buf], { type: t.type || '' }) : null);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  window.CUTTER_HOST = {
    name: 'Mixtape', backHref: '../',
    async listSongs() {
      const all = await tx('readonly', o => o.getAll());
      return all.filter(t => t.blob || t.buf).map(t => ({ id: t.id, title: t.title || t.name || 'Untitled', artist: t.artist || '', album: t.album || '', duration: t.duration || 0, video: t.kind === 'video', size: t.size || 0, added: t.added || 0 })).sort((a, b) => b.added - a.added);
    },
    async getSong(id) {
      const t = await tx('readonly', o => o.get(id)); if (!t) return null; const b = blobOf(t); if (!b) return null;
      const name = t.name || `${t.title || 'song'}${/video/.test(t.type) ? '.mp4' : '.mp3'}`;
      return new File([b], name, { type: t.type || b.type || '', lastModified: t.added || 0 });
    },
    /* a finished cut joins the library (album "Cuts"); an open Mixtape player shows it at once */
    async addToLibrary(file, name, { duration = 0, video = false } = {}) {
      const data = file.size < 600e6 ? new Blob([await file.arrayBuffer()], { type: file.type }) : file; // a copy of its own: the cut's working file is swept after an hour
      const t = { id: uid(), name, size: file.size, type: file.type || '', title: name.replace(/\.[^.]+$/, ''), artist: '', album: 'Cuts', track: 0, duration, added: Date.now(), blob: data, art: null, ...(video ? { kind: 'video' } : {}) };
      await tx('readwrite', o => o.put(t));
      try { new BroadcastChannel('mixtape').postMessage({ type: 'library' }); } catch (e) {}
      return t.id;
    },
  };
})();
