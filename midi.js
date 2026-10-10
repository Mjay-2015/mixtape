// Mixtape MIDI: read and write Standard MIDI Files, and a small set of built-in
// instruments made from the browser's own oscillators. The instruments are for
// writing and placing music; the production studio renders the finished sound
// with real sampled instruments. No outside code.
'use strict';
(function (root) {
  /* ---------- reading ---------- */
  function parse(buf) {
    const b = new Uint8Array(buf); let o = 0;
    const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); o += n; return s; };
    const u32 = () => { const v = (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0; o += 4; return v; };
    const u16 = () => { const v = b[o] << 8 | b[o + 1]; o += 2; return v; };
    const vlq = () => { let v = 0, c; do { c = b[o++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && o < b.length); return v; };
    if (str(4) !== 'MThd') throw new Error('This is not a MIDI file.');
    const hl = u32(), format = u16(), ntrk = u16(), div = u16(); o += hl - 6;
    if (div & 0x8000) throw new Error('This MIDI file counts time in SMPTE frames, which Mixtape does not read yet.');
    const ppq = div, tempos = [], tracks = [];
    for (let t = 0; t < ntrk && o < b.length; t++) {
      if (str(4) !== 'MTrk') throw new Error('The MIDI file is damaged (a track is missing its header).');
      const len = u32(), end = o + len; let tick = 0, status = 0;
      const tr = { name: '', notes: [], programs: {} }, open = new Map();
      while (o < end) {
        tick += vlq();
        let s = b[o];
        if (s & 0x80) { o++; if (s < 0xf0) status = s; } else s = status; // running status
        if (s === 0xff) {
          const type = b[o++], l = vlq(), at = o; o += l;
          if (type === 0x51 && l === 3) tempos.push({ tick, us: b[at] << 16 | b[at + 1] << 8 | b[at + 2] });
          else if (type === 0x03 && !tr.name) { let n = ''; for (let i = 0; i < l; i++) n += String.fromCharCode(b[at + i]); tr.name = n.trim(); }
          else if (type === 0x2f) break;
        } else if (s === 0xf0 || s === 0xf7) { o += vlq(); }
        else {
          const hi = s & 0xf0, ch = s & 0x0f, d1 = b[o++], d2 = (hi === 0xc0 || hi === 0xd0) ? 0 : b[o++];
          if (hi === 0x90 && d2 > 0) { const k = ch * 128 + d1; if (!open.has(k)) open.set(k, []); open.get(k).push({ tick, v: d2 }); }
          else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
            const k = ch * 128 + d1, q = open.get(k);
            if (q && q.length) { const n = q.shift(); tr.notes.push({ p: d1, tick: n.tick, dt: Math.max(1, tick - n.tick), v: n.v, ch }); }
          } else if (hi === 0xc0 && tr.programs[ch] == null) tr.programs[ch] = d1;
        }
      }
      for (const [k, q] of open) for (const n of q) tr.notes.push({ p: k % 128, tick: n.tick, dt: Math.max(1, tick - n.tick), v: n.v, ch: Math.floor(k / 128) });
      o = end; tracks.push(tr);
    }
    // ticks to seconds through the tempo map (shared by every track)
    tempos.sort((a, x) => a.tick - x.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
    const segs = []; let sec = 0;
    tempos.forEach((tp, i) => { if (i) sec += (tp.tick - tempos[i - 1].tick) / ppq * tempos[i - 1].us / 1e6; segs.push({ tick: tp.tick, sec, us: tp.us }); });
    const secAt = tick => { let s = segs[0]; for (const x of segs) if (x.tick <= tick) s = x; return s.sec + (tick - s.tick) / ppq * s.us / 1e6; };
    // one Mixtape track per MIDI channel in each file track (a type-0 file keeps every channel in one track)
    const out = [];
    for (const tr of tracks) {
      if (!tr.notes.length) continue;
      const byCh = new Map(); for (const n of tr.notes) { if (!byCh.has(n.ch)) byCh.set(n.ch, []); byCh.get(n.ch).push(n); }
      for (const [ch, ns] of byCh) {
        const program = tr.programs[ch] ?? null;
        const name = tr.name ? (byCh.size > 1 ? `${tr.name} (ch ${ch + 1})` : tr.name) : ch === 9 ? 'Drums' : `MIDI ${out.length + 1}`;
        out.push({ name, channel: ch, program, inst: ch === 9 ? 'drums' : instForProgram(program),
          notes: ns.map(n => { const t = secAt(n.tick); return { p: n.p, t, d: secAt(n.tick + n.dt) - t, v: n.v }; }).sort((a, x) => a.t - x.t) });
      }
    }
    return { ppq, format, tempos: segs.map(s => ({ sec: s.sec, bpm: Math.round(60e6 / s.us * 100) / 100 })), tracks: out };
  }

  /* ---------- writing ---------- */
  function write({ ppq = 480, tempos = [{ sec: 0, bpm: 120 }], tracks, tickAt }) {
    const bytes = [];
    const push = (...a) => bytes.push(...a);
    const u32 = v => push(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
    const vlq = v => { const s = [v & 0x7f]; while ((v >>= 7) > 0) s.unshift((v & 0x7f) | 0x80); push(...s); };
    const chunk = (id, body) => { push(...[...id].map(c => c.charCodeAt(0))); u32(body.length); push(...body); };
    const track = events => { // events: [{tick, data:[...]}]
      events.sort((a, b) => a.tick - b.tick || a.order - b.order);
      const out = []; let last = 0;
      const v = n => { const s = [n & 0x7f]; while ((n >>= 7) > 0) s.unshift((n & 0x7f) | 0x80); out.push(...s); };
      for (const e of events) { v(Math.max(0, e.tick - last)); last = Math.max(last, e.tick); out.push(...e.data); }
      v(0); out.push(0xff, 0x2f, 0x00); return out;
    };
    const hdr = []; const h = (...a) => hdr.push(...a);
    h(0, 1, (tracks.length + 1) >> 8, (tracks.length + 1) & 255, ppq >> 8, ppq & 255);
    chunk('MThd', hdr);
    const tempoEv = tempos.map(t => { const us = Math.round(60e6 / t.bpm); return { tick: tickAt(t.sec), order: 0, data: [0xff, 0x51, 3, us >> 16 & 255, us >> 8 & 255, us & 255] }; });
    chunk('MTrk', track([{ tick: 0, order: 0, data: [0xff, 0x58, 4, 4, 2, 24, 8] }, ...tempoEv]));
    for (const tr of tracks) {
      const ch = tr.channel & 15, name = [...(tr.name || '')].map(c => c.charCodeAt(0) & 0x7f).slice(0, 60), ev = [];
      ev.push({ tick: 0, order: 0, data: [0xff, 0x03, name.length, ...name] });
      if (ch !== 9) ev.push({ tick: 0, order: 1, data: [0xc0 | ch, (tr.program ?? 0) & 127] });
      for (const n of tr.notes) {
        const a = tickAt(n.t), z = Math.max(a + 1, tickAt(n.t + n.d)), p = Math.max(0, Math.min(127, Math.round(n.p))), vel = Math.max(1, Math.min(127, Math.round(n.v)));
        ev.push({ tick: a, order: 3, data: [0x90 | ch, p, vel] }, { tick: z, order: 2, data: [0x80 | ch, p, 0] });
      }
      chunk('MTrk', track(ev));
    }
    void vlq;
    return new Uint8Array(bytes);
  }

  /* ---------- instruments ---------- */
  const INSTRUMENTS = { piano: 'Piano', strings: 'Strings', pad: 'Warm pad', bass: 'Bass', pluck: 'Pluck / guitar', organ: 'Organ', brass: 'Brass', lead: 'Synth lead', drums: 'Drum kit' };
  const PROGRAM = { piano: 0, pluck: 24, organ: 16, bass: 33, strings: 48, brass: 61, lead: 80, pad: 89, drums: 0 };
  function instForProgram(p) {
    if (p == null) return 'piano';
    if (p < 8) return 'piano'; if (p < 16) return 'pluck'; if (p < 24) return 'organ'; if (p < 32) return 'pluck';
    if (p < 40) return 'bass'; if (p < 56) return 'strings'; if (p < 64) return 'brass'; if (p < 88) return 'lead';
    return 'pad';
  }
  const noiseCache = new WeakMap();
  function noise(ac) {
    let b = noiseCache.get(ac); if (b) return b;
    b = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ac, b); return b;
  }
  const hz = p => 440 * Math.pow(2, (p - 69) / 12);

  /** Play one note; returns the sources so playback can stop them. */
  function playNote(ac, dest, inst, p, when, d, v) {
    const vel = Math.max(0.05, Math.min(1, v / 127)), end = when + Math.max(0.02, d), f = hz(p), srcs = [];
    const osc = (type, freq, detune = 0) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune; srcs.push(o); return o; };
    const env = (attack, peak, decayTo, decay, release) => {
      const g = ac.createGain(); g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(peak, when + attack);
      if (decay) g.gain.setTargetAtTime(decayTo, when + attack, decay / 3);
      g.gain.setTargetAtTime(0.0001, end, release / 4);
      return g;
    };
    const lp = (freq, q = 0.7) => { const n = ac.createBiquadFilter(); n.type = 'lowpass'; n.frequency.value = freq; n.Q.value = q; return n; };
    const finish = (tail) => { const stopAt = end + tail; for (const s of srcs) { s.start(when); s.stop(stopAt); } return srcs; };
    if (inst === 'drums') return drum(ac, dest, p, when, vel, srcs);
    if (inst === 'piano') {
      const g = env(0.004, 0.45 * vel, 0.0001, 1.4 + (96 - p) / 40, 0.25), fl = lp(1200 + vel * 5000);
      const h = ac.createGain(); h.gain.value = 0.28;
      osc('triangle', f).connect(fl); osc('sine', f * 2).connect(h); h.connect(fl); fl.connect(g); g.connect(dest); return finish(0.4);
    }
    if (inst === 'strings' || inst === 'pad') {
      const pad = inst === 'pad', g = env(pad ? 0.6 : 0.18, (pad ? 0.16 : 0.2) * vel, (pad ? 0.14 : 0.17) * vel, 0.6, pad ? 1.2 : 0.4), fl = lp(pad ? 1300 : 2400);
      osc('sawtooth', f, -7).connect(fl); osc('sawtooth', f, 7).connect(fl);
      if (pad) { const s = ac.createGain(); s.gain.value = 0.5; osc('triangle', f / 2).connect(s); s.connect(fl); }
      fl.connect(g); g.connect(dest); return finish(pad ? 1.4 : 0.6);
    }
    if (inst === 'bass') {
      const g = env(0.005, 0.5 * vel, 0.32 * vel, 0.3, 0.08), fl = lp(500 + vel * 900, 1.2);
      osc('sawtooth', f).connect(fl); const s = ac.createGain(); s.gain.value = 0.6; osc('sine', f / 2).connect(s); s.connect(g);
      fl.connect(g); g.connect(dest); return finish(0.15);
    }
    if (inst === 'pluck') {
      const g = env(0.002, 0.42 * vel, 0.0001, 0.9, 0.1), fl = lp(6000, 1);
      fl.frequency.setValueAtTime(6000 * vel + 800, when); fl.frequency.setTargetAtTime(350, when + 0.01, 0.12);
      osc('sawtooth', f).connect(fl); fl.connect(g); g.connect(dest); return finish(0.2);
    }
    if (inst === 'organ') {
      const g = env(0.01, 0.22 * vel, 0.22 * vel, 0, 0.06);
      [[1, 0.5], [2, 0.3], [3, 0.18], [4, 0.1]].forEach(([m, a]) => { const h = ac.createGain(); h.gain.value = a; osc('sine', f * m).connect(h); h.connect(g); });
      g.connect(dest); return finish(0.1);
    }
    if (inst === 'brass') {
      const g = env(0.05, 0.3 * vel, 0.24 * vel, 0.3, 0.15), fl = lp(400, 1.5);
      fl.frequency.setValueAtTime(400, when); fl.frequency.linearRampToValueAtTime(1200 + 2400 * vel, when + 0.08);
      osc('sawtooth', f).connect(fl); osc('sawtooth', f, 5).connect(fl); fl.connect(g); g.connect(dest); return finish(0.25);
    }
    // lead
    const g = env(0.01, 0.22 * vel, 0.2 * vel, 0.2, 0.1), fl = lp(3200, 1);
    osc('square', f).connect(fl); osc('sawtooth', f, 9).connect(fl); fl.connect(g); g.connect(dest); return finish(0.15);
  }

  function drum(ac, dest, p, when, vel, srcs) {
    const n = (dur, type, freq, q = 1, peak = 0.6) => {
      const s = ac.createBufferSource(); s.buffer = noise(ac); const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ac.createGain(); g.gain.setValueAtTime(peak * vel, when); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      s.connect(f); f.connect(g); g.connect(dest); s.start(when); s.stop(when + dur + 0.02); srcs.push(s);
    };
    const tone = (f0, f1, dur, peak = 0.8, type = 'sine') => {
      const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f1, when + dur * 0.7);
      const g = ac.createGain(); g.gain.setValueAtTime(peak * vel, when); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      o.connect(g); g.connect(dest); o.start(when); o.stop(when + dur + 0.02); srcs.push(o);
    };
    if (p === 35 || p === 36) tone(150, 45, 0.4, 0.95);
    else if (p === 38 || p === 40) { n(0.2, 'bandpass', 1800, 0.8, 0.55); tone(200, 140, 0.12, 0.35, 'triangle'); }
    else if (p === 37) n(0.05, 'bandpass', 2500, 2, 0.5);
    else if (p === 39) { n(0.03, 'bandpass', 1200, 1, 0.5); n(0.15, 'bandpass', 1100, 1, 0.45); }
    else if (p === 42 || p === 44) n(0.05, 'highpass', 7500, 1, 0.35);
    else if (p === 46) n(0.35, 'highpass', 7000, 1, 0.3);
    else if ([41, 43, 45, 47, 48, 50].includes(p)) { const base = 70 + (p - 41) * 18; tone(base * 1.6, base, 0.35, 0.7); }
    else if ([49, 52, 55, 57].includes(p)) n(1.4, 'highpass', 4500, 0.7, 0.35);
    else if ([51, 53, 59].includes(p)) { n(0.6, 'highpass', 8000, 0.8, 0.22); tone(5200, 5000, 0.4, 0.04); }
    else n(0.08, 'bandpass', 3000, 1, 0.3);
    return srcs;
  }

  root.MixtapeMIDI = { parse, write, playNote, INSTRUMENTS, PROGRAM, instForProgram };
})(typeof self !== 'undefined' ? self : window);
