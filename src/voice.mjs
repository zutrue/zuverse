/**
 * The new-voice steps: the new person's voice read from their photo (so every
 * line is spoken in a voice that fits them, never the original speaker's),
 * and who says which line when a second voice speaks (a phone call, someone
 * behind the camera). Both are best effort: "" / [] when they can't be done.
 */

import { chatText, MODELS } from "./zurelay.mjs";

/** The new person's voice in one short phrase, read from their photo. */
export async function voiceFor(photoDataUrl) {
  const content = await chatText({
    model: MODELS.text,
    messages: [
      {
        role: "system",
        content:
          "You describe the speaking voice a person in a photo would most plausibly have, for a video voice actor. Reply with one short phrase only, like: a man in his early 30s with a warm, mid-range voice and a relaxed American accent. Include gender and apparent age.",
      },
      { role: "user", content: [{ type: "text", text: "The person on screen:" }, { type: "image_url", image_url: { url: photoDataUrl } }] },
    ],
    maxTokens: 1024,
    label: "reading the new voice",
  });
  const text = content
    .replace(/\*\*[^*]*\*\*/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(voice|answer)\s*:\s*/i, "")
    .split(/(?<=[.!?])\s/)[0]
    .replace(/^["'*]+|["'*]+$/g, "")
    .trim()
    .slice(0, 200);
  return text.length >= 8 ? text : "";
}

const cleanLine = (s) => String(s || "").replace(/\s+/g, " ").replace(/"/g, "'").trim();

const SPEAKER_LABEL_PROMPT =
  'You split the transcript of a short video ad into who says each sentence. The person on camera is the one filming or presenting the ad. Anyone else is off camera: the other end of a phone call, someone behind the camera, a voice-over. Listen to the voices in the video and use what is said (a receptionist answering a phone, a question and its answer) to decide. If only one person speaks, reply {"turns":[]}. Otherwise reply with JSON only: {"turns":[{"on":true,"text":"..."},{"on":false,"text":"..."}]} covering every word of the transcript exactly once, in order, with the text copied exactly.';

/** The labeller's reply as turns (consecutive lines of one side merged), or [] when unusable. */
export function parseLabelledTurns(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.turns) ? parsed.turns : [];
  const out = [];
  for (const raw of list) {
    const t = raw && typeof raw === "object" ? raw : {};
    const line = cleanLine(String(t.text ?? ""));
    if (!line) continue;
    const onScreen = t.on !== false;
    const last = out[out.length - 1];
    if (last && last.onScreen === onScreen) last.text = `${last.text} ${line}`;
    else out.push({ onScreen, text: line });
  }
  return out.some((t) => !t.onScreen) ? out : [];
}

/** Turns are only trusted when they hold (nearly) every word of the script. */
export function turnsCoverScript(turns, script) {
  const count = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
  const scriptWords = count(script);
  if (!turns.length) return false;
  if (!scriptWords) return true;
  return turns.reduce((n, t) => n + count(t.text), 0) >= scriptWords * 0.9;
}

/** Who says which line of `script`, heard from the clip; [] when one voice speaks. */
export async function speakerTurns(videoDataUrl, script) {
  if (!String(script || "").trim()) return [];
  const content = await chatText({
    model: MODELS.text,
    messages: [
      { role: "system", content: SPEAKER_LABEL_PROMPT },
      {
        role: "user",
        content: [
          { type: "video_url", video_url: { url: videoDataUrl } },
          { type: "text", text: `TRANSCRIPT:\n${script}` },
        ],
      },
    ],
    responseFormat: { type: "json_object" },
    maxTokens: 4096,
    timeoutMs: 180_000,
    label: "hearing who speaks",
  });
  const turns = parseLabelledTurns(content);
  return turnsCoverScript(turns, script) ? turns : [];
}
