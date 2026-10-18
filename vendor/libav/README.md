# libav.js "cutter-oldaudio": WMA, AMR, AC3 and AIFF for the Cutter

The Cutter (`cutter/olddecode.js`) uses this to open sound formats no browser decodes: WMA (v1, v2, Pro, Lossless,
Voice), AMR (narrow and wide band), AC3 / E-AC3 and AIFF. Decoding happens in the browser; nothing is uploaded.

- **What it is:** a custom build of [libav.js](https://github.com/Yahweasel/libav.js) v6.10.9.0 (FFmpeg 9.0's libraries
  compiled to WebAssembly with Emscripten 6.0.5). Only the decoders and demuxers listed in `ffmpeg-config.txt` are in it.
- **Licence:** FFmpeg's libraries are under the **GNU Lesser General Public License v2.1** (`COPYING.LGPLv2.1`);
  libav.js's own wrapper code is 0BSD. This build contains no GPL parts.
- **Source code (as the LGPL requires):** `sources/ffmpeg-9.0.tar.xz` and `sources/libav.js-6.10.9.0.tar.gz`, the exact
  sources it was built from (libav.js applies its own patches from `patches/` in its archive).
  SHA-256: ffmpeg `7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52`,
  libav.js `3b640c356d74724a99230b077ef442d8c995a37c03e0729d6d2a9be0f3a41fd3`.
- **How it was built:** `.github/workflows/libav-oldaudio.yml` on this repository's `build-libav` branch:

      cd libav.js/configs
      ./mkconfig.js cutter-oldaudio '["avformat","avcodec","swresample","demuxer-asf","decoder-wmav1","decoder-wmav2","decoder-wmapro","decoder-wmalossless","decoder-wmavoice","demuxer-amr","parser-amr","decoder-amrnb","decoder-amrwb","demuxer-ac3","demuxer-eac3","parser-ac3","decoder-ac3","decoder-eac3","demuxer-aiff","decoder-pcm_s16be","decoder-pcm_s24be","decoder-pcm_s32be","decoder-pcm_f32be","decoder-pcm_s8"]'
      cd .. && make build-cutter-oldaudio

  You may rebuild it from these sources (with your own changes) and replace the three `libav-6.10.9.0-cutter-oldaudio.*`
  files here; the Cutter loads whatever is in this folder.
