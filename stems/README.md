# Stem splitter: sources and credits

Splits a song into vocals, drums, bass and other instruments, entirely on the
device. Nothing is uploaded. These are the only files in Mixtape that came
from outside; each is a fixed copy, checked against its published fingerprint.

| Part | Source | Version | Licence |
|---|---|---|---|
| `ort/` ONNX Runtime Web (`ort.webgpu.min.mjs`, `ort-wasm-simd-threaded.jsep.mjs`, `.jsep.wasm`) | npm `onnxruntime-web` (Microsoft) | 1.21.0, npm integrity verified | MIT (`ort/LICENSE`) |
| `demucs/` pre/post-processing (`processor.js`, `fft.js`, `constants.js`) | github.com/timcsy/demucs-web | commit `617385fbf5883b04a2e6f474be63ed4d93f4e44c`, unmodified | MIT (`demucs/LICENSE`) |
| `model/htdemucs.part1` + `part2` | huggingface.co/timcsy/demucs-web-onnx, `htdemucs_embedded.onnx` | revision `92e33df61cfc9eb820272aaa62d2ef6dcf4d950d` | see note |

The model file is 180,534,758 bytes with SHA-256
`e5e425c17683f163a472462eb5f5a4ffcd11c31858d57fbd0833b012d8b88077`.
It is split in two only because GitHub limits files to 100 MB. The stem worker
joins the halves and refuses to run unless the joined file matches that fingerprint.

**Model licence note.** Demucs is by Meta AI (github.com/facebookresearch/demucs);
its code is MIT. The trained htdemucs weights are described as MIT by most
exports, but at least one export labels them CC BY-NC 4.0 (non-commercial).
Personal use is fine either way. Check this before selling anything built on it.
