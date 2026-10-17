/* H.264 parameter-set surgery, for the smart cut.

   A smart cut copies whole groups of frames byte for byte and re-encodes only the frames at the edges. Both kinds of
   slice must live in one video track, and H.264 slices name their parameter sets (SPS/PPS) by number; so each source's
   sets and the encoder's are renumbered apart and merged into one avcC, and slices whose set moved get the new number by
   bit-exact rewriting of their header. CABAC slice data must stay byte-aligned, so a moved PPS number's code is longer
   than the old one's by whole bytes (0 -> 15: 1 bit -> 9 bits). Carried over from Mixtape's cutter and the Cutting Room,
   where it was verified frame by frame. */
const bitAt = (b, i) => (b[i >> 3] >> (7 - (i & 7))) & 1;
function readUe(b, pos) { let z = 0; while (pos + z < b.length * 8 && bitAt(b, pos + z) === 0) z++; if (z > 31) throw new Error('bad Exp-Golomb'); let v = 0; for (let i = 0; i <= z; i++) v = (v << 1) | bitAt(b, pos + z + i); return { value: v - 1, len: 2 * z + 1 }; }
function ueBits(v) { const x = v + 1, len = 31 - Math.clz32(x), out = []; for (let i = 0; i < len; i++) out.push(0); for (let i = len; i >= 0; i--) out.push((x >> i) & 1); return out; }
function rewriteUe(b, pos, value) {
  const old = readUe(b, pos), nb = ueBits(value), total = b.length * 8, d = nb.length - old.len, out = new Uint8Array(Math.ceil((total + d) / 8));
  const set = (i, v) => { if (v) out[i >> 3] |= 0x80 >> (i & 7); };
  for (let i = 0; i < pos; i++) set(i, bitAt(b, i)); for (let i = 0; i < nb.length; i++) set(pos + i, nb[i]);
  for (let i = pos + old.len; i < total; i++) set(i + d, bitAt(b, i)); return out;
}
const rbspOf = e => { const o = []; for (let i = 0; i < e.length; i++) { if (i >= 2 && e[i] === 3 && e[i - 1] === 0 && e[i - 2] === 0 && (i + 1 >= e.length || e[i + 1] <= 3)) continue; o.push(e[i]); } return Uint8Array.from(o); };
const ebspOf = r => { const o = []; let z = 0; for (const x of r) { if (z >= 2 && x <= 3) { o.push(3); z = 0; } o.push(x); z = x === 0 ? z + 1 : 0; } return Uint8Array.from(o); };
export function nalus(data, lenSize) { const out = []; let i = 0; while (i + lenSize <= data.length) { let n = 0; for (let k = 0; k < lenSize; k++) n = (n << 8) | data[i + k]; i += lenSize; out.push(data.subarray(i, i + n)); i += n; } return out; }
export function joinNalus(list, lenSize) { const out = new Uint8Array(list.reduce((s, n) => s + lenSize + n.length, 0)); let o = 0; for (const n of list) { for (let k = lenSize - 1; k >= 0; k--) out[o++] = (n.length >>> (8 * k)) & 255; out.set(n, o); o += n.length; } return out; }
export function parseAvcC(d) { if (d[0] !== 1) throw new Error('not an avcC'); const lenSize = (d[4] & 3) + 1, sps = [], pps = []; let i = 6; const nS = d[5] & 31; for (let k = 0; k < nS; k++) { const n = (d[i] << 8) | d[i + 1]; sps.push(d.slice(i + 2, i + 2 + n)); i += 2 + n; } const nP = d[i++]; for (let k = 0; k < nP; k++) { const n = (d[i] << 8) | d[i + 1]; pps.push(d.slice(i + 2, i + 2 + n)); i += 2 + n; } return { profile: d[1], compat: d[2], level: d[3], lenSize, sps, pps, ext: d.slice(i) }; }
function buildAvcC(a) { const p = [1, a.profile, a.compat, a.level, 0xFC | (a.lenSize - 1), 0xE0 | a.sps.length]; for (const s of a.sps) p.push(s.length >> 8, s.length & 255, ...s); p.push(a.pps.length); for (const x of a.pps) p.push(x.length >> 8, x.length & 255, ...x); return Uint8Array.from([...p, ...a.ext]); }
const spsId = sps => readUe(rbspOf(sps.subarray(1)), 24).value;
const ppsIds = pps => { const r = rbspOf(pps.subarray(1)), a = readUe(r, 0); return { pps: a.value, sps: readUe(r, a.len).value, len0: a.len }; };
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/* One track's parameter sets, gathered from every shot and the encoder. add(avcC) → { renumber(nalu) } where renumber
   rewrites a slice's PPS number when this set had to move. CABAC slice data must stay byte-aligned, so a moved PPS
   number's code is longer than the old one's by whole bytes (0 → 15: 1 bit → 9 bits). */
export class ParamSets {
  constructor() { this.sps = []; this.pps = []; this.usedS = new Set(); this.usedP = new Set(); this.base = null; }
  add(desc) {
    const A = parseAvcC(new Uint8Array(desc)); if (A.sps.length !== 1 || A.pps.length !== 1) throw new Error('a shot with more than one parameter set');
    if (!this.base) this.base = { profile: A.profile, compat: A.compat, level: A.level, lenSize: A.lenSize, ext: A.ext };
    this.base.level = Math.max(this.base.level, A.level); this.base.compat &= A.compat;
    // the same bytes as a set already in: share it, nothing to rewrite
    for (let i = 0; i < this.sps.length; i++) if (sameBytes(this.sps[i], A.sps[0]) && sameBytes(this.pps[i], A.pps[0])) return { renumber: n => n, lenSize: A.lenSize };
    const sid = spsId(A.sps[0]), ids = ppsIds(A.pps[0]);
    if (!this.usedS.has(sid) && !this.usedP.has(ids.pps)) { this.sps.push(A.sps[0]); this.pps.push(A.pps[0]); this.usedS.add(sid); this.usedP.add(ids.pps); return { renumber: n => n, lenSize: A.lenSize }; }
    let newS = 0; while (this.usedS.has(newS)) newS++; if (newS > 31) throw new Error('no free SPS number');
    const oldLen = ueBits(ids.pps).length; let newP = -1; for (let v = 0; v <= 255; v++) if (!this.usedP.has(v) && (ueBits(v).length - oldLen) % 8 === 0 && ueBits(v).length >= oldLen) { newP = v; break; } if (newP < 0) throw new Error('no free PPS number');
    const sr = rbspOf(A.sps[0].subarray(1)), nsps = Uint8Array.from([A.sps[0][0], ...ebspOf(rewriteUe(sr, 24, newS))]);
    const pr = rbspOf(A.pps[0].subarray(1)), npps = Uint8Array.from([A.pps[0][0], ...ebspOf(rewriteUe(rewriteUe(pr, ids.len0, newS), 0, newP))]);
    this.sps.push(nsps); this.pps.push(npps); this.usedS.add(newS); this.usedP.add(newP); const oldP = ids.pps;
    return { lenSize: A.lenSize, renumber: nalu => { const t = nalu[0] & 31; if (t !== 1 && t !== 5) return nalu; const r = rbspOf(nalu.subarray(1)), a = readUe(r, 0), b = readUe(r, a.len), c = readUe(r, a.len + b.len); if (c.value !== oldP) throw new Error('a slice names an unexpected PPS'); return Uint8Array.from([nalu[0], ...ebspOf(rewriteUe(r, a.len + b.len, newP))]); } };
  }
  description() { return buildAvcC({ ...this.base, sps: this.sps, pps: this.pps }); }
  codecString() { const h = n => n.toString(16).padStart(2, '0').toUpperCase(); return `avc1.${h(this.base.profile)}${h(this.base.compat)}${h(this.base.level)}`; }
}
