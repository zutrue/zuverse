/**
 * Everything ffmpeg does: probing, the 29 s reference clip, a smaller copy for
 * the AI to read, the muted copy, frames, and the frame differences the cut
 * finder reads.
 *
 * ffmpeg/ffprobe come from (in order): ZUVERSE_FFMPEG / ZUVERSE_FFPROBE, the
 * PATH, or the ffmpeg-static / ffprobe-static packages `npm install` adds.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFile, stat, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Seedance 2.5 rejects reference videos of 30 s and over. */
export const REFERENCE_MAX_SECONDS = 29;
/**
 * The reference clip goes to Zurelay inline (a data URL) beside up to 9
 * images, in a request of 25 MB at most (base64 adds a third), so it is kept
 * under this.
 */
export const REFERENCE_MAX_BYTES = 14 * 1024 * 1024;
/** What the AI reads inline (Zurelay: 20 MB a file, 25 MB a request). */
export const AI_VIDEO_MAX_BYTES = 15 * 1024 * 1024;

let cached = null;

function works(bin, args = ["-version"]) {
  try {
    const r = spawnSync(bin, args, { stdio: "ignore", windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function fromPackage(name) {
  try {
    const mod = require(name);
    const p = typeof mod === "string" ? mod : mod?.path;
    return p && works(p) ? p : null;
  } catch {
    return null;
  }
}

/** { ffmpeg, ffprobe } paths, or null for the ones that can't be found. */
export function tools() {
  if (cached) return cached;
  const ffmpeg =
    (process.env.ZUVERSE_FFMPEG && works(process.env.ZUVERSE_FFMPEG) ? process.env.ZUVERSE_FFMPEG : null) ??
    (works("ffmpeg") ? "ffmpeg" : null) ??
    fromPackage("ffmpeg-static");
  const ffprobe =
    (process.env.ZUVERSE_FFPROBE && works(process.env.ZUVERSE_FFPROBE) ? process.env.ZUVERSE_FFPROBE : null) ??
    (works("ffprobe") ? "ffprobe" : null) ??
    fromPackage("ffprobe-static");
  cached = { ffmpeg, ffprobe };
  return cached;
}

function need(name) {
  const bin = tools()[name];
  if (!bin) {
    throw new Error(
      `${name} was not found. Run \`npm install\` in the Zuverse folder (it brings its own copy), or install ffmpeg: ` +
        "winget install Gyan.FFmpeg (Windows), brew install ffmpeg (macOS), sudo apt install ffmpeg (Linux).",
    );
  }
  return bin;
}

/** Runs a tool; resolves with its exit code, stdout (Buffer) and the end of stderr. */
export function run(bin, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
    if (input) child.stdin.end(input);
  });
}

async function ffmpeg(args) {
  const r = await run(need("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
  return r;
}

/** Length, picture size and whether there is a sound track. */
export async function probe(file) {
  const r = await run(need("ffprobe"), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]);
  if (r.code !== 0) throw new Error(`Couldn't read ${path.basename(file)}: ${r.stderr.trim().split("\n").pop() || "not a video"}`);
  const j = JSON.parse(r.stdout.toString() || "{}");
  const video = (j.streams ?? []).find((s) => s.codec_type === "video");
  const duration = Number(j.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    hasVideo: !!video,
    hasAudio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/** Scale factor that brings a frame into Seedance's reference-video window (1 when it is inside). */
const SEEDANCE_REFERENCE_K = "if(lt(iw*ih,409600),sqrt(409600/(iw*ih)),if(gt(iw*ih,921600),sqrt(921600/(iw*ih)),1))";

/**
 * Seedance reads a reference video of 409,600 to 927,408 pixels (640x640 to
 * 834x1112): smaller ones are refused as "resolution too low". The clip keeps
 * its shape and is scaled into that window (360x640 -> 480x854, 1080x1920 ->
 * 720x1280).
 */
export const SEEDANCE_REFERENCE_SCALE =
  `scale=w='ceil(iw*${SEEDANCE_REFERENCE_K}/2)*2':h='ceil(ih*${SEEDANCE_REFERENCE_K}/2)*2':flags=bicubic`;

/**
 * The first `maxSeconds` only, 720p-class H.264/AAC, faststart: the @Video1
 * reference and what everything else is read from. Re-encoding (not stream
 * copy) keeps the cut frame-accurate and turns MOV/WebM/odd sizes into
 * something both the AI and Seedance accept. A clip over REFERENCE_MAX_BYTES
 * is made again with fewer bits.
 */
export async function transcodeReference(input, output, maxSeconds = REFERENCE_MAX_SECONDS) {
  const attempts = [
    ["-vf", `${SEEDANCE_REFERENCE_SCALE},fps=30`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"],
    ["-vf", `${SEEDANCE_REFERENCE_SCALE},fps=30`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "29", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k"],
    ["-vf", `${SEEDANCE_REFERENCE_SCALE},fps=24`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "33", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k"],
    // For inputs the audio encoder chokes on.
    ["-vf", `${SEEDANCE_REFERENCE_SCALE},fps=24`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-an"],
  ];
  let lastErr = "";
  for (const args of attempts) {
    try {
      await ffmpeg(["-i", input, "-t", String(maxSeconds), ...args, "-movflags", "+faststart", output]);
      const { size } = await stat(output);
      if (size <= REFERENCE_MAX_BYTES) return;
      lastErr = `still ${(size / 1048576).toFixed(1)} MB`;
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`Couldn't prepare this video. ${lastErr}`.trim());
}

const FIT_TRIES = [
  { side: 1280, fps: 24, audioKbps: 64, share: 1 },
  { side: 854, fps: 20, audioKbps: 48, share: 0.85 },
  { side: 640, fps: 15, audioKbps: 32, share: 0.7 },
  { side: 640, fps: 15, audioKbps: 0, share: 0.7 },
];

/**
 * A copy of a clip that fits in `maxBytes` for the AI to read inline (it
 * needs legible frames and the sound, not full quality). The clip itself when
 * it already fits.
 */
export async function fitVideoUnder(input, output, maxBytes = AI_VIDEO_MAX_BYTES) {
  if ((await stat(input)).size <= maxBytes) return input;
  const seconds = (await probe(input)).duration ?? 60;
  for (const t of FIT_TRIES) {
    const videoKbps = Math.floor((maxBytes * 8 * 0.9 * t.share) / seconds / 1000) - t.audioKbps;
    if (videoKbps < 80) continue;
    const audio = t.audioKbps ? ["-c:a", "aac", "-b:a", `${t.audioKbps}k`] : ["-an"];
    try {
      await ffmpeg([
        "-i", input,
        "-vf", `scale='if(gt(iw,ih),min(${t.side},iw),-2)':'if(gt(iw,ih),-2,min(${t.side},ih))',fps=${t.fps}`,
        "-c:v", "libx264", "-preset", "veryfast",
        "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`,
        "-pix_fmt", "yuv420p", ...audio, "-movflags", "+faststart", output,
      ]);
      if ((await stat(output)).size <= maxBytes) return output;
    } catch {
      // the next, smaller try
    }
  }
  throw new Error("This video is too large for the AI to read. Try a shorter clip.");
}

/** The clip without its sound (Seedance copies a reference video's soundtrack, voice included). */
export async function muteVideo(input, output) {
  await ffmpeg(["-i", input, "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", output]);
}

/** JPEG frames at the given times, at most `maxWidth` wide. */
export async function grabFrames(input, times, outputs, maxWidth = 720) {
  for (let i = 0; i < times.length; i++) {
    await ffmpeg([
      "-ss", times[i].toFixed(2), "-i", input, "-frames:v", "1",
      "-vf", `scale='min(${maxWidth},iw)':-2`, "-q:v", "3", outputs[i],
    ]);
  }
}

/**
 * Frame differences every `step` seconds, the way the Zuops page measures
 * them: each sample shrunk to 36 px wide and compared with the one before by
 * colour histogram (what is in frame, `hd`) and by luma (where it is, `ld`).
 */
export async function frameDiffs(input, step = 0.1) {
  const info = await probe(input);
  if (!info.duration || !info.width || !info.height) throw new Error("Couldn't read the video's length or size.");
  const W = 36;
  const H = Math.max(16, Math.round((W * info.height) / info.width / 2) * 2);
  const r = await run(need("ffmpeg"), [
    "-hide_banner", "-loglevel", "error", "-i", input,
    "-vf", `fps=${Math.round(1 / step)},scale=${W}:${H}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg failed while scanning: ${r.stderr.trim().split("\n").pop()}`);
  const frameBytes = W * H * 3;
  const frames = Math.floor(r.stdout.length / frameBytes);
  const diffs = [];
  let prevHist = null;
  let prevLuma = null;
  for (let f = 0; f < frames; f++) {
    const px = r.stdout.subarray(f * frameBytes, (f + 1) * frameBytes);
    const hist = new Float32Array(64);
    const luma = new Float32Array(W * H);
    for (let i = 0, p = 0; i < px.length; i += 3, p++) {
      hist[(px[i] >> 6) * 16 + (px[i + 1] >> 6) * 4 + (px[i + 2] >> 6)]++;
      luma[p] = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
    }
    if (prevHist && prevLuma) {
      let hd = 0;
      for (let b = 0; b < 64; b++) hd += Math.abs(hist[b] - prevHist[b]);
      let ld = 0;
      for (let p = 0; p < luma.length; p++) ld += Math.abs(luma[p] - prevLuma[p]);
      diffs.push({ t: Math.round(f * step * 10) / 10, hd: hd / (2 * W * H), ld: ld / (luma.length * 255) });
    }
    prevHist = hist;
    prevLuma = luma;
  }
  return { duration: info.duration, diffs };
}

/**
 * A photo as a JPEG the video and image models take: 300 to 6000 px a side
 * (the long side is kept at 2048 or less) and no wider or taller than 5:2.
 */
export async function normalizePhoto(input, output) {
  await ffmpeg([
    "-i", input, "-frames:v", "1",
    "-vf",
    "scale='if(gt(iw,ih),min(2048,max(iw,512*iw/ih)),-2)':'if(gt(iw,ih),-2,min(2048,max(ih,512*ih/iw)))':flags=bicubic," +
      "crop='min(iw,ih*2.5)':'min(ih,iw*2.5)'",
    "-q:v", "2", output,
  ]);
}

/** "png", "jpg" or "webp" from an image's first bytes ("jpg" when unsure). */
export function imageExtension(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return "jpg";
}

/**
 * An image the API sent back, saved byte for byte as `<base>.<its own
 * extension>` (it may be PNG whatever was asked for). Never re-encoded: that
 * would drop its content credentials. Returns the path written.
 */
export async function saveImage(bytes, base) {
  const { writeFile } = await import("node:fs/promises");
  const file = `${base}.${imageExtension(bytes)}`;
  await writeFile(file, bytes);
  return file;
}

/** A smaller JPEG copy (long side at most 1280 px) of an image, for a request that would be too big. */
export async function shrinkImage(input, output) {
  await ffmpeg(["-i", input, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'", "-q:v", "3", output]);
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime" };

/** A local file as a data URL (links are passed through). */
export async function dataUrl(fileOrUrl) {
  if (/^(https:|data:)/i.test(fileOrUrl)) return fileOrUrl;
  const mime = MIME[path.extname(fileOrUrl).toLowerCase()] ?? "application/octet-stream";
  const bytes = await readFile(fileOrUrl);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export async function removeQuietly(file) {
  await rm(file, { force: true }).catch(() => {});
}
