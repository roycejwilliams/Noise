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
//
// 2026-10-08 (Royce, after a 10-call eval where 4 of 9 outbound calls opened on
// "the PDF went out this morning, wanted to make sure it landed"): an outbound
// opening comes from WHY Co called, a moment in their life (services/callReason.ts,
// held by the call gate), never from something Co owes or sent. Any opening that
// leads with Co's homework is refused in code, inbound and outbound.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { checkNoEmotionLabelOnCall } from "../harness/emotion.js";
import { recordDecision } from "../harness/core.js";
import { MODELS } from "../models.js";
import { stockLine } from "../harness/stockLines.js";
import { cuesIn } from "./voiceCues.js";
import { narratesInternalState, selfContradiction } from "./speakable.js";
import { SENSITIVE, heldCallReason, leadsWithCoHomework, renderCallReason, type CallReason } from "./callReason.js";
import { recordAnthropicUsage, scopeMember, withMember } from "./llmUsage.js";

export const OPENING_WRITER = {
  minContext: 300,
  maxContext: 8000,
  maxChars: 220,
  maxWords: 40,
  // Outbound: written while it rings. Inbound: a short wait, then the pool.
  // Hume's brain (claude-sonnet-4-6, 2026-10-08 Royce: "put what the Hume prompt and model had into ElevenLabs"): no default thinking.
  outboundModel: "claude-sonnet-4-6",
  inboundModel: MODELS.haiku,
  // Haiku 5.5 with thinking off writes in ~0.7-1s; 0.7s was always missed (inbound always fell back to the pool).
  inboundBudgetMs: 1200,
  takeBudgetMs: 800,
  ttlMs: 5 * 60 * 1000,
};

// What the opening is written from, and checked against: the call's context
// without its older threads (questions, never a pickup) and without the old side
// of a settled correction (2026-10-08 call review: two calls in a row opened on a
// goal they had corrected, "first paying customer").
export function openingContext(summary: string): string {
  return summary
    .split("\n\n")
    .filter((section) => !/^Older threads, not current/.test(section))
    .map((section) => (/^Settled \(/.test(section) ? section.replace(/ \(not "[^"]*"\)/g, "").replace(/: not "[^"]*" \(they said that's wrong\)/g, ": (an old item they said was wrong)") : section))
    .join("\n\n");
}

// What the outbound line opens on: the reason Co called (their moment), or, for a call they asked for, them.
const NOT_CO_WORK = "Never open on Cue's own work: nothing Cue sent, made, drafted, delivered, owes or is working on (no \"did it land\", no \"did you get the doc\").";
export function outboundOpeningGuide(reason: CallReason | null | undefined): string {
  if (reason && reason.kind !== "member_asked" && reason.kind !== "intake") {
    if (reason.sensitive)
      return `Cue is calling about something personal in their life. Don't name it: whoever picks up hears this line. Greet them warmly and ask one open, light question about them. ${NOT_CO_WORK}`;
    // Their words stay out of the guide: they often carry the feeling ("nervous about the Q&A"), which the first line never names
    // (2026-10-08 live check: 3 of 3 lines asked "still feeling nervous?"). The call brain gets them ({{call_reason}}).
    return `Cue called because of this, a moment in their life: ${reason.text}. Open on it: greet them, then one light question about the thing itself (${reason.kind === "how_it_went" ? "whether it ended up happening, never taking for granted that they went" : "how it's shaping up, whether it's still on, or whether it happened"}), never about how they feel about it. Their moment, in a friend's words. ${NOT_CO_WORK}`;
  }
  if (reason?.kind === "intake") return `This is their first real conversation with Cue: Cue called to get to know them. Greet them and open on them. ${NOT_CO_WORK}`;
  return `${reason?.kind === "member_asked" ? "They asked Cue to call. " : ""}Then pick up ONE specific, real thing about them and their week, as a light question or as "last we talked ...": something they said, have coming up or are working on, whatever a friend who knows them would naturally bring up. ${NOT_CO_WORK}`;
}

export function openingPrompt(o: { firstName: string; direction: "inbound" | "outbound"; summary: string; recent?: string[]; reason?: CallReason | null }): string {
  return `You're writing the first thing Cue says when a phone call connects. Cue is a calm, warm companion who already knows ${o.firstName || "this person"} and has talked with them before. ${o.direction === "outbound" ? `Cue is calling them, so Cue says who it is ("it's Cue").` : "They called Cue."}

What Cue knows about them (this is all you may use):
${o.summary.slice(0, OPENING_WRITER.maxContext)}

Write ONE spoken line, two short sentences at most and under 28 words, greeting ${o.firstName || "them"} by name.${o.direction === "inbound" ? ` They called Cue, so they likely have something on their mind: greet them warmly and let them lead. A light touch of one real thing about them is fine; never open with Cue's own agenda. ${NOT_CO_WORK}` : ` ${outboundOpeningGuide(o.reason)}`}
Never pick up something they've already told Cue is off, changed or done, and never repeat back news from the last call as if it were new. Never say Cue did, drafted, sent or found something unless what Cue knows says it was done: something Cue still owes them is still owed.
${o.recent?.length ? `How you opened your last calls with them (never reuse their words, and don't lead with the same thing again):
${o.recent.map((l) => `- ${l}`).join("\n")}
` : ""}
Rules:
- Only use facts that are in what Cue knows. No times, places, names or numbers that aren't there.
- Never name or guess how they feel or sound.
- The line is heard the moment anyone picks up, maybe not them. Pick up work, plans, projects or logistics only. Never health, loss, family, money trouble, legal matters, relationships, or anything another member of Noise said or did.
- No times or dates relative to now (today, tomorrow, this week, a weekday) unless the exact words are in what Cue knows.
- No "how are you", no "good to hear your voice", no "I remember", no "I was thinking about you".
- Plain speech: no dashes, brackets, quotes or placeholders.
- If nothing in what Cue knows is a safe, good thing to pick up, answer exactly: NONE

Reply with only the line.`;
}

const FEELING_WORD = /\b(?:stress(?:ed)?|overwhelm\w*|anxi\w*|worr(?:y|ied|ies)|nervous|sad|upset|frustrat\w*|exhaust\w*|burn(?:ed|t)? out|lonely|depress\w*|scared|afraid|angry|annoyed|discourag\w*|feeling|feel)\b/i;
const RELATIVE_TIME = /\b(?:today|tonight|tomorrow|yesterday|this (?:week|weekend|morning|afternoon|evening)|next (?:week|weekend|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const CO_DID = /\bI(?:'ve| have)?\s+(?:just\s+|already\s+)?(drafted|sent|finished|wrote|put together|pulled together|made|built|found|booked|set up|lined up)\b/i;
const STOP_CAPS = new Set(["i", "i'm", "i've", "i'd", "i'll", "co", "cue"]);
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
  if (RELATIVE_TIME.test(line) && !RELATIVE_TIME.test(summary)) return "a relative time not in what Cue knows";
  if (/\bintro(?:duc\w*)?\b|\bsaid yes\b|\bwants? to meet\b/i.test(line)) return "speaks for another member";
  if (/\bhow are you\b|good to hear your voice|i remember|thinking about you/i.test(line) || stockLine(line)) return "a stock line";
  // Never narrates Co's own state ("I still haven't found anything solid yet", "working on it"): the same rule as every text (speakable.ts).
  if (narratesInternalState(line) || /\b(?:haven't|have not|still haven't) (?:found|got|gotten|finished|had a chance)\b/i.test(line)) return "narrates Cue's own state";
  // Never two clauses that can't both be true (2026-10-08: "review that post-event branding plan I owe you"): speakable.ts.
  const clash = selfContradiction(line);
  if (clash) return `contradicts itself: ${clash}`;
  // Co's own finished work only when the record says it (2026-10-08: "I drafted the planning doc" for a plan
  // the after-call check had found nothing good enough to send for).
  const did = line.match(CO_DID);
  if (did && !new RegExp(`\\b${did[1].toLowerCase().replace(/\s+/g, "\\s+")}\\b`).test(summary.toLowerCase())) return `claims Cue ${did[1].toLowerCase()} something the record doesn't show`;
  // Never Co's homework, inbound or outbound (2026-10-08: "the PDF went out this morning, wanted to make sure it landed"):
  // the opening is about them, never a deliverable Co sent, owes or is working on (services/callReason.ts).
  if (leadsWithCoHomework(line, summary)) return "leads with Cue's homework";
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
      if ((isNumber || isName) && !present) return `not in what Cue knows: ${bare}`;
    }
  }
  return null;
}

export function openingVerdict(raw: string, summary: string, firstName: string): { ok: true; line: string } | { ok: false; why: string } {
  const why = openingProblems(raw, summary, firstName);
  return why ? { ok: false, why } : { ok: true, line: raw.trim().replace(/^["“']|["”']$/g, "").trim() };
}

// How Co opened its last calls with them (written or pool), newest first: the writer avoids their words and their angle
// (2026-10-08: openings repeated call after call).
export async function recentOpenings(userId: string, n = 4): Promise<string[]> {
  const { default: pool } = await import("../db/db.js");
  const { rows } = await pool.query(
    `SELECT COALESCE(proposal->>'line', proposal->>'text') AS line FROM harness_decisions
     WHERE user_id = $1 AND decision = 'call.opening' AND COALESCE(proposal->>'line', proposal->>'text') IS NOT NULL
     ORDER BY created_at DESC LIMIT $2`,
    [userId, n],
  );
  return rows.map((r: any) => String(r.line)).filter(Boolean);
}

// The context the line is written from and checked against: the trimmed call context, plus why Co called (outbound), so the
// moment it opens on is in what Co knows.
export function openingSource(summary: string, direction: "inbound" | "outbound", reason?: CallReason | null): string {
  const base = openingContext(summary);
  // First, so the writer's cut (OPENING_WRITER.maxContext) never drops it under a long context (review of #354: the text thread made
  // the context longer than the cut).
  return direction === "outbound" && reason ? `Why Cue is calling: ${renderCallReason(reason)}\n\n${base}` : base;
}

// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
export async function writeOpening(...a: Parameters<typeof writeOpeningInScope>): ReturnType<typeof writeOpeningInScope> {
  return withMember(a[0].userId ?? scopeMember(), () => writeOpeningInScope(...a));
}
async function writeOpeningInScope(o: { firstName: string; direction: "inbound" | "outbound"; summary: string; timeoutMs?: number; userId?: string; reason?: CallReason | null }): Promise<{ line: string | null; why?: string }> {
  if (o.summary.trim().length < OPENING_WRITER.minContext) return { line: null, why: "no context yet (a first call)" };
  // Written from, and checked against, the same trimmed context.
  const summary = openingSource(o.summary, o.direction, o.reason);
  try {
    const model = o.direction === "outbound" ? OPENING_WRITER.outboundModel : OPENING_WRITER.inboundModel;
    const recent = o.userId ? await recentOpenings(o.userId).catch(() => [] as string[]) : [];
    const prompt = openingPrompt({ ...o, summary, recent });
    const signal = AbortSignal.timeout(o.timeoutMs ?? 20_000);
    // Haiku 5.x thinks by default and ai-sdk drops a "disabled" thinking option: on the inbound budget it used the whole cap and
    // wrote nothing, every call (2026-10-08: 4 of 4 empty, 1.2-1.5s against a 0.7s budget), so inbound calls always fell back to
    // the pool. Asked directly, with thinking off, as the call brain's proxy does.
    const text = /^claude-haiku-5/.test(model)
      ? await (async () => {
          const Anthropic = (await import("@anthropic-ai/sdk")).default;
          const r: any = await new Anthropic().messages.create({ model, max_tokens: 120, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] } as any, { signal });
          recordAnthropicUsage("call.writeOpening", r.model ?? model, r.usage);
          return (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        })()
      : (
          await generateText({
            model: anthropic(model),
            maxOutputTokens: 120,
            // A one-line writing job: low effort so thinking can't eat the cap (evals/guards). Sonnet 4.x neither thinks by default
            // nor takes an effort option.
            ...(/^claude-sonnet-4/.test(model) ? {} : { providerOptions: { anthropic: { effort: "low" as const } } }),
            abortSignal: signal,
            experimental_telemetry: { isEnabled: true, functionId: "call.writeOpening" },
            prompt,
          })
        ).text;
    const v = openingVerdict(text, summary, o.firstName);
    return v.ok ? { line: v.line } : { line: null, why: v.why };
  } catch (err: any) {
    return { line: null, why: `write failed: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

// ---------- written while it rings
const pending = new Map<string, { at: number; line: Promise<{ line: string | null; why?: string }> }>();

// Outbound: the reason the call gate held for this call (services/callReason.ts) is what the line opens on.
export function prebuildOpening(userId: string, firstName: string, direction: "inbound" | "outbound", summary: Promise<string>, now = Date.now()): void {
  const reason = direction === "outbound" ? (heldCallReason(userId, now)?.result.reason ?? null) : null;
  pending.set(userId, { at: now, line: summary.then((s) => writeOpening({ firstName, direction, summary: s, userId, reason })).catch(() => ({ line: null, why: "failed" })) });
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
