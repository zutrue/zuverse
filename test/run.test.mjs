// Ported from the Zuops Video Ad Copier tests.
// Renames in the port: cleanRunConfig -> cleanSettings, buildRunPrompt({ config }) -> buildRunPrompt({ settings }).
// Not ported (not in src/run.mjs): retryChoices, staleFrameRefs, stageLabel,
// isActiveStage, withRunTextRules; and the https-only photo filtering (local
// paths are allowed here).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanEdits,
  buildRunPrompt,
  castPhotoFor,
  cleanSettings,
  directedAnalysis,
  framesToMake,
  hasPresenter,
  needsCast,
  parseTimeRange,
  planEdits,
  runPhotos,
  shotChange,
  withShotPlan,
} from "../src/run.mjs";

const includes = (actual, expected, msg) =>
  assert.ok(String(actual).includes(expected), msg ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);

const analysis = {
  video_type: "ugc_speaker",
  industry: "HVAC",
  product_or_service: "air duct cleaning",
  duration_seconds_estimate: 20,
  hook: "Come and join me",
  original_script: "Come and join me. All done.",
  adapted_script: "Come and join me. All done.",
  brand_mentions: [],
  on_screen_text: ["COME AND JOIN ME"],
  subject_reference: { demographics: "man in his 20s", attire: "navy polo", expression: "upbeat" },
  environment: { location: "house", details: "ceiling vent", weather_lighting: "bright" },
  shots: [{ time_range: "0-20s", shot_type: "selfie", camera: "handheld", subject_action: "points up", setting: "vent" }],
  visual_style: "smartphone UGC",
  audio_guidelines: { voice_style: "casual", background_audio: "brush noise" },
  key_hooks: [],
};

test("config: the page's choices, checked, with safe defaults", () => {
  const c = cleanSettings({
    mode: "new",
    voice: "original",
    aspectRatio: "weird",
    durationSeconds: 99,
    resolution: "4k",
    // The original also passed "javascript:alert(1)" and "http://insecure/b.jpg" and expected them
    // dropped (https-only); the port allows local paths, so that part is not ported.
    photos: [{ url: "https://x/a.jpg", note: "Sam" }],
    notes: "  kitchen  ",
  });
  assert.deepStrictEqual(c.mode, "new");
  assert.deepStrictEqual(c.voice, "new", "a new version always gets a new voice");
  assert.deepStrictEqual(c.aspectRatio, "portrait");
  assert.deepStrictEqual(c.durationSeconds, 30);
  assert.deepStrictEqual(c.resolution, "720p");
  assert.deepStrictEqual(c.photos, [{ url: "https://x/a.jpg", note: "Sam", generated: undefined }]);
  assert.deepStrictEqual(c.lookalike, true);
  assert.deepStrictEqual(c.notes, "kitchen");
  assert.deepStrictEqual(cleanSettings(null).mode, "replace");
});

test("cast: only when on, the ad has a person and no photo was given", () => {
  const c = cleanSettings({});
  assert.ok(needsCast(c, analysis));
  assert.ok(!needsCast({ ...c, lookalike: false }, analysis));
  assert.ok(!needsCast({ ...c, photos: [{ url: "https://x/me.jpg" }] }, analysis));
  assert.ok(!needsCast(c, { ...analysis, video_type: "showcase" }));
  assert.ok(!needsCast(c, { ...analysis, subject_reference: { demographics: "none", attire: "", expression: "" }, product_or_service: "" }));
  assert.ok(hasPresenter(analysis));
});

test("photos: the user's first, the cast after; the voice comes from the cast", () => {
  const c = cleanSettings({ photos: [{ url: "https://x/product.jpg", note: "the product" }] });
  const photos = runPhotos(c, "https://x/cast.jpg");
  assert.deepStrictEqual(photos.map((p) => p.url), ["https://x/product.jpg", "https://x/cast.jpg"]);
  assert.deepStrictEqual(castPhotoFor(photos, analysis), "https://x/cast.jpg");
  assert.deepStrictEqual(castPhotoFor(photos, { ...analysis, video_type: "showcase" }), undefined);
  assert.deepStrictEqual(runPhotos(c, null).length, 1);
});

test("direction: the planned changes land on the plan; none leaves it as is", () => {
  assert.deepStrictEqual(directedAnalysis(analysis, null), analysis);
  const d = directedAnalysis(analysis, {
    summary: [], cannot: [], script: "", script_changed: false, hook: "New hook",
    person: { demographics: "woman in her 40s", attire: "scrubs", expression: "calm" }, person_changed: true,
    environment: { location: "kitchen", details: "", weather_lighting: "" }, shots: [], visual_style: "", background_audio: "",
    on_screen_text: false, extras: [],
  });
  assert.deepStrictEqual(d.hook, "New hook");
  assert.deepStrictEqual(d.subject_reference.demographics, "woman in her 40s");
  assert.deepStrictEqual(d.environment.location, "kitchen");
  assert.deepStrictEqual(d.shots, analysis.shots);
});

const plan = [
  { start: 0, end: 2, shot_type: "selfie", subject: "Man.", action: "points up", person: true, frame_url: "https://x/f1.jpg", clean_url: "https://x/c1.jpg", clean_cast: "https://x/castA.jpg", clean_style: "fresh-2" },
  { start: 2, end: 18, shot_type: "POV", subject: "Duct", action: "brush spins", person: false, frame_url: "https://x/f2.jpg", clean_url: "https://x/c2.jpg", clean_style: "fresh-2" },
  { start: 18, end: 20, shot_type: "wide", subject: "Logo", action: "card", graphic: true, frame_url: "https://x/f3.jpg" },
];

test("frames: what is missing or was made for another face", () => {
  assert.deepStrictEqual(framesToMake(plan, "https://x/castA.jpg"), []);
  assert.deepStrictEqual(framesToMake(plan, "https://x/castB.jpg"), [0]);
  assert.deepStrictEqual(framesToMake([{ ...plan[1], clean_url: null }], null), [0]);
  const { analysis: a, frameUrls } = withShotPlan(analysis, plan, 1);
  assert.deepStrictEqual(frameUrls, ["https://x/c1.jpg", "https://x/c2.jpg"]);
  assert.deepStrictEqual(a.shots.map((s) => s.frame_ref), [2, 3, undefined]);
});

test("frames: an old edit of the source frame (original people and place) is drawn again, never sent", () => {
  const old = plan.map(({ clean_style: _s, ...s }) => s);
  // Even with the same face, both filmed shots are drawn fresh.
  assert.deepStrictEqual(framesToMake(old, "https://x/castA.jpg"), [0, 1]);
  const { analysis: a, frameUrls } = withShotPlan(analysis, old, 1);
  assert.deepStrictEqual(frameUrls, []);
  assert.deepStrictEqual(a.shots.map((s) => s.frame_ref), [undefined, undefined, undefined]);
  // (staleFrameRefs assertions not ported.)
});

test("frames that show the presenter carry their face: the photo stays home, a frame is read for the voice", () => {
  const cast = "https://x/castA.jpg";
  const shots = Array.from({ length: 10 }, (_, i) => ({
    start: i * 2, end: i * 2 + 2, shot_type: "medium", subject: "Presenter", action: "talks", person: true,
    frame_url: `https://x/f${i}.jpg`, clean_url: `https://x/c${i}.jpg`, clean_cast: cast, clean_style: "fresh-2",
  }));
  const settings = cleanSettings({ mode: "new", durationSeconds: 20 });
  const out = buildRunPrompt({ settings, analysis, planShots: shots, castUrl: cast, hasSourceVideo: true });
  // No photo: all nine slots are frames.
  assert.deepStrictEqual(out.refs, shots.slice(0, 9).map((s) => s.clean_url));
  assert.deepStrictEqual(out.voicePhoto, "https://x/c0.jpg");
  includes(out.prompt, "SHOT 1 (0.0-2.0s), like @Image1");
  includes(out.prompt, "IDENTITY LOCK: the person on camera is the presenter shown in the shot reference images (@Image1 to @Image9)");
  assert.ok(!out.prompt.includes("@Image1 = the person on camera"), out.prompt);
  assert.ok(!out.prompt.includes("Cast a new person"), out.prompt);
  // A logo photo still goes, first, and is named as itself.
  const withLogo = buildRunPrompt({
    settings: cleanSettings({ mode: "new", durationSeconds: 20, photos: [{ url: "https://x/logo.png", note: "our logo" }] }),
    analysis, planShots: shots, castUrl: cast, hasSourceVideo: true,
  });
  assert.deepStrictEqual(withLogo.refs[0], "https://x/logo.png");
  assert.deepStrictEqual(withLogo.refs.length, 9);
  includes(withLogo.prompt, "The other reference images are shown exactly as they look: @Image1 = our logo.");
  // Only one frame shows them (or the frames are older): the photo goes as before.
  const one = buildRunPrompt({ settings, analysis, planShots: plan, castUrl: cast, hasSourceVideo: true });
  assert.deepStrictEqual(one.refs[0], cast);
  assert.deepStrictEqual(one.voicePhoto, undefined);
});

test("frames: photos + frames never pass the 9 reference images Seedance 2.5 takes", () => {
  const many = Array.from({ length: 16 }, (_, i) => ({
    start: i, end: i + 1, shot_type: "wide", subject: `Shot ${i}`, action: "moves", person: false,
    frame_url: `https://x/f${i}.jpg`, clean_url: `https://x/c${i}.jpg`, clean_style: "fresh-2",
  }));
  const { analysis: a, frameUrls } = withShotPlan(analysis, many, 3);
  assert.deepStrictEqual(frameUrls.length, 6);
  assert.deepStrictEqual(a.shots.filter((s) => s.frame_ref).map((s) => s.frame_ref), [4, 5, 6, 7, 8, 9]);
  const photos = Array.from({ length: 4 }, (_, i) => ({ url: `https://x/p${i}.jpg`, note: "" }));
  const out = buildRunPrompt({
    settings: cleanSettings({ mode: "new", durationSeconds: 16, photos }),
    analysis, planShots: many, castUrl: "https://x/castA.jpg", hasSourceVideo: true,
  });
  assert.ok(out.refs.length <= 9, `${out.refs.length} references`);
});

test("prompt: a new version with its frames, the cast as @Image1, the switches applied", () => {
  const settings = cleanSettings({ mode: "new", durationSeconds: 20, noText: true, noMusic: true });
  const out = buildRunPrompt({ settings, analysis, planShots: plan, castUrl: "https://x/castA.jpg", hasSourceVideo: true });
  assert.deepStrictEqual(out.refs, ["https://x/castA.jpg", "https://x/c1.jpg", "https://x/c2.jpg"]);
  assert.deepStrictEqual(out.frameCount, 2);
  includes(out.prompt, "SHOT 1 (0.0-2.0s), like @Image2");
  includes(out.prompt, "@Image1 = the person on camera");
  assert.ok(!out.prompt.includes("@Video1"));
  includes(out.prompt, "On-screen Text Rules");
  includes(out.prompt, "Audio Rules (strict)");
  // Replace mode: the source rides along, no frames.
  const r = buildRunPrompt({ settings: cleanSettings({ mode: "replace", voice: "new" }), analysis, planShots: plan, castUrl: "https://x/castA.jpg", hasSourceVideo: true });
  assert.deepStrictEqual(r.refs, ["https://x/castA.jpg"]);
  includes(r.prompt, "@Video1");
  // A script the direction rewrote is the one spoken.
  const directed = buildRunPrompt({
    settings: cleanSettings({ mode: "new", notes: "say we are open Sundays" }),
    analysis,
    direction: {
      summary: [], cannot: [], script: "Open Sundays. All done.", script_changed: true, hook: "", person: { demographics: "", attire: "", expression: "" },
      person_changed: false, environment: { location: "", details: "", weather_lighting: "" }, shots: [], visual_style: "", background_audio: "",
      on_screen_text: false, extras: ["Mention Sundays"],
    },
    hasSourceVideo: false,
  });
  includes(directed.prompt, "Open Sundays. All done.");
  includes(directed.prompt, "USER DIRECTION");
});

test("edits: a changed beat reaches the measured shots in it, and their frames are made again", () => {
  const read = {
    ...analysis,
    shots: [
      { time_range: "0-3s", shot_type: "close-up", camera: "static", subject_action: "Yellow glove works the brush", setting: "duct", on_screen_text: "day yeah" },
      { time_range: "3-12s", shot_type: "close-up", camera: "static", subject_action: "The hose goes in", setting: "duct" },
    ],
  };
  const edited = {
    ...read,
    shots: [{ ...read.shots[0], subject_action: "A blue nitrile glove works the brush", on_screen_text: "" }, read.shots[1]],
  };
  const edits = planEdits(read, edited);
  assert.deepStrictEqual(edits.beats.length, 1);
  assert.deepStrictEqual(edits.beats[0].range, [0, 3]);
  assert.deepStrictEqual(edits.setting, null);

  const measured = [
    { start: 0, end: 1.5, action: "yellow glove", frame_url: "f1", clean_url: "c1", clean_change: "", clean_style: "fresh-2" },
    { start: 1.5, end: 3, action: "yellow glove", frame_url: "f2", clean_url: "c2", clean_change: "", clean_style: "fresh-2" },
    { start: 3, end: 12, action: "hose", frame_url: "f3", clean_url: "c3", clean_change: "", clean_style: "fresh-2" },
  ];
  // Both measured shots inside 0-3 s take the new action; their frames are stale, the third is not.
  const applied = applyPlanEdits(measured, edits);
  assert.deepStrictEqual(applied.map((s) => s.action), ["A blue nitrile glove works the brush", "A blue nitrile glove works the brush", "hose"]);
  assert.deepStrictEqual(applied[0].on_screen_text, "");
  assert.deepStrictEqual(framesToMake(measured, null, edits), [0, 1]);
  assert.deepStrictEqual(shotChange(measured[0], edits), "A blue nitrile glove works the brush");
  // Once made with the change, they are done.
  const made = measured.map((s) => ({ ...s, clean_change: shotChange(s, edits) }));
  assert.deepStrictEqual(framesToMake(made, null, edits), []);

  // A new place changes every frame.
  const moved = planEdits(read, { ...read, environment: { location: "attic", details: "wooden beams", weather_lighting: "dim" } });
  assert.deepStrictEqual(moved.setting, "attic. wooden beams. Light: dim");
  assert.deepStrictEqual(framesToMake(made, null, moved), [0, 1, 2]);
  // Nothing edited: nothing to redo.
  assert.deepStrictEqual(planEdits(read, read), { beats: [], setting: null, scale: 1 });
  assert.deepStrictEqual(parseTimeRange("2.5 - 6 s"), [2.5, 6]);
  assert.deepStrictEqual(parseTimeRange("#3"), null);
});

test("no text: on unless a caller turns it off; the plan's text never reaches the prompt", () => {
  assert.deepStrictEqual(cleanSettings({}).noText, true, "older pages and API callers get text off");
  assert.deepStrictEqual(cleanSettings({ noText: true }).noText, true);
  assert.deepStrictEqual(cleanSettings({ noText: false }).noText, false, "callers can still turn it off");
  const withText = {
    ...analysis,
    shots: [{ ...analysis.shots[0], on_screen_text: "COME AND JOIN ME" }],
  };
  const textPlan = plan.map((s, i) => (i === 0 ? { ...s, on_screen_text: "ONLY $99" } : s));
  const direction = {
    summary: [], cannot: [], script: "", script_changed: false, hook: "", person: { demographics: "", attire: "", expression: "" },
    person_changed: false, environment: { location: "", details: "", weather_lighting: "" }, shots: [], visual_style: "", background_audio: "",
    on_screen_text: true, extras: ["Add a caption that says OPEN SUNDAYS"],
  };

  // On (the default), in both modes, even when kept and asked for by the direction.
  for (const mode of ["replace", "new"]) {
    const out = buildRunPrompt({
      settings: cleanSettings({ mode, keepOnScreenText: true }),
      analysis: withText,
      direction,
      planShots: textPlan,
      hasSourceVideo: true,
    });
    assert.ok(!out.prompt.includes("COME AND JOIN ME"), mode);
    assert.ok(!out.prompt.includes("ONLY $99"), mode);
    assert.ok(!out.prompt.includes("OPEN SUNDAYS"), mode);
    assert.ok(!out.prompt.includes("On-screen text:"), mode);
    includes(out.prompt, "On-screen Text Rules");
    assert.deepStrictEqual(out.prompt.split("On-screen Text Rules").length, 2, "once");
  }
  const replace = buildRunPrompt({ settings: cleanSettings({ mode: "replace" }), analysis: withText, hasSourceVideo: true });
  includes(replace.prompt, "burned into its frames: never copy them");

  // Off and kept (what the page sends with the switch off): the text goes in, no strict rules.
  const off = buildRunPrompt({
    settings: cleanSettings({ mode: "replace", noText: false, keepOnScreenText: true }),
    analysis: withText,
    hasSourceVideo: true,
  });
  includes(off.prompt, 'On-screen text: "COME AND JOIN ME"');
  assert.ok(!off.prompt.includes("On-screen Text Rules"));
  // Off but not kept (the page before this switch): left out as before, without the strict block.
  const legacy = buildRunPrompt({ settings: cleanSettings({ mode: "replace", noText: false }), analysis: withText, hasSourceVideo: true });
  assert.ok(!legacy.prompt.includes("COME AND JOIN ME"));
  includes(legacy.prompt, "No text, captions, subtitles");
  assert.ok(!legacy.prompt.includes("On-screen Text Rules"));
  // (withRunTextRules assertions not ported.)
});

test("edits on the remake's clock: a new version's direction (0 to its length) still reaches the measured shots", () => {
  const read = {
    ...analysis,
    environment: { location: "living room", details: "white curtains", weather_lighting: "daylight" },
    shots: [
      { time_range: "0-13s", shot_type: "close-up", camera: "static", subject_action: "Blonde woman makes a bet", setting: "living room" },
      { time_range: "13-29s", shot_type: "close-up", camera: "static", subject_action: "Blonde woman points at her phone", setting: "living room" },
    ],
  };
  const directed = {
    ...read,
    environment: { location: "home kitchen", details: "wooden table", weather_lighting: "window light" },
    shots: [
      { time_range: "0-4s", shot_type: "close-up", camera: "static", subject_action: "The man makes a bet", setting: "kitchen" },
      { time_range: "4-6s", shot_type: "close-up", camera: "static", subject_action: "The man points at his phone", setting: "kitchen" },
    ],
  };
  const edits = planEdits(read, directed);
  assert.ok(Math.abs(edits.scale - 6 / 29) < 1e-9);
  const measured = [
    { start: 0, end: 26.7, subject: "blonde woman", action: "bets", setting: "white curtains", lighting: "window behind", person: true, frame_url: "f1" },
    { start: 26.7, end: 29, subject: "blonde woman", action: "points", setting: "white curtains", lighting: "window behind", person: true, frame_url: "f2" },
  ];
  const shots = applyPlanEdits(measured, edits);
  assert.deepStrictEqual(shots.map((s) => s.action), ["The man makes a bet", "The man points at his phone"]);
  assert.deepStrictEqual(shots.map((s) => s.subject), ["", ""]);
  assert.ok(shots.every((s) => s.setting.startsWith("home kitchen") && s.lighting === ""));
  assert.match(shotChange(measured[0], edits), /The man makes a bet\. The place: home kitchen/);
});

test("edits on the remake's clock: beats kept word for word are not counted as changes", () => {
  const read = { ...analysis, shots: [{ time_range: "0-20s", shot_type: "selfie", camera: "handheld", subject_action: "points up", setting: "vent" }] };
  const sameWords = { ...read, shots: [{ ...read.shots[0], time_range: "0-6s" }] };
  assert.deepStrictEqual(planEdits(read, sameWords).beats, []);
});

test("a long measured shot that spans several edited beats carries all of them, in order", () => {
  const read = {
    ...analysis,
    shots: [
      { time_range: "0-3s", shot_type: "close-up", camera: "static", subject_action: "she makes a bet", setting: "room" },
      { time_range: "3-13s", shot_type: "close-up", camera: "static", subject_action: "she listens to the phone", setting: "room" },
      { time_range: "13-23s", shot_type: "close-up", camera: "static", subject_action: "she looks annoyed", setting: "room" },
      { time_range: "23-29s", shot_type: "close-up", camera: "static", subject_action: "she points at the phone", setting: "room" },
    ],
  };
  const directed = {
    ...read,
    shots: [
      { ...read.shots[0], subject_action: "He makes a bet." },
      { ...read.shots[1], subject_action: "He listens to the phone." },
      { ...read.shots[2], subject_action: "He looks annoyed." },
      { ...read.shots[3], subject_action: "He points at the phone." },
    ],
  };
  const edits = planEdits(read, directed);
  const [long, short] = applyPlanEdits([{ start: 0, end: 26.7, person: true, action: "x" }, { start: 26.7, end: 29, person: true, action: "y" }], edits);
  // The last beat (23-29s) is mostly in the short shot, so it stays there.
  assert.equal(long.action, "He makes a bet. Then He listens to the phone. Then He looks annoyed.");
  assert.equal(short.action, "He points at the phone.");
});

test("prompt: a new version's mapped shots lose the brand like the script does", () => {
  const mapped = [
    { start: 0, end: 10, shot_type: "selfie", subject: "Woman.", action: "listens to the phone", person: true, dialogue: "Thanks for calling Acme. How can I help?", frame_url: "https://x/f1.jpg" },
    { start: 10, end: 20, shot_type: "selfie", subject: "Woman.", action: "hangs up", person: true, dialogue: "Okay, thanks.", frame_url: "https://x/f2.jpg" },
  ];
  // The pipeline hands over the read with its script already branded.
  const read = (script) => ({ ...analysis, original_script: "Thanks for calling Acme. How can I help? Okay, thanks.", adapted_script: script, brand_mentions: ["Acme"] });
  const removed = buildRunPrompt({
    settings: cleanSettings({ mode: "new", durationSeconds: 20, removeBranding: true }),
    analysis: read("Thanks for calling. How can I help? Okay, thanks."),
    planShots: mapped,
    hasSourceVideo: false,
  });
  includes(removed.prompt, 'Says: "Thanks for calling. How can I help?"');
  assert.ok(!/Says: "[^"]*Acme/.test(removed.prompt), removed.prompt);
  const swapped = buildRunPrompt({
    settings: cleanSettings({ mode: "new", durationSeconds: 20, companyName: "Peak Roofing" }),
    analysis: read("Thanks for calling Peak Roofing. How can I help? Okay, thanks."),
    planShots: mapped,
    hasSourceVideo: false,
  });
  includes(swapped.prompt, 'Says: "Thanks for calling Peak Roofing. How can I help?"');
  // The shots passed in are left as they were.
  assert.deepStrictEqual(mapped[0].dialogue, "Thanks for calling Acme. How can I help?");
});
