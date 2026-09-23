# Rick Explains

Paste a link to an article or announcement and get back a 9:16 short video in which Rick, a cranky genius scientist, translates it into normal human language. It's built for AI news, where half the announcements need translating.

<img src="docs/frame-hook.jpg" alt="A frame from a generated video: a title card reading 'New AI model just dropped', captions below, and the cartoon scientist Rick at the bottom" width="300" />

## What a video contains

- **Hook:** what happened, in one sentence.
- **THEY SAID / TRANSLATION:** the jargon is quoted, crossed out, and rewritten in plain English. This is the main bit.
- **Stat** and **list** cards for the key number and the takeaways.
- **Verdict:** a 0–10 "worth caring" meter.
- Word-by-word captions, a talking animated character, and an occasional synthesized burp.

## How it works

```
link or text ─▶ /api/extract ─▶ /api/script ─▶ /api/tts (per beat) ─▶ browser renders + records
                 Readability      Claude          ElevenLabs or          canvas 1080×1920 @30fps
                                  (JSON schema)   OpenAI TTS             MediaRecorder → MP4/WebM
```

1. **Extract** (`server.js`): the server downloads the page and pulls out the article text with Mozilla Readability. Pasted text skips this step.
2. **Script** (`script.js`): Claude writes a list of "beats" that must match a strict JSON schema. The system prompt keeps Rick's facts tied to the article (no invented numbers or quotes).
3. **Edit:** the page shows every beat so you can fix anything before rendering.
4. **Voice:** each beat's narration is sent to TTS on its own, which gives exact timing for every line.
5. **Render** (`public/renderer.js`): the browser draws every frame procedurally on a canvas (no image assets), lip-syncs the mouth to the audio volume, and records canvas and audio together with `MediaRecorder`. Chrome and Edge produce MP4. Browsers without MP4 recording produce WebM.

Rendering happens in real time, so a 60-second video takes about 60 seconds. Keep the tab in front while it renders, because background tabs throttle animation.

## Easiest: Mac app (no installs)

If you already have **Rick Explains.app** on the Desktop, double-click it. Node, Ollama (`qwen2.5:7b`), and Kokoro are bundled inside the `.app`. Unsigned build: right-click → **Open** the first time. Details: [APP.md](APP.md).

## Run from source (no API keys)

Requires Node 22.9+ (`brew install node`) and [Ollama](https://ollama.com/download) for the script writer when not using the packaged app.

```bash
# 1. a local model for writing scripts (about 5 GB, one time)
ollama pull qwen2.5:7b         # or llama3.1:8b on 16 GB Macs; llama3.2:3b on 8 GB

# 2. the app
git clone https://github.com/RichardGarza/rick-explains
cd rick-explains && npm install
npm start                      # http://localhost:3000
```

With no keys set, the server uses:

- **Ollama** for the script (`OLLAMA_MODEL` overrides auto-pick).
- **Kokoro** for voice on the CPU. From source, the first start may download ~90 MB unless you ran `npm run bundle:vendor`. Defaults: `KOKORO_VOICE=am_fenrir`, `KOKORO_SPEED=1.15`.

Rough timing on Apple Silicon: 30–90s for the script, voice faster than real time, then video renders in real time. Edit the script before rendering.

Long articles: the local model reads the first 40,000 characters; the UI notes when that happens.

## Optional paid upgrades

Any key you set takes over from the free option automatically. Copy `.env.example` to `.env` and fill in what you want.

| Env var | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Claude writes the scripts instead of the local model. Sharper and funnier. `CLAUDE_MODEL` defaults to `claude-opus-5`. |
| `ELEVENLABS_API_KEY` | Best voice quality. Set `ELEVENLABS_VOICE_ID` to pick or design a voice. |
| `OPENAI_API_KEY` | `gpt-4o-mini-tts` with a gravelly-scientist style prompt. |
| `OLLAMA_URL` | Where Ollama runs, if not `http://127.0.0.1:11434`. |

With no keys and no Ollama, the app runs in **demo mode** with a built-in sample script, so you can still try the renderer.

**About the voice:** Rick is meant to have the *vibe* of a cranky cartoon genius. Don't clone a real actor's voice.

## Project layout

```
server.js               Express: /api/config, /api/extract, /api/script, /api/tts
script.js               JSON schema, Rick's system prompt, demo script
electron/main.js        Packaged app: Electron-as-Node + bundled Ollama
scripts/bundle-vendor.sh  Prep vendor/ for packaging (not committed)
public/index.html       Paste → edit script → render → download
public/app.js           UI flow
public/renderer.js      Canvas scene, character, captions, burp synth, recording
```

## Customizing

- **Rick's personality:** edit `SYSTEM_PROMPT` in `script.js`.
- **New card types:** add the kind to the schema enum in `script.js`, then add a `case` in `drawBeat()` in `renderer.js`.
- **Look:** change the colours in the `C` object at the top of `renderer.js`. The character is drawn in `drawRick()`.
- **Pacing:** `WORDS_PER_SEC`, `GAP` and `TAIL` in `renderer.js`, and the length picker in the UI.

## Known limits

- Local models sometimes write a flat joke or a slightly off headline. Edit before rendering.
- Paywalled pages and JavaScript-only pages often can't be extracted. Some sites block bots too. For those, paste the text instead.
- Articles over about 400K characters are rejected rather than silently truncated.
- The MP4/WebM format depends on what the browser's `MediaRecorder` supports.

## Mac app (Electron)

Self-contained `.app` — see [APP.md](APP.md). Rebuild (Node 22+, local Ollama model, ~5GB+ output):

```bash
npm run bundle:vendor     # copy ollama + qwen models + Kokoro into vendor/ (gitignored)
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
# → dist/mac-arm64/Rick Explains.app
npm run electron          # dev window using vendor/ when present
```

## Ideas / roadmap

- Server-side rendering (headless Chromium or Remotion) so rendering doesn't need an open tab and can run as a batch job.
- A "today's AI news" mode that pulls a few RSS feeds and makes one video per story.
- Word-level timestamps from the TTS provider for exact caption sync.
- Pulling images and logos from the article onto the cards.
