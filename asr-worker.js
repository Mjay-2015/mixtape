/* Hears speech or singing and returns the words, each with its time: Mixtape's lyrics, transcripts and read-along.
   Whisper base.en (MIT, OpenAI; the ONNX export with word timings by onnx-community), run by transformers.js 4.3.1
   (Apache-2.0) over ONNX Runtime Web (MIT). The library is fetched from jsDelivr at that exact version the first time
   (it is not kept in this repository: GitHub's secret scanner mistakes one of its model names for an API key) and the
   service worker keeps it for offline use; the model (~77 MB) downloads from Hugging Face once and stays in the
   browser's cache.

   In:  { audio: Float32Array (mono, 16 kHz) } — a whole song, heard in 30-second windows here; or
        { window: true, audio, offset, keepFrom, keepTo } — one window of a long recording, cut by the page (so hours of
        audio never sit in memory): words are returned with `offset` added, kept when keepFrom <= start < keepTo
   Out: { type: 'load', file, loaded, total } while the model downloads; { type: 'progress', done } (0..1) while listening;
        { type: 'done', words: [{ text, start, end }] }; or { type: 'error', message }. */
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const lib = import(TRANSFORMERS); // started now, awaited in the handler (so the first message is never missed); its ONNX Runtime files come from jsDelivr too, at the version it pins
const MODEL = 'onnx-community/whisper-base.en_timestamped';
const SR = 16000, WIN = 30, STEP = 25; // 30-second windows, 5 seconds of overlap so no word is cut in half
let asr = null;

async function ready() {
  const { pipeline, env } = await lib; env.allowLocalModels = false;
  if (!asr) asr = await pipeline('automatic-speech-recognition', MODEL, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm',
    progress_callback: p => { if (p.status === 'progress') self.postMessage({ type: 'load', file: p.file, loaded: p.loaded, total: p.total }); },
  });
  return asr;
}
/* How sure Whisper was of each word: a logits processor that sees every step's scores, so when the next step shows
   which token was chosen, that token's probability is kept. A word's confidence is its least sure token. */
let Capture = null;
async function capture() {
  if (Capture) return new Capture();
  const { LogitsProcessor } = await lib;
  Capture = class extends LogitsProcessor {
    constructor() { super(); this.prev = null; this.got = []; }
    _call(input_ids, logits) {
      const ids = input_ids[0], d = logits[0].data, n = Math.min(d.length, TS_BEGIN);
      if (this.prev) { const last = Number(ids[ids.length - 1]); if (last < n) this.got.push([last, this.prev[last]]); }
      let mx = -Infinity; for (let i = 0; i < n; i++) if (d[i] > mx) mx = d[i];
      const p = this.prev && this.prev.length === n ? this.prev : new Float32Array(n); let sum = 0;
      for (let i = 0; i < n; i++) { const v = Math.exp(d[i] - mx); p[i] = v; sum += v; } for (let i = 0; i < n; i++) p[i] /= sum;
      this.prev = p; return logits;
    }
  };
  return new Capture();
}
const TS_BEGIN = 50363, EOT = 50256, SOT = 50257, PREV = 50360;
/* A short prompt of fillers tells Whisper the speech is verbatim, so "um", "uh" and false starts ("we, we") are written
   down instead of tidied away; the clean view can hide them again. */
const FILLER_PROMPT = ' Um, uh, well, so, I mean, like, you know, hmm.';
let promptIds = null;
/* the words' confidences, from the captured tokens: a token starting with a space starts a new word */
function confidences(r, got) {
  const words = []; let cur = null;
  for (const [id, p] of got) { if (id >= EOT) continue; const t = r.tokenizer.decode([id]); if (!cur || /^\s/.test(t)) { cur = { text: t.trim(), p }; words.push(cur); } else { cur.text += t; cur.p = Math.min(cur.p, p); } }
  return words;
}
self.onmessage = async e => {
  const audio = e.data.audio;
  if (e.data.window) { // one window of a long recording
    try {
      const r = await ready(), cap = await capture(), { LogitsProcessorList } = await lib, lp = new LogitsProcessorList(); lp.push(cap);
      const opts = { return_timestamps: 'word', logits_processor: lp };
      if (e.data.verbatim !== false) { promptIds ||= r.tokenizer.encode(FILLER_PROMPT, { add_special_tokens: false }); opts.decoder_input_ids = [PREV, ...promptIds, SOT]; }
      const out = await r(audio, opts), o = e.data.offset, words = [], conf = confidences(r, cap.got);
      // match the confidences to the pipeline's words in order (they are the same words, joined the same way)
      let ci = 0; const norm = s => s.toLowerCase().replace(/[^a-z0-9']/g, '');
      for (const c of out.chunks || []) {
        const s = o + (c.timestamp[0] ?? 0), en = o + (c.timestamp[1] ?? c.timestamp[0] ?? 0), text = String(c.text || '').trim();
        let k = ci; while (k < conf.length && k < ci + 3 && norm(conf[k].text) !== norm(text)) k++;
        const cw = k < conf.length && norm(conf[k].text) === norm(text) ? conf[k] : null; if (cw) ci = k + 1;
        if (text && s >= e.data.keepFrom && s < e.data.keepTo) words.push({ text, start: +s.toFixed(3), end: +Math.max(s, en).toFixed(3), ...(cw ? { c: +cw.p.toFixed(3) } : {}) });
      }
      self.postMessage({ type: 'window', words, offset: o });
    } catch (err) { self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) }); }
    return;
  }
  try {
    await ready();
    const dur = audio.length / SR, words = [];
    for (let w0 = 0; w0 < dur; w0 += STEP) {
      const piece = audio.subarray(Math.floor(w0 * SR), Math.min(audio.length, Math.floor((w0 + WIN) * SR)));
      if (piece.length < SR * 0.5) break;
      const out = await asr(piece, { return_timestamps: 'word' });
      // keep this window's words up to the middle of the overlap with the next window; the next one takes the rest
      const from = w0 === 0 ? -1 : w0 + (WIN - STEP) / 2, upto = w0 + STEP + (WIN - STEP) / 2;
      for (const c of out.chunks || []) {
        const s = w0 + (c.timestamp[0] ?? 0), en = w0 + (c.timestamp[1] ?? c.timestamp[0] ?? 0), text = String(c.text || '').trim();
        if (!text || s < from || (w0 + WIN < dur && s >= upto)) continue;
        words.push({ text, start: +s.toFixed(3), end: +Math.max(s, en).toFixed(3) });
      }
      self.postMessage({ type: 'progress', done: Math.min(1, (w0 + WIN) / dur) });
      if (w0 + WIN >= dur) break;
    }
    self.postMessage({ type: 'done', words });
  } catch (err) { self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) }); }
};
