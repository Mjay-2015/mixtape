# Mixtape

A music player for your own song files. Install it once from the link below, and after that it works with no internet and keeps playing with the screen off.

**Open / install:** https://mjay-2015.github.io/mixtape/

- Songs stay on your device (saved in the browser). Nothing is uploaded.
- Play, pause, next, previous, seek, shuffle, repeat (all / one), queue, favorites, playlists, search, sort, sleep timer, speed, lock-screen controls.
- Reads title, artist, album and cover art from MP3 tags; other formats use the filename.

When you change `index.html`, bump `VERSION` in `sw.js` so installed copies pick up the update.

**Where it lives:** this repository is carried inside screenwright as `apps/mixtape` and served there at `/studio/mixtape/` (behind staff sign-in). Pushing to `main` still publishes the phone version on GitHub Pages. Edit it in `screenwright/apps/mixtape`.
