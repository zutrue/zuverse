/**
 * The pipeline's decisions (pure): the settings, the user's edits and
 * direction carried onto the plan, which frames to draw, and the final
 * prompt + reference images. The same rules as the Zuops copier pipeline:
 *
 *   read      Gemini reads the ad (analysis.json)
 *   direct    "Anything else to change?" worked into the plan (direction.json, by Claude)
 *   cast      a similar but different person, when no photo of the person was given
 *   map       "Make a new version": the measured cuts described shot by shot
 *   frames    each shot's frame drawn fresh (same shot, new people, a new place, no text)
 *   prompt    the prompt built, the references picked
 *   render    Seedance 2.5 makes the video
 */

import { isFreshFrame } from "./shot-plan.mjs";
import {
  applyVoicePlan,
  buildRecreationPrompt,
  copierMode,
  copierVoice,
  stripOnScreenText,
  videoShowsText,
  withNoMusicRules,
  withNoTextRules,
} from "./prompt.mjs";

/** Reference images one Seedance 2.5 render takes (photos + shot frames). */
export const MAX_REFERENCE_IMAGES = 9;

const str = (v, max) => String(v ?? "").trim().slice(0, max);

/**
 * settings.json, checked. Photos are local files (or https links) with a note
 * saying who or what each one is.
 */
export function cleanSettings(raw) {
  const r = raw ?? {};
  const mode = copierMode(r.mode);
  const photos = (Array.isArray(r.photos) ? r.photos : [])
    .map((p) => (typeof p === "string" ? { url: p } : { url: p?.url ?? p?.path, note: p?.note, generated: p?.generated }))
    .filter((p) => typeof p.url === "string" && p.url.trim())
    .slice(0, 9)
    .map((p) => ({ url: String(p.url).trim(), note: str(p.note, 200) || undefined, generated: p.generated === true || undefined }));
  const aspect = r.aspectRatio === "landscape" || r.aspectRatio === "square" ? r.aspectRatio : "portrait";
  const resolution = r.resolution === "480p" || r.resolution === "1080p" ? r.resolution : "720p";
  return {
    mode,
    voice: copierVoice(r.voice, mode, "new"),
    aspectRatio: aspect,
    durationSeconds: Math.min(30, Math.max(4, Math.round(Number(r.durationSeconds) || 15))),
    resolution,
    photos,
    lookalike: r.lookalike !== false,
    notes: str(r.notes, 2000),
    companyName: str(r.companyName, 80),
    removeBranding: r.removeBranding === true,
    noText: r.noText !== false,
    noMusic: r.noMusic === true,
    script: typeof r.script === "string" && r.script.trim() ? r.script.trim().slice(0, 3000) : null,
    keepOnScreenText: r.keepOnScreenText === true,
    // "images=off": no generated face or shot frame goes to the video model (it casts from the words).
    sendImages: r.sendImages !== false && r.images !== false && r.images !== "off",
    promptOverride: typeof r.promptOverride === "string" && r.promptOverride.trim() ? r.promptOverride.slice(0, 20_000) : null,
  };
}

/** True when the ad has an on-camera person to cast for. */
export function hasPresenter(analysis) {
  if (!analysis) return false;
  const demo = String(analysis.subject_reference?.demographics ?? "").trim();
  if (analysis.video_type === "showcase") return false;
  if (/^(none|n\/a|no (person|people|one|presenter)|nobody)\b/i.test(demo)) return false;
  return !!demo || !!analysis.product_or_service;
}

/** A cast is made when the switch is on, the ad has a person and the user gave no photo of their own. */
export function needsCast(settings, analysis) {
  return settings.lookalike && hasPresenter(analysis) && settings.photos.length === 0;
}

/** The ad's plan with the planned direction applied (direction.json). */
export function directedAnalysis(analysis, r) {
  if (!r) return analysis;
  const a = analysis ?? {};
  const shots = Array.isArray(r.shots) && r.shots.length ? r.shots.map((s, i) => ({ ...(a.shots?.[i] ?? {}), ...s })) : a.shots;
  return {
    ...a,
    hook: r.hook || a.hook,
    subject_reference: r.person_changed ? { ...(a.subject_reference ?? {}), ...r.person } : a.subject_reference,
    environment: { ...(a.environment ?? {}), ...(r.environment ?? {}) },
    shots,
    visual_style: r.visual_style || a.visual_style,
    audio_guidelines: { ...(a.audio_guidelines ?? {}), background_audio: r.background_audio || a.audio_guidelines?.background_audio },
  };
}

/* ── the user's edits, carried onto the measured shots ── */

/** "2-6s" / "2.5-6s" / "2 - 6 s" -> [2, 6]. */
export function parseTimeRange(raw) {
  const m = String(raw ?? "").match(/(\d+(?:\.\d+)?)\s*s?\s*[-–to]+\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
}

const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * What the final plan (the user's edits, then their direction) changes from
 * the ad as read: beats whose action or on-screen text changed, and the
 * setting. The measured shots and their frames must show these, or the frames
 * (cut from the original ad) win over the words.
 */
export function planEdits(original, final) {
  const out = { beats: [], setting: null, scale: 1 };
  if (!original || !final) return out;
  const before = new Map();
  for (const s of original.shots ?? []) before.set(norm(s.time_range), s);
  // A new version's direction times its beats on the remake's clock (0 to its
  // length), the measured shots run on the ad's: shots are matched by where
  // they fall in the ad, not by raw seconds.
  const lastEnd = (shots) => Math.max(0, ...(shots ?? []).map((s) => parseTimeRange(s.time_range)?.[1] ?? 0));
  const from = lastEnd(original.shots);
  const to = lastEnd(final.shots);
  if (from > 0 && to > 0 && Math.abs(to - from) > 0.5) out.scale = to / from;
  (final.shots ?? []).forEach((s, i) => {
    const range = parseTimeRange(s.time_range);
    if (!range) return;
    const was = before.get(norm(s.time_range)) ?? (out.scale !== 1 ? original.shots?.[i] : undefined);
    const action = String(s.subject_action ?? "").trim();
    const text = String(s.on_screen_text ?? "").trim();
    const actionChanged = !!action && norm(action) !== norm(was?.subject_action);
    const textChanged = norm(text) !== norm(was?.on_screen_text);
    if (actionChanged || (was && textChanged)) {
      out.beats.push({ range, action: actionChanged ? action : undefined, onScreenText: textChanged ? text : undefined });
    }
  });
  const e0 = original.environment ?? { location: "", details: "", weather_lighting: "" };
  const e1 = final.environment ?? e0;
  if (norm(e0.location) !== norm(e1.location) || norm(e0.details) !== norm(e1.details) || norm(e0.weather_lighting) !== norm(e1.weather_lighting)) {
    out.setting = [e1.location, e1.details, e1.weather_lighting ? `Light: ${e1.weather_lighting}` : ""]
      .map((x) => String(x ?? "").trim().replace(/[.\s]+$/, ""))
      .filter(Boolean)
      .join(". ");
  }
  return out;
}

/** The edited beat a measured shot falls in (by its middle, on the edited plan's clock), if any. */
export function editFor(shot, edits) {
  const mid = ((Number(shot.start) + Number(shot.end)) / 2) * (edits.scale ?? 1);
  return edits.beats.find((b) => mid >= b.range[0] && mid < b.range[1]);
}

/** What a shot's frame must show that the original frame does not ("" = nothing). */
export function shotChange(shot, edits) {
  if (shot.graphic) return "";
  const beat = editFor(shot, edits);
  return [beat?.action ?? "", edits.setting ? `The place: ${edits.setting}` : ""].filter(Boolean).join(". ");
}

/**
 * The measured shots with the user's edits in their words (action, on-screen
 * text) and a changed place in every filmed shot (the shot's own place and
 * light described the original's, which would fight the new one).
 */
export function applyPlanEdits(shots, edits) {
  if (!edits.beats.length && !edits.setting) return shots;
  return shots.map((s) => {
    if (s.graphic) return s;
    const beat = editFor(s, edits);
    return {
      ...s,
      ...(edits.setting ? { setting: edits.setting, lighting: "" } : {}),
      ...(beat?.action ? { subject: "", action: beat.action } : {}),
      ...(beat && beat.onScreenText !== undefined ? { on_screen_text: beat.onScreenText } : {}),
    };
  });
}

/**
 * Frames still to draw for this cast and these edits: missing, not drawn
 * fresh, drawn with another cast, or drawn before the user changed what the
 * shot shows.
 */
export function framesToMake(shots, castUrl, edits) {
  const out = [];
  shots.forEach((s, i) => {
    if (s.graphic || !s.frame_url) return;
    if (!isFreshFrame(s)) out.push(i);
    else if (s.person && castUrl && s.clean_cast !== castUrl) out.push(i);
    else if (edits && (s.clean_change ?? "") !== shotChange(s, edits)) out.push(i);
  });
  return out;
}

/** The analysis with the plan's shots, each pointing at its fresh frame as @Image{n} after `photoCount` photos. */
export function withShotPlan(analysis, shots, photoCount) {
  const frameUrls = [];
  const room = Math.max(0, MAX_REFERENCE_IMAGES - photoCount);
  const planned = shots.map((s) => {
    let frameRef;
    if (!s.graphic && isFreshFrame(s) && frameUrls.length < room) {
      frameUrls.push(String(s.clean_url));
      frameRef = photoCount + frameUrls.length;
    }
    const subject = String(s.subject ?? "").trim().replace(/[.\s]+$/, "");
    const action = String(s.action ?? "").trim();
    return {
      time_range: `${s.start}-${s.end}s`,
      start: Number(s.start),
      end: Number(s.end),
      shot_type: String(s.shot_type ?? ""),
      framing: s.framing,
      camera: String(s.camera ?? ""),
      subject_action: subject && action ? `${subject}: ${action}` : subject || action,
      setting: String(s.setting ?? ""),
      lighting: s.lighting,
      person: s.person,
      graphic: s.graphic,
      dialogue: s.dialogue,
      on_screen_text: s.on_screen_text,
      frame_ref: frameRef,
    };
  });
  return { analysis: { ...analysis, shots: planned }, frameUrls };
}

/** The photos that go to the renderer: the user's own, then the cast face. */
export function runPhotos(settings, castUrl) {
  const photos = [...settings.photos];
  if (castUrl && !photos.some((p) => p.url === castUrl)) {
    photos.push({ url: castUrl, note: "the person on camera — use this face", generated: true });
  }
  return photos.slice(0, 9);
}

/** The cast face (or first photo) whose voice the new person gets; none for a product-only ad. */
export function castPhotoFor(photos, analysis) {
  if (analysis?.video_type === "showcase") return undefined;
  return (photos.find((p) => p.generated) || photos[0])?.url;
}

/** Fresh frames that show the presenter drawn from this photo. */
export function presenterFrames(shots, photo) {
  return shots
    .filter((s) => !s.graphic && s.person && isFreshFrame(s) && s.clean_cast === photo)
    .map((s) => String(s.clean_url));
}

/**
 * The prompt and the reference images for a render.
 *
 * @param {object} o
 * @param {ReturnType<typeof cleanSettings>} o.settings
 * @param {object} o.analysis the plan (the user's edited one, else the read)
 * @param {object|null} [o.direction] direction.json
 * @param {object[]|null} [o.planShots] the described, framed shots ("new" mode)
 * @param {string|null} [o.castUrl]
 * @param {boolean} o.hasSourceVideo
 * @param {object|null} [o.originalAnalysis] the ad as read, before edits
 */
export function buildRunPrompt(o) {
  const { settings } = o;
  // With images off, the cast face and the drawn frames stay home; the user's own photos still go.
  const castUrl = settings.sendImages ? o.castUrl : null;
  const photos = runPhotos(settings, castUrl);
  const directed = directedAnalysis(o.analysis, o.direction);
  const ownScript = String(directed.adapted_script || directed.condensed_script || "");
  const script = settings.script ?? (o.direction?.script_changed && o.direction.script ? o.direction.script : ownScript);
  // Your own words replace the ad's: its per-beat lines would fight them, so they go.
  let analysis = settings.script && settings.script.trim() !== ownScript.trim()
    ? { ...directed, shots: (directed.shots ?? []).map(({ dialogue: _said, ...s }) => s) }
    : directed;
  let frameUrls = [];
  let sent = photos;
  let voicePhoto;
  if (settings.mode === "new" && o.planShots?.length) {
    // The measured shots replace the read's beats, so the user's beat edits are carried onto them.
    const edits = planEdits(o.originalAnalysis ?? o.analysis, directed);
    const shots = applyPlanEdits(settings.sendImages ? o.planShots : o.planShots.map((s) => ({ ...s, clean_url: null })), edits);
    let planned = withShotPlan(directed, shots, photos.length);
    // Frames that already show the presenter carry their face: the photo
    // itself stays home (with it, nine images of one person tripped the video
    // model's content filter) and its slot goes to another frame.
    const face = castPhotoFor(photos, directed);
    if (face) {
      const without = photos.filter((p) => p.url !== face);
      const tried = withShotPlan(directed, shots, without.length);
      const showing = presenterFrames(shots, face).filter((u) => tried.frameUrls.includes(u));
      if (showing.length >= 2) {
        planned = tried;
        sent = without;
        voicePhoto = showing[0];
      }
    }
    analysis = planned.analysis;
    frameUrls = planned.frameUrls;
  }
  if (settings.noText) analysis = stripOnScreenText(analysis);
  const showsText = videoShowsText({
    noText: settings.noText,
    keepOnScreenText: settings.keepOnScreenText,
    directionText: !!o.direction?.on_screen_text,
    analysis,
  });
  const silentReference = settings.mode === "replace" && settings.voice === "new" && o.hasSourceVideo;
  let prompt = buildRecreationPrompt(analysis, {
    durationSeconds: settings.durationSeconds,
    aspectRatio: settings.aspectRatio,
    hasReferenceVideo: settings.mode === "replace" && o.hasSourceVideo,
    referenceImages: sent.map((p, i) => ({ index: i + 1, note: p.note })),
    recastPrompt: settings.notes || undefined,
    directionExtras: o.direction?.extras,
    companyName: settings.companyName || undefined,
    removeBranding: settings.removeBranding && !settings.companyName,
    script,
    noText: !showsText,
    mode: settings.mode,
    voice: settings.voice,
    silentReference,
    presenterFromFrames: sent !== photos,
  });
  prompt = applyVoicePlan(prompt, { mode: settings.mode, voice: settings.voice, silentReference });
  prompt = withNoMusicRules(withNoTextRules(prompt, settings.noText), settings.noMusic);
  // Frames go along only when the prompt points at them.
  const sendFrames = frameUrls.length > 0 && prompt.includes(`@Image${sent.length + 1}`);
  return {
    prompt,
    refs: [...sent.map((p) => p.url), ...(sendFrames ? frameUrls : [])],
    frameCount: sendFrames ? frameUrls.length : 0,
    script,
    ...(voicePhoto ? { voicePhoto } : {}),
  };
}
