/* Hears a song and returns the words it hears, each with its time: what Mixtape uses to time lyrics.
   Whisper base.en (MIT, OpenAI; the ONNX export with word timings by onnx-community), run by transformers.js 4.3.1
   (Apache-2.0) over ONNX Runtime Web (MIT). The library is fetched from jsDelivr at that exact version the first time
   (it is not kept in this repository: GitHub's secret scanner mistakes one of its model names for an API key) and the
   service worker keeps it for offline use; the model (~77 MB) downloads from Hugging Face once and stays in the
   browser's cache.

   In:  { audio: Float32Array (mono, 16 kHz) }
   Out: { type: 'load', file, loaded, total } while the model downloads; { type: 'progress', done } (0..1) while listening;
        { type: 'done', words: [{ text, start, end }] }; or { type: 'error', message }. */
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const lib = import(TRANSFORMERS); // started now, awaited in the handler (so the first message is never missed); its ONNX Runtime files come from jsDelivr too, at the version it pins
const MODEL = 'onnx-community/whisper-base.en_timestamped';
const SR = 16000, WIN = 30, STEP = 25; // 30-second windows, 5 seconds of overlap so no word is cut in half
let asr = null;

self.onmessage = async e => {
  const audio = e.data.audio;
  try {
    const { pipeline, env } = await lib; env.allowLocalModels = false;
    if (!asr) asr = await pipeline('automatic-speech-recognition', MODEL, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm',
      progress_callback: p => { if (p.status === 'progress') self.postMessage({ type: 'load', file: p.file, loaded: p.loaded, total: p.total }); },
    });
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
