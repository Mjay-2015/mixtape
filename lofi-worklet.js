// Mixtape lo-fi: fewer bits and a lower sample rate, like an old sampler. No outside code.
// Runs on the audio thread; the Studio's "Lo-fi" effect loads it into each audio context it plays or saves with.
class MixtapeLofi extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 2, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 11025, minValue: 1000, maxValue: 48000, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.ph = [1, 1]; this.h = [0, 0]; this.done = false;
    this.port.onmessage = e => { if (e.data === 'end') this.done = true; }; // playback stopped: let the node go
  }
  process(inputs, outputs, p) {
    if (this.done) return false;
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) { for (const o of out) o.fill(0); return true; }
    const steps = Math.pow(2, Math.round(p.bits[0]) - 1), inc = Math.min(1, p.rate[0] / sampleRate);
    for (let c = 0; c < out.length; c++) {
      const x = inp[c] || inp[0], o = out[c]; let ph = this.ph[c] ?? 1, h = this.h[c] ?? 0;
      // hold each sample until the slower clock ticks again, rounded to the coarser bit depth
      for (let i = 0; i < o.length; i++) { ph += inc; if (ph >= 1) { ph -= 1; h = Math.round(x[i] * steps) / steps; } o[i] = h; }
      this.ph[c] = ph; this.h[c] = h;
    }
    return true;
  }
}
registerProcessor('mixtape-lofi', MixtapeLofi);
