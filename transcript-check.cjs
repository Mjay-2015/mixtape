// Checks for Mixtape's transcript rules. Run: node transcript-check.cjs
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = {}; vm.createContext(ctx);
for (const f of ['lyrics-core.js', 'transcript-core.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx);
const T = ctx.TranscriptCore;
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log('ok  ', what); } else { fail++; console.log('FAIL', what); } };

// heard words: two sentences, a long pause, a third sentence
const heard = []; let t = 1;
const say = (s, gap = 0.3) => s.split(' ').forEach(w => { heard.push({ text: w, start: t, end: t + 0.25 }); t += gap; });
say('Thanks for coming in today.'); t += 0.2; say('Tell me where you grew up.'); t += 2; say('I grew up in Soweto, near the stadium.');
const W = T.fromHeard(heard);
const P = T.paragraphs(W);
ok(W.length === 19 && W[0].p && P.length === 2, 'a long pause starts a new paragraph; a short one does not');
ok(P[1].start === W[P[1].i0].s && W[P[1].i0].t === 'I', 'paragraphs know where they start');
ok(T.wordAt(W, 0.5) === -1 && T.wordAt(W, W[3].s + 0.1) === 3 && T.wordAt(W, 999) === W.length - 1, 'the word being spoken at a time');

// growing a transcript window by window
const half = heard.slice(0, 11), rest = heard.slice(11);
const G = T.append(T.fromHeard(half), rest);
ok(G.length === W.length && T.paragraphs(G).length === 2, 'adding words later gives the same transcript as all at once');
const S = T.append(T.fromHeard(heard.slice(0, 3)), heard.slice(3, 6));
ok(T.paragraphs(S).length === 1, 'a window boundary mid-sentence does not start a paragraph');

// editing a paragraph keeps the times of unchanged words
const p0 = P[0];
const E = T.editParagraph(W, p0.i0, p0.i1, 'Thank you for coming in today. Tell me where you grew up?');
const e0 = T.paragraphs(E)[0];
ok(E.length === W.length + 1 && E[e0.i0].t === 'Thank', 'edited words replace the old ones');
const keep = E.find(w => w.t === 'coming'), was = W.find(w => w.t === 'coming');
ok(keep.s === was.s, 'an unchanged word keeps its time');
const you = E.find(w => w.t === 'you');
ok(you.s >= E[0].s && you.s <= keep.s, 'a new word is placed between its neighbours');
ok(E.slice(1).every((w, i) => w.s >= E[i].s), 'times stay in order after an edit');
const E2 = T.editParagraph(W, p0.i0, p0.i1, 'Welcome, welcome, thanks for coming in today. Tell me where you grew up.');
ok(E2[0].s < E2[1].s && E2[1].s < E2[2].s, 'new words that land on one moment are spread out');
const Sp = T.editParagraph(W, p0.i0, p0.i1, 'Thanks for coming in today.\n\nTell me where you grew up.');
ok(T.paragraphs(Sp).length === 3, 'a blank line in an edit splits the paragraph');
const named = T.setSpeaker(W, P[1].i0, 'Thabo');
ok(T.paragraphs(named)[1].speaker === 'Thabo' && T.toTxt(named).includes('Thabo: I grew up'), 'a speaker can be named');
const kept = T.editParagraph(named, T.paragraphs(named)[1].i0, T.paragraphs(named)[1].i1, 'I grew up in Soweto near the stadium.');
ok(T.paragraphs(kept)[1].speaker === 'Thabo', 'editing a paragraph keeps its speaker');

// search and export
ok(T.search(W, 'grew up').length === 2 && T.search(W, 'SOWETO').length === 1 && T.search(W, 'stad').length === 1, 'search finds phrases, any case, word starts');
ok(T.toTxt(W).startsWith('[00:00:01] Thanks for coming') && T.toTxt(W, { timestamps: false }).startsWith('Thanks'), 'text export with or without timestamps');
const cs = T.cues(W);
ok(cs.length >= 3 && cs.every(c => c.text.split(' ').length <= 14 && c.end - c.start <= 6.5), 'subtitle cues are short');
ok(T.toSrt(W).startsWith('1\n00:00:01,000 --> ') && T.toVtt(W).startsWith('WEBVTT'), 'SRT and VTT written');
ok(T.short(3725) === '1:02:05' && T.short(65) === '1:05' && T.hms(65) === '00:01:05', 'times shown');

// a word stretched back over the intro starts where it is really said
const st = T.fromHeard([{ text: 'I', start: 0.42, end: 6.32 }, { text: 'was', start: 6.32, end: 6.6 }, { text: 'there.', start: 6.6, end: 8.4 }]);
ok(Math.abs(st[0].s - 5.97) < 0.01 && st[2].s === 6.6, 'a first word stretched over the intro is moved to just before the next; a long last word is left alone');
// an audiobook: the book's text, matched to the narration window by window
const book = 'Chapter One\n\nI was eighteen that year, and the lights had not yet come. A few months before, they had put up the masts.\n\nTall steel towers stood over the shacks. Nobody believed they would ever shine.';
const B = T.fromText(book);
ok(B.length === 37 && B.filter(w => w.p).length === 3 && B.every(w => w.s == null), 'a text becomes words waiting for times, with its paragraphs');
// the narrator skips the chapter heading, misreads one word and adds an aside
const nar = []; t = 3; const read = (s, gap = 0.35) => s.split(' ').forEach(w => { nar.push({ text: w, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) }); t += gap; });
read('I was eighteen that year, and the light had not yet come.'); t += 0.8; read('A few months before, they had put up the masts.'); t += 1.5; read('um'); read('Tall steel towers stood over the shacks.'); t += 0.6; read('Nobody believed they would ever shine.');
let ptr = 0; for (let i = 0; i < nar.length; i += 9) ptr = T.matchBatch(B, ptr, nar.slice(i, i + 9)).ptr;
const word = x => B.find(w => w.t === x);
ok(ptr === B.length && T.timedUpTo(B) === B.length, 'every word of the read text gets a time, window by window');
ok(Math.abs(word('eighteen').s - nar.find(w => w.text === 'eighteen').start) < 0.01 && Math.abs(word('Tall').s - nar.find(w => w.text === 'Tall').start) < 0.01, 'read words carry the time they were read');
ok(B.slice(1).every((w, i) => w.s >= B[i].s), 'times run in order through the book');
ok(word('lights').s >= word('the').s && word('lights').s <= word('had').s, 'a misread word is placed between its neighbours');
ok(T.wordAt(B, word('masts.').s + 0.1) === B.indexOf(word('masts.')), 'the word being read is found');
// a sentence whose first words were not recognised (names) starts at the end of the pause before it, not half way in
const B3 = T.fromText('Down our street. Hey Skhumba, the lights are on.'); const h4 = [];
[['down', 1], ['our', 1.3], ['street', 1.6], ['the', 6.5], ['lights', 6.8], ['are', 7.1], ['on', 7.4]].forEach(([w, s]) => h4.push({ text: w, start: s, end: s + .25 }));
T.matchBatch(B3, 0, h4);
ok(B3[3].s > 5.7 && B3[3].s < 6.5 && B3[4].s < 6.5, 'unrecognised first words of a sentence sit at the end of the pause');
// stopping half way: what is not yet read has no time
const B2 = T.fromText(book); const half2 = T.matchBatch(B2, 0, nar.slice(0, 12));
ok(half2.ptr > 5 && half2.ptr < 20 && B2[half2.ptr].s == null && T.timedUpTo(B2) === half2.ptr, 'a half-read book is timed up to where the narrator got');
// a long book: matching stays local (a 20,000-word text, one window)
const big = T.fromText(Array.from({ length: 2000 }, (_, i) => `Line ${i} of the long book goes on here.`).join(' ')); const t0 = Date.now();
const hb = []; let tt = 0; 'Line 0 of the long book goes on here. Line 1 of the long book goes on here.'.split(' ').forEach(w => { hb.push({ text: w, start: tt, end: tt + .3 }); tt += .35; });
const r = T.matchBatch(big, 0, hb);
ok(r.ptr === 18 && Date.now() - t0 < 500, 'a long text costs no more per window than a short one');

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
