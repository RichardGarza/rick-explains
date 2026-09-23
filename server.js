import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { fetch as undiciFetch, EnvHttpProxyAgent } from "undici";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SCHEMA, SYSTEM_PROMPT, DEMO_SCRIPT } from "./script.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Local Kokoro ONNX dir (bundled) when present; else Hub id. */
function resolveKokoroModelId() {
  const candidates = [
    process.env.KOKORO_MODEL_PATH,
    join(__dirname, "vendor", "kokoro-model"),
    join(__dirname, "..", "kokoro-model"),
    join(__dirname, "kokoro-model"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(join(p, "config.json")) && existsSync(join(p, "onnx", "model_quantized.onnx"))) {
      return p;
    }
  }
  return "onnx-community/Kokoro-82M-v1.0-ONNX";
}

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const MAX_ARTICLE_CHARS = 400_000; // ~100K tokens; refuse (don't truncate) anything bigger

// Script writer: Claude if there's a key, otherwise a local model through Ollama.
const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const claude = hasClaude ? new Anthropic() : null;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
// Local models get slower and dumber with long inputs, so they read the start of a long article.
const LOCAL_MAX_CHARS = 40_000;
// Small local models in rough order of how well they do at this job.
const OLLAMA_PREFERRED = ["llama3.1", "qwen2.5", "gemma3", "mistral", "llama3.2", "phi4"];

// Voice: a paid API if there's a key, otherwise Kokoro running locally in this process.
const tts = process.env.ELEVENLABS_API_KEY ? "elevenlabs" : process.env.OPENAI_API_KEY ? "openai" : "kokoro";
const KOKORO_VOICE = process.env.KOKORO_VOICE || "am_fenrir";
const KOKORO_SPEED = Number(process.env.KOKORO_SPEED) || 1.15;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

async function ollamaStatus() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { reachable: false, models: [] };
    const models = ((await r.json()).models ?? []).map((m) => m.name);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

function pickOllamaModel(models) {
  if (process.env.OLLAMA_MODEL) return process.env.OLLAMA_MODEL;
  for (const pref of OLLAMA_PREFERRED) {
    const hit = models.find((m) => m.startsWith(pref));
    if (hit) return hit;
  }
  return models[0] ?? null;
}

app.get("/api/config", async (_req, res) => {
  const ollama = hasClaude ? null : await ollamaStatus();
  const script = hasClaude
    ? { provider: "claude", model: MODEL }
    : ollama.reachable && ollama.models.length
      ? { provider: "ollama", model: pickOllamaModel(ollama.models), models: ollama.models }
      : { provider: "demo", ollamaReachable: ollama.reachable };
  res.json({ script, voice: { provider: tts, voice: tts === "kokoro" ? KOKORO_VOICE : undefined } });
});

app.get("/api/voices", async (_req, res) => {
  if (tts !== "kokoro") return res.json([]);
  try {
    const k = await kokoro();
    res.json(Object.entries(k.voices).map(([id, v]) => ({ id, name: v.name, gender: v.gender, language: v.language })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// jsdom registers undici 8 as the global dispatcher, which Node's bundled fetch
// mishandles (compressed bodies, redirects). Use undici's own fetch for pages.
// EnvHttpProxyAgent honours HTTP(S)_PROXY / NO_PROXY and goes direct otherwise.
const pageAgent = new EnvHttpProxyAgent();
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_HEADERS = {
  "user-agent": BROWSER_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function explainFetchError(err) {
  const cause = err?.cause;
  const detail = cause?.code || cause?.message || err?.message || "network error";
  const msg = String(err?.message || "");
  if (/fetch failed/i.test(msg) || cause) {
    return (
      `Couldn't reach that page (${detail}). ` +
      "Some sites block automated readers — paste the article text instead."
    );
  }
  return msg || "Couldn't fetch that page.";
}

/** Prefer Chromium net.fetch helper (Electron main) — BoringSSL/undici breaks on some CDNs. */
async function fetchPageHtml(targetUrl) {
  const href = String(targetUrl);
  const helper = process.env.ELECTRON_FETCH_HELPER?.replace(/\/$/, "");
  if (helper) {
    try {
      const r = await fetch(`${helper}/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: href }),
        signal: AbortSignal.timeout(45_000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `helper HTTP ${r.status}`);
      return { status: data.status, finalUrl: data.url || href, html: data.html ?? "" };
    } catch (err) {
      console.warn("Chromium fetch helper failed, falling back to undici:", err.message);
    }
  }

  try {
    const r = await undiciFetch(href, {
      dispatcher: pageAgent,
      headers: PAGE_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    const html = await r.text();
    return { status: r.status, finalUrl: String(r.url || href), html };
  } catch (err) {
    throw new Error(explainFetchError(err));
  }
}

// 1. Link or pasted text -> clean article text
app.post("/api/extract", async (req, res) => {
  const { url, text } = req.body ?? {};
  try {
    if (text?.trim()) {
      return res.json({ title: "", source: "", text: text.trim() });
    }
    if (!url) return res.status(400).json({ error: "Paste a link or some text." });
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) links work.");

    const { status, finalUrl, html } = await fetchPageHtml(parsed.href);
    if (!status || status >= 400) {
      throw new Error(
        `That page returned HTTP ${status || "?"}. Some sites block bots; paste the text instead.`
      );
    }
    const base = finalUrl || parsed.href;
    const dom = new JSDOM(html, { url: base });
    const article = new Readability(dom.window.document).parse();
    const body = article?.textContent?.replace(/\n{3,}/g, "\n\n").trim();
    if (!body || body.length < 200) {
      throw new Error("Couldn't pull readable text from that page (paywall or JS-only site?). Paste the text instead.");
    }
    const host = new URL(base).hostname.replace(/^www\./, "");
    res.json({ title: article.title ?? "", source: host, text: body });
  } catch (err) {
    const message = /fetch failed/i.test(String(err?.message || ""))
      ? explainFetchError(err)
      : err.message;
    res.status(400).json({ error: message });
  }
});

// 2. Article -> structured video script
app.post("/api/script", async (req, res) => {
  const { title = "", source = "", text = "", seconds = 60 } = req.body ?? {};
  if (!text.trim()) return res.status(400).json({ error: "No article text." });
  if (text.length > MAX_ARTICLE_CHARS) {
    return res.status(413).json({ error: `Article is ${text.length.toLocaleString()} chars; max is ${MAX_ARTICLE_CHARS.toLocaleString()}. Paste the part you care about.` });
  }
  const userPrompt =
    `Target length: about ${seconds} seconds of narration.\n` +
    `Source: ${source || "pasted text"}\nTitle: ${title || "(none)"}\n\n`;

  if (!claude) {
    const { reachable, models } = await ollamaStatus();
    const model = reachable ? pickOllamaModel(models) : null;
    if (!model) return res.json({ ...DEMO_SCRIPT, demo: true, ollamaReachable: reachable });
    try {
      const script = await ollamaScript(model, userPrompt, text, req.body?.model);
      return res.json(script);
    } catch (err) {
      console.error(err);
      return res.status(502).json({ error: err.message });
    }
  }

  try {
    const response = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: SCRIPT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `${userPrompt}<article>\n${text}\n</article>`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "Claude declined to script this one. Try a different article." });
    }
    if (response.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "Script got cut off. Try a shorter target length." });
    }
    const out = response.content.find((b) => b.type === "text")?.text;
    res.json(JSON.parse(out));
  } catch (err) {
    console.error(err);
    const status = err instanceof Anthropic.APIError ? err.status ?? 502 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Local model through Ollama's chat API. `format` takes a JSON schema and Ollama
// constrains the output to it, so even small models return valid script JSON.
async function ollamaScript(model, userPrompt, text, requestedModel) {
  const useModel = requestedModel || model;
  let note = "";
  if (text.length > LOCAL_MAX_CHARS) {
    text = text.slice(0, LOCAL_MAX_CHARS);
    note = `Long article: the local model only read the first ${LOCAL_MAX_CHARS.toLocaleString()} characters.`;
  }
  // Room for the article plus the answer; a too-small context silently drops the start of the prompt.
  const num_ctx = Math.min(32768, Math.max(8192, Math.ceil(text.length / 3) + 3000));
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: useModel,
      stream: false,
      format: SCRIPT_SCHEMA,
      options: { temperature: 0.8, num_ctx, num_predict: 4000 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${userPrompt}<article>\n${text}\n</article>\n\nRespond with the script as JSON.` },
      ],
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (data.done_reason === "length") throw new Error("The local model ran out of room mid-script. Try a shorter length.");
  let script;
  try {
    script = JSON.parse(data.message?.content ?? "");
  } catch {
    throw new Error("The local model didn't return valid script JSON. Try again or a different model.");
  }
  if (!Array.isArray(script.beats) || !script.beats.length) throw new Error("The local model returned an empty script. Try again.");
  script.beats = script.beats.filter((b) => b?.narration?.trim());
  return { ...script, provider: "ollama", model: useModel, note };
}

// Kokoro: 82M-parameter speech model on CPU. Prefer bundled local weights (offline).
let kokoroPromise = null;
function kokoro() {
  kokoroPromise ??= (async () => {
    const [{ KokoroTTS }, { env }] = await Promise.all([
      import("kokoro-js"),
      import("@huggingface/transformers"),
    ]);
    const modelId = resolveKokoroModelId();
    const local = typeof modelId === "string" && (modelId.startsWith("/") || /^[A-Za-z]:[\\/]/.test(modelId));
    if (local) {
      env.allowLocalModels = true;
      env.useBrowserCache = false;
      // Prefer the given directory; do not hit the network.
      env.allowRemoteModels = false;
    }
    console.log(`  Kokoro loading from ${local ? "local path" : "Hub"}: ${modelId}`);
    return KokoroTTS.from_pretrained(modelId, { dtype: "q8", device: "cpu" });
  })().catch((err) => {
    kokoroPromise = null; // let the next call retry
    throw err;
  });
  return kokoroPromise;
}

// 3. One narration line -> speech audio
app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 2000);
  if (!text.trim()) return res.status(400).json({ error: "No text." });
  try {
    if (tts === "kokoro") {
      const k = await kokoro();
      const voice = req.body?.voice && k.voices[req.body.voice] ? req.body.voice : KOKORO_VOICE;
      const audio = await k.generate(text, { voice, speed: KOKORO_SPEED });
      res.set("content-type", "audio/wav");
      return res.send(Buffer.from(audio.toWav()));
    }
    let r;
    if (tts === "elevenlabs") {
      const voice = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // stock "Adam"; swap for your own voice
      r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
          voice_settings: { stability: 0.3, similarity_boost: 0.75, style: 0.6 },
        }),
      });
    } else {
      r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: process.env.OPENAI_VOICE || "ash",
          input: text,
          instructions:
            "Gravelly, raspy older male scientist. Fast, impatient, sarcastic, a little slurred, like he's " +
            "explaining something obvious to someone slow. Big emphasis on key words. Short dramatic pauses.",
          response_format: "mp3",
        }),
      });
    }
    if (!r.ok) throw new Error(`TTS failed: HTTP ${r.status} ${await r.text()}`);
    res.set("content-type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", async () => {
  console.log(`Rick Explains on http://127.0.0.1:${PORT}`);
  if (hasClaude) console.log(`  script: Claude (${MODEL})`);
  else {
    const { reachable, models } = await ollamaStatus();
    const model = reachable ? pickOllamaModel(models) : null;
    if (model) console.log(`  script: Ollama (${model})`);
    else if (reachable) console.log("  script: DEMO. Ollama is running but has no models: run `ollama pull llama3.1:8b`");
    else console.log(`  script: DEMO. Start Ollama (${OLLAMA_URL}) for local scripts, or set ANTHROPIC_API_KEY`);
  }
  console.log(`  voice:  ${tts === "kokoro" ? `Kokoro, local (${KOKORO_VOICE})` : tts}`);
  if (tts === "kokoro") {
    // Warm up in the background so the first video doesn't wait on the download.
    kokoro().then(() => console.log("  Kokoro ready")).catch((err) => console.error("  Kokoro failed to load:", err.message));
  }
});
