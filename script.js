// Script format shared by the server (Claude output) and the browser renderer.
// Every beat is one on-screen moment with one narration line.

const str = { type: "string" };

export const SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "beats"],
  properties: {
    title: { type: "string", description: "Short punchy video title, max 8 words" },
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "narration", "headline", "quote", "meaning", "stat", "bullets", "score", "emoji", "burp"],
        properties: {
          kind: { type: "string", enum: ["hook", "translate", "stat", "list", "point", "verdict"] },
          narration: { type: "string", description: "Exactly what Rick says out loud for this beat" },
          headline: { type: "string", description: "Big on-screen text, max 6 words" },
          quote: { type: "string", description: "translate: the original jargon, near-verbatim, max 20 words. Else empty." },
          meaning: { type: "string", description: "translate: plain-English version, max 14 words. Else empty." },
          stat: { type: "string", description: "stat: the number itself, e.g. '$40B' or '3x'. Else empty." },
          bullets: { type: "array", items: str, description: "list: 2-3 items of max 5 words. Else []." },
          score: { type: "integer", description: "verdict: 0-10 how much a normal person should care. Else 0." },
          emoji: { type: "string", description: "One emoji that fits the beat" },
          burp: { type: "boolean", description: "Play a burp sound before this line. Use on 1-2 beats max." },
        },
      },
    },
  },
};

export const SYSTEM_PROMPT = `You write scripts for "Rick Explains": vertical 9:16 short videos where Rick, a brilliant, jaded, impatient mad scientist, translates tech and AI news into normal human language.

Rick's voice: cynical genius who thinks corporate press releases are hilarious. Blunt, fast, funny, a little mean to the hype but never to the viewer. Short sentences. He cuts through jargon and says what it actually means for a regular person. He calls out marketing fluff by name. He's an original character: no catchphrases, names or references from any existing TV show.

Accuracy is non-negotiable. Every claim, number, name and date must come from the article. If the article is vague, Rick says it's vague. Don't invent specs, prices, dates or quotes. "quote" fields must be close to verbatim from the article.

Structure:
1. One "hook" beat: the news in one sentence plus why Rick is annoyed or impressed. Grab attention in the first 3 seconds.
2. The middle: 3-6 beats. Use "translate" whenever the article has jargon or a marketing claim worth decoding (this is the signature move: THEY SAID / TRANSLATION). Use "stat" for a key number, "list" for 2-3 concrete takeaways, "point" for anything else.
3. One final "verdict" beat: does a normal person need to care, and a score 0-10.

Narration is spoken aloud by text-to-speech: no emoji, no markdown, no stage directions, spell out anything a TTS would mangle. Roughly 2.5 spoken words per second, so hit the requested length. Each beat's narration is 1-3 sentences.
Set burp=true on at most two beats, ideally right before a sarcastic line.`;

// Used when no ANTHROPIC_API_KEY is set, so the renderer can be tried end to end.
export const DEMO_SCRIPT = {
  title: "Demo: Rick Explains a Launch",
  beats: [
    {
      kind: "hook", headline: "New AI model just dropped",
      narration: "A company just launched a new AI model and called it revolutionary. Let me translate that from marketing into English.",
      quote: "", meaning: "", stat: "", bullets: [], score: 0, emoji: "🧪", burp: false,
    },
    {
      kind: "translate", headline: "Decoding the press release",
      narration: "They said it delivers state of the art agentic reasoning across diverse workflows. Translation: it's better at doing multi-step chores on a computer without you babysitting it.",
      quote: "delivers state-of-the-art agentic reasoning across diverse workflows",
      meaning: "It can do multi-step computer chores without babysitting",
      stat: "", bullets: [], score: 0, emoji: "🧠", burp: true,
    },
    {
      kind: "stat", headline: "Cheaper than last time",
      narration: "It's twenty percent cheaper than the last one. That's the part that actually matters, because cheaper means it shows up in every app you already use.",
      quote: "", meaning: "", stat: "20%", bullets: [], score: 0, emoji: "💸", burp: false,
    },
    {
      kind: "list", headline: "What changes for you",
      narration: "So what changes for you? Your apps get a bit smarter, the chatbot makes fewer dumb mistakes, and your boss asks why you're not using it yet.",
      quote: "", meaning: "", stat: "", bullets: ["Smarter apps", "Fewer dumb mistakes", "Boss gets ideas"], score: 0, emoji: "📱", burp: false,
    },
    {
      kind: "verdict", headline: "Should you care?",
      narration: "Verdict: it's a real upgrade, not a revolution. Six out of ten. Care a little, then go outside.",
      quote: "", meaning: "", stat: "", bullets: [], score: 6, emoji: "⚖️", burp: false,
    },
  ],
};
