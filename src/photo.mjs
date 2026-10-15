/**
 * The "casual iPhone photo" prompt every generated person and frame uses,
 * rendered by GPT Image 2.5 Sunburst at medium quality, 1K, JPEG. Written this
 * way, people come out looking like real people on an ordinary day rather
 * than models in a studio (1K looked more real than 2K: the phone-JPEG
 * softness the prompt asks for).
 */

export const PHOTO_QUALITY = "medium";
export const PHOTO_FORMAT = "jpeg";

const strip = (s) => String(s ?? "").trim().replace(/\.$/, "");

function shapeLine(aspectRatio) {
  const ar = String(aspectRatio || "").trim();
  if (ar === "16:9") return "landscape 16:9";
  if (ar === "1:1") return "square 1:1";
  if (ar === "4:5" || ar === "3:4" || ar === "2:3") return `portrait ${ar}`;
  if (ar === "4:3" || ar === "3:2") return `landscape ${ar}`;
  return "portrait 9:16";
}

export function aspectFor(raw) {
  return raw === "landscape" || raw === "16:9" ? "16:9" : raw === "square" || raw === "1:1" ? "1:1" : "9:16";
}

/** GPT Image pixel size at 1K for a ratio: long side 1536 (1024 square), sides in steps of 16. */
export function imageSize(ratio) {
  const [a, b] = aspectFor(ratio).split(":").map(Number);
  if (a === b) return "1024x1024";
  const longRatio = Math.max(a / b, b / a);
  const short = Math.max(16, Math.round(1536 / longRatio / 16) * 16);
  return a > b ? `1536x${short}` : `${short}x1536`;
}

/**
 * The image prompt, as the JSON GPT Image 2.5 follows closely.
 *
 * camera: "selfie" (filming themselves), "filmed" (a friend holds the phone),
 * "group", "scene" (no person in view) or "mirror".
 */
export function casualIphonePhotoPrompt(p) {
  const cam = p.camera;
  const person = cam === "selfie" || cam === "filmed" || cam === "mirror";
  const look = strip(p.look) || "an adult who would run this business";
  const outfit = strip(p.outfit);
  const wearing = outfit ? `, wearing ${outfit}` : "";
  const action = strip(p.action);
  const setting = strip(p.setting) || "an ordinary everyday place";
  const framing = strip(p.framing);
  const realism = (p.realism || []).map(strip).filter(Boolean);

  const opening =
    cam === "scene"
      ? `A casual iPhone photo of ${strip(p.subject) || setting}.`
      : cam === "selfie"
        ? `A casual iPhone selfie of ${look}${wearing || ", wearing ordinary unbranded clothes"}, ${action || "caught mid-sentence while filming a quick video of themselves on their own phone, talking straight into the front camera"}.`
        : cam === "mirror"
          ? `A casual iPhone mirror selfie of ${look}${wearing || ", wearing ordinary unbranded clothes"}, ${action || "holding their phone up to the mirror"}.`
          : cam === "filmed"
            ? action
              ? `A casual iPhone photo of ${look}${wearing}, ${action}, as a friend takes a quick photo of them on an iPhone from a few feet away.`
              : `A casual iPhone photo of ${look}${wearing || ", wearing ordinary unbranded clothes"}, caught mid-sentence while talking straight into the lens as a friend films a quick video of them on an iPhone held by someone a few feet in front of them.`
            : `A casual iPhone photo of ${look}${wearing}${action ? `, ${action}` : ""}, as a friend takes a quick photo from a few feet away.`;

  const people = person
    ? [
        realism.length
          ? `They are a real person in that role, not a model, actor or influencer, exactly as they would look on a normal work day: ${realism.join("; ")}.`
          : "They are a real person in that role, not a model, actor or influencer, exactly as they would look on a normal work day.",
        "Realistic skin texture with visible pores and slight unevenness, a few flyaway hairs, natural teeth, and a relaxed, slightly asymmetrical expression mid-word. Makeup, hair and grooming exactly as this person would have them on a normal day in this job: a med spa, salon or skincare presenter is made up and groomed, a tradesperson is not. As attractive or as plain as a real person in that job would be, no more and no less.",
      ]
    : cam === "group"
      ? [
          "They are real people, not models, actors or influencers, exactly as they would look on an ordinary day. Realistic skin texture with visible pores and slight unevenness, a few flyaway hairs, natural teeth, and relaxed, slightly asymmetrical expressions, caught mid-moment rather than posing.",
        ]
      : [];

  const place = `Location: ${setting}. Lit only by the ordinary light of that place: outdoors, plain daylight, direct sun or overcast; indoors, the room's own uneven light from one side. The background stays in focus, with the real, mundane details of the place recognizable.`;

  const camera =
    cam === "selfie"
      ? "Front camera held at arm's length, a little above or below eye level, chest-up, slightly off-center with a subtly tilted camera angle and the mild wide-angle stretch of a selfie."
      : cam === "mirror"
        ? `Taken on their own phone pointed at a mirror: the phone and the hand holding it are visible in the reflection, partly covering the lower face; framed as ${framing || "a reflection from the knees up with the room around them"}, slightly off-center with a subtly tilted camera angle.`
        : cam === "filmed"
          ? `Taken from a few feet away at about chest height, not a selfie: no arm reaching toward the camera; framed as ${framing || "a medium shot from the waist up with the place around them"}, slightly off-center with a subtly tilted camera angle.`
          : cam === "group"
            ? `Taken by a friend from a few feet away, framed as ${framing || "a medium-wide shot with the place around them"}, slightly off-center with a subtly tilted camera angle.`
            : `Taken on an iPhone by someone standing there, framed as ${framing || "the whole subject in view with some of the place around it"}, slightly off-center with a subtly tilted camera angle.`;

  const roll = cam === "selfie" || cam === "mirror" ? "their own" : cam === "scene" ? "someone's" : "a friend's";
  const quality = `Everyday iPhone camera quality, subtle shadow noise, natural colors and small imperfections. It should feel like an unedited photo from ${roll} camera roll.`;
  const never =
    "No posing, no beauty filters, no skin smoothing, no retouching, no studio lighting or ring light, no cinematic grading, no HDR glow, no portrait-mode blur, no whitened teeth. No text, no logos, no graphics and no watermark.";

  const prompt = [
    opening,
    ...people,
    ...(p.extra || []).map((x) => String(x || "").trim()).filter(Boolean),
    place,
    camera,
    quality,
    never,
    `Single photograph, ${shapeLine(p.aspectRatio)}.`,
  ].join(" ");
  return JSON.stringify({ prompt }, null, 2);
}

/**
 * "Cast a similar but different person": the same TYPE of person as the ad's
 * presenter (gender, age range, style of clothes, energy) so the ad still
 * works, but a clearly different individual - never their face. The user's
 * own direction about the person wins over the original's type.
 */
export function castPrompt(analysis, styleNote = "") {
  const clip = (v, n) => String(v ?? "").replace(/@\w+\d*/g, "").replace(/\s+/g, " ").trim().slice(0, n);
  const subject = analysis?.subject_reference ?? {};
  const typeOf = clip(subject.demographics, 220);
  const attireOf = clip(subject.attire, 200);
  const energyOf = clip(subject.expression, 140);
  const roleOf = clip(analysis?.product_or_service || analysis?.industry, 160);
  return casualIphonePhotoPrompt({
    camera: "filmed",
    look: typeOf
      ? `a real everyday person of the same type as the presenter in the original ad: ${typeOf} (same gender and age range, same general look), who could front an ad for ${roleOf || "this business"}`
      : "a real everyday person who could be the on-camera presenter for this kind of ad",
    outfit: attireOf ? `the same style of clothes: ${attireOf}, with no logos or brand names` : "casual, clean everyday clothes with no logos",
    action: `looking straight into the lens${energyOf ? `, ${energyOf}` : " with a relaxed, warm expression"}`,
    setting: "standing against a plain, uncluttered light wall at home in soft window light",
    framing: "a waist-up shot",
    extra: [
      styleNote ? `The user's direction for this ad comes first; follow anything it says about the person: ${clip(styleNote, 400)}.` : "",
      "CRITICAL: a clearly different individual from the person in the original ad: their own face (different face shape and features) and their own hairstyle, never a lookalike or near-twin of them. Never resemble a specific real or famous person.",
    ],
    aspectRatio: "9:16",
  });
}
