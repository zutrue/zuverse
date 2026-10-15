/**
 * Finds the cuts in a video, so the remake follows the source cut for cut:
 * the model that describes the shots is told exactly where they are instead
 * of guessing (left to itself it folded a 12-shot ad into 5).
 *
 * Method: sample the video every 0.1 s at a tiny size and compare each sample
 * with the one before by colour histogram (what is in frame) and by luma
 * (where it is). A cut is a sharp histogram jump, well above the clip's usual
 * frame-to-frame change; jumps closer together than `minShot` are one cut (a
 * whip pan or a flash), so fast motion inside a shot does not split it.
 */

import { frameDiffs } from "./media.mjs";

const round1 = (n) => Math.round(n * 10) / 10;

/** Pure: the shots implied by a run of frame differences. */
export function shotsFromDiffs(diffs, duration, opts = {}) {
  const floor = opts.floor ?? 0.15;
  const k = opts.k ?? 3;
  const minShot = opts.minShot ?? 0.5;
  const maxShots = opts.maxShots ?? 16;
  const end = Math.max(0, duration);
  if (!diffs.length || end <= 0) return end > 0 ? [{ start: 0, end: round1(end) }] : [];

  const sorted = diffs.map((d) => d.hd).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = Math.max(floor, k * median);

  // Local peaks above the threshold, strongest first, then keep those at least minShot apart.
  const peaks = diffs
    .map((d, i) => ({ ...d, i }))
    .filter((d) => d.hd >= threshold && d.hd >= (diffs[d.i - 1]?.hd ?? 0) && d.hd >= (diffs[d.i + 1]?.hd ?? 0))
    .sort((a, b) => b.hd + b.ld - (a.hd + a.ld));
  const cuts = [];
  for (const p of peaks) {
    const at = p.t;
    if (at < minShot || end - at < minShot * 0.6) continue;
    if (cuts.some((c) => Math.abs(c - at) < minShot)) continue;
    cuts.push(at);
    if (cuts.length >= maxShots - 1) break;
  }
  cuts.sort((a, b) => a - b);

  const bounds = [0, ...cuts, end];
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) shots.push({ start: round1(bounds[i]), end: round1(bounds[i + 1]) });
  return shots;
}

/** Where to take a shot's frame: a little way in, clear of the cut and any transition. */
export function frameTimeFor(shot) {
  const len = shot.end - shot.start;
  return round1(shot.start + Math.min(0.4, len * 0.3));
}

/** The shots of a video file. */
export async function detectShots(file, opts = {}) {
  const { duration, diffs } = await frameDiffs(file);
  return { duration, shots: shotsFromDiffs(diffs, duration, opts) };
}
