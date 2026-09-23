import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { SCRIPT_SCHEMA, SYSTEM_PROMPT, DEMO_SCRIPT } from "./script.js";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const MAX_ARTICLE_CHARS = 400_000; // ~100K tokens; refuse (don't truncate) anything bigger

const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const tts = process.env.ELEVENLABS_API_KEY ? "elevenlabs" : process.env.OPENAI_API_KEY ? "openai" : null;
const claude = hasClaude ? new Anthropic() : null;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

app.get("/api/config", (_req, res) => {
  res.json({ claude: hasClaude, tts, model: MODEL });
});

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

    const r = await fetch(parsed, {
      headers: { "user-agent": "Mozilla/5.0 (RickExplains; +article-reader)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`That page returned HTTP ${r.status}.`);
    const html = await r.text();
    const dom = new JSDOM(html, { url: parsed.href });
    const article = new Readability(dom.window.document).parse();
    const body = article?.textContent?.replace(/\n{3,}/g, "\n\n").trim();
    if (!body || body.length < 200) {
      throw new Error("Couldn't pull readable text from that page (paywall or JS-only site?). Paste the text instead.");
    }
    res.json({ title: article.title ?? "", source: parsed.hostname.replace(/^www\./, ""), text: body });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Article -> structured video script
app.post("/api/script", async (req, res) => {
  const { title = "", source = "", text = "", seconds = 60 } = req.body ?? {};
  if (!text.trim()) return res.status(400).json({ error: "No article text." });
  if (text.length > MAX_ARTICLE_CHARS) {
    return res.status(413).json({ error: `Article is ${text.length.toLocaleString()} chars; max is ${MAX_ARTICLE_CHARS.toLocaleString()}. Paste the part you care about.` });
  }
  if (!claude) return res.json({ ...DEMO_SCRIPT, demo: true });

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
          content:
            `Target length: about ${seconds} seconds of narration.\n` +
            `Source: ${source || "pasted text"}\nTitle: ${title || "(none)"}\n\n` +
            `<article>\n${text}\n</article>`,
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

// 3. One narration line -> speech audio
app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 2000);
  if (!text.trim()) return res.status(400).json({ error: "No text." });
  if (!tts) return res.status(501).json({ error: "No TTS key configured." });

  try {
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

app.listen(PORT, () => {
  console.log(`Rick Explains on http://localhost:${PORT}`);
  console.log(`  script: ${hasClaude ? MODEL : "DEMO (set ANTHROPIC_API_KEY)"}`);
  console.log(`  voice:  ${tts ?? "none — silent captions (set ELEVENLABS_API_KEY or OPENAI_API_KEY)"}`);
});
