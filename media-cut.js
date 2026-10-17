/* Cutting a part out of any audio or video file, in the browser.
   Built on mediabunny (MPL-2.0, vendor/mediabunny/) over the browser's own WebCodecs decoders and encoders, so a
   5-hour video is read lazily from the File and nothing GPL is loaded. Three ways to cut, chosen per file:
     - 'pcm'     WAV/FLAC/AIFF and other lossless audio: decoded and written as WAV, exact to the sample, lossless.
     - 'copy'    compressed audio (AAC, Opus, Vorbis, MP3): the packets are copied, no re-encoding, cut lands on a
                 packet edge (~20 ms).
     - 'reencode' video: exact to the frame. The picture is re-encoded at very high quality, the sound at 320 kb/s
                 AAC or kept lossless. (A "smart cut" that copies the middle and re-encodes only the edges is the
                 next step; it needs the H.264 parameter sets rewritten so both halves can share one track.)
   The engine shape (probe / peaks / frame / hear / cut) matches long-mp3.js so the cutter window can use either. */
const MB_URL = './vendor/mediabunny/mediabunny.min.mjs';
let mbP = null;
const mb = () => (mbP ||= import(MB_URL));

const isVideoFile = f => /^video\//.test(f.type || '') || /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ts|3gp)$/i.test(f.name || '');
const isMediaFile = f => isVideoFile(f) || /^audio\//.test(f.type || '') || /\.(mp3|m4a|aac|wav|aif|aiff|flac|ogg|oga|opus|weba|wma)$/i.test(f.name || '');

/* Opens the file: { kind:'video'|'audio', duration, video:{w,h,fps,codec}|null, audio:{sr,ch,codec,lossless}|null, how } */
async function probe(file) {
  const M = await mb();
  const input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack(), a = await input.getPrimaryAudioTrack();
  if (!v && !a) throw new Error('No sound or picture was found in this file.');
  const dur = Math.max(v ? await v.computeDuration() : 0, a ? await a.computeDuration() : 0);
  const vi = v ? { w: v.displayWidth, h: v.displayHeight, codec: v.codec, codecString: await v.getCodecParameterString().catch(() => v.codec), canDecode: await v.canDecode(), fps: null } : null;
  if (v) { try { const fr = await v.computeFrameRateMetrics?.(); vi.fps = fr?.frameRate ?? fr?.averageFrameRate ?? null; } catch (e) {} }
  const ai = a ? { sr: a.sampleRate, ch: a.numberOfChannels, codec: a.codec, canDecode: await a.canDecode(), lossless: ['pcm-s16', 'pcm-s16be', 'pcm-s24', 'pcm-s24be', 'pcm-s32', 'pcm-s32be', 'pcm-f32', 'pcm-f32be', 'pcm-f64', 'pcm-f64be', 'pcm-u8', 'pcm-s8', 'flac', 'alac'].includes(a.codec) } : null;
  const how = v ? 'reencode' : ai.lossless ? 'pcm' : 'copy';
  return { M, input, v, a, kind: v ? 'video' : 'audio', duration: dur, video: vi, audio: ai, how };
}

/* min/max per bucket from the sound, decoded a stretch at a time; onChunk(peaks, upToSec) as it goes. */
async function peaks(p, bucketSec, onChunk, cancelled) {
  const nb = Math.ceil(p.duration / bucketSec), min = new Float32Array(nb), max = new Float32Array(nb);
  if (!p.a || !p.audio.canDecode) return { min, max, bucketSec };
  const sink = new p.M.AudioSampleSink(p.a), step = 120;
  for (let t0 = 0; t0 < p.duration; t0 += step) {
    if (cancelled && cancelled()) return null;
    const t1 = Math.min(p.duration, t0 + step);
    try {
      for await (const s of sink.samples(t0, t1)) {
        const n = s.numberOfFrames, ch = s.numberOfChannels, sr = s.sampleRate, buf = new Float32Array(n * ch);
        s.copyTo(buf, { planeIndex: 0, format: 'f32' }); // interleaved
        for (let i = 0; i < n; i++) {
          const b = Math.floor((s.timestamp + i / sr) / bucketSec); if (b < 0 || b >= nb) continue;
          for (let c = 0; c < ch; c++) { const x = buf[i * ch + c]; if (x < min[b]) min[b] = x; else if (x > max[b]) max[b] = x; }
        }
        s.close();
      }
    } catch (e) { /* a stretch that will not decode is left flat */ }
    if (onChunk) onChunk({ min, max, bucketSec }, t1);
  }
  return { min, max, bucketSec };
}

/* The picture at time t, drawn onto a canvas (null if the file has no picture or it cannot be decoded). */
async function frame(p, t, width = 480) {
  if (!p.v || !p.video.canDecode) return null;
  p._cs ||= new p.M.CanvasSink(p.v, { width, fit: 'contain', poolSize: 2 });
  const w = await p._cs.getCanvas(Math.max(0, Math.min(p.duration, t)));
  return w ? { canvas: w.canvas, at: w.timestamp } : null;
}

/* The sound from t0 to t1 as an AudioBuffer, for listening around a cut point. */
async function hear(p, ctx, t0, t1) {
  if (!p.a || !p.audio.canDecode) return null;
  const sink = new p.M.AudioSampleSink(p.a), chunks = []; let frames = 0, sr = p.audio.sr, ch = p.audio.ch;
  for await (const s of sink.samples(t0, t1)) { const buf = new Float32Array(s.numberOfFrames * s.numberOfChannels); s.copyTo(buf, { planeIndex: 0, format: 'f32' }); chunks.push({ buf, n: s.numberOfFrames, ts: s.timestamp }); frames += s.numberOfFrames; sr = s.sampleRate; ch = s.numberOfChannels; s.close(); }
  if (!frames) return null;
  const out = ctx.createBuffer(ch, frames, sr); let o = 0;
  for (const c of chunks) { for (let k = 0; k < ch; k++) { const d = out.getChannelData(k); for (let i = 0; i < c.n; i++) d[o + i] = c.buf[i * ch + k]; } o += c.n; }
  return { buffer: out, at: chunks[0].ts };
}

/* Where the output goes: a file in the browser's private storage (OPFS), so a 2 GB cut never has to sit in memory. */
async function opfsTarget(M, name) {
  const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('cuts', { create: true });
  // each cut gets its own file (a reused name once handed back the previous cut), and cuts older than an hour are swept
  const stamp = Date.now(), fname = `${stamp.toString(36)}-${name}`;
  try { for await (const [k] of dir.entries()) { const s = parseInt(k.split('-')[0], 36); if (s && stamp - s > 3600e3) await dir.removeEntry(k).catch(() => {}); } } catch (e) {}
  const fh = await dir.getFileHandle(fname, { create: true }), ws = await fh.createWritable({ keepExistingData: false });
  let closeDone; const closed = new Promise(r => { closeDone = r; });
  const target = new M.StreamTarget(new WritableStream({
    write: async chunk => { await ws.write({ type: 'write', position: chunk.position, data: chunk.data }); },
    close: async () => { await ws.close(); closeDone(); },
    abort: async () => { try { await ws.abort(); } catch (e) {} closeDone(); },
  }), { chunked: true });
  return { target, file: async () => { await closed; return fh.getFile(); }, remove: async () => { try { await dir.removeEntry(fname); } catch (e) {} } };
}
/* The finished file must hold every track that went in; an encoder that fails quietly leaves a track out. */
async function checkTracks(M, blob, want) {
  const inp = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS }), got = (await inp.getTracks()).map(t => t.type);
  for (const w of want) if (!got.includes(w)) throw new Error(`The ${w === 'video' ? 'picture' : 'sound'} did not make it into the cut file (the encoder refused it). Nothing was saved.`);
}

const extOf = how => how.container === 'webm' ? 'webm' : how.container === 'wav' ? 'wav' : 'mp4';

/* Cuts t0..t1 out. onProgress(0..1). Returns { blob, name, how, exact, note }. */
async function cut(p, t0, t1, opts = {}) {
  const M = p.M, onProgress = opts.onProgress || (() => {}), base = (opts.name || 'part').replace(/\.[^.]+$/, '');
  if (p.how === 'pcm') return cutPcm(p, t0, t1, base, onProgress);
  if (p.how === 'copy') return cutCopy(p, t0, t1, base, onProgress);
  // video: exact to the frame, re-encoded at very high quality; the container follows the source's family
  const webm = ['vp8', 'vp9', 'av1'].includes(p.video.codec) || (p.a && ['opus', 'vorbis'].includes(p.audio.codec) && p.video.codec !== 'avc');
  const format = webm ? new M.WebMOutputFormat() : new M.Mp4OutputFormat({ fastStart: 'in-memory' });
  const name = `${base} (${fmtName(t0)}-${fmtName(t1)}).${webm ? 'webm' : 'mp4'}`;
  const tgt = await opfsTarget(M, name);
  const output = new M.Output({ format, target: tgt.target });
  // bitrate: generous (3× the source's, at least 12 Mb/s for 1080p) so the re-encode is visually lossless
  const stats = await p.v.computePacketStats(600).catch(() => null);
  const srcBr = stats?.averageBitrate || 8e6, px = p.video.w * p.video.h, floor = px >= 3840 * 2160 ? 45e6 : px >= 1920 * 1080 ? 12e6 : 6e6;
  const vcodec = p.video.codec === 'avc' || p.video.codec === 'hevc' ? (webm ? 'vp9' : p.video.codec) : (p.video.codec || (webm ? 'vp9' : 'avc'));
  const conv = await M.Conversion.init({
    input: p.input, output,
    trim: { start: t0, end: t1 },
    video: { codec: vcodec, quality: new M.Quality({ bitrate: Math.min(100e6, Math.max(floor, srcBr * 3)) }), keyFrameInterval: 2, hardwareAcceleration: 'no-preference' },
    // the sound: lossless stays lossless; compressed sound is re-encoded at the top rate the encoder allows per channel
    audio: p.a ? (p.audio.lossless ? { codec: webm ? 'opus' : 'pcm-s16' } : { codec: webm ? 'opus' : 'aac', quality: new M.Quality({ bitrate: Math.min(webm ? 256e3 : 320e3, (webm ? 128e3 : 160e3) * p.audio.ch) }) }) : undefined,
  });
  const dropped = conv.discardedTracks.map(d => `${d.track.type}: ${d.reason}`);
  if (!conv.isValid || dropped.length) { await tgt.remove(); throw new Error(`This file cannot be cut here (${dropped.join('; ') || 'the browser cannot decode it'}).`); }
  conv.onProgress = onProgress;
  try { await conv.execute(); } catch (e) { await tgt.remove(); throw e; }
  const blob = await tgt.file();
  try { await checkTracks(M, blob, ['video', ...(p.a ? ['audio'] : [])]); } catch (e) { await tgt.remove(); throw e; }
  const abr = p.a && !p.audio.lossless ? Math.min(webm ? 256e3 : 320e3, (webm ? 128e3 : 160e3) * p.audio.ch) : 0;
  return { blob, name, how: 'reencode', exact: true, note: `Exact to the frame. The picture was re-encoded at ${Math.round(Math.min(100e6, Math.max(floor, srcBr * 3)) / 1e6)} Mb/s (the original was ${Math.round(srcBr / 1e6)} Mb/s), so it looks the same; ${p.a ? (p.audio.lossless ? 'the sound is lossless' : `the sound is ${Math.round(abr / 1000)} kb/s ${webm ? 'Opus' : 'AAC'}`) : 'there is no sound track'}.`, cleanup: tgt.remove };
}

/* Lossless audio → WAV, exact to the sample. */
async function cutPcm(p, t0, t1, base, onProgress) {
  const M = p.M, name = `${base} (${fmtName(t0)}-${fmtName(t1)}).wav`, tgt = await opfsTarget(M, name);
  const output = new M.Output({ format: new M.WavOutputFormat(), target: tgt.target });
  const src = new M.AudioSampleSource({ codec: 'pcm-s24' }); // 24-bit covers 16-bit sources exactly and float/24-bit sources almost exactly
  output.addAudioTrack(src); await output.start();
  const sink = new M.AudioSampleSink(p.a); let done = 0;
  try {
    for await (const s of sink.samples(t0, t1)) {
      // trim the first and last samples to the exact times
      const sr = s.sampleRate, from = Math.max(0, Math.round((t0 - s.timestamp) * sr)), to = Math.min(s.numberOfFrames, Math.round((t1 - s.timestamp) * sr));
      if (to <= from) { s.close(); continue; }
      let piece = s;
      if (from > 0 || to < s.numberOfFrames) {
        const ch = s.numberOfChannels, n = to - from, buf = new Float32Array(s.numberOfFrames * ch); s.copyTo(buf, { planeIndex: 0, format: 'f32' });
        piece = new M.AudioSample({ data: buf.subarray(from * ch, to * ch), format: 'f32', sampleRate: sr, numberOfChannels: ch, timestamp: Math.max(t0, s.timestamp) + 0 });
        s.close();
      }
      // timestamps restart at 0 in the new file
      const shifted = new M.AudioSample({ data: (() => { const b = new Float32Array(piece.numberOfFrames * piece.numberOfChannels); piece.copyTo(b, { planeIndex: 0, format: 'f32' }); return b; })(), format: 'f32', sampleRate: piece.sampleRate, numberOfChannels: piece.numberOfChannels, timestamp: Math.max(0, piece.timestamp - t0) });
      piece.close(); await src.add(shifted); shifted.close();
      done = Math.max(done, piece.timestamp + 0); onProgress(Math.min(1, (shifted.timestamp) / Math.max(0.001, t1 - t0)));
    }
    await output.finalize();
  } catch (e) { try { await output.cancel(); } catch (_) {} await tgt.remove(); throw e; }
  return { blob: await tgt.file(), name, how: 'pcm', exact: true, note: 'Exact to the sample and lossless (saved as a 24-bit WAV).', cleanup: tgt.remove };
}

/* Compressed audio: the packets are copied as they are. */
async function cutCopy(p, t0, t1, base, onProgress) {
  const M = p.M, codec = p.audio.codec, webm = ['opus', 'vorbis'].includes(codec), mp3 = codec === 'mp3';
  const format = mp3 ? new M.Mp3OutputFormat() : webm ? new M.WebMOutputFormat() : new M.Mp4OutputFormat({ fastStart: 'in-memory' });
  const name = `${base} (${fmtName(t0)}-${fmtName(t1)}).${mp3 ? 'mp3' : webm ? 'webm' : 'm4a'}`, tgt = await opfsTarget(M, name);
  const output = new M.Output({ format, target: tgt.target });
  const src = new M.EncodedAudioPacketSource(codec); output.addAudioTrack(src); await output.start();
  const sink = new M.EncodedPacketSink(p.a), cfg = await p.a.getDecoderConfig();
  const first = await sink.getPacket(t0) || await sink.getFirstPacket(); let n = 0, startTs = null, meta = { decoderConfig: cfg };
  try {
    for await (const pk of sink.packets(first)) {
      if (pk.timestamp >= t1) break;
      if (startTs === null) startTs = pk.timestamp;
      await src.add(pk.clone({ timestamp: pk.timestamp - startTs }), n++ === 0 ? meta : undefined);
      if (n % 50 === 0) onProgress(Math.min(1, (pk.timestamp - t0) / Math.max(0.001, t1 - t0)));
    }
    await output.finalize();
  } catch (e) { try { await output.cancel(); } catch (_) {} await tgt.remove(); throw e; }
  return { blob: await tgt.file(), name, how: 'copy', exact: false, at: startTs, note: `No re-encoding: the sound is copied as it is. The cut starts at ${fmtName(startTs ?? t0)} (the nearest packet edge, within about 20 ms).`, cleanup: tgt.remove };
}

// a time for a file name (no colons allowed): h.mm.ss, with hundredths when the cut is not on a whole second
const fmtName = s => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = Math.floor(s % 60), cs = Math.round((s % 1) * 100) % 100; return (h ? `${h}.` : '') + `${String(m).padStart(2, '0')}.${String(x).padStart(2, '0')}` + (cs ? `.${String(cs).padStart(2, '0')}` : ''); };

window.MixtapeMediaCut = { probe, peaks, frame, hear, cut, isVideoFile, isMediaFile, ready: () => mb().then(() => true) };
