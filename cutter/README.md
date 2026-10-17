# Cutter (part of Mixtape)

Cuts any sound or video file in the browser: exact to the frame, or untouched. Reached from Mixtape's **Cutter** button,
the Studio's top bar, or **Open in Cutter** on any song; finished cuts can go straight back into the library.

- `model.js` the rules (times, parts, splitting); checked by `node check.mjs`.
- `engine.js` the media work, on mediabunny (MPL-2.0, `../vendor/mediabunny/`) and WebCodecs; `h264.js` the smart-cut surgery.
- `app.js`, `index.html`, `style.css` the screen; `host-mixtape.js` connects it to the Mixtape library.
- `sync-screenwright.mjs` copies it into screenwright (`/studio/cutter`) until Mixtape moves into screenwright.

This folder is the only source. After changing anything here, bump `VERSION` in `../sw.js`.
