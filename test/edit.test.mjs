import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assColor,
  assTime,
  autoEmphasis,
  buildAss,
  captionLines,
  cleanEdit,
  cleanWords,
  editFilter,
  editRules,
  keptSeconds,
  parseSilences,
  planKeeps,
  quietLevel,
  remap,
  zoomsFor,
} from "../src/edit.mjs";

const W = (i, text, start, end, offScreen = false) => ({ i, text, start, end, offScreen });

test("words: sorted, clamped, no overlaps, numbered", () => {
  const words = cleanWords(
    { words: [{ text: "world", start: 0.9, end: 1.4 }, { text: " hello ", start: 0.2, end: 1.0 }, { text: "", start: 2, end: 3 }, { text: "late", start: 9, end: 12 }] },
    10,
  );
  assert.deepStrictEqual(words.map((w) => [w.i, w.text, w.start, w.end]), [[0, "hello", 0.2, 0.9], [1, "world", 0.9, 1.4], [2, "late", 9, 10]]);
  assert.equal(cleanWords({ words: [] }, 10), null);
  assert.equal(cleanWords(null, 10), null);
});

test("silencedetect output -> quiet stretches, an open one closed at the end", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 0",
    "[silencedetect @ 0x1] silence_end: 0.42 | silence_duration: 0.42",
    "[silencedetect @ 0x1] silence_start: 3.105",
    "[silencedetect @ 0x1] silence_end: 3.9 | silence_duration: 0.795",
    "[silencedetect @ 0x1] silence_start: 9.5",
  ].join("\n");
  assert.deepStrictEqual(parseSilences(stderr, 10), [{ start: 0, end: 0.42 }, { start: 3.11, end: 3.9 }, { start: 9.5, end: 10 }]);
});

test("quiet level sits 9 dB under the speech, within limits", () => {
  assert.equal(quietLevel(-21.2), -30);
  assert.equal(quietLevel(-5), -22);
  assert.equal(quietLevel(-70), -50);
  assert.equal(quietLevel(null), -35);
});

test("a pause is cut only where the words AND the sound agree", () => {
  const words = [W(0, "Hey,", 0.5, 0.8), W(1, "listen.", 1.6, 2.0), W(2, "Now", 2.1, 2.4), W(3, "go.", 3.5, 3.8)];
  // Quiet: before the first word, in the 0.8-1.6 pause, NOT in the 2.4-3.5 pause (music was loud there), after the end.
  const quiet = [{ start: 0, end: 0.45 }, { start: 0.85, end: 1.55 }, { start: 3.85, end: 5 }];
  const keeps = planKeeps(words, quiet, 5, cleanEdit());
  // `pad` of the quiet stays next to every sound: 0.45 - 0.08, 0.85 + 0.08, 1.55 - 0.08, 3.85 + 0.08.
  assert.deepStrictEqual(keeps, [{ start: 0.37, end: 0.93 }, { start: 1.47, end: 3.93 }]);
  // The 2.4-3.5 gap stayed whole: no quiet was measured there.
  assert.ok(keeps[1].start < 2.4 && keeps[1].end > 3.5);
  assert.equal(keptSeconds(keeps), 3.02);
});

test("a quiet voice on a phone is never cut: it is a word, not a gap", () => {
  const words = [W(0, "Hi", 0, 0.4), W(1, "we're", 0.6, 1.0, true), W(2, "closed.", 1.0, 2.4, true), W(3, "See?", 2.5, 2.9)];
  // The detector calls the soft phone voice "quiet" from 0.45 to 2.45.
  const keeps = planKeeps(words, [{ start: 0.45, end: 2.45 }], 2.9, cleanEdit({ trimEnds: false }));
  assert.deepStrictEqual(keeps, [{ start: 0, end: 2.9 }]);
});

test("keepPauses holds a beat; trimEnds off keeps the head and tail", () => {
  const words = [W(0, "Wait", 1, 1.3), W(1, "for", 2.3, 2.5), W(2, "it.", 2.6, 2.9)];
  const quiet = [{ start: 0, end: 0.95 }, { start: 1.35, end: 2.25 }, { start: 2.95, end: 4 }];
  assert.deepStrictEqual(planKeeps(words, quiet, 4, cleanEdit({ keepPauses: [0], trimEnds: false })), [{ start: 0, end: 4 }]);
  assert.deepStrictEqual(planKeeps(words, quiet, 4, cleanEdit()), [{ start: 0.87, end: 1.43 }, { start: 2.17, end: 3.03 }]);
});

test("maxHold shortens a long gap that isn't quiet (a ringtone), half each side; keepPauses still wins", () => {
  const words = [W(0, "home?", 10, 11), W(1, "Hi.", 16, 17)];
  // Only 11-13 is quiet; 13-16 is a ringtone.
  const quiet = [{ start: 11, end: 13 }];
  const plain = planKeeps(words, quiet, 17, cleanEdit({ trimEnds: false }));
  assert.deepStrictEqual(plain, [{ start: 0, end: 11.08 }, { start: 12.92, end: 17 }]);
  const held = planKeeps(words, quiet, 17, cleanEdit({ trimEnds: false, maxHold: 0.6 }));
  assert.deepStrictEqual(held, [{ start: 0, end: 11.08 }, { start: 15.7, end: 17 }]);
  assert.equal(Math.round((remap(16, held) - remap(11, held)) * 100) / 100, 0.38);
  assert.deepStrictEqual(planKeeps(words, quiet, 17, cleanEdit({ trimEnds: false, maxHold: 0.6, keepPauses: [0] })), [{ start: 0, end: 17 }]);
  assert.equal(cleanEdit({}).maxHold, null);
});

test("no flash frames: a short part between two cuts with no word in it is dropped", () => {
  const words = [W(0, "home?", 10, 11.44), W(1, "I", 16.92, 17.1)];
  // Quiet right after the word, then a ringtone: the quiet cut and the hold cut almost meet.
  const keeps = planKeeps(words, [{ start: 11.45, end: 11.76 }], 17.1, cleanEdit({ trimEnds: false, maxHold: 0.7 }));
  assert.deepStrictEqual(keeps, [{ start: 0, end: 11.53 }, { start: 16.57, end: 17.1 }]);
  // ...but a short part with a word in it stays.
  const word = planKeeps([W(0, "a", 1, 1.1), W(1, "b", 1.9, 2), W(2, "c", 2.9, 3)], [{ start: 1.1, end: 1.85 }, { start: 2.05, end: 2.85 }], 3, cleanEdit({ trimEnds: false, pad: 0.02 }));
  assert.ok(word.some((k) => k.start <= 1.9 && k.end >= 2 && k.end - k.start < 0.25));
});

test("remap: times move left by the cuts before them; a time in a cut lands on it", () => {
  const keeps = [{ start: 1, end: 2 }, { start: 3, end: 5 }];
  assert.equal(remap(0.5, keeps), 0);
  assert.equal(remap(1.5, keeps), 0.5);
  assert.equal(remap(2.5, keeps), 1);
  assert.equal(remap(4, keeps), 2);
  assert.equal(remap(9, keeps), 3);
});

test("zooms alternate on each jump cut, short parts keep the zoom before", () => {
  const keeps = [{ start: 0, end: 2 }, { start: 2.5, end: 4 }, { start: 4.2, end: 4.5 }, { start: 5, end: 7 }];
  assert.deepStrictEqual(zoomsFor(keeps, cleanEdit()), [1, 1.12, 1.12, 1]);
  assert.deepStrictEqual(zoomsFor(keeps, cleanEdit({ zoom: "off" })), [1, 1, 1, 1]);
  assert.deepStrictEqual(zoomsFor(keeps, cleanEdit({ zoom: [1, 1.2] })), [1, 1.2, 1, 1]);
});

test("caption lines break on word count, sentence ends and speaker changes", () => {
  const words = [
    W(0, "Hey,", 0, 0.3), W(1, "I", 0.3, 0.4), W(2, "bet", 0.4, 0.6), W(3, "you.", 0.6, 0.9),
    W(4, "Hello,", 1.0, 1.3, true), W(5, "Arctic.", 1.3, 1.8, true), W(6, "Hi!", 1.9, 2.2),
  ];
  const lines = captionLines(words, [{ start: 0, end: 3 }], cleanEdit());
  assert.deepStrictEqual(lines.map((l) => l.words.map((w) => w.text).join(" ")), ["Hey, I bet", "you.", "Hello, Arctic.", "Hi!"]);
  assert.equal(lines[2].offScreen, true);
  assert.ok(lines.every((l, i) => !lines[i + 1] || l.end <= lines[i + 1].start));
});

test("auto emphasis: numbers, money and call-to-action words", () => {
  const words = [W(0, "a", 0, 1), W(1, "thousand", 1, 2), W(2, "bucks", 2, 3), W(3, "$500", 3, 4), W(4, "click", 4, 5), W(5, "the", 5, 6), W(6, "link.", 6, 7)];
  assert.deepStrictEqual(autoEmphasis(words), [1, 3, 4, 6]);
});

test("ASS colours and times", () => {
  assert.equal(assColor("#FFD400"), "&H0000D4FF");
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(61.234), "0:01:01.23");
  assert.equal(assTime(3725.5), "1:02:05.50");
});

test("the overlay: one caption event per word, the spoken word lit, a sticker, the progress bar", () => {
  const words = [W(0, "Save", 0, 0.4), W(1, "$500", 0.5, 1.0), W(2, "today.", 1.1, 1.5)];
  const edit = cleanEdit({ popups: [{ word: 1, text: "$500 off", seconds: 1 }] });
  const ass = buildAss({ words, keeps: [{ start: 0, end: 2 }], edit, width: 720, height: 1280 });
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(events.filter((l) => l.includes(",Cap,")).length, 3);
  assert.ok(events.some((l) => l.includes(",Pop,") && l.includes("$500 OFF")));
  assert.ok(events.some((l) => l.includes(",Bar,") && l.includes("\\clip(0,0,720,1280)")));
  // "$500" is an emphasis word: drawn in the emphasis colour when it isn't the spoken one.
  assert.ok(events[0].includes(`{\\c${assColor("#3CFF7A")}}$500`));
  assert.ok(ass.includes("PlayResY: 1280"));
});

test("captions off, no bar: no events", () => {
  const ass = buildAss({ words: [W(0, "Hi", 0, 1)], keeps: [{ start: 0, end: 1 }], edit: cleanEdit({ captions: { on: false }, progressBar: false }) });
  assert.equal(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length, 0);
});

test("edit.json is cleaned: bad values fall back, colours normalised", () => {
  const e = cleanEdit({ maxGap: "x", pad: 5, zoom: [2, "a"], captions: { highlight: "ff0000", size: 9 }, popups: [{ word: 2, text: "" }, { word: 1, text: "ok", y: 3 }] });
  assert.equal(e.maxGap, 0.25);
  assert.equal(e.pad, 0.3);
  assert.deepStrictEqual(e.zoom, [1.6, 1]);
  assert.equal(e.captions.highlight, "#FF0000");
  assert.equal(e.captions.size, 24);
  assert.deepStrictEqual(e.popups.map((p) => [p.word, p.text, p.y]), [[1, "ok", 0.95]]);
  assert.equal(e.emphasis, null);
});

test("the filter graph: one trim per kept part, zoom only where asked, overlay by relative path", () => {
  const g = editFilter({ keeps: [{ start: 0, end: 1 }, { start: 1.5, end: 3 }], zooms: [1, 1.12], width: 720, height: 1280, assFile: "edit/captions.ass" });
  assert.equal((g.match(/\[0:v\]trim=/g) ?? []).length, 2);
  assert.equal((g.match(/crop=/g) ?? []).length, 1);
  assert.ok(g.includes("scale=808:1434"));
  // Every part ends square-pixelled, zoomed or not (concat refuses a mix).
  assert.equal((g.match(/,setsar=1\[v\d\]/g) ?? []).length, 2);
  assert.ok(g.includes("concat=n=2:v=1:a=1[vc][ac]"));
  assert.ok(g.includes("[vc]ass=edit/captions.ass,format=yuv420p[vout]"));
  assert.ok(g.includes("loudnorm=I=-14"));
  const silent = editFilter({ keeps: [{ start: 0, end: 1 }], zooms: [1], width: 720, height: 1280, hasAudio: false });
  assert.ok(!silent.includes("[0:a]") && silent.includes("concat=n=1:v=1:a=0[vc]"));
});

test("edit rules list every word and show which pauses are cut", () => {
  const words = [W(0, "Hey,", 0.5, 0.8), W(1, "listen.", 1.6, 2.0)];
  const keeps = planKeeps(words, [{ start: 0.85, end: 1.55 }], 2.0, cleanEdit({ trimEnds: false }));
  const text = editRules({ words, keeps, duration: 2, quiet: [{}], level: -30, edit: false });
  // 0.05 s of sound-tail + 0.08 pad on each side, + 0.05 before the next word.
  assert.match(text, /0\s+0\.50-0\.80\s+Hey, +\[pause 0\.80 s -> 0\.26 s\]/);
  assert.match(text, /1\s+1\.60-2\.00\s+listen\./);
});
