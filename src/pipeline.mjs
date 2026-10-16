/**
 * The steps, each saving what it makes in the project folder:
 *
 *   fetch    the ad -> source + clip.mp4 (first 29 s, sized for Seedance)
 *   read     Gemini 3.1 Pro reads it (analysis.json); the cuts are measured (shots.json)
 *   cast     a similar but different person (cast/), unless you gave photos
 *   frames   "Make a new version": every shot described, then drawn fresh (frames/)
 *   prompt   the video prompt + its references (prompt.txt, render-plan.json)
 *   render   Seedance 2.5 makes the video (zuverse-*.mp4)
 *   edit     only when asked: pauses cut, captions, zooms, stickers (zuverse-*-edit-*.mp4)
 */

import { rename, mkdir, rm, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { readAd, tightenScript } from "./analyze.mjs";
import { detectShots, frameTimeFor } from "./cuts.mjs";
import { planFrom, sanitizeDirection } from "./direction.mjs";
import {
  buildAss,
  cleanEdit,
  cleanWords,
  editFilter,
  keptSeconds,
  parseSilences,
  planKeeps,
  quietLevel,
  WORDS_SYSTEM,
  wordsPrompt,
  wordsSchema,
  zoomsFor,
} from "./edit.mjs";
import {
  AI_VIDEO_MAX_BYTES,
  dataUrl,
  fitVideoUnder,
  grabFrames,
  muteVideo,
  normalizePhoto,
  probe,
  quietReport,
  REFERENCE_MAX_SECONDS,
  removeQuietly,
  renderEdit,
  saveImage,
  shrinkImage,
  speechLoudness,
  transcodeReference,
} from "./media.mjs";
import { aspectFor, castPrompt, imageSize, PHOTO_FORMAT, PHOTO_QUALITY } from "./photo.mjs";
import { renderResolution, usd, videoCost } from "./pricing.mjs";
import { createProject, slug } from "./project.mjs";
import {
  adaptScriptForBrand,
  applyVoicePlan,
  copierRenderPlan,
  dialogueFromPrompt,
  hasSpokenScript,
  withNoTextRules,
  withSeedanceReferenceHints,
  wordBudget,
  wordCount,
} from "./prompt.mjs";
import {
  buildRunPrompt,
  castPhotoFor,
  cleanSettings,
  directedAnalysis,
  framesToMake,
  needsCast,
  planEdits,
  runPhotos,
  shotChange,
} from "./run.mjs";
import {
  cleanMeasuredShots,
  FRESH_FRAME_STYLE,
  mergeShotPlan,
  parsePlanJson,
  planIsUsable,
  SHOT_PLAN_SYSTEM,
  shotFramePrompt,
  shotPlanPrompt,
  shotPlanSchema,
} from "./shot-plan.mjs";
import { getSource } from "./source.mjs";
import { speakerTurns, voiceFor } from "./voice.mjs";
import { createVideo, downloadVideo, getVideo, makeImage, MODELS, parseJsonObject, toolCall, videoFailureMessage } from "./zurelay.mjs";

const log = (msg) => process.stderr.write(`${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seedance's longest prompt, less room for the reference hints put in front. */
const MAX_PROMPT_CHARS = 7_750;
/** Zurelay's request limit is 25 MB (data URLs included). */
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

function shapeOf(width, height) {
  if (!width || !height) return "portrait";
  const r = width / height;
  return r > 1.2 ? "landscape" : r < 0.85 ? "portrait" : "square";
}

/* ─────────────────────────────── fetch ─────────────────────────────── */

export async function fetchStep(root, input, { name, html, adId } = {}) {
  const guess = name || (html ? `fb-ad-${adId ?? "saved"}` : /^https?:/i.test(String(input)) ? slug(input).replace(/^(tiktok-com|instagram-com|facebook-com)-?/, "") : path.parse(String(input)).name);
  const project = await createProject(root, guess);
  try {
    log(`Getting the ad...`);
    const download = project.file("source.download");
    const got = await getSource(input, download, { html, adId });
    const ext = !/^https?:/i.test(String(input ?? "")) && input ? path.extname(String(input)).toLowerCase() || ".mp4" : ".mp4";
    const source = project.file(`source${ext}`);
    await rename(download, source);
    const original = await probe(source);
    if (!original.hasVideo) throw new Error("That file has no video in it.");

    log(original.duration > REFERENCE_MAX_SECONDS + 0.05 ? `Trimming to the first ${REFERENCE_MAX_SECONDS} seconds...` : "Preparing the clip...");
    await transcodeReference(source, project.file("clip.mp4"));
    const clip = await probe(project.file("clip.mp4"));

    const info = {
      input: html ? `saved page ${path.basename(html)} (ad ${adId})` : String(input),
      via: got.via,
      title: got.title ?? null,
      sourceSeconds: original.duration ? Math.round(original.duration * 10) / 10 : null,
      clipSeconds: clip.duration ? Math.round(clip.duration * 10) / 10 : null,
      trimmed: !!original.duration && original.duration > REFERENCE_MAX_SECONDS + 0.05,
      width: clip.width,
      height: clip.height,
      hasAudio: clip.hasAudio,
      createdAt: new Date().toISOString(),
    };
    await project.writeJson("info.json", info);
    await project.writeJson(
      "settings.json",
      cleanSettings({ aspectRatio: shapeOf(original.width, original.height), durationSeconds: Math.min(30, Math.max(4, Math.round(clip.duration ?? 15))) }),
    );
    return { project, info };
  } catch (e) {
    await rm(project.dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/* ─────────────────────────────── read ─────────────────────────────── */

/** The clip the AI watches: clip.mp4, or a smaller copy of it. */
async function aiClip(project) {
  const clip = project.file("clip.mp4");
  if (project.has("clip-ai.mp4")) return project.file("clip-ai.mp4");
  const fitted = await fitVideoUnder(clip, project.file("clip-ai.mp4"), AI_VIDEO_MAX_BYTES);
  return fitted;
}

export async function readStep(project) {
  const info = await project.readJson("info.json");
  const settings = cleanSettings(await project.readJson("settings.json", {}));
  const sourceDuration = Math.round(info.clipSeconds ?? 15);
  const cap = Math.max(4, Math.min(30, sourceDuration || 30));
  const targetDuration = Math.min(cap, Math.max(4, settings.durationSeconds || sourceDuration));

  log(`Reading the ad shot by shot (${MODELS.read})...`);
  const analysis = await readAd({
    videoDataUrl: await dataUrl(await aiClip(project)),
    targetDuration,
    sourceDuration,
    companyName: settings.companyName || undefined,
    removeBranding: settings.removeBranding,
    refNotes: settings.photos.map((p) => p.note ?? ""),
    direction: settings.notes,
  });
  await project.writeJson("analysis.json", analysis);

  log("Measuring the cuts...");
  const { shots } = await detectShots(project.file("clip.mp4"));
  await mkdir(project.file("shots"), { recursive: true });
  const frames = shots.map((_, i) => project.file("shots", `src-${i + 1}.jpg`));
  await grabFrames(project.file("clip.mp4"), shots.map(frameTimeFor), frames);
  await project.writeJson("shots.json", {
    measured: shots.map((s, i) => ({ ...s, frame_url: project.relative(frames[i]) })),
    shots: [],
  });
  return { analysis, cuts: shots.length };
}

/* ─────────────────────────────── plan ─────────────────────────────── */

/** The plan the video is made from: plan.json (your edits) or analysis.json, plus direction.json. */
export async function loadPlan(project) {
  const original = await project.readJson("analysis.json");
  if (!original) throw new Error(`${project.name} hasn't been read yet. Run: zuverse read ${project.name}`);
  const edited = await project.readJson("plan.json");
  const analysis = edited ?? original;
  const settings = cleanSettings(await project.readJson("settings.json", {}));
  const rawDirection = await project.readJson("direction.json");
  const ownScript = String(analysis.adapted_script || analysis.condensed_script || "");
  const direction = rawDirection
    ? sanitizeDirection(rawDirection, planFrom(analysis, settings.script ?? ownScript), { noText: settings.noText })
    : null;
  return { original, analysis, settings, direction };
}

/** Brand names swapped (or removed) in the words, as the settings say, so changing the brand needs no new read. */
function branded(analysis, settings) {
  const mentions = analysis.brand_mentions ?? [];
  if (!mentions.length || (!settings.companyName && !settings.removeBranding)) return analysis;
  const fix = (s) => (s ? adaptScriptForBrand(s, mentions, settings.companyName || undefined, settings.removeBranding) : s);
  return {
    ...analysis,
    adapted_script: fix(analysis.adapted_script),
    condensed_script: fix(analysis.condensed_script),
    shots: (analysis.shots ?? []).map((s) => ({ ...s, dialogue: fix(s.dialogue) })),
  };
}

/* ─────────────────────────────── cast ─────────────────────────────── */

/** The cast face in use (its path in the project), or null when none is needed or made yet. */
export async function castFor(project, settings, analysis) {
  if (!needsCast(settings, analysis)) return null;
  const pointer = await project.readJson("cast.json");
  return pointer?.file && project.has(pointer.file) ? pointer.file : null;
}

export async function castStep(project, { again = false } = {}) {
  const { analysis, settings, direction } = await loadPlan(project);
  const directed = directedAnalysis(analysis, direction);
  if (!settings.sendImages) {
    log("images=off: no face is cast; the video model casts the new person from the description.");
    return null;
  }
  if (!needsCast(settings, directed)) {
    const why = settings.photos.length
      ? "you gave your own photos"
      : !settings.lookalike
        ? "casting is switched off (lookalike=false)"
        : "this ad has no on-camera person";
    log(`No new face needed: ${why}.`);
    return null;
  }
  const current = await castFor(project, settings, directed);
  if (current && !again) {
    log(`Using the face already cast (${current}). Run \`zuverse cast --again\` for a new one.`);
    return current;
  }
  log(`Casting a similar but different person (${MODELS.image})...`);
  const bytes = await makeImage({ prompt: castPrompt(directed, settings.notes), size: imageSize("9:16"), quality: PHOTO_QUALITY, outputFormat: PHOTO_FORMAT, label: "casting" });
  // A new file each time, so frames drawn with an earlier face are drawn again.
  await mkdir(project.file("cast"), { recursive: true });
  const file = project.relative(await saveImage(bytes, project.file("cast", `cast-${Date.now().toString(36)}`)));
  await project.writeJson("cast.json", { file, castAt: new Date().toISOString() });
  return file;
}

/* ─────────────────────────────── frames ─────────────────────────────── */

function describedShots(shotsJson) {
  const shots = shotsJson?.shots;
  if (!Array.isArray(shots) || !shots.length) return null;
  return shots.some((s) => s?.framing || s?.action || s?.subject) ? shots : null;
}

/** Every measured shot described from the clip and its frame (Gemini 3.1 Pro). */
export async function mapStep(project, { again = false } = {}) {
  const shotsJson = await project.readJson("shots.json");
  if (!shotsJson) throw new Error(`${project.name} hasn't been read yet. Run: zuverse read ${project.name}`);
  if (describedShots(shotsJson) && !again) return describedShots(shotsJson);
  const analysis = await project.readJson("analysis.json");
  const measured = cleanMeasuredShots(shotsJson.measured);
  if (!measured.length) return null;
  const frames = shotsJson.measured.slice(0, measured.length).map((s) => s.frame_url);

  const parts = [{ type: "video_url", video_url: { url: await dataUrl(await aiClip(project)) } }];
  for (let i = 0; i < frames.length; i++) {
    parts.push({ type: "text", text: `Frame ${i + 1} (from shot ${i + 1}):` });
    parts.push({ type: "image_url", image_url: { url: await dataUrl(project.resolve(frames[i])) } });
  }
  const summary = (analysis?.shots ?? []).map((s) => `${s?.time_range}: ${s?.shot_type}, ${s?.camera}; ${s?.setting}; ${s?.subject_action}`).join(" | ");
  parts.push({ type: "text", text: shotPlanPrompt({ shots: measured, transcript: String(analysis?.original_script ?? ""), summary }) });

  log(`Mapping every shot (${measured.length} cuts, ${MODELS.read})...`);
  try {
    const shots = await toolCall({
      model: MODELS.read,
      system: SHOT_PLAN_SYSTEM,
      user: parts,
      tool: { name: "submit_shot_plan", description: "Submit every shot of the ad, described.", parameters: shotPlanSchema() },
      parse: (raw) => {
        const plan = parsePlanJson(raw);
        if (!plan) return null;
        const merged = mergeShotPlan(measured, plan);
        return planIsUsable(merged) ? merged : null;
      },
      label: "mapping the shots",
      timeoutMs: 600_000,
      maxTokens: 12_000,
      temperature: 0.2,
    });
    const described = shots.map((s, i) => ({ ...s, frame_url: frames[i] ?? null }));
    await project.writeJson("shots.json", { ...shotsJson, shots: described, describedAt: new Date().toISOString() });
    return described;
  } catch (e) {
    log(`Couldn't map the shots (${e.message}); the video will follow the read's beats without shot frames.`);
    return null;
  }
}

/** "Make a new version": each shot drawn fresh (same shot, new people, a new place, no text). */
export async function framesStep(project, { castUrl } = {}) {
  const { original, analysis, settings, direction } = await loadPlan(project);
  if (settings.mode !== "new") {
    log('Shot frames are only for mode "new" (Make a new version); this project is "replace".');
    return { made: 0, failed: 0, total: 0 };
  }
  const described = await mapStep(project);
  if (!settings.sendImages) {
    log("images=off: the shots are mapped but not drawn; the video model films them from the shot list.");
    return { made: 0, failed: 0, total: 0 };
  }
  if (!described) return { made: 0, failed: 0, total: 0 };
  const directed = directedAnalysis(analysis, direction);
  const cast = castUrl === undefined ? await castFor(project, settings, directed) : castUrl;
  const castForSwap = castPhotoFor(runPhotos(settings, cast), directed) ?? null;
  const edits = planEdits(original, directed);
  const shots = described.map((s) => ({ ...s }));
  const total = shots.filter((s) => !s.graphic && s.frame_url).length;
  const failures = {};
  await mkdir(project.file("frames"), { recursive: true });
  const castData = castForSwap ? await dataUrl(project.resolve(castForSwap)) : null;

  for (let pass = 0; pass < 3; pass++) {
    const todo = framesToMake(shots, castForSwap, edits).filter((i) => (failures[i] ?? 0) < 2);
    if (!todo.length) break;
    log(`Drawing ${todo.length} shot frame${todo.length === 1 ? "" : "s"} fresh (${MODELS.image})...`);
    for (let b = 0; b < todo.length; b += 6) {
      const batch = todo.slice(b, b + 6);
      await Promise.all(
        batch.map(async (i) => {
          const s = shots[i];
          const kind = s.person && castForSwap ? "swap" : "clean";
          const change = shotChange(s, edits);
          const started = Date.now();
          try {
            const bytes = await makeImage({
              prompt: shotFramePrompt(kind, change, !!s.person),
              images: [await dataUrl(project.resolve(s.frame_url)), ...(kind === "swap" ? [castData] : [])],
              size: imageSize(settings.aspectRatio),
              quality: PHOTO_QUALITY,
              outputFormat: PHOTO_FORMAT,
              label: `shot ${i + 1}`,
            });
            const file = await saveImage(bytes, project.file("frames", `shot-${i + 1}-${kind}-${Date.now().toString(36)}`));
            shots[i] = { ...s, clean_url: project.relative(file), clean_cast: kind === "swap" ? castForSwap : null, clean_change: change, clean_style: FRESH_FRAME_STYLE };
            log(`  shot ${i + 1} done (${Math.round((Date.now() - started) / 1000)} s)`);
          } catch (e) {
            failures[i] = (failures[i] ?? 0) + 1;
            log(`  shot ${i + 1} failed: ${e.message}`);
          }
        }),
      );
      const shotsJson = await project.readJson("shots.json");
      await project.writeJson("shots.json", { ...shotsJson, shots });
    }
  }
  const left = framesToMake(shots, castForSwap, edits).length;
  return { made: total - left, failed: left, total };
}

/* ─────────────────────────────── prompt ─────────────────────────────── */

export async function promptStep(project) {
  const info = await project.readJson("info.json");
  const loaded = await loadPlan(project);
  const { original, direction } = loaded;
  const settings = { ...loaded.settings };
  const analysis = branded(loaded.analysis, settings);
  const directed = directedAnalysis(analysis, direction);
  const shotsJson = await project.readJson("shots.json");
  const planShots = settings.mode === "new" ? describedShots(shotsJson) : null;
  const castUrl = settings.sendImages ? await castFor(project, settings, directed) : null;
  const hasSourceVideo = project.has("clip.mp4");

  // A shorter video than the ad: the words are cut to fit (the original wording kept where possible).
  if (!settings.script) {
    const own = String((direction?.script_changed && direction.script) || directed.adapted_script || "");
    const budget = wordBudget(settings.durationSeconds);
    if (hasSpokenScript(own) && wordCount(own) > budget.cap) {
      log(`The script is ${wordCount(own)} words; about ${budget.high} fit in ${settings.durationSeconds} s. Tightening it...`);
      const tight = await tightenScript(own, settings.durationSeconds, budget);
      if (tight) settings.script = tight;
      else log("  Couldn't tighten it: the video may rush. Set a shorter script with `zuverse set <project> script=\"...\"`.");
    }
  }

  if (settings.mode === "replace" && !castUrl && !settings.photos.length && directed.video_type !== "showcase") {
    log("Warning: no photo of the new person. With only the original clip to go on, the video model tends to keep the original person's look. Add a photo (zuverse photo), cast one (lookalike=true), or use mode=new.");
  }
  const built = buildRunPrompt({ settings, analysis, direction, planShots, castUrl, hasSourceVideo, originalAnalysis: original });
  const plan = copierRenderPlan({ mode: settings.mode, voice: settings.voice, hasSourceVideo });
  let prompt = built.prompt;
  let referenceVideo = plan.sendVideo ? "clip.mp4" : null;
  let voice = "";
  let speakers = [];

  if (plan.newVoice) {
    const script = dialogueFromPrompt(prompt) ?? "";
    const spoken = hasSpokenScript(script);
    let silentReference = false;
    if (plan.sendVideo) {
      if (info?.hasAudio) {
        await muteVideo(project.file("clip.mp4"), project.file("clip-silent.mp4"));
        referenceVideo = "clip-silent.mp4";
      }
      silentReference = true;
    }
    // Their photo stayed home (the frames show them): the voice is read from a frame of them.
    const voicePhoto = built.voicePhoto && built.refs.includes(built.voicePhoto) ? built.voicePhoto : castPhotoFor(runPhotos(settings, castUrl), directed);
    if (spoken) {
      log("Giving the new person their own voice...");
      [voice, speakers] = await Promise.all([
        voicePhoto ? voiceFor(await dataUrl(project.resolve(voicePhoto))) : Promise.resolve(""),
        aiClip(project).then(async (clip) => speakerTurns(await dataUrl(clip), script)),
      ]);
    }
    prompt = applyVoicePlan(prompt, { mode: settings.mode, voice: settings.voice, description: voice, silentReference, turns: speakers });
    if (settings.noText) prompt = withNoTextRules(prompt, true);
  }
  prompt = withSeedanceReferenceHints(prompt, { images: built.refs.length, videos: referenceVideo ? 1 : 0 });

  const resolution = renderResolution(settings.resolution, !!referenceVideo);
  const renderPlan = {
    model: MODELS.video,
    seconds: settings.durationSeconds,
    resolution,
    aspect_ratio: aspectFor(settings.aspectRatio),
    mode: settings.mode,
    voice: settings.voice,
    referenceImages: built.refs,
    referenceVideo,
    referenceSeconds: referenceVideo ? info?.clipSeconds ?? settings.durationSeconds : 0,
    shotFrames: built.frameCount,
    newVoice: voice || null,
    speakers,
    script: dialogueFromPrompt(prompt) ?? "",
    builtAt: new Date().toISOString(),
  };
  await project.writeText("prompt.txt", `${prompt}\n`);
  await project.writeJson("render-plan.json", renderPlan);
  if (resolution !== settings.resolution) log(`Note: with the original clip as a reference, Seedance 2.5 renders at 720p at most, so this is made at ${resolution}.`);
  if (prompt.length > MAX_PROMPT_CHARS) {
    log(`Warning: the prompt is ${prompt.length} characters; Seedance reads ${MAX_PROMPT_CHARS}. Shorten prompt.txt before rendering.`);
  }
  return { prompt, renderPlan, cost: videoCost({ seconds: renderPlan.seconds, resolution, referenceSeconds: renderPlan.referenceSeconds }) };
}

/* ─────────────────────────────── render ─────────────────────────────── */

/**
 * The reference images as sent: each file as it is (generated ones keep their
 * content credentials), unless the request would pass Zurelay's 25 MB; then
 * the biggest are swapped for smaller JPEG copies until it fits.
 */
async function refImages(project, refs, otherBytes) {
  const sources = refs.map((r) => project.resolve(r));
  const urls = await Promise.all(sources.map((s) => dataUrl(s)));
  const total = () => otherBytes + urls.reduce((n, u) => n + u.length, 0);
  const order = urls.map((u, i) => i).sort((a, b) => urls[b].length - urls[a].length);
  for (const i of order) {
    if (total() <= MAX_REQUEST_BYTES || /^https:/i.test(sources[i])) continue;
    await mkdir(project.file("render"), { recursive: true });
    const out = project.file("render", `ref-${i + 1}.jpg`);
    await removeQuietly(out);
    try {
      await shrinkImage(sources[i], out);
      urls[i] = await dataUrl(out);
    } catch {
      // leave it as it is
    }
  }
  return urls;
}

export async function renderStep(project, { yes = false, waitMs = 540_000 } = {}) {
  const renderPlan = await project.readJson("render-plan.json");
  if (!renderPlan) throw new Error(`Build the prompt first: zuverse prompt ${project.name}`);
  const prompt = (await project.readText("prompt.txt")).trim();
  if (!prompt) throw new Error("prompt.txt is empty.");
  if (prompt.length > 8000) throw new Error(`prompt.txt is ${prompt.length} characters; Seedance reads 8,000 at most. Shorten it first.`);
  const cost = videoCost({ seconds: renderPlan.seconds, resolution: renderPlan.resolution, referenceSeconds: renderPlan.referenceSeconds });
  if (!yes) return { needsConfirm: true, cost, renderPlan };

  const body = {
    model: renderPlan.model,
    prompt,
    seconds: renderPlan.seconds,
    resolution: renderPlan.resolution,
    aspect_ratio: renderPlan.aspect_ratio,
    generate_audio: true,
  };
  if (renderPlan.referenceVideo) body.reference_videos = [await dataUrl(project.resolve(renderPlan.referenceVideo))];
  const images = await refImages(project, renderPlan.referenceImages, Buffer.byteLength(JSON.stringify(body)) + 4096);
  if (images.length) body.reference_images = images;
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_REQUEST_BYTES) {
    throw new Error(`The request is ${(size / 1048576).toFixed(1)} MB; Zurelay takes 25 MB. Use fewer photos or a shorter clip.`);
  }

  log(`Starting the video: ${renderPlan.seconds} s at ${renderPlan.resolution}, ${images.length} reference image${images.length === 1 ? "" : "s"}${renderPlan.referenceVideo ? " + the original clip" : ""} (about ${usd(cost.total)})...`);
  const job = await createVideo(body);
  const render = {
    videoId: job.id,
    status: job.status,
    startedAt: new Date().toISOString(),
    estimate: cost,
    seconds: renderPlan.seconds,
    resolution: renderPlan.resolution,
    mode: renderPlan.mode,
    outputs: (await project.readJson("render.json"))?.outputs ?? [],
  };
  await project.writeJson("render.json", render);
  return await waitForRender(project, { waitMs });
}

/** Follows the render until it is done (then downloads it) or `waitMs` passes. */
export async function waitForRender(project, { waitMs = 540_000 } = {}) {
  const render = await project.readJson("render.json");
  if (!render?.videoId) throw new Error(`Nothing is rendering in ${project.name}. Run: zuverse render ${project.name} --yes`);
  if (render.status === "completed" && render.file) return { status: "completed", file: render.file, render };
  const until = Date.now() + waitMs;
  let last = "";
  for (;;) {
    const video = await getVideo(render.videoId);
    const status = String(video?.status ?? "unknown");
    // The status when it changes, the progress in steps of 20%.
    const step = typeof video?.progress === "number" ? Math.floor(video.progress / 20) * 20 : null;
    const line = `  ${status}${step !== null ? ` ${step}%` : ""}`;
    if (line !== last) log(line);
    last = line;
    if (status === "completed") {
      const bytes = await downloadVideo(render.videoId);
      const file = project.file(`zuverse-${project.name}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.mp4`);
      await writeFile(file, bytes);
      const done = { ...render, status, completedAt: new Date().toISOString(), cost: video.cost ?? null, file: project.relative(file), outputs: [...(render.outputs ?? []), project.relative(file)] };
      await project.writeJson("render.json", done);
      return { status, file, render: done };
    }
    if (status === "failed") {
      const failed = { ...render, status, error: video?.error ?? null, failedAt: new Date().toISOString() };
      await project.writeJson("render.json", failed);
      return { status, error: videoFailureMessage(video?.error), render: failed };
    }
    if (Date.now() > until) {
      await project.writeJson("render.json", { ...render, status });
      return { status, pending: true, render };
    }
    await sleep(10_000);
  }
}

/* ─────────────────────────────── edit ─────────────────────────────── */

/** The video an edit works on: the one given, or the project's latest render. */
export async function editSource(project, file) {
  if (file) {
    const p = path.resolve(file);
    if (!existsSync(p)) throw new Error(`No such file: ${file}`);
    return p;
  }
  const render = await project.readJson("render.json");
  const latest = render?.file ? project.resolve(render.file) : null;
  if (!latest || !existsSync(latest)) {
    throw new Error(`${project.name} has no finished video yet. Render one first, or edit any file with: zuverse edit ${project.name} --video <file>`);
  }
  return latest;
}

/**
 * When every word is said (Gemini 3.1 Pro listens), kept in edit/words.json
 * for that video so the edit can be redone for free.
 */
export async function wordsStep(project, video, { again = false } = {}) {
  const { size } = await stat(video);
  const key = { video: project.relative(video), bytes: size };
  const cached = await project.readJson(path.join("edit", "words.json"));
  if (!again && cached?.words?.length && cached.video === key.video && cached.bytes === key.bytes) return cached.words;

  const info = await probe(video);
  if (!info.hasAudio) throw new Error("This video has no sound, so there are no pauses to cut or words to caption.");
  await mkdir(project.file("edit"), { recursive: true });
  const small = await fitVideoUnder(video, project.file("edit", "video-ai.mp4"), AI_VIDEO_MAX_BYTES);
  // The render's own script helps the words come back spelled the way they were meant.
  const render = await project.readJson("render.json");
  const isRender = render?.file && path.resolve(project.resolve(render.file)) === path.resolve(video);
  const script = isRender ? (await project.readJson("render-plan.json"))?.script : null;

  const user = [
    { type: "video_url", video_url: { url: await dataUrl(small) } },
    { type: "text", text: wordsPrompt({ duration: info.duration, script }) },
  ];
  const timeWith = (model) => {
    log(`Timing every word (${model})...`);
    return toolCall({
      model,
      system: WORDS_SYSTEM,
      user,
      tool: { name: "submit_words", description: "Submit every spoken word with its timing.", parameters: wordsSchema() },
      parse: (raw) => cleanWords(parseJsonObject(raw), info.duration),
      label: "timing the words",
      timeoutMs: 600_000,
      maxTokens: 16_000,
      temperature: 0,
    });
  };
  // Listening for words is a job the smaller Gemini does well too: it stands in when the big one is down.
  let model = MODELS.read;
  let words;
  try {
    words = await timeWith(model);
  } catch (e) {
    if (e?.status !== 503 && e?.code !== "model_unavailable") throw e;
    log(`  ${MODELS.read} is unavailable right now; using ${MODELS.text} for the word timing.`);
    model = MODELS.text;
    words = await timeWith(model);
  }
  if (small !== video) await removeQuietly(small);
  await project.writeJson(path.join("edit", "words.json"), { ...key, model, timedAt: new Date().toISOString(), words });
  return words;
}

/** The edit as it stands: edit.json (unless `auto`), the quiet in the sound, and the parts kept. */
export async function editPlan(project, video, words, { auto = false } = {}) {
  const info = await probe(video);
  let raw = null;
  if (!auto && project.has("edit.json")) {
    raw = await project.readJson("edit.json");
    if (!raw) throw new Error(`${project.file("edit.json")} isn't valid JSON. Fix it, or run with --auto.`);
  }
  const edit = cleanEdit(raw ?? {});
  const level = quietLevel(await speechLoudness(video));
  const quiet = parseSilences(await quietReport(video, level), info.duration);
  const keeps = planKeeps(words, quiet, info.duration, edit);
  return { info, edit, hasEdit: !!raw, level, quiet, keeps, zooms: zoomsFor(keeps, edit) };
}

/** Cuts the pauses, draws the captions and stickers, and saves zuverse-<project>-edit-<time>.mp4. */
export async function editStep(project, { video: file, auto = false, again = false } = {}) {
  const video = await editSource(project, file);
  const words = await wordsStep(project, video, { again });
  const plan = await editPlan(project, video, words, { auto });
  const { info, edit, keeps, zooms } = plan;
  const width = Math.round(info.width / 2) * 2;
  const height = Math.round(info.height / 2) * 2;

  await mkdir(project.file("edit"), { recursive: true });
  await project.writeText(path.join("edit", "captions.ass"), buildAss({ words, keeps, edit, width, height }));
  const output = project.file(`zuverse-${project.name}-edit-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.mp4`);
  log(`Cutting ${keeps.length - 1} pause(s), zooming and drawing the captions...`);
  await renderEdit({
    input: video,
    filter: editFilter({ keeps, zooms, width, height, focus: edit.zoomFocus, assFile: "edit/captions.ass", hasAudio: info.hasAudio, loudness: edit.loudness }),
    output,
    cwd: project.dir,
    hasAudio: info.hasAudio,
  });
  const result = {
    video: project.relative(video),
    file: project.relative(output),
    from: Math.round(info.duration * 100) / 100,
    to: keptSeconds(keeps),
    parts: keeps.length,
    words: words.length,
    popups: edit.popups.length,
    usedEditJson: plan.hasEdit,
    keeps,
    zooms,
    editedAt: new Date().toISOString(),
  };
  await project.writeJson(path.join("edit", "last.json"), result);
  return { ...result, file: output };
}

/* ─────────────────────────────── photos ─────────────────────────────── */

/** Your own photo (a person or product) added to the project, ready for the models. */
export async function addPhoto(project, file, note) {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  await mkdir(project.file("photos"), { recursive: true });
  const out = project.file("photos", `${slug(path.parse(file).name)}-${Date.now().toString(36)}.jpg`);
  try {
    await normalizePhoto(file, out);
  } catch {
    await copyFile(file, out);
  }
  const settings = await project.readJson("settings.json", {});
  const photos = Array.isArray(settings.photos) ? settings.photos : [];
  if (photos.length >= 9) throw new Error("Seedance 2.5 takes 9 reference images at most.");
  photos.push({ url: project.relative(out), ...(note ? { note } : {}) });
  await project.writeJson("settings.json", { ...settings, photos });
  return project.relative(out);
}
