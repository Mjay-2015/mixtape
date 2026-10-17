# Mixtape

A music player for your own song files. Install it once from the link below, and after that it works with no internet and keeps playing with the screen off.

**Open / install:** https://mjay-2015.github.io/mixtape/

- Songs stay on your device (saved in the browser). Nothing is uploaded.
- Play, pause, next, previous, seek, shuffle, repeat (all / one), queue, favorites, playlists, search, sort, sleep timer, speed, lock-screen controls.
- Reads title, artist, album and cover art from MP3 tags; other formats use the filename.

When you change `index.html`, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Lyrics

Any song can carry its lyrics (song menu → **Add lyrics**). In **Now Playing → Lyrics** the line being sung lights up and stays in view; tap a line to jump there.

- Paste the words, or load a `.lrc`, `.srt`, `.vtt` or `.txt` file.
- **Time them automatically**: the song is heard by Whisper (base.en, MIT) running in the browser through transformers.js 4.3.1 (Apache-2.0) and ONNX Runtime Web (MIT), fetched from jsDelivr the first time and kept for offline use; your lines are matched to what it hears. Lines it is unsure of are marked *check*. The model (~77 MB) downloads once, on first use. If the song has a split vocals stem, that is what it listens to.
- **Tap along**: play the song and press Space as each line starts (Backspace takes a tap back).
- Save the timed lyrics as `.lrc`, `.srt` (YouTube, video editors) or `.vtt`.

Rules: `lyrics-core.js` (checked by `node lyrics-check.cjs`); screens: `lyrics.js`, `lyrics.css`; recogniser: `asr-worker.js`.

## Transcripts and read-along

**Transcribe** (top bar, the song menu, or the Studio): pick a recording or video, or open a file (it joins the library under *Recordings*).

- **Write down what is said**: for interviews and voice notes. The text appears as it is made, in paragraphs at the pauses.
- **Match my text to it**: for audiobooks and read scripts. Paste the text or load a .txt; each word is matched to the moment it is read (headings the narrator skips, misread names and asides do not throw it).
- Click any word to play from there; the word being spoken is lit and kept in view. Correct a paragraph (✎): words you keep keep their timing. Name the speakers. Find in the text. Speed, 5-second skips, Space to play (Tab while editing).
- Long recordings are read 30 seconds at a time and saved as they go: pause, close, and continue later.
- Save as text with timestamps, plain text, .srt, .vtt, or words with times (.json).

Rules: `transcript-core.js` (checked by `node transcript-check.cjs`); screen: `transcribe/`. Same recogniser as the lyrics.

**Where it lives:** this repository is carried inside screenwright as `apps/mixtape` and served there at `/studio/mixtape/` (behind staff sign-in). Pushing to `main` still publishes the phone version on GitHub Pages. Edit it in `screenwright/apps/mixtape`.
