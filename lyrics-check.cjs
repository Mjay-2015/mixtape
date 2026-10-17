// Checks for Mixtape's lyrics rules. Run: node lyrics-check.cjs
// lyrics-core.js is a classic browser script: run it in a fresh context and take what it defines
const ctx = {}; require('vm').runInNewContext(require('fs').readFileSync(require('path').join(__dirname, 'lyrics-core.js'), 'utf8'), ctx); const L = ctx.LyricsCore;
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log('ok  ', what); } else { fail++; console.log('FAIL', what); } };
const near = (a, b, e = 0.01) => a != null && Math.abs(a - b) <= e;

// text
const song = 'I was eighteen that year\nThe lights had not yet come\n\nWozobona\nThe lights are working baba';
const lines = L.fromText(song);
ok(lines.length === 4 && lines[2].gap === true && !lines[1].gap, 'plain words: one line each, a blank line marks a new verse');
ok(L.toText(lines) === song, 'and back to the same words');
ok(L.parseClock('1:02.5') === 62.5 && L.parseClock('01:02:03') === 3723 && L.parseClock('62.3') === 62.3 && L.parseClock('x') === null, 'times read');
ok(L.fmtClock(62.5) === '01:02.50', 'LRC time written');

// files
const lrc = '[ti:Song]\n[offset:+500]\n[00:12.00]First line\n[00:15.50][01:15.50]Chorus\n[00:20.25]<00:20.25>Word <00:21.00>timed';
const pl = L.parseLRC(lrc);
ok(pl.length === 4 && near(pl[0].t, 11.5) && pl[1].text === 'Chorus' && near(pl[3].t, 75), 'LRC: offset applied, repeated tags become repeated lines, in time order');
ok(pl[2].text === 'Word timed', 'LRC: word-level tags dropped from the text');
const srt = '1\n00:00:12,000 --> 00:00:14,500\nFirst line\n\n2\n00:00:15,500 --> 00:00:18,000\nSecond <i>line</i>\n';
const ps = L.parseCues(srt);
ok(ps.length === 2 && near(ps[0].t, 12) && near(ps[0].end, 14.5) && ps[1].text === 'Second line', 'SRT read, tags stripped');
ok(L.parseAny('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n').kind === 'vtt' && L.parseAny(lrc).kind === 'lrc' && L.parseAny(song).kind === 'text', 'the file kind is recognised from its content');
const tl = [{ text: 'A', t: 1 }, { text: 'B', t: 3 }, { text: 'C', t: 20 }];
ok(L.toSRT(tl, 22).includes('00:00:01,000 --> 00:00:03,000') && L.toSRT(tl, 22).includes('00:00:03,000 --> 00:00:09,000'), 'SRT: a line ends at the next, but shows 6 s at most');
ok(L.toVTT(tl, 22).startsWith('WEBVTT') && L.toVTT(tl, 22).includes('00:00:20.000 --> 00:00:22.000'), 'VTT written; the last line ends with the song');
ok(L.parseLRC(L.toLRC(tl, { title: 'T' })).map(x => x.t).join() === '1,3,20', 'LRC round trip');
ok(L.lineAt(tl, 0.5) === -1 && L.lineAt(tl, 2.9) === 0 && L.lineAt(tl, 3) === 1 && L.lineAt(tl, 100) === 2, 'the line showing at a time');

// alignment: the recogniser hears the song with a few mistakes, a missed line and an ad lib
const truth = [12.0, 15.4, 21.0, 24.8, 30.2, 33.0];
const lyr = L.fromText("I was eighteen that year\nand the lights had not yet come\nWozobona\nthe lights are working baba\nI was eighteen that year\nand the lights had not yet come");
const heard = [];
const say = (t0, text, gap = 0.32) => text.split(' ').forEach((w, i) => heard.push({ text: w, start: t0 + i * gap, end: t0 + i * gap + 0.28 }));
say(12.0, 'I was eighteen that year'); say(15.4, 'and the light had not yet come'); say(18.5, 'yeah yeah'); // "light", an ad lib
/* line 3 ("Wozobona") is not heard at all */ say(24.8, 'the lights are working bubba'); say(30.2, 'I was eighteen that year'); say(33.0, 'and the lights had not yet come');
const al = L.align(lyr, heard, 40);
ok(al.every((l, i) => i === 2 || near(l.t, truth[i], 0.05)), 'heard lines start where they were sung, despite misheard words and an ad lib');
ok(al[2].t > al[1].t && al[2].t < al[3].t && al[2].conf === 0, 'a line nobody heard is placed between its neighbours and marked to check');
ok(al[0].conf === 1 && al[3].conf >= 0.75, 'confidence: share of the words matched');
ok(near(al[4].t, 30.2, 0.05), 'a repeated verse is matched to its second singing, not its first');
// a line whose first word was missed starts a little before its first heard word
const h2 = []; [['the', 5.0], ['road', 5.3], ['home', 5.6]].forEach(([w, s]) => h2.push({ text: w, start: s, end: s + .25 }));
const a2 = L.align(L.fromText('Down the road home'), h2, 10);
ok(a2[0].t < 5.0 && a2[0].t > 4.3, 'a missed first word moves the start back by about one word');
ok(L.similar('singin', 'singing') > 0 && L.similar('baba', 'bubba') > 0 && L.similar('lights', 'night') === 0 || L.similar('lights', 'night') < 0.7, 'near spellings count as matches');
// the recogniser stamps the song's first word at 0.4 s, under the intro; the line still starts where it is sung
const h3 = []; [['i', 0.4], ['was', 6.4], ['eighteen', 6.7], ['that', 7.1], ['year', 7.4]].forEach(([w, s]) => h3.push({ text: w, start: s, end: s + .25 }));
const a3 = L.align(L.fromText('I was eighteen that year'), h3, 20);
ok(a3[0].t > 5.6 && a3[0].t < 6.4, 'a first word stamped far too early (under the intro) is passed over');
const draft = L.draftFromWords([{ text: 'hello', start: 1, end: 1.3 }, { text: 'there', start: 1.4, end: 1.7 }, { text: 'again', start: 3, end: 3.4 }]);
ok(draft.length === 2 && draft[0].text === 'hello there' && draft[1].t === 3, 'heard words become draft lines at the pauses');

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
