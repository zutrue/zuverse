/**
 * The Zurelay API (https://zurelay.com): one OpenAI-compatible key for every
 * model Zuverse uses.
 *
 *   gemini-3.1-pro           watches the ad (video + sound) and plans it
 *   gemini-3.8-flash         small text jobs (voice from a photo, who says what)
 *   gpt-image-2.5-sunburst   the cast photo and the shot frames
 *   seedance-2.5             the video
 *
 * Everything goes inline as data URLs, so nothing has to be hosted anywhere.
 * Requests use node:https rather than fetch: a long, non-streamed answer
 * (a video read, an image) can take longer than fetch's 5-minute wait for
 * response headers.
 */

import https from "node:https";
import { URL } from "node:url";

export const ZURELAY_BASE_URL = (process.env.ZURELAY_BASE_URL || "https://api.zurelay.com/v1").replace(/\/+$/, "");
export const SIGNUP_URL = "https://zurelay.com";
export const BILLING_URL = "https://zurelay.com/app/billing";

export const MODELS = {
  read: "gemini-3.1-pro",
  text: "gemini-3.8-flash",
  image: "gpt-image-2.5-sunburst",
  video: "seedance-2.5",
};

/** Answers in the same family when the image model is down (Zurelay tries them in order). */
const IMAGE_BACKUPS = { "gpt-image-2.5-sunburst": ["gpt-image-2.5-flare"] };

export class ZurelayError extends Error {
  constructor(message, { status = 0, code = "", retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function apiKey() {
  const key = String(process.env.ZURELAY_API_KEY ?? "").trim();
  if (!key) {
    throw new ZurelayError(
      `No Zurelay API key. Make one at ${SIGNUP_URL} (API keys), then put it in a .env file next to Zuverse: ZURELAY_API_KEY=zr_live_...`,
      { code: "missing_api_key" },
    );
  }
  return key;
}

/** A readable message for an API error (never echoes the key). */
function explain(status, body) {
  const code = String(body?.error?.code ?? body?.error?.type ?? "");
  const message = String(body?.error?.message ?? "").slice(0, 500);
  if (status === 401) return "Zurelay refused the API key. Check ZURELAY_API_KEY in your .env file.";
  if (status === 402) return `Your Zurelay balance doesn't cover this request. Add credit at ${BILLING_URL} and run it again.`;
  if (status === 413) return "A file is too large for Zurelay (20 MB a file, 25 MB a request). Use a shorter clip.";
  return `Zurelay ${status}${code ? ` ${code}` : ""}: ${message || "request failed"}`;
}

function rawRequest(method, path, { body, timeoutMs = 600_000, headers = {} } = {}) {
  const url = new URL(`${ZURELAY_BASE_URL}${path}`);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "User-Agent": "zuverse/1.0 (+https://github.com/zutrue/zuverse)",
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new ZurelayError(`Zurelay didn't answer within ${Math.round(timeoutMs / 1000)} s.`, { code: "timeout" })));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One API call, retried while Zurelay says to wait (429 busy, 503 the model
 * is down for a moment). Nothing that may have been accepted is sent twice:
 * a timeout or a dropped connection is not retried.
 */
export async function api(method, path, { body, timeoutMs, headers, retries = 4, label = path } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await rawRequest(method, path, { body, timeoutMs, headers });
    let json = null;
    try {
      json = JSON.parse(res.buffer.toString("utf8"));
    } catch {
      json = null;
    }
    if (res.status >= 200 && res.status < 300) return { json, headers: res.headers, buffer: res.buffer };
    const retryAfter = Number(res.headers["retry-after"]) || 0;
    const shouldRetry = (res.status === 429 || res.status === 503 || res.status === 500) && res.headers["x-should-retry"] !== "false";
    if (shouldRetry && attempt < retries) {
      const wait = Math.min(60, Math.max(retryAfter, 5 * (attempt + 1)));
      process.stderr.write(`  ${label}: Zurelay is busy (${res.status}), trying again in ${wait} s...\n`);
      await sleep(wait * 1000);
      continue;
    }
    throw new ZurelayError(explain(res.status, json), {
      status: res.status,
      code: String(json?.error?.code ?? ""),
      retryAfter,
    });
  }
}

/* ─────────────────────────────── chat ─────────────────────────────── */

/** The arguments of the forced tool call in a reply, as text (or JSON written as plain text). */
export function toolArgumentsText(payload, name) {
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== "object") return null;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const call = calls.find((c) => c?.function?.name === name) ?? calls[0];
  const args = call?.function?.arguments;
  if (typeof args === "string" && args.trim()) return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";
  return text.includes("{") ? text : null;
}

/** A JSON object from a reply: as it is, or the outermost {...} in it. */
export function parseJsonObject(raw) {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  for (const candidate of [text, start >= 0 && end > start ? text.slice(start, end + 1) : ""]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * One forced tool call: the model answers with the tool's arguments, which
 * `parse` checks. An answer in the wrong shape is asked for once more.
 */
export async function toolCall({ model, system, user, tool, parse, maxTokens, temperature, timeoutMs = 900_000, label }) {
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools: [{ type: "function", function: tool }],
    tool_choice: { type: "function", function: { name: tool.name } },
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (typeof temperature === "number") body.temperature = temperature;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { json } = await api("POST", "/chat/completions", { body, timeoutMs, headers: { "x-zurelay-fallback": "off" }, label });
    const raw = toolArgumentsText(json, tool.name);
    let value = null;
    try {
      value = raw ? parse(raw) : null;
    } catch {
      value = null;
    }
    if (value) return value;
    process.stderr.write(`  ${label}: the answer wasn't in the expected shape${attempt ? "" : ", asking once more"}...\n`);
  }
  throw new ZurelayError(`${label}: the model didn't return a usable answer. Run it again.`, { code: "bad_output" });
}

/** A short text answer (smart routing on: any close model may answer). Returns "" on failure. */
export async function chatText({ model = MODELS.text, messages, maxTokens = 2048, temperature, responseFormat, timeoutMs = 120_000, label }) {
  try {
    const body = { model, messages, max_tokens: maxTokens };
    if (typeof temperature === "number") body.temperature = temperature;
    if (responseFormat) body.response_format = responseFormat;
    const { json } = await api("POST", "/chat/completions", { body, timeoutMs, headers: { "x-zurelay-fallback": "auto" }, retries: 2, label });
    const raw = json?.choices?.[0]?.message?.content;
    const content = Array.isArray(raw) ? raw.map((p) => p?.text || "").join(" ") : String(raw || "");
    // Some routes put the model's reasoning first; only the answer after it counts.
    return content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
  } catch (e) {
    process.stderr.write(`  ${label}: ${e.message}\n`);
    return "";
  }
}

/* ─────────────────────────────── images ─────────────────────────────── */

/**
 * One GPT Image 2.5 image, returned as bytes exactly as made. With input
 * images it is an edit (/images/edits); the images go as data URLs. Asked for
 * as a link: that file keeps the image's content credentials (C2PA, "made by
 * AI"), which the video model's filter reads; base64 answers come without them.
 */
export async function makeImage({ prompt, images = [], size, quality = "medium", outputFormat = "jpeg", model = MODELS.image, label = "image" }) {
  const body = { model, prompt, n: 1, response_format: "url", quality, output_format: outputFormat };
  if (IMAGE_BACKUPS[model]) body.models = IMAGE_BACKUPS[model];
  if (size) body.size = size;
  if (images.length) body.images = images;
  const { json, headers } = await api("POST", images.length ? "/images/edits" : "/images/generations", {
    body,
    timeoutMs: 600_000,
    headers: { "x-zurelay-fallback": "off" },
    retries: 3,
    label,
  });
  if (headers["x-zurelay-routed-from"]) process.stderr.write(`  ${label}: ${model} was busy, made with ${headers["x-zurelay-model"] ?? "a backup model"}\n`);
  const item = json?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new ZurelayError(`${label}: couldn't download the image (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new ZurelayError(`${label}: no image came back.`, { code: "image_not_generated" });
}

/* ─────────────────────────────── video ─────────────────────────────── */

/** Starts a video. Not retried after a request that may have been accepted. */
export async function createVideo(body) {
  const { json } = await api("POST", "/videos", { body, timeoutMs: 300_000, headers: { "x-zurelay-fallback": "off" }, retries: 3, label: "video" });
  if (!json?.id) throw new ZurelayError("Zurelay didn't return a video id.");
  return json;
}

export async function getVideo(id) {
  const { json } = await api("GET", `/videos/${encodeURIComponent(id)}`, { timeoutMs: 60_000, retries: 6, label: "video status" });
  return json;
}

/** The finished MP4 as bytes. */
export async function downloadVideo(id) {
  const { buffer } = await api("GET", `/videos/${encodeURIComponent(id)}/content`, { timeoutMs: 600_000, retries: 3, label: "video download" });
  return buffer;
}

/**
 * Customer-readable reason for a failed video (failed videos are free).
 * `mode` is the render's mode: a new version is already made, so it is told to
 * send no images instead.
 */
export function videoFailureMessage(error, { mode = "", project = "<project>" } = {}) {
  const code = String(error?.code ?? "");
  if (code === "content_policy") {
    const declined = "The video model declined this request under its content rules (failed videos are free).";
    if (mode === "new") {
      return `${declined} Render once more (it can pass on a second try). If it's declined again, run \`zuverse set ${project} images=off\`, then \`zuverse prompt ${project}\` and \`zuverse render ${project} --yes\`: no face or frame is sent and the video model casts the new person from the written plan.`;
    }
    return `${declined} Try other cast photos (cropped head-and-shoulders, everyday clothes), fewer reference images, or Make a new version.`;
  }
  if (code === "invalid_image") return "One of the reference images couldn't be used (JPG/PNG/WebP, 300 to 6000 px a side). Failed videos are free.";
  if (code === "generation_timeout") return "The video took too long to make (failed videos are free). Try again.";
  return `The video couldn't be made this time (failed videos are free): ${String(error?.message ?? code ?? "").slice(0, 200)}`;
}
