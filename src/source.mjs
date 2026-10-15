/**
 * Getting the ad: a TikTok, Instagram or Facebook Ad Library link, a direct
 * video link, or a file on disk -> source.mp4 in the project folder.
 *
 * TikTok and Instagram are read from their public pages (as a browser would
 * see them). Facebook only shows Ad Library pages to a real browser, so those
 * go through yt-dlp when it is installed, or a page you saved (--html), or a
 * video address your browser shows. yt-dlp (https://github.com/yt-dlp/yt-dlp)
 * is also the fallback for TikTok and Instagram.
 */

import { spawnSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  adLibraryVideoFromHtml,
  instagramVideoFromHtml,
  looksLikeVideo,
  parseSourceLink,
  tiktokVideoFromHtml,
  tiktokVideoFromTikwm,
} from "./social.mjs";

const MAX_BYTES = 600 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const browserHeaders = (extra = {}) => ({
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  ...extra,
});

/** Cookies a page sets, sent back on the next request (TikTok's video links need them). */
class CookieJar {
  map = new Map();
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function fetchText(url, init = {}, timeoutMs = 25_000) {
  try {
    const res = await fetch(url, { redirect: "follow", ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { res, text: await res.text() };
  } catch {
    return null;
  }
}

/** Downloads a video link to `out`; false when what came back isn't a video. */
async function downloadVideo(url, out, headers = { "User-Agent": UA }) {
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(300_000) });
    if (!res.ok) return false;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES || bytes.length < 10_000) return false;
    if (!looksLikeVideo(res.headers.get("content-type"), bytes.subarray(0, 12))) return false;
    await writeFile(out, bytes);
    return true;
  } catch {
    return false;
  }
}

function ytDlp(url, out) {
  const bin = ["yt-dlp", "yt-dlp.exe"].find((b) => {
    try {
      return spawnSync(b, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
    } catch {
      return false;
    }
  });
  if (!bin) return { ok: false, missing: true };
  const r = spawnSync(bin, ["-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4", "--no-playlist", "-o", out, url], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    timeout: 300_000,
  });
  return { ok: r.status === 0 && existsSync(out), missing: false, error: String(r.stderr ?? "").trim().split("\n").pop() };
}

async function tiktok(link, out) {
  // 1. The page's own data, with the cookies it sets (the play address needs them).
  const jar = new CookieJar();
  const page = await fetchText(link.url, { headers: browserHeaders() });
  if (page) {
    jar.absorb(page.res);
    const found = tiktokVideoFromHtml(page.text);
    const headers = { "User-Agent": UA, Referer: "https://www.tiktok.com/", ...(jar.header() ? { Cookie: jar.header() } : {}) };
    if (found && (await downloadVideo(found.videoUrl, out, headers))) return { via: "tiktok page", title: found.title };
  }
  // 2. tikwm.com's public API (no watermark).
  const api = await fetchText(`https://www.tikwm.com/api/?url=${encodeURIComponent(link.url)}&hd=1`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (api) {
    try {
      const found = tiktokVideoFromTikwm(JSON.parse(api.text));
      if (found && (await downloadVideo(found.videoUrl, out))) return { via: "tikwm", title: found.title };
    } catch {
      /* not JSON */
    }
  }
  return null;
}

async function instagram(link, out) {
  // The public embed page, asked for as a phone, carries the video address.
  const embedUrl = `https://www.instagram.com/p/${link.id}/embed/captioned/`;
  for (const ua of [IPHONE_UA, UA]) {
    const embed = await fetchText(embedUrl, { headers: browserHeaders({ "User-Agent": ua }) });
    const found = embed ? instagramVideoFromHtml(embed.text) : null;
    if (found && (await downloadVideo(found.videoUrl, out))) return { via: "instagram embed" };
  }
  const page = await fetchText(link.url, { headers: browserHeaders() });
  const found = page ? instagramVideoFromHtml(page.text) : null;
  if (found && (await downloadVideo(found.videoUrl, out))) return { via: "instagram page" };
  return null;
}

export const FACEBOOK_HELP = `Facebook only shows Ad Library pages to a real browser. Any of these works:
  1. Install yt-dlp (https://github.com/yt-dlp/yt-dlp) and run the same command again.
  2. Open the ad in your browser, right-click the video > "Copy video address" (or ask Claude to read it with its browser tool), then: zuverse fetch "<that address>"
  3. Save the Ad Library page (Ctrl+S / Cmd+S, "Webpage, HTML only"), then: zuverse fetch --html saved.html --ad <ad id>
  4. Download the video yourself and run: zuverse fetch path/to/video.mp4`;

/**
 * The ad as `out` (an mp4 or whatever the source was; it is transcoded next).
 * `html` + `adId`: read the video address from a saved Ad Library page.
 */
export async function getSource(input, out, { html, adId } = {}) {
  if (html) {
    const text = await readFile(html, "utf8");
    const found = adLibraryVideoFromHtml(text, String(adId ?? ""));
    if (!found) throw new Error(`No video for ad ${adId} in ${path.basename(html)}. Check the ad id (the number after ?id= in the link).`);
    if (!(await downloadVideo(found.videoUrl, out))) throw new Error("The video address in that page didn't download (the links expire after a while: save the page again).");
    return { via: "saved ad library page", title: found.title };
  }

  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Give a link (TikTok, Instagram, Facebook Ad Library, or a video file link) or a file path.");
  if (!/^https?:\/\//i.test(raw)) {
    if (!existsSync(raw)) throw new Error(`No such file: ${raw}`);
    await copyFile(raw, out);
    return { via: "file" };
  }

  const link = parseSourceLink(raw);
  if (link?.platform === "tiktok") {
    let resolved = link;
    if (link.short) {
      const page = await fetchText(link.url, { headers: browserHeaders() });
      resolved = (page && parseSourceLink(page.res.url)) || link;
    }
    const got = await tiktok(resolved, out);
    if (got) return got;
  } else if (link?.platform === "instagram") {
    const got = await instagram(link, out);
    if (got) return got;
  } else if (!link) {
    // A direct video link.
    if (await downloadVideo(raw, out)) return { via: "direct link" };
  }

  const viaYtDlp = ytDlp(link?.url ?? raw, out);
  if (viaYtDlp.ok) return { via: "yt-dlp" };

  if (link?.platform === "facebook-ad") throw new Error(FACEBOOK_HELP);
  const hint = viaYtDlp.missing
    ? " Installing yt-dlp (https://github.com/yt-dlp/yt-dlp) often fixes this, or download the video and pass the file."
    : ` yt-dlp: ${viaYtDlp.error || "failed"}. Download the video and pass the file instead.`;
  throw new Error(`Couldn't download that ${link?.platform ?? "link"}.${hint}`);
}
