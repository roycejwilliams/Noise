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
import { checkDraft } from "../harness/proactive.js";
import { parseModelJson } from "./modelJson.js";
import { numbersBacked, OFFERS_WHAT_CO_CANT, placesBacked } from "./taskWeb.js";
import { captionNumbersBacked } from "./sendCheck.js";

export type SendItem = { url: string; name: string; tier: number; facts: string[] };

// Tier order, stable within a tier (the order Co found them).
export function orderByTier<T extends { tier: number }>(items: T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.tier - b.it.tier || a.i - b.i).map((x) => x.it);
}

export function assembleMessages(items: { url: string; caption: string }[], closing: string | null): string[] {
  const out: string[] = [];
  // No "Two that fit, sending both now." lead (Royce, 2026-10-09: no process narration): each thing is its link and caption.
  for (const it of items) out.push(it.url, it.caption);
  if (closing && closing.trim()) out.push(closing.trim());
  return out;
}

// A caption says only what its own item's verified facts say, or what the member said themselves (their budget, their headcount,
// their city), the same backing a search find's caption gets (agent/loopTools.ts captionProblems). Royce, 2026-10-31: his own
// "5,000 or 8,000" grant target failed a caption as "not in its facts".
export function captionOk(caption: string, itemFacts: string, theirs = ""): { ok: boolean; why: string | null } {
  const rules = checkDraft(caption, { maxSentences: 2, maxChars: 300 }).filter((c) => !c.pass);
  if (rules.length) return { ok: false, why: rules.map((r) => r.name).join(", ") };
  const backing = `${itemFacts} ${theirs}`;
  const nums = numbersBacked(caption, backing);
  if (!nums.ok) return { ok: false, why: `numbers not in its facts: ${nums.missing.join(", ")}` };
  const places = placesBacked(caption, backing);
  if (!places.ok) return { ok: false, why: `places not in its facts: ${places.missing.join(", ")}` };
  // Scarcity, "free" and "sold out" with no number behind them (Phase B, B4): the same rule a find's caption is held to.
  const said = captionNumbersBacked(caption, backing);
  if (!said.ok) return { ok: false, why: said.problems.join("; ") };
  if (OFFERS_WHAT_CO_CANT.test(caption)) return { ok: false, why: "offers something Cue can't do" };
  return { ok: true, why: null };
}

// The found things a text names, so a find never goes out named without its link (Royce, 2026-10-31: "stackable with Francisco
// San" went out and francisco san's link never did). A name counts only when its first words appear as a proper noun: every
// content word capitalised as written ("Francisco San", "the Founders Dinner"), never the same words as ordinary speech ("a
// founders dinner series", "after the run club"), and a one-word name never at the start of a sentence. The words count only
// inside one clause, so "San Francisco, San Mateo" never names "francisco san"; a name that a sent item's own name contains is
// left alone, since the words may mean that one.
const nameWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const NAME_GLUE = new Set(["a", "an", "the", "of", "in", "for", "at", "x", "and", "on", "to", "by", "with"]);
export function namedFinds(text: string, finds: { name: string }[], sent: { name: string }[] = []): string[] {
  const sentKeys = sent.map((s) => nameWords(s.name));
  const out: string[] = [];
  for (const f of finds) {
    const w = nameWords(f.name).split(" ").filter(Boolean);
    const lead = (w[0] === "the" ? w.slice(1) : w).slice(0, 3);
    const key = lead.join(" ");
    if (key.length < 6 || out.includes(f.name) || sentKeys.some((k) => k.includes(key))) continue;
    const content = lead.filter((x) => !NAME_GLUE.has(x)).length;
    const re = new RegExp(`(?<![A-Za-z0-9])${lead.map((x) => `(${x})`).join("[^A-Za-z0-9.,;:!?()\\n]+")}(?![A-Za-z0-9])`, "gi");
    for (const m of text.matchAll(re)) {
      const proper = m.slice(1).every((x, i) => NAME_GLUE.has(lead[i]) || /^[A-Z0-9]/.test(x));
      const atStart = /(^|[.!?]\s+)$/.test(text.slice(0, m.index));
      if (proper && !(content === 1 && atStart)) { out.push(f.name); break; }
    }
  }
  return out;
}

// One call: a caption per item from that item's facts only, and a short closing line. fix: what broke in the first draft, for the
// one redraft.
export async function draftTaskMessages(o: { firstName: string; goal: string; items: SendItem[]; what: string; context: string; fix?: string }): Promise<{ captions: Map<string, string>; closing: string | null }> {
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    maxOutputTokens: 3000,
    providerOptions: { anthropic: { effort: "low" } },
    experimental_telemetry: { isEnabled: true, functionId: "taskTurn.captions" },
    prompt: `${CO_VOICE}

You're texting ${o.firstName} about what they asked you to do: "${o.goal}". Each thing below goes out as its link, then a short caption under it. Write the captions, then one short closing line.

${o.items.map((it, i) => `[${i + 1}] ${it.name} (${it.url})\n    verified facts: ${it.facts.join("; ") || "(none beyond its name)"}`).join("\n")}

Other verified context (for the closing line only): ${o.context || "(none)"}
What you want to get across overall (a guide, not a source): ${o.what}

Rules: each caption is one or two short sentences saying what it is and why it fits, using ONLY that item's verified facts. No links in captions. The closing line (one or two sentences) is where you ask your one question or say what's next; never promise a result, and never offer to call, book, reserve or contact anyone for them, or to fill in, submit or apply for anything for them. No sign-off, no greeting.
${o.fix ? `\nYour first draft broke these, so it didn't go: ${o.fix}. Write them all again. Name only the things listed above: anything else you found stays unnamed, since its link isn't going.\n` : ""}
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
