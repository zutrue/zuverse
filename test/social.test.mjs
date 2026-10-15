// Ported from the Zuops Video Ad Copier tests.
// Rename in the port: parseSocialLink -> parseSourceLink (which also knows Facebook Ad Library links).
// Not ported (not in src/social.mjs): instagramVideoFromGraphql.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instagramVideoFromHtml,
  looksLikeVideo,
  parseSourceLink,
  tiktokVideoFromHtml,
  tiktokVideoFromTikwm,
} from "../src/social.mjs";

test("TikTok links: full, share-tracking, mobile and short", () => {
  assert.deepStrictEqual(
    parseSourceLink("https://www.tiktok.com/@airductcleaners/video/7639584443434274061?q=air%20duct%20cleaning&t=1790378067427"),
    { platform: "tiktok", url: "https://www.tiktok.com/@airductcleaners/video/7639584443434274061", id: "7639584443434274061", short: false },
  );
  assert.deepStrictEqual(parseSourceLink("https://m.tiktok.com/v/7639584443434274061.html")?.id, "7639584443434274061");
  assert.deepStrictEqual(parseSourceLink("https://vm.tiktok.com/ZMabc123/")?.short, true);
  assert.deepStrictEqual(parseSourceLink("https://www.tiktok.com/t/ZTabc/")?.short, true);
  assert.deepStrictEqual(parseSourceLink("https://www.tiktok.com/@someone"), null, "a profile is not a video");
});

test("Instagram links: post, reel, reels, tv, with share params", () => {
  assert.deepStrictEqual(parseSourceLink("https://www.instagram.com/p/DYGf8OauXh3/"), {
    platform: "instagram",
    url: "https://www.instagram.com/p/DYGf8OauXh3/",
    id: "DYGf8OauXh3",
    short: false,
  });
  assert.deepStrictEqual(parseSourceLink("https://instagram.com/reel/Cx1_ab-Z9/?igsh=abc")?.url, "https://www.instagram.com/reel/Cx1_ab-Z9/");
  assert.deepStrictEqual(parseSourceLink("https://www.instagram.com/reels/Cx1_ab-Z9/")?.url, "https://www.instagram.com/reel/Cx1_ab-Z9/");
  assert.deepStrictEqual(parseSourceLink("https://www.instagram.com/someuser/"), null);
  // Not a valid ad id (the port's Ad Library support needs a numeric id of 8+ digits).
  assert.deepStrictEqual(parseSourceLink("https://www.facebook.com/ads/library/?id=1"), null);
  assert.deepStrictEqual(parseSourceLink("not a url"), null);
});

// Added for the port: parseSourceLink also recognises Facebook Ad Library links.
test("Facebook Ad Library links (port only)", () => {
  assert.deepStrictEqual(parseSourceLink("https://www.facebook.com/ads/library/?active_status=all&id=1234567890123456"), {
    platform: "facebook-ad",
    url: "https://www.facebook.com/ads/library/?id=1234567890123456",
    id: "1234567890123456",
    short: false,
  });
  assert.deepStrictEqual(parseSourceLink("https://www.facebook.com/somepage/videos/123456789"), null);
});

test("TikTok page data -> the play address, unescaped", () => {
  const data = {
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        itemInfo: {
          itemStruct: {
            desc: "30 seconds of dirty ducts",
            video: {
              duration: 22,
              width: 720,
              height: 1280,
              playAddr: "https:\\u002F\\u002Fv16-webapp-prime.us.tiktok.com\\u002Fvideo\\u002Fabc?a=1\\u0026b=2",
              downloadAddr: "https://example.com/watermarked.mp4",
            },
          },
        },
      },
    },
  };
  const html = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data).replace(/\\\\u/g, "\\u")}</script></html>`;
  const v = tiktokVideoFromHtml(html);
  assert.deepStrictEqual(v?.durationSeconds, 22);
  assert.deepStrictEqual(v?.width, 720);
  assert.ok(v?.videoUrl.startsWith("https://v16-webapp-prime.us.tiktok.com/video/abc"), v?.videoUrl);
  assert.ok(!v?.videoUrl.includes("\\u"), "unescaped");
  assert.deepStrictEqual(tiktokVideoFromHtml("<html>captcha</html>"), null);
});

test("tikwm answers", () => {
  assert.deepStrictEqual(tiktokVideoFromTikwm({ code: 0, data: { hdplay: "https://cdn/x.mp4", duration: 22, title: "t" } })?.videoUrl, "https://cdn/x.mp4");
  assert.deepStrictEqual(tiktokVideoFromTikwm({ code: 0, data: { play: "/video/media/play/1.mp4" } })?.videoUrl, "https://www.tikwm.com/video/media/play/1.mp4");
  assert.deepStrictEqual(tiktokVideoFromTikwm({ code: -1, msg: "Url parsing is failed!" }), null);
});

test("Instagram HTML in its many shapes", () => {
  assert.deepStrictEqual(instagramVideoFromHtml('..."video_url":"https:\\/\\/scontent.cdninstagram.com\\/a.mp4?b=1\\u0026c=2"...')?.videoUrl, "https://scontent.cdninstagram.com/a.mp4?b=1&c=2");
  assert.deepStrictEqual(instagramVideoFromHtml('<meta property="og:video" content="https://x.cdninstagram.com/v.mp4?a=1&amp;b=2">')?.videoUrl, "https://x.cdninstagram.com/v.mp4?a=1&b=2");
  assert.deepStrictEqual(instagramVideoFromHtml('"video_versions":[{"type":101,"url":"https://v/1.mp4","width":720}]')?.videoUrl, "https://v/1.mp4");
  assert.deepStrictEqual(instagramVideoFromHtml('<video class="x" src="https://v/2.mp4?x=1"></video>')?.videoUrl, "https://v/2.mp4?x=1");
  assert.deepStrictEqual(instagramVideoFromHtml("<html><title>Instagram</title></html>"), null);
});

test("video sniffing", () => {
  assert.ok(looksLikeVideo("video/mp4", new Uint8Array()));
  assert.ok(looksLikeVideo("application/octet-stream", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])));
  assert.ok(!looksLikeVideo("text/html", new Uint8Array([60, 104, 116, 109, 108, 62, 0, 0])));
});

test("the Instagram embed page's triple-escaped video address", () => {
  const embed =
    'x\\":{\\"count\\":2379}},\\"video_url\\":\\"https:\\\/\\\/scontent-lax7-1.cdninstagram.com\\\/o1\\\/v\\\/t2\\\/m86\\\/AQO.mp4?efg=eyJ2\\u00253D&_nc_ht=scontent&oe=6AB8E912\\\\\\",\\"video_duration\\":11.7,';
  const v = instagramVideoFromHtml(embed);
  assert.deepStrictEqual(v?.videoUrl, "https://scontent-lax7-1.cdninstagram.com/o1/v/t2/m86/AQO.mp4?efg=eyJ2%3D&_nc_ht=scontent&oe=6AB8E912");
  assert.deepStrictEqual(v?.durationSeconds, 11.7);
});
