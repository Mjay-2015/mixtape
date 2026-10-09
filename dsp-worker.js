// Mixtape Studio background worker: beat, tempo and key detection, and
// time-stretching (change speed without changing pitch). Runs off the main
// thread so the Studio stays responsive. No outside code.
'use strict';

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'analyze') self.postMessage({ id: m.id, ok: true, result: analyze(m.mono, m.sr) });
    else if (m.type === 'stretch') {
      const chs = stretch(m.chs, m.sr, m.factor);
      self.postMessage({ id: m.id, ok: true, result: { chs } }, chs.map(c => c.buffer));
    } else throw new Error('Unknown job ' + m.type);
  } catch (err) { self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) }); }
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hann = n => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function downsample(x, sr, target) {
  const f = Math.max(1, Math.round(sr / target)), n = Math.floor(x.length / f), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < f; j++) s += x[i * f + j]; y[i] = s / f; }
  return { y, sr: sr / f };
}

const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db || 1);
}

function analyze(mono, sr) {
  const { y, sr: ds } = downsample(mono, sr, 11025);

  // Loudness (RMS of the whole song, dBFS)
  let ss = 0; for (let i = 0; i < y.length; i++) ss += y[i] * y[i];
  const loud = 10 * Math.log10(ss / Math.max(1, y.length) + 1e-12);

  // Onset strength: spectral flux on short frames
  const N = 512, H = 128, win = hann(N), frames = Math.max(0, Math.floor((y.length - N) / H)), fps = ds / H;
  const flux = new Float32Array(frames), prev = new Float32Array(N / 2), re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = y[f * H + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let s = 0;
    for (let k = 1; k < N / 2; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); const d = m - prev[k]; if (d > 0) s += d; prev[k] = m; }
    flux[f] = s;
  }
  const on = new Float32Array(frames), ps = new Float64Array(frames + 1), w = Math.round(fps * 0.4);
  for (let i = 0; i < frames; i++) ps[i + 1] = ps[i] + flux[i];
  for (let i = 0; i < frames; i++) { const a = Math.max(0, i - w), b = Math.min(frames, i + w + 1); on[i] = Math.max(0, flux[i] - (ps[b] - ps[a]) / (b - a)); }

  // Tempo: autocorrelation of the onset strength, weighted toward common tempos
  let bpm = 0, offset = 0, conf = 0;
  if (frames > fps * 4) {
    const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 55);
    const ac = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) { let s = 0; for (let i = 0; i + lag < frames; i++) s += on[i] * on[i + lag]; ac[lag] = s / (frames - lag); }
    let best = -1, bestLag = minLag, sum = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const b = 60 * fps / lag, wgt = Math.exp(-0.5 * (Math.log2(b / 120) / 0.9) ** 2), v = ac[lag] * wgt; sum += ac[lag];
      if (v > best) { best = v; bestLag = lag; }
    }
    const a0 = ac[bestLag - 1], a1 = ac[bestLag], a2 = ac[bestLag + 1], den = a0 - 2 * a1 + a2;
    const lagF = bestLag + (den ? clamp(0.5 * (a0 - a2) / den, -0.5, 0.5) : 0);
    bpm = 60 * fps / lagF; while (bpm < 70) bpm *= 2; while (bpm > 180) bpm /= 2;
    let e0 = 0; for (let i = 0; i < frames; i++) e0 += on[i] * on[i]; e0 /= frames;
    conf = e0 > 0 ? ac[bestLag] / e0 : 0; // how strongly the music repeats at this beat (0 = not at all, 1 = perfectly)
    // Beat phase: which offset lines up with the strongest onsets
    const period = 60 * fps / bpm; let bestS = -1, bestPh = 0;
    for (let ph = 0; ph < period; ph += 0.5) { let s = 0; for (let t = ph; t < frames; t += period) s += on[Math.round(t)] || 0; if (s > bestS) { bestS = s; bestPh = ph; } }
    offset = ((bestPh * H + N / 2) / ds) % (60 / bpm);
    if (conf < 0.08) { bpm = 0; offset = 0; } // no steady beat: don't invent a tempo
  }

  // Key: chroma profile matched against major and minor key templates
  const N2 = 4096, H2 = 2048, w2 = hann(N2), re2 = new Float64Array(N2), im2 = new Float64Array(N2), chroma = new Float64Array(12);
  const pcOf = new Int8Array(N2 / 2).fill(-1);
  for (let k = 1; k < N2 / 2; k++) { const f = k * ds / N2; if (f >= 60 && f <= 2500) pcOf[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12; }
  for (let s = 0; s + N2 <= y.length; s += H2) {
    for (let i = 0; i < N2; i++) { re2[i] = y[s + i] * w2[i]; im2[i] = 0; }
    fft(re2, im2);
    for (let k = 1; k < N2 / 2; k++) if (pcOf[k] >= 0) chroma[pcOf[k]] += Math.sqrt(Math.hypot(re2[k], im2[k]));
  }
  let bestK = 0, bestMode = 'major', bestC = -2;
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
    const cM = corr(rot, MAJOR), cm = corr(rot, MINOR);
    if (cM > bestC) { bestC = cM; bestK = t; bestMode = 'major'; }
    if (cm > bestC) { bestC = cm; bestK = t; bestMode = 'minor'; }
  }

  // Drums, speech or noise have no clear key: say so rather than guess.
  const clear = bestC >= 0.6;
  return { bpm: Math.round(bpm * 10) / 10, offset, conf, key: clear ? bestK : null, mode: clear ? bestMode : null,
    keyName: clear ? `${KEYS[bestK]} ${bestMode}` : 'no clear key', keyConf: bestC, loud };
}

// WSOLA time-stretch: output length = input length × factor, pitch unchanged.
function stretch(chs, sr, factor) {
  if (Math.abs(factor - 1) < 1e-4) return chs.map(c => c.slice());
  const len = chs[0].length, N = 2 * Math.round(sr * 0.023), Hs = N / 2, Ha = Hs / factor, tol = Math.round(sr * 0.012), D = 4;
  const outLen = Math.ceil(len * factor), out = chs.map(() => new Float32Array(outLen + N)), wsum = new Float32Array(outLen + N), win = hann(N);
  const mono = new Float32Array(Math.ceil(len / D));
  for (let i = 0; i < mono.length; i++) { let v = 0; for (const c of chs) v += c[i * D] || 0; mono[i] = v; }
  const L = Math.floor(Hs / D);
  let prevIn = 0;
  for (let m = 0; m * Hs < outLen; m++) {
    const ideal = Math.round(m * Ha);
    let pos = Math.min(ideal, Math.max(0, len - N));
    const natural = prevIn + Hs;
    if (m > 0 && natural + Hs < len) {
      const n0 = Math.floor(natural / D); let best = -Infinity;
      for (let d = -tol; d <= tol; d += D) {
        const p = ideal + d; if (p < 0 || p + N > len) continue;
        const p0 = Math.floor(p / D); let s = 0, e = 0;
        for (let i = 0; i < L; i++) { const v = mono[p0 + i]; s += mono[n0 + i] * v; e += v * v; }
        const score = s / Math.sqrt(e + 1e-9);
        if (score > best) { best = score; pos = p; }
      }
    }
    const o = m * Hs;
    for (let c = 0; c < chs.length; c++) { const src = chs[c], dst = out[c]; for (let i = 0; i < N; i++) dst[o + i] += (src[pos + i] || 0) * win[i]; }
    for (let i = 0; i < N; i++) wsum[o + i] += win[i];
    prevIn = pos;
  }
  for (let c = 0; c < out.length; c++) { const d = out[c]; for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-3) d[i] /= wsum[i]; }
  return out.map(o => o.slice(0, outLen));
}
