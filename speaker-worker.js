/* Who is speaking when: Mixtape's speaker finder for transcripts.
   - pyannote segmentation 3.0 (MIT; onnx-community, 1.5 MB) hears, 10 seconds at a time, where up to three voices
     speak — the turns, but with names that only hold inside those 10 seconds;
   - Wespeaker ResNet34 (Apache-2.0; 26.5 MB) turns each voice's speech into a voiceprint (256 numbers), so the page can
     tell which turns across the whole recording are the same person (see clusterVoice in transcript-core.js).
   Both download once on first use and are kept (pyannote by transformers.js's cache, Wespeaker in 'mixtape-speaker-v1').
   In:  { audio: Float32Array (16 kHz mono), offset, keepFrom, keepTo }
   Out: { type: 'speakers', turns: [{ s, e, g }], prints: [Float32Array] } (g indexes prints; -1 = too short to tell),
        { type: 'load', what, loaded, total }, or { type: 'error', message }. */
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
const WESPEAKER = 'https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34/resolve/main/voxceleb_resnet34.onnx';
const SR = 16000;
let seg = null, proc = null, spk = null, ort = null;

async function ready() {
  if (!seg) {
    const TF = await import(TRANSFORMERS); TF.env.allowLocalModels = false;
    proc = await TF.AutoProcessor.from_pretrained('onnx-community/pyannote-segmentation-3.0');
    seg = await TF.AutoModelForAudioFrameClassification.from_pretrained('onnx-community/pyannote-segmentation-3.0', { dtype: 'q8', device: 'wasm', progress_callback: p => { if (p.status === 'progress') self.postMessage({ type: 'load', what: 'speaker turns', loaded: p.loaded, total: p.total }); } });
  }
  if (!spk) {
    ort = await import(ORT + 'ort.wasm.bundle.min.mjs'); ort.env.wasm.wasmPaths = ORT;
    const cache = await caches.open('mixtape-speaker-v1'); let res = await cache.match(WESPEAKER);
    if (!res) { const r = await fetch(WESPEAKER); if (!r.ok) throw new Error(`the voiceprint model could not be fetched (${r.status})`); const total = +r.headers.get('content-length') || 26.5e6, reader = r.body.getReader(), parts = []; let got = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; self.postMessage({ type: 'load', what: 'voiceprints', loaded: got, total }); } const blob = new Blob(parts); await cache.put(WESPEAKER, new Response(blob)); res = new Response(blob); }
    spk = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
  }
}

/* Kaldi-style 80-band log-mel filterbank (25 ms frames every 10 ms, Hamming, pre-emphasis 0.97, DC removed, samples at
   16-bit scale), mean-normalised: what Wespeaker was trained on. */
const NFFT = 512, NB = 80, FL = 400, HOP = 160;
let melBins = null, win = null;
function fbank(x) {
  const nf = Math.floor((x.length - FL) / HOP) + 1; if (nf < 10) return null;
  if (!melBins) {
    const mel = f => 1127 * Math.log(1 + f / 700), lo = mel(20), hi = mel(SR / 2); melBins = [];
    for (let m = 0; m < NB; m++) { const l = lo + (hi - lo) * m / (NB + 1), c = lo + (hi - lo) * (m + 1) / (NB + 1), r = lo + (hi - lo) * (m + 2) / (NB + 1), w = new Float32Array(NFFT / 2 + 1); for (let k = 0; k <= NFFT / 2; k++) { const mk = mel(k * SR / NFFT); w[k] = mk > l && mk < r ? (mk <= c ? (mk - l) / (c - l) : (r - mk) / (r - c)) : 0; } melBins.push(w); }
    win = new Float32Array(FL); for (let i = 0; i < FL; i++) win[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FL - 1));
  }
  const out = new Float32Array(nf * NB), re = new Float32Array(NFFT), im = new Float32Array(NFFT), pw = new Float32Array(NFFT / 2 + 1);
  for (let f = 0; f < nf; f++) {
    re.fill(0); im.fill(0); let mean = 0; const o = f * HOP; for (let i = 0; i < FL; i++) mean += x[o + i]; mean /= FL;
    for (let i = 0; i < FL; i++) { const v = (x[o + i] - mean) * 32768, pv = i ? (x[o + i - 1] - mean) * 32768 : v; re[i] = (v - 0.97 * pv) * win[i]; }
    fft(re, im); for (let k = 0; k <= NFFT / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < NB; m++) { let e = 0; const w = melBins[m]; for (let k = 0; k <= NFFT / 2; k++) if (w[k]) e += w[k] * pw[k]; out[f * NB + m] = Math.log(Math.max(e, 1.19e-7)); }
  }
  for (let m = 0; m < NB; m++) { let s = 0; for (let f = 0; f < nf; f++) s += out[f * NB + m]; s /= nf; for (let f = 0; f < nf; f++) out[f * NB + m] -= s; }
  return { data: out, frames: nf };
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, h = len >> 1; for (let i = 0; i < n; i += len) for (let k = 0; k < h; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), p = i + k + h, xr = re[p] * c - im[p] * s, xi = re[p] * s + im[p] * c; re[p] = re[i + k] - xr; im[p] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi; } }
}

self.onmessage = async e => {
  const { audio, offset, keepFrom, keepTo } = e.data;
  try {
    await ready();
    const turns = [], prints = [];
    for (let w0 = 0; w0 * SR < audio.length; w0 += 10) {
      const piece = audio.subarray(w0 * SR, Math.min(audio.length, (w0 + 10) * SR)); if (piece.length < SR) break;
      const { logits } = await seg(await proc(piece)); const segs = proc.post_process_speaker_diarization(logits, piece.length)[0];
      // local speakers 1-3 (4-6 are two at once: left out; 0 is nobody)
      const byLocal = new Map();
      for (const s of segs) { if (s.id < 1 || s.id > 3 || s.end - s.start < 0.2) continue; const t = { s: +(offset + w0 + s.start).toFixed(2), e: +(offset + w0 + s.end).toFixed(2), local: s.id, a: Math.floor(s.start * SR), b: Math.floor(s.end * SR) }; if (t.e <= keepFrom || t.s >= keepTo) continue; (byLocal.get(s.id) || byLocal.set(s.id, []).get(s.id)).push(t); }
      for (const ts of byLocal.values()) {
        // up to 3 seconds of this voice's speech make its voiceprint
        let len = 0; const parts = []; for (const t of ts) { if (len >= 3 * SR) break; const p = piece.subarray(t.a, Math.min(t.b, t.a + 3 * SR - len)); parts.push(p); len += p.length; }
        let g = -1;
        if (len >= 0.8 * SR) { const x = new Float32Array(len); let o = 0; for (const p of parts) { x.set(p, o); o += p.length; } const fb = fbank(x); if (fb) { const r = await spk.run({ feats: new ort.Tensor('float32', fb.data, [1, fb.frames, NB]) }); prints.push(Float32Array.from(r.embs.data)); g = prints.length - 1; } }
        for (const t of ts) turns.push({ s: Math.max(t.s, keepFrom), e: Math.min(t.e, keepTo), g });
      }
    }
    turns.sort((a, b) => a.s - b.s);
    self.postMessage({ type: 'speakers', turns, prints });
  } catch (err) { self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) }); }
};
