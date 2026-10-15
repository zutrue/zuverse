/**
 * Step 1: read the ad. Gemini 3.1 Pro watches the clip (picture and sound)
 * and returns the recreation brief: shots, transcript, brand mentions,
 * on-screen text, the person, the place, the look and the sound.
 */

import { adaptScriptForBrand, hasSpokenScript, wordBudget, wordCount } from "./prompt.mjs";
import { chatText, MODELS, parseJsonObject, toolCall } from "./zurelay.mjs";

const SYSTEM_INSTRUCTION = `You are a precision video analyst for an ad recreation tool. The video you receive will be remade almost identically by a video model with a new cast and brand, so the model needs to know EXACTLY what happens, when, and how it looks and sounds. Describe; never summarise.

CRITICAL RULES:
- video_type: "ugc_speaker" when a person talks to camera, "showcase" when there is no on-camera speaker (product, space, b-roll), "mixed" for both.
- shots: split the whole video into 3-8 shots in order. Each shot gets its time range, shot type, camera movement, exactly what the subject does (gestures, eye-line, movement), the setting and props in frame, the dialogue spoken during it (verbatim), and any on-screen text visible during it.
- original_script: the complete word-for-word transcript of everything SPOKEN. Ignore on-screen text. Empty string when nothing is spoken.
- adapted_script: the same dialogue kept as close to verbatim as possible, only trimmed if it cannot fit the target runtime, with brand names swapped as instructed. Empty string when nothing is spoken. NEVER use quotation marks inside it. ASCII punctuation only.
- brand_mentions: every company, product or brand name said or shown, exactly as written.
- on_screen_text: every caption, title or overlay burned into the video, in order.
- subject_reference: for a speaker, be exhaustive (gender, apparent age, ethnicity, hair, build, clothing colours and style, accessories, expression, energy). For showcase, set demographics and attire to "none" and expression to the mood.
- environment: location, materials, colours, fixtures, props, and the lighting (natural or artificial, time of day, colour temperature).
- visual_style: smartphone UGC vs professional vs cinematic, handheld vs stabilised, lens feel, colour grade, aspect ratio.
- audio_guidelines: voice character (or "none") and background music/ambience in detail (genre, tempo, mood, instruments, energy).
- duration_seconds_estimate: the source video's length in whole seconds.
- Use only ASCII punctuation. No aggressive or shaming language.
Output valid JSON matching the schema.`;

/** The submit_video_analysis tool's arguments. */
export function responseSchema(budget) {
  const shot = {
    type: "object",
    properties: {
      time_range: { type: "string", description: "e.g. 0-3s" },
      shot_type: { type: "string", description: "wide / medium / close-up / insert / over-the-shoulder / product shot" },
      camera: { type: "string", description: "movement and angle: static, handheld push-in, slow pan, whip, tilt, tracking" },
      subject_action: { type: "string", description: "exactly what the subject does: gestures, eye-line, movement, expression" },
      setting: { type: "string", description: "what is in frame: setting, props, product" },
      dialogue: { type: "string", description: "words spoken during this shot, verbatim; empty if none" },
      on_screen_text: { type: "string", description: "text burned into the frame during this shot; empty if none" },
    },
    required: ["time_range", "shot_type", "camera", "subject_action", "setting"],
  };
  return {
    type: "object",
    properties: {
      video_type: { type: "string" },
      industry: { type: "string", description: "the trade or niche, e.g. Roofing, Dental, Solar" },
      product_or_service: { type: "string", description: "what is being sold, in one line" },
      duration_seconds_estimate: { type: "number" },
      hook: { type: "string", description: "the first 1-2 seconds: what grabs attention, spoken and visual" },
      original_script: { type: "string" },
      adapted_script: {
        type: "string",
        description: `Dialogue kept as close to verbatim as fits ${budget.high} words (absolute maximum ${budget.cap}); brand names swapped as instructed; empty when nothing is spoken.`,
      },
      brand_mentions: { type: "array", items: { type: "string" } },
      on_screen_text: { type: "array", items: { type: "string" } },
      subject_reference: {
        type: "object",
        properties: { demographics: { type: "string" }, attire: { type: "string" }, expression: { type: "string" } },
        required: ["demographics", "attire", "expression"],
      },
      environment: {
        type: "object",
        properties: { location: { type: "string" }, details: { type: "string" }, weather_lighting: { type: "string" } },
        required: ["location", "details", "weather_lighting"],
      },
      shots: { type: "array", items: shot, description: "3-8 shots covering the whole video in order" },
      visual_style: { type: "string" },
      audio_guidelines: {
        type: "object",
        properties: { voice_style: { type: "string" }, background_audio: { type: "string" } },
        required: ["voice_style", "background_audio"],
      },
      key_hooks: { type: "array", items: { type: "string" } },
    },
    required: [
      "video_type", "industry", "product_or_service", "duration_seconds_estimate", "hook", "original_script",
      "adapted_script", "brand_mentions", "on_screen_text", "subject_reference", "environment", "shots",
      "visual_style", "audio_guidelines",
    ],
  };
}

export function buildAnalysisPrompt(o) {
  const lines = [
    `Analyze this video ad so it can be recreated almost identically as a ${o.targetDuration}-second video${
      o.sourceDuration ? ` (the source is about ${o.sourceDuration} seconds)` : ""
    }.`,
    "Extract the transcript, every brand mention, every piece of on-screen text, the person, the setting, the sound, and a timed shot list that covers the whole video.",
    `The dialogue must stay as close to the original words as fits ${o.budget.low}-${o.budget.high} words (hard maximum ${o.budget.cap}). Spell out numbers, prices and percentages in words.`,
  ];
  if (o.companyName) {
    lines.push(`BRANDING: the remake is for "${o.companyName}". In adapted_script replace every original brand or company name with that name and keep everything else the same.`);
  } else if (o.removeBranding) {
    lines.push("BRANDING: the remake is brand-neutral. In adapted_script remove or generalise every brand or company name and keep everything else the same.");
  } else {
    lines.push("BRANDING: keep brand mentions as they are in adapted_script; list them in brand_mentions.");
  }
  if (o.refCount > 0) {
    lines.push(
      `RECAST: the user uploaded ${o.refCount} reference image${o.refCount === 1 ? "" : "s"} that will replace the cast/products${
        o.refNotes.filter(Boolean).length ? ` (${o.refNotes.map((n, i) => `image ${i + 1}: ${n || "unspecified"}`).join("; ")})` : ""
      }. Describe the original person/product in subject_reference anyway, so the remake matches their role, framing and energy.`,
    );
  }
  if (o.direction) lines.push(`USER DIRECTION for the remake (does not change what you extract, but note anything it makes irrelevant): ${o.direction}`);
  return lines.join("\n\n");
}

export function normalizeAnalysis(raw) {
  const str = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
  const list = (v, max = 40) => (Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean).slice(0, max) : []);
  const shots = (Array.isArray(raw?.shots) ? raw.shots : [])
    .map((s) => ({
      time_range: str(s?.time_range, 16),
      shot_type: str(s?.shot_type, 60),
      camera: str(s?.camera, 200),
      subject_action: str(s?.subject_action, 400),
      setting: str(s?.setting, 300),
      dialogue: str(s?.dialogue, 400),
      on_screen_text: str(s?.on_screen_text, 200),
    }))
    .filter((s) => s.subject_action || s.camera)
    .slice(0, 12);
  return {
    video_type: ["ugc_speaker", "showcase", "mixed"].includes(String(raw?.video_type)) ? raw.video_type : "ugc_speaker",
    industry: str(raw?.industry, 80) || "general business",
    product_or_service: str(raw?.product_or_service, 200),
    duration_seconds_estimate: Math.max(0, Math.round(Number(raw?.duration_seconds_estimate) || 0)),
    hook: str(raw?.hook, 300),
    original_script: str(raw?.original_script, 4000),
    adapted_script: str(raw?.adapted_script, 2000),
    brand_mentions: list(raw?.brand_mentions, 20),
    on_screen_text: list(raw?.on_screen_text, 40),
    subject_reference: {
      demographics: str(raw?.subject_reference?.demographics, 300),
      attire: str(raw?.subject_reference?.attire, 300),
      expression: str(raw?.subject_reference?.expression, 200),
    },
    environment: {
      location: str(raw?.environment?.location, 300),
      details: str(raw?.environment?.details, 500),
      weather_lighting: str(raw?.environment?.weather_lighting, 200),
    },
    shots,
    visual_style: str(raw?.visual_style, 300),
    audio_guidelines: {
      voice_style: str(raw?.audio_guidelines?.voice_style, 200),
      background_audio: str(raw?.audio_guidelines?.background_audio, 300),
    },
    key_hooks: list(raw?.key_hooks, 8),
  };
}

/** The script cut to fit `targetDuration` (the original wording kept wherever possible), or null. */
export async function tightenScript(script, targetDuration, budget = wordBudget(targetDuration)) {
  // Asked twice: an answer can come back empty (the model's thinking used the room) or a little long.
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = (await chatText({
      model: MODELS.text,
      messages: [{
        role: "user",
        content:
          `Tighten this spoken ad script so it fits ${targetDuration} seconds at a conversational pace. Target ${budget.low}-${budget.high} words, hard maximum ${budget.cap}. Keep the original wording wherever possible: cut filler first, then the least important sentence. Keep the hook, the offer details and the closing line. ASCII punctuation only, never use quotation marks. Return only the script.\n\nSCRIPT:\n${script}`,
      }],
      temperature: 0.3,
      maxTokens: 4096,
      label: "tighten script",
    })).replace(/^["']|["']$/g, "");
    if (out && wordCount(out) <= budget.cap && wordCount(out) >= Math.min(6, budget.low)) return out;
  }
  return null;
}

/**
 * Reads the ad from `videoDataUrl` (the clip, inline). The adapted script is
 * fitted to `targetDuration` and branded as asked.
 */
export async function readAd({ videoDataUrl, targetDuration, sourceDuration, companyName, removeBranding, refNotes = [], direction = "" }) {
  const budget = wordBudget(targetDuration);
  const userPrompt = buildAnalysisPrompt({
    targetDuration,
    sourceDuration,
    direction,
    companyName,
    removeBranding,
    refCount: refNotes.length,
    refNotes,
    budget,
  });
  const analysis = await toolCall({
    model: MODELS.read,
    system: SYSTEM_INSTRUCTION,
    user: [{ type: "video_url", video_url: { url: videoDataUrl } }, { type: "text", text: userPrompt }],
    tool: {
      name: "submit_video_analysis",
      description: "Submit the complete analysis of the video ad.",
      parameters: responseSchema(budget),
    },
    parse: (raw) => {
      const parsed = parseJsonObject(raw);
      return parsed ? normalizeAnalysis(parsed) : null;
    },
    label: "reading the ad",
    timeoutMs: 900_000,
    maxTokens: 16_384,
    temperature: 0.2,
  });

  let script = String(analysis.adapted_script || analysis.original_script || "").trim();
  if (hasSpokenScript(script)) {
    script = adaptScriptForBrand(script, analysis.brand_mentions ?? [], companyName, removeBranding);
    if (wordCount(script) > budget.cap) {
      const tightened = await tightenScript(script, targetDuration, budget);
      if (tightened) script = tightened;
    }
  } else {
    script = "";
  }
  analysis.adapted_script = script;
  analysis.condensed_script = script;
  return analysis;
}
