/* Cutter's media engine: opens any audio or video file, draws its pictures and waveform, plays it, and writes cuts.

   Built on mediabunny (MPL-2.0, vendor/mediabunny/) over the browser's own WebCodecs decoders and encoders. Nothing GPL
   is loaded, files are read lazily (a 5-hour recording is never held in memory), and output streams into the browser's
   private storage before it is saved.

   Three ways to write a cut:
   - copy     Untouched. Packets are copied as they are, in the file's own format, for any codec. A video cut widens to
              the keyframes around it (that is the price of touching nothing); sound lands on a packet edge (~20 ms).
   - smart    Exact to the frame, for video. H.264 copies every whole group of frames and re-encodes only the frames at
              the edges (see h264.js); any other codec is re-encoded to H.264 at a generous bitrate. The sound is cut
              exactly and re-encoded at the highest rate the browser allows (or kept lossless when it was lossless).
   - exact    Exact to the sample, for sound: decoded and written in the same codec when the browser can encode it
              (PCM stays PCM, lossless), otherwise as AAC.
   Conversions to another format go through mediabunny's Conversion. */
import * as M from '../vendor/mediabunny/mediabunny.min.mjs';
import { ParamSets, parseAvcC, nalus, joinNalus } from './h264.js';
export { M };

const EPS = 1e-6;
const PCM = new Set(M.PCM_AUDIO_CODECS);
export const isLossless = c => PCM.has(c) || c === 'flac' || c === 'alac';
export const isMediaFile = f => /^(video|audio)\//.test(f.type || '') || /\.(mp4|m4v|mov|webm|mkv|mka|avi|ts|mts|m2ts|3gp|mp3|m4a|aac|wav|aif|aiff|flac|ogg|oga|opus|weba|wma|wmv|asf|amr|ac3)$/i.test(f.name || '');

/* ---------- formats ---------- */
function familyOf(fmt) {
  if (fmt instanceof M.WebMInputFormat) return 'webm';
  if (fmt instanceof M.MatroskaInputFormat) return 'mkv';
  if (fmt instanceof M.QuickTimeInputFormat) return 'mov';
  if (fmt instanceof M.Mp4InputFormat) return 'mp4';
  if (fmt instanceof M.Mp3InputFormat) return 'mp3';
  if (fmt instanceof M.WaveInputFormat) return 'wav';
  if (fmt instanceof M.FlacInputFormat) return 'flac';
  if (fmt instanceof M.OggInputFormat) return 'ogg';
  if (fmt instanceof M.AdtsInputFormat) return 'aac';
  if (fmt instanceof M.MpegTsInputFormat) return 'ts';
  return 'mkv';
}
/* Output format per family; `big` drops fast start (which holds the whole file in memory to put the index first). */
function outputFormat(family, big) {
  const fs = big ? {} : { fastStart: 'in-memory' };
  switch (family) {
    case 'mp4': case 'm4a': return new M.Mp4OutputFormat(fs);
    case 'mov': return new M.MovOutputFormat(fs);
    case 'webm': return new M.WebMOutputFormat();
    case 'mp3': return new M.Mp3OutputFormat();
    case 'wav': return new M.WavOutputFormat();
    case 'flac': return new M.FlacOutputFormat();
    case 'ogg': return new M.OggOutputFormat();
    case 'aac': return new M.AdtsOutputFormat();
    case 'ts': return new M.MpegTsOutputFormat();
    default: return new M.MkvOutputFormat();
  }
}
const EXT = { mp4: '.mp4', m4a: '.m4a', mov: '.mov', webm: '.webm', mp3: '.mp3', wav: '.wav', flac: '.flac', ogg: '.ogg', aac: '.aac', ts: '.ts', mkv: '.mkv', mka: '.mka' };
const supports = (family, vcodec, acodec) => { const f = outputFormat(family, true); return (!vcodec || f.getSupportedVideoCodecs().includes(vcodec)) && (!acodec || f.getSupportedAudioCodecs().includes(acodec)); };
/* The natural home for a sound codec on its own. */
function audioFamily(codec) {
  if (PCM.has(codec)) return 'wav';
  return { aac: 'm4a', mp3: 'mp3', opus: 'ogg', vorbis: 'ogg', flac: 'flac', alac: 'm4a' }[codec] || 'mka';
}
/* The family a copy keeps: the source's own when it can hold the tracks, else MKV (which holds nearly anything). */
function copyFamily(media, tracks) {
  const vc = tracks !== 'audio' && media.v ? media.video.codec : null, ac = tracks !== 'video' && media.a ? media.audio.codec : null;
  let fam = !vc ? (media.v ? audioFamily(ac) : media.family) : media.family;
  if (fam === 'm4a' && !supports('mp4', null, ac)) fam = 'mka';
  const test = fam === 'm4a' ? 'mp4' : fam === 'mka' ? 'mkv' : fam;
  if (!supports(test, vc, ac)) fam = vc ? 'mkv' : 'mka';
  return fam;
}
/* The source's own extension when the family did not change (keeps .m4v, .m4a, .oga, .mts as they were). */
function extFor(media, family) {
  const own = (media.file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const same = { mp4: ['.mp4', '.m4v', '.m4a'], mov: ['.mov'], webm: ['.webm', '.weba'], mkv: ['.mkv'], mka: ['.mka'], mp3: ['.mp3'], wav: ['.wav'], flac: ['.flac'], ogg: ['.ogg', '.oga', '.opus'], aac: ['.aac'], ts: ['.ts', '.mts', '.m2ts'], m4a: ['.m4a'] };
  if (family === media.family && (same[family] || []).includes(own)) return own;
  if (family === 'mp4' && !media.v) return '.m4a';
  return EXT[family] || '.mkv';
}

/* ---------- a file, opened ---------- */
export class Media {
  constructor(file) { this.file = file; this.name = file.name.replace(/\.[^.]+$/, ''); this.id = `${file.name}|${file.size}|${file.lastModified}`; }
  async open() {
    this.input = new M.Input({ source: new M.BlobSource(this.file), formats: M.ALL_FORMATS });
    let fmt; try { fmt = await this.input.getFormat(); } catch (e) {
      // Microsoft's and old phone formats no browser can decode: say what it is and what to do, not just "can't"
      const ext = (this.file.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase(), known = { wma: 'WMA (Windows Media Audio)', wmv: 'WMV (Windows Media Video)', asf: 'Windows Media', amr: 'AMR (phone voice notes)', ac3: 'AC3 (Dolby Digital)' }[ext];
      if (known) throw new Error(`No browser can read ${known} yet. Drag “${this.file.name}” onto “Convert for Cutter” (in PROJECTS\\tools): it makes a copy the Cutter opens, on this computer, losing nothing.`);
      throw new Error(`“${this.file.name}” is not a sound or video file this browser can read.`);
    }
    this.family = familyOf(fmt); this.formatName = fmt.name;
    this.v = await this.input.getPrimaryVideoTrack(); this.a = await this.input.getPrimaryAudioTrack();
    // a still picture inside a sound file (cover art) is not a video to cut
    if (this.v && this.a && ['mp3', 'flac', 'm4a', 'ogg'].includes(this.family)) { const st = await this.v.computePacketStats(3).catch(() => null); if (st && st.packetCount <= 1) this.v = null; }
    if (!this.v && !this.a) throw new Error(`No sound or picture was found in “${this.file.name}”.`);
    // a video's timeline is its picture (sound that runs a few ms past the last frame is not a frame); a sound file's is its sound
    this.duration = this.v ? await this.v.computeDuration() : await this.a.computeDuration();
    if (this.v) {
      const v = this.v, st = await v.computePacketStats(600).catch(() => null);
      // the frame rate from the gaps between the first frames (the average over the file is skewed by a long last frame
      // or by sound that runs past the picture), snapped to the usual rates
      let fps = st?.averagePacketRate || 30;
      try { const ps = new M.EncodedPacketSink(v), ts = []; for await (const pk of ps.packets(undefined, undefined, { metadataOnly: true })) { ts.push(pk.timestamp); if (ts.length >= 240) break; } ts.sort((x, y) => x - y); const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter(g => g > 1e-5).sort((x, y) => x - y); if (gaps.length > 4) { const med = gaps[gaps.length >> 1], near = gaps.filter(g => g > med * 0.6 && g < med * 1.4); fps = near.length / near.reduce((x, y) => x + y, 0); } } catch (e) {}
      { let best = null; for (const r of [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120]) { const d = Math.abs(fps - r) / r; if (d < 0.01 && (!best || d < best.d)) best = { r, d }; } if (best) fps = best.r; }
      this.video = { w: v.displayWidth, h: v.displayHeight, codedW: v.codedWidth, codedH: v.codedHeight, rotation: v.rotation || 0, codec: v.codec, codecString: await v.getCodecParameterString().catch(() => v.codec), canDecode: await v.canDecode(), fps, bitrate: st?.averageBitrate || 0, config: await v.getDecoderConfig().catch(() => null) };
    } else this.video = null;
    if (this.a) { const a = this.a; this.audio = { sr: a.sampleRate, ch: a.numberOfChannels, codec: a.codec, canDecode: await a.canDecode(), lossless: isLossless(a.codec), config: await a.getDecoderConfig().catch(() => null) }; }
    else this.audio = null;
    this.fps = this.video ? this.video.fps : null;
    return this;
  }
  /* keyframe times, read in the background (the timeline shows them; untouched cuts snap to them) */
  keyframes(onSome) {
    if (this._keysP) return this._keysP;
    return (this._keysP = (async () => {
      if (!this.v) return [];
      const sink = new M.EncodedPacketSink(this.v), keys = []; let k = await sink.getFirstKeyPacket({ metadataOnly: true });
      while (k && keys.length < 200000) { keys.push(k.timestamp); if (onSome && keys.length % 500 === 0) onSome(keys); k = await sink.getNextKeyPacket(k, { metadataOnly: true }); }
      return (this.keys = keys);
    })());
  }
  /* the picture at time t on a canvas (width in px; omit for full size) */
  async frame(t, width) {
    if (!this.v || !this.video.canDecode) return null;
    this._cs ||= new Map(); const key = width || 0; let s = this._cs.get(key);
    if (!s) { s = new M.CanvasSink(this.v, width ? { width, fit: 'contain', poolSize: 2 } : { poolSize: 1 }); this._cs.set(key, s); }
    const w = await s.getCanvas(Math.max(0, Math.min(this.duration - EPS, t))); return w ? { canvas: w.canvas, at: w.timestamp } : null;
  }
  /* a small picture at the keyframe at or before t (cheap: no group of frames to decode) */
  async thumb(t, height = 54) {
    if (!this.v || !this.video.canDecode) return null;
    this._ks ||= new M.EncodedPacketSink(this.v); this._tc ||= new Map();
    const k = await this._ks.getKeyPacket(Math.max(0, t), { metadataOnly: true }); const at = k ? k.timestamp : 0;
    if (this._tc.has(at)) return this._tc.get(at);
    this._ts ||= new M.CanvasSink(this.v, { height, width: Math.round(height * this.video.w / this.video.h), fit: 'cover', poolSize: 0 });
    const p = this._ts.getCanvas(at + EPS).then(w => w ? w.canvas : null).catch(() => null); this._tc.set(at, p); return p;
  }
  /* min/max of the sound per bucket over [t0, t1), decoded a stretch at a time; onChunk(peaks) as it goes */
  async peaks(buckets, t0 = 0, t1 = this.duration, onChunk, cancelled) {
    const bucketSec = Math.max(1e-4, (t1 - t0) / buckets), nb = Math.ceil((t1 - t0) / bucketSec), min = new Float32Array(nb), max = new Float32Array(nb), out = { min, max, bucketSec, t0, t1, done: false };
    if (!this.a || !this.audio.canDecode) { out.done = true; return out; }
    const sink = new M.AudioSampleSink(this.a), step = Math.max(30, (t1 - t0) / 40), stride = bucketSec > 0.05 ? 7 : 1;
    for (let w0 = t0; w0 < t1 - EPS; w0 += step) {
      if (cancelled && cancelled()) return null;
      const w1 = Math.min(t1, w0 + step);
      try {
        for await (const s of sink.samples(w0, w1)) {
          const n = s.numberOfFrames, ch = s.numberOfChannels, sr = s.sampleRate, buf = new Float32Array(n * ch); s.copyTo(buf, { planeIndex: 0, format: 'f32' });
          for (let i = 0; i < n; i += stride) { const b = Math.floor((s.timestamp + i / sr - t0) / bucketSec); if (b < 0 || b >= nb) continue; for (let c = 0; c < ch; c++) { const x = buf[i * ch + c]; if (x < min[b]) min[b] = x; if (x > max[b]) max[b] = x; } }
          s.close();
        }
      } catch (e) { /* a stretch that will not decode is left flat */ }
      if (onChunk) onChunk(out, w1);
    }
    out.done = true; return out;
  }
  /* how different each frame is from the one before (small colour histograms), for finding scene changes */
  async frameDiffs(onProgress, cancelled) {
    if (!this.v || !this.video.canDecode) return [];
    const sink = new M.CanvasSink(this.v, { width: 48, height: 27, fit: 'fill', poolSize: 2 }), out = []; let prev = null, n = 0;
    for await (const w of sink.canvases(0)) {
      if (cancelled && cancelled()) return null;
      const d = w.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w.canvas.width, w.canvas.height).data, h = new Float32Array(48);
      for (let i = 0; i < d.length; i += 4) { h[d[i] >> 4]++; h[16 + (d[i + 1] >> 4)]++; h[32 + (d[i + 2] >> 4)]++; }
      const px = d.length / 4; for (let i = 0; i < 48; i++) h[i] /= px;
      let diff = 0; if (prev) { for (let i = 0; i < 48; i++) diff += Math.abs(h[i] - prev[i]); diff /= 6; }
      out.push({ t: w.timestamp, d: diff }); prev = h; if (onProgress && ++n % 48 === 0) onProgress(Math.min(1, w.timestamp / this.duration));
    }
    return out;
  }
}

/* ---------- playback: pictures on a canvas, sound through Web Audio, both on the audio clock ---------- */
export class Player {
  constructor({ onFrame, onTime, onEnd }) { this.onFrame = onFrame; this.onTime = onTime; this.onEnd = onEnd; this.run = 0; this.playing = false; this.nodes = new Set(); }
  get time() { return this.playing ? this.from + (this.ctx.currentTime - this.ctxStart) * this.rate : this.at || 0; }
  async play(media, from, to = media.duration) {
    this.stop(); const run = ++this.run; this.media = media;
    this.ctx ||= new AudioContext(); if (!this.gain) { this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); }
    await this.ctx.resume(); if (run !== this.run) return;
    this.rate = 1; this.from = from; this.to = Math.min(to, media.duration); this.ctxStart = this.ctx.currentTime + 0.1; this.playing = true;
    const ctx = this.ctx, live = () => run === this.run;
    if (media.a && media.audio.canDecode) (async () => {
      try {
        const sink = new M.AudioBufferSink(media.a), end = this.to >= media.duration - EPS ? undefined : this.to;
        for await (const { buffer, timestamp } of sink.buffers(from, end)) {
          if (!live()) return; if (timestamp >= this.to) break;
          const node = ctx.createBufferSource(); node.buffer = buffer; node.connect(this.gain);
          const when = this.ctxStart + (timestamp - from), now = ctx.currentTime;
          if (when >= now) node.start(when); else if (now - when < buffer.duration) node.start(now, now - when); else continue;
          const stopAt = this.ctxStart + (this.to - from); if (stopAt < when + buffer.duration) node.stop(Math.max(now, stopAt));
          this.nodes.add(node); node.onended = () => this.nodes.delete(node);
          while (live() && timestamp - this.time > 2) await new Promise(r => setTimeout(r, 120));
        }
      } catch (e) { console.warn('sound playback stopped:', e); }
    })();
    if (media.v && media.video.canDecode) (async () => {
      try {
        const sink = new M.CanvasSink(media.v, { width: Math.min(1280, media.video.w), fit: 'contain', poolSize: 3 }), end = this.to >= media.duration - EPS ? undefined : this.to;
        for await (const w of sink.canvases(from, end)) {
          if (!live()) return; if (w.timestamp >= this.to) break;
          while (live() && w.timestamp > this.time + 0.004) await new Promise(r => requestAnimationFrame(r));
          if (!live()) return;
          if (this.time - w.timestamp < 0.25) this.onFrame(w.canvas, w.timestamp); // drawn unless far behind (the decoder could not keep up)
        }
      } catch (e) { console.warn('picture playback stopped:', e); }
    })();
    const tick = () => { if (!live()) return; const t = this.time; if (t >= this.to - EPS) { this.at = this.to; this.stop(); this.onTime(this.to); this.onEnd && this.onEnd(); return; } this.onTime(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  stop() { if (this.playing) this.at = Math.min(this.to, this.time); this.run++; this.playing = false; for (const n of this.nodes) { try { n.stop(); } catch (e) {} } this.nodes.clear(); }
}

/* ---------- where output goes: the browser's private storage, streamed, swept after an hour ---------- */
async function opfsTarget(name) {
  const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('cutter', { create: true }), stamp = Date.now(), fname = `${stamp.toString(36)}${Math.random().toString(36).slice(2, 6)}-${name}`;
  try { for await (const [k] of dir.entries()) { const s = parseInt(k.split('-')[0].slice(0, -4), 36); if (s && stamp - s > 3600e3) await dir.removeEntry(k).catch(() => {}); } } catch (e) {}
  const fh = await dir.getFileHandle(fname, { create: true }), ws = await fh.createWritable({ keepExistingData: false }); let done; const closed = new Promise(r => { done = r; });
  const target = new M.StreamTarget(new WritableStream({ write: async c => { await ws.write({ type: 'write', position: c.position, data: c.data }); }, close: async () => { await ws.close(); done(); }, abort: async () => { try { await ws.abort(); } catch (e) {} done(); } }), { chunked: true });
  return { target, file: async () => { await closed; return fh.getFile(); }, remove: async () => { try { await dir.removeEntry(fname); } catch (e) {} } };
}
/* Every track that went in must be in the file: an encoder that fails quietly leaves one out. */
async function checkTracks(file, want) {
  const inp = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS }), got = (await inp.getTracks()).map(t => t.type);
  for (const w of want) if (!got.includes(w)) throw new Error(`The ${w === 'video' ? 'picture' : 'sound'} did not make it into the file (the browser's encoder refused it). Nothing was saved.`);
}
/* The highest AAC rate this browser's encoder accepts for the channel count (stereo at 320 kb/s is refused on some). */
export async function aacBitrate(channels, sampleRate) {
  for (const per of [160e3, 128e3, 96e3, 64e3]) { const bitrate = Math.min(320e3, per * channels); try { if ((await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', numberOfChannels: channels, sampleRate, bitrate })).supported) return bitrate; } catch (e) {} }
  return 96e3 * channels;
}
const videoBitrate = media => { const px = media.video.w * media.video.h, floor = px >= 3840 * 2160 ? 45e6 : px >= 1920 * 1080 ? 12e6 : 6e6; return Math.round(Math.min(100e6, Math.max(floor, (media.video.bitrate || 8e6) * 3))); };
class Cancelled extends Error { constructor() { super('Cancelled.'); this.cancelled = true; } }
const job = opts => ({ progress: opts.onProgress || (() => {}), check: () => { if (opts.signal && opts.signal.aborted) throw new Cancelled(); } });
async function run(output, tgt, fn) { try { await fn(); } catch (e) { try { await output.cancel(); } catch (_) {} await tgt.remove(); throw e; } }

/* ---------- 1. copy: untouched, any codec ----------
   ranges: [{ media, t0, t1 }] (one file, or several files whose tracks match exactly). tracks: 'both'|'audio'|'video'. */
async function copyJob(ranges, opts) {
  const J = job(opts), m0 = ranges[0].media, tracks = opts.tracks || 'both';
  const useV = tracks !== 'audio' && !!m0.v, useA = tracks !== 'video' && !!m0.a;
  const family = copyFamily(m0, tracks), ext = extFor(m0, family), name = opts.fileName(ext);
  const plan = []; let total = 0;
  for (const r of ranges) {
    let t0 = r.t0, t1 = r.t1, K = null, Kend = null, vs = null;
    if (useV) {
      vs = new M.EncodedPacketSink(r.media.v);
      K = (await vs.getKeyPacket(r.t0 + EPS, { metadataOnly: true })) || await vs.getFirstKeyPacket({ metadataOnly: true });
      if (r.t1 < r.media.duration - EPS) { Kend = await vs.getKeyPacket(r.t1 - EPS, { metadataOnly: true }); if (Kend && Kend.timestamp < r.t1 - EPS) Kend = await vs.getNextKeyPacket(Kend, { metadataOnly: true }); }
      t0 = K.timestamp; t1 = Kend ? Kend.timestamp : r.media.duration;
    }
    plan.push({ ...r, t0, t1, K, Kend }); total += t1 - t0;
  }
  const big = (m0.file.size * total / Math.max(1, m0.duration)) > 300e6;
  const tgt = await opfsTarget(name), output = new M.Output({ format: outputFormat(family === 'm4a' ? 'mp4' : family === 'mka' ? 'mkv' : family, big), target: tgt.target });
  const vsrc = useV ? new M.EncodedVideoPacketSource(m0.video.codec) : null, asrc = useA ? new M.EncodedAudioPacketSource(m0.audio.codec) : null;
  if (vsrc) output.addVideoTrack(vsrc, { rotation: m0.video.rotation || 0, frameRate: m0.fps || undefined });
  if (asrc) output.addAudioTrack(asrc);
  await run(output, tgt, async () => {
    await output.start(); let off = 0, firstV = true, firstA = true, lastA = 0;
    for (const p of plan) {
      let vIt = null;
      if (useV) { const vsk = new M.EncodedPacketSink(p.media.v), Kf = await vsk.getKeyPacket(p.K.timestamp + EPS), Ke = p.Kend ? await vsk.getKeyPacket(p.Kend.timestamp + EPS) : undefined; vIt = vsk.packets(Kf, Ke)[Symbol.asyncIterator](); }
      let aIt = null;
      if (useA) { const as = new M.EncodedPacketSink(p.media.a); let first = await as.getPacket(p.t0) || await as.getFirstPacket(); if (first && first.timestamp + first.duration / 2 < p.t0) first = await as.getNextPacket(first) || first; aIt = first ? as.packets(first)[Symbol.asyncIterator]() : null; }
      let vN = vIt ? await vIt.next() : { done: true }, aN = aIt ? await aIt.next() : { done: true };
      const aEnd = pk => pk.timestamp + pk.duration / 2 > p.t1;
      if (!aN.done && aEnd(aN.value)) aN = { done: true };
      while (!vN.done || !aN.done) {
        J.check();
        const takeV = !vN.done && (aN.done || vN.value.timestamp <= aN.value.timestamp);
        if (takeV) {
          const pk = vN.value;
          if (pk.timestamp >= p.t0 - EPS) { await vsrc.add(pk.clone({ timestamp: pk.timestamp - p.t0 + off }), firstV ? { decoderConfig: m0.video.config } : undefined); firstV = false; }
          vN = await vIt.next();
        } else {
          const pk = aN.value, ts = Math.max(lastA, pk.timestamp - p.t0 + off);
          await asrc.add(pk.clone({ timestamp: ts }), firstA ? { decoderConfig: m0.audio.config } : undefined); firstA = false; lastA = ts + pk.duration;
          J.progress(Math.min(0.99, ts / total));
          aN = await aIt.next(); if (!aN.done && aEnd(aN.value)) aN = { done: true };
        }
      }
      off += p.t1 - p.t0;
    }
    vsrc?.close(); asrc?.close(); await output.finalize();
  });
  const file = await tgt.file(); await checkTracks(file, [...(useV ? ['video'] : []), ...(useA ? ['audio'] : [])]).catch(async e => { await tgt.remove(); throw e; });
  const moved = plan.filter((p, i) => Math.abs(p.t0 - ranges[i].t0) > 1e-3 || Math.abs(p.t1 - ranges[i].t1) > 1e-3);
  return { file, name, how: 'copy', length: total, cleanup: tgt.remove, actual: plan.map(p => ({ t0: p.t0, t1: p.t1 })),
    note: `Untouched: nothing was re-encoded.${useV && moved.length ? ` The picture can only be cut on keyframes without re-encoding, so ${ranges.length === 1 ? 'the cut' : `${moved.length} of the parts`} widened to the keyframes around ${ranges.length === 1 ? 'it' : 'them'}.` : ''}${!useV ? ' The cut lands on the nearest packet edge (within about 20 ms).' : ''}` };
}

/* ---------- the exact sound: decoded, trimmed to the sample, written as one continuous track ----------
   Feeds an AudioSampleSource range by range; until(t) writes everything up to output time t (so sound can be written
   in step with the picture). Ranges from files with another rate or channel count are converted. Joins get a 2 ms
   ramp so they do not click. */
class SoundFeeder {
  constructor(src, ranges, sr, ch, joined) { this.src = src; this.ranges = ranges; this.sr = sr; this.ch = ch; this.joined = joined; this.i = 0; this.pos = 0; this.it = null; this.outFrames = 0; let o = 0; this.starts = ranges.map(r => { const s = o; o += r.t1 - r.t0; return s; }); this.total = o; }
  async until(tOut) {
    while (this.i < this.ranges.length && this.outFrames / this.sr < tOut - EPS) {
      const r = this.ranges[this.i], rEndFrames = Math.round((this.starts[this.i] + r.t1 - r.t0) * this.sr);
      if (!this.it) {
        this.rampIn = this.joined && this.i > 0; this.rampOut = this.joined && this.i < this.ranges.length - 1; this.rStart = Math.round(this.starts[this.i] * this.sr);
        this.it = r.media.a && r.media.audio.canDecode ? new M.AudioSampleSink(r.media.a).samples(r.t0, r.t1 >= r.media.duration - EPS ? undefined : r.t1)[Symbol.asyncIterator]() : null;
      }
      const n = this.it ? await this.it.next() : { done: true };
      if (n.done) { // the range ran out (or has no sound): silence up to its end, then the next range
        if (rEndFrames > this.outFrames) await this.write(new Float32Array((rEndFrames - this.outFrames) * this.ch), rEndFrames - this.outFrames, rEndFrames);
        this.it = null; this.i++; continue;
      }
      const s = n.value, sr = s.sampleRate, sch = s.numberOfChannels, buf = new Float32Array(s.numberOfFrames * sch); s.copyTo(buf, { planeIndex: 0, format: 'f32' }); const ts = s.timestamp; s.close();
      const from = Math.max(0, Math.round((r.t0 - ts) * sr)), to = Math.min(buf.length / sch, Math.round((r.t1 - ts) * sr)); if (to <= from) continue;
      // to the output's rate and channels
      let frames = to - from, data;
      if (sr === this.sr && sch === this.ch) data = buf.subarray(from * sch, to * sch);
      else { const outN = Math.max(0, Math.round(frames * this.sr / sr)); data = new Float32Array(outN * this.ch); for (let i = 0; i < outN; i++) { const x = from + i * sr / this.sr, i0 = Math.floor(x), f = x - i0, i1 = Math.min(to - 1, i0 + 1); for (let c = 0; c < this.ch; c++) { const cc = Math.min(c, sch - 1); data[i * this.ch + c] = buf[i0 * sch + cc] * (1 - f) + buf[i1 * sch + cc] * f; } } frames = outN; }
      // where it lands; a gap left by the decoder is filled with silence
      const at = this.rStart + Math.round(Math.max(0, ts + from / sr - r.t0) * this.sr);
      if (at > this.outFrames) await this.write(new Float32Array((at - this.outFrames) * this.ch), at - this.outFrames, rEndFrames);
      let skip = Math.max(0, this.outFrames - at); if (skip >= frames) continue;
      await this.write(skip ? data.subarray(skip * this.ch) : data, frames - skip, rEndFrames);
    }
  }
  async write(data, frames, rEnd) {
    frames = Math.min(frames, rEnd - this.outFrames); if (frames <= 0) return;
    data = data.length === frames * this.ch ? data : data.subarray(0, frames * this.ch);
    const ramp = Math.round(this.sr * 0.002);
    if (this.rampIn || this.rampOut) { data = Float32Array.from(data); for (let i = 0; i < frames; i++) { const g = Math.min(this.rampIn ? Math.min(1, (this.outFrames + i - this.rStart) / ramp) : 1, this.rampOut ? Math.min(1, (rEnd - this.outFrames - i) / ramp) : 1); if (g < 1) for (let c = 0; c < this.ch; c++) data[i * this.ch + c] *= Math.max(0, g); } }
    const piece = new M.AudioSample({ data, format: 'f32', sampleRate: this.sr, numberOfChannels: this.ch, timestamp: this.outFrames / this.sr });
    await this.src.add(piece); piece.close(); this.outFrames += frames;
  }
  async finish() { await this.until(this.total + 1); }
}
/* The sound codec for an exact cut: the source's own when the browser can encode it (PCM always), else AAC. */
async function exactSoundCodec(media, family) {
  const c = media.audio.codec;
  if (PCM.has(c)) return { codec: ['pcm-s16', 'pcm-s24', 'pcm-s32', 'pcm-f32', 'pcm-u8'].includes(c) ? c : c.startsWith('pcm-f') ? 'pcm-f32' : 'pcm-s24', lossless: true };
  if (c === 'flac' || c === 'alac') return { codec: 'pcm-s24', lossless: true }; // lossless in, lossless out (as PCM)
  if (supports(family, null, c) && await M.canEncodeAudio(c)) return { codec: c, lossless: false };
  return { codec: 'aac', lossless: false };
}
async function soundSource(codec, ch, sr) {
  if (PCM.has(codec)) return new M.AudioSampleSource({ codec });
  const bitrate = codec === 'aac' ? await aacBitrate(ch, sr) : codec === 'opus' ? Math.min(256e3, 128e3 * ch) : Math.min(320e3, 160e3 * ch);
  return new M.AudioSampleSource({ codec, quality: new M.Quality({ bitrate }) });
}

/* ---------- 2. exact sound on its own ---------- */
async function exactSoundJob(ranges, opts) {
  const J = job(opts), m0 = ranges[0].media, joined = ranges.length > 1;
  let family = opts.family, codec = opts.codec, lossless = false;
  if (!codec) { family ||= audioFamily(m0.audio.codec); const x = await exactSoundCodec(m0, family === 'm4a' ? 'mp4' : family); codec = x.codec; lossless = x.lossless; if (PCM.has(codec)) family = 'wav'; else if (!supports(family === 'm4a' ? 'mp4' : family === 'mka' ? 'mkv' : family, null, codec)) family = 'm4a'; }
  else lossless = PCM.has(codec);
  const sr = Math.max(...ranges.map(r => r.media.audio?.sr || 0)) || 48000, ch = Math.max(...ranges.map(r => r.media.audio?.ch || 0)) || 2;
  const ext = family === 'm4a' ? '.m4a' : family === 'mka' ? '.mka' : EXT[family] || '.mka', name = opts.fileName(ext);
  const tgt = await opfsTarget(name), output = new M.Output({ format: outputFormat(family === 'm4a' ? 'mp4' : family === 'mka' ? 'mkv' : family, false), target: tgt.target });
  const src = await soundSource(codec, ch, sr); output.addAudioTrack(src);
  const feeder = new SoundFeeder(src, ranges, sr, ch, joined);
  await run(output, tgt, async () => { await output.start(); for (let t = 5; t < feeder.total + 5; t += 5) { J.check(); await feeder.until(t); J.progress(Math.min(0.99, t / feeder.total)); } src.close(); await output.finalize(); });
  const file = await tgt.file(); await checkTracks(file, ['audio']).catch(async e => { await tgt.remove(); throw e; });
  return { file, name, how: 'exact', length: feeder.total, cleanup: tgt.remove, note: `Exact to the sample${lossless ? ' and lossless' : ''}${!lossless && codec !== m0.audio.codec ? ` (saved as ${codec.toUpperCase()}: this browser cannot write ${m0.audio.codec.toUpperCase()})` : ''}.` };
}

/* ---------- 3. smart: video exact to the frame ---------- */
async function encodeFrames(media, t0, t1, enc, onChunk, J, fit) {
  // decodes [t0, t1) of media and feeds the frames to the configured encoder; fit = { w, h } draws them letterboxed
  const sink = new M.VideoSampleSink(media.v); let n = 0, cv = null, cx = null;
  if (fit) { cv = new OffscreenCanvas(fit.w, fit.h); cx = cv.getContext('2d'); }
  for await (const s of sink.samples(t0, t1 >= media.duration - EPS ? undefined : t1)) {
    if (s.timestamp < t0 - EPS || s.timestamp >= t1 - EPS) { s.close(); continue; }
    J.check();
    const stamp = { timestamp: Math.max(0, Math.round((s.timestamp - t0) * 1e6)), duration: Math.round(1e6 / media.fps) };
    let fr;
    if (fit) { cx.fillStyle = '#000'; cx.fillRect(0, 0, fit.w, fit.h); const sc = Math.min(fit.w / s.displayWidth, fit.h / s.displayHeight), w = s.displayWidth * sc, h = s.displayHeight * sc; s.draw(cx, (fit.w - w) / 2, (fit.h - h) / 2, w, h); fr = new VideoFrame(cv, stamp); }
    else { const raw = s.toVideoFrame(); fr = new VideoFrame(raw, stamp); raw.close(); }
    s.close(); enc.encode(fr, { keyFrame: n === 0 }); fr.close(); n++;
    while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 4));
    if (onChunk) await onChunk(n);
  }
  return n;
}
function makeEncoder(cfg) {
  const st = { chunks: [], desc: null, err: null };
  const enc = new VideoEncoder({ output: (c, meta) => { if (meta?.decoderConfig?.description && !st.desc) st.desc = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description); const d = new Uint8Array(c.byteLength); c.copyTo(d); st.chunks.push({ data: d, type: c.type, ts: c.timestamp / 1e6 }); }, error: e => { st.err = e; } });
  enc.configure(cfg); return { enc, st };
}
async function encodeStretch(media, t0, t1, cfg, J, fit) {
  const { enc, st } = makeEncoder(cfg); await encodeFrames(media, t0, t1, enc, () => { if (st.err) throw st.err; }, J, fit);
  await enc.flush(); enc.close(); if (st.err) throw st.err; if (!st.desc) throw new Error('the encoder gave no parameter sets');
  st.chunks.sort((a, b) => a.ts - b.ts); return { packets: st.chunks, description: st.desc, frames: st.chunks.length };
}
async function smartJob(ranges, opts) {
  const J = job(opts), m0 = ranges[0].media, withSound = opts.tracks !== 'video' && ranges.some(r => r.media.a && r.media.audio.canDecode);
  for (const r of ranges) { if (!r.media.v) throw new Error(`“${r.media.file.name}” has no picture.`); if (!r.media.video.canDecode) throw new Error(`This browser cannot decode the picture in “${r.media.file.name}” (${r.media.video.codec}). Try “Untouched”, which copies it without decoding.`); }
  const W = m0.video.codedW, H = m0.video.codedH, rot = m0.video.rotation || 0;
  for (const r of ranges) if ((r.media.video.rotation || 0) !== rot) throw new Error(`“${r.media.file.name}” is turned differently from “${m0.file.name}”, so they cannot be joined here yet.`);
  let family = opts.family || (['mp4', 'mov', 'mkv'].includes(m0.family) ? m0.family : 'mp4');
  const codecString = m0.video.codec === 'avc' && /^avc1\./.test(m0.video.codecString) ? m0.video.codecString : 'avc1.640033';
  const bitrate = Math.max(...ranges.map(r => videoBitrate(r.media))), fpsOut = m0.fps;
  const cfg = { codec: codecString, width: W, height: H, bitrate, framerate: fpsOut, latencyMode: 'quality', avc: { format: 'avc' }, hardwareAcceleration: 'no-preference' };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) { cfg.codec = 'avc1.640033'; if (!(await VideoEncoder.isConfigSupported(cfg)).supported) throw new Error('This browser cannot encode H.264 at this size.'); }
  // the plan: per range, the keyframes that bound a copyable middle; the edges are encoded now (they are short), so every
  // parameter set is known before the first packet is written and the middle can stream straight from the file
  const sets = new ParamSets(), perMedia = new Map(), plan = []; let encSet = null, total = 0, totalFrames = 0, doneFrames = 0;
  const encRen = d => { if (!encSet) { encSet = sets.add(d); encSet.desc = d; } else if (!sameBytesArr(d, encSet.desc)) throw new Error('the encoder gave different settings for two edges'); return encSet; };
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i], me = r.media, fps = me.fps, sameSize = me.video.codedW === W && me.video.codedH === H;
    const p = { ...r, kind: 'encode', why: null, head: null, tail: null, K1: null, Kz: null, frames: Math.round((r.t1 - r.t0) * fps) };
    totalFrames += p.frames; total += r.t1 - r.t0;
    if (me.video.codec === 'avc' && me.video.config?.description && sameSize) {
      try {
        if (!perMedia.has(me)) perMedia.set(me, sets.add(me.video.config.description));
        const sink = new M.EncodedPacketSink(me.v);
        let k = await sink.getKeyPacket(r.t0, { metadataOnly: true }) || await sink.getFirstKeyPacket({ metadataOnly: true }); while (k && k.timestamp < r.t0 - EPS) k = await sink.getNextKeyPacket(k, { metadataOnly: true });
        const atEnd = r.t1 >= me.duration - 0.5 / fps, K1 = k, Kz = atEnd ? { timestamp: me.duration, virtual: true } : await sink.getKeyPacket(r.t1 + EPS, { metadataOnly: true });
        if (K1 && Kz && Kz.timestamp > K1.timestamp + EPS) {
          // closed groups only: every packet between the two keyframes must show between them (checked from the index)
          for await (const pk of sink.packets(K1, Kz.virtual ? undefined : Kz, { metadataOnly: true })) if (pk.timestamp < K1.timestamp - EPS || (!Kz.virtual && pk.timestamp >= Kz.timestamp - EPS)) throw Object.assign(new Error('open groups of frames'), { soft: true });
          p.kind = 'smart'; p.K1 = K1; p.Kz = Kz;
          if (K1.timestamp > r.t0 + EPS) { J.progress(doneFrames / Math.max(1, totalFrames) * 0.9, `part ${i + 1}: re-encoding the first frames`); p.head = await encodeStretch(me, r.t0, K1.timestamp, cfg, J); encRen(p.head.description); doneFrames += p.head.frames; }
          if (!Kz.virtual && r.t1 > Kz.timestamp + EPS) { J.progress(doneFrames / Math.max(1, totalFrames) * 0.9, `part ${i + 1}: re-encoding the last frames`); p.tail = await encodeStretch(me, Kz.timestamp, r.t1, cfg, J); encRen(p.tail.description); doneFrames += p.tail.frames; }
        } else p.why = 'no whole group of frames inside the part';
      } catch (e) { if (e.cancelled) throw e; if (!e.soft && !/open groups/.test(e.message)) console.warn('smart cut not possible:', e); p.kind = 'encode'; p.why = e.message; p.head = p.tail = null; }
    } else p.why = me.video.codec !== 'avc' ? `the picture is ${me.video.codec.toUpperCase()}, not H.264` : !sameSize ? 'a different picture size' : 'no parameter sets';
    plan.push(p);
  }
  // parts re-encoded whole need the encoder's parameter sets up front: one frame encoded to learn them
  if (plan.some(p => p.kind === 'encode') && !encSet) { const pr = plan.find(p => p.kind === 'encode'); const probe = await encodeStretch(pr.media, pr.t0, Math.min(pr.t1, pr.t0 + 1.5 / pr.media.fps), cfg, J, pr.media.video.codedW !== W || pr.media.video.codedH !== H ? { w: W, h: H } : null); encRen(probe.description); }
  const desc = sets.description(), lenOut = parseAvcC(desc).lenSize;
  const decoderConfig = { codec: sets.codecString(), codedWidth: W, codedHeight: H, description: desc };
  const ext = family === 'mp4' && m0.family === 'mp4' ? extFor(m0, 'mp4') : EXT[family], name = opts.fileName(ext);
  const big = total * bitrate / 8 > 300e6 || m0.file.size * total / Math.max(1, m0.duration) > 300e6;
  const tgt = await opfsTarget(name), output = new M.Output({ format: outputFormat(family, big), target: tgt.target });
  const vsrc = new M.EncodedVideoPacketSource('avc'); output.addVideoTrack(vsrc, { rotation: rot, frameRate: ranges.every(r => Math.abs(r.media.fps - fpsOut) < 0.01) ? fpsOut : undefined });
  let feeder = null, sound = null;
  if (withSound) { const ms = ranges.find(r => r.media.a)?.media; sound = await exactSoundCodec(ms, family); const sr = Math.max(...ranges.map(r => r.media.audio?.sr || 0)) || 48000, ch = Math.max(...ranges.map(r => r.media.audio?.ch || 0)) || 2; const asrc = await soundSource(sound.codec, ch, sr); output.addAudioTrack(asrc); feeder = new SoundFeeder(asrc, ranges, sr, ch, ranges.length > 1); feeder.srcRef = asrc; }
  const report = { copied: 0, redone: 0, parts: [] };
  await run(output, tgt, async () => {
    await output.start(); let first = true, off = 0, lastFed = 0;
    const add = async (data, type, ts, dur) => { await vsrc.add(new M.EncodedPacket(data, type, ts, dur), first ? { decoderConfig } : undefined); first = false; if (feeder && ts - lastFed > 1) { await feeder.until(ts + 0.5); lastFed = ts; } };
    const fromEncoder = (c, base, me) => add(joinNalus(nalus(c.data, 4).filter(n => ![7, 8, 9].includes(n[0] & 31)).map(encSet.renumber), lenOut), c.type, base + c.ts, 1 / me.fps);
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i], me = p.media; let copied = 0, redone = 0;
      if (p.kind === 'smart') {
        if (p.head) for (const c of p.head.packets) await fromEncoder(c, off, me); redone += p.head ? p.head.frames : 0;
        const ren = perMedia.get(me), lenIn = parseAvcC(new Uint8Array(me.video.config.description)).lenSize, sink = new M.EncodedPacketSink(me.v);
        J.progress(Math.min(0.97, (doneFrames + 0) / Math.max(1, totalFrames)), `part ${i + 1}: copying`);
        const K1f = await sink.getKeyPacket(p.K1.timestamp + EPS), Kzf = p.Kz.virtual ? undefined : await sink.getKeyPacket(p.Kz.timestamp + EPS);
        for await (const pk of sink.packets(K1f, Kzf)) {
          J.check(); const data = lenIn === lenOut ? joinNalus(nalus(pk.data, lenIn).map(ren.renumber), lenOut) : joinNalus(nalus(pk.data, lenIn).map(ren.renumber), lenOut);
          await add(data, pk.type, off + (pk.timestamp - p.t0), pk.duration || 1 / me.fps); copied++; doneFrames++; if (copied % 60 === 0) J.progress(Math.min(0.97, doneFrames / Math.max(1, totalFrames)), `part ${i + 1}: copying`);
        }
        if (p.tail) for (const c of p.tail.packets) await fromEncoder(c, off + (p.Kz.timestamp - p.t0), me); redone += p.tail ? p.tail.frames : 0;
      } else {
        // the whole part through the encoder, written as it comes out
        const fit = me.video.codedW !== W || me.video.codedH !== H ? { w: W, h: H } : null, { enc, st } = makeEncoder(cfg); let written = 0;
        const drain = async () => { st.chunks.sort((a, b) => a.ts - b.ts); const ready = st.chunks.splice(0, st.chunks.length); for (const c of ready) await fromEncoder(c, off, me); written += ready.length; };
        await encodeFrames(me, p.t0, p.t1, enc, async n => { if (st.err) throw st.err; if (st.chunks.length > 8) await drain(); if (n % 15 === 0) J.progress(Math.min(0.97, (doneFrames + n) / Math.max(1, totalFrames)), `part ${i + 1}: re-encoding (${p.why})`); }, J, fit);
        await enc.flush(); enc.close(); if (st.err) throw st.err; await drain(); redone = written; doneFrames += written;
        if (st.desc && !sameBytesArr(st.desc, encSet.desc)) throw new Error('the encoder changed its settings between parts');
      }
      report.parts.push({ copied, redone, why: p.kind === 'encode' ? p.why : null }); report.copied += copied; report.redone += redone; off += p.t1 - p.t0;
    }
    vsrc.close(); if (feeder) { J.progress(0.98, 'writing the sound'); await feeder.finish(); feeder.srcRef.close(); }
    await output.finalize();
  });
  const file = await tgt.file(); await checkTracks(file, ['video', ...(withSound ? ['audio'] : [])]).catch(async e => { await tgt.remove(); throw e; });
  const all = report.copied + report.redone, whyAll = [...new Set(report.parts.map(x => x.why).filter(Boolean))];
  return { file, name, how: 'smart', length: total, cleanup: tgt.remove, report,
    note: `Exact to the frame. ${!report.redone ? `All ${all.toLocaleString()} frames were copied untouched.` : report.copied ? `${report.copied.toLocaleString()} of ${all.toLocaleString()} frames were copied untouched; ${report.redone.toLocaleString()} at the edges ${report.redone === 1 ? 'was' : 'were'} re-encoded at ${Math.round(bitrate / 1e6)} Mb/s, so they look the same.` : `All ${all.toLocaleString()} frames were re-encoded${whyAll.length ? ` (${whyAll.join('; ')})` : ''} at ${Math.round(bitrate / 1e6)} Mb/s, so it looks the same.`}${withSound ? ` The sound is ${sound.lossless ? 'lossless' : sound.codec.toUpperCase()}${sound.lossless ? '' : ' at the highest rate this browser allows'}.` : ''}` };
}
const sameBytesArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/* ---------- 4. conversion to another format ---------- */
const TARGETS = {
  mp4: { family: 'mp4', video: 'avc', audio: 'aac', label: 'MP4 (H.264 + AAC)' },
  webm: { family: 'webm', video: 'vp9', audio: 'opus', label: 'WebM (VP9 + Opus)' },
  m4a: { family: 'm4a', audio: 'aac', label: 'M4A (AAC)', sound: true },
  wav: { family: 'wav', audio: 'pcm-s16', label: 'WAV (lossless)', sound: true },
  ogg: { family: 'ogg', audio: 'opus', label: 'Ogg (Opus)', sound: true },
  mp3: { family: 'mp3', audio: 'mp3', label: 'MP3', sound: true },
  flac: { family: 'flac', audio: 'flac', label: 'FLAC', sound: true },
};
/* The formats this browser can write, for the format list. */
export async function writableTargets() {
  const out = [];
  for (const [k, t] of Object.entries(TARGETS)) { const okA = !t.audio || PCM.has(t.audio) || await M.canEncodeAudio(t.audio).catch(() => false), okV = !t.video || await M.canEncodeVideo(t.video).catch(() => false); if (okA && okV) out.push({ id: k, ...t }); }
  return out;
}
async function convertJob(ranges, opts) {
  const J = job(opts), t = TARGETS[opts.format], m0 = ranges[0].media;
  if (t.sound) {
    if (!ranges.every(r => r.media.a)) throw new Error('There is no sound to save.');
    const codec = t.audio === 'pcm-s16' && ranges.some(r => r.media.audio.lossless && /24|32|f/.test(r.media.audio.codec)) ? 'pcm-s24' : t.audio;
    return exactSoundJob(ranges, { ...opts, family: t.family, codec });
  }
  if (opts.format === 'mp4') return smartJob(ranges, { ...opts, family: 'mp4' });
  // WebM: one range is converted straight from the file; several are joined exactly first, then converted
  let src = m0, t0 = ranges[0].t0, t1 = ranges[0].t1, temp = null;
  if (ranges.length > 1) { temp = await smartJob(ranges, { ...opts, family: 'mp4', onProgress: (v, s) => J.progress(v * 0.5, s), fileName: () => 'joined.mp4' }); src = await new Media(temp.file).open(); t0 = 0; t1 = src.duration; }
  const name = opts.fileName(EXT[t.family]), tgt = await opfsTarget(name), output = new M.Output({ format: outputFormat(t.family, true), target: tgt.target });
  const withSound = opts.tracks !== 'video' && !!src.a;
  const conv = await M.Conversion.init({ input: src.input, output, trim: { start: t0, end: t1 },
    video: opts.tracks === 'audio' ? { discard: true } : { codec: t.video, quality: new M.Quality({ bitrate: videoBitrate(src) }), hardwareAcceleration: 'no-preference' },
    audio: withSound ? { codec: t.audio, quality: new M.Quality({ bitrate: Math.min(256e3, 128e3 * (src.audio.ch || 2)) }) } : { discard: true } });
  const dropped = conv.discardedTracks.filter(d => d.reason !== 'discarded_by_user').map(d => `${d.track.type}: ${d.reason}`);
  if (!conv.isValid || dropped.length) { await tgt.remove(); if (temp) await temp.cleanup(); throw new Error(`This file cannot be converted here (${dropped.join('; ') || 'the browser cannot decode it'}).`); }
  conv.onProgress = v => J.progress(temp ? 0.5 + v * 0.5 : v, 'converting');
  if (opts.signal) opts.signal.addEventListener('abort', () => conv.cancel().catch(() => {}), { once: true });
  try { await conv.execute(); } catch (e) { await tgt.remove(); if (temp) await temp.cleanup(); throw opts.signal?.aborted ? new Cancelled() : e; }
  if (temp) await temp.cleanup();
  const file = await tgt.file(); await checkTracks(file, ['video', ...(withSound ? ['audio'] : [])]).catch(async e => { await tgt.remove(); throw e; });
  return { file, name, how: 'convert', length: t1 - t0, cleanup: tgt.remove, note: `Converted to ${t.label}, exact to the frame, at ${Math.round(videoBitrate(src) / 1e6)} Mb/s.` };
}

/* ---------- the one entry point ----------
   spec: { ranges: [{ media, t0, t1 }], precision: 'exact'|'copy', tracks: 'both'|'audio'|'video', format: 'same'|<target>,
           fileName(ext) -> string, onProgress(0..1, text), signal } -> { file, name, note, how, length, cleanup } */
export async function writeCut(spec) {
  const m0 = spec.ranges[0].media, tracks = spec.tracks || 'both';
  if (spec.format && spec.format !== 'same') return convertJob(spec.ranges, spec);
  const picture = !!m0.v && tracks !== 'audio';
  if (picture) return spec.precision === 'copy' ? copyJob(spec.ranges, spec) : smartJob(spec.ranges, spec);
  if (!m0.a) throw new Error('There is no sound to save.');
  // sound on its own: PCM is always cut exactly (it is lossless and costs nothing); compressed sound is copied or re-encoded
  if (spec.precision === 'copy' && !PCM.has(m0.audio.codec)) return copyJob(spec.ranges, { ...spec, tracks: 'audio' });
  return exactSoundJob(spec.ranges, spec);
}
/* Can these files be joined untouched (same codecs, same settings)? */
export function sameTracks(medias) {
  const a = medias[0], key = m => JSON.stringify([m.video && [m.video.codec, m.video.codedW, m.video.codedH, m.video.config?.description && Array.from(new Uint8Array(m.video.config.description.buffer || m.video.config.description)).join(',')], m.audio && [m.audio.codec, m.audio.sr, m.audio.ch]]);
  return medias.every(m => key(m) === key(a));
}
