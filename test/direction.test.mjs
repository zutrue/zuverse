// Ported from the Zuops Video Ad Copier tests.
// Not ported (not in src/direction.mjs): directionMessages and parseModelJson. Their test
// ("the prompt insists on doing all of it...", "model replies are read...") is skipped, and the
// directionMessages half of the "text switched off" test is left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFrom, sanitizeDirection, scriptWordCap } from "../src/direction.mjs";

const analysis = {
  video_type: "ugc_speaker",
  industry: "Garage doors",
  product_or_service: "garage door repair",
  hook: "Kneeling next to a broken spring",
  subject_reference: { demographics: "man in his 40s", attire: "grey work polo", expression: "friendly" },
  environment: { location: "suburban garage", details: "tools on the wall", weather_lighting: "daylight" },
  shots: [
    { time_range: "0-5s", shot_type: "medium", camera: "handheld", subject_action: "points at the broken spring", setting: "garage", dialogue: "This spring snapped." },
    { time_range: "5-15s", shot_type: "close-up", camera: "static", subject_action: "smiles", setting: "garage", dialogue: "We fixed it the same day." },
  ],
  visual_style: "phone UGC",
  audio_guidelines: { voice_style: "male", background_audio: "garage ambience" },
};
const plan = planFrom(analysis, "This spring snapped. We fixed it the same day.");

test("the plan carries every field the model may change", () => {
  assert.deepStrictEqual(plan.person.attire, "grey work polo");
  assert.deepStrictEqual(plan.shots.length, 2);
  assert.deepStrictEqual(plan.background_audio, "garage ambience");
  assert.deepStrictEqual(plan.script, "This spring snapped. We fixed it the same day.");
});

// Added for the port (the original only used it inside the skipped directionMessages test):
// about 2.7 words a second, never under the 4 s floor.
test("the script word cap fits the length", () => {
  assert.deepStrictEqual(scriptWordCap(15), 40);
  assert.deepStrictEqual(scriptWordCap(0), 10);
});

test("a full answer is used as given", () => {
  const r = sanitizeDirection({
    summary: ["A woman in her 50s presents it", "Ends on the $49 tune-up"],
    cannot: [],
    script: "This spring snapped. Our $49 tune-up fixed it the same day.",
    hook: "Kneeling next to a broken spring",
    person: { demographics: "woman in her 50s", attire: "navy work shirt", expression: "warm" },
    person_changed: true,
    environment: analysis.environment,
    shots: [
      { time_range: "0-5s", shot_type: "medium", camera: "handheld", subject_action: "points at the spring", setting: "garage", dialogue: "This spring snapped." },
      { time_range: "5-15s", shot_type: "close-up", camera: "static", subject_action: "smiles", setting: "garage", dialogue: "Our $49 tune-up fixed it the same day." },
    ],
    visual_style: "phone UGC",
    background_audio: "upbeat acoustic music",
    on_screen_text: false,
    extras: ["End on a close-up of her smiling."],
  }, plan);
  assert.deepStrictEqual(r.script_changed, true);
  assert.deepStrictEqual(r.person_changed, true);
  assert.deepStrictEqual(r.person.demographics, "woman in her 50s");
  assert.deepStrictEqual(r.background_audio, "upbeat acoustic music");
  assert.deepStrictEqual(r.summary.length, 2);
  assert.deepStrictEqual(r.extras, ["End on a close-up of her smiling."]);
});

test("missing or broken parts fall back to the plan", () => {
  const r = sanitizeDirection({ summary: "not a list", shots: [{}, null], person_changed: true, person: {} }, plan);
  assert.deepStrictEqual(r.script, plan.script);
  assert.deepStrictEqual(r.script_changed, false);
  assert.deepStrictEqual(r.shots, plan.shots);
  assert.deepStrictEqual(r.person, plan.person);
  assert.deepStrictEqual(r.person_changed, false, "claiming a change with the same person is not a change");
  assert.deepStrictEqual(r.summary, []);
  assert.deepStrictEqual(r.on_screen_text, false);
  const empty = sanitizeDirection(null, plan);
  assert.deepStrictEqual(empty.environment, plan.environment);
});

test("text switched off: the planner is told to plan none, and no text gets through", () => {
  // (The directionMessages assertions are not ported.)
  const answer = { on_screen_text: true, extras: ["Add a caption reading 50% OFF", "Show a lower third with her name", "Slow push in on the spring"] };
  const off = sanitizeDirection(answer, plan, { noText: true });
  assert.deepStrictEqual(off.on_screen_text, false);
  assert.deepStrictEqual(off.extras, ["Slow push in on the spring"]);
  const on = sanitizeDirection(answer, plan);
  assert.deepStrictEqual(on.on_screen_text, true);
  assert.deepStrictEqual(on.extras.length, 3);
});
