// Co's opening line on a call, written from what it knows about them (Royce,
// 2026-10-04: "the ElevenLabs call sounds scripted; Hume was more proactive and
// picked things up where we left off").
//
// Why it changed: Hume's first message was left empty, so its model wrote the
// opening itself from the member's context ("Last we talked you were gearing
// up for October tenth, how's it all coming together?"). ElevenLabs needs the
// first line before the call connects, and the first version of this chose a
// greeting from a fixed pool ("Hey Royce. Good to hear your voice."), which
// said nothing about them and left the model to open its first real question
// from the prompt's own examples.
//
// Now the line is written by a model while the phone rings (outbound), or
// within a short budget as an inbound call connects, from the same context the
// call gets, and checked in code: it has to be short, use their name, name no
// feeling, carry no cue or placeholder, and every name, place and number in it
// has to be in the context it was written from. Anything that fails, or is late,
// falls back to the pool in elevenLabsCalls.ts (chooseOpening). A first call
// (no context yet) uses the pool: there is nothing to pick up.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { checkNoEmotionLabelOnCall } from "../harness/emotion.js";
import { recordDecision } from "../harness/core.js";
import { MODELS } from "../models.js";
import { stockLine } from "../harness/stockLines.js";
import { cuesIn } from "./voiceCues.js";

export const OPENING_WRITER = {
  minContext: 300,
  maxContext: 8000,
  maxChars: 220,
  maxWords: 40,
  // Outbound: written while it rings. Inbound: a short wait, then the pool.
  outboundModel: MODELS.sonnet,
  inboundModel: MODELS.haiku,
  inboundBudgetMs: 700,
  takeBudgetMs: 800,
  ttlMs: 5 * 60 * 1000,
};

export function openingPrompt(o: { firstName: string; direction: "inbound" | "outbound"; summary: string }): string {
  return `You're writing the first thing Co says when a phone call connects. Co is a calm, warm companion who already knows ${o.firstName || "this person"} and has talked with them before. ${o.direction === "outbound" ? `Co is calling them, so Co says who it is ("it's Co").` : "They called Co."}

What Co knows about them (this is all you may use):
${o.summary.slice(0, OPENING_WRITER.maxContext)}

Write ONE spoken line, two short sentences at most and under 28 words: greet ${o.firstName || "them"} by name, then pick up from ONE specific, real thing in what Co knows (something they were last working on, deciding or waiting on), as a light question or as "last we talked ...". Pick the thing most alive for them right now, not the first thing listed.

Rules:
- Only use facts that are in what Co knows. No times, places, names or numbers that aren't there.
- Never name or guess how they feel or sound.
- The line is heard the moment anyone picks up, maybe not them. Pick up work, plans, projects or logistics only. Never health, loss, family, money trouble, legal matters, relationships, or anything another member of Co said or did.
- No times or dates relative to now (today, tomorrow, this week, a weekday) unless the exact words are in what Co knows.
- No "how are you", no "good to hear your voice", no "I remember", no "I was thinking about you".
- Plain speech: no dashes, brackets, quotes or placeholders.
- If nothing in what Co knows is a safe, good thing to pick up, answer exactly: NONE

Reply with only the line.`;
}

const SENSITIVE = /\b(?:biops\w*|diagnos\w*|cancer|surgery|hospital\w*|chemo\w*|therap\w*|pregnan\w*|miscarr\w*|passed away|funeral|grie\w+|died|death|divorc\w*|breakup|break-up|lawsuit|lawyer|attorney|bankrupt\w*|debt|eviction|rehab|diagnosed|medical|illness)\b/i;
const FEELING_WORD = /\b(?:stress(?:ed)?|overwhelm\w*|anxi\w*|worr(?:y|ied|ies)|nervous|sad|upset|frustrat\w*|exhaust\w*|burn(?:ed|t)? out|lonely|depress\w*|scared|afraid|angry|annoyed|discourag\w*|feeling|feel)\b/i;
const RELATIVE_TIME = /\b(?:today|tonight|tomorrow|yesterday|this (?:week|weekend|morning|afternoon|evening)|next (?:week|weekend|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const STOP_CAPS = new Set(["i", "i'm", "i've", "i'd", "i'll", "co"]);
// Words that start a sentence and are capitalised only for that.
const GREETING_CAPS = new Set(["hey", "hi", "hello", "last", "it's", "so", "any", "how", "did", "is", "was", "are", "were", "what", "where", "when", "which", "who", "has", "have", "had", "do", "does", "still", "been", "and", "but", "or", "i'm", "i've", "i'd", "i'll", "i", "co", "you", "your", "you're", "you've", "that", "the", "a", "an", "we", "we've", "let's", "good", "welcome", "back", "thanks", "thank", "quick", "one", "two", "since"]);

// Pure: why a written line can't be used, or null. `summary` is what it was written from.
export function openingProblems(raw: string, summary: string, firstName: string): string | null {
  const line = raw.trim().replace(/^["“']|["”']$/g, "").trim();
  if (!line) return "empty";
  if (/^none\b/i.test(line)) return "nothing to pick up";
  if (line.length > OPENING_WRITER.maxChars) return "too long";
  if (line.split(/\s+/).length > OPENING_WRITER.maxWords) return "too many words";
  if (/[\[\]{}<>]/.test(line) || cuesIn(line).length) return "brackets or a cue";
  if (/[—–]|--/.test(line)) return "a dash";
  if (/\n/.test(line)) return "more than one line";
  if (firstName && !new RegExp(`\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line)) return "doesn't use their name";
  // The call-strength check: this is spoken, and a hearsay exemption ("I hear X about the plan") has no place in a greeting.
  if (!checkNoEmotionLabelOnCall(line).pass) return "names a feeling";
  if (SENSITIVE.test(line)) return "a sensitive topic";
  if (FEELING_WORD.test(line)) return "names a feeling";
  if (RELATIVE_TIME.test(line) && !RELATIVE_TIME.test(summary)) return "a relative time not in what Co knows";
  if (/\bintro(?:duc\w*)?\b|\bsaid yes\b|\bwants? to meet\b/i.test(line)) return "speaks for another member";
  if (/\bhow are you\b|good to hear your voice|i remember|thinking about you/i.test(line) || stockLine(line)) return "a stock line";
  // Every name, place and number in it has to be in what it was written from.
  const hay = summary.toLowerCase().replace(/’/g, "'");
  for (const sentence of line.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      // "Fund's" is "Fund": a possessive doesn't make a name new.
      const bare = words[i].replace(/[^A-Za-z0-9'’]/g, "").replace(/['’]s$/i, "");
      if (!bare) continue;
      const isNumber = /\d/.test(bare);
      const isName = /^[A-Z]/.test(bare) && !GREETING_CAPS.has(bare.toLowerCase()) && !STOP_CAPS.has(bare.toLowerCase()) && bare.toLowerCase() !== firstName.toLowerCase();
      const needle = bare.toLowerCase().replace(/’/g, "'");
      const present = isNumber ? new RegExp(`(?<![0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(hay) : hay.includes(needle);
      if ((isNumber || isName) && !present) return `not in what Co knows: ${bare}`;
    }
  }
  return null;
}

export function openingVerdict(raw: string, summary: string, firstName: string): { ok: true; line: string } | { ok: false; why: string } {
  const why = openingProblems(raw, summary, firstName);
  return why ? { ok: false, why } : { ok: true, line: raw.trim().replace(/^["“']|["”']$/g, "").trim() };
}

export async function writeOpening(o: { firstName: string; direction: "inbound" | "outbound"; summary: string; timeoutMs?: number }): Promise<{ line: string | null; why?: string }> {
  if (o.summary.trim().length < OPENING_WRITER.minContext) return { line: null, why: "no context yet (a first call)" };
  try {
    const { text } = await generateText({
      model: anthropic(o.direction === "outbound" ? OPENING_WRITER.outboundModel : OPENING_WRITER.inboundModel),
      maxOutputTokens: 120,
      // A one-line writing job: low effort so thinking can't eat the cap (evals/guards).
      // Haiku takes no effort setting (and needs none).
      ...(o.direction === "outbound" ? { providerOptions: { anthropic: { effort: "low" as const } } } : {}),
      abortSignal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      experimental_telemetry: { isEnabled: true, functionId: "call.writeOpening" },
      prompt: openingPrompt(o),
    });
    const v = openingVerdict(text, o.summary, o.firstName);
    return v.ok ? { line: v.line } : { line: null, why: v.why };
  } catch (err: any) {
    return { line: null, why: `write failed: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

// ---------- written while it rings
const pending = new Map<string, { at: number; line: Promise<{ line: string | null; why?: string }> }>();

export function prebuildOpening(userId: string, firstName: string, direction: "inbound" | "outbound", summary: Promise<string>, now = Date.now()): void {
  pending.set(userId, { at: now, line: summary.then((s) => writeOpening({ firstName, direction, summary: s })).catch(() => ({ line: null, why: "failed" })) });
}

export async function takeOpening(userId: string, waitMs = OPENING_WRITER.takeBudgetMs, now = Date.now()): Promise<{ line: string | null; why?: string }> {
  const hit = pending.get(userId);
  pending.delete(userId);
  if (!hit || now - hit.at >= OPENING_WRITER.ttlMs) return { line: null, why: "none prepared" };
  return Promise.race([hit.line, new Promise<{ line: null; why: string }>((r) => setTimeout(() => r({ line: null, why: `not ready in ${waitMs}ms` }), waitMs))]);
}

// Logged with the pool's own decision, so the review sees which one a call got.
export function recordOpening(userId: string, direction: "inbound" | "outbound", r: { line: string | null; why?: string }): void {
  recordDecision({
    layer: 8,
    // The pool's own record is "call.opening" (it reads the last template to avoid
    // repeating); a fallback is logged apart so that read isn't disturbed.
    decision: r.line ? "call.opening" : "call.opening_fallback",
    userId,
    outcome: r.line ? "act" : "skip",
    action: direction,
    proposal: r.line ? { template: "model", line: r.line } : { fallback: r.why ?? "unknown" },
  }).catch(() => {});
}
