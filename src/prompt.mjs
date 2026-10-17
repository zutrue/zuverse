/**
 * The ad's plan -> the Seedance 2.5 prompt.
 *
 * Zuverse makes one of two things from an existing ad:
 *  - "replace" (Replace the person): the ad almost shot for shot with a
 *    different person, product or brand. The source clip rides along as
 *    @Video1 (motion, timing, camera), the cast photos ride along as
 *    @Image1..N, and this prompt says what to keep and what to swap.
 *  - "new" (Make a new version): the same ad filmed fresh, shot for shot. The
 *    source clip is never sent, so the prompt carries a shot list (hard cuts at
 *    the same moments, the same framing, camera and action), and each shot
 *    points at its own reference frame: drawn new, with new people in a new
 *    place of the same kind.
 *
 * The voice is a separate choice: "original" leaves the source soundtrack to
 * the model (it copies a reference video's sound); "new" sends the reference
 * muted and adds a VOICE section so the new person speaks in a voice of their
 * own. `applyVoicePlan` rewrites that section once more is known (the voice
 * read from the cast photo, who says which line).
 *
 * This is the same prompt builder the Zuops Video Ad Copier uses.
 * Pure module: no I/O.
 */

/**
 * @typedef {object} RecreationShot
 * @property {string} time_range e.g. "0-3s"
 * @property {string} shot_type "medium close-up", "wide", "insert"
 * @property {string} camera handheld push-in, static tripod, slow pan...
 * @property {string} subject_action exactly what the subject does
 * @property {string} setting what is in frame
 * @property {string} [dialogue] words spoken in this shot
 * @property {string} [on_screen_text] text burned into the frame (left out unless kept)
 * @property {number} [start] measured shot start, seconds
 * @property {number} [end] measured shot end, seconds
 * @property {string} [framing] angle, distance, what fills the frame
 * @property {string} [lighting]
 * @property {boolean} [person] a person is on camera in this shot
 * @property {boolean} [graphic] a designed graphic or end card (dropped from a new version)
 * @property {number} [frame_ref] 1-based @Image number of this shot's reference frame
 */

/**
 * @typedef {object} RecreationAnalysis
 * @property {string} video_type "ugc_speaker" | "showcase" | "mixed"
 * @property {string} industry
 * @property {string} product_or_service
 * @property {number} duration_seconds_estimate
 * @property {string} hook
 * @property {string} original_script
 * @property {string} [adapted_script]
 * @property {string} [condensed_script]
 * @property {string[]} brand_mentions
 * @property {string[]} on_screen_text
 * @property {{demographics: string, attire: string, expression: string}} subject_reference
 * @property {{location: string, details: string, weather_lighting: string}} environment
 * @property {RecreationShot[]} shots
 * @property {string} visual_style
 * @property {{voice_style: string, background_audio: string}} audio_guidelines
 * @property {string[]} key_hooks
 */

export function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

const NO_SCRIPT = /^(|none|n\/a|no dialogue|no script|no spoken|no spoken dialogue)$/i;

export function hasSpokenScript(script) {
  const s = String(script ?? "").trim();
  return !!s && !NO_SCRIPT.test(s);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swap (or strip) brand names in the dialogue. Brand mentions come from the
 * read; the name is substituted in place, or taken out when the brand is
 * removed (see withoutBrand).
 */
export function adaptScriptForBrand(script, brandMentions, companyName, removeBranding) {
  let out = String(script ?? "");
  const mentions = (brandMentions ?? [])
    .map((m) => String(m ?? "").trim())
    .filter((m) => m.length >= 2)
    // longest first so "Acme Roofing" is replaced before "Acme"
    .sort((a, b) => b.length - a.length);
  if (!mentions.length) return out;
  const company = companyName?.trim();
  if (!company && !removeBranding) return out;
  for (const m of mentions) {
    out = company ? out.replace(new RegExp(`\\b${escapeRegExp(m)}\\b`, "gi"), company) : withoutBrand(out, escapeRegExp(m));
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

const SENTENCE_START = String.raw`(^|[.!?]\s+)`;
const CLAUSE_END = String.raw`(?=[.,!?;:]|\s*$)`;
const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * One brand (a regex source) taken out of the dialogue so every line still
 * reads: a name said on its own as a phone greeting goes ("Acme. How can I
 * help?" -> "How can I help?", "thanks for calling Acme." -> "thanks for
 * calling."), "Acme's" becomes "our", and anywhere else the name becomes "us".
 */
function withoutBrand(text, m) {
  if (!new RegExp(String.raw`\b${m}`, "i").test(text)) return text;
  return text
    .replace(new RegExp(String.raw`\bcalling\s+${m}${CLAUSE_END}`, "gi"), "calling")
    .replace(new RegExp(String.raw`\b(welcome|here)\s+(?:to|at)\s+${m}${CLAUSE_END}`, "gi"), "$1")
    .replace(new RegExp(String.raw`\b(?:this is|you've reached|you have reached)\s+${m}${CLAUSE_END}`, "gi"), "")
    .replace(new RegExp(String.raw`${SENTENCE_START}${m}(?:[.,!?;:]+\s*|\s*$)(\p{Ll}?)`, "giu"), (_, lead, next) => lead + next.toUpperCase())
    .replace(new RegExp(String.raw`,\s*${m}(?=[.!?]|\s*$)`, "gi"), "")
    .replace(new RegExp(String.raw`\b${m}['’]s\b`, "gi"), (_, at, all) => (/(^|[.!?]\s+)$/.test(all.slice(0, at)) ? "Our" : "our"))
    .replace(new RegExp(String.raw`\b${m}\b`, "gi"), "us")
    // The punctuation a removed name leaves behind: "Hi, .", "Hi! ." and a leading ", how".
    .replace(/,\s*(?=[.!?])/g, "")
    .replace(/([.!?])(?:\s+[.!?])+/g, "$1")
    .replace(/(^|[.!?])\s*[,;:]\s*(\p{Ll}?)/gu, (_, end, next) => `${end}${end ? " " : ""}${upperFirst(next)}`);
}

function ratioLabel(aspectRatio) {
  if (aspectRatio === "landscape" || aspectRatio === "16:9") return "horizontal 16:9";
  if (aspectRatio === "square" || aspectRatio === "1:1") return "square 1:1";
  return "vertical 9:16";
}

function clean(s, max = 400) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** clean() without a trailing full stop, for text that gets one added. */
function bare(s, max = 400) {
  return clean(s, max).replace(/[.\s]+$/, "");
}

/** Like clean() but keeps the line breaks (a direction can be a list). */
function cleanBlock(s, max = 2000) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, max);
}

/* ─────────────────────────── text on the video ──────────────────────────── */

/**
 * The strict "no text on the video" instruction. AI video misspells captions
 * and on-screen words, so it is added unless text is switched on.
 */
export const NO_TEXT_OVERLAY_RULES = `\n\nOn-screen Text Rules (visuals only, audio is NOT affected):\n- No text overlays.\n- No captions.\n- No subtitles.\n- No graphics.\n- No headline text.\n- No price text on screen.\n- No CTA text on screen.\n- No animated words on screen.\n- No floating text boxes.\n- No logos added on screen.\n- No written words rendered on screen, except natural branding already physically present in the real-world scene.\n- IMPORTANT: These rules restrict VISIBLE written text only. Spoken dialogue, voiceover, and lip-synced speech MUST still be generated and clearly audible. Keep the character talking out loud with natural, audible voice.`;

/** The strict "no background music" instruction. */
export const NO_BACKGROUND_MUSIC_RULES = `\n\nAudio Rules (strict):\n- No background music.\n- No instrumental score, soundtrack, or musical bed.\n- No ambient music, lo-fi beats, or stingers.\n- No sound effects mixed under dialogue.\n- Do NOT mute or remove the speaker's voice: spoken dialogue and voiceover must remain present and clearly audible at full level.\n- Audio should contain ONLY the speaker's natural voice (and necessary ambient room tone). Keep it clean, dry, and music-free.`;

function withoutBlock(prompt, block) {
  const text = String(prompt ?? "");
  const body = block.trim();
  if (!text.includes(body)) return text;
  return text.split(block).join("").split(body).join("").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

/** The prompt with the strict no-text instruction exactly once, at the end (on), or without it (off). Idempotent. */
export function withNoTextRules(prompt, on) {
  const text = withoutBlock(prompt, NO_TEXT_OVERLAY_RULES);
  return on && text.trim() ? `${text}${NO_TEXT_OVERLAY_RULES}` : text;
}

/** The same for the strict no-music instruction. */
export function withNoMusicRules(prompt, on) {
  const text = withoutBlock(prompt, NO_BACKGROUND_MUSIC_RULES);
  return on && text.trim() ? `${text}${NO_BACKGROUND_MUSIC_RULES}` : text;
}

const ON_SCREEN_TEXT_FIELDS = [
  "on_screen_text",
  "onScreenText",
  "caption",
  "captions",
  "caption_text",
  "overlay",
  "overlays",
  "overlay_text",
  "text_overlay",
  "text_overlays",
  "text_card",
  "title_card",
  "lower_third",
  "lower_thirds",
];
const SHOT_LISTS = ["shots", "scene_breakdown", "timeline_sequence", "condensed_timeline"];

/**
 * The plan with no text on the video: every shot's on-screen text, caption,
 * overlay and text-card fields taken out. The ad-level `on_screen_text` list
 * stays (it only tells the model the original's text is left out).
 */
export function stripOnScreenText(analysis) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return analysis;
  const out = { ...analysis };
  for (const key of SHOT_LISTS) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((s) => {
      if (!s || typeof s !== "object") return s;
      const shot = { ...s };
      for (const f of ON_SCREEN_TEXT_FIELDS) delete shot[f];
      return shot;
    });
  }
  return out;
}

export function planHasOnScreenText(analysis) {
  return (analysis?.shots ?? []).some((s) => !!String(s?.on_screen_text ?? "").trim());
}

const ON_SCREEN_TEXT_WORDS =
  /\b(captions?|subtitles?|on[- ]?screen (?:text|words?|titles?|graphics?)|text (?:overlays?|cards?|on (?:the )?screen|boxes?)|overlay text|title cards?|lower[- ]thirds?|headline text|super(?:imposed)? text|kinetic (?:text|typography)|end cards?)\b/i;

/** The words ask for (or about) text on screen. */
export function mentionsOnScreenText(s) {
  return ON_SCREEN_TEXT_WORDS.test(String(s ?? ""));
}

/**
 * Whether the copy may show text. `noText` (on unless turned off) wins over
 * everything. Off, the plan's on-screen text goes in when kept, and so does
 * text the direction asked for.
 */
export function videoShowsText(o) {
  if (o.noText) return false;
  return !!o.directionText || (!!o.keepOnScreenText && planHasOnScreenText(o.analysis));
}

/* ─────────────────────────── choices ─────────────────────────────── */

export function copierMode(raw) {
  return raw === "new" ? "new" : "replace";
}

/** "Make a new version" always gets a new voice; otherwise the stated choice, or `fallback`. */
export function copierVoice(raw, mode, fallback = "original") {
  if (mode === "new") return "new";
  return raw === "new" || raw === "original" ? raw : fallback;
}

/** What a render sends: the source only when replacing the person, muted when the voice is new. */
export function copierRenderPlan(o) {
  const sendVideo = o.mode === "replace" && o.hasSourceVideo;
  const newVoice = o.mode === "new" || o.voice === "new";
  return { sendVideo, muteVideo: sendVideo && newVoice, newVoice };
}

/* ─────────────────────────── prompt sections ────────────────────────────── */

const SECTION_HEAD = /^[A-Z][A-Z /()-]{2,}[^\n]*:/;

function promptSections(prompt) {
  const out = [];
  for (const chunk of String(prompt ?? "").replace(/\r\n/g, "\n").split("\n\n")) {
    if (out.length && !SECTION_HEAD.test(chunk)) out[out.length - 1] += `\n\n${chunk}`;
    else out.push(chunk);
  }
  return out;
}

function sectionKey(section) {
  const m = section.match(/^([A-Z][A-Z ]*[A-Z])\s*[(:]/);
  return m ? m[1] : "";
}

/** The DIALOGUE section's text, "" for "DIALOGUE: none", undefined when there is none. */
export function dialogueFromPrompt(prompt) {
  const section = promptSections(prompt).find((s) => sectionKey(s) === "DIALOGUE");
  if (section === undefined) return undefined;
  if (/^DIALOGUE:\s*none/i.test(section)) return "";
  return section.split("\n").slice(1).join("\n").trim();
}

const VOICE_OPENERS = [
  "VOICE: from the very first word",
  "VOICE: the person on screen speaks in their own",
  "VOICE: none (nobody speaks)",
];

/** The VOICE section for a new voice, or "" when there is nothing to say. */
export function voiceSection(v) {
  const desc = clean(v.description, 200).replace(/[."']+$/g, "").replace(/"/g, "'");
  const silent = v.mode === "replace" && v.silentReference;
  if (!v.spoken) {
    return silent
      ? "VOICE: none (nobody speaks). @Video1 is sent without its sound: take only its picture from it and create the audio fresh, the natural sound of the scene."
      : "";
  }
  if (v.mode === "new") {
    return `VOICE: the person on screen speaks in their own natural voice${desc ? `: ${desc}` : ", one that fits them"}.`;
  }
  return (
    `VOICE: from the very first word to the last, the person on screen speaks only in their own new voice${desc ? `: ${desc}` : ", one that fits the new person"}. ` +
    "Never use the voice of the original person in @Video1, not even for the opening line; the original speaker's voice must not be heard anywhere." +
    (silent ? " @Video1 is sent without its sound: take only its picture from it and create all of the audio fresh, the voices plus the natural sound of the scene." : "")
  );
}

/** Who says which line, when more than one voice speaks; "" otherwise. */
export function speakersSection(turns) {
  const lines = (turns ?? [])
    .map((t) => ({ onScreen: t?.onScreen !== false, text: clean(t?.text, 600).replace(/"/g, "'") }))
    .filter((t) => t.text);
  if (lines.length < 2 || !lines.some((t) => !t.onScreen)) return "";
  return (
    "SPEAKERS (the dialogue above is said by more than one person, in this order; only the person on screen is lip-synced):\n" +
    lines
      .map((t) =>
        t.onScreen
          ? `- The person on screen (their voice above): "${t.text}"`
          : `- Another person, off screen (a different voice, heard the way the scene shows, e.g. through a phone speaker on a call): "${t.text}"`,
      )
      .join("\n")
  );
}

/**
 * The prompt with its voice sections matching the plan: with the original
 * voice there are none; with a new voice the VOICE section is written (or
 * rewritten, unless written by hand) and SPEAKERS follows `turns`
 * (undefined leaves it, [] removes it). Everything else is left as it is.
 */
export function applyVoicePlan(prompt, plan) {
  const text = String(prompt ?? "");
  if (!text.trim()) return text;
  const parts = promptSections(text);
  const find = (key) => parts.findIndex((s) => sectionKey(s) === key);
  const newVoice = plan.mode === "new" || plan.voice === "new";
  if (!newVoice) {
    const kept = parts.filter((s) => sectionKey(s) !== "VOICE" && sectionKey(s) !== "SPEAKERS");
    return kept.length === parts.length ? text : kept.join("\n\n");
  }

  // The original's voice character would fight the new voice; the rest of the AUDIO line stays.
  const audioAt = find("AUDIO");
  const audio = audioAt >= 0 ? parts[audioAt].match(/^AUDIO: voice: [^\n]*?(?:; (no background music|background audio: [^\n]*))?\.$/) : null;
  if (audio) {
    if (audio[1]) parts[audioAt] = `AUDIO: ${audio[1]}.`;
    else parts.splice(audioAt, 1);
  }

  const dialogueAt = find("DIALOGUE");
  const spoken = dialogueAt < 0 || !/^DIALOGUE:\s*none/i.test(parts[dialogueAt]);
  const voice = voiceSection({ mode: plan.mode, spoken, description: plan.description, silentReference: plan.silentReference });
  const voiceAt = find("VOICE");
  if (voiceAt >= 0) {
    if (VOICE_OPENERS.some((o) => parts[voiceAt].startsWith(o))) {
      if (voice) parts[voiceAt] = voice;
      else parts.splice(voiceAt, 1);
    }
  } else if (voice) {
    const before = ["DIALOGUE", "SPEAKERS", "AUDIO", "STYLE", "BRANDING", "RULES"].map(find).filter((i) => i > 0);
    parts.splice(before.length ? Math.min(...before) : parts.length, 0, voice);
  }

  if (plan.turns !== undefined) {
    const speakers = speakersSection(plan.turns);
    const speakersAt = find("SPEAKERS");
    if (speakersAt >= 0) {
      if (speakers) parts[speakersAt] = speakers;
      else parts.splice(speakersAt, 1);
    } else if (speakers) {
      const after = find("DIALOGUE") >= 0 ? find("DIALOGUE") : find("VOICE");
      parts.splice(after >= 0 ? after + 1 : parts.length, 0, speakers);
    }
  }
  return parts.join("\n\n");
}

/* ─────────────────────────── the remake's shots ─────────────────────────── */

const round1 = (n) => Math.round(n * 10) / 10;
const sentence = (s) => (s && !/[.!?]$/.test(s) ? `${s}.` : s);

/**
 * The shots a new version films. Graphics and end cards are dropped and the
 * shot before holds instead. Measured shots are laid onto the remake's length
 * in proportion, so a 23 s ad made at 15 s keeps its rhythm.
 */
export function remakeShots(shots, durationSeconds) {
  const usable = (shots ?? []).filter((s) => s && (s.subject_action || s.camera || s.framing));
  const measured = usable.length > 0 && usable.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
  const kept = [];
  for (const s of usable) {
    if (s.graphic) {
      if (kept.length) {
        const prev = kept[kept.length - 1];
        const words = [prev.dialogue, s.dialogue].map((d) => clean(d, 240)).filter(Boolean).join(" ");
        kept[kept.length - 1] = { ...prev, ...(measured ? { end: s.end } : {}), dialogue: words };
      }
      continue;
    }
    // A graphic before the first kept shot: that shot starts at 0 instead.
    kept.push(measured && !kept.length ? { ...s, start: 0 } : { ...s });
  }
  if (!measured || !kept.length) return kept;
  const total = Number(kept[kept.length - 1].end) || durationSeconds;
  const k = total > 0 ? durationSeconds / total : 1;
  return kept.map((s, i) => ({
    ...s,
    start: round1(Number(s.start) * k),
    end: i === kept.length - 1 ? durationSeconds : round1(Number(s.end) * k),
  }));
}

const wordsOf = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);

/**
 * Whether the shots' words are the script being spoken, give or take a word
 * ("30" for "thirty"). The shot map has the ad's words verbatim; the script is
 * often a condensed version of them, and both in one prompt are two scripts.
 */
export function shotsSayScript(shots, script) {
  const a = wordsOf((shots ?? []).map((s) => s?.dialogue ?? "").join(" "));
  const b = wordsOf(script);
  if (!a.length || !b.length) return false;
  // The most words the two share in the same order (longest common subsequence).
  let prev = new Array(b.length + 1).fill(0);
  for (const w of a) {
    const row = [0];
    for (let j = 0; j < b.length; j++) row.push(w === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], row[j]));
    prev = row;
  }
  return (2 * prev[b.length]) / (a.length + b.length) >= 0.85;
}

/** "SHOT 2 (2.3-4.3s), like @Image3: POV. Looking straight down ... Says: "..."" */
function remakeShotLine(s, i, withWords, withText = false) {
  const time = Number.isFinite(s.start) && Number.isFinite(s.end)
    ? `${round1(Number(s.start)).toFixed(1)}-${round1(Number(s.end)).toFixed(1)}s`
    : clean(s.time_range, 12) || "-";
  const bits = [
    clean(s.shot_type, 60),
    clean(s.framing, 300),
    s.camera ? `Camera: ${clean(s.camera, 160)}` : "",
    clean(s.subject_action, 400),
    clean(s.setting, 220),
    s.lighting ? `Light: ${clean(s.lighting, 120)}` : "",
    s.person === false ? "No person on screen in this shot" : "",
  ].filter(Boolean).map(sentence);
  const words = withWords ? clean(s.dialogue, 240) : "";
  const text = withText ? clean(s.on_screen_text, 200).replace(/"/g, "'") : "";
  return `SHOT ${i + 1} (${time})${s.frame_ref ? `, like @Image${s.frame_ref}` : ""}: ${bits.join(" ")}${words ? ` Says: "${words}"` : ""}${text ? ` On-screen text: "${text}"` : ""}`;
}

/* ─────────────────────────── the prompt ─────────────────────────────────── */

/**
 * The prompt the video model receives. Structured, plain ASCII, and explicit
 * about what is copied (shots, timing, motion, pacing, framing, energy) versus
 * what is recast (person, product, brand, setting when asked).
 *
 * @param {RecreationAnalysis} a
 * @param {object} o
 * @param {number} o.durationSeconds
 * @param {string} o.aspectRatio "portrait" | "landscape" | "square"
 * @param {boolean} o.hasReferenceVideo the source clip goes along as @Video1 (never in "new" mode)
 * @param {{index: number, note?: string}[]} [o.referenceImages]
 * @param {string} [o.recastPrompt] the user's own words for what to change (wins over the plan)
 * @param {string[]} [o.directionExtras] concrete instructions worked out from that direction
 * @param {string} [o.companyName]
 * @param {boolean} [o.removeBranding]
 * @param {string} [o.script] the words to speak (defaults to the adapted script)
 * @param {boolean} [o.noText] default true
 * @param {boolean} [o.noMusic]
 * @param {"replace"|"new"} [o.mode]
 * @param {"new"|"original"} [o.voice]
 * @param {boolean} [o.silentReference]
 * @param {boolean} [o.presenterFromFrames] the shot frames already show the presenter (their photo is not sent)
 */
export function buildRecreationPrompt(a, o) {
  const mode = copierMode(o.mode);
  const fresh = mode === "new";
  const hasVideo = !fresh && o.hasReferenceVideo;
  const newVoice = fresh || o.voice === "new";
  const dur = Math.max(4, Math.round(o.durationSeconds));
  const ratio = ratioLabel(o.aspectRatio);
  const refImages = (o.referenceImages ?? []).filter((r) => r && r.index >= 1);
  const script = o.script !== undefined ? o.script : (a.adapted_script || a.condensed_script || "");
  const speaks = hasSpokenScript(script);
  const showcase = a.video_type === "showcase";
  const industry = clean(a.industry, 80) || "this business";
  const product = clean(a.product_or_service, 160);
  const direction = cleanBlock(o.recastPrompt, 2000);
  const noText = o.noText !== false;
  const directionExtras = (o.directionExtras ?? [])
    .map((x) => clean(x, 300))
    .filter((x) => x && !(noText && mentionsOnScreenText(x)))
    .slice(0, 12);
  const directed = !!direction || directionExtras.length > 0;
  const followDirection = directed ? " Where the user's direction below asks for something different, do what it asks." : "";
  const unlessDirected = directed ? " unless the user's direction changes it" : "";

  const lines = [];
  const freshShots = fresh ? remakeShots(a.shots ?? [], dur) : [];
  const shotFrames = freshShots.some((s) => s.frame_ref);

  // ── What to make ──────────────────────────────────────────────────────
  if (fresh) {
    // Copying the original's people or place would make it the same footage,
    // so only the structure carries over; everything seen on screen is new.
    const newPart = showcase
      ? `The place is new: a different real location of the same kind, with its own surroundings${o.companyName ? ", and the brand is new" : ""}.`
      : `Everything on screen is new: every person is a different individual (the presenter and anyone else in a shot)${o.companyName ? ", the brand is new," : ""} and the place is a different real location of the same kind, with its own building, colours, vehicles and props. Nothing may look like the original footage.`;
    lines.push(
      `Create a new ${dur} second ${ratio} video ad for ${industry}${product ? ` (${product})` : ""}. It remakes an existing ad shot for shot, filmed fresh${showcase ? "" : " with a new person"}: the same shots in the same order with hard cuts at the same moments, the same framing, camera angles and camera movement, the same kinds of subjects, actions and pacing. ${newPart}${shotFrames ? " Every shot below has its own reference image showing exactly how that shot looks: match its composition, angle, distance, subject, props and colours." : ""}${followDirection}`.replace(/ {2,}/g, " "),
    );
  } else if (hasVideo) {
    lines.push(
      `Recreate @Video1 as a new ${dur} second ${ratio} video ad for ${industry}${product ? ` (${product})` : ""}. Reproduce it shot for shot: the same shot order, timing, camera movement, framing, pacing, gestures, transitions and energy. This is a faithful remake with a new cast and brand, not a loose interpretation.${followDirection}`,
    );
  } else {
    lines.push(
      `Create a ${dur} second ${ratio} video ad for ${industry}${product ? ` (${product})` : ""} that reproduces the reference ad described below shot for shot: the same shot order, timing, camera movement, framing, pacing, gestures and energy.${followDirection}`,
    );
  }

  // ── The user's direction ──────────────────────────────────────────────
  if (directed) {
    const body = [
      direction,
      ...directionExtras.map((x) => `- ${x}`),
      noText && mentionsOnScreenText(direction)
        ? "- Except text: this video has no captions, titles or written words on screen, so any text mentioned above is left out."
        : "",
    ].filter(Boolean).join("\n");
    lines.push(
      `USER DIRECTION (from the person making this ad; carry out every part of it exactly and completely, even where it overrides the plan below):\n${body}`,
    );
  }

  // ── Recast ────────────────────────────────────────────────────────────
  const recast = [];
  const frameRefs = freshShots.map((s) => s.frame_ref).filter((n) => !!n);
  if (fresh && o.presenterFromFrames && frameRefs.length && !showcase) {
    const range = frameRefs.length > 1 ? `@Image${frameRefs[0]} to @Image${frameRefs[frameRefs.length - 1]}` : `@Image${frameRefs[0]}`;
    recast.push(
      `IDENTITY LOCK: the person on camera is the presenter shown in the shot reference images (${range}). Keep exactly that face, hair, skin, build and outfit in every single shot, including shots without a reference image. Anyone else in those images is a different, new person who appears only in their own shot.`,
    );
    if (refImages.length) {
      const tags = refImages.map((r) => `@Image${r.index}${r.note ? ` = ${clean(r.note, 80)}` : ""}`).join("; ");
      recast.push(`The other reference images are shown exactly as they look: ${tags}.`);
    }
  } else if (refImages.length) {
    const tags = refImages.map((r) => `@Image${r.index}${r.note ? ` = ${clean(r.note, 80)}` : ""}`).join("; ");
    recast.push(
      refImages.length > 1
        ? `IDENTITY LOCK: the on-screen cast and props come ONLY from the reference images: ${tags}. Each reference replaces the matching person or product from the original, one for one. Every referenced identity must match its own image exactly (face, hair, skin, build, outfit, colours), stay distinct from the other references, and stay consistent in every shot.`
        : directed && !showcase
          ? `IDENTITY LOCK: the on-screen person comes ONLY from ${tags}. Match that image exactly - same face, hair, skin and build - in every single shot, and keep the outfit and colours from the image unless the user's direction changes them.`
          : `IDENTITY LOCK: the on-screen ${showcase ? "product/space" : "person"} comes ONLY from ${tags}. Match that image exactly - same face, hair, skin, build, outfit and colours - in every single shot.`,
    );
    if (shotFrames && !showcase) {
      recast.push(
        "The shot reference images show each shot's composition and setting; wherever the presenter appears in them it is already this new person, and anyone else in them is already new too.",
      );
    }
    if (hasVideo) {
      recast.push(
        showcase
          ? "CRITICAL: @Video1 supplies shot order, timing, framing, camera motion and pacing ONLY. Do not reproduce the products, packaging or branding shown in @Video1."
          : "CRITICAL: @Video1 supplies shot order, timing, framing, camera motion, gestures, pacing and delivery ONLY. Do NOT reproduce the face, hair, skin tone, body, clothing or identity of anyone appearing in @Video1. Every person visible on screen must come from the reference images above, never from @Video1.",
      );
    }
  } else if (!showcase) {
    const demo = clean(a.subject_reference?.demographics, 160);
    if (fresh) {
      recast.push(
        demo && demo.toLowerCase() !== "none"
          ? `Cast a new person who would believably front this ad, of a similar type (${demo}), but clearly a different individual with their own face, hair and clothes.`
          : "Cast a presenter who fits this business, with natural, confident energy.",
      );
    } else {
      recast.push(
        demo && demo.toLowerCase() !== "none"
          ? `Cast a different but comparable person: ${demo}, ${clean(a.subject_reference?.attire, 120) || "similar attire"}, ${clean(a.subject_reference?.expression, 100) || "same demeanour"}. Do not copy the original person's identity.`
          : "Cast a comparable presenter with the same energy and delivery.",
      );
    }
    if (hasVideo) {
      recast.push(
        "CRITICAL: do not reproduce the face, hair or identity of the person in @Video1 - they are a performance reference only. Copy their shots, timing, framing, motion and delivery, but the presenter on screen must be a clearly different individual with different hair and clothing.",
      );
    }
  }
  if (recast.length) lines.push(`RECAST:\n${recast.join("\n")}`);

  // ── Subject / setting ─────────────────────────────────────────────────
  if (showcase) {
    lines.push(
      `SUBJECT: ${product || "the product or space being showcased"}. Atmosphere: ${clean(a.subject_reference?.expression, 120) || "as in the reference"}.`,
    );
  }
  const env = a.environment ?? { location: "", details: "", weather_lighting: "" };
  const settingBits = [bare(env.location, 200), bare(env.details, 300), bare(env.weather_lighting, 160)].filter(Boolean);
  if (settingBits.length) {
    const kindOnly = fresh ? " (the same kind of place, but a different location: never the original one)" : "";
    lines.push(`SETTING${kindOnly}${directed ? " (unless the user's direction changes it)" : ""}: ${settingBits.join(". ")}.`);
  }

  // ── Shot list ─────────────────────────────────────────────────────────
  const shots = (a.shots ?? []).filter((s) => s && (s.subject_action || s.camera));
  if (fresh) {
    if (freshShots.length) {
      // Words per shot only while the script is the source's own and the shots
      // say it (an edited or condensed script would fight them); the DIALOGUE
      // section always has the words.
      const ownScript = (a.adapted_script || a.condensed_script || "").trim();
      const wordsPerShot = speaks && String(script).trim() === ownScript && shotsSayScript(freshShots, script);
      lines.push(
        `SHOT LIST (${freshShots.length} shot${freshShots.length === 1 ? "" : "s"}, a hard cut between each; follow the order and timing exactly${directed ? "; where the user's direction differs, the direction wins" : ""}):`,
      );
      freshShots.forEach((s, i) => lines.push(remakeShotLine(s, i, wordsPerShot, !noText)));
    }
  } else if (shots.length) {
    lines.push(`SHOT LIST (follow this timing exactly${directed ? "; where the user's direction differs, the direction wins" : ""}):`);
    for (const s of shots) {
      const bits = [clean(s.shot_type, 60), clean(s.camera, 120), clean(s.subject_action, 260), clean(s.setting, 160)].filter(Boolean);
      const dialogue = clean(s.dialogue, 200);
      const text = noText ? "" : clean(s.on_screen_text, 200).replace(/"/g, "'");
      lines.push(`${clean(s.time_range, 12) || "-"}: ${bits.join(". ")}${dialogue && speaks ? ` Says: "${dialogue}"` : ""}${text ? ` On-screen text: "${text}"` : ""}`);
    }
  }

  // ── Voice ─────────────────────────────────────────────────────────────
  if (newVoice) {
    const voice = voiceSection({ mode, spoken: speaks, silentReference: hasVideo && o.silentReference });
    if (voice) lines.push(voice);
  }

  // ── Dialogue ──────────────────────────────────────────────────────────
  if (speaks) {
    lines.push(
      freshShots.some((s) => s.person === false)
        ? `DIALOGUE (the person's own voice, natural delivery: lip-synced while they are on camera, heard as their voiceover over the shots without them; must finish by the final shot):\n${String(script).trim()}`
        : `DIALOGUE (spoken to camera, natural delivery, lip-synced, must finish by the final shot; the speaker closes their mouth and holds a neutral expression afterwards):\n${String(script).trim()}`,
    );
  } else {
    lines.push("DIALOGUE: none. No voiceover, no narration. Visual storytelling with ambient sound.");
  }

  // ── Audio / style ─────────────────────────────────────────────────────
  const audio = a.audio_guidelines ?? { voice_style: "", background_audio: "" };
  const audioBits = [];
  // With a new voice the original's voice character would fight the VOICE section.
  if (speaks && !newVoice && audio.voice_style && audio.voice_style.toLowerCase() !== "none") audioBits.push(`voice: ${clean(audio.voice_style, 120)}`);
  if (o.noMusic) audioBits.push("no background music");
  else if (audio.background_audio) audioBits.push(`background audio: ${bare(audio.background_audio, 160)}${directed ? " (unless the user's direction changes it)" : ""}`);
  if (audioBits.length) lines.push(`AUDIO: ${audioBits.join("; ")}.`);
  if (a.visual_style) {
    lines.push(
      fresh
        ? shotFrames
          ? `STYLE: ${bare(a.visual_style, 240)}. Match the look of the shot reference images: colour, light, lens and camera handling${unlessDirected}.`
          : `STYLE: ${bare(a.visual_style, 240)}. The same look and feel as the original, filmed fresh${unlessDirected}.`
        : `STYLE: ${bare(a.visual_style, 240)}. Match the reference's colour grade, lens feel and camera handling${directed ? " unless the user's direction changes them" : ""}.`,
    );
  }

  // ── Branding ──────────────────────────────────────────────────────────
  const mentions = (a.brand_mentions ?? []).map((m) => clean(m, 60)).filter(Boolean);
  if (o.companyName?.trim()) {
    lines.push(
      `BRANDING: this ad is for ${clean(o.companyName, 80)}. ${mentions.length ? `Every mention of ${mentions.join(", ")} becomes ${clean(o.companyName, 80)}. ` : ""}No logos, uniforms, signage or packaging from the original brand may appear.`,
    );
  } else if (o.removeBranding) {
    lines.push(
      `BRANDING: brand-neutral. ${mentions.length ? `Do not say or show ${mentions.join(", ")}. ` : ""}No logos, signage, uniforms or packaging with any brand name.`,
    );
  }

  // ── Hard rules ────────────────────────────────────────────────────────
  // Framing comes from the shots; the only rule is not to cut the person's face off.
  const rules = [
    `Total runtime ${dur} seconds, ${ratio} framing${showcase ? "" : ", and whenever the person is on camera their whole face stays in frame"}.`,
  ];
  if (freshShots.length > 1) {
    const cutTimes = freshShots.slice(1).map((s) => s.start).filter((t) => Number.isFinite(t));
    rules.push(
      `${freshShots.length} shots with a hard cut at each listed time${cutTimes.length === freshShots.length - 1 ? ` (cuts at exactly ${cutTimes.map((t) => `${t.toFixed(1)}s`).join(", ")})` : ""}; never merge shots, skip one, hold one longer or add new ones.`,
    );
  }
  if (noText) {
    rules.push(
      `No text, captions, subtitles, titles, logos, watermarks or on-screen overlays of any kind${(a.on_screen_text ?? []).length ? " (the original's on-screen text is deliberately omitted)" : ""}.`,
    );
    if (hasVideo) {
      rules.push(
        "@Video1 may have captions, subtitles, titles, stickers, prices or other words burned into its frames: never copy them. Make every frame clean, showing what is behind the text, with no written words anywhere.",
      );
    }
  }
  rules.push("Photoreal, consistent identity and wardrobe across all shots, no morphing, no extra limbs, hands and faces stay natural.");
  if (refImages.length && hasVideo) {
    rules.push(
      refImages.length > 1
        ? "CRITICAL: every on-screen person and product comes from the reference images; nobody from @Video1 may be reproduced - @Video1 is motion and timing reference only."
        : "CRITICAL: the on-screen subject is the person in the reference image; the person in @Video1 must not be reproduced - @Video1 is motion and timing reference only.",
    );
  }
  lines.push(`RULES:\n- ${rules.join("\n- ")}`);

  return lines.join("\n\n");
}

/** How many words fit a runtime at a conversational ~2.4 words/s. */
export function wordBudget(durationSeconds) {
  const d = Math.max(4, durationSeconds);
  return { low: Math.round(d * 1.8), high: Math.round(d * 2.4), cap: Math.floor(d * 2.7) };
}

/**
 * Seedance reads reference assets best when the prompt names them (@Image1,
 * @Video1); hints go in front when the prompt has none.
 */
export function withSeedanceReferenceHints(prompt, refs) {
  const hints = [];
  if (refs.images > 0 && !/@Image\d/i.test(prompt)) {
    hints.push("Use @Image1 as the visual appearance reference for the on-screen subject (face, hair, skin, outfit).");
  }
  if (refs.videos > 0 && !/@Video\d/i.test(prompt)) hints.push("Follow @Video1 for motion, pacing, and camera feel.");
  return hints.length ? `${hints.join(" ")}\n\n${prompt}` : prompt;
}
