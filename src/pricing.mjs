/**
 * What a run costs on Zurelay, in US dollars (prices as listed on
 * https://zurelay.com/models on 2026-10-15; check there for today's).
 * Failed videos are free on Zurelay.
 */

export const PRICES_AS_OF = "2026-10-15";

/** Seedance 2.5, per second of output. */
export const SEEDANCE_25_PER_SECOND = { "480p": 0.135, "720p": 0.305, "1080p": 0.75 };
/** Seedance 2.5, per second of reference video (it reads every second it is given). */
export const SEEDANCE_25_REFERENCE_PER_SECOND = { "480p": 0.081, "720p": 0.183 };
/** GPT Image 2.5 Sunburst at the size Zuverse draws (864x1536 bills as 2K). */
export const IMAGE_PRICE = 0.034;
/** Gemini 3.1 Pro watching a 30 s clip (plus the shot-by-shot read), roughly. */
export const READ_PRICE = 0.05;

/**
 * Seedance 2.5 takes a reference video at 480p and 720p only, so a "Replace
 * the person" render asked for at 1080p is made at 720p.
 */
export function renderResolution(resolution, sendsVideo) {
  if (sendsVideo && resolution === "1080p") return "720p";
  return resolution === "480p" || resolution === "1080p" ? resolution : "720p";
}

/** The video's price: output seconds, plus the reference clip's seconds when it is sent. */
export function videoCost({ seconds, resolution, referenceSeconds = 0 }) {
  const out = (SEEDANCE_25_PER_SECOND[resolution] ?? SEEDANCE_25_PER_SECOND["720p"]) * seconds;
  const ref = referenceSeconds > 0 ? (SEEDANCE_25_REFERENCE_PER_SECOND[resolution] ?? SEEDANCE_25_REFERENCE_PER_SECOND["720p"]) * referenceSeconds : 0;
  return { output: round2(out), reference: round2(ref), total: round2(out + ref) };
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const usd = (n) => `$${round2(n).toFixed(2)}`;
