# Zuverse

**Reverse-engineer any video ad. Remake it as your own.**

Give Zuverse a TikTok, an Instagram Reel, a Facebook Ad Library ad or any video file. It breaks the ad down shot
by shot (the hook, every word, every cut, the person, the place, the camera, the sound), then makes it again with
a new person, a new voice and your brand.

It's the same pipeline as the Video Ad Copier in [Zuops](https://zuops.com), open-sourced as a tool you hand to
[Claude Code](https://claude.com/claude-code). Claude runs it, shows you the plan, asks what you want changed, and
tells you the price before anything is spent.

## Give it to your Claude

Open Claude Code in any folder and paste:

```text
Set up Zuverse from https://github.com/zutrue/zuverse and remake this ad for my business: <link to the ad>
```

That's it. Claude clones the repo, installs it, asks for your [Zurelay](https://zurelay.com) API key, reads the
ad, and walks you through the remake.

<details>
<summary>Or install it as a Claude Code plugin (works in every project)</summary>

```text
/plugin marketplace add zutrue/zuverse
/plugin install zuverse@zuverse
```

Then ask Claude to "remake this ad: <link>". In plugin mode, install ffmpeg yourself if `zuverse doctor` says it's
missing (`winget install Gyan.FFmpeg`, `brew install ffmpeg` or `sudo apt install ffmpeg`).

</details>

## What it does

1. **Gets the ad.** TikTok, Instagram and direct video links download on their own; Facebook Ad Library ads come
   through your browser (Claude does it for you if it has a browser tool). The first 29 seconds are kept.
2. **Reads it shot by shot.** Gemini 3.1 Pro watches the clip with its sound and writes the plan: the hook, the
   transcript, who's on camera, where, how it's filmed, the music, brand mentions and on-screen text. The cuts are
   measured from the frames, so the remake cuts where the original cuts.
3. **Takes your changes.** A new script, offer, place, outfit or language: Claude works them into the plan.
4. **Casts the new person.** GPT Image 2.5 makes a similar but clearly different person (same kind of presenter,
   never the same face), or you use your own photos.
5. **Makes the video.** Seedance 2.5 renders it with the new person speaking in a voice that fits them, and the
   second voice of a phone call kept as a second voice.

Two ways to remake:

| | **Replace the person** (`mode=replace`) | **Make a new version** (`mode=new`) |
| --- | --- | --- |
| What's kept | The original's motion, timing and camera (the clip is the reference) | The shot list: same shots, same cuts, same framing and action |
| What's new | The person, the voice, the brand | Every person and the place: each shot is redrawn fresh |
| Best for | The closest copy of a winning ad | A fresh ad nobody can trace back to the original footage |
| Resolution | 480p or 720p | 480p, 720p or 1080p |
| Good to know | Needs a face for the new person (cast or your photo). The video model sometimes declines a new face in real footage; that's free, and a new version is the way around it | Takes a few more minutes: every shot is drawn first |

## Why Zurelay

Zuverse needs three kinds of AI: a model that watches video (Gemini 3.1 Pro), an image model (GPT Image 2.5) and a
video model (Seedance 2.5). [Zurelay](https://zurelay.com) serves all of them behind **one OpenAI-compatible API
key**, prepaid from $10 with no subscription, at a fraction of each lab's own price. It takes the ad and the
photos inline, so there's nothing to host, and failed videos aren't charged. (Full disclosure: Zurelay is made by
the same team as Zuverse.)

| What | Model on Zurelay | Price (Oct 2026) |
| --- | --- | --- |
| Reading the ad | `gemini-3.1-pro` | about $0.05 an ad |
| Cast face + shot frames | `gpt-image-2.5-sunburst` | about $0.03 an image |
| The video | `seedance-2.5` | $0.135/s at 480p, $0.305/s at 720p, $0.75/s at 1080p |
| The original clip as a reference (Replace mode) | `seedance-2.5` | $0.081/s at 480p, $0.183/s at 720p |

**What a remake costs:**

| Video | Make a new version | Replace the person (with a 15 s reference) |
| --- | --- | --- |
| 15 s at 480p (draft) | about $2.40 | about $3.30 |
| 15 s at 720p | about $5 | about $7.40 |
| 30 s at 720p | about $9.70 | about $14.50 (29 s reference) |

Live prices: [zurelay.com/models](https://zurelay.com/models). `zuverse cost` shows the price of your exact settings
before you render.

**Get a key:** sign up at [zurelay.com](https://zurelay.com), add credit, create an API key, and put it in a `.env`
file next to where you run Zuverse:

```bash
ZURELAY_API_KEY=zr_live_your_key_here
```

## Use it without Claude

Zuverse is a plain Node.js CLI (Node 18+, no build step).

```bash
git clone https://github.com/zutrue/zuverse && cd zuverse
npm install           # also downloads ffmpeg
cp .env.example .env  # then paste your Zurelay key into .env
node bin/zuverse.mjs doctor
```

```bash
node bin/zuverse.mjs fetch "https://www.tiktok.com/@someone/video/123..." --name roof-ad
node bin/zuverse.mjs read roof-ad
node bin/zuverse.mjs set roof-ad mode=new duration=15 resolution=480p company="Peak Roofing"
node bin/zuverse.mjs photo roof-ad me.jpg --note "the owner, Sam"   # optional: your own face
node bin/zuverse.mjs cost roof-ad
node bin/zuverse.mjs make roof-ad --yes
```

Or in one go: `node bin/zuverse.mjs go "<link>" --mode new --duration 15 --resolution 480p --company "Peak Roofing" --yes`

| Command | What it does |
| --- | --- |
| `doctor` | Checks Node, ffmpeg, yt-dlp and your key |
| `fetch <link or file>` | Gets the ad and trims it to 29 s (`--html saved.html --ad <id>` for a saved Ad Library page) |
| `read` | Reads it shot by shot and measures the cuts |
| `plan` | Shows the plan: script, person, place, beats, settings |
| `set key=value ...` | Changes settings (below) |
| `photo <file> --note "..."` | Uses your own person or product photo (up to 9) |
| `direction-rules` | The rules for `direction.json` (your changes worked into the plan) and the current plan |
| `cast [--again]` | Casts a similar but different person |
| `frames [--remap]` | New-version mode: maps every shot and draws it fresh |
| `prompt` | Builds the Seedance prompt (`prompt.txt`, editable) and its references |
| `cost` | What it will cost |
| `render --yes` | Makes the video and downloads it |
| `status` | Keeps waiting for a render that's still going |
| `make --yes` | cast + frames + prompt + render |
| `go <link> --yes` | fetch + read + make |
| `list` | Your projects |

| Setting | Values |
| --- | --- |
| `mode` | `replace` (default) or `new` |
| `voice` | `new` (default: the new person's own voice) or `original` (replace mode only) |
| `duration` | 4 to 30 seconds (default: the ad's length, up to 29) |
| `resolution` | `480p`, `720p` (default), `1080p` |
| `aspect` | `9:16`, `16:9`, `1:1` (default: the ad's shape) |
| `company` | Your business name: every brand mention becomes yours |
| `removeBranding` | `true` strips brand names instead |
| `text` | `off` (default: no captions or on-screen words, which AI video misspells) or `on` |
| `music` | `on` (default) or `off` |
| `lookalike` | `true` (default): cast a similar person when you give no photo |
| `images` | `on` (default) or `off`: send no generated face or shot frames; the video model casts from the words |
| `notes` | Your direction, sent with the prompt |
| `script` | Your own words for the person to say |

Every project is a folder in `./zuverse-projects/` with everything each step made (`analysis.json`, `shots/`,
`frames/`, `cast/`, `prompt.txt`, the videos), so you can look, edit by hand, and re-run any step.

## How it works

```text
link ─► fetch ─► clip.mp4 (29 s, sized for Seedance)
                    │
                    ├─► Gemini 3.1 Pro watches it ─► analysis.json (hook, script, person, place, beats, sound)
                    └─► cut detection (ffmpeg)     ─► shots.json + one frame per shot
                                   │
                your changes ─► direction.json / plan.json / settings.json
                                   │
          Replace the person                       Make a new version
          ──────────────────                       ──────────────────
          cast a new face (GPT Image 2.5)          cast a new face
          mute the clip (new voice)                Gemini describes every measured shot
                                                   GPT Image 2.5 redraws each shot fresh:
                                                   same framing, new people, new place, no text
                                   │
                prompt ─► the voice read from the new face, who says which line
                                   │
                Seedance 2.5 ─► zuverse-<project>.mp4
```

Some details that make the difference:

- **Cut for cut.** The cuts come from the frames, not from the model's guess (left alone it folds a 12-shot ad
  into 5), and the remake is told to cut at exactly those times.
- **A new voice, really.** Seedance copies a reference video's sound, voice included, so the clip is sent muted
  and the new person's voice is read from their face.
- **Two voices stay two voices.** A phone call or someone behind the camera keeps their own lines and voice.
- **No text by default.** AI video misspells captions, so on-screen words are left out (turn them on with `text=on`).
- **Nothing traceable in a new version.** Shot frames are drawn new (same angle, new people, a new place), never
  edits of the original frames, and the presenter is cropped the way the ad crops them.

## Troubleshooting

- **Facebook Ad Library link won't download.** Facebook shows those pages only to a real browser. Install
  [yt-dlp](https://github.com/yt-dlp/yt-dlp), or open the ad, right-click the video, "Copy video address", and
  `fetch` that; or save the page and use `fetch --html saved.html --ad <id>`.
- **`content_policy`.** The video model declined it (free). Seedance's filter often declines photoreal faces in
  reference images, generated ones included. Try once more; if it's declined again, `set images=off` (a new
  version then sends no faces and the video model casts the person from the written plan, shot by shot), or
  switch a Replace to `mode=new`.
- **ffmpeg not found.** Run `npm install`, or install ffmpeg from your package manager.

## Use it responsibly

Zuverse is for turning ideas that work into your own ads. Don't use it to impersonate a real person, put
someone's face or voice in an ad without their consent, copy logos or trademarks, or pass off someone else's ad
as yours. Follow the terms of the platforms you post on.

## License

MIT. Made by the team behind [Zuops](https://zuops.com) and [Zurelay](https://zurelay.com).
