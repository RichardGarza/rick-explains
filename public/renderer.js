// Draws a "Rick Explains" script onto a 1080x1920 canvas in real time and
// records canvas + audio with MediaRecorder. Everything is procedural: no assets.

export const W = 1080;
export const H = 1920;
const FPS = 30;
const WORDS_PER_SEC = 2.5; // pacing used when there's no TTS audio
const GAP = 0.35; // silence between beats
const BURP_LEN = 0.75;
const TAIL = 1.0;

const C = {
  bg0: "#07130d", bg1: "#0d2a1c", grid: "rgba(80,255,150,0.07)",
  slime: "#5dff9a", slimeDim: "#2c8a55", ink: "#f4f7f2", muted: "#9fb3a6",
  card: "rgba(8,20,14,0.82)", cardEdge: "rgba(93,255,154,0.35)",
  said: "#2a2f2c", warn: "#ffd23f", hot: "#ff5a5f",
  skin: "#e9cfb0", skinShade: "#cfae8c", hair: "#e6edf1", hairShade: "#b7c3ca",
  coat: "#f1f3f0", coatShade: "#c9d0cb", shirt: "#1d3b4a", brass: "#c79a3b", lens: "#7fe3ff",
};
const HEAD_FONT = `"Anton", "Impact", "Arial Narrow", sans-serif`;
const BODY_FONT = `"Inter", "Segoe UI", system-ui, sans-serif`;

// ---------- audio ----------

async function fetchSpeech(ctx, text, voice) {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `TTS HTTP ${r.status}`);
  return ctx.decodeAudioData(await r.arrayBuffer());
}

// A cartoon burp: low buzzy tone with a wobbling pitch, filtered noise on top.
function scheduleBurp(ctx, out, t) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(95, t);
  osc.frequency.linearRampToValueAtTime(70, t + 0.25);
  osc.frequency.linearRampToValueAtTime(82, t + 0.45);
  osc.frequency.linearRampToValueAtTime(58, t + BURP_LEN);

  const wobble = ctx.createOscillator();
  wobble.frequency.value = 22;
  const wobbleGain = ctx.createGain();
  wobbleGain.gain.value = 0.35;
  wobble.connect(wobbleGain);

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 650;
  lp.Q.value = 6;

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(0.55, t + 0.05);
  amp.gain.setValueAtTime(0.5, t + BURP_LEN - 0.2);
  amp.gain.linearRampToValueAtTime(0, t + BURP_LEN);
  wobbleGain.connect(amp.gain);

  const noise = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * BURP_LEN), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.25;
  noise.buffer = buf;

  osc.connect(lp);
  noise.connect(lp);
  lp.connect(amp).connect(out);
  for (const n of [osc, wobble, noise]) {
    n.start(t);
    n.stop(t + BURP_LEN);
  }
}

// ---------- timeline ----------

function wordTimings(text, start, dur) {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => w.length + 2 + (/[.,!?;:]$/.test(w) ? 3 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return words.map((w, i) => {
    const len = (weights[i] / total) * dur;
    const out = { w, t0: t, t1: t + len };
    t += len;
    return out;
  });
}

function chunkWords(words, max = 4) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= max || /[.!?,;:]$/.test(w.w)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((ws) => ({ words: ws, t0: ws[0].t0, t1: ws[ws.length - 1].t1 }));
}

/** Builds timing for every beat. Fetches TTS audio when useVoice is true. */
export async function prepare(script, { ctx, useVoice, voice, onProgress }) {
  const beats = [];
  let t = 0.3;
  for (let i = 0; i < script.beats.length; i++) {
    onProgress?.(`Recording voice ${i + 1}/${script.beats.length}…`);
    const b = script.beats[i];
    const audio = useVoice ? await fetchSpeech(ctx, b.narration, voice) : null;
    const start = t;
    const burpAt = b.burp ? t : null;
    if (b.burp) t += BURP_LEN;
    const speechStart = t;
    const words = b.narration.split(/\s+/).filter(Boolean).length;
    const speechDur = audio ? audio.duration : words / WORDS_PER_SEC + 0.3;
    t += speechDur + GAP;
    const timings = wordTimings(b.narration, speechStart, speechDur);
    beats.push({ ...b, audio, start, end: t, burpAt, speechStart, speechDur, chunks: chunkWords(timings) });
  }
  return { title: script.title, beats, duration: t + TAIL };
}

// ---------- drawing helpers ----------

const ease = (x) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);
const pop = (x) => {
  x = Math.min(Math.max(x, 0), 1);
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function wrap(g, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws wrapped text, shrinking the font until it fits maxLines. Returns height used. */
function fitText(g, text, { x, y, maxW, size, minSize = 28, maxLines = 3, font = HEAD_FONT, color = C.ink, align = "center", lh = 1.12, upper = false }) {
  if (!text) return 0;
  const s = upper ? String(text).toUpperCase() : String(text);
  let lines;
  for (;;) {
    g.font = `${size}px ${font}`;
    lines = wrap(g, s, maxW);
    if (lines.length <= maxLines || size <= minSize) break;
    size -= 4;
  }
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = "top";
  lines.forEach((l, i) => g.fillText(l, x, y + i * size * lh));
  return lines.length * size * lh;
}

function card(g, x, y, w, h, { fill = C.card, edge = C.cardEdge } = {}) {
  g.save();
  g.shadowColor = "rgba(0,0,0,0.5)";
  g.shadowBlur = 30;
  roundRect(g, x, y, w, h, 36);
  g.fillStyle = fill;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 4;
  g.strokeStyle = edge;
  g.stroke();
  g.restore();
}

function label(g, text, x, y, bg, fg = "#07130d") {
  g.font = `bold 34px ${BODY_FONT}`;
  const w = g.measureText(text).width + 40;
  roundRect(g, x, y, w, 56, 14);
  g.fillStyle = bg;
  g.fill();
  g.fillStyle = fg;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(text, x + 20, y + 29);
}

// ---------- scene ----------

function drawBackground(g, t) {
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, C.bg1);
  grad.addColorStop(1, C.bg0);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  g.strokeStyle = C.grid;
  g.lineWidth = 2;
  const off = (t * 30) % 90;
  for (let x = -90 + off; x < W; x += 90) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let y = off; y < H; y += 90) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }

  // bubbles drifting up
  for (let i = 0; i < 18; i++) {
    const seed = i * 97.13;
    const x = (seed * 7.1) % W;
    const speed = 40 + (seed % 60);
    const y = H - ((t * speed + seed * 13) % (H + 100));
    const r = 6 + (seed % 14);
    g.beginPath();
    g.arc(x + Math.sin(t * 1.5 + i) * 14, y, r, 0, Math.PI * 2);
    g.fillStyle = "rgba(93,255,154,0.08)";
    g.fill();
  }

  // glow behind Rick
  const glow = g.createRadialGradient(W / 2, 1650, 50, W / 2, 1650, 650);
  glow.addColorStop(0, "rgba(93,255,154,0.28)");
  glow.addColorStop(1, "rgba(93,255,154,0)");
  g.fillStyle = glow;
  g.fillRect(0, 900, W, H - 900);
}

function drawHeader(g, title, progress) {
  label(g, "RICK EXPLAINS", 60, 70, C.slime);
  fitText(g, title, { x: 60, y: 150, maxW: W - 120, size: 58, minSize: 36, maxLines: 2, align: "left", color: C.ink, upper: true });
  roundRect(g, 60, 290, W - 120, 10, 5);
  g.fillStyle = "rgba(255,255,255,0.12)";
  g.fill();
  roundRect(g, 60, 290, (W - 120) * Math.min(progress, 1), 10, 5);
  g.fillStyle = C.slime;
  g.fill();
}

function drawBeat(g, b, t) {
  const age = t - b.start;
  const p = (t - b.speechStart) / Math.max(b.speechDur, 0.01); // 0..1 through the narration
  const inP = pop(age / 0.45);
  const x = 60, y = 350, w = W - 120, h = 640;

  g.save();
  g.translate(W / 2, y + h / 2);
  g.scale(0.85 + 0.15 * inP, 0.85 + 0.15 * inP);
  g.globalAlpha = ease(age / 0.25);
  g.translate(-W / 2, -(y + h / 2));

  switch (b.kind) {
    case "translate": {
      card(g, x, y, w, 290, { fill: "rgba(40,44,42,0.9)", edge: "rgba(255,255,255,0.15)" });
      label(g, "THEY SAID", x + 36, y + 30, "#c8cfca");
      fitText(g, `“${b.quote}”`, { x: x + 40, y: y + 110, maxW: w - 80, size: 44, minSize: 28, maxLines: 3, font: `italic ${BODY_FONT}`, align: "left", color: "#d6dbd7" });
      if (p > 0.35) {
        const s = ease((p - 0.35) / 0.15);
        g.strokeStyle = C.hot;
        g.lineWidth = 8;
        g.beginPath();
        g.moveTo(x + 30, y + 260);
        g.lineTo(x + 30 + (w - 60) * s, y + 60);
        g.stroke();
      }
      if (p > 0.4) {
        const a = pop((p - 0.4) / 0.12);
        g.save();
        g.translate(W / 2, y + 480);
        g.scale(a, a);
        g.translate(-W / 2, -(y + 480));
        card(g, x, y + 320, w, 320, { fill: "rgba(12,48,30,0.95)", edge: C.slime });
        label(g, "TRANSLATION", x + 36, y + 350, C.slime);
        fitText(g, b.meaning, { x: x + 40, y: y + 430, maxW: w - 80, size: 64, minSize: 34, maxLines: 3, align: "left", color: C.ink });
        g.restore();
      }
      break;
    }
    case "stat": {
      card(g, x, y, w, h);
      const s = pop(age / 0.6);
      g.save();
      g.translate(W / 2, y + 260);
      g.scale(s, s);
      fitText(g, b.stat, { x: 0, y: -150, maxW: w - 80, size: 260, minSize: 120, maxLines: 1, color: C.slime });
      g.restore();
      fitText(g, b.headline, { x: W / 2, y: y + 440, maxW: w - 100, size: 64, minSize: 36, maxLines: 2, upper: true });
      break;
    }
    case "list": {
      card(g, x, y, w, h);
      fitText(g, b.headline, { x: x + 50, y: y + 40, maxW: w - 100, size: 64, minSize: 40, maxLines: 2, align: "left", upper: true, color: C.slime });
      const items = (b.bullets || []).slice(0, 3);
      items.forEach((item, i) => {
        const appear = 0.1 + (i / items.length) * 0.7;
        if (p < appear) return;
        const a = ease((p - appear) / 0.08);
        const iy = y + 210 + i * 140;
        g.globalAlpha = a;
        g.fillStyle = C.slime;
        g.beginPath();
        g.arc(x + 80 - (1 - a) * 40, iy + 40, 18, 0, Math.PI * 2);
        g.fill();
        fitText(g, item, { x: x + 130 - (1 - a) * 40, y: iy, maxW: w - 190, size: 60, minSize: 34, maxLines: 1, align: "left", font: `bold ${BODY_FONT}` });
        g.globalAlpha = 1;
      });
      break;
    }
    case "verdict": {
      card(g, x, y, w, h, { edge: C.warn });
      label(g, "VERDICT", x + 36, y + 36, C.warn);
      fitText(g, b.headline, { x: W / 2, y: y + 130, maxW: w - 100, size: 72, minSize: 40, maxLines: 2, upper: true });
      const score = Math.max(0, Math.min(10, Number(b.score) || 0));
      const fill = ease(p / 0.6) * (score / 10);
      const bx = x + 60, by = y + 390, bw = w - 120, bh = 70;
      roundRect(g, bx, by, bw, bh, 35);
      g.fillStyle = "rgba(255,255,255,0.1)";
      g.fill();
      roundRect(g, bx, by, Math.max(bh, bw * fill), bh, 35);
      g.fillStyle = score >= 7 ? C.slime : score >= 4 ? C.warn : C.hot;
      g.fill();
      fitText(g, `${Math.round(fill * 10)}/10 WORTH CARING`, { x: W / 2, y: by + 100, maxW: bw, size: 54, maxLines: 1, color: C.ink });
      break;
    }
    default: {
      // hook + point
      card(g, x, y, w, h, b.kind === "hook" ? { edge: C.slime } : {});
      if (b.kind === "hook") label(g, "TODAY'S NONSENSE", x + 36, y + 36, C.slime);
      g.font = `200px ${BODY_FONT}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.save();
      g.translate(W / 2, y + 250);
      g.rotate(Math.sin(t * 3) * 0.08);
      g.fillText(b.emoji || "🧪", 0, 0);
      g.restore();
      fitText(g, b.headline, { x: W / 2, y: y + 390, maxW: w - 100, size: 84, minSize: 42, maxLines: 2, upper: true });
    }
  }
  g.restore();
}

function drawBurp(g, b, t) {
  if (b.burpAt == null) return;
  const k = (t - b.burpAt) / BURP_LEN;
  if (k < 0 || k > 1.2) return;
  g.save();
  g.globalAlpha = k > 1 ? 1 - (k - 1) / 0.2 : 1;
  g.translate(W / 2 + Math.sin(t * 90) * 10, 1230 + Math.cos(t * 70) * 6);
  g.rotate(-0.12);
  const s = pop(k / 0.35);
  g.scale(s, s);
  g.font = `130px ${HEAD_FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 14;
  g.strokeStyle = "#07130d";
  g.strokeText("*BURRRP*", 0, 0);
  g.fillStyle = C.warn;
  g.fillText("*BURRRP*", 0, 0);
  g.restore();
}

function drawCaptions(g, b, t) {
  const chunk = b.chunks.find((c) => t >= c.t0 - 0.05 && t < c.t1 + 0.15) ||
    (t >= b.speechStart && t < b.end ? b.chunks.findLast((c) => c.t0 <= t) : null);
  if (!chunk) return;
  const size = 78;
  g.font = `${size}px ${HEAD_FONT}`;
  const words = chunk.words.map((w) => ({ ...w, text: w.w.toUpperCase() }));
  const space = g.measureText(" ").width;
  // lay out on up to 2 lines
  const lines = [[]];
  let lw = 0;
  for (const w of words) {
    const ww = g.measureText(w.text).width;
    if (lw + ww > W - 140 && lines[lines.length - 1].length) {
      lines.push([]);
      lw = 0;
    }
    lines[lines.length - 1].push({ ...w, width: ww });
    lw += ww + space;
  }
  const baseY = 1060;
  g.textBaseline = "top";
  g.textAlign = "left";
  lines.forEach((line, li) => {
    const total = line.reduce((a, w) => a + w.width, 0) + space * (line.length - 1);
    let cx = (W - total) / 2;
    for (const w of line) {
      const active = t >= w.t0 && t < w.t1;
      const y = baseY + li * size * 1.1 - (active ? 6 : 0);
      g.lineWidth = 12;
      g.lineJoin = "round";
      g.strokeStyle = "#041008";
      g.strokeText(w.text, cx, y);
      g.fillStyle = active ? C.warn : C.ink;
      g.fillText(w.text, cx, y);
      cx += w.width + space;
    }
  });
}

// Original character: wild white hair, brass goggles on forehead, stubble, lab coat.
function drawRick(g, t, { talk, mood }) {
  const cx = W / 2;
  const bob = Math.sin(t * 2.2) * 6 + talk * 10;
  const tilt = Math.sin(t * 0.9) * 0.04 + (mood === "skeptic" ? -0.06 : 0);
  const headY = 1560 + bob;

  // body / lab coat
  g.save();
  g.fillStyle = C.coat;
  g.beginPath();
  g.moveTo(cx - 420, H);
  g.quadraticCurveTo(cx - 400, 1760, cx - 170, 1740);
  g.lineTo(cx + 170, 1740);
  g.quadraticCurveTo(cx + 400, 1760, cx + 420, H);
  g.fill();
  g.fillStyle = C.shirt;
  g.beginPath();
  g.moveTo(cx - 120, 1740);
  g.lineTo(cx + 120, 1740);
  g.lineTo(cx + 60, H);
  g.lineTo(cx - 60, H);
  g.fill();
  g.fillStyle = C.coatShade;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + s * 120, 1740);
    g.lineTo(cx + s * 60, H);
    g.lineTo(cx + s * 150, H);
    g.lineTo(cx + s * 200, 1800);
    g.fill();
  }
  // pocket + pens
  g.fillStyle = "#ffffff";
  g.fillRect(cx + 200, 1830, 110, 90);
  g.fillStyle = C.hot; g.fillRect(cx + 220, 1800, 12, 50);
  g.fillStyle = C.slime; g.fillRect(cx + 245, 1795, 12, 55);
  g.restore();

  g.save();
  g.translate(cx, headY);
  g.rotate(tilt);

  // neck
  g.fillStyle = C.skinShade;
  g.fillRect(-60, 120, 120, 90);

  // hair (behind head): two layers of radial spikes, closed through the skull centre
  const hair = (color, base, long, short, wobAmt, phase) => {
    const spikes = 16;
    const a0 = Math.PI * 0.88, a1 = Math.PI * 2.12;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, -40);
    for (let i = 0; i <= spikes; i++) {
      const a = a0 + (i / spikes) * (a1 - a0);
      const valley = a - (a1 - a0) / spikes / 2;
      const tip = base + (i % 2 ? long : short) + Math.sin(t * 3 + i * phase) * wobAmt;
      if (i > 0) g.lineTo(Math.cos(valley) * 175, Math.sin(valley) * 175 - 50);
      g.lineTo(Math.cos(a) * tip * 1.12, Math.sin(a) * tip - 50);
    }
    g.closePath();
    g.fill();
  };
  hair(C.hairShade, 250, 90, 20, 8, 1);
  hair(C.hair, 220, 60, 10, 6, 1.7);

  // ears
  g.fillStyle = C.skinShade;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(s * 185, 10, 34, 50, 0, 0, Math.PI * 2);
    g.fill();
  }

  // head
  g.fillStyle = C.skin;
  g.beginPath();
  g.ellipse(0, 0, 180, 215, 0, 0, Math.PI * 2);
  g.fill();

  // stubble
  g.fillStyle = "rgba(90,80,70,0.35)";
  for (let i = 0; i < 70; i++) {
    const a = (i * 2.399) % (Math.PI * 2);
    const r = 60 + ((i * 37) % 90);
    const sx = Math.cos(a) * r * 1.1;
    const sy = 110 + Math.abs(Math.sin(a)) * 80 - 30;
    if (Math.abs(sx) < 150) g.fillRect(sx, sy, 4, 4);
  }

  // goggles on forehead
  g.strokeStyle = "#3b2f1d";
  g.lineWidth = 16;
  g.beginPath();
  g.moveTo(-178, -125);
  g.quadraticCurveTo(0, -150, 178, -125);
  g.stroke();
  for (const s of [-1, 1]) {
    g.fillStyle = C.brass;
    g.beginPath();
    g.arc(s * 70, -140, 58, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.lens;
    g.beginPath();
    g.arc(s * 70, -140, 40, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.beginPath();
    g.arc(s * 70 - 14, -154, 10, 0, Math.PI * 2);
    g.fill();
  }

  // eyes (blink + glance)
  const blink = (t % 3.7) < 0.12 ? 0.1 : 1;
  const squint = mood === "verdict" ? 0.65 : 1;
  const look = Math.sin(t * 0.7) * 10;
  for (const s of [-1, 1]) {
    g.fillStyle = "#fff";
    g.beginPath();
    g.ellipse(s * 70, -30, 40, 34 * blink * squint, 0, 0, Math.PI * 2);
    g.fill();
    if (blink > 0.5) {
      g.fillStyle = "#1b1b1b";
      g.beginPath();
      g.arc(s * 70 + look, -28, 10, 0, Math.PI * 2);
      g.fill();
    }
    // bags
    g.strokeStyle = "rgba(120,90,70,0.5)";
    g.lineWidth = 4;
    g.beginPath();
    g.arc(s * 70, -18, 42, 0.2 * Math.PI, 0.8 * Math.PI);
    g.stroke();
  }

  // eyebrows: separate, bushy, expressive
  const raise = mood === "skeptic" ? 1 : talk * 0.6;
  g.strokeStyle = C.hair;
  g.lineWidth = 22;
  g.lineCap = "round";
  for (const s of [-1, 1]) {
    const lift = s === 1 ? raise * 26 : raise * 6;
    g.beginPath();
    g.moveTo(s * 30, -78 - lift * 0.4);
    g.lineTo(s * 112, -88 - lift);
    g.stroke();
  }

  // nose
  g.fillStyle = C.skinShade;
  g.beginPath();
  g.moveTo(0, -20);
  g.quadraticCurveTo(26, 40, 8, 58);
  g.quadraticCurveTo(-10, 62, -14, 50);
  g.fill();

  // mouth: opens with speech volume, slightly crooked
  const open = 6 + talk * 60;
  g.save();
  g.translate(10, 120);
  g.rotate(-0.06);
  g.fillStyle = "#3a1414";
  g.beginPath();
  g.ellipse(0, 0, 70 + talk * 10, open / 2, 0, 0, Math.PI * 2);
  g.fill();
  if (talk > 0.15) {
    g.fillStyle = "#f5f1e6";
    g.fillRect(-45, -open / 2, 90, Math.min(14, open / 3));
  }
  g.strokeStyle = "#7b4a3a";
  g.lineWidth = 5;
  g.beginPath();
  g.ellipse(0, 0, 70 + talk * 10, open / 2, 0, 0, Math.PI * 2);
  g.stroke();
  g.restore();

  g.restore();
}

// ---------- main render ----------

/**
 * Plays the prepared timeline onto `canvas`. When `record` is true, returns a Blob of the video.
 */
export async function render(plan, { canvas, ctx, record = true, monitor = true, onProgress }) {
  const g = canvas.getContext("2d");
  canvas.width = W;
  canvas.height = H;

  const out = ctx.createGain(); // everything that goes into the video
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const recDest = ctx.createMediaStreamDestination();
  out.connect(recDest);
  if (monitor) out.connect(ctx.destination);

  const voiceBus = ctx.createGain();
  voiceBus.connect(out);
  voiceBus.connect(analyser);

  await ctx.resume();
  const t0 = ctx.currentTime + 0.25;
  const sources = [];
  for (const b of plan.beats) {
    if (b.audio) {
      const src = ctx.createBufferSource();
      src.buffer = b.audio;
      src.connect(voiceBus);
      src.start(t0 + b.speechStart);
      sources.push(src);
    }
    if (b.burpAt != null) scheduleBurp(ctx, voiceBus, t0 + b.burpAt);
  }

  let recorder, chunks = [], mime = "";
  if (record) {
    const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...recDest.stream.getAudioTracks()]);
    mime = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
      .find((m) => MediaRecorder.isTypeSupported(m)) || "";
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start(1000);
  }

  const buf = new Float32Array(analyser.fftSize);
  let talk = 0;

  await new Promise((resolve) => {
    const frame = () => {
      const t = ctx.currentTime - t0;
      analyser.getFloatTimeDomainData(buf);
      let rms = 0;
      for (const v of buf) rms += v * v;
      rms = Math.sqrt(rms / buf.length);
      let target = Math.min(1, rms * 6);
      const beat = plan.beats.find((b) => t >= b.start && t < b.end) || (t < 0 ? plan.beats[0] : plan.beats.at(-1));
      // no voice audio: fake lip-flap while captions run
      if (!beat.audio && t >= beat.speechStart && t < beat.speechStart + beat.speechDur) {
        target = 0.35 + 0.35 * Math.abs(Math.sin(t * 17)) * Math.abs(Math.sin(t * 5.3));
      }
      talk += (target - talk) * 0.45;

      drawBackground(g, t);
      drawHeader(g, plan.title, t / plan.duration);
      drawBeat(g, beat, t);
      drawRick(g, t, { talk, mood: beat.kind === "translate" ? "skeptic" : beat.kind === "verdict" ? "verdict" : "" });
      drawCaptions(g, beat, t);
      drawBurp(g, beat, t);

      onProgress?.(Math.min(Math.max(t / plan.duration, 0), 1));
      if (t < plan.duration) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });

  sources.forEach((s) => s.disconnect());
  out.disconnect();
  if (!record) return null;
  await new Promise((r) => {
    recorder.onstop = r;
    recorder.stop();
  });
  return new Blob(chunks, { type: mime.split(";")[0] || "video/webm" });
}
