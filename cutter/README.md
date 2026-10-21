# Cutter (part of Mixtape)

Cuts any sound or video file in the browser: exact to the frame, or untouched. Reached from Mixtape's **Cutter** button,
the Studio's top bar, or **Open in Cutter** on any song; finished cuts can go straight back into the library.

- `model.js` the rules (times, parts, splitting); checked by `node check.mjs`.
- `engine.js` the media work, on mediabunny (MPL-2.0, `../vendor/mediabunny/`) and WebCodecs; `h264.js` the smart-cut surgery.
- `olddecode.js` opens WMA, AMR, AC3/E-AC3 and AIFF, which no browser decodes: unpacked in the browser into a 24-bit WAV by
  FFmpeg's decoders compiled to WebAssembly (libav.js, LGPL-2.1, `../vendor/libav/` with its sources and build recipe;
  fetched only when such a file is opened). Checked against FFmpeg's own decoding: identical sound (−75 dB), timeline
  within 0.5 ms. WMV/ASF video still goes through `PROJECTS\tools\Convert for Cutter.bat`.
- `app.js`, `index.html`, `style.css` the screen; `host-mixtape.js` connects it to the Mixtape library.
- **Loop** (L, beside the transport) plays the selected part over and over, or the whole file with no part selected, without a gap at the turn (the player schedules the passes back to back). **Step** sets how far ◀ ▶ and ← → move (1 frame to 30 s); Shift + arrow is always one frame, Ctrl + arrow ten seconds. Both are remembered.
- Your session (open files, the current one, playhead, zoom, the folder for cuts) is kept in IndexedDB `cutter-session`;
  parts are kept per file. Marking parts saves itself; a new file is only written by **Export**.

This folder is the only source. After changing anything here, bump `VERSION` in `../sw.js`.

Mixtape lives inside screenwright as the submodule `apps/mixtape` (served at `/studio/mixtape/`, so the Cutter is at `/studio/mixtape/cutter/`); the same repository publishes to GitHub Pages for phones.
