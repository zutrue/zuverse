// Ported from the Zuops Video Ad Copier tests.
// Not ported (not in src/prompt.mjs): copierCredits pricing tests, and the
// "worker and app copies are identical" check.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adaptScriptForBrand,
  applyVoicePlan,
  buildRecreationPrompt,
  copierMode,
  copierRenderPlan,
  copierVoice,
  dialogueFromPrompt,
  mentionsOnScreenText,
  NO_BACKGROUND_MUSIC_RULES,
  NO_TEXT_OVERLAY_RULES,
  planHasOnScreenText,
  remakeShots,
  shotsSayScript,
  speakersSection,
  stripOnScreenText,
  videoShowsText,
  voiceSection,
  withNoMusicRules,
  withNoTextRules,
} from "../src/prompt.mjs";

const includes = (actual, expected, msg) =>
  assert.ok(String(actual).includes(expected), msg ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);

const analysis = {
  video_type: "ugc_speaker",
  industry: "Flooring",
  product_or_service: "hardwood floor installation",
  duration_seconds_estimate: 20,
  hook: "Kneeling on an old carpet with new wood samples",
  original_script: "This carpet is twenty years old. FloorCo put these floors in for me in two days.",
  adapted_script: "This carpet is twenty years old. FloorCo put these floors in for me in two days.",
  brand_mentions: ["FloorCo"],
  on_screen_text: ["20 YEARS OLD"],
  subject_reference: { demographics: "woman in her 30s, brown hair in a bun", attire: "grey hoodie", expression: "warm, excited" },
  environment: { location: "living room", details: "worn beige carpet, white walls, window with blinds", weather_lighting: "soft daylight from the left" },
  shots: [
    { time_range: "0-4s", shot_type: "medium", camera: "handheld, slight push-in", subject_action: "kneels on the carpet holding up two wood samples", setting: "living room floor", dialogue: "This carpet is twenty years old." },
    { time_range: "4-20s", shot_type: "close-up", camera: "static", subject_action: "lays a sample on the carpet and smiles at the camera", setting: "carpet", dialogue: "FloorCo put these floors in for me in two days." },
  ],
  visual_style: "smartphone UGC, handheld",
  audio_guidelines: { voice_style: "female, warm, conversational", background_audio: "quiet room tone" },
  key_hooks: ["before/after"],
};

const base = { durationSeconds: 20, aspectRatio: "portrait", hasReferenceVideo: true, script: analysis.adapted_script, noText: true };

test("mode and voice parsing: unknown values keep today's behaviour, a new version always gets a new voice", () => {
  assert.deepStrictEqual(copierMode("new"), "new");
  assert.deepStrictEqual(copierMode("replace"), "replace");
  assert.deepStrictEqual(copierMode(undefined), "replace");
  assert.deepStrictEqual(copierMode("anything"), "replace");
  assert.deepStrictEqual(copierVoice(undefined, "replace"), "original");
  assert.deepStrictEqual(copierVoice(undefined, "replace", "new"), "new");
  assert.deepStrictEqual(copierVoice("original", "replace", "new"), "original");
  assert.deepStrictEqual(copierVoice("new", "replace"), "new");
  assert.deepStrictEqual(copierVoice("original", "new"), "new");
});

test("render plan: replace sends the video (muted for a new voice); a new version never sends it", () => {
  assert.deepStrictEqual(copierRenderPlan({ mode: "replace", voice: "new", hasSourceVideo: true }), { sendVideo: true, muteVideo: true, newVoice: true });
  assert.deepStrictEqual(copierRenderPlan({ mode: "replace", voice: "original", hasSourceVideo: true }), { sendVideo: true, muteVideo: false, newVoice: false });
  assert.deepStrictEqual(copierRenderPlan({ mode: "new", voice: "original", hasSourceVideo: true }), { sendVideo: false, muteVideo: false, newVoice: true });
  assert.deepStrictEqual(copierRenderPlan({ mode: "replace", voice: "new", hasSourceVideo: false }), { sendVideo: false, muteVideo: false, newVoice: true });
});

test("replace + original voice is today's prompt: no VOICE section, voice style kept", () => {
  const p = buildRecreationPrompt(analysis, base);
  assert.ok(p.startsWith("Recreate @Video1 as a new 20 second vertical 9:16 video ad"));
  assert.ok(!p.includes("VOICE:"));
  includes(p, "AUDIO: voice: female, warm, conversational; background audio: quiet room tone.");
  includes(p, "SHOT LIST (follow this timing exactly):");
  includes(p, "worn beige carpet");
  // The explicit "original" choice is the same prompt as saying nothing.
  assert.deepStrictEqual(buildRecreationPrompt(analysis, { ...base, mode: "replace", voice: "original" }), p);
});

test("replace + new voice: VOICE before the dialogue, sent silent, the original voice character dropped", () => {
  const p = buildRecreationPrompt(analysis, { ...base, voice: "new", silentReference: true });
  assert.ok(p.startsWith("Recreate @Video1"));
  const voiceAt = p.indexOf("VOICE: from the very first word to the last");
  assert.ok(voiceAt > 0 && voiceAt < p.indexOf("DIALOGUE ("));
  includes(p, "one that fits the new person");
  includes(p, "@Video1 is sent without its sound");
  assert.ok(!p.includes("voice: female"));
  includes(p, "AUDIO: background audio: quiet room tone.");
  // The words stay the script shown in the plan.
  assert.deepStrictEqual(dialogueFromPrompt(p), analysis.adapted_script);
});

test("make a new version: no @Video1, the ad's own shots with their camera, framing and setting", () => {
  const p = buildRecreationPrompt(analysis, { ...base, mode: "new", referenceImages: [{ index: 1, note: "the new presenter" }] });
  assert.ok(!p.includes("@Video1"), p);
  assert.ok(p.startsWith("Create a new 20 second vertical 9:16 video ad for Flooring (hardwood floor installation). It remakes an existing ad shot for shot, filmed fresh with a new person"));
  assert.ok(!p.includes("your own camera angles"), "no longer asks for its own angles");
  assert.ok(!p.includes("STORY BEATS"));
  includes(p, "SHOT LIST (2 shots, a hard cut between each; follow the order and timing exactly):");
  includes(p, 'SHOT 1 (0-4s): medium. Camera: handheld, slight push-in. kneels on the carpet holding up two wood samples. living room floor. Says: "This carpet is twenty years old."');
  includes(p, "SETTING (the same kind of place, but a different location: never the original one): living room. worn beige carpet, white walls, window with blinds. soft daylight from the left.");
  includes(p, "every person is a different individual (the presenter and anyone else in a shot)");
  assert.ok(!p.includes("Only the person"), "a new version changes the place too");
  includes(p, "IDENTITY LOCK: the on-screen person comes ONLY from @Image1 = the new presenter.");
  includes(p, "VOICE: the person on screen speaks in their own natural voice, one that fits them.");
  includes(p, "The same look and feel as the original, filmed fresh.");
  assert.ok(!p.includes("waist-up"), "framing comes from the shots, not a fixed rule");
  includes(p, "whenever the person is on camera their whole face stays in frame");
  assert.deepStrictEqual(dialogueFromPrompt(p), analysis.adapted_script);
  // A new version ignores hasReferenceVideo and the voice choice.
  assert.deepStrictEqual(buildRecreationPrompt(analysis, { ...base, mode: "new", voice: "original", hasReferenceVideo: false, referenceImages: [{ index: 1, note: "the new presenter" }] }), p);
});

test("a measured shot plan: exact cuts, each shot on its own reference frame, end card dropped", () => {
  const script = "Come and join me for 30 seconds cleaning some air ducts. All done.";
  const planned = {
    ...analysis,
    adapted_script: script,
    shots: [
      { time_range: "0-2.3s", start: 0, end: 2.3, shot_type: "selfie", framing: "low angle up at the man and the vent", camera: "handheld selfie", subject_action: "Man: points up at the vent", setting: "white ceiling", lighting: "bright indoor", person: true, dialogue: "Come and join me for 30", frame_ref: 2 },
      { time_range: "2.3-12s", start: 2.3, end: 12, shot_type: "POV", framing: "straight down a round flexible duct", camera: "push in", subject_action: "Duct: the brush spins, dust comes loose", setting: "grey dusty duct", lighting: "camera light", person: false, dialogue: "seconds cleaning some air ducts.", frame_ref: 3 },
      { time_range: "12-20s", start: 12, end: 20, shot_type: "wide", framing: "full screen graphic", camera: "static", subject_action: "Logo card", setting: "graphic", person: false, graphic: true, dialogue: "All done." },
    ],
  };
  const p = buildRecreationPrompt(planned, { ...base, durationSeconds: 10, script, mode: "new", referenceImages: [{ index: 1, note: "the person on camera" }] });
  includes(p, "Every shot below has its own reference image showing exactly how that shot looks");
  includes(p, "SHOT LIST (2 shots, a hard cut between each");
  // 20 s of source laid onto 10 s; the end card's time and words go to the shot before it.
  includes(p, "SHOT 1 (0.0-1.2s), like @Image2: selfie. low angle up at the man and the vent. Camera: handheld selfie.");
  includes(p, "SHOT 2 (1.2-10.0s), like @Image3: POV.");
  includes(p, 'No person on screen in this shot. Says: "seconds cleaning some air ducts. All done."');
  assert.ok(!p.includes("Logo card"), "the graphic is left out");
  includes(p, "heard as their voiceover over the shots without them");
  includes(p, "wherever the presenter appears in them it is already this new person, and anyone else in them is already new too");
  includes(p, "Match the look of the shot reference images");
  includes(p, "2 shots with a hard cut at each listed time (cuts at exactly 1.2s); never merge shots, skip one, hold one longer or add new ones.");
  // An edited script drops the per-shot words (they would fight it); DIALOGUE carries the new ones.
  const edited = buildRecreationPrompt(planned, { ...base, durationSeconds: 10, script: "Something else entirely.", mode: "new" });
  assert.ok(!edited.includes("Says:"), edited);
  assert.deepStrictEqual(dialogueFromPrompt(edited), "Something else entirely.");
});

test("remakeShots: proportional timing, graphics folded into the shot before", () => {
  const out = remakeShots(
    [
      { time_range: "", start: 0, end: 2, shot_type: "a", camera: "c", subject_action: "x", setting: "" },
      { time_range: "", start: 2, end: 8, shot_type: "b", camera: "c", subject_action: "y", setting: "" },
      { time_range: "", start: 8, end: 10, shot_type: "g", camera: "c", subject_action: "card", setting: "", graphic: true },
    ],
    20,
  );
  assert.deepStrictEqual(out.map((s) => [s.start, s.end]), [[0, 4], [4, 20]]);
  // A graphic first: the next shot starts at 0.
  const lead = remakeShots(
    [
      { time_range: "", start: 0, end: 1, shot_type: "g", camera: "", subject_action: "title", setting: "", graphic: true },
      { time_range: "", start: 1, end: 5, shot_type: "a", camera: "c", subject_action: "x", setting: "" },
    ],
    5,
  );
  assert.deepStrictEqual(lead.map((s) => [s.start, s.end]), [[0, 5]]);
  // Unmeasured shots keep their text time ranges.
  assert.deepStrictEqual(remakeShots(analysis.shots, 20).map((s) => s.time_range), ["0-4s", "4-20s"]);
});

test("make a new version without photos casts a different person of a similar type", () => {
  const p = buildRecreationPrompt(analysis, { ...base, mode: "new" });
  includes(p, "Cast a new person who would believably front this ad, of a similar type (woman in her 30s, brown hair in a bun)");
  assert.ok(!p.includes("CRITICAL: do not reproduce"));
});

test("no spoken script: no VOICE section unless the reference goes silent", () => {
  const silentAd = { ...base, script: "" };
  assert.ok(!buildRecreationPrompt(analysis, { ...silentAd, mode: "new" }).includes("VOICE:"));
  assert.ok(!buildRecreationPrompt(analysis, { ...silentAd, voice: "new" }).includes("VOICE:"));
  includes(buildRecreationPrompt(analysis, { ...silentAd, voice: "new", silentReference: true }), "VOICE: none (nobody speaks). @Video1 is sent without its sound");
});

test("voice plan: fills in the read voice and who says what, idempotent, keeps hand-written voices", () => {
  const p = buildRecreationPrompt(analysis, { ...base, voice: "new", silentReference: true });
  const turns = [
    { onScreen: true, text: "This carpet is twenty years old." },
    { onScreen: false, text: "FloorCo put these floors in for me in two days." },
  ];
  const plan = { mode: "replace", voice: "new", description: "a man in his early 30s with a warm voice.", silentReference: true, turns };
  const out = applyVoicePlan(p, plan);
  includes(out, "speaks only in their own new voice: a man in his early 30s with a warm voice. Never use");
  includes(out, "SPEAKERS (the dialogue above is said by more than one person");
  assert.ok(out.indexOf("SPEAKERS") > out.indexOf("DIALOGUE ("), "speakers follow the dialogue");
  assert.deepStrictEqual(applyVoicePlan(out, plan), out);
  // The words are still read back from the DIALOGUE section alone.
  assert.deepStrictEqual(dialogueFromPrompt(out), analysis.adapted_script);
  // Muting failed: the "without its sound" line goes, the rest stays.
  const loud = applyVoicePlan(out, { ...plan, silentReference: false });
  assert.ok(!loud.includes("without its sound"));
  includes(loud, "a man in his early 30s");
  // No second voice found: SPEAKERS removed; undefined turns leave it alone.
  assert.ok(!applyVoicePlan(out, { ...plan, turns: [] }).includes("SPEAKERS"));
  includes(applyVoicePlan(out, { ...plan, turns: undefined }), "SPEAKERS");
  // Keep the original audio: every voice section goes, the rest is untouched.
  const stripped = applyVoicePlan(out, { mode: "replace", voice: "original" });
  assert.ok(!stripped.includes("VOICE:") && !stripped.includes("SPEAKERS"));
  assert.deepStrictEqual(stripped, p.replace(/\n\nVOICE: [^\n]*/, ""));
  // A VOICE line the user wrote is theirs.
  const custom = out.replace(/^VOICE: [^\n]*/m, "VOICE: a deep Texan drawl.");
  includes(applyVoicePlan(custom, plan), "VOICE: a deep Texan drawl.");
});

test("voice plan turns an older prompt into the new-voice prompt, leaving the rest as it was", () => {
  const old = buildRecreationPrompt(analysis, base);
  const out = applyVoicePlan(old, { mode: "replace", voice: "new", silentReference: true });
  assert.ok(out.indexOf("VOICE: from the very first word") < out.indexOf("DIALOGUE ("));
  // Exactly what the builder writes for a new voice: the original's voice character is dropped from AUDIO.
  assert.deepStrictEqual(out, buildRecreationPrompt(analysis, { ...base, voice: "new", silentReference: true }));
  assert.deepStrictEqual(
    out.replace(/\n\nVOICE: [^\n]*/, "").replace("AUDIO: background audio: quiet room tone.", "AUDIO: voice: female, warm, conversational; background audio: quiet room tone."),
    old,
  );
  // An AUDIO line that only held the voice goes; one with music settings keeps them.
  const noBg = { ...analysis, audio_guidelines: { voice_style: "male, gravelly", background_audio: "" } };
  assert.ok(!applyVoicePlan(buildRecreationPrompt(noBg, base), { mode: "replace", voice: "new" }).includes("AUDIO:"));
  includes(
    applyVoicePlan(buildRecreationPrompt(analysis, { ...base, noMusic: true }), { mode: "replace", voice: "new" }),
    "AUDIO: no background music.",
  );
  // Prompts without a DIALOGUE section still get a voice line (appended before RULES or at the end).
  includes(applyVoicePlan("Make a video of a plumber.", { mode: "new", voice: "new" }), "Make a video of a plumber.\n\nVOICE: the person on screen");
  assert.deepStrictEqual(applyVoicePlan("", { mode: "new", voice: "new" }), "");
});

test("sections: one voice, a second voice, and the dialogue reader", () => {
  assert.deepStrictEqual(speakersSection([{ onScreen: true, text: "Hi" }]), "");
  assert.deepStrictEqual(speakersSection([{ onScreen: true, text: "Hi" }, { onScreen: true, text: "there" }]), "");
  includes(speakersSection([{ onScreen: true, text: 'He said "hi"' }, { onScreen: false, text: "Hello?" }]), `"He said 'hi'"`);
  assert.deepStrictEqual(voiceSection({ mode: "new", spoken: false }), "");
  assert.deepStrictEqual(dialogueFromPrompt("Something\n\nDIALOGUE: none. No voiceover."), "");
  assert.deepStrictEqual(dialogueFromPrompt("Something with no dialogue section"), undefined);
  assert.deepStrictEqual(dialogueFromPrompt("A\n\nDIALOGUE (x):\nLine one.\n\nLine two.\n\nRULES:\n- r"), "Line one.\n\nLine two.");
});

test("the user's direction leads the prompt, whole, and the keep-it-the-same lines yield to it", () => {
  const direction = "Film it in a bright showroom instead of a living room.\nMake the ending mention our $49 tune-up special.\nUpbeat music.";
  for (const mode of ["new", "replace"]) {
    const p = buildRecreationPrompt(analysis, {
      ...base,
      mode,
      voice: "new",
      recastPrompt: direction,
      directionExtras: ["Close on the presenter pointing at the $49 sign."],
      referenceImages: [{ index: 1, note: "the person on camera" }],
    });
    const sections = p.split("\n\n");
    // Right after the opening paragraph, with its line breaks kept.
    assert.deepStrictEqual(sections[1].split("\n")[0].startsWith("USER DIRECTION"), true, mode);
    includes(p, "Make the ending mention our $49 tune-up special.\nUpbeat music.");
    includes(p, "- Close on the presenter pointing at the $49 sign.");
    includes(sections[0], "Where the user's direction below asks for something different, do what it asks.");
    // No longer buried in the casting notes.
    assert.ok(!p.includes("Direction from the user"), mode);
    includes(p, "(unless the user's direction changes it)");
    includes(p, "where the user's direction differs, the direction wins");
    includes(p, "unless the user's direction changes them");
    includes(p, "background audio: quiet room tone (unless the user's direction changes it)");
  }
  // A long direction is not cut at 600 characters any more.
  const long = "x".repeat(1500);
  includes(buildRecreationPrompt(analysis, { ...base, mode: "new", recastPrompt: long }), long);
});

test("without a direction the prompt is exactly as before", () => {
  const p = buildRecreationPrompt(analysis, { ...base, mode: "new", voice: "new" });
  assert.ok(!p.includes("USER DIRECTION"));
  assert.ok(!p.includes("user's direction"));
  includes(p, "SHOT LIST (2 shots, a hard cut between each; follow the order and timing exactly):");
  includes(p, "STYLE: smartphone UGC, handheld. The same look and feel as the original, filmed fresh.");
  const r = buildRecreationPrompt(analysis, { ...base, referenceImages: [{ index: 1 }] });
  includes(r, "same face, hair, skin, build, outfit and colours");
  includes(r, "SHOT LIST (follow this timing exactly):");
});

test("the voice plan still finds the AUDIO line when a direction softens it", () => {
  const p = buildRecreationPrompt(analysis, { ...base, voice: "original", recastPrompt: "Upbeat music." });
  const out = applyVoicePlan(p, { mode: "replace", voice: "new" });
  includes(out, "AUDIO: background audio: quiet room tone (unless the user's direction changes it).");
  assert.ok(!out.includes("voice: female, warm"));
});

test("no text: the strict rules go on once, come off when off, and never on an empty prompt", () => {
  const p = "Recreate @Video1.\n\nRULES:\n- Total runtime 20 seconds.";
  const on = withNoTextRules(p, true);
  assert.ok(on.endsWith(NO_TEXT_OVERLAY_RULES));
  includes(on, "- No captions.");
  includes(on, "Spoken dialogue, voiceover, and lip-synced speech MUST still be generated");
  assert.deepStrictEqual(withNoTextRules(on, true), on, "idempotent");
  assert.deepStrictEqual(withNoTextRules(on, false), p);
  assert.deepStrictEqual(withNoTextRules(p, false), p);
  assert.deepStrictEqual(withNoTextRules("", true), "");
  // Text then music, in any order of application, each exactly once.
  const both = withNoMusicRules(withNoTextRules(p, true), true);
  assert.deepStrictEqual(withNoMusicRules(withNoTextRules(both, true), true), both);
  assert.deepStrictEqual(both.split("On-screen Text Rules").length, 2);
  assert.deepStrictEqual(both.split("Audio Rules (strict)").length, 2);
  assert.ok(both.endsWith(NO_BACKGROUND_MUSIC_RULES));
  // A stored prompt that already had them somewhere else still gets them once.
  assert.deepStrictEqual(withNoTextRules(`${p}${NO_TEXT_OVERLAY_RULES}\n\nVOICE: new.`, true).split("On-screen Text Rules").length, 2);
});

test("no text: the plan loses every shot's on-screen text, the read keeps the list", () => {
  const withText = {
    ...analysis,
    shots: [{ ...analysis.shots[0], on_screen_text: "20 YEARS OLD", caption: "x", text_overlay: "y" }, analysis.shots[1]],
    timeline_sequence: [{ action: "kneels", caption_text: "SALE" }],
  };
  assert.ok(planHasOnScreenText(withText));
  const clean = stripOnScreenText(withText);
  assert.ok(!planHasOnScreenText(clean));
  assert.deepStrictEqual(Object.keys(clean.shots[0]).filter((k) => /text|caption|overlay/.test(k)), []);
  assert.deepStrictEqual(clean.shots[0].subject_action, analysis.shots[0].subject_action, "the rest of the shot stays");
  assert.deepStrictEqual(clean.timeline_sequence, [{ action: "kneels" }]);
  assert.deepStrictEqual(clean.on_screen_text, ["20 YEARS OLD"]);
  assert.deepStrictEqual(withText.shots[0].on_screen_text, "20 YEARS OLD", "the input is not changed");
  assert.deepStrictEqual(stripOnScreenText(null), null);
});

test("no text: the switch wins; off, the plan's text or the direction's goes in", () => {
  const withText = { shots: [{ on_screen_text: "SALE" }] };
  assert.deepStrictEqual(videoShowsText({ noText: true, keepOnScreenText: true, directionText: true, analysis: withText }), false);
  assert.deepStrictEqual(videoShowsText({ noText: false, keepOnScreenText: true, analysis: withText }), true);
  assert.deepStrictEqual(videoShowsText({ noText: false, keepOnScreenText: false, analysis: withText }), false, "older pages: text only when kept");
  assert.deepStrictEqual(videoShowsText({ noText: false, keepOnScreenText: true, analysis: { shots: [] } }), false, "nothing to show");
  assert.deepStrictEqual(videoShowsText({ noText: false, directionText: true }), true);
  assert.ok(mentionsOnScreenText("Add a caption that says 50% off"));
  assert.ok(mentionsOnScreenText("Put an end card with our phone number"));
  assert.ok(!mentionsOnScreenText("Film it in a bright showroom"));
});

test("no text: the prompt carries no on-screen text, no text extras, and tells Replace mode to drop burned-in words", () => {
  const withText = { ...analysis, shots: [{ ...analysis.shots[0], on_screen_text: "20 YEARS OLD" }, analysis.shots[1]] };
  const extras = ["Add a caption reading OPEN SUNDAYS", "Hold the last shot a beat longer"];
  const off = buildRecreationPrompt(withText, { ...base, directionExtras: extras });
  assert.ok(!off.includes("On-screen text:"));
  assert.ok(!off.includes("OPEN SUNDAYS"));
  includes(off, "- Hold the last shot a beat longer");
  includes(off, "No text, captions, subtitles, titles, logos, watermarks or on-screen overlays of any kind");
  includes(off, "@Video1 may have captions, subtitles, titles, stickers, prices or other words burned into its frames: never copy them.");
  // A direction that asks for text is told it is left out.
  const asked = buildRecreationPrompt(withText, { ...base, recastPrompt: "Add a caption saying 50% off." });
  includes(asked, "- Except text: this video has no captions, titles or written words on screen");
  // A new version has no @Video1, so no line about it.
  const fresh = buildRecreationPrompt(withText, { ...base, mode: "new" });
  assert.ok(!fresh.includes("@Video1 may have"));
  assert.ok(!fresh.includes("On-screen text:"));
  // Text allowed: the shot's text is in, the extras stay, no "no text" rules.
  const on = buildRecreationPrompt(withText, { ...base, noText: false, directionExtras: extras });
  includes(on, 'On-screen text: "20 YEARS OLD"');
  includes(on, "OPEN SUNDAYS");
  assert.ok(!on.includes("No text, captions"));
  assert.ok(!on.includes("@Video1 may have"));
  const onFresh = buildRecreationPrompt(withText, { ...base, noText: false, mode: "new" });
  includes(onFresh, 'On-screen text: "20 YEARS OLD"');
});

test("brand removed: a name said on its own goes, and the line still reads", () => {
  const air = ["Arctic Air Home Services"];
  const acme = ["Acme", "Acme Roofing"];
  const out = (s, m) => adaptScriptForBrand(s, m, undefined, true);
  assert.deepStrictEqual(out("They won't give me a price over the phone. Arctic Air Home Services. How can I help?", air), "They won't give me a price over the phone. How can I help?");
  assert.deepStrictEqual(out("Good afternoon, thank you for calling Arctic Air Home Services. This is Amanda.", air), "Good afternoon, thank you for calling. This is Amanda.");
  assert.deepStrictEqual(out("Acme, how can I help?", acme), "How can I help?");
  assert.deepStrictEqual(out("This is Acme, how can I help?", acme), "How can I help?");
  assert.deepStrictEqual(out("Hi, this is Acme Roofing. What do you need?", acme), "Hi. What do you need?");
  assert.deepStrictEqual(out("Welcome to Acme! We fix roofs.", acme), "Welcome! We fix roofs.");
  assert.deepStrictEqual(out("Acme's crew was great, and Acme's price was fair.", acme), "Our crew was great, and our price was fair.");
  // Anywhere else the name becomes "us", the longest name first.
  assert.deepStrictEqual(out("Call Acme Roofing today.", acme), "Call us today.");
  // Words without the brand are left exactly as they were.
  assert.deepStrictEqual(out("No brand here, e.g.: fine.", acme), "No brand here, e.g.: fine.");
});

test("brand swapped: the company goes where the name was; neither switch leaves it", () => {
  assert.deepStrictEqual(adaptScriptForBrand("Thanks for calling Acme. Acme's the best.", ["Acme"], "Peak Roofing", false), "Thanks for calling Peak Roofing. Peak Roofing's the best.");
  assert.deepStrictEqual(adaptScriptForBrand("Call Acme.", ["Acme"], undefined, false), "Call Acme.");
});

test("a new version leaves out per-shot words that aren't the script being spoken", () => {
  const script = "Come and join me for thirty seconds cleaning some air ducts.";
  const shot = (dialogue, start, end) => ({ start, end, shot_type: "selfie", camera: "handheld", subject_action: "talks", person: true, dialogue });
  const same = { ...analysis, adapted_script: script, shots: [shot("Come and join me for 30", 0, 2), shot("seconds cleaning some air ducts.", 2, 10)] };
  // Give or take a word ("30" for "thirty"), the shots say the script: their words go in.
  assert.ok(shotsSayScript(same.shots, script));
  includes(buildRecreationPrompt(same, { ...base, durationSeconds: 10, script, mode: "new" }), 'Says: "Come and join me for 30"');
  // The shots hold the ad's longer words and the script condenses them: only DIALOGUE has words.
  const verbatim = {
    ...same,
    shots: [shot("Okay so, um, come on and join me today for like thirty whole seconds while I clean out", 0, 2), shot("some really dirty air ducts in this house, it's gonna be fun.", 2, 10)],
  };
  assert.ok(!shotsSayScript(verbatim.shots, script));
  const p = buildRecreationPrompt(verbatim, { ...base, durationSeconds: 10, script, mode: "new" });
  assert.ok(!p.includes("Says:"), p);
  assert.deepStrictEqual(dialogueFromPrompt(p), script);
});
