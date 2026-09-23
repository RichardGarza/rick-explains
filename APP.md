# Rick Explains — Mac app

Self-contained Electron app. Double-click to run — **no** system Node, **no** separately installed Ollama, **no** Hugging Face download at runtime.

## Open it

- **Desktop:** `~/Desktop/Rick Explains.app`
- **Build output:** `dist/mac-arm64/Rick Explains.app`

Unsigned. First open: right-click → **Open** → Open (Gatekeeper).

First launch can be slow while models mmap into memory.

## What’s bundled

| Piece | Where |
|--------|--------|
| Node runtime | Electron (`ELECTRON_RUN_AS_NODE` runs `server.js`) |
| Ollama + `qwen2.5:7b` | `Contents/Resources/ollama` + `ollama-models` |
| Kokoro TTS (q8 ONNX) | `Contents/Resources/kokoro-model` |

Optional API keys: `Contents/Resources/rick-explains/.env`.

## Rebuild

Needs **Node 22+**, Homebrew Ollama with `qwen2.5:7b`, and once-off Kokoro download:

```bash
cd ~/projects/rick-explains
npm install
npm run bundle:vendor    # copies ~/.ollama models + ollama binary + Kokoro into vendor/
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
# → dist/mac-arm64/Rick Explains.app (~5GB+)
cp -R "dist/mac-arm64/Rick Explains.app" ~/Desktop/
```

`vendor/` is gitignored (multi-GB). Do not commit model blobs or `dist/`.

## Dev

```bash
npm run electron   # uses vendor/ when present; else system Ollama
```

## Troubleshooting

- **"Couldn't reach that page …"** — the site blocked the reader (paywall/bot wall). Use the **Paste text** tab.
- **"Couldn't reach the local Rick Explains server"** — quit the app fully and double-click again so the embedded server can start.
- Article fetching in the Mac app uses Chromium's network stack (not Node's), so CDN-blocked Node fetches still work for most news sites.
