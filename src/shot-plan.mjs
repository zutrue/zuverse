/**
 * "Make a new version": a measured, shot-by-shot plan of the source ad, so the
 * remake follows it cut for cut instead of loosely.
 *
 * Three layers, as in a manual breakdown:
 *   - objective: the cuts are measured from the frames (cuts.mjs) and one
 *     frame is grabbed from each shot;
 *   - watching: Gemini watches the clip with that exact cut list and the
 *     frames, and describes each shot (framing, camera, subject, action,
 *     setting, light, whether a person is on camera, what is said);
 *   - frames: each shot's frame is drawn fresh as a reference image (same
 *     angle and poses, new people, a new place of the same kind, no text).
 *
 * The cut times always come from the measurement, never from the model: the
 * model only fills in what each shot looks like.
 *
 * Pure module: no I/O.
 */

export const SHOT_PLAN_MAX_SHOTS = 16;

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const round1 = (n) => Math.round(n * 10) / 10;

/** Measured shots, checked: in order, non-overlapping, at least 0.2 s each, at most 16. */
export function cleanMeasuredShots(raw, maxSeconds = 60) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of list) {
    const start = Number(s?.start);
    const end = Number(s?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const a = Math.max(0, Math.min(maxSeconds, start));
    const b = Math.max(0, Math.min(maxSeconds, end));
    if (b - a < 0.2) continue;
    if (out.length && a < out[out.length - 1].end - 0.05) continue;
    out.push({ start: round1(a), end: round1(b) });
    if (out.length >= SHOT_PLAN_MAX_SHOTS) break;
  }
  return out;
}

export const SHOT_PLAN_SYSTEM = `You are a frame-accurate video breakdown analyst. A video model will remake this ad shot for shot with a new person, so it needs to know exactly what every shot looks like. The cut list you are given was measured from the frames: keep exactly those shots, in that order, with those times. For each shot you also get a still frame from inside it; the stills are the ground truth for framing, props and setting, the video tells you the motion.

Describe each shot concretely and visually, the way a camera operator would need it:
- shot_type: extreme close-up / close-up / medium / wide / insert / POV / selfie
- framing: angle and distance, what fills the frame and where (e.g. "looking straight down into a round flexible duct, the spiral ribs fill the frame, dark opening in the centre")
- camera: how the camera moves during the shot (static, handheld drift, slow push in, pulling back, tilting up, rotating), and whether it is a selfie, POV or held by someone else
- subject: who or what the shot is about (a person described by role and look, or the object)
- action: what happens, moment by moment within the shot (gestures, eye-line, the tool spinning, dust coming loose)
- setting: the place, surfaces, colours, props, condition (dirty, clean)
- lighting: light source, brightness, colour temperature
- person: true when a person (face or body, hands count) is visible in the shot
- graphic: true when the shot is a designed graphic, title card, logo card or end card rather than filmed footage
- dialogue: the words spoken during this shot, verbatim, or empty
- on_screen_text: captions or overlays burned in during this shot (they will NOT be recreated), or empty
Never describe the on-screen captions as part of the scene. Use only ASCII punctuation. Output valid JSON matching the schema.`;

/** The submit_shot_plan tool's arguments, as JSON Schema. */
export function shotPlanSchema() {
  const shot = {
    type: "object",
    properties: {
      index: { type: "integer" },
      shot_type: { type: "string" },
      framing: { type: "string" },
      camera: { type: "string" },
      subject: { type: "string" },
      action: { type: "string" },
      setting: { type: "string" },
      lighting: { type: "string" },
      person: { type: "boolean" },
      graphic: { type: "boolean" },
      dialogue: { type: "string" },
      on_screen_text: { type: "string" },
    },
    required: ["index", "shot_type", "framing", "camera", "subject", "action", "setting", "lighting", "person", "graphic", "dialogue"],
  };
  return {
    type: "object",
    properties: { shots: { type: "array", items: shot } },
    required: ["shots"],
  };
}

/** The user turn: the measured cut list, the transcript and what the first read said. */
export function shotPlanPrompt(o) {
  const lines = [
    `This ad has exactly ${o.shots.length} shots, measured from its frames:`,
    ...o.shots.map((s, i) => `Shot ${i + 1}: ${s.start.toFixed(1)}s to ${s.end.toFixed(1)}s`),
    "",
    `After the video come ${o.shots.length} still frames, one per shot in the same order (frame 1 is from shot 1, and so on).`,
  ];
  if (o.transcript) lines.push("", `Transcript of what is said (verbatim): ${str(o.transcript, 3000)}`);
  if (o.summary) lines.push("", `An earlier, coarser read of the ad, for context only (its shot times are not reliable): ${str(o.summary, 2500)}`);
  lines.push("", `Return exactly ${o.shots.length} shots, index 1 to ${o.shots.length}.`);
  return lines.join("\n");
}

/** The model's shots laid onto the measured cuts (times always from the cuts). */
export function mergeShotPlan(measured, raw) {
  const list = Array.isArray(raw?.shots) ? raw.shots : Array.isArray(raw) ? raw : [];
  const byIndex = new Map();
  list.forEach((s, i) => {
    const idx = Number(s?.index);
    byIndex.set(Number.isInteger(idx) && idx >= 1 && idx <= measured.length && !byIndex.has(idx) ? idx : i + 1, s);
  });
  return measured.map((m, i) => {
    const s = byIndex.get(i + 1) ?? {};
    return {
      start: m.start,
      end: m.end,
      shot_type: str(s.shot_type, 60),
      framing: str(s.framing, 300),
      camera: str(s.camera, 200),
      subject: str(s.subject, 200),
      action: str(s.action, 400),
      setting: str(s.setting, 300),
      lighting: str(s.lighting, 160),
      person: s.person === true,
      graphic: s.graphic === true,
      dialogue: str(s.dialogue, 400),
      on_screen_text: str(s.on_screen_text, 300),
    };
  });
}

/** A plan worth using: most shots came back described. */
export function planIsUsable(plan) {
  if (!plan.length) return false;
  const described = plan.filter((s) => s.framing || s.action || s.subject).length;
  return described >= Math.ceil(plan.length * 0.6);
}

/** Pull the JSON out of a model reply (bare, fenced, or with text around it). */
export function parsePlanJson(text) {
  const t = String(text ?? "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Frames are drawn fresh (never edits of the source frame, which would carry
 * the original people and place through pixel for pixel), with the presenter
 * cropped like the ad. A frame without this style is drawn again before use.
 */
export const FRESH_FRAME_STYLE = "fresh-2";

export function isFreshFrame(shot) {
  return !!shot.clean_url && shot.clean_style === FRESH_FRAME_STYLE;
}

/**
 * The instruction for one shot's reference frame in a new version: a new photo
 * that only borrows the shot (angle, distance, framing, poses, action) from the
 * source frame. Every person and the place are new, so nothing can be
 * recognised as the original ad. "swap": the presenter is the person in the
 * second image; `people`: the shot has people in it (all new).
 *
 * (The crop rule: from a full-body cast photo the model drew the presenter
 * full-body in every shot, and nine such images tripped the video model's
 * content filter where the same frames cropped like the ad passed.)
 */
export function shotFramePrompt(kind, change = "", people = kind === "swap") {
  const edit = change.trim() ? `Show this in the frame: ${change.trim().slice(0, 600)}.` : "";
  const guide =
    "Make a brand-new photo: one frame from a new phone video that remakes the shot in the first image. Use the first image only as a guide to the shot: the camera angle, distance, framing, where the people and things sit in the frame, their poses and what is happening. Copy nothing else from it.";
  const presenter =
    kind === "swap"
      ? "The main person on camera is the person in the second image: their face, hair, skin, build and outfit, in the same pose, position and size in frame as the main person in the first image. Crop them exactly as the first image crops its main person: show only as much of their body as it shows (cut off at the chest or waist when it is), never more. The second image is only for who they are, not how much of them is seen."
      : "";
  const others = people
    ? kind === "swap"
      ? "Every other person in the frame is a completely different, newly invented person: a different face, hair, age, build, skin tone and clothing from anyone in the first image, so no one could be recognised."
      : "Every person in the frame is a completely different, newly invented person: a different face, hair, age, build, skin tone and clothing from anyone in the first image, so no one could be recognised."
    : "Do not add any person or hand that is not in the first image. Show a different but comparable subject of the same kind.";
  const place =
    "The place is a different real location of the same kind: a different building, walls, colours, layout, vehicles, furniture and props, so the frame could never be mistaken for the original footage.";
  const noText =
    "No captions, subtitles, words, stickers, emoji, logos, watermarks or on-screen overlays: the result has no text of any kind.";
  const real = "It must look like a real, unedited phone video frame with natural light, not a staged photo or an illustration.";
  return [guide, presenter, others, place, edit, noText, real].filter(Boolean).join(" ");
}
