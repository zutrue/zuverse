/**
 * "Anything else to change?": the user's direction worked into the plan.
 *
 * In Zuops a model rewrites the ad's plan so every part of the direction is
 * carried out (script wording, person, place, shots, look, music) and lists
 * what will change. In Zuverse, Claude does that job: it reads the plan
 * (`zuverse plan <project>`), follows DIRECTION_RULES below, and writes
 * direction.json. This module checks that file and fills anything missing
 * from the plan, exactly as Zuops checks its model's answer.
 */

import { mentionsOnScreenText } from "./prompt.mjs";

export const TEXT_SWITCHED_OFF_NOTE =
  "Text on the video is switched off (noText), so the text you asked for is left out.";

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const block = (v, max) =>
  String(v ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
const list = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);

/** How many words fit the runtime at a conversational pace. */
export function scriptWordCap(seconds) {
  return Math.floor(Math.max(4, Number(seconds) || 0) * 2.7);
}

/** The plan in the shape the director reads and writes. */
export function planFrom(a, script) {
  a = a ?? {};
  return {
    video_type: str(a.video_type, 40),
    industry: str(a.industry, 120),
    product_or_service: str(a.product_or_service, 200),
    hook: str(a.hook, 300),
    script: block(script, 2000),
    person: {
      demographics: str(a.subject_reference?.demographics, 240),
      attire: str(a.subject_reference?.attire, 240),
      expression: str(a.subject_reference?.expression, 200),
    },
    environment: {
      location: str(a.environment?.location, 240),
      details: str(a.environment?.details, 400),
      weather_lighting: str(a.environment?.weather_lighting, 200),
    },
    shots: (Array.isArray(a.shots) ? a.shots : []).slice(0, 20).map((s) => ({
      time_range: str(s?.time_range, 16),
      shot_type: str(s?.shot_type, 80),
      camera: str(s?.camera, 200),
      subject_action: str(s?.subject_action, 300),
      setting: str(s?.setting, 240),
      dialogue: str(s?.dialogue, 300),
    })),
    visual_style: str(a.visual_style, 300),
    background_audio: str(a.audio_guidelines?.background_audio, 240),
  };
}

/** The rules the director follows (the same ones the Zuops planner model gets). */
export function directionRules({ mode, durationSeconds, noText }) {
  const dur = Math.max(4, Math.round(Number(durationSeconds) || 15));
  const words = scriptWordCap(dur);
  return [
    "Rewrite the plan so every part of the direction is carried out, exactly and completely, however many parts of the plan it touches.",
    "- Do everything the direction asks. Never skip, soften or only partly do a request. If it asks for several things, do all of them.",
    "- Change only what the direction asks for, plus whatever has to change with it to stay consistent (a new place changes every shot's setting; a new closing line changes the last shot's dialogue and the script).",
    `- Script: rewrite the wording only where the direction asks (new or different lines, a different offer, price, ending, call to action, tone or language). Otherwise keep it word for word. It must be speakable in ${dur} seconds, so at most about ${words} words unless the direction asks for more. Keep each shot's dialogue consistent with the script, in order.`,
    "- Person: if the direction says anything about who is on camera (age, gender, look, clothes, role, uniform, how many people), rewrite `person` to match and set person_changed to true. Otherwise return the person unchanged and person_changed false.",
    mode === "replace"
      ? "- Shots: this remake follows the original footage's motion and timing, so keep the same number of shots and the same time ranges; change what each shot shows or says as the direction requires."
      : `- Shots: keep the same number and order unless the direction adds, removes or reorders moments. Time ranges must run from 0 to ${dur}s in order.`,
    noText
      ? `- On-screen text: switched off for this video. Plan no captions, subtitles, titles, text cards, prices, calls to action or any other written words on screen, even if the direction asks for them: set on_screen_text to false and put nothing about text in \`extras\`. If the direction asks for text on screen, add this to \`cannot\`: "${TEXT_SWITCHED_OFF_NOTE}"`
      : "- On-screen text: these videos have no captions, titles or signs with words unless the direction explicitly asks for text; if it does, set on_screen_text to true and say exactly what text in `extras`.",
    "- Anything the direction asks for that the fields can't hold (a camera move, a prop, a transition, pacing, an effect, a particular shot), write as short, concrete instructions for the video model in `extras`.",
    "- If part of the direction truly can't be done in a generated video (using a logo file that wasn't provided, a real celebrity, a real person's likeness), say so plainly in `cannot` and do the closest thing that can.",
    "- `summary`: 1 to 6 short plain-English bullets for the user saying what will be different, e.g. \"Filmed in a bright showroom instead of a living room\". No jargon.",
    "",
    "direction.json has exactly these keys:",
    '{"summary":[string],"cannot":[string],"script":string,"hook":string,"person":{"demographics":string,"attire":string,"expression":string},"person_changed":boolean,"environment":{"location":string,"details":string,"weather_lighting":string},"shots":[{"time_range":string,"shot_type":string,"camera":string,"subject_action":string,"setting":string,"dialogue":string}],"visual_style":string,"background_audio":string,"on_screen_text":boolean,"extras":[string]}',
  ].join("\n");
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * direction.json made safe to use, falling back to the plan wherever it is
 * missing or broken. With text off nothing in it can put words on screen.
 */
export function sanitizeDirection(raw, plan, opts = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const script = block(r.script, 2000) || plan.script;
  const person = {
    demographics: str(r.person?.demographics, 240) || plan.person.demographics,
    attire: str(r.person?.attire, 240) || plan.person.attire,
    expression: str(r.person?.expression, 200) || plan.person.expression,
  };
  const shots = (Array.isArray(r.shots) ? r.shots : [])
    .slice(0, 20)
    .map((s, i) => ({
      time_range: str(s?.time_range, 16) || plan.shots[i]?.time_range || "",
      shot_type: str(s?.shot_type, 80),
      camera: str(s?.camera, 200),
      subject_action: str(s?.subject_action, 300),
      setting: str(s?.setting, 240),
      dialogue: str(s?.dialogue, 300),
    }))
    .filter((s) => s.subject_action || s.camera || s.dialogue);
  const personChanged =
    r.person_changed === true &&
    (norm(person.demographics) !== norm(plan.person.demographics) || norm(person.attire) !== norm(plan.person.attire));
  return {
    summary: list(r.summary, 6, 160),
    cannot: list(r.cannot, 4, 200),
    script,
    script_changed: norm(script) !== norm(plan.script),
    hook: str(r.hook, 300) || plan.hook,
    person,
    person_changed: personChanged,
    environment: {
      location: str(r.environment?.location, 240) || plan.environment.location,
      details: str(r.environment?.details, 400) || plan.environment.details,
      weather_lighting: str(r.environment?.weather_lighting, 200) || plan.environment.weather_lighting,
    },
    shots: shots.length ? shots : plan.shots,
    visual_style: str(r.visual_style, 300) || plan.visual_style,
    background_audio: str(r.background_audio, 240) || plan.background_audio,
    on_screen_text: !opts.noText && r.on_screen_text === true,
    extras: list(r.extras, 10, 300).filter((x) => !(opts.noText && mentionsOnScreenText(x))),
  };
}
