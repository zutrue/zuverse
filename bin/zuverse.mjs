#!/usr/bin/env node
/**
 * Zuverse: reverse-engineer any video ad, then remake it as your own.
 * Run `zuverse help` for the commands.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** KEY=value lines from .env files (the working folder's, then Zuverse's own); real env vars win. */
function loadEnv() {
  for (const file of [path.join(process.cwd(), ".env"), path.join(ROOT, ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
loadEnv();

const { cleanSettings, directedAnalysis, needsCast } = await import("../src/run.mjs");
const { listProjects, openProject, projectsRoot } = await import("../src/project.mjs");
const pipeline = await import("../src/pipeline.mjs");
const { directionRules, planFrom } = await import("../src/direction.mjs");
const { IMAGE_PRICE, PRICES_AS_OF, READ_PRICE, renderResolution, usd, videoCost } = await import("../src/pricing.mjs");
const { tools } = await import("../src/media.mjs");
const { api, BILLING_URL, SIGNUP_URL } = await import("../src/zurelay.mjs");

const BOOLEAN_FLAGS = new Set(["yes", "y", "again", "remap", "help", "h", "detach"]);

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const multi = { photo: [], note: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      const [k, inline] = a.replace(/^--?/, "").split(/=(.*)/s);
      const key = k.toLowerCase();
      if (BOOLEAN_FLAGS.has(key) && inline === undefined) {
        flags[key] = true;
        continue;
      }
      const value = inline !== undefined ? inline : argv[++i];
      if (key in multi) multi[key].push(value);
      else flags[key] = value;
    } else positionals.push(a);
  }
  return { positionals, flags, multi };
}

const out = (s = "") => process.stdout.write(`${s}\n`);

/** "key=value" pairs -> settings changes. */
function settingsPatch(pairs) {
  const patch = {};
  const yes = (v) => /^(1|true|yes|on)$/i.test(v);
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`Expected key=value, got "${pair}".`);
    const key = pair.slice(0, at).trim().toLowerCase().replace(/[-_]/g, "");
    const value = pair.slice(at + 1).trim();
    switch (key) {
      case "mode": patch.mode = value; break;
      case "voice": patch.voice = value; break;
      case "duration": case "durationseconds": case "seconds": patch.durationSeconds = Number(value); break;
      case "resolution": patch.resolution = value; break;
      case "aspect": case "aspectratio": case "ratio":
        patch.aspectRatio = value === "9:16" ? "portrait" : value === "16:9" ? "landscape" : value === "1:1" ? "square" : value;
        break;
      case "company": case "companyname": case "brand": patch.companyName = value; break;
      case "removebranding": patch.removeBranding = yes(value); break;
      case "text": patch.noText = !yes(value); break;
      case "notext": patch.noText = yes(value); break;
      case "music": patch.noMusic = !yes(value); break;
      case "nomusic": patch.noMusic = yes(value); break;
      case "lookalike": case "castlookalike": patch.lookalike = yes(value); break;
      case "keeponscreentext": patch.keepOnScreenText = yes(value); break;
      case "images": patch.sendImages = yes(value); break;
      case "notes": case "direction": patch.notes = value; break;
      case "script": patch.script = value || null; break;
      case "photos": if (!value || value === "none") patch.photos = []; else throw new Error("Add photos with: zuverse photo <project> <file> --note \"who it is\""); break;
      default: throw new Error(`Unknown setting "${pair.slice(0, at)}". See \`zuverse help\`.`);
    }
  }
  return patch;
}

async function applySettings(project, patch) {
  const current = await project.readJson("settings.json", {});
  const next = cleanSettings({ ...current, ...patch });
  await project.writeJson("settings.json", next);
  return next;
}

/** Settings flags shared by `go` and `fetch`. */
function flagSettings(flags) {
  const pairs = [];
  const map = { mode: "mode", voice: "voice", duration: "duration", resolution: "resolution", aspect: "aspect", company: "company", notes: "notes", script: "script", text: "text", music: "music", lookalike: "lookalike" };
  for (const [flag, key] of Object.entries(map)) if (flags[flag] !== undefined) pairs.push(`${key}=${flags[flag]}`);
  if (flags["remove-branding"] !== undefined) pairs.push(`removeBranding=${flags["remove-branding"]}`);
  return pairs.length ? settingsPatch(pairs) : {};
}

function wrap(text, width = 100, indent = "    ") {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

async function printPlan(project) {
  const info = await project.readJson("info.json");
  const { analysis, settings, direction, original } = await pipeline.loadPlan(project);
  const a = directedAnalysis(analysis, direction);
  const shotsJson = await project.readJson("shots.json");
  out(`\n${project.name}  (${info.clipSeconds}s${info.trimmed ? `, trimmed from ${info.sourceSeconds}s` : ""}, ${info.width}x${info.height}, from ${info.via})`);
  out(`  Type: ${a.video_type}   Industry: ${a.industry}`);
  out(`  Selling: ${a.product_or_service}`);
  out(`  Hook: ${a.hook}`);
  out(`  Person: ${a.subject_reference?.demographics}`);
  out(`  Wearing: ${a.subject_reference?.attire}`);
  out(`  Place: ${[a.environment?.location, a.environment?.details].filter(Boolean).join(". ")}`);
  out(`  Light: ${a.environment?.weather_lighting}`);
  out(`  Look: ${a.visual_style}`);
  out(`  Voice: ${a.audio_guidelines?.voice_style}   Sound: ${a.audio_guidelines?.background_audio}`);
  if (a.brand_mentions?.length) out(`  Brands mentioned: ${a.brand_mentions.join(", ")}`);
  if (a.on_screen_text?.length) out(`  On-screen text (left out unless text=on): ${a.on_screen_text.join(" | ")}`);
  out(`\n  Transcript:\n${wrap(original.original_script || "(nothing is said)")}`);
  out(`\n  Script the remake speaks${settings.script ? " (your own)" : direction?.script_changed ? " (from direction.json)" : ""}:\n${wrap(settings.script || (direction?.script_changed ? direction.script : a.adapted_script) || "(none)")}`);
  out("\n  Beats:");
  for (const s of a.shots ?? []) out(`    ${String(s.time_range).padEnd(8)} ${s.shot_type}, ${s.camera}. ${s.subject_action}${s.dialogue ? ` Says: "${s.dialogue}"` : ""}`);
  const described = (shotsJson?.shots ?? []).length;
  out(`\n  Measured cuts: ${(shotsJson?.measured ?? []).length} shots${described ? ` (described: ${described})` : ""}`);
  if (direction) {
    out("\n  Your direction (direction.json):");
    for (const s of direction.summary) out(`    - ${s}`);
    for (const s of direction.cannot) out(`    ! ${s}`);
  }
  out(`\n  Settings: mode=${settings.mode} voice=${settings.voice} duration=${settings.durationSeconds}s resolution=${settings.resolution} aspect=${settings.aspectRatio} text=${settings.noText ? "off" : "on"} music=${settings.noMusic ? "off" : "on"}${settings.companyName ? ` company="${settings.companyName}"` : ""}${settings.removeBranding ? " removeBranding" : ""} photos=${settings.photos.length} lookalike=${settings.lookalike} images=${settings.sendImages ? "on" : "off"}`);
  out(`  Files: ${project.dir}`);
}

async function printCost(project) {
  const info = await project.readJson("info.json");
  const settings = cleanSettings(await project.readJson("settings.json", {}));
  const analysis = await project.readJson("analysis.json");
  const shotsJson = await project.readJson("shots.json");
  const frames = settings.mode === "new" ? Math.min(16, (shotsJson?.measured ?? []).length || 8) : 0;
  const cast = analysis && needsCast(settings, analysis) ? 1 : 0;
  const sends = settings.mode === "replace";
  const res = renderResolution(settings.resolution, sends);
  const video = videoCost({ seconds: settings.durationSeconds, resolution: res, referenceSeconds: sends ? info.clipSeconds ?? settings.durationSeconds : 0 });
  const images = (frames + cast) * IMAGE_PRICE;
  out(`\nEstimated Zurelay cost for ${project.name} (prices as of ${PRICES_AS_OF}):`);
  out(`  Video: Seedance 2.5, ${settings.durationSeconds}s at ${res}: ${usd(video.output)}${video.reference ? ` + ${usd(video.reference)} for the ${info.clipSeconds}s reference clip` : ""}`);
  if (frames + cast) out(`  Images: ${cast ? "1 cast face" : ""}${cast && frames ? " + " : ""}${frames ? `up to ${frames} shot frames` : ""} on GPT Image 2.5: about ${usd(images)}`);
  out(`  Reading the ad: about ${usd(READ_PRICE)}`);
  out(`  Total: about ${usd(video.total + images + READ_PRICE)}   (failed videos are free; live prices: https://zurelay.com/models)`);
  const draft = videoCost({ seconds: settings.durationSeconds, resolution: "480p", referenceSeconds: sends ? info.clipSeconds ?? settings.durationSeconds : 0 });
  if (res !== "480p") out(`  Tip: a 480p draft of the same video costs ${usd(draft.total)}.`);
}

async function doctor() {
  const [major] = process.versions.node.split(".").map(Number);
  out(`Node ${process.versions.node} ${major >= 18 ? "ok" : "- Zuverse needs Node 18 or newer"}`);
  const t = tools();
  out(`ffmpeg  ${t.ffmpeg ? `ok (${t.ffmpeg})` : "MISSING - run `npm install` here, or install ffmpeg"}`);
  out(`ffprobe ${t.ffprobe ? `ok (${t.ffprobe})` : "MISSING - run `npm install` here, or install ffmpeg"}`);
  const { spawnSync } = await import("node:child_process");
  const yt = spawnSync("yt-dlp", ["--version"], { encoding: "utf8", windowsHide: true });
  out(`yt-dlp  ${yt.status === 0 ? `ok (${String(yt.stdout).trim()})` : "not installed (optional: Facebook Ad Library links and a fallback for TikTok/Instagram)"}`);
  const key = String(process.env.ZURELAY_API_KEY ?? "").trim();
  if (!key) {
    out(`Zurelay key MISSING - make one at ${SIGNUP_URL}, then put ZURELAY_API_KEY=zr_live_... in a .env file here`);
    return;
  }
  try {
    await api("GET", "/videos?limit=1", { timeoutMs: 20_000, retries: 1, label: "key check" });
    out(`Zurelay key ok (…${key.slice(-4)})`);
  } catch (e) {
    out(`Zurelay key problem: ${e.message}`);
  }
}

function report(result, project) {
  if (result.needsConfirm) {
    const c = result.cost;
    out(`\nReady to render ${project.name}: ${result.renderPlan.seconds}s at ${result.renderPlan.resolution}, ${result.renderPlan.referenceImages.length} reference image(s)${result.renderPlan.referenceVideo ? " + the original clip" : ""}.`);
    out(`This costs about ${usd(c.total)} on Zurelay${c.reference ? ` (${usd(c.output)} video + ${usd(c.reference)} for the reference clip)` : ""}. Failed videos are free.`);
    out(`Run again with --yes to start it:  zuverse render ${project.name} --yes`);
    return;
  }
  if (result.status === "completed") out(`\nDone: ${result.file}`);
  else if (result.status === "failed") {
    out(`\nThe video failed: ${result.error}`);
    process.exitCode = 1;
  } else out(`\nStill rendering (Zurelay video ${result.render.videoId}). Check again with:  zuverse status ${project.name}`);
}

const HELP = `Zuverse - reverse-engineer any video ad, then remake it as your own.

  zuverse doctor                          check Node, ffmpeg, yt-dlp and your Zurelay key
  zuverse fetch <link|file> [--name n]    get the ad (TikTok, Instagram, Facebook Ad Library, video link or file)
        [--html saved.html --ad <id>]       ...or from a saved Facebook Ad Library page
  zuverse read [project]                  read it shot by shot (Gemini 3.1 Pro) and measure the cuts
  zuverse plan [project]                  show the plan: script, person, place, beats, settings
  zuverse direction-rules [project]       how to write direction.json (your changes, worked into the plan)
  zuverse set [project] key=value ...     change settings (see below)
  zuverse photo [project] <file> --note "who/what it is"   use your own person or product photo
  zuverse cast [project] [--again]        cast a similar but different person (GPT Image 2.5)
  zuverse frames [project] [--remap]      "new" mode: map every shot and draw it fresh
  zuverse prompt [project]                build the Seedance prompt (prompt.txt) and its references
  zuverse cost [project]                  what it will cost on Zurelay
  zuverse render [project] --yes          make the video (Seedance 2.5) and download it
  zuverse status [project]                keep waiting for a render that is still going
  zuverse make [project] --yes            cast + frames + prompt + render in one go
  zuverse go <link|file> [settings] --yes fetch + read + make in one go
  zuverse list                            your projects

Settings (zuverse set, or as --flags on go):
  mode=replace|new        replace: keep the original footage's motion, swap the person (default)
                          new: remake it shot for shot with new people in a new place
  voice=new|original      new: the new person speaks in their own voice (default)
  duration=4..30          seconds (default: the ad's length, up to 29)
  resolution=480p|720p|1080p   (replace mode renders at 720p at most)
  aspect=9:16|16:9|1:1
  company="Your Brand"    every brand mention becomes yours;  removeBranding=true strips them
  text=on|off             captions and on-screen text (default off: AI video misspells words)
  music=on|off            background music (default on)
  lookalike=true|false    cast a similar but different person when you give no photo (default true)
  images=on|off           off: send no generated face or shot frames; the video model casts from the words
                          (use it when the video model keeps declining the faces)
  notes="..."             your direction, sent with the prompt
  script="..."            your own words for the person to say

Project defaults to the most recent one. Projects live in ./zuverse-projects (or --dir / ZUVERSE_PROJECTS).
API key: ZURELAY_API_KEY in a .env file. Get one at ${SIGNUP_URL}`;

async function main() {
  const { positionals, flags, multi } = parseArgs(process.argv.slice(2));
  const [command = "help", ...rest] = positionals;
  const root = projectsRoot(flags.dir);
  const waitMs = Math.max(0, Number(flags.wait ?? 540)) * 1000;

  // An optional project name comes first, unless it looks like a setting or a file.
  const projectArg = (args) => (args[0] && !args[0].includes("=") ? args[0] : undefined);
  const open = (args) => openProject(root, projectArg(args));

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return;
    case "doctor":
      await doctor();
      return;
    case "list": {
      const all = listProjects(root);
      if (!all.length) out("No projects yet. Start with: zuverse fetch <link or file>");
      for (const p of all) {
        const r = await p.readJson("render.json");
        const s = await p.readJson("settings.json", {});
        out(`${p.name.padEnd(40)} ${String(s.mode ?? "").padEnd(8)} ${p.has("analysis.json") ? "read" : "fetched"}${r?.outputs?.length ? `, ${r.outputs.length} video(s)` : r?.status ? `, render ${r.status}` : ""}`);
      }
      return;
    }
    case "fetch": {
      if (!rest[0] && !flags.html) throw new Error("Give a link or a file: zuverse fetch <link|file>");
      const { project, info } = await pipeline.fetchStep(root, rest[0], { name: flags.name, html: flags.html, adId: flags.ad });
      const patch = flagSettings(flags);
      if (Object.keys(patch).length) await applySettings(project, patch);
      out(`\nGot it: ${project.name} (${info.clipSeconds}s${info.trimmed ? `, trimmed from ${info.sourceSeconds}s` : ""}, ${info.width}x${info.height}, via ${info.via})`);
      out(`Next: zuverse read ${project.name}`);
      return;
    }
    case "read": {
      const project = open(rest);
      const { cuts } = await pipeline.readStep(project);
      await printPlan(project);
      out(`\n${cuts} cuts measured. Next: change anything (zuverse set / plan.json / direction.json), then: zuverse make ${project.name} --yes`);
      return;
    }
    case "plan": {
      await printPlan(open(rest));
      return;
    }
    case "direction-rules": {
      const project = open(rest);
      const { analysis, settings } = await pipeline.loadPlan(project);
      out(directionRules({ mode: settings.mode, durationSeconds: settings.durationSeconds, noText: settings.noText }));
      out("\nCURRENT PLAN (rewrite this as direction.json in the project folder):");
      out(JSON.stringify(planFrom(analysis, settings.script ?? analysis.adapted_script ?? ""), null, 2));
      return;
    }
    case "set": {
      const project = open(rest);
      const pairs = rest.slice(projectArg(rest) ? 1 : 0);
      if (!pairs.length) throw new Error("Nothing to set. Example: zuverse set mode=new duration=15");
      const s = await applySettings(project, settingsPatch(pairs));
      out(`Saved: mode=${s.mode} voice=${s.voice} duration=${s.durationSeconds}s resolution=${s.resolution} aspect=${s.aspectRatio} text=${s.noText ? "off" : "on"} music=${s.noMusic ? "off" : "on"}${s.companyName ? ` company="${s.companyName}"` : ""}`);
      return;
    }
    case "photo": {
      const hasProject = rest.length > 1;
      const project = openProject(root, hasProject ? rest[0] : undefined);
      const file = hasProject ? rest[1] : rest[0];
      if (!file) throw new Error('Which photo? zuverse photo <project> <file> --note "who or what it is"');
      const saved = await pipeline.addPhoto(project, file, multi.note[0] ?? flags.note);
      out(`Added ${saved}. It replaces the matching person or product (no lookalike is cast while you have photos).`);
      return;
    }
    case "cast": {
      const project = open(rest);
      const file = await pipeline.castStep(project, { again: !!flags.again });
      if (file) out(`Cast: ${project.file(file)}`);
      return;
    }
    case "frames": {
      const project = open(rest);
      if (flags.remap) await pipeline.mapStep(project, { again: true });
      await pipeline.castStep(project);
      const r = await pipeline.framesStep(project);
      out(`Shot frames: ${r.made} of ${r.total} drawn${r.failed ? `, ${r.failed} failed (the video goes without them)` : ""}. They're in ${project.file("frames")}`);
      return;
    }
    case "prompt": {
      const project = open(rest);
      const r = await pipeline.promptStep(project);
      out(`\n${r.prompt}\n`);
      out(`Saved prompt.txt (${r.prompt.length} characters) with ${r.renderPlan.referenceImages.length} reference image(s)${r.renderPlan.referenceVideo ? " + the original clip" : ""}.`);
      out(`Render cost: about ${usd(r.cost.total)}. Next: zuverse render ${project.name} --yes`);
      return;
    }
    case "cost": {
      await printCost(open(rest));
      return;
    }
    case "render": {
      const project = open(rest);
      report(await pipeline.renderStep(project, { yes: !!(flags.yes || flags.y), waitMs: flags.detach ? 0 : waitMs }), project);
      return;
    }
    case "status": {
      const project = open(rest);
      report(await pipeline.waitForRender(project, { waitMs }), project);
      return;
    }
    case "make":
    case "go": {
      let project;
      if (command === "go") {
        if (!rest[0]) throw new Error("Give a link or a file: zuverse go <link|file> [settings] --yes");
        project = (await pipeline.fetchStep(root, rest[0], { name: flags.name })).project;
        out(`Got it: ${project.name}`);
        const patch = flagSettings(flags);
        if (Object.keys(patch).length) await applySettings(project, patch);
        for (let i = 0; i < multi.photo.length; i++) await pipeline.addPhoto(project, multi.photo[i], multi.note[i]);
        await pipeline.readStep(project);
        await printPlan(project);
      } else {
        project = open(rest);
        if (!project.has("analysis.json")) await pipeline.readStep(project);
      }
      const settings = cleanSettings(await project.readJson("settings.json", {}));
      await pipeline.castStep(project);
      if (settings.mode === "new") {
        const r = await pipeline.framesStep(project);
        out(`Shot frames: ${r.made} of ${r.total} drawn.`);
      }
      const p = await pipeline.promptStep(project);
      out(`Prompt saved (${p.prompt.length} characters).`);
      report(await pipeline.renderStep(project, { yes: !!(flags.yes || flags.y), waitMs: flags.detach ? 0 : waitMs }), project);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Run \`zuverse help\`.`);
  }
}

main().catch((e) => {
  process.stderr.write(`\nError: ${e?.message ?? e}\n`);
  if (/balance/i.test(String(e?.message))) process.stderr.write(`Top up at ${BILLING_URL}\n`);
  process.exitCode = 1;
});
