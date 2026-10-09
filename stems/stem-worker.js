// Mixtape stem splitter: separates a song into vocals, drums, bass and other
// instruments with Meta's Demucs (htdemucs) model, entirely on this device.
// Runtime: ONNX Runtime Web 1.21.0 (MIT). Pipeline: timcsy/demucs-web (MIT).
// See stems/README.md for sources, versions and fingerprints.
import * as ort from './ort/ort.webgpu.min.mjs';
import { DemucsProcessor } from './demucs/processor.js';

const MODEL = {
  parts: ['model/htdemucs.part1', 'model/htdemucs.part2'],
  bytes: 180534758,
  sha256: 'e5e425c17683f163a472462eb5f5a4ffcd11c31858d57fbd0833b012d8b88077',
  cache: 'mixtape-stems-model-v1',
};
const here = p => new URL(p, import.meta.url).href;
const send = (msg, transfer) => self.postMessage(msg, transfer || []);
let processor = null, backend = null;

async function hex(buf) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join(''); }

async function fetchModel() {
  const cache = await caches.open(MODEL.cache);
  const all = new Uint8Array(MODEL.bytes);
  let offset = 0, fromCache = true;
  for (const p of MODEL.parts) {
    const url = here(p);
    let res = await cache.match(url), bytes;
    if (res) bytes = new Uint8Array(await res.arrayBuffer());
    else {
      fromCache = false;
      res = await fetch(url);
      if (!res.ok) throw new Error(`Could not download the AI model (${res.status}). Check your internet connection and try again.`);
      const reader = res.body.getReader(), chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        chunks.push(value); got += value.length;
        send({ type: 'progress', stage: 'download', done: offset + got, total: MODEL.bytes });
      }
      bytes = new Uint8Array(got); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    }
    if (offset + bytes.length > MODEL.bytes) throw new Error('The AI model download is the wrong size.');
    all.set(bytes, offset); offset += bytes.length;
    if (!fromCache) await cache.put(url, new Response(bytes));
  }
  if (offset !== MODEL.bytes || (await hex(all.buffer)) !== MODEL.sha256) {
    await caches.delete(MODEL.cache);
    throw new Error('The AI model did not download correctly (its fingerprint does not match). Try again.');
  }
  return all.buffer;
}

async function load() {
  if (processor) return;
  let gpu = false;
  try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })); } catch (e) {}
  backend = gpu ? 'webgpu' : 'wasm';
  ort.env.wasm.wasmPaths = here('ort/');
  ort.env.wasm.numThreads = 1;      // the site can't enable multi-threading on GitHub Pages
  ort.env.wasm.proxy = false;
  if (gpu) { ort.env.webgpu = ort.env.webgpu || {}; ort.env.webgpu.powerPreference = 'high-performance'; }
  const model = await fetchModel();
  send({ type: 'progress', stage: 'load', backend });
  processor = new DemucsProcessor({
    ort,
    sessionOptions: { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'basic' },
    onProgress: p => send({ type: 'progress', stage: 'separate', done: p.currentSegment, total: p.totalSegments, backend }),
  });
  await processor.loadModel(model);
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'status') {
      const cache = await caches.open(MODEL.cache);
      const have = await Promise.all(MODEL.parts.map(p => cache.match(here(p))));
      return send({ type: 'status', modelSaved: have.every(Boolean), gpu: !!navigator.gpu });
    }
    if (m.type === 'split') {
      await load();
      const t0 = performance.now();
      const out = await processor.separate(m.left, m.right);
      const stems = {}, transfer = [];
      for (const k of ['vocals', 'drums', 'bass', 'other']) { stems[k] = { left: out[k].left, right: out[k].right }; transfer.push(out[k].left.buffer, out[k].right.buffer); }
      send({ type: 'done', stems, backend, seconds: (performance.now() - t0) / 1000 }, transfer);
    }
  } catch (err) {
    send({ type: 'error', message: (err && err.message) || String(err) });
  }
};
