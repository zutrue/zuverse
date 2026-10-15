/**
 * Links -> a downloadable video. Pure parsing (the network lives in
 * source.mjs), so every page shape can be unit-tested.
 */

/** TikTok, Instagram or Facebook Ad Library link? null for anything else. */
export function parseSourceLink(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  if (/^(vm|vt)\.tiktok\.com$/.test(host) || (host === "tiktok.com" && /^\/t\//.test(u.pathname))) {
    return { platform: "tiktok", url: u.toString(), id: null, short: true };
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    const m = u.pathname.match(/\/(?:video|photo)\/(\d{8,})/) || u.pathname.match(/\/v\/(\d{8,})/);
    if (!m) return null;
    const user = u.pathname.match(/^\/(@[^/]+)/)?.[1] ?? "@i";
    return { platform: "tiktok", url: `https://www.tiktok.com/${user}/video/${m[1]}`, id: m[1], short: false };
  }
  if (host === "instagram.com" || host === "instagr.am" || host.endsWith(".instagram.com")) {
    const m = u.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/);
    if (!m) return null;
    const kind = m[1] === "reels" ? "reel" : m[1];
    return { platform: "instagram", url: `https://www.instagram.com/${kind}/${m[2]}/`, id: m[2], short: false };
  }
  if ((host === "facebook.com" || host.endsWith(".facebook.com")) && /\/ads\/library/.test(u.pathname)) {
    const id = u.searchParams.get("id");
    return /^\d{8,}$/.test(id ?? "") ? { platform: "facebook-ad", url: `https://www.facebook.com/ads/library/?id=${id}`, id, short: false } : null;
  }
  return null;
}

const unescapeJson = (s) =>
  s.replace(/\\u002F/gi, "/").replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&");

/** TikTok's page data (__UNIVERSAL_DATA_FOR_REHYDRATION__ / SIGI_STATE) -> the playable video. */
export function tiktokVideoFromHtml(html) {
  const text = String(html ?? "");
  const scripts = [
    text.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)?.[1],
    text.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/)?.[1],
  ].filter(Boolean);
  for (const raw of scripts) {
    try {
      const j = JSON.parse(raw);
      const item =
        j?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ??
        (j?.ItemModule ? Object.values(j.ItemModule)[0] : null);
      const v = item?.video;
      if (!v) continue;
      // The plain play address has no watermark; bitrate variants are the fallback.
      const variants = Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [];
      const best = variants
        .map((b) => ({ url: b?.PlayAddr?.UrlList?.[0], bitrate: Number(b?.Bitrate) || 0 }))
        .filter((b) => typeof b.url === "string" && b.url)
        .sort((a, b) => b.bitrate - a.bitrate)[0]?.url;
      const url = v.playAddr || best || v.downloadAddr;
      if (typeof url === "string" && url.startsWith("http")) {
        return {
          videoUrl: unescapeJson(url),
          durationSeconds: Number(v.duration) || undefined,
          width: Number(v.width) || undefined,
          height: Number(v.height) || undefined,
          title: String(item?.desc ?? "").slice(0, 120) || undefined,
        };
      }
    } catch {
      /* next script */
    }
  }
  const loose = text.match(/"playAddr":"(https:[^"]+)"/)?.[1];
  return loose ? { videoUrl: unescapeJson(loose) } : null;
}

/** tikwm.com's public API answer -> the no-watermark video. */
export function tiktokVideoFromTikwm(json) {
  const d = json?.data;
  if (!d || (json?.code !== undefined && json.code !== 0)) return null;
  const pick = d.hdplay || d.play || d.wmplay;
  if (typeof pick !== "string" || !pick) return null;
  const url = pick.startsWith("http") ? pick : `https://www.tikwm.com${pick}`;
  return { videoUrl: url, durationSeconds: Number(d.duration) || undefined, title: String(d.title ?? "").slice(0, 120) || undefined };
}

/**
 * "video_url" in any amount of JSON escaping (the embed page nests it three
 * deep). The address runs to the next quote; its backslashes are escaping.
 */
function escapedJsonUrl(text, key) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(key, from);
    if (at < 0) return null;
    from = at + key.length;
    const start = text.indexOf("https:", from);
    if (start < 0 || !/^[\\"\s:]*$/.test(text.slice(from, start))) continue;
    const end = text.indexOf('"', start);
    if (end < 0) return null;
    const url = text
      .slice(start, end)
      .replace(/\\+\//g, "/")
      .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, "&")
      .replace(/\\+$/, "");
    if (/^https:\/\/[^\s\\]+$/.test(url)) return url;
  }
}

/** Any Instagram page HTML (post, embed) -> the video. */
export function instagramVideoFromHtml(html) {
  const text = String(html ?? "");
  const direct =
    escapedJsonUrl(text, "video_url") ??
    text.match(/"video_versions"\s*:\s*\[\s*\{[^\]]*?"url"\s*:\s*"(https:[^"]+)"/)?.[1] ??
    text.match(/<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="(https:[^"]+)"/)?.[1] ??
    text.match(/<video[^>]+src="(https:[^"]+\.mp4[^"]*)"/)?.[1];
  if (!direct) return null;
  const duration = Number(text.match(/video_duration\\*"\s*:\s*([\d.]+)/)?.[1]);
  return { videoUrl: unescapeJson(direct), durationSeconds: duration || undefined };
}

const AD_ID_MARKER = /"(?:adArchiveID|ad_archive_id)"\s*:\s*"?(\d{8,})"?/g;
const MAX_REGION_CHARS = 400_000;

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\\//g, "/");
  }
}

/**
 * The video of one ad out of saved Facebook Ad Library HTML. A deep link
 * renders the requested ad on top of the advertiser's whole listing, so the
 * page carries dozens of ads: the right video is the first one after the
 * ad's own id marker and before the next ad's.
 */
export function adLibraryVideoFromHtml(html, adId) {
  const text = String(html ?? "");
  const markers = Array.from(text.matchAll(AD_ID_MARKER), (m) => ({ id: m[1], pos: m.index ?? 0 }));
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].id !== adId) continue;
    let end = text.length;
    for (let j = i + 1; j < markers.length; j++) {
      if (markers[j].id !== adId) {
        end = markers[j].pos;
        break;
      }
    }
    const region = text.slice(markers[i].pos, Math.min(end, markers[i].pos + MAX_REGION_CHARS));
    const hit = region.match(/"video_hd_url"\s*:\s*"([^"]+)"/) ?? region.match(/"video_sd_url"\s*:\s*"([^"]+)"/);
    if (!hit?.[1]) continue;
    const videoUrl = unescapeJsonString(hit[1]).replace(/&amp;/g, "&").trim();
    if (/^https?:\/\//i.test(videoUrl)) {
      const page = region.match(/"page_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return { videoUrl, title: page ? unescapeJsonString(page[1]).trim() || undefined : undefined };
    }
  }
  // A page that names no other ad (one ad's snapshot): its only video.
  const others = Array.from(text.matchAll(AD_ID_MARKER), (m) => m[1]).some((id) => id !== adId);
  if (others) return null;
  const any = text.match(/"video_hd_url"\s*:\s*"([^"]+)"/) ?? text.match(/"video_sd_url"\s*:\s*"([^"]+)"/) ?? text.match(/<video[^>]*\ssrc=["']([^"']+)["']/i);
  return any ? { videoUrl: unescapeJsonString(any[1]).replace(/&amp;/g, "&") } : null;
}

/** Looks like an MP4/MOV (by type or by the first bytes: "ftyp" at byte 4). */
export function looksLikeVideo(contentType, head) {
  if (/^video\//i.test(contentType ?? "")) return true;
  return head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
}
