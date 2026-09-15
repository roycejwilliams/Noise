// Layer 3 harness: grounding for the conversational reply (Royce,
// 2026-09-14). Co kept inventing things about its own actions and the world
// ("This is text, I can't actually call", "I'll get you the link as soon as
// I have it", a 6:30pm start and "15-20 founders" for an event with neither
// on file, "I accidentally sent a broken link"). The reply prompt already
// said not to; prompts alone didn't hold.
//
//   gather  — ReplyFacts: one structured list of what's actually true this
//             turn (actions taken, pending items, scheduled calls, known
//             event fields and known gaps), built in code
//   propose — the reply agent drafts a message
//   gate    — groundReply: code checks links/phones/times/call claims, and a
//             Sonnet 5 read extracts every claim about actions, promises,
//             times, places, links, counts, and other people, each of which
//             must cite a fact or quote the thread (code verifies the cite).
//             Unsupported -> one redraft -> still unsupported -> the failing
//             sentences are dropped. The reply is never blocked.
//   record  — recordDecision(layer 3, "reply.grounding")
//   eval    — evals/reply/run.ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { cleanCoMessage } from "../services/sendblue.js";
import { CO_TEXT_CHANNEL, CO_VOICE } from "../services/coVoice.js";
import { recordDecision, type GateCheck } from "./core.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { checkNoEmotionLabel } from "./emotion.js";
import { enrichMatch, missingEventDetails, renderEventDetails, type EventDetails, type OpportunityDetails } from "../services/eventDetails.js";

// Model policy (Royce, 2026-09-14): Sonnet 5 for anything with judgment or
// side effects; Haiku only for narrow, code-checked reads.
export const LAYER3_MODELS = {
  // REPLY_EVAL_MODEL only exists so evals/reply can compare models.
  reply: process.env.REPLY_EVAL_MODEL || MODELS.sonnet,
  grounding: MODELS.sonnet,
  redraft: MODELS.sonnet,
  narrow: MODELS.haiku,
} as const;

// Effort for the grounding check and redraft. The check is extraction plus a
// supported/unsupported read, so low effort keeps latency down.
const GROUNDING_EFFORT = "low";

export type FactKind =
  | "did_this_turn" // something Co actually did during this turn
  | "pending" // something Co asked and is still waiting on
  | "scheduled" // a real scheduled call
  | "known" // a real field Co has (event name, date, link, recommendation)
  | "unknown" // a detail Co explicitly does not have
  | "capability" // what Co can and can't do
  | "ongoing"; // a search that really keeps running for them (an open ask)

export type Fact = { id: string; kind: FactKind; text: string };

export type ReplyFacts = { facts: Fact[]; instructions: string[] };

export function createReplyFacts(): ReplyFacts {
  return { facts: [], instructions: [] };
}

export function addFact(rf: ReplyFacts, kind: FactKind, text: string): void {
  const t = text.trim();
  if (!t || rf.facts.some((f) => f.text === t)) return;
  rf.facts.push({ id: `F${rf.facts.length + 1}`, kind, text: t });
}

export function addInstruction(rf: ReplyFacts, text: string): void {
  const t = text.trim();
  if (t && !rf.instructions.includes(t)) rf.instructions.push(t);
}

const STANDING_CAPABILITIES = [
  `Co can call them right now when they ask ("call me"), and can schedule a call for a specific later time. Calling is real and working.`,
  `They can also call Co from this same number. You are not given the digits, so never write a phone number.`,
  `Co can't go chase down a specific link, detail, or answer later: if it isn't here, it won't show up.`,
  `Co can send its contact card (so they can save Co) with the sendContactCard tool when they ask for it or want to save Co.`,
];

// Facts that are true for every reply, before anything about this person.
export function baseReplyFacts(): ReplyFacts {
  const rf = createReplyFacts();
  for (const c of STANDING_CAPABILITIES) addFact(rf, "capability", c);
  return rf;
}

// Gathers the facts that don't depend on what happened earlier in this turn.
// Branch-specific facts (a link just sent, a call that failed) are added by
// routes/sendblue.ts as it acts.
export async function gatherReplyFacts(
  userId: string,
  opts: { pendingDescriptions?: string[] } = {},
): Promise<ReplyFacts> {
  const rf = baseReplyFacts();
  for (const d of opts.pendingDescriptions ?? []) addFact(rf, "pending", `Waiting to hear back: ${d}`);
  await addOngoingSearchFacts(rf, userId);

  const [scheduled, reveal] = await Promise.all([
    pool
      .query(
        `SELECT scheduled_for, timezone FROM scheduled_calls WHERE user_id = $1 AND status = 'pending' AND scheduled_for > NOW() ORDER BY scheduled_for LIMIT 3`,
        [userId],
      )
      .catch(() => ({ rows: [] as any[] })),
    // Most recent event/opportunity Co told them about, resolved or not:
    // "what time does it start" can come days after the yes.
    pool
      .query(
        `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'event_offer_pending' AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )
      .catch(() => ({ rows: [] as any[] })),
  ]);

  if (!scheduled.rows.length) addFact(rf, "scheduled", "No calls are scheduled with them.");
  for (const row of scheduled.rows) {
    const local = DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(row.timezone);
    addFact(rf, "scheduled", `A call is scheduled for ${local.toFormat("cccc, LLLL d 'at' h:mm a")} (${row.timezone}).`);
  }

  if (reveal.rows[0]) {
    try {
      const { match } = JSON.parse(reveal.rows[0].content) as { match: any };
      // Offers stored before details existed get them on demand.
      addEventFacts(rf, await enrichMatch(match));
    } catch {
      // Malformed or pre-fix content shape; nothing reliable to add.
    }
  }
  return rf;
}

// What Co is really still looking for, from open asks. Only these make
// "I'll keep looking and text you if something fits" true: the daily sweep
// searches each open ask and the daily pick can text about a result. With
// none open, nothing is being looked for and any such promise is false.
export async function addOngoingSearchFacts(rf: ReplyFacts, userId: string): Promise<void> {
  const { rows } = await pool
    .query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 3`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const asks = rows.map((r: any) => String(r.ask_text)).filter(Boolean);
  if (rf.facts.some((f) => f.kind === "ongoing")) return;
  if (asks.length) {
    addFact(
      rf,
      "ongoing",
      `Co's daily search is looking for: ${asks.map((a) => `"${a}"`).join("; ")}. If something real fits, Co may text them about it (at most one text a day). Co can't promise it will find anything, or when.`,
    );
  } else {
    addFact(rf, "unknown", "Co isn't searching for anything for them right now. Nothing will be looked for later unless they ask for something specific.");
  }
}

// Real fields only, plus the gaps stated as gaps so "I don't have that" is
// itself grounded.
export function addEventFacts(
  rf: ReplyFacts,
  match: { name: string; event_date?: string; deadline?: string; url?: string; kind?: string; details?: EventDetails; opportunity?: OpportunityDetails; whyItFits?: string },
): void {
  const label = match.kind === "opportunity" ? "Opportunity" : "Event";
  addFact(rf, "known", `${label} Co told them about: "${match.name}"${match.event_date ? `, on ${match.event_date}` : ""}${match.deadline ? `, application deadline ${match.deadline}` : ""}.`);
  addFact(rf, "known", match.url ? `Link for "${match.name}": ${match.url}` : `There is no link on file for "${match.name}".`);
  // The real record (event page or source post), so "tell me more" gets
  // real answers instead of "I don't have that".
  if (match.details) for (const line of renderEventDetails(match.name, match.details)) addFact(rf, "known", line);
  if (match.opportunity) addFact(rf, "known", `What the source post for "${match.name}" says: ${match.opportunity.postText}`);
  if (match.whyItFits) addFact(rf, "known", `Why "${match.name}" fits them: ${match.whyItFits}`);
  if (match.kind !== "opportunity") {
    const missing = missingEventDetails(match.name, match.details);
    if (missing) addFact(rf, "unknown", missing);
  }
}

export function renderReplyFacts(rf: ReplyFacts): string {
  const facts = rf.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const instr = rf.instructions.length ? `\n\nFor this reply:\n${rf.instructions.map((i) => `- ${i}`).join("\n")}` : "";
  return `What's true right now. These, plus what's actually in the conversation, are the only actions, plans, links, times, places, numbers, and things about other people you can mention. If a detail isn't here, you don't have it: say so plainly, and don't promise to get it later.
${facts}${instr}`;
}

// ---------------------------------------------------------------------------
// Gate

export type Claim = {
  text: string;
  type: "past_action" | "future_promise" | "time" | "place" | "link" | "other_person" | "count" | "capability" | "detail";
  supported: boolean;
  factId: string | null;
  quote: string | null;
};

export type GroundingSources = {
  message: string;
  recentConversation: string;
  contextSummary?: string;
  recentMemories?: string;
  // Messages Co already sent earlier in this same turn.
  sentThisTurn?: string[];
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

function sourceText(rf: ReplyFacts, src: GroundingSources): string {
  return norm(
    [rf.facts.map((f) => f.text).join("\n"), src.recentConversation, src.contextSummary ?? "", src.recentMemories ?? "", src.message, ...(src.sentThisTurn ?? [])].join("\n"),
  );
}

// "2pm", "2:00 PM", "14:00" -> "14:00"
function clockTimes(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) {
    let h = Number(m[1]) % 12;
    if (/^p/i.test(m[3])) h += 12;
    out.push(`${String(h).padStart(2, "0")}:${m[2] ?? "00"}`);
  }
  return out;
}

// Deterministic checks that don't need a model.
export function codeChecks(draft: string, rf: ReplyFacts, src: GroundingSources): GateCheck[] {
  const emotionLabel = checkNoEmotionLabel(draft);
  const checks: GateCheck[] = [];
  const sources = sourceText(rf, src);
  const rawSources = [rf.facts.map((f) => f.text).join("\n"), src.recentConversation, src.contextSummary ?? "", src.recentMemories ?? "", src.message, ...(src.sentThisTurn ?? [])].join("\n");

  for (const url of draft.match(/https?:\/\/[^\s)]+/gi) ?? []) {
    const u = url.replace(/[.,!?]+$/, "");
    checks.push({ name: "link_on_file", pass: sources.includes(norm(u)), reason: `link ${u}` });
  }
  for (const phone of draft.match(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) ?? []) {
    const digits = phone.replace(/\D/g, "");
    checks.push({ name: "phone_on_file", pass: rawSources.replace(/\D/g, "").includes(digits), reason: `phone number ${phone}` });
  }
  const knownTimes = new Set(clockTimes(rawSources));
  for (const t of clockTimes(draft)) {
    checks.push({ name: "time_on_file", pass: knownTimes.has(t), reason: `time ${t}` });
  }
  if (/\b((calling|ringing|dialing) you (right )?now|i'?m (calling|ringing|dialing) you|still (calling|ringing|dialing) you)\b/i.test(draft)) {
    checks.push({ name: "no_call_placed_claim", pass: false, reason: "says a call is happening, but this reply never places one" });
  }
  if (/\bI\s*(can(no|')?t|can not|am unable to|'?m unable to|don'?t|do not)\s+(actually\s+)?(make|place|do)?\s*(a\s+|phone\s+)*calls?\b|\bthis is (just )?(a )?text\b/i.test(draft)) {
    checks.push({ name: "no_capability_denial", pass: false, reason: "says Co can't call, which is false" });
  }
  // Follow-up promises nothing in the code keeps: no job texts them when a
  // link turns up or when the other person answers (an intro goes out by
  // email, not a text from Co).
  const promise = draft.match(
    // "If one turns up, I'll text you" (conditional first) is the same promise.
    /\b(?:if|when|once|as soon as)\b[^.?!]{0,80}\b(?:i'?ll|i will)\s+(?:text|send|ping|message|let)\s+you\b|\b(i'?ll|i will|i can|let me|will)\s+(keep (an eye out|watching|looking|searching|checking)|flag (it|that|one)|circle back|follow up|get back to you|let you know|text you (when|once|as soon|the moment|if)|track (it|that|one) down|find out|look into|reach out to|send (it|one|the link) (when|once|as soon)|send (it|one|them|that) your way|pass (it|one|that) along|ping you|be in touch)\b/i,
  );
  const lookoutPromise = draft.match(/\b(keep (my|an|our) eyes? (open|out|peeled)|keep (watching|looking|an eye out)|be on the lookout|watch(ing)? for (one|it|something|that)|text you (the second|the moment|right when|as soon as))\b/i);
  const found = promise ?? lookoutPromise;
  // A promise to keep looking is only true while an ask is open (the sweep
  // really does search it), and never with a timing commitment.
  const ongoing = rf.facts.some((f) => f.kind === "ongoing");
  const timingCommitment = /\b(the second|the moment|right when|as soon as|right away|immediately|tonight|tomorrow|today|this week)\b/i.test(draft);
  const lookingOnly = found && /keep (looking|watching|an eye|my eyes|eyes)|on the lookout|watch(ing)? for|if (something|anything|one) (real )?(turns up|comes up|fits|shows up)/i.test(found[0] + " " + draft);
  if (found && !(ongoing && lookingOnly && !timingCommitment)) {
    checks.push({ name: "no_followup_promise", pass: false, reason: `promises a follow-up nothing will do: "${found[0]}"` });
  }
  if (!emotionLabel.pass) checks.push(emotionLabel);
  return checks;
}

function extractJson(text: string): any {
  try {
    return parseModelJson(text);
  } catch {
    return null;
  }
}

async function extractClaims(draft: string, rf: ReplyFacts, src: GroundingSources): Promise<{ claims: Claim[]; latencyMs: number } | null> {
  const started = Date.now();
  const facts = rf.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.grounding),
    maxOutputTokens: 2000,
    providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.check" },
    prompt: `You check a text message Co is about to send, before it goes out. Find every claim in it that could be false, and say whether the sources below support it.

Claims to find:
- past_action: something Co says it did or sent ("I sent you the link", "I scheduled it", "I emailed you both")
- future_promise: something Co says it will do later ("I'll send it when I have it", "I'll keep an eye out", "I'll call you then")
- time, place, count, detail: a start time, date, address, neighborhood, headcount, format, host, price, or other specific about an event, program, or plan
- link: a link or an "it's in the link above"
- other_person: what another person said, wants, feels, or did ("she mentioned she'd like to meet you")
- capability: what Co can or can't do ("I can't call", "I don't have access to your calendar")

Don't list: opinions, feelings, questions, general encouragement, restating what they told Co, or how Co will talk in this conversation ("I'll keep it short", "switching back to normal caps", "let's keep going over text").

A claim is supported only if a FACT below states it, or the conversation shows it. A future_promise is supported only if a FACT says it will actually happen (a scheduled call, a pending item). "I don't have X" is supported when X is not in the sources. Never count something as supported because it's plausible.

FACTS:
${facts}

Conversation so far:
${src.recentConversation || "(none)"}
${src.sentThisTurn?.length ? `\nCo already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}${src.contextSummary ? `\nWhat Co knows about them:\n${src.contextSummary}\n` : ""}
They just said: "${src.message}"

Message Co is about to send:
"${draft}"

Return ONLY JSON: {"claims": [{"text": "exact words from the message", "type": "...", "supported": true|false, "factId": "F3" or null, "quote": "exact words copied from the conversation or what Co knows that support it" or null}]}. Supported claims need a factId or a quote. Return {"claims": []} if there are none.`,
  });
  const json = extractJson(text);
  if (!json || !Array.isArray(json.claims)) return null;
  const claims: Claim[] = json.claims
    .filter((c: any) => c && typeof c.text === "string")
    .map((c: any) => ({
      text: c.text,
      type: c.type ?? "detail",
      supported: c.supported === true,
      factId: typeof c.factId === "string" ? c.factId : null,
      quote: typeof c.quote === "string" && c.quote.trim() ? c.quote : null,
    }));
  return { claims, latencyMs: Date.now() - started };
}

// A model's "supported" only counts if its citation checks out in code.
function claimChecks(claims: Claim[], rf: ReplyFacts, src: GroundingSources): GateCheck[] {
  const sources = sourceText(rf, src);
  const factIds = new Set(rf.facts.map((f) => f.id));
  return claims.map((c) => {
    let pass = c.supported;
    let reason = `${c.type}: "${c.text}"`;
    if (pass && c.type === "future_promise") {
      const cited = rf.facts.find((f) => f.id === c.factId);
      if (!cited || !["ongoing", "scheduled", "did_this_turn"].includes(cited.kind)) {
        pass = false;
        reason += " (a future action needs a real scheduled call or an open search behind it)";
      }
    }
    if (pass) {
      const factOk = !!c.factId && factIds.has(c.factId);
      const quoteOk = !!c.quote && norm(c.quote).length >= 6 && sources.includes(norm(c.quote));
      if (!factOk && !quoteOk) {
        pass = false;
        reason += " (cited support not found)";
      }
    }
    return { name: `claim_${c.type}`, pass, reason };
  });
}

async function redraft(draft: string, failed: GateCheck[], rf: ReplyFacts, src: GroundingSources): Promise<string | null> {
  const tail = src.recentConversation.split("\n").slice(-14).join("\n");
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.redraft),
    maxOutputTokens: 1000,
    providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.redraft" },
    prompt: `${CO_VOICE}

${CO_TEXT_CHANNEL}

${renderReplyFacts(rf)}

Recent conversation:
${tail || "(none)"}
${src.sentThisTurn?.length ? `\nYou already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}
They just said: "${src.message}"

Your draft reply:
"${draft}"

These parts of the draft aren't supported by the facts or the conversation:
${failed.map((f) => `- ${f.reason ?? f.name}`).join("\n")}

Rewrite the draft so it still responds to what they said, keeping everything that's supported. Fix or remove each unsupported part. If you don't have something they asked for, say it once, plainly, naming exactly what you don't have ("I don't have the start time"), then what you can do now if anything. Don't hedge, don't point them at a link instead, and don't promise to get it later. Match the draft's capitalization style. Same length or shorter. Return ONLY the message.`,
  });
  const out = text.trim().replace(/^"|"$/g, "");
  return out || null;
}

// Last resort: drop the sentences that carry an unsupported claim.
function stripUnsupported(draft: string, failed: GateCheck[]): string {
  const sentences = draft.match(/[^.!?\n]+[.!?]*\s*/g) ?? [draft];
  const bad = failed.map((f) => norm((f.reason ?? "").replace(/^[a-z_]+: "|"( \(cited support not found\))?$/g, "").replace(/^(link|phone number|time) /, "")));
  const keep = sentences.filter((s) => {
    const ns = norm(s);
    if (failed.some((f) => f.name === "no_call_placed_claim") && /(calling|ringing|dialing) you|i'?m (calling|ringing|dialing)/i.test(s)) return false;
    if (failed.some((f) => f.name === "no_emotion_label") && !checkNoEmotionLabel(s).pass) return false;
    if (failed.some((f) => f.name === "no_followup_promise") && /\b(i'?ll|i will|i can|let me|will)\s+(keep|flag|circle|follow|get back|let you know|text you|track|find out|look into|reach out|send)/i.test(s)) return false;
    if (failed.some((f) => f.name === "no_capability_denial") && /\b(can(no|')?t|unable to|this is (just )?text)\b/i.test(s)) return false;
    if (failed.some((f) => f.name === "link_on_file") && /https?:\/\//i.test(s)) return false;
    if (failed.some((f) => f.name === "phone_on_file") && /\d{3}[\s.-]?\d{4}/.test(s)) return false;
    if (failed.some((f) => f.name === "time_on_file") && clockTimes(s).length) return false;
    return !bad.some((b) => b.length >= 6 && (ns.includes(b) || b.includes(ns.replace(/[.!?]+$/, ""))));
  });
  return keep.join("").trim();
}

export type GroundingResult = {
  final: string;
  outcome: "as_drafted" | "redrafted" | "stripped" | "unchecked";
  checks: GateCheck[];
  // Total grounding time for this message (checks + any redraft).
  latencyMs: number;
  // Just the first check: the added latency on a reply that passes as drafted.
  firstCheckMs: number;
};

const MINIMAL_FALLBACK = "I don't have that, so I'd rather not guess.";

// Cheap pre-filter for the model claim read. Plain conversational replies
// ("That sounds hard. What's been the toughest part?") have nothing to
// verify, and the Sonnet read added ~2s p50 to every reply. Anything that
// could carry a checkable claim still gets read: numbers, times and dates,
// links or contact details, a proper name mid-sentence, Co describing its own
// actions or plans, or someone else's words or intent.
const CLAIM_SHAPED = [
  /\d/,
  /https?:\/\/|www\.|@/i,
  /\b(today|tonight|tomorrow|yesterday|week|weekend|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|noon|midnight)\b/i,
  /\b(i'?ll|i will|i'?ve|i have|i just|i already|i can'?t|i cannot|i'?m (going|calling|sending|booking|looking|checking)|let me|we'?ll|will be)\b/i,
  /\b(sent|shared|booked|scheduled|called|calling|texted|emailed|introduced|intro|registered|signed up|added|found|reached out|confirmed|link|address|located|starts|ends|event|call)\b/i,
  /\b(said|says|mentioned|told|asked|wants|wanted|would like|is going|are going|attending|opted|agreed|interested)\b/i,
  /[a-z,]\s+[A-Z][a-z]{2,}/,
];

export function needsClaimCheck(draft: string): boolean {
  return CLAIM_SHAPED.some((re) => re.test(draft));
}

async function check(draft: string, rf: ReplyFacts, src: GroundingSources): Promise<{ checks: GateCheck[]; modelOk: boolean; ms: number }> {
  const code = codeChecks(draft, rf, src);
  if (!needsClaimCheck(draft)) return { checks: [...code, { name: "claim_read", pass: true, reason: "nothing claim-shaped, model read skipped" }], modelOk: true, ms: 0 };
  try {
    const extracted = await extractClaims(draft, rf, src);
    if (!extracted) return { checks: code, modelOk: false, ms: 0 };
    return { checks: [...code, ...claimChecks(extracted.claims, rf, src)], modelOk: true, ms: extracted.latencyMs };
  } catch (err: any) {
    console.error("replyGrounding: claim check failed (non-fatal, code checks only):", err?.message ?? err);
    return { checks: code, modelOk: false, ms: 0 };
  }
}

export async function groundReply(
  rawDraft: string,
  rf: ReplyFacts,
  src: GroundingSources,
  opts: { userId?: string | null; record?: boolean } = {},
): Promise<GroundingResult> {
  const started = Date.now();
  const draft = cleanCoMessage(rawDraft);
  const first = await check(draft, rf, src);
  const firstCheckMs = Date.now() - started;
  let result: GroundingResult;
  const failed1 = first.checks.filter((c) => !c.pass);

  if (!failed1.length) {
    result = { final: draft, outcome: first.modelOk ? "as_drafted" : "unchecked", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs };
  } else {
    let second: { checks: GateCheck[]; modelOk: boolean } | null = null;
    let rewritten: string | null = null;
    try {
      rewritten = await redraft(draft, failed1, rf, src);
      if (rewritten) {
        rewritten = cleanCoMessage(rewritten);
        second = await check(rewritten, rf, src);
      }
    } catch (err: any) {
      console.error("replyGrounding: redraft failed (non-fatal, stripping instead):", err?.message ?? err);
    }
    if (rewritten && second && second.checks.every((c) => c.pass)) {
      result = { final: rewritten, outcome: "redrafted", checks: [...first.checks, ...second.checks.map((c) => ({ ...c, name: `redraft.${c.name}` }))], latencyMs: Date.now() - started, firstCheckMs };
    } else {
      const base = rewritten && second ? rewritten : draft;
      const failed = rewritten && second ? second.checks.filter((c) => !c.pass) : failed1;
      const stripped = stripUnsupported(base, failed);
      result = {
        final: stripped.split(/\s+/).length >= 3 ? stripped : MINIMAL_FALLBACK,
        outcome: "stripped",
        checks: [...first.checks, ...(second?.checks ?? []).map((c) => ({ ...c, name: `redraft.${c.name}` }))],
        latencyMs: Date.now() - started,
        firstCheckMs,
      };
    }
  }

  if (opts.record !== false) {
    await recordDecision({
      layer: 3,
      decision: "reply.grounding",
      userId: opts.userId ?? null,
      outcome: "act",
      action: result.outcome,
      proposal: { draft, final: result.final },
      checks: result.checks,
      confidence: result.outcome === "unchecked" ? "low" : null,
      reason: result.checks.filter((c) => !c.pass).map((c) => c.reason ?? c.name).join("; ") || null,
    });
  }
  return result;
}
