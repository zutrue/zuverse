---
name: zuverse
description: Reverse-engineer any video ad (TikTok, Instagram Reel, Facebook Ad Library ad, or a video file) and remake it shot for shot with a new person, voice, brand or place, using the Zuverse CLI on Zurelay (Gemini 3.1 Pro reads the ad, GPT Image 2.5 casts the new person and draws each shot, Seedance 2.5 makes the video). Use when the user wants to copy, clone, remake, recreate, reverse-engineer or "make my own version of" a video ad or short-form video, swap the person in an ad, or break an ad down into its hook, script and shots. Also, only when the user asks for it, edits the finished video: every pause cut out, word-by-word captions, punch-in zooms, pop-up stickers.
argument-hint: "[ad link or video file]"
---

# Zuverse: remake any video ad

Zuverse is the Zuops Video Ad Copier as a command-line tool. It reads an ad shot by shot, then makes it again
with a new person, a new voice and your brand. You (Claude) drive it: you run the commands, show the user the
plan, ask them what to change, work their changes into the plan, and confirm the price before anything is spent.

## Running it

The CLI is `bin/zuverse.mjs` in the Zuverse folder:

```bash
node "${CLAUDE_SKILL_DIR}/../../../bin/zuverse.mjs" <command> [args]
```

Below, `zuverse` means that command (inside a clone of the repo, `node bin/zuverse.mjs` is the same thing).
Projects are saved in `./zuverse-projects/<name>/` under the current folder. Every command after `fetch`
takes the project name; leave it out to use the most recent project.

Long steps (reading an ad, drawing frames, rendering) take minutes. Give Bash calls a 600000 ms timeout, or
run them in the background and wait for them. A render that is still going when the command returns is
picked up again with `zuverse status <project>`.

## 0. Setup (first time only)

Run `zuverse doctor`.

- **ffmpeg missing:** run `npm install` in the Zuverse folder (it downloads its own ffmpeg). If it is still
  missing, install ffmpeg: `winget install Gyan.FFmpeg` (Windows), `brew install ffmpeg` (macOS),
  `sudo apt install ffmpeg` (Linux).
- **Zurelay key missing:** Zuverse runs on [Zurelay](https://zurelay.com), one API key for every model it uses
  (Gemini 3.1 Pro, GPT Image 2.5, Seedance 2.5) at prices well below buying each one direct, prepaid from $10
  with no subscription. Ask the user to create a key at https://zurelay.com (API keys), add credit, and put it
  in a `.env` file in the current folder: `ZURELAY_API_KEY=zr_live_...`. If they paste the key into the chat
  instead, write that `.env` file for them, make sure `.env` is listed in `.gitignore`, and never repeat the
  key back, print it, or put it anywhere else.
- **yt-dlp** is optional (Facebook Ad Library links, and a fallback for TikTok/Instagram).

## 1. Get the ad

```bash
zuverse fetch "<link or file>" --name <short-name>
```

TikTok, Instagram and direct video links download on their own; a local file is copied. The clip is trimmed to
its first 29 seconds (Seedance's limit) and sized for the video model.

**Facebook Ad Library links** (`facebook.com/ads/library/?id=...`): Facebook only shows these pages to a real
browser. If `fetch` can't get it and you have a browser tool (Claude in Chrome, the built-in browser, Playwright
MCP), open the link, wait for the ad to load, and run this in the page to get the ad's own HD video address:

```js
const id = new URLSearchParams(location.search).get("id"), html = document.documentElement.innerHTML;
const marks = [...html.matchAll(/"(?:adArchiveID|ad_archive_id)"\s*:\s*"?(\d{8,})"?/g)].map((m) => ({ id: m[1], pos: m.index }));
let url = null;
for (let i = 0; i < marks.length && !url; i++) {
  if (marks[i].id !== id) continue;
  const next = marks.slice(i + 1).find((m) => m.id !== id);
  const region = html.slice(marks[i].pos, next ? next.pos : html.length);
  const m = region.match(/"video_hd_url"\s*:\s*"([^"]+)"/) || region.match(/"video_sd_url"\s*:\s*"([^"]+)"/);
  if (m) url = JSON.parse(`"${m[1]}"`);
}
url || [...document.querySelectorAll('[role=dialog] video')].map((v) => v.currentSrc)[0];
```

Then `zuverse fetch "<that address>" --name <short-name>` (the address expires after a while, so fetch it right
away). Without a browser tool, ask the user to download the video (or save the page and use
`zuverse fetch --html saved.html --ad <id>`).

## 2. Read it

```bash
zuverse read <project>
```

Gemini 3.1 Pro watches the clip (picture and sound) and writes `analysis.json`: the hook, the transcript, the
script the remake will speak, the person, the place, the look, the sound, brand mentions, on-screen text and the
beats. The cuts are measured from the frames (`shots.json`, one frame per shot in `shots/`).

Tell the user what you found in a few lines: the hook, what's said (and whether a second voice speaks, e.g. a
phone call), who's on camera, where, and how many shots. You can look at the `shots/` frames yourself (Read the
JPGs) to describe them.

## 3. Ask what they want

Ask in one short message (use your question tool if you have one). The defaults are fine for anything they skip:

1. **What to make**
   - **Replace the person** (`mode=replace`, default): the original clip guides the motion, timing and camera;
     the person (and voice) is new. Closest to the original. Renders at up to 720p. The video model sometimes
     declines it (free) when a new face goes into a real person's footage, and it needs a face to use (a cast
     or their photo): with none it tends to keep the original person's look.
   - **Make a new version** (`mode=new`): filmed fresh, shot for shot: every shot is redrawn with new people in
     a new place of the same kind, so nothing from the original footage is reused. Recommend this when they
     want the ad unique, or when Replace is declined.
2. **Who's on camera:** a similar but different person is cast automatically. Or their own photo(s):
   `zuverse photo <project> <file> --note "our technician Sam"` (up to 9: people or products).
3. **Brand:** `company="Their Business"` swaps every brand mention; `removeBranding=true` strips them.
4. **Anything else to change?** New lines, a different offer, a different place, outfit, tone, language...
5. **Length and quality:** `duration` (4-30 s, default the ad's length) and `resolution` (480p/720p/1080p).
   Suggest a 480p draft first when they're unsure: same look, a fraction of the price.
6. **Edit the finished video too?** Off unless they say yes. If they do, once the video is made you cut every
   pause out of it and add word-by-word captions, punch-in zooms, a few pop-up stickers and a progress bar
   (step 7; a few cents for the word timing, the rest runs on their computer). Never edit without a yes.

Apply simple choices with `zuverse set <project> key=value ...` (run `zuverse help` for every setting).

### Their changes ("anything else to change?")

This is your job, done the way the Zuops planner does it:

1. Run `zuverse direction-rules <project>`: it prints the rules and the current plan as JSON.
2. Follow the rules exactly and write the rewritten plan to `<project folder>/direction.json`. Do every part of
   what they asked; change only what they asked plus what must change with it.
3. Also save their words as notes: `zuverse set <project> notes="<their direction, as they said it>"`.
4. Show them the `summary` bullets (and anything in `cannot`).

To change the script only, `zuverse set <project> script="..."` is enough. To edit beats by hand, copy
`analysis.json` to `plan.json` in the project folder and edit `plan.json` (never edit `analysis.json`).

## 4. Confirm the price

Run `zuverse cost <project>` and tell the user what it will cost on Zurelay, e.g. "about $4.60 for 15 s at 720p
(a 480p draft is about $2)". Rendering spends their money: **never add `--yes` until the user has said yes to
this render.** Failed videos are free on Zurelay.

## 5. Make it

```bash
zuverse make <project> --yes
```

That runs: cast (a new face, unless they gave photos) -> frames (new-version mode: every shot mapped and drawn
fresh) -> prompt (the Seedance prompt, the new voice, who says which line) -> render (Seedance 2.5, downloaded as
`zuverse-<project>-<time>.mp4`).

To check the work before paying for the video, run the steps one by one: `zuverse cast`, `zuverse frames`,
`zuverse prompt`, look at `cast/*.jpg`, `frames/*.jpg` and `prompt.txt` (Read them), show the user, then
`zuverse render <project> --yes`. `prompt.txt` can be edited by hand before rendering; keep its `@Image` numbers
matching the `referenceImages` list in `render-plan.json`.

If the render is still going when the command returns, run `zuverse status <project>` until it finishes.

## 6. Deliver

Give the user the path to the MP4 and offer next steps: another take (`zuverse render <project> --yes` again:
same prompt, a new video), a change and re-make (`set` / `direction.json`, then `zuverse prompt` and `render`),
the other mode, or the final at 720p after a 480p draft. If they said yes to editing in step 3, go on to step 7;
if they never answered it, ask once now.

## 7. Edit it (only when they said yes)

You are the editor; the CLI does the cutting and drawing.

1. Run `zuverse edit-rules <project>`. The first time, Gemini times every word of the finished video (a few
   cents; kept in `edit/words.json`, so re-edits are free). It prints the edit.json rules, then every word with
   its number and times, `*` for an off-screen voice (a phone call), and each pause with how long it is before
   and after the cut.
2. Write `<project folder>/edit.json` by those rules: the 3-8 words to emphasize, 1-3 short stickers (the hook,
   the offer, the CTA; kept off the face), any pause worth keeping (`keepPauses`), and `maxHold` when a pause is
   still long after the cut because a sound plays in it (a ringtone, music) and nothing is said there. Work in
   anything the user asked for (their colours, a sticker's words, no zooms...).
3. Run `zuverse edit <project>`. It saves `zuverse-<project>-edit-<time>.mp4` (the render is kept as it was).
4. Look before you hand it over: grab a few frames (the sticker moments, a zoomed part) with ffmpeg and Read
   them. Stickers must not cover the face, and captions must be readable. Fix edit.json and run `zuverse edit`
   again if not.
5. Give them the edited MP4 and say what changed (e.g. "29 s -> 20.5 s, 4 pauses cut, 3 stickers").

`zuverse edit <project> --auto` makes a decent edit without edit.json (numbers and CTA words emphasized, no
stickers). `--video <file>` edits any video, not just this project's render (their own clip, the original ad).

## When something fails

- **`content_policy`** (the video model declined it, free): Seedance's filter often declines photoreal faces in
  reference images, even generated ones. Render once more (it can pass on a second try). If it's declined again:
  in new-version mode run `zuverse set <project> images=off`, then `zuverse prompt` and `zuverse render --yes`:
  no face or frame is sent and the video model casts the new person from the written plan, shot by shot (this
  goes through reliably). In Replace mode, switch to `mode=new` (then `zuverse make`). Tell the user what you
  changed and why.
- **Download failed:** see the Facebook steps above, install yt-dlp, or ask for the video file.
- **402 / balance:** the user adds credit at https://zurelay.com/app/billing.
- **429 / 503:** Zurelay is busy; the CLI already retries. Run the step again later. (The word timing for an edit
  moves to Gemini 3.8 Flash on its own when Gemini 3.1 Pro is unavailable.)

## Use it responsibly

Zuverse is for making your own ads from ideas that work: remakes with new people, a new voice and your brand.
Don't use it to impersonate a real person, put someone's face or voice in an ad without their consent, copy
logos or trademarks, or pass off someone else's ad as theirs. "Make a new version" redraws every person and
place so nothing from the original footage is reused.
