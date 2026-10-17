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
(function () {
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

/* ---------------------------------------------------------------------------------------------------------------------
   The smart cut (H.264 in MP4). Frames between keyframes are copied as they are; only the stretch from the start to the
   next keyframe, and from the last keyframe to the end, is decoded and re-encoded. The two halves must share one video
   track, and H.264 slices name their parameter sets by number, so the re-encoded slices and their SPS/PPS are renumbered
   (bit-exact rewriting of the Exp-Golomb fields) and both sets go into one avcC. Anything unexpected throws, and the
   caller falls back to re-encoding the whole part.
   --------------------------------------------------------------------------------------------------------------------- */
// Exp-Golomb and bit helpers over an RBSP (emulation-prevention bytes already removed)
const bitAt = (b, i) => (b[i >> 3] >> (7 - (i & 7))) & 1;
function readUe(b, pos) { let z = 0; while (pos + z < b.length * 8 && bitAt(b, pos + z) === 0) z++; if (z > 31) throw new Error('bad Exp-Golomb'); let v = 0; for (let i = 0; i <= z; i++) v = (v << 1) | bitAt(b, pos + z + i); return { value: v - 1, len: 2 * z + 1 }; }
function ueBits(v) { const x = v + 1, len = 31 - Math.clz32(x); const out = []; for (let i = 0; i < len; i++) out.push(0); for (let i = len; i >= 0; i--) out.push((x >> i) & 1); return out; }
/* Replaces the ue(v) field at bit `pos` with `value`, shifting everything after it. Returns the new RBSP. */
function rewriteUe(b, pos, value) {
  const old = readUe(b, pos), nb = ueBits(value), totalBits = b.length * 8, tail = totalBits - (pos + old.len);
  const outBits = pos + nb.length + tail, out = new Uint8Array(Math.ceil(outBits / 8));
  const set = (i, v) => { if (v) out[i >> 3] |= 0x80 >> (i & 7); };
  for (let i = 0; i < pos; i++) set(i, bitAt(b, i));
  for (let i = 0; i < nb.length; i++) set(pos + i, nb[i]);
  // the rest is shifted by d bits; copied bit by bit (slices are a few hundred KB at most, this stays well under a frame's time)
  const d = nb.length - old.len, from = pos + old.len;
  if (d === 0) { for (let i = from; i < totalBits; i++) set(i, bitAt(b, i)); }
  else for (let i = from; i < totalBits; i++) set(i + d, bitAt(b, i));
  return out;
}
const rbspOf = ebsp => { const out = []; for (let i = 0; i < ebsp.length; i++) { if (i >= 2 && ebsp[i] === 3 && ebsp[i - 1] === 0 && ebsp[i - 2] === 0 && (i + 1 >= ebsp.length || ebsp[i + 1] <= 3)) continue; out.push(ebsp[i]); } return Uint8Array.from(out); };
const ebspOf = rbsp => { const out = []; let z = 0; for (const x of rbsp) { if (z >= 2 && x <= 3) { out.push(3); z = 0; } out.push(x); z = x === 0 ? z + 1 : 0; } return Uint8Array.from(out); };
/* The NAL units of a length-prefixed sample (avcC form). */
function nalus(data, lenSize) { const out = []; let i = 0; while (i + lenSize <= data.length) { let n = 0; for (let k = 0; k < lenSize; k++) n = (n << 8) | data[i + k]; i += lenSize; out.push(data.subarray(i, i + n)); i += n; } return out; }
function joinNalus(list, lenSize) { const total = list.reduce((s, n) => s + lenSize + n.length, 0), out = new Uint8Array(total); let o = 0; for (const n of list) { for (let k = lenSize - 1; k >= 0; k--) out[o++] = (n.length >>> (8 * k)) & 255; out.set(n, o); o += n.length; } return out; }
function parseAvcC(d) {
  if (d[0] !== 1) throw new Error('not an avcC');
  const lenSize = (d[4] & 3) + 1, sps = [], pps = []; let i = 6; const nS = d[5] & 31;
  for (let k = 0; k < nS; k++) { const n = (d[i] << 8) | d[i + 1]; sps.push(d.slice(i + 2, i + 2 + n)); i += 2 + n; }
  const nP = d[i++]; for (let k = 0; k < nP; k++) { const n = (d[i] << 8) | d[i + 1]; pps.push(d.slice(i + 2, i + 2 + n)); i += 2 + n; }
  return { profile: d[1], compat: d[2], level: d[3], lenSize, sps, pps, ext: d.slice(i) };
}
function buildAvcC(a) {
  const parts = [1, a.profile, a.compat, a.level, 0xFC | (a.lenSize - 1), 0xE0 | a.sps.length];
  for (const s of a.sps) parts.push(s.length >> 8, s.length & 255, ...s);
  parts.push(a.pps.length); for (const p of a.pps) parts.push(p.length >> 8, p.length & 255, ...p);
  return Uint8Array.from([...parts, ...a.ext]);
}
const spsId = sps => readUe(rbspOf(sps.subarray(1)), 24).value; // after profile_idc, constraint flags, level_idc
const ppsIds = pps => { const r = rbspOf(pps.subarray(1)), a = readUe(r, 0); return { pps: a.value, sps: readUe(r, a.len).value, len0: a.len }; };
/* Renumbers an encoder's SPS/PPS to ids unused by the source and merges them into the source's avcC.
   Returns { description, renumber(nalu) → nalu } where renumber rewrites a slice's pps id. */
function mergeParameterSets(srcDesc, encDesc) {
  const S = parseAvcC(srcDesc), E = parseAvcC(encDesc);
  if (E.sps.length !== 1 || E.pps.length !== 1) throw new Error('the encoder gave more than one parameter set');
  const usedS = new Set(S.sps.map(spsId)), usedP = new Set(S.pps.map(p => ppsIds(p).pps));
  let newS = 0; while (usedS.has(newS)) newS++;
  // CABAC slice data must start on a byte boundary, so the new pps id's code must be longer than the old one's by whole
  // bytes (an id of 0 is 1 bit; ids 15-30 are 9 bits): the header grows by 8 bits and the alignment holds
  const oldLen = ueBits(ppsIds(E.pps[0]).pps).length; let newP = -1;
  for (let v = 0; v <= 255; v++) if (!usedP.has(v) && (ueBits(v).length - oldLen) % 8 === 0 && ueBits(v).length >= oldLen) { newP = v; break; }
  if (newS > 31 || newP < 0) throw new Error('no free parameter set id');
  // SPS: id is the first ue after 24 fixed bits
  const sr = rbspOf(E.sps[0].subarray(1)), newSps = Uint8Array.from([E.sps[0][0], ...ebspOf(rewriteUe(sr, 24, newS))]);
  // PPS: pps id then sps id; the second is rewritten first so the first's offset still holds
  const pr = rbspOf(E.pps[0].subarray(1)), ids = ppsIds(E.pps[0]);
  const pr2 = rewriteUe(rewriteUe(pr, ids.len0, newS), 0, newP), newPps = Uint8Array.from([E.pps[0][0], ...ebspOf(pr2)]);
  const oldP = ids.pps;
  const merged = buildAvcC({ profile: S.profile, compat: S.compat & E.compat, level: Math.max(S.level, E.level), lenSize: S.lenSize, sps: [...S.sps, newSps], pps: [...S.pps, newPps], ext: S.ext });
  const renumber = nalu => { // slice header: first_mb_in_slice, slice_type, pic_parameter_set_id
    const type = nalu[0] & 31; if (type !== 1 && type !== 5) return nalu;
    const r = rbspOf(nalu.subarray(1)), a = readUe(r, 0), b = readUe(r, a.len), c = readUe(r, a.len + b.len);
    if (c.value !== oldP) throw new Error('a slice names an unexpected PPS');
    return Uint8Array.from([nalu[0], ...ebspOf(rewriteUe(r, a.len + b.len, newP))]);
  };
  return { description: merged, lenSize: S.lenSize, level: Math.max(S.level, E.level), profile: S.profile, compat: S.compat & E.compat, renumber };
}
/* Decodes [t0, t1) and re-encodes it as H.264 (first frame a keyframe). Returns { packets: [{data,type,ts,dur}], description }. */
async function encodeStretch(p, t0, t1, codecString, bitrate, onFrame) {
  const M = p.M, chunks = []; let desc = null, err = null;
  const enc = new VideoEncoder({ output: (c, meta) => { if (meta && meta.decoderConfig && meta.decoderConfig.description && !desc) desc = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description); const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ data: d, type: c.type, ts: c.timestamp / 1e6, dur: (c.duration || 0) / 1e6 }); }, error: e => { err = e; } });
  const cfg = { codec: codecString, width: p.v.displayWidth, height: p.v.displayHeight, bitrate, framerate: p.video.fps || 30, latencyMode: 'quality', avc: { format: 'avc' }, hardwareAcceleration: 'no-preference' };
  const sup = await VideoEncoder.isConfigSupported(cfg); if (!sup.supported) throw new Error(`the encoder does not support ${codecString}`);
  enc.configure(cfg);
  const sink = new M.VideoSampleSink(p.v); let n = 0;
  for await (const s of sink.samples(t0, t1)) {
    if (s.timestamp < t0 - 1e-6 || s.timestamp >= t1 - 1e-6) { s.close(); continue; }
    // timestamps restart at 0; never negative (a start a millionth of a second after the first frame must not lose that frame)
    const frame = s.toVideoFrame(); const f2 = new VideoFrame(frame, { timestamp: Math.max(0, Math.round((s.timestamp - t0) * 1e6)), duration: Math.round((s.duration || 1 / (p.video.fps || 30)) * 1e6) }); frame.close();
    enc.encode(f2, { keyFrame: n === 0 }); f2.close(); s.close(); n++; if (onFrame) onFrame(n);
    if (err) throw err;
  }
  await enc.flush(); enc.close(); if (err) throw err;
  if (!desc) throw new Error('the encoder gave no parameter sets');
  chunks.sort((a, b) => a.ts - b.ts); // Chrome's H.264 encoders emit no B-frames, so presentation order is decode order
  return { packets: chunks, description: desc, frames: n };
}
/* The sound of [t0, t1), decoded and written exactly, timestamps starting at 0. */
async function addExactAudio(M, p, output, t0, t1, webm, onProgress) {
  if (!p.a || !p.audio.canDecode) return null;
  const lossless = p.audio.lossless, codec = webm ? 'opus' : lossless ? 'pcm-s16' : 'aac';
  const src = new M.AudioSampleSource(lossless && !webm ? { codec } : { codec, quality: new M.Quality({ bitrate: Math.min(webm ? 256e3 : 320e3, (webm ? 128e3 : 160e3) * p.audio.ch) }) });
  output.addAudioTrack(src);
  return async () => {
    const sink = new M.AudioSampleSink(p.a);
    for await (const s of sink.samples(t0, t1)) {
      const sr = s.sampleRate, from = Math.max(0, Math.round((t0 - s.timestamp) * sr)), to = Math.min(s.numberOfFrames, Math.round((t1 - s.timestamp) * sr));
      if (to <= from) { s.close(); continue; }
      const ch = s.numberOfChannels, buf = new Float32Array(s.numberOfFrames * ch); s.copyTo(buf, { planeIndex: 0, format: 'f32' });
      const piece = new M.AudioSample({ data: buf.subarray(from * ch, to * ch), format: 'f32', sampleRate: sr, numberOfChannels: ch, timestamp: Math.max(0, s.timestamp - t0 + from / sr) });
      s.close(); await src.add(piece); piece.close(); if (onProgress) onProgress((piece.timestamp) / Math.max(0.001, t1 - t0));
    }
    src.close();
  };
}
async function cutSmart(p, t0, t1, base, onProgress) {
  const M = p.M; if (p.video.codec !== 'avc') throw new Error('not H.264');
  const srcCfg = await p.v.getDecoderConfig(); if (!srcCfg || !srcCfg.description) throw new Error('no avcC');
  const sink = new M.EncodedPacketSink(p.v);
  // the keyframes that bound the copied middle: K1 = first key at/after the start, Kz = last key at/before the end
  let k = await sink.getKeyPacket(t0); if (!k) throw new Error('no keyframe');
  while (k && k.timestamp < t0 - 1e-6) k = await sink.getNextKeyPacket(k);
  const K1 = k, Kz = await sink.getKeyPacket(t1 + 1e-6); // a keyframe exactly at the end counts: then nothing needs re-encoding there
  if (!K1 || !Kz || Kz.timestamp <= K1.timestamp) throw new Error('no whole group of frames to copy');
  // closed groups only: every packet between K1 and Kz must show between them
  const middle = []; for await (const pk of sink.packets(K1)) { if (pk.timestamp >= Kz.timestamp - 1e-9 && pk.type === 'key') break; if (pk.timestamp < K1.timestamp - 1e-6 || pk.timestamp >= Kz.timestamp - 1e-9) throw new Error('open groups of frames'); middle.push(pk); }
  const stats = await p.v.computePacketStats(600).catch(() => null), srcBr = stats?.averageBitrate || 8e6, px = p.video.w * p.video.h, floor = px >= 3840 * 2160 ? 45e6 : px >= 1920 * 1080 ? 12e6 : 6e6, bitrate = Math.min(100e6, Math.max(floor, srcBr * 3));
  const codecString = p.video.codecString && /^avc1\./.test(p.video.codecString) ? p.video.codecString : 'avc1.640033';
  const headN = Math.max(0, Math.round((K1.timestamp - t0) * (p.video.fps || 30))), tailN = Math.max(0, Math.round((t1 - Kz.timestamp) * (p.video.fps || 30))), total = headN + tailN + middle.length;
  onProgress(0.02);
  const head = K1.timestamp > t0 + 1e-6 ? await encodeStretch(p, t0, K1.timestamp, codecString, bitrate, n => onProgress(0.02 + 0.3 * n / Math.max(1, headN))) : null;
  const tail = t1 > Kz.timestamp + 1e-6 ? await encodeStretch(p, Kz.timestamp, t1, codecString, bitrate, n => onProgress(0.32 + 0.3 * n / Math.max(1, tailN))) : null;
  const encDesc = (head || tail || {}).description; if ((head && tail) && head.description.join() !== tail.description.join()) throw new Error('the two edges got different parameter sets');
  const merged = encDesc ? mergeParameterSets(new Uint8Array(srcCfg.description), encDesc) : null;
  const lenSize = merged ? merged.lenSize : parseAvcC(new Uint8Array(srcCfg.description)).lenSize;
  const fix = pkts => pkts.map(c => { const list = nalus(c.data, 4).filter(n => ![7, 8, 9].includes(n[0] & 31)).map(merged.renumber); return { data: joinNalus(list, lenSize), type: c.type, ts: c.ts, dur: c.dur }; });
  const name = `${base} (${fmtName(t0)}-${fmtName(t1)}).mp4`, tgt = await opfsTarget(M, name);
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: tgt.target });
  const vsrc = new M.EncodedVideoPacketSource('avc'); output.addVideoTrack(vsrc, { frameRate: p.video.fps || undefined });
  let audioRun = null; try { audioRun = await addExactAudio(M, p, output, t0, t1, false, v => onProgress(0.7 + 0.28 * v)); } catch (e) { await tgt.remove(); throw e; }
  const desc = merged ? merged.description : new Uint8Array(srcCfg.description);
  const hex = n => n.toString(16).padStart(2, '0').toUpperCase();
  const decoderConfig = { codec: merged ? `avc1.${hex(merged.profile)}${hex(merged.compat)}${hex(merged.level)}` : srcCfg.codec, codedWidth: srcCfg.codedWidth, codedHeight: srcCfg.codedHeight, description: desc };
  try {
    await output.start(); let first = true;
    const addRaw = async (c, ts) => { const pk = new M.EncodedPacket(c.data, c.type, ts, c.dur || 1 / (p.video.fps || 30)); await vsrc.add(pk, first ? { decoderConfig } : undefined); first = false; };
    if (head) for (const c of fix(head.packets)) await addRaw(c, c.ts);
    for (const pk of middle) { await vsrc.add(pk.clone({ timestamp: pk.timestamp - t0 }), first ? { decoderConfig } : undefined); first = false; }
    if (tail) for (const c of fix(tail.packets)) await addRaw(c, c.ts + (Kz.timestamp - t0));
    vsrc.close();
    if (audioRun) await audioRun();
    await output.finalize();
  } catch (e) { try { await output.cancel(); } catch (_) {} await tgt.remove(); throw e; }
  const blob = await tgt.file();
  try { await checkTracks(M, blob, ['video', ...(p.a && p.audio.canDecode ? ['audio'] : [])]); } catch (e) { await tgt.remove(); throw e; }
  const copied = middle.length, redone = (head ? head.frames : 0) + (tail ? tail.frames : 0);
  return { blob, name, how: 'smart', exact: true, note: `Exact to the frame. ${copied} of ${copied + redone} frames were copied untouched; only ${redone} at the edges were re-encoded (at ${Math.round(bitrate / 1e6)} Mb/s, so they look the same)${p.a ? (p.audio.lossless ? '; the sound is lossless' : `; the sound is ${Math.round(Math.min(320e3, 160e3 * p.audio.ch) / 1000)} kb/s AAC`) : ''}.`, cleanup: tgt.remove };
}

const extOf = how => how.container === 'webm' ? 'webm' : how.container === 'wav' ? 'wav' : 'mp4';

/* Cuts t0..t1 out. onProgress(0..1). Returns { blob, name, how, exact, note }. */
async function cut(p, t0, t1, opts = {}) {
  const M = p.M, onProgress = opts.onProgress || (() => {}), base = (opts.name || 'part').replace(/\.[^.]+$/, '');
  if (p.how === 'pcm') return cutPcm(p, t0, t1, base, onProgress);
  if (p.how === 'copy') return cutCopy(p, t0, t1, base, onProgress);
  // video: exact to the frame. H.264 gets the smart cut (the middle copied, only the edges re-encoded); anything that
  // stops it falls back to re-encoding the whole part at very high quality. The container follows the source's family.
  const webm = ['vp8', 'vp9', 'av1'].includes(p.video.codec) || (p.a && ['opus', 'vorbis'].includes(p.audio.codec) && p.video.codec !== 'avc');
  let fallbackWhy = null;
  if (p.video.codec === 'avc' && !webm && opts.smart !== false) {
    try { return await cutSmart(p, t0, t1, base, onProgress); }
    catch (e) { fallbackWhy = e.message || String(e); console.warn('smart cut not possible, re-encoding the whole part:', fallbackWhy); }
  }
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
  return { blob, name, how: 'reencode', exact: true, fallbackWhy, note: `Exact to the frame. ${fallbackWhy ? `The whole picture was re-encoded (a frame-copy cut was not possible here: ${fallbackWhy})` : 'The picture was re-encoded'} at ${Math.round(Math.min(100e6, Math.max(floor, srcBr * 3)) / 1e6)} Mb/s (the original was ${Math.round(srcBr / 1e6)} Mb/s), so it looks the same; ${p.a ? (p.audio.lossless ? 'the sound is lossless' : `the sound is ${Math.round(abr / 1000)} kb/s ${webm ? 'Opus' : 'AAC'}`) : 'there is no sound track'}.`, cleanup: tgt.remove };
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
})();
