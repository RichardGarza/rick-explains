import { prepare, render } from "./renderer.js";

const $ = (id) => document.getElementById(id);
let config = { claude: false, tts: null };
let script = null;
let mode = "url";
let lastUrl = null;

async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function msg(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
}

// ---- setup ----

config = await fetch("/api/config").then((r) => r.json()).catch(() => config);
const bits = [];
if (!config.claude) bits.push("Demo mode: no ANTHROPIC_API_KEY, so you'll get a sample script.");
if (!config.tts) bits.push("No voice key set: videos render with captions only.");
$("status-line").textContent = bits.join(" ");
$("voice").checked = Boolean(config.tts);
$("voice").disabled = !config.tts;

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    mode = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("url").hidden = mode !== "url";
    $("text").hidden = mode !== "text";
  });
}

// ---- step 1: article -> script ----

$("go").addEventListener("click", async () => {
  $("go").disabled = true;
  try {
    msg("input-msg", mode === "url" ? "Reading the article…" : "Reading…");
    const article = await api("/api/extract", mode === "url" ? { url: $("url").value.trim() } : { text: $("text").value });
    msg("input-msg", `Got ${article.text.split(/\s+/).length.toLocaleString()} words${article.title ? ` from “${article.title}”` : ""}. Rick is writing…`);
    script = await api("/api/script", { ...article, seconds: Number($("seconds").value) });
    msg("input-msg", script.demo ? "Demo script loaded (set ANTHROPIC_API_KEY for real ones)." : "Script ready.");
    showScript();
  } catch (err) {
    msg("input-msg", err.message, true);
  } finally {
    $("go").disabled = false;
  }
});

// ---- step 2: editable script ----

function field(beat, key, labelText, { area = false } = {}) {
  const wrap = document.createElement("label");
  wrap.textContent = labelText;
  const el = document.createElement(area ? "textarea" : "input");
  if (area) el.rows = 3;
  el.value = Array.isArray(beat[key]) ? beat[key].join(" | ") : beat[key] ?? "";
  el.addEventListener("input", () => {
    beat[key] = key === "bullets" ? el.value.split("|").map((s) => s.trim()).filter(Boolean)
      : key === "score" ? Number(el.value) || 0
      : el.value;
  });
  wrap.append(el);
  return wrap;
}

function showScript() {
  $("step-script").hidden = false;
  $("title").value = script.title;
  $("title").oninput = () => (script.title = $("title").value);
  const list = $("beats");
  list.replaceChildren();
  script.beats.forEach((b, i) => {
    const box = document.createElement("div");
    box.className = "beat";
    const kind = document.createElement("div");
    kind.className = "kind";
    kind.textContent = `${i + 1}. ${b.kind}${b.burp ? " · burp" : ""}`;
    box.append(kind, field(b, "narration", "Narration", { area: true }));
    const grid = document.createElement("div");
    grid.className = "grid2";
    grid.append(field(b, "headline", "Headline"));
    if (b.kind === "translate") grid.append(field(b, "quote", "They said"), field(b, "meaning", "Translation"));
    if (b.kind === "stat") grid.append(field(b, "stat", "Number"));
    if (b.kind === "list") grid.append(field(b, "bullets", "Bullets (split with |)"));
    if (b.kind === "verdict") grid.append(field(b, "score", "Score 0–10"));
    if (b.kind === "hook" || b.kind === "point") grid.append(field(b, "emoji", "Emoji"));
    box.append(grid);
    list.append(box);
  });
  $("step-script").scrollIntoView({ behavior: "smooth" });
}

// ---- step 3: render ----

async function doRender() {
  $("render").disabled = $("again").disabled = true;
  $("step-render").hidden = false;
  $("result").hidden = true;
  $("canvas").hidden = false;
  $("download").hidden = true;
  $("progress").value = 0;
  $("step-render").scrollIntoView({ behavior: "smooth" });

  const ctx = new AudioContext();
  try {
    await document.fonts.load(`80px Anton`).catch(() => {});
    const plan = await prepare(script, { ctx, useVoice: $("voice").checked, onProgress: (t) => msg("script-msg", t) });
    msg("script-msg", "Rendering… keep this tab in front.");
    const blob = await render(plan, {
      canvas: $("canvas"),
      ctx,
      monitor: $("monitor").checked,
      onProgress: (p) => ($("progress").value = p),
    });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    $("result").src = lastUrl;
    $("result").hidden = false;
    $("canvas").hidden = true;
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    $("download").href = lastUrl;
    $("download").download = `rick-explains-${slug(script.title)}.${ext}`;
    $("download").textContent = `Download .${ext}`;
    $("download").hidden = false;
    msg("script-msg", `Done: ${(blob.size / 1e6).toFixed(1)} MB ${ext.toUpperCase()}.`);
  } catch (err) {
    msg("script-msg", err.message, true);
  } finally {
    ctx.close();
    $("render").disabled = $("again").disabled = false;
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "video";

$("render").addEventListener("click", doRender);
$("again").addEventListener("click", doRender);
