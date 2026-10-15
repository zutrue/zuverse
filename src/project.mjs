/**
 * One folder per ad, holding everything a step makes, so any step can be run
 * again (or edited by hand) without redoing the others:
 *
 *   source.*            the ad as downloaded
 *   clip.mp4            its first 29 s, sized for Seedance (the @Video1 reference)
 *   clip-ai.mp4         a smaller copy for the AI to watch (when clip.mp4 is too big)
 *   clip-silent.mp4     clip.mp4 without sound ("Replace the person" with a new voice)
 *   info.json           where it came from, lengths, picture size
 *   settings.json       the choices: mode, voice, length, resolution, photos, brand...
 *   analysis.json       the ad as read (never edited)
 *   plan.json           the plan as edited (optional; a copy of analysis.json to change)
 *   direction.json      "Anything else to change?" worked into the plan (optional)
 *   shots.json          the measured cuts, each shot described, and its frames
 *   shots/              one frame from each shot of the original
 *   frames/             each shot drawn fresh ("Make a new version")
 *   photos/             your own photos, ready for the models
 *   cast/, cast.json    the new person (when you gave no photo) and which one is in use
 *   prompt.txt          the video prompt (edit it freely before rendering)
 *   render-plan.json    what goes with the prompt: reference images, reference video
 *   render.json         the render: Zurelay video id, status, cost
 *   zuverse-*.mp4       the finished videos
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function projectsRoot(dir) {
  return path.resolve(dir || process.env.ZUVERSE_PROJECTS || "zuverse-projects");
}

/** A folder name from a title or link. */
export function slug(text) {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "ad";
}

export class Project {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.name = path.basename(this.dir);
  }

  file(...parts) {
    return path.join(this.dir, ...parts);
  }

  has(...parts) {
    return existsSync(this.file(...parts));
  }

  async readJson(name, fallback = null) {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8"));
    } catch {
      return fallback;
    }
  }

  async writeJson(name, value) {
    await mkdir(path.dirname(this.file(name)), { recursive: true });
    await writeFile(this.file(name), `${JSON.stringify(value, null, 2)}\n`);
  }

  async readText(name, fallback = "") {
    try {
      return await readFile(this.file(name), "utf8");
    } catch {
      return fallback;
    }
  }

  async writeText(name, text) {
    await writeFile(this.file(name), text);
  }

  /** The source as downloaded (any extension). */
  sourceFile() {
    const hit = readdirSync(this.dir).find((f) => /^source\./.test(f));
    return hit ? this.file(hit) : null;
  }

  /** Paths in project files are relative to the project; links and absolute paths stay. */
  resolve(p) {
    if (!p || /^(https?:|data:)/i.test(p) || path.isAbsolute(p)) return p;
    return this.file(p);
  }

  relative(p) {
    if (!p || /^(https?:|data:)/i.test(p)) return p;
    const rel = path.relative(this.dir, p);
    return rel.startsWith("..") ? p : rel.split(path.sep).join("/");
  }
}

/** A new, unused project folder. */
export async function createProject(root, name) {
  await mkdir(root, { recursive: true });
  let dir = path.join(root, slug(name));
  for (let i = 2; existsSync(dir); i++) dir = path.join(root, `${slug(name)}-${i}`);
  await mkdir(dir, { recursive: true });
  return new Project(dir);
}

/** A project by folder path or by name under the projects folder. */
export function openProject(root, nameOrPath) {
  if (!nameOrPath) {
    // The most recent one.
    if (!existsSync(root)) throw new Error("No projects yet. Start with: zuverse fetch <link or file>");
    const all = readdirSync(root)
      .map((n) => path.join(root, n))
      .filter((d) => statSync(d).isDirectory() && existsSync(path.join(d, "info.json")))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (!all.length) throw new Error("No projects yet. Start with: zuverse fetch <link or file>");
    return new Project(all[0]);
  }
  const direct = path.resolve(nameOrPath);
  if (existsSync(path.join(direct, "info.json"))) return new Project(direct);
  const named = path.join(root, nameOrPath);
  if (existsSync(path.join(named, "info.json"))) return new Project(named);
  throw new Error(`No project "${nameOrPath}" in ${root}. Run \`zuverse list\` to see them.`);
}

export function listProjects(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => path.join(root, n))
    .filter((d) => statSync(d).isDirectory() && existsSync(path.join(d, "info.json")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .map((d) => new Project(d));
}
