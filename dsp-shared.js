// Mixtape sound maths shared by the Studio page and its background worker.
// True peak (the level between samples, which is what streaming platforms
// check) and a look-ahead limiter that keeps the true peak under a ceiling.
// No outside code.
'use strict';
(function (root) {
  // 4x oversampling with a windowed-sinc interpolator: 12 neighbouring samples
  // per in-between point, Hann window. Accurate to well under 0.1 dB on music.
  const TAPS = 12, HALF = TAPS / 2, PHASES = [0.25, 0.5, 0.75];
  const KERNEL = PHASES.map(f => {
    const k = new Float64Array(TAPS);
    for (let j = 0; j < TAPS; j++) {
      const x = f - (j - HALF + 1);                       // distance from neighbour j
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * x / HALF);  // Hann over ±HALF samples
      k[j] = sinc * w;
    }
    const sum = k.reduce((a, b) => a + b, 0); for (let j = 0; j < TAPS; j++) k[j] /= sum;
    return k;
  });

  /** The highest absolute level reached at or just after each sample, across channels (4x oversampled). */
  function peakEnvelope(chs) {
    const n = chs[0].length, env = new Float32Array(n);
    for (const d of chs) {
      for (let i = 0; i < n; i++) {
        let p = Math.abs(d[i]);
        for (const k of KERNEL) {
          let v = 0;
          for (let j = 0; j < TAPS; j++) { const idx = i + j - HALF + 1; if (idx >= 0 && idx < n) v += d[idx] * k[j]; }
          const a = Math.abs(v); if (a > p) p = a;
        }
        if (p > env[i]) env[i] = p;
      }
    }
    return env;
  }

  const toDb = v => 20 * Math.log10(v + 1e-12);

  /** True peak in dBTP. */
  function truePeak(chs) {
    const env = peakEnvelope(chs); let p = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > p) p = env[i];
    return Math.round(toDb(p) * 10) / 10;
  }

  /**
   * Turn the whole thing up or down by gainDb, then hold the true peak under
   * ceilingDb. Look-ahead: the gain starts coming down before a peak arrives,
   * so nothing clips and nothing clicks; it recovers over `releaseSec`.
   * Works in place on Float32Arrays and returns how much it had to pull down.
   */
  function limit(chs, sr, { gainDb = 0, ceilingDb = -1, lookaheadSec = 0.005, releaseSec = 0.12 } = {}) {
    const n = chs[0].length, g0 = Math.pow(10, gainDb / 20);
    if (g0 !== 1) for (const d of chs) for (let i = 0; i < n; i++) d[i] *= g0;
    let maxCut = 0;
    for (let pass = 0, ceil = ceilingDb; pass < 3; pass++) {
      const c = Math.pow(10, ceil / 20), env = peakEnvelope(chs);
      let over = false; for (let i = 0; i < n; i++) if (env[i] > c) { over = true; break; }
      if (!over) break;
      const L = Math.max(1, Math.round(lookaheadSec * sr));
      const need = new Float32Array(n); for (let i = 0; i < n; i++) need[i] = env[i] > c ? c / env[i] : 1;
      // gmin[m] = smallest gain needed anywhere in [m, m+L]  (sliding minimum)
      const gmin = new Float32Array(n), dq = new Int32Array(n); let h = 0, t = 0;
      for (let i = n - 1; i >= 0; i--) {
        while (t > h && need[dq[t - 1]] >= need[i]) t--;
        dq[t++] = i;
        while (dq[h] > i + L) h++;
        gmin[i] = need[dq[h]];
      }
      // average over the look-ahead window: every value averaged is already low enough for sample i
      const gain = new Float32Array(n); let acc = 0;
      for (let i = 0; i < n; i++) { acc += gmin[i]; if (i >= L + 1) acc -= gmin[i - L - 1]; gain[i] = acc / Math.min(i + 1, L + 1); }
      // release: recover slowly, never above what is needed
      const rc = 1 - Math.exp(-1 / (releaseSec * sr)); let gcur = 1;
      for (let i = 0; i < n; i++) { const up = gcur + (1 - gcur) * rc; gcur = Math.min(gain[i], up); gain[i] = gcur; if (1 - gcur > maxCut) maxCut = 1 - gcur; }
      for (const d of chs) for (let i = 0; i < n; i++) d[i] *= gain[i];
      ceil -= 0.1; // a second pass, slightly lower, catches what the gain change itself put between samples
    }
    return { gainDb, maxReductionDb: Math.round(-toDb(1 - maxCut) * 10) / 10 };
  }

  root.MixtapeDSP = { truePeak, limit, peakEnvelope };
})(typeof self !== 'undefined' ? self : window);
