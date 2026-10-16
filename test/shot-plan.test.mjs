// Ported from the Zuops Video Ad Copier tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanMeasuredShots,
  mergeShotPlan,
  parsePlanJson,
  planIsUsable,
  shotFramePrompt,
  shotPlanPrompt,
  SHOT_PLAN_MAX_SHOTS,
  SHOT_PLAN_SYSTEM,
} from "../src/shot-plan.mjs";
import { remakeShots } from "../src/prompt.mjs";
import { framesToMake, withShotPlan } from "../src/run.mjs";

const includes = (actual, expected, msg) =>
  assert.ok(String(actual).includes(expected), msg ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);

test("measured shots: in order, no overlaps, no slivers, capped", () => {
  assert.deepStrictEqual(
    cleanMeasuredShots([{ start: 0, end: 2.33 }, { start: 2.33, end: 2.4 }, { start: 2.3, end: 5 }, { start: 1, end: 3 }, { start: "x", end: 9 }]),
    [{ start: 0, end: 2.3 }, { start: 2.3, end: 5 }],
  );
  const many = Array.from({ length: 30 }, (_, i) => ({ start: i, end: i + 1 }));
  assert.deepStrictEqual(cleanMeasuredShots(many).length, SHOT_PLAN_MAX_SHOTS);
  assert.deepStrictEqual(cleanMeasuredShots(null), []);
});

test("the model's shots go onto the measured cuts; times always come from the cuts", () => {
  const measured = [{ start: 0, end: 2.3 }, { start: 2.3, end: 4.3 }];
  const merged = mergeShotPlan(measured, {
    shots: [
      { index: 2, shot_type: "POV", framing: "down the duct", camera: "push in", subject: "duct", action: "brush spins", setting: "grey duct", lighting: "camera light", person: false, graphic: false, dialogue: "", start: 9, end: 99 },
      { index: 1, shot_type: "selfie", framing: "low angle", camera: "handheld", subject: "man", action: "points up", setting: "ceiling", lighting: "bright", person: true, graphic: false, dialogue: "Come and join me" },
    ],
  });
  assert.deepStrictEqual(merged[0].start, 0);
  assert.deepStrictEqual(merged[0].shot_type, "selfie");
  assert.deepStrictEqual(merged[0].person, true);
  assert.deepStrictEqual(merged[1].end, 4.3);
  assert.deepStrictEqual(merged[1].framing, "down the duct");
  assert.ok(planIsUsable(merged));
  // Missing shots come back empty, and too many empties is not usable.
  const thin = mergeShotPlan(measured, { shots: [] });
  assert.deepStrictEqual(thin[1].framing, "");
  assert.ok(!planIsUsable(thin));
});

test("a shot with a person in it is filmed footage, even when the model calls it a graphic", () => {
  // The arctic-air read: a red caption burned into the talking shot got it flagged as a graphic.
  const measured = [{ start: 0, end: 26.7 }, { start: 26.7, end: 29 }, { start: 29, end: 30 }];
  const merged = mergeShotPlan(measured, {
    shots: [
      { index: 1, shot_type: "selfie", framing: "chest up", camera: "handheld", subject: "technician", action: "talks to camera", setting: "kitchen", lighting: "daylight", person: true, graphic: true, dialogue: "What is a fair price", on_screen_text: "WHAT IS A FAIR PRICE..." },
      { index: 2, shot_type: "medium", framing: "chest up", camera: "handheld", subject: "technician", action: "thumbs up", setting: "kitchen", lighting: "daylight", person: true, graphic: false, dialogue: "" },
      { index: 3, shot_type: "wide", framing: "full screen card", camera: "static", subject: "logo", action: "logo fades in", setting: "white card", lighting: "", person: false, graphic: true, dialogue: "Call today." },
    ],
  });
  assert.deepStrictEqual(merged.map((s) => [s.person, s.graphic]), [[true, false], [true, false], [false, true]]);
  // The caption is kept as on-screen text, not lost with the shot.
  assert.deepStrictEqual(merged[0].on_screen_text, "WHAT IS A FAIR PRICE...");
  // The mapper is told the same thing.
  includes(SHOT_PLAN_SYSTEM, "Filmed footage with captions, subtitles, stickers or text overlaid on it is NOT a graphic");
  includes(SHOT_PLAN_SYSTEM, "A shot with a person in it is never a graphic");
});

test("a captioned talking shot stays in a new version end to end", () => {
  const measured = [{ start: 0, end: 26.7 }, { start: 26.7, end: 29 }];
  const merged = mergeShotPlan(measured, {
    shots: [
      { index: 1, shot_type: "selfie", framing: "chest up, phone at arm's length", camera: "handheld", subject: "technician", action: "talks to camera", setting: "kitchen", lighting: "daylight", person: true, graphic: true, dialogue: "What is a fair price for a new AC?", on_screen_text: "WHAT IS A FAIR PRICE..." },
      { index: 2, shot_type: "medium", framing: "chest up", camera: "handheld", subject: "technician", action: "points at the camera", setting: "kitchen", lighting: "daylight", person: true, graphic: false, dialogue: "Call us." },
    ],
  }).map((s, i) => ({ ...s, frame_url: `shots/shot-${i + 1}.jpg` }));
  // Both shots get a frame drawn...
  assert.deepStrictEqual(framesToMake(merged, "cast/cast.png"), [0, 1]);
  // ...and both are filmed, on the measured cuts.
  const { analysis } = withShotPlan({ shots: [] }, merged, 1);
  const shots = remakeShots(analysis.shots, 29);
  assert.deepStrictEqual(shots.map((s) => [s.start, s.end]), [[0, 26.7], [26.7, 29]]);
  includes(shots[0].subject_action, "talks to camera");
  assert.deepStrictEqual(shots[0].dialogue, "What is a fair price for a new AC?");
});

test("JSON from a reply: bare, fenced or wrapped in text", () => {
  assert.deepStrictEqual(parsePlanJson('{"shots":[]}'), { shots: [] });
  assert.deepStrictEqual(parsePlanJson('Here:\n```json\n{"shots":[1]}\n```'), { shots: [1] });
  assert.deepStrictEqual(parsePlanJson("nope"), null);
});

test("prompts: the cut list is exact; frames keep the shot and lose the text", () => {
  const p = shotPlanPrompt({ shots: [{ start: 0, end: 2.3 }, { start: 2.3, end: 4.3 }], transcript: "Come and join me" });
  includes(p, "exactly 2 shots");
  includes(p, "Shot 2: 2.3s to 4.3s");
  includes(p, "Return exactly 2 shots");
  includes(shotFramePrompt("swap"), "The main person on camera is the person in the second image");
  includes(shotFramePrompt("clean"), "Do not add any person");
  for (const k of ["swap", "clean"]) {
    const p = shotFramePrompt(k);
    includes(p, "the result has no text of any kind");
    // A new version never re-uses the original frame: only its shot, with new people in a new place.
    includes(p, "Use the first image only as a guide to the shot");
    includes(p, "The place is a different real location of the same kind");
    assert.ok(!p.includes("Keep everything else"), p);
  }
  includes(shotFramePrompt("swap"), "Every other person in the frame is a completely different, newly invented person");
  // No cast face (it failed): everyone in a people shot is invented.
  includes(shotFramePrompt("clean", "", true), "Every person in the frame is a completely different, newly invented person");
  includes(shotFramePrompt("clean", "A blue glove"), "Show this in the frame: A blue glove.");
});
