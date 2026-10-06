// How a task's findings arrive, the same way search results do (Royce,
// 2026-09-30: "Remember its links first then description. It should follow the
// same order as the tiers"). Several things get a one-line heads-up; then each
// link followed by its own description; Co's own events first, then public
// events, then everything found on the web (services/messageFormat.ts, the
// tiers). A closing line, if any, comes last.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { CO_VOICE } from "./coVoice.js";
import { renderMatchLead } from "./messageFormat.js";
import { checkDraft } from "../harness/proactive.js";
import { parseModelJson } from "./modelJson.js";
import { numbersBacked, OFFERS_WHAT_CO_CANT, placesBacked } from "./taskWeb.js";
import { sealedTelemetry } from "./privateTurn.js";

export type SendItem = { url: string; name: string; tier: number; facts: string[] };

// Tier order, stable within a tier (the order Co found them).
export function orderByTier<T extends { tier: number }>(items: T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.tier - b.it.tier || a.i - b.i).map((x) => x.it);
}

export function assembleMessages(items: { url: string; caption: string }[], closing: string | null): string[] {
  const out: string[] = [];
  if (items.length > 1) out.push(renderMatchLead(items.length));
  for (const it of items) out.push(it.url, it.caption);
  if (closing && closing.trim()) out.push(closing.trim());
  return out;
}

// A caption says only what its own item's verified facts say.
export function captionOk(caption: string, itemFacts: string): { ok: boolean; why: string | null } {
  const rules = checkDraft(caption, { maxSentences: 2, maxChars: 300 }).filter((c) => !c.pass);
  if (rules.length) return { ok: false, why: rules.map((r) => r.name).join(", ") };
  const nums = numbersBacked(caption, itemFacts);
  if (!nums.ok) return { ok: false, why: `numbers not in its facts: ${nums.missing.join(", ")}` };
  const places = placesBacked(caption, itemFacts);
  if (!places.ok) return { ok: false, why: `places not in its facts: ${places.missing.join(", ")}` };
  if (OFFERS_WHAT_CO_CANT.test(caption)) return { ok: false, why: "offers something Co can't do" };
  return { ok: true, why: null };
}

// One call: a caption per item from that item's facts only, and a short closing line.
export async function draftTaskMessages(o: { firstName: string; goal: string; items: SendItem[]; what: string; context: string }): Promise<{ captions: Map<string, string>; closing: string | null }> {
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    maxOutputTokens: 3000,
    providerOptions: { anthropic: { effort: "low" } },
    experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "taskTurn.captions" },
    prompt: `${CO_VOICE}

You're texting ${o.firstName} about what they asked you to do: "${o.goal}". Each thing below goes out as its link, then a short caption under it. Write the captions, then one short closing line.

${o.items.map((it, i) => `[${i + 1}] ${it.name} (${it.url})\n    verified facts: ${it.facts.join("; ") || "(none beyond its name)"}`).join("\n")}

Other verified context (for the closing line only): ${o.context || "(none)"}
What you want to get across overall (a guide, not a source): ${o.what}

Rules: each caption is one or two short sentences saying what it is and why it fits, using ONLY that item's verified facts. No links in captions. The closing line (one or two sentences) is where you ask your one question or say what's next; never promise a result, and never offer to call, book, reserve or contact anyone for them. No sign-off, no greeting.

Return ONLY JSON: {"captions": [{"n": 1, "caption": "..."}], "closing": "..." or null}`,
  });
  const p = parseModelJson<{ captions?: { n?: number; caption?: string }[]; closing?: string | null }>(text);
  const captions = new Map<string, string>();
  for (const c of p?.captions ?? []) {
    const it = typeof c.n === "number" ? o.items[c.n - 1] : undefined;
    if (it && typeof c.caption === "string" && c.caption.trim()) captions.set(it.url, c.caption.trim());
  }
  return { captions, closing: typeof p?.closing === "string" && p.closing.trim() ? p.closing.trim() : null };
}
