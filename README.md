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
- Click any word to play from there; the word being spoken is lit and kept in view. Double-click a word (or ✎) to correct its paragraph: words you keep keep their timing.
- **Speakers are found automatically** (pyannote segmentation 3.0, MIT, hears the turns; Wespeaker ResNet34, Apache-2.0, tells the voices apart, both in `speaker-worker.js`). Click a speaker to rename them everywhere, or give a paragraph to someone else or a new speaker.
- **Everything said is kept** — "um", "uh", "we, we" (Whisper is prompted to write verbatim). **Clean script** hides fillers, false starts and starters ("So,", "Well,", "You know,"); exports follow the switch.
- **Words the recogniser was unsure of are lighter** (from Whisper's own token probabilities), the least sure underlined: check those first.
- Keys, as in Temi and Rev: **Tab** play/pause anywhere (even while typing), **Shift+Tab** back 5 s, Ctrl+←/→ 5 s, Ctrl+↑/↓ speed, Ctrl+Z undo, Ctrl+F find, ? for the list. Playing again after a pause backs up 1 s.
- **✦ AI check** (inside the studio only, it goes through the studio's server): a second reader. Claude (Opus 5.5) reads the transcript for sense and suggests the words the recogniser most likely misheard (names, places, legal or local words, sound-alikes) and paragraphs whose speaker looks wrong, and who a speaker is when the talk says so. Optional notes (names, the topic) help it spell. It never rewrites: the server drops any suggestion that rewords, adds or removes a filler, or does not match the words actually there. Each shows as an ochre mark: hear it, accept it, or keep what was heard; Accept all and Ctrl+Z work. About $0.07 per 1,000 words, costed to the studio.
- **Mark sensitive** (under the title): for court, client, medical or HR recordings. The AI check is locked (it is the only thing here that sends anything out: the words, to Claude through the studio), the recording shows a 🔒, exports say so, and it is never used for training. Recognising, speakers, cutting and exports always run in the browser.
- A transcript made elsewhere (a `.json` with `"mode": "heard"`, e.g. from Reverb on your own computer) opens with its recording as a transcript.
- Long recordings are read 30 seconds at a time and saved as they go: pause, close, and continue later.
- Save as text with timestamps, plain text, .srt, .vtt, or words with times (.json).

Rules: `transcript-core.js` (checked by `node transcript-check.cjs`); screen: `transcribe/`. Same recogniser as the lyrics.

**Where it lives:** this repository is carried inside screenwright as `apps/mixtape` and served there at `/studio/mixtape/` (behind staff sign-in). Pushing to `main` still publishes the phone version on GitHub Pages. Edit it in `screenwright/apps/mixtape`.
