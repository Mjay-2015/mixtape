/* Sound formats no browser reads: WMA (all five kinds), AMR voice notes, AC3/E-AC3 and AIFF. They are decoded here, in
   the browser, by ffmpeg's own decoders compiled to WebAssembly (libav.js, LGPL-2.1, in vendor/libav/, fetched only the
   first time one is opened). The sound comes out as a 24-bit WAV, which the Cutter then opens like any other file.
   Nothing leaves the computer. WMV video is not handled here (only its sound would survive): it still goes through
   "Convert for Cutter". */
const OLD_EXT = /\.(wma|amr|awb|3ga|ac3|eac3|ec3|aif|aiff|aifc)$/i; // not .asf: it may hold video, which would be lost
export const isOldAudio = f => OLD_EXT.test(f.name || '') || /x-ms-wma|audio\/(amr|ac3|eac3|aiff|x-aiff)/i.test(f.type || '');

let libavP = null;
const libav = () => (libavP ||= import('../vendor/libav/libav-6.10.9.0-cutter-oldaudio.mjs').then(m => m.default.LibAV({ noworker: true })));

/* one 24-bit little-endian sample per value, interleaved, from a frame in any of ffmpeg's sample formats */
const FMT = { 0: 'u8', 1: 's16', 2: 's32', 3: 'flt', 4: 'dbl', 5: 'u8', 6: 's16', 7: 's32', 8: 'flt', 9: 'dbl' }; // 5..9 are the planar ones
const SCALE = { u8: v => (v - 128) / 128, s16: v => v / 32768, s32: v => v / 2147483648, flt: v => v, dbl: v => v };
function to24(frame, from = 0) {
  const ch = frame.channels, n = frame.nb_samples, kind = FMT[frame.format];
  if (!kind) throw new Error(`an unusual sample format (${frame.format})`);
  const sc = SCALE[kind], planar = frame.format >= 5, out = new Uint8Array((n - from) * ch * 3);
  let o = 0;
  for (let i = from; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = planar ? frame.data[c][i] : frame.data[i * ch + c];
    let s = Math.round(Math.max(-1, Math.min(1, sc(v))) * 8388607);
    out[o++] = s & 255; out[o++] = (s >> 8) & 255; out[o++] = (s >> 16) & 255;
  }
  return out;
}
function wavHeader(rate, ch, bytes) {
  const h = new DataView(new ArrayBuffer(44)), w = (o, s) => [...s].forEach((c, k) => h.setUint8(o + k, c.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); w(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * 3, true); h.setUint16(32, ch * 3, true); h.setUint16(34, 24, true); w(36, 'data'); h.setUint32(40, bytes, true);
  return h.buffer;
}

/* file → a WAV File named "<name> (from WMA).wav", keeping the original's date so its saved parts still match */
export async function decodeOld(file, onProgress = () => {}) {
  const av = await libav(), name = `in${Date.now()}`, kind = (file.name.match(/\.([a-z0-9]+)$/i) || [, 'audio'])[1].toUpperCase();
  await av.mkreadaheadfile(name, file);
  let fmt = 0, c = 0, pkt = 0, frame = 0;
  try {
    let streams; try { [fmt, streams] = await av.ff_init_demuxer_file(name); } catch (e) { throw new Error(`“${file.name}” could not be read as ${kind}.`); }
    const s = streams.find(x => x.codec_type === av.AVMEDIA_TYPE_AUDIO); if (!s) throw new Error(`No sound was found in “${file.name}”.`);
    [, c, pkt, frame] = await av.ff_init_decoder(s.codec_id, { codecpar: s.codecpar });
    const parts = []; let bytes = 0, rate = 0, chans = 0, done = false, got = 0, skipped = 0;
    while (!done) {
      const [res, packets] = await av.ff_read_frame_multi(fmt, pkt, { limit: 1 << 20 });
      done = res === av.AVERROR_EOF;
      if (res !== 0 && !done && res !== -av.EAGAIN) throw new Error(`“${file.name}” stopped making sense partway (error ${res}).`);
      // a damaged stretch: the batch fails as a whole, so it is decoded again packet by packet, skipping only the bad ones
      const batch = packets[s.index] || []; let frames;
      try { frames = await av.ff_decode_multi(c, pkt, frame, batch, { ignoreErrors: true }); }
      catch (e) { frames = []; for (const p of batch) { try { frames.push(...await av.ff_decode_multi(c, pkt, frame, [p], { ignoreErrors: true })); } catch (e2) { skipped++; } } }
      if (done) { try { frames.push(...await av.ff_decode_multi(c, pkt, frame, [], { fin: true, ignoreErrors: true })); } catch (e) {} } // the decoder's last few samples
      for (const f of frames) {
        if (!rate) { rate = f.sample_rate; chans = f.channels; }
        if (f.sample_rate !== rate || f.channels !== chans) continue; // a stream that changes shape midway: keep the first shape
        // each block goes where its timestamp says, so the WAV keeps the original's timeline to the sample: WMA's first
        // block, for one, is stamped ~0.1 s in (the decoder's warm-up), and ffmpeg and every player honour that
        // — but only the first block and real gaps: WMA's stamps are rounded to the millisecond (blocks of exactly 2048
        // samples come stamped 2073, 2029… apart), and following that jitter chopped the sound. Within 30 ms, blocks
        // simply follow on, as decoded.
        let from = 0;
        if (f.ptshi !== -2147483648) { // a real timestamp (not "none")
          const at = Math.round((f.pts + f.ptshi * 4294967296) * f.time_base_num * rate / f.time_base_den), gap = at - got, slack = Math.round(rate * 0.03);
          if (gap > (got ? slack : 0) && gap < rate * 5) { const z = new Uint8Array(gap * chans * 3); parts.push(z); bytes += z.length; got += gap; } // silence where nothing was
          else if (gap < -slack) { if (-gap >= f.nb_samples) continue; from = -gap; } // overlaps what is already there: the overlap is dropped
        }
        const b = to24(f, from); parts.push(b); bytes += b.length; got += f.nb_samples - from;
      }
      onProgress(got / (rate || 1));
      if (bytes > 4e9) throw new Error(`“${file.name}” is too long to unpack in the browser (over about 4 hours). Use “Convert for Cutter”.`);
    }
    if (!bytes) throw new Error(`No sound could be decoded from “${file.name}”.`);
    const base = file.name.replace(/\.[^.]+$/, '');
    const out = new File([wavHeader(rate, chans, bytes), ...parts], `${base} (from ${kind}).wav`, { type: 'audio/wav', lastModified: file.lastModified });
    out.skipped = skipped; // damaged packets passed over (each a few milliseconds)
    return out;
  } finally {
    try { if (c) await av.ff_free_decoder(c, pkt, frame); if (fmt) await av.avformat_close_input_js(fmt); await av.unlink(name); } catch (e) {}
  }
}
