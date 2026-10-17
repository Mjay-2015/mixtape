/* Long MP3s, without unpacking them whole.
   A 5-hour MP3 unpacks to ~6.6 GB of raw audio, more than a browser tab may use, so the Studio never decodes it in one go.
   Instead this maps every MP3 frame (a frame is ~26 ms of sound with its own header), decodes only the stretch it is asked
   for, and cuts a part out by copying whole frames: no re-encoding, so the part sounds exactly like the original.
   Layer III only (what "MP3" means in practice), MPEG-1/2/2.5, constant or variable bit rate. */
(function () {
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const SR1 = [44100, 48000, 32000];

  // the frame header at b[i], or null if there is none
  function header(b, i) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
    const v1 = ver === 3, sr = SR1[sri] / (v1 ? 1 : ver === 2 ? 2 : 4), br = (v1 ? BR1 : BR2)[bri], pad = (b[i + 2] >> 1) & 1;
    return { v1, sr, len: Math.floor((v1 ? 144000 : 72000) * br / sr) + pad, spf: v1 ? 1152 : 576, mono: (b[i + 3] >> 6) === 3 };
  }
  const sideInfo = h => h.v1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);

  /* Every frame's byte offset. onProgress(0..1). Returns { off (Float64Array, frames + 1 entries: the last is the end),
     frames, sr, spf, duration, first (byte where audio starts), xing (bytes of the original Xing/Info frame, if any) }. */
  async function index(blob, onProgress) {
    const CH = 8 << 20; let pos = 0;
    let head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) // an ID3v2 tag: skip it
      pos = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f)) + (head[5] & 0x10 ? 10 : 0);
    let end = blob.size;
    const tail = new Uint8Array(await blob.slice(Math.max(0, end - 128), end).arrayBuffer());
    if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) end -= 128; // ID3v1 "TAG"
    let off = new Float64Array(1 << 16), n = 0, fmt = null, xing = null, buf = null, bufAt = 0;
    const need = async (p, k) => { if (!buf || p < bufAt || p + k > bufAt + buf.length) { bufAt = p; buf = new Uint8Array(await blob.slice(p, Math.min(end, p + CH)).arrayBuffer()); } return p + k <= bufAt + buf.length; };
    let lastReport = 0;
    while (pos + 4 <= end) {
      if (!(await need(pos, 4))) break;
      let h = header(buf, pos - bufAt);
      if (h && fmt && (h.sr !== fmt.sr || h.spf !== fmt.spf)) h = null; // a false sync inside audio data
      if (!h) { // lost sync: step forward to the next header that is followed by another header
        let found = false;
        for (let p = pos + 1; p + 4 <= end; p++) {
          if (!(await need(p, 4))) break;
          const g = header(buf, p - bufAt); if (!g || (fmt && (g.sr !== fmt.sr || g.spf !== fmt.spf))) continue;
          if (p + g.len + 4 > end) { pos = end; break; }
          if (!(await need(p, g.len + 4))) break;
          if (header(buf, p + g.len - bufAt)) { pos = p; h = g; found = true; break; }
        }
        if (!found) break;
      }
      if (!fmt) {
        fmt = { sr: h.sr, spf: h.spf };
        await need(pos, h.len);
        const s = pos - bufAt + 4 + sideInfo(h), tag = String.fromCharCode(...buf.subarray(s, s + 4));
        if (tag === 'Xing' || tag === 'Info') { xing = { at: pos, bytes: buf.slice(pos - bufAt, pos - bufAt + h.len), side: sideInfo(h) }; pos += h.len; continue; } // a header, not sound
      }
      if (n + 2 > off.length) { const o = new Float64Array(off.length * 2); o.set(off); off = o; }
      off[n++] = pos; pos += h.len;
      if (onProgress && pos - lastReport > 16 << 20) { lastReport = pos; onProgress(pos / end); await new Promise(r => setTimeout(r, 0)); }
    }
    if (!fmt) throw new Error('This file has no MP3 sound in it.');
    off[n] = Math.min(pos, end);
    // sound comes out of an MP3 decoder late: the encoder's own delay (the LAME tag says how much; 576 samples is LAME's
    // usual) plus the decoder's 529. Times here are the original recording's, so that delay is taken off.
    let enc = 576;
    if (xing) {
      const x = xing.bytes, s = 4 + xing.side, fl = x[s + 7]; let p = s + 8 + (fl & 1 ? 4 : 0) + (fl & 2 ? 4 : 0) + (fl & 4 ? 100 : 0) + (fl & 8 ? 4 : 0);
      if (String.fromCharCode(...x.subarray(p, p + 4)) === 'LAME' && p + 24 <= x.length) enc = (x[p + 21] << 4) | (x[p + 22] >> 4);
    }
    return { off: off.subarray(0, n + 1), frames: n, sr: fmt.sr, spf: fmt.spf, duration: Math.max(0, n * fmt.spf - enc - 529) / fmt.sr, delay: (enc + 529) / fmt.sr, xing, size: blob.size };
  }

  /* The sound from t0 to t1 seconds, decoded. A few frames before t0 are decoded too and dropped: an MP3 frame may borrow
     bits from the frames before it, and the decoder needs a moment to settle. Returns { buffer, at } (at = the time of
     buffer's first sample; it is t0 to within a frame). */
  const PRE = 10;
  async function decode(ctx, blob, ix, t0, t1) {
    const fps = ix.sr / ix.spf, k0 = Math.max(0, Math.floor((t0 + ix.delay) * fps)), k1 = Math.min(ix.frames, Math.ceil((t1 + ix.delay) * fps) + 1), a = Math.max(0, k0 - PRE);
    const bytes = await blob.slice(ix.off[a], ix.off[k1]).arrayBuffer();
    const raw = await ctx.decodeAudioData(bytes);
    // the decoder hands back the sound from frame a; drop the settling frames so the buffer starts at frame k0
    const skip = Math.min(raw.length - 1, Math.round((k0 - a) * ix.spf / ix.sr * raw.sampleRate)), len = raw.length - skip;
    const at = k0 / fps - ix.delay;
    if (skip <= 0) return { buffer: raw, at };
    const out = ctx.createBuffer(raw.numberOfChannels, Math.max(1, len), raw.sampleRate);
    for (let c = 0; c < raw.numberOfChannels; c++) out.copyToChannel(raw.getChannelData(c).subarray(skip), c);
    return { buffer: out, at };
  }

  /* min/max per bucket over the whole file, decoded a minute at a time. onChunk(peaks, upToSec) lets the caller draw as it goes.
     cancelled() stops early. */
  async function peaks(_ctx, blob, ix, bucketSec, onChunk, cancelled) {
    // a picture needs no fine detail: unpacking at 8 kHz takes about half as long (measured)
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const nb = Math.ceil(ix.duration / bucketSec), min = new Float32Array(nb), max = new Float32Array(nb), step = 300;
    for (let t = 0; t < ix.duration; t += step) {
      if (cancelled && cancelled()) return null;
      let d; try { d = await decode(ctx, blob, ix, t, Math.min(ix.duration, t + step)); } catch (e) { continue; }
      const sr = d.buffer.sampleRate, chs = [...Array(d.buffer.numberOfChannels)].map((_, c) => d.buffer.getChannelData(c));
      const b0 = Math.floor(t / bucketSec), b1 = Math.min(nb, Math.ceil(Math.min(ix.duration, t + step) / bucketSec));
      for (let b = b0; b < b1; b++) {
        const i0 = Math.max(0, Math.round((b * bucketSec - d.at) * sr)), i1 = Math.min(d.buffer.length, Math.round(((b + 1) * bucketSec - d.at) * sr));
        let lo = 0, hi = 0;
        for (const ch of chs) for (let i = i0; i < i1; i++) { const v = ch[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
        min[b] = lo; max[b] = hi;
      }
      if (onChunk) onChunk({ min, max, bucketSec }, Math.min(ix.duration, t + step));
    }
    return { min, max, bucketSec };
  }

  /* The part from t0 to t1 as its own MP3, by copying whole frames (cuts land within ~26 ms of the times asked for).
     A variable-bit-rate file gets a fresh Xing header, so players show the right length and seek correctly. */
  function cut(blob, ix, t0, t1) {
    // Cuts land within ~1/20 s of t0: a frame may lean on bits stored in the frames before it (the "bit reservoir"), so the
    // first frame or two of a cut can decode as silence (measured 25-63 ms on a file without a Xing header, 1 ms with one).
    const sh = ix.delay, fps = ix.sr / ix.spf, k0 = Math.max(0, Math.round((t0 + sh) * fps)), k1 = Math.min(ix.frames, Math.round((t1 + sh) * fps));
    if (k1 <= k0) throw new Error('The part is empty.');
    const parts = [], frames = k1 - k0, bytes = ix.off[k1] - ix.off[k0];
    if (ix.xing) {
      const x = ix.xing.bytes.slice(), s = 4 + ix.xing.side, dv = new DataView(x.buffer);
      x.fill(0, s); x.set([0x58, 0x69, 0x6e, 0x67], s); // "Xing", and nothing after the table: the old LAME tag described the whole file
      dv.setUint32(s + 4, 7); dv.setUint32(s + 8, frames); dv.setUint32(s + 12, bytes + x.length);
      for (let i = 0; i < 100; i++) { // the seek table: where each 1% of the time starts, as a share of the bytes
        const k = k0 + Math.min(frames - 1, Math.floor(frames * i / 100));
        x[s + 16 + i] = Math.min(255, Math.floor(256 * (ix.off[k] - ix.off[k0] + x.length) / (bytes + x.length)));
      }
      parts.push(x);
    }
    parts.push(blob.slice(ix.off[k0], ix.off[k1]));
    return { blob: new Blob(parts, { type: 'audio/mpeg' }), at: k0 / fps - sh, duration: frames / fps };
  }

  const isMp3 = t => /mpeg|mp3/i.test(t.type || '') || /\.mp3$/i.test(t.name || '');
  window.MixtapeLongMP3 = { index, decode, peaks, cut, isMp3 };
})();
