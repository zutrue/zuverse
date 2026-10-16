/**
 * The optional edit of a finished video: every pause cut out, word-by-word
 * captions that pop, punch-in zooms on the jump cuts, pop-up stickers and a
 * progress bar. Only run when asked (`zuverse edit`); a render is never edited
 * on its own.
 *
 * Gemini says when each word is spoken; ffmpeg measures where the sound is
 * quiet. A pause is cut only where both agree, so a quiet voice (someone on a
 * phone) is never cut for silence, and a mistimed word never loses its sound.
 * Everything here is pure; media.mjs runs ffmpeg and pipeline.mjs the steps.
 */

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);

/* ─────────────────────────────── words ─────────────────────────────── */

export const WORDS_SYSTEM = `You are a frame-accurate speech aligner for video editing. Listen to the video's sound and return every spoken word, in order, with the moment it starts and ends in seconds (to 0.01 s), measured from the start of the video.

- One entry per word, exactly as said. Numbers as said ("a thousand", "30"), with their punctuation attached to the word ("bucks," "phone.").
- start is when the word's sound begins, end is when it stops. A word never overlaps the next one. Pauses between words are left out: the next word starts when it is actually said.
- offScreen: true for a voice that does not belong to the person on screen (a voice through a phone, a voice-over), false otherwise.
- Do not invent words that are not said, do not skip any, and do not include music, sound effects or lyrics.
Output valid JSON matching the schema.`;

export function wordsSchema() {
  return {
    type: "object",
    properties: {
      words: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            start: { type: "number" },
            end: { type: "number" },
            offScreen: { type: "boolean" },
          },
          required: ["text", "start", "end"],
        },
      },
    },
    required: ["words"],
  };
}

export function wordsPrompt({ duration, script }) {
  const lines = [`The video is ${duration.toFixed(2)} s long.`];
  if (script) lines.push(`It was made from this script (the words actually said may differ a little; return what is said): ${String(script).slice(0, 3000)}`);
  lines.push("Return every spoken word with its start and end time.");
  return lines.join("\n");
}

/**
 * The model's words, cleaned: in order, inside the video, at least 60 ms
 * long, never overlapping. Returns null when nothing usable came back.
 */
export function cleanWords(raw, duration) {
  const list = Array.isArray(raw?.words) ? raw.words : Array.isArray(raw) ? raw : [];
  const words = list
    .map((w) => ({
      text: String(w?.text ?? "").replace(/\s+/g, " ").trim(),
      start: Number(w?.start),
      end: Number(w?.end),
      offScreen: w?.offScreen === true,
    }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ ...w, start: clamp(w.start, 0, duration), end: clamp(Math.max(w.end, w.start), 0, duration) }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (w.end - w.start < 0.06) w.end = Math.min(duration, w.start + 0.06);
    if (next && w.end > next.start) w.end = Math.max(w.start + 0.02, next.start);
    w.start = round2(w.start);
    w.end = round2(w.end);
  }
  const usable = words.filter((w) => w.end > w.start);
  return usable.length ? usable.map((w, i) => ({ i, ...w })) : null;
}

/* ─────────────────────────────── quiet ─────────────────────────────── */

/** "silence_start: 1.23" / "silence_end: 1.9" lines from ffmpeg's silencedetect -> [{start, end}]. */
export function parseSilences(stderr, duration) {
  const out = [];
  let open = null;
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && open !== null) {
      out.push({ start: round2(open), end: round2(Number(e[1])) });
      open = null;
    }
  }
  if (open !== null && Number.isFinite(duration) && duration > open) out.push({ start: round2(open), end: round2(duration) });
  return out.filter((q) => q.end > q.start);
}

/**
 * The level under which sound counts as quiet, from the speech band's mean
 * loudness: about 9 dB under it, so background music under a voice is still
 * "quiet" but a soft-spoken word is not.
 */
export function quietLevel(meanDb) {
  if (!Number.isFinite(meanDb)) return -35;
  return Math.round(clamp(meanDb - 9, -50, -22));
}

/* ─────────────────────────────── cuts ─────────────────────────────── */

/** The shortest part kept between two cuts when no word is said in it (seconds). */
const MIN_PART = 0.25;

/** What edit.json may say, with defaults filled in and nonsense dropped. */
export function cleanEdit(raw = {}) {
  const e = raw && typeof raw === "object" ? raw : {};
  const c = e.captions && typeof e.captions === "object" ? e.captions : {};
  const color = (v, fallback) => (/^#?[0-9a-f]{6}$/i.test(String(v ?? "")) ? `#${String(v).replace("#", "").toUpperCase()}` : fallback);
  const ints = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : []);
  return {
    maxGap: clamp(num(e.maxGap, 0.25), 0.1, 3),
    pad: clamp(num(e.pad, 0.08), 0, 0.3),
    keepPauses: ints(e.keepPauses),
    maxHold: e.maxHold === null || e.maxHold === undefined || e.maxHold === false ? null : clamp(num(e.maxHold, 0.6), 0.2, 5),
    trimEnds: e.trimEnds !== false,
    zoom: Array.isArray(e.zoom) ? e.zoom.map((z) => clamp(num(z, 1), 1, 1.6)) : e.zoom === "off" || e.zoom === false ? "off" : "alternate",
    zoomAmount: clamp(num(e.zoomAmount, 1.12), 1, 1.6),
    zoomFocus: clamp(num(e.zoomFocus, 0.35), 0, 1),
    captions: {
      on: c.on !== false,
      uppercase: c.uppercase !== false,
      wordsPerLine: clamp(Math.round(num(c.wordsPerLine, 3)), 1, 6),
      maxChars: clamp(Math.round(num(c.maxChars, 16)), 6, 40),
      font: String(c.font || "Arial Black").replace(/[,{}\\]/g, "").slice(0, 60),
      size: clamp(Math.round(num(c.size, 62)), 24, 140),
      color: color(c.color, "#FFFFFF"),
      highlight: color(c.highlight, "#FFD400"),
      y: clamp(num(c.y, 0.7), 0.1, 0.95),
    },
    emphasis: Array.isArray(e.emphasis) ? ints(e.emphasis) : null,
    emphasisColor: color(e.emphasisColor, "#3CFF7A"),
    popups: (Array.isArray(e.popups) ? e.popups : [])
      .map((p) => ({
        word: Number.isInteger(Number(p?.word)) ? Number(p.word) : null,
        text: String(p?.text ?? "").replace(/[{}\\]/g, "").trim().slice(0, 40),
        seconds: clamp(num(p?.seconds, 1.6), 0.4, 8),
        color: color(p?.color, "#FFD400"),
        textColor: color(p?.textColor, "#111111"),
        y: clamp(num(p?.y, 0.14), 0.05, 0.95),
        tilt: clamp(num(p?.tilt, -5), -30, 30),
        size: clamp(Math.round(num(p?.size, 56)), 20, 140),
      }))
      .filter((p) => p.text && p.word !== null),
    progressBar: e.progressBar !== false,
    loudness: e.loudness !== false,
  };
}

/**
 * The parts of the video to keep. A pause between two words longer than
 * `maxGap` is cut where the sound is also quiet, keeping `pad` of it on each
 * side; the quiet before the first word and after the last goes too (unless
 * trimEnds is off). `keepPauses` lists words whose following pause stays.
 * `maxHold` (off unless set) shortens any longer gap between words to that
 * length whatever is playing in it (a ringtone, a music swell): it trusts the
 * word timings alone, so it is for gaps that are clearly empty of speech.
 */
export function planKeeps(words, quiet, duration, edit = cleanEdit()) {
  const { maxGap, pad, maxHold } = edit;
  const keepAfter = new Set(edit.keepPauses);
  const cuts = [];
  const gaps = [];
  if (words?.length) {
    if (edit.trimEnds) gaps.push({ from: 0, to: words[0].start, lead: true });
    for (let i = 0; i < words.length - 1; i++) {
      if (keepAfter.has(words[i].i ?? i)) continue;
      gaps.push({ from: words[i].end, to: words[i + 1].start });
    }
    if (edit.trimEnds) gaps.push({ from: words[words.length - 1].end, to: duration, tail: true });
  }
  for (const g of gaps) {
    // Half the hold stays next to each word (all of it next to the word, at the very start or end).
    if (maxHold && g.to - g.from > maxHold) {
      const from = g.lead ? 0 : g.from + (g.tail ? maxHold : maxHold / 2);
      const to = g.tail ? g.to : g.to - (g.lead ? maxHold : maxHold / 2);
      if (to - from >= 0.1) cuts.push({ from: round2(from), to: round2(to) });
    }
    if (g.to - g.from <= maxGap) continue;
    for (const q of quiet ?? []) {
      const from = Math.max(g.from, q.start) + (g.lead ? 0 : pad);
      const to = Math.min(g.to, q.end) - (g.tail ? 0 : pad);
      // Only real pauses: what is left to cut must itself be worth a cut.
      if (to - from >= Math.max(0.1, maxGap - 2 * pad)) cuts.push({ from: round2(from), to: round2(to) });
    }
  }
  cuts.sort((a, b) => a.from - b.from);
  // A sliver left between two cuts with no word in it would flash on screen: it goes too.
  const worth = (a, b) => b - a > 0.04 && (b - a >= MIN_PART || (words ?? []).some((w) => w.end > a && w.start < b));
  const keeps = [];
  let at = 0;
  for (const c of cuts) {
    if (worth(at, c.from)) keeps.push({ start: round2(at), end: round2(c.from) });
    at = Math.max(at, c.to);
  }
  if (worth(at, duration)) keeps.push({ start: round2(at), end: round2(duration) });
  return keeps.length ? keeps : [{ start: 0, end: round2(duration) }];
}

/** A time on the original clock, on the edited one (a time inside a cut lands on the cut). */
export function remap(t, keeps) {
  let acc = 0;
  for (const k of keeps) {
    if (t < k.start) return round2(acc);
    if (t <= k.end) return round2(acc + (t - k.start));
    acc += k.end - k.start;
  }
  return round2(acc);
}

export const keptSeconds = (keeps) => round2(keeps.reduce((s, k) => s + (k.end - k.start), 0));

/**
 * The zoom of each kept part. "alternate" punches in on every other jump cut
 * (a part under half a second keeps the zoom before it, so it doesn't flicker).
 */
export function zoomsFor(keeps, edit = cleanEdit()) {
  if (edit.zoom === "off") return keeps.map(() => 1);
  if (Array.isArray(edit.zoom)) return keeps.map((_, i) => edit.zoom[i] ?? 1);
  const out = [];
  let zoomed = false;
  keeps.forEach((k, i) => {
    if (i > 0 && k.end - k.start >= 0.5) zoomed = !zoomed;
    out.push(zoomed ? edit.zoomAmount : 1);
  });
  return out;
}

/** Words worth a colour on their own: numbers, money and the usual call-to-action words. */
const STRONG = /^(free|now|today|save|price|prices|pricing|online|click|link|below|new|never|guaranteed|best|instant|seconds?|minutes?|thousand|million|hundred)$/i;
export function autoEmphasis(words) {
  return (words ?? []).filter((w) => /[\d$%]/.test(w.text) || STRONG.test(bare(w.text))).map((w) => w.i);
}

const bare = (text) => String(text).replace(/[^\p{L}\p{N}$%'-]/gu, "");

/* ─────────────────────────────── captions ─────────────────────────────── */

/** "#RRGGBB" -> ASS "&H00BBGGRR". */
export function assColor(hex) {
  const h = String(hex).replace("#", "");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** Seconds -> ASS "H:MM:SS.cc". */
export function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const assText = (s) => String(s).replace(/[{}\\]/g, "").replace(/\n/g, " ");

/**
 * The words on the edited clock, grouped into caption lines: a few words a
 * line, a new line after a sentence ends, when the speaker changes, or after
 * a held pause.
 */
export function captionLines(words, keeps, edit = cleanEdit()) {
  const { wordsPerLine, maxChars } = edit.captions;
  const timed = (words ?? []).map((w) => ({ ...w, s: remap(w.start, keeps), e: remap(w.end, keeps) })).filter((w) => w.e > w.s);
  const lines = [];
  let line = null;
  for (const w of timed) {
    const prev = line?.words[line.words.length - 1];
    const chars = line ? line.words.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length : 0;
    const breakHere =
      !line ||
      line.words.length >= wordsPerLine ||
      chars > maxChars ||
      /[.!?]["')]?$/.test(prev.text) ||
      prev.offScreen !== w.offScreen ||
      w.s - prev.e > 0.6;
    if (breakHere) {
      line = { words: [], offScreen: w.offScreen };
      lines.push(line);
    }
    line.words.push(w);
  }
  for (const l of lines) l.start = l.words[0].s;
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    l.end = round2(Math.min(l.words[l.words.length - 1].e + 0.35, next ? next.start : Infinity));
  });
  return lines;
}

/**
 * The whole overlay as an ASS subtitle file (libass draws it in ffmpeg):
 * captions with the spoken word lit and popped, emphasis words in their own
 * colour, the off-screen voice in a dark bubble, stickers, and a progress bar.
 */
export function buildAss({ words, keeps, edit = cleanEdit(), width = 720, height = 1280 }) {
  const c = edit.captions;
  const scale = height / 1280;
  const size = Math.round(c.size * scale);
  const marginV = Math.round(height * (1 - c.y));
  const total = keptSeconds(keeps);
  const emphasis = new Set(edit.emphasis ?? autoEmphasis(words));
  const white = assColor(c.color);
  const lit = assColor(c.highlight);
  const strong = assColor(edit.emphasisColor);
  const upper = (s) => (c.uppercase ? s.toUpperCase() : s);

  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${c.font},${size},${white},${white},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${Math.round(7 * scale)},${Math.round(3 * scale)},2,${Math.round(40 * scale)},${Math.round(40 * scale)},${marginV},1`,
    `Style: Voice,${c.font},${Math.round(size * 0.82)},&H00FFFFFF,&H00FFFFFF,&H40201A14,&H00000000,-1,-1,0,0,100,100,0,0,3,${Math.round(14 * scale)},0,2,${Math.round(60 * scale)},${Math.round(60 * scale)},${marginV},1`,
    `Style: Pop,${c.font},${Math.round(56 * scale)},&H00111111,&H00111111,${lit},${lit},-1,0,0,0,100,100,0,0,3,${Math.round(14 * scale)},0,5,0,0,0,1`,
    `Style: Bar,Arial,10,${lit},${lit},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = [];
  const dialogue = (layer, start, end, style, text) => events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);

  if (c.on) {
    for (const line of captionLines(words, keeps, edit)) {
      const style = line.offScreen ? "Voice" : "Cap";
      line.words.forEach((w, k) => {
        const from = k === 0 ? line.start : w.s;
        const to = k === line.words.length - 1 ? line.end : line.words[k + 1].s;
        if (to - from < 0.01) return;
        // The line pops in with its first word; after that only the spoken word moves.
        const entry = k === 0 ? `{\\fscx82\\fscy82\\t(0,90,\\fscx104\\fscy104)\\t(90,150,\\fscx100\\fscy100)}` : "";
        const body = line.words
          .map((x, j) => {
            const text = assText(upper(x.text));
            const isStrong = emphasis.has(x.i);
            if (line.offScreen) return j === k ? `{\\c${lit}}${text}{\\c&H00FFFFFF&}` : text;
            if (j !== k) return isStrong ? `{\\c${strong}}${text}{\\c${white}}` : text;
            const grow = isStrong ? 124 : 112;
            return `{\\c${isStrong ? strong : lit}\\fscx${grow}\\fscy${grow}\\t(0,110,\\fscx${isStrong ? 112 : 104}\\fscy${isStrong ? 112 : 104})}${text}{\\c${white}\\fscx100\\fscy100}`;
          })
          .join(" ");
        dialogue(0, from, to, style, entry + body);
      });
    }
  }

  for (const p of edit.popups) {
    const w = (words ?? []).find((x) => x.i === p.word);
    if (!w) continue;
    const from = remap(w.start, keeps);
    const to = Math.min(total, from + p.seconds);
    if (to - from < 0.2) continue;
    const box = assColor(p.color);
    const ink = assColor(p.textColor);
    const pos = `\\pos(${Math.round(width / 2)},${Math.round(height * p.y)})`;
    dialogue(
      2,
      from,
      to,
      "Pop",
      `{${pos}\\frz${p.tilt}\\fs${Math.round(p.size * scale)}\\c${ink}\\3c${box}\\4c${box}\\fad(0,150)\\fscx0\\fscy0\\t(0,140,\\fscx116\\fscy116)\\t(140,230,\\fscx100\\fscy100)}${assText(upper(p.text))}`,
    );
  }

  if (edit.progressBar && total > 0) {
    const h = Math.max(6, Math.round(10 * scale));
    dialogue(
      3,
      0,
      total,
      "Bar",
      `{\\an7\\pos(0,${height - h})\\p1\\clip(0,0,0,${height})\\t(0,${Math.round(total * 1000)},\\clip(0,0,${width},${height}))}m 0 0 l ${width} 0 l ${width} ${h} l 0 ${h}{\\p0}`,
    );
  }
  return `${[...head, ...events].join("\n")}\n`;
}

/* ─────────────────────────────── ffmpeg graph ─────────────────────────────── */

/**
 * The filter graph that cuts the kept parts, zooms each one, joins them and
 * draws the overlay. `assFile` must be a plain relative path (ffmpeg runs in
 * the project folder, so no drive letter needs escaping).
 */
export function editFilter({ keeps, zooms, width, height, focus = 0.35, assFile, hasAudio = true, loudness = true }) {
  const parts = [];
  const joins = [];
  keeps.forEach((k, i) => {
    const z = zooms[i] ?? 1;
    const zoom = z > 1.001
      ? `,scale=${even(width * z)}:${even(height * z)}:flags=bicubic,crop=${width}:${height}:(iw-${width})/2:(ih-${height})*${focus}`
      : "";
    // setsar last: scaling for a zoom changes the pixel shape, and concat wants every part the same.
    parts.push(`[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS,scale=${width}:${height}:flags=bicubic${zoom},setsar=1[v${i}]`);
    if (hasAudio) {
      const len = k.end - k.start;
      const fade = Math.min(0.012, len / 4).toFixed(3);
      parts.push(`[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, len - Number(fade)).toFixed(3)}:d=${fade}[a${i}]`);
    }
    joins.push(hasAudio ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  parts.push(`${joins.join("")}concat=n=${keeps.length}:v=1:a=${hasAudio ? 1 : 0}${hasAudio ? "[vc][ac]" : "[vc]"}`);
  parts.push(`[vc]${assFile ? `ass=${assFile},` : ""}format=yuv420p[vout]`);
  if (hasAudio) parts.push(`[ac]${loudness ? "loudnorm=I=-14:TP=-1.5:LRA=11," : ""}aresample=48000[aout]`);
  return parts.join(";");
}

const even = (n) => Math.ceil(n / 2) * 2;

/* ─────────────────────────────── rules ─────────────────────────────── */

/** What Claude reads before writing edit.json: the rules, the words and the cuts as planned now. */
export function editRules({ words, keeps, duration, quiet, level, edit }) {
  const cut = round2(duration - keptSeconds(keeps));
  const lines = [
    "EDIT RULES: write edit.json in the project folder (every key is optional; leave one out for its default).",
    "",
    "{",
    '  "maxGap": 0.25,          pauses longer than this (s) are cut where the sound is also quiet',
    '  "pad": 0.08,             breathing room (s) kept each side of a cut',
    '  "keepPauses": [ ],       word numbers whose FOLLOWING pause stays (a beat for effect, a reaction)',
    '  "maxHold": null,         seconds: no gap between words lasts longer, WHATEVER plays in it (a ringtone, music).',
    '                           Use it when a pause below is still long after the cut and nothing is said in it.',
    '  "zoom": "alternate",     "alternate" | "off" | [1, 1.12, 1, ...] one zoom per kept part (1 = none)',
    '  "zoomAmount": 1.12,      the punch-in for "alternate"',
    '  "zoomFocus": 0.35,       where zooms aim: 0 top, 0.5 centre (faces sit high)',
    '  "captions": { "on": true, "uppercase": true, "wordsPerLine": 3, "maxChars": 16, "font": "Arial Black",',
    '                "size": 62, "color": "#FFFFFF", "highlight": "#FFD400", "y": 0.7 },',
    '  "emphasis": [ ],         word numbers drawn in emphasisColor and popped bigger (default: numbers, money, CTA words)',
    '  "emphasisColor": "#3CFF7A",',
    '  "popups": [ { "word": 0, "text": "SHORT STICKER", "seconds": 1.6, "color": "#FFD400", "textColor": "#111111",',
    '               "y": 0.14, "tilt": -5, "size": 56 } ],   a sticker that pops in when that word is said',
    '  "progressBar": true,',
    '  "loudness": true         level the sound to -14 LUFS (social media loudness)',
    "}",
    "",
    "How to edit well:",
    "- Cut every dead pause; keep a pause only where it lands a joke, a reaction or a reveal (keepPauses).",
    "- Emphasis: 3 to 8 words that carry the message (numbers, prices, the offer, the CTA). Not filler.",
    "- Popups: 1 to 3 short stickers (2-4 words) at the hook and the offer/CTA. Keep them off the face: y 0.1-0.18 for a face-to-camera shot.",
    "- Zoom: alternate is right for a talking head; give a list to punch in harder on the hook or the CTA (1.15-1.25).",
    "- Spoken numbers read better as digits in a sticker (\"$1,000\", \"30 SEC\").",
    "",
    `NOW: ${duration.toFixed(2)} s -> ${keptSeconds(keeps).toFixed(2)} s (${cut.toFixed(2)} s of pauses cut, ${keeps.length} parts, quiet below ${level} dB, ${quiet.length} quiet stretches measured)`,
    `EDIT.JSON: ${edit ? "present" : "none yet (defaults)"}`,
    "",
    "WORDS (number  start-end s  text; * = off-screen voice; the gap after a word is shown when it is cut):",
  ];
  const cutAfter = new Map();
  for (let i = 0; i < (words?.length ?? 0) - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    const before = b.start - a.end;
    const after = remap(b.start, keeps) - remap(a.end, keeps);
    if (before - after > 0.05) cutAfter.set(a.i, `   [pause ${before.toFixed(2)} s -> ${after.toFixed(2)} s]`);
  }
  for (const w of words ?? []) {
    lines.push(`  ${String(w.i).padStart(3)}  ${w.start.toFixed(2).padStart(6)}-${w.end.toFixed(2).padEnd(6)} ${w.offScreen ? "*" : " "}${w.text}${cutAfter.get(w.i) ?? ""}`);
  }
  return lines.join("\n");
}
