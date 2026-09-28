import { findPendingOfferReactions, type PendingOfferReaction } from "./offerReactions.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { z } from "zod";
import pool from "../db/db.js";
import { CALL_OFFER_EXPIRY_DAYS } from "../agent/conversationReply.js";
import { EVENT_OFFER_EXPIRY_DAYS } from "./eventSurfacingSweep.js";
import { findPendingOutcomeFollowUp, type PendingOutcomeFollowUp } from "./recommendationOutcome.js";
import { findPendingEventCheckinFollowUp, type PendingEventCheckinFollowUp } from "./eventCheckinFollowUp.js";
import { findPendingMatchNudge, type PendingMatchNudge } from "./eventGuestMatchHandoff.js";
import {
  findPendingNetworkTease,
  findPendingNetworkIntroOffer,
  type PendingNetworkTease,
  type PendingNetworkIntroOffer,
} from "./networkIntroNudge.js";
import { MODELS } from "../models.js";
import { extractFirstJsonObject, parseModelJson } from "./modelJson.js";

// Layer 2 router (Royce, 2026-09-14). Replaces ~10 independent classifiers
// that each decided, without seeing the others, whether a message answered
// "their" open item. Confirmed in real traffic: one "yes" accepted a stale
// call offer AND opted into a match intro (placing an unwanted real call);
// "Sure" resolved a call offer, an event tease, and an outcome follow-up at
// once. Now: everything waiting on this person goes into ONE call, and plain
// code (decideActions) decides what actually runs. Every change here must
// pass evals/router/run.ts before shipping.

// Single place to change the router model.
export const ROUTER_MODEL = MODELS.sonnet;
const ROUTER_EFFORT: "low" | "medium" | "high" | undefined = "low";

export type OpenItemKind =
  | "call_offer"
  | "event_tease"
  | "outcome_followup"
  | "event_checkin"
  | "match_nudge"
  | "network_tease"
  | "network_intro"
  | "walkin_ask"
  | "offer_reaction";

export type OpenItem = {
  id: string;
  kind: OpenItemKind;
  description: string;
  // The other person's first name (match_nudge, network_intro)
  // or the event name; null when there isn't one.
  detail: string | null;
  askedAt: Date | null;
  ref?:
    | { kind: "call_offer"; memoryId: string; content: string; createdAt: Date }
    | { kind: "event_tease"; memoryId: string; content: string }
    | { kind: "outcome_followup"; pending: PendingOutcomeFollowUp }
    | { kind: "event_checkin"; pending: PendingEventCheckinFollowUp }
    | { kind: "match_nudge"; pending: PendingMatchNudge }
    | { kind: "network_tease"; pending: PendingNetworkTease }
    | { kind: "network_intro"; pending: PendingNetworkIntroOffer }
    | { kind: "walkin_ask"; eventApiId: string }
    | { kind: "offer_reaction"; pending: PendingOfferReaction };
};

// Values the router may give when answering each kind of item.
export const ANSWER_VALUES: Record<OpenItemKind, readonly string[]> = {
  call_offer: ["accept", "decline"],
  event_tease: ["yes", "no"],
  outcome_followup: ["named_positive", "named_critical", "not_mentioned"],
  event_checkin: ["named_positive", "named_critical", "not_mentioned"],
  match_nudge: ["yes", "no"],
  network_tease: ["yes", "no"],
  network_intro: ["yes", "no"],
  walkin_ask: ["answered"],
  offer_reaction: ["interested", "not_interested", "already_did_it"],
};

// One description per kind, shared by production and the eval set so the
// router sees the same wording in both. `detail` is the call offer's stored
// content, the outcome/check-in's event name, or the other person's first name.
export function describeOpenItem(kind: OpenItemKind, detail: string | null): string {
  switch (kind) {
    case "call_offer": {
      const offered = detail?.split("| Co offered:")[1]?.trim() ?? detail ?? "";
      return `Co's message that was recorded as a call offer: "${offered.slice(0, 300)}"`;
    }
    case "event_tease":
      return "Co hinted something (an event or opportunity) crossed its mind for them, without naming it, and asked if they want to hear more";
    case "outcome_followup":
      return `Co asked how "${detail ?? "a recommendation"}" went and who they met there`;
    case "event_checkin":
      return `Co asked who they met at "${detail ?? "the event"}" tonight`;
    case "match_nudge":
      return detail
        ? `Co told them about ${detail}, someone at the same event, and asked if they want to be connected`
        : "Co told them another member is going to the same event, without saying who, and asked if they'd like an intro";
    case "network_tease":
      return "Co said someone in its network crossed its mind for them, without saying who, and asked if they want to hear who";
    case "network_intro":
      return `Co named ${detail ?? "someone"} and asked if they want an introduction`;
    case "walkin_ask":
      return "They checked in at an event and Co asked what they're hoping to find there / who they'd want to meet";
    case "offer_reaction":
      return `Co sent them "${detail ?? "something"}" (with its details) and they haven't reacted to it yet. Only answer this if their message clearly reacts to it: interested ("ooh I'll check it out", "that looks good"), not_interested ("not for me", "I'll pass", "not really my thing"), or already_did_it (they say they signed up, registered, applied, or went). A bare thanks, an emoji, or talking about something else isn't a reaction`;
  }
}

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: any) {
    console.error(`messageRouter: ${label} lookup failed (non-fatal):`, err?.message ?? err);
    return null;
  }
}

// Everything currently waiting on a reply from this person, newest first.
// `skipWalkinAsk` is true on the turn the check-in text itself arrives —
// nothing has been asked yet, so nothing can be answered.
export async function gatherOpenItems(userId: string, opts: { skipWalkinAsk?: boolean } = {}): Promise<OpenItem[]> {
  const items: OpenItem[] = [];

  const [callOffer, eventTease, outcome, checkin, matchNudge, tease, intro, walkin, offerReactions] = await Promise.all([
    safe("call_offer", async () => {
      const { rows } = await pool.query(
        `SELECT p.id, p.content, p.created_at FROM co_memories p
         WHERE p.user_id = $1 AND p.memory_type = 'call_offer_pending'
         AND p.created_at > NOW() - ($2 || ' days')::interval
         AND NOT EXISTS (
           SELECT 1 FROM co_memories r
           WHERE r.user_id = $1 AND r.memory_type = 'call_offer_resolved' AND r.created_at > p.created_at
         )
         ORDER BY p.created_at DESC LIMIT 1`,
        [userId, CALL_OFFER_EXPIRY_DAYS],
      );
      return rows[0] ?? null;
    }),
    safe("event_tease", async () => {
      const { rows } = await pool.query(
        `SELECT p.id, p.content, p.created_at FROM co_memories p
         WHERE p.user_id = $1 AND p.memory_type = 'event_offer_pending'
         AND p.created_at > NOW() - ($2 || ' days')::interval
         AND NOT EXISTS (
           SELECT 1 FROM co_memories r
           WHERE r.user_id = $1 AND r.memory_type = 'event_offer_resolved' AND r.created_at > p.created_at
         )
         ORDER BY p.created_at DESC LIMIT 1`,
        [userId, EVENT_OFFER_EXPIRY_DAYS],
      );
      return rows[0] ?? null;
    }),
    safe("outcome_followup", () => findPendingOutcomeFollowUp(userId)),
    safe("event_checkin", () => findPendingEventCheckinFollowUp(userId)),
    safe("match_nudge", () => findPendingMatchNudge(userId)),
    safe("network_tease", () => findPendingNetworkTease(userId)),
    safe("network_intro", () => findPendingNetworkIntroOffer(userId)),
    opts.skipWalkinAsk
      ? Promise.resolve(null)
      : safe("walkin_ask", async () => {
          const { rows } = await pool.query(
            `SELECT event_api_id, checked_in_at FROM event_walkin_checkins
             WHERE person_id = $1 AND ask_text IS NULL AND checked_in_at > NOW() - INTERVAL '1 day'
             ORDER BY checked_in_at DESC LIMIT 1`,
            [userId],
          );
          return rows[0] ?? null;
        }),
    safe("offer_reaction", () => findPendingOfferReactions(userId)),
  ]);

  if (callOffer) {
    items.push({
      id: `call_offer:${callOffer.id}`,
      kind: "call_offer",
      description: describeOpenItem("call_offer", String(callOffer.content)),
      detail: null,
      askedAt: new Date(callOffer.created_at),
      ref: { kind: "call_offer", memoryId: callOffer.id, content: callOffer.content, createdAt: new Date(callOffer.created_at) },
    });
  }
  if (eventTease) {
    items.push({
      id: `event_tease:${eventTease.id}`,
      kind: "event_tease",
      description: describeOpenItem("event_tease", null),
      detail: null,
      askedAt: new Date(eventTease.created_at),
      ref: { kind: "event_tease", memoryId: eventTease.id, content: eventTease.content },
    });
  }
  if (outcome) {
    const at = await safe("outcome sent_at", async () => (await pool.query(`SELECT sent_at FROM recommendation_outcome_followups WHERE id = $1`, [outcome.id])).rows[0]?.sent_at);
    items.push({
      id: `outcome_followup:${outcome.id}`,
      kind: "outcome_followup",
      description: describeOpenItem("outcome_followup", outcome.match_name),
      detail: outcome.match_name,
      askedAt: at ? new Date(at) : null,
      ref: { kind: "outcome_followup", pending: outcome },
    });
  }
  if (checkin) {
    const at = await safe("checkin sent_at", async () => (await pool.query(`SELECT sent_at FROM event_checkin_followups WHERE id = $1`, [checkin.id])).rows[0]?.sent_at);
    items.push({
      id: `event_checkin:${checkin.id}`,
      kind: "event_checkin",
      description: describeOpenItem("event_checkin", checkin.event_name),
      detail: checkin.event_name,
      askedAt: at ? new Date(at) : null,
      ref: { kind: "event_checkin", pending: checkin },
    });
  }
  if (matchNudge) {
    const at = await safe("match nudge sent_at", async () =>
      (await pool.query(`SELECT MAX(sent_at) AS at FROM event_guest_match_nudges WHERE person_id = $1 AND event_id = $2 AND candidate_id = $3`, [userId, matchNudge.event_id, matchNudge.candidate_id])).rows[0]?.at,
    );
    items.push({
      id: `match_nudge:${matchNudge.event_id}:${matchNudge.candidate_id}`,
      kind: "match_nudge",
      // Never the name for an anonymous heads-up: this text reaches the reply.
      description: describeOpenItem("match_nudge", matchNudge.anonymous ? null : matchNudge.candidate_first_name),
      detail: matchNudge.anonymous ? null : matchNudge.candidate_first_name,
      askedAt: at ? new Date(at) : null,
      ref: { kind: "match_nudge", pending: matchNudge },
    });
  }
  if (tease) {
    const at = await safe("network tease created_at", async () =>
      (await pool.query(`SELECT MAX(created_at) AS at FROM co_memories WHERE user_id = $1 AND memory_type = 'network_offer_pending'`, [userId])).rows[0]?.at,
    );
    items.push({
      id: `network_tease:${tease.askId}`,
      kind: "network_tease",
      description: describeOpenItem("network_tease", null),
      detail: null,
      askedAt: at ? new Date(at) : null,
      ref: { kind: "network_tease", pending: tease },
    });
  }
  if (intro) {
    const at = await safe("network intro created_at", async () =>
      (await pool.query(`SELECT MAX(created_at) AS at FROM co_memories WHERE user_id = $1 AND memory_type = 'network_intro_offer_pending'`, [userId])).rows[0]?.at,
    );
    items.push({
      id: `network_intro:${intro.candidate.candidate_id}`,
      kind: "network_intro",
      description: describeOpenItem("network_intro", intro.candidate.first_name),
      detail: intro.candidate.first_name,
      askedAt: at ? new Date(at) : null,
      ref: { kind: "network_intro", pending: intro },
    });
  }
  if (walkin) {
    items.push({
      id: `walkin_ask:${walkin.event_api_id}`,
      kind: "walkin_ask",
      description: describeOpenItem("walkin_ask", null),
      detail: null,
      askedAt: walkin.checked_in_at ? new Date(walkin.checked_in_at) : null,
      ref: { kind: "walkin_ask", eventApiId: walkin.event_api_id },
    });
  }

  for (const o of offerReactions ?? []) {
    items.push({
      id: `offer_reaction:${o.id}`,
      kind: "offer_reaction",
      description: describeOpenItem("offer_reaction", o.itemName),
      detail: o.itemName,
      askedAt: o.sentAt,
      ref: { kind: "offer_reaction", pending: o },
    });
  }

  items.sort((a, b) => (b.askedAt?.getTime() ?? 0) - (a.askedAt?.getTime() ?? 0));
  return items;
}

const routerOutputSchema = z.object({
  // A model sometimes returns {} instead of null; treat that as null.
  answers: z.preprocess(
    (v) => (v && typeof v === "object" && (v as any).itemId && (v as any).value ? v : null),
    z.object({ itemId: z.string(), value: z.string() }).nullable(),
  ),
  ambiguousBetween: z.array(z.string()).default([]),
  call: z.enum(["explicit_request", "asks_about_calling", "schedule_request", "cancel_scheduled_call", "would_benefit", "none"]),
  wantsRecommendation: z.boolean(),
  // Everything in the message besides the ask itself (a feeling, news, a
  // second question), or null when the message is only the ask. Missing
  // means the router didn't say (callers fall back to their own check).
  beyondAsk: z.preprocess((v) => (typeof v === "string" ? (v.trim() ? v.trim() : null) : v), z.string().nullable()).optional(),
  // A short question to ask before searching, when what they want could mean
  // clearly different things; null when it's clear enough to search.
  askUnclear: z.preprocess((v) => (typeof v === "string" ? (v.trim() ? v.trim() : null) : v), z.string().nullable()).optional(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().default(""),
});

export type RouterOutput = z.infer<typeof routerOutputSchema>;

// The router's fields from a JSON object that may carry more (services/readTurn.ts adds its own).
export function parseRouterOutput(obj: unknown): RouterOutput {
  return routerOutputSchema.parse(obj);
}

export type RouteInput = {
  message: string;
  recentConversation: string;
  openItems: Pick<OpenItem, "id" | "kind" | "description" | "askedAt">[];
  declinedCallTopics?: string[];
  now?: Date;
};

function ago(at: Date | null, now: Date): string {
  if (!at) return "time unknown";
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}


export function buildRouterPrompt(input: RouteInput): string {
  const now = input.now ?? new Date();
  const itemsBlock = input.openItems.length
    ? input.openItems
        .map((it) => `- id "${it.id}" (${it.kind}, asked ${ago(it.askedAt, now)}): ${it.description}. Allowed values: ${ANSWER_VALUES[it.kind].join(" | ")}`)
        .join("\n")
    : "(nothing is waiting on a reply from them)";
  const declined = input.declinedCallTopics?.length
    ? `\nCo previously offered a call about these, and they said no each time:\n${input.declinedCallTopics.map((t) => `- ${t}`).join("\n")}\n"Essentially the same situation" means the same underlying topic or feeling, even if worded completely differently: "building solo without a cofounder, don't know other founders locally" and "still feeling isolated without other founders around" are the SAME situation (solo-founder isolation). Read for the real thing underneath the phrasing, not a text match. If what they describe now is essentially the same situation as any of these, "would_benefit" does not apply — use "none". A genuinely different topic is still free to be "would_benefit".\n`
    : "";

  return `You route one inbound text message for Co, a companion people text. Decide what the latest message is doing. You only classify; other code acts on your answer.

Recent conversation, in order (read it: short replies only make sense against what Co last said):
${input.recentConversation || "(start of the conversation)"}

Their latest message: "${input.message}"

Things Co has asked that are still waiting on a reply from them (newest first, where known):
${itemsBlock}
${declined}
Return ONLY a JSON object:
{"reason": "one short sentence: what their message is doing", "answers": {"itemId": "...", "value": "..."} or null, "ambiguousBetween": [itemIds], "call": "...", "wantsRecommendation": true/false, "beyondAsk": "..." or null, "askUnclear": "..." or null, "confidence": "high" | "medium" | "low"}
Write "reason" first, then make every other field agree with it: if your reason says the message isn't answering a waiting item, answers must be null.

answers — which waiting item (if any) the latest message is actually replying to:
- Only set it if the message is genuinely a reply to that item. If they're just talking, or replying to something else Co said, use null. Having an item open does not make every message an answer to it.
- A short reply ("yes", "sure", "for sure", "no", "I'm interested") answers what Co asked most recently. Look at Co's last messages in the conversation: if Co's most recent message asked something that is not one of the waiting items, the short reply answers that, and answers is null.
- If a short reply could just as plausibly answer two or more waiting items and the conversation does not make clear which, set answers to null and list those item ids in ambiguousBetween. In particular, when Co asked two or more waiting questions back to back with no reply from them in between, a short reply that doesn't name or refer to one of them ("sure", "yes", "ok do it") is ambiguous between those questions, even though one was sent slightly later.
- A bare acknowledgment ("thanks", "ok", "got it", "sounds good", "cool", "nice", "bet") is not a yes to anything.
- Tapback reactions such as "Liked “…”", "Loved “…”", "Emphasized “…”", "Laughed at “…”" are reactions to a message, not answers or requests.
- call_offer: "accept" only if they clearly say yes to Co calling them. If the recorded "call offer" is really Co telling them they can call Co's number, or is not actually an offer for Co to call them, it cannot be accepted: never answer it with "accept". Saying they'd rather keep texting, or no to a call, is "decline".
- outcome_followup / event_checkin: "named_positive" = they name or describe someone specific they met, or a specific good outcome ("met a product person at LinkedIn and an investor" counts, no names needed); "named_critical" = a real negative assessment ("waste of time", "nobody interesting"), with or without a name; "not_mentioned" = neutral or non-committal ("it was fine", "didn't go", "no one really"). Talking about something unrelated is not an answer.
- match_nudge / network_intro: "yes" = they want to be connected/introduced to that specific person; "no" = passing.
- event_tease / network_tease: "yes" = they want to hear more / hear who; "no" = passing.
- walkin_ask: "answered" if their message says what they hope to find or who they want to meet.

call — about Co calling them:
- "explicit_request": they directly ask Co to call them now, or to talk by phone with no future time ("call me", "can you call me", "call me right now"). A command, not a question about the feature. Not this if they only mention a call while questioning, declining, or complaining about one ("why did you call me", "stop calling"). When a call request and some other waiting item are both possible, a call request does not also answer the other item.
- "asks_about_calling": a question about whether or how PHONE CALLS with Co work ("can I just call you?", "how do I call you back?"). Questions about other Co features (memory, APIs, how it works in general) are "none". When in doubt between a call request and a question about calling, it's the question.
- "schedule_request": a call at a specific future date/time, including changing a time already set ("push that to 4pm"), even if the time is only complete combined with earlier messages.
- "cancel_scheduled_call": cancel a scheduled call, with no new time.
- "would_benefit": none of the above, but what they're describing is complex or emotional enough that voice would genuinely help. Never for short, light, or logistical messages.
- "none": anything else. Accepting or declining a waiting call offer goes in answers, not here (use "none").

wantsRecommendation — they're asking Co to find, suggest, or surface something concrete in the world right now (events, programs, people, opportunities): "find me a networking event", "anything real you can find for me", "found anything for me?", "have you surfaced anything lately?", "don't see anything on X?", "anything on Twitter?", "point me in the right direction" (after Co offered to look), "I want to look for some friends", "what's the vibes for Sunday?" (asking what's on then). It can be true alongside an answer ("never mind the call, can you find me a founder event"). false when: Not when they only ask what's new or changed with Co itself ("Updates?", "what's new?"): Co answers that on its own, without a search.
- they're only answering a waiting item ("yes", "tell me more"), or asking about something Co already sent ("what did you send me", "where's the link?", "any details?", "who is hosting it?");
- a false-premise callback ("that job posting you sent me, is it still open") when the conversation shows Co never sent it;
- they want Co's own opinion or advice (how to fix something, help planning their pitch, feedback on their build);
- venting or telling Co about their life.

beyondAsk — when wantsRecommendation is true, separate the ask from everything else in the message. The ask is what they want found, including its time frame, place, and who it's for ("tech week, Oct 5th - Oct 11th?" is one ask; "anything about VC looking to fund?" is one ask). beyondAsk is anything else that needs a real response: a feeling ("ugh rough week"), news about their life ("wasn't feeling the mixer"), a second, different question, or a reaction to something Co said. Write it in a few plain words ("rough week", "asked about Maya too"), or null when the message is only the ask. A feeling or life update is never part of the ask. null when wantsRecommendation is false.

askUnclear — when wantsRecommendation is true, a short, plain question to ask them first if what they want could reasonably mean two clearly different things, so searching would be a guess (Royce, 2026-09-18: "if you don't have an understanding of the context... ask clarifying questions... rather than just sending them anything"). Example: a founder asking "anyone hiring a design engineer?" could be hiring one or looking for a role, so: "Are you looking to hire a design engineer, or looking for a design engineer role?" null whenever the ask is clear enough to act on, including broad ones ("anything happening this weekend?", "any founder events?") and ones the conversation already makes clear. Never ask about details you could reasonably search broadly for.

confidence — "high" if the read is unambiguous, "medium" if it's the most reasonable read but another is possible, "low" if you're guessing.`;
}

export type RouteResult = { output: RouterOutput; latencyMs: number; inputTokens: number; outputTokens: number };

export async function routeMessage(input: RouteInput, opts: { model?: string; effort?: "low" | "medium" | "high" | null } = {}): Promise<RouteResult> {
  const model = opts.model ?? ROUTER_MODEL;
  const effort = opts.effort === undefined ? ROUTER_EFFORT : opts.effort ?? undefined;
  const started = Date.now();
  const { text, usage } = await generateText({
    model: anthropic(model),
    maxOutputTokens: 4000,
    providerOptions: effort && !model.startsWith("claude-haiku") ? { anthropic: { effort } } : undefined,
    experimental_telemetry: { isEnabled: true, functionId: "router.route" },
    prompt: buildRouterPrompt(input),
  });
  const json = extractFirstJsonObject(text.replace(/```(?:json)?/g, ""));
  if (!json) throw new Error(`router returned no JSON: ${text.slice(0, 200)}`);
  const parsed = routerOutputSchema.parse(JSON.parse(json));
  return {
    output: parsed,
    latencyMs: Date.now() - started,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

// Fail-safe when the router call itself errors: act on nothing, so a model
// outage can never place a call or resolve the wrong item.
export const NO_ROUTE: RouterOutput = {
  answers: null,
  ambiguousBetween: [],
  call: "none",
  wantsRecommendation: false,
  confidence: "low",
  reason: "router unavailable",
};

type RoutableItem = Pick<OpenItem, "id" | "kind" | "description" | "detail">;

export type Decision<T extends RoutableItem = RoutableItem> = {
  resolve: { item: T; value: string } | null;
  placeCall: boolean;
  scheduleCall: boolean;
  cancelCall: boolean;
  answerCallingQuestion: boolean;
  callWouldBenefit: boolean;
  wantsRecommendation: boolean;
  // Router's read of what else the message holds besides the ask; undefined
  // when it didn't say.
  beyondAsk?: string | null;
  clarifyContext: string;
  // What the clarifying question is about, if any: which waiting item they
  // meant, or whether they want a call.
  clarifyAbout: "items" | "call" | "ask" | null;
};

export function isIrreversible(kind: OpenItemKind, value: string): boolean {
  return (
    (kind === "call_offer" && value === "accept") ||
    (kind === "match_nudge" && value === "yes") ||
    (kind === "network_intro" && value === "yes")
  );
}

function plainOption(item: Pick<OpenItem, "kind" | "description">): string {
  switch (item.kind) {
    case "call_offer":
      return "a call with Co";
    case "event_tease":
      return "hearing more about the event or opportunity Co mentioned";
    case "network_tease":
      return "hearing who Co had in mind";
    case "offer_reaction":
      return `what Co sent about ${item.description.match(/"([^"]+)"/)?.[1] ?? "something"}`;
    default:
      return item.description.replace(/^Co /, "").slice(0, 120);
  }
}

// Pure code gates: what actually runs. Irreversible actions need a clear,
// high-confidence, unambiguous read; otherwise nothing resolves and the reply
// asks which one they meant.
// Co's most recent turn: the Co lines after their previous message, before
// the one being routed (and any identical repeats of it). Empty across a
// "[— 2 days later —]" gap, since nothing that old is a fresh ask.
export function lastCoTurn(recentConversation: string): string {
  const entries: string[] = [];
  for (const line of recentConversation.split("\n")) {
    if (/^(User said:|Co replied:|\[—)/.test(line) || !entries.length) entries.push(line);
    else entries[entries.length - 1] += `\n${line}`;
  }
  while (entries.length && entries[entries.length - 1].startsWith("User said:")) entries.pop();
  const co: string[] = [];
  for (let i = entries.length - 1; i >= 0 && entries[i].startsWith("Co replied:"); i--) co.unshift(entries[i]);
  return co.join("\n");
}

// Deterministic check that an irreversible yes is answering something Co
// actually just asked, or that names it outright. Confirmed in the eval
// (c148): a bare "yes" to an unrelated Co question was read as opting into a
// match intro that was open but hadn't been mentioned in the conversation.
export function askIsFresh(item: Pick<OpenItem, "kind" | "detail">, message: string, recentConversation: string): boolean {
  const text = `${lastCoTurn(recentConversation)}\n${message}`;
  switch (item.kind) {
    case "call_offer":
      return /\b(call|calling|voice|phone|talk (it|this|that) through)\b/i.test(text);
    case "match_nudge":
    case "network_intro":
      return item.detail ? text.toLowerCase().includes(item.detail.toLowerCase()) : /connect|introduc|meet/i.test(text);
    default:
      return true;
  }
}

// Co's last turn asked more than one question while more than one item is
// open, and the reply doesn't name which: an irreversible yes can't be
// assigned to either (eval s11: "sure" after a tease question and an intro
// question). Resolves nothing and asks which they meant.
export function coAskedSeveralThings(openItems: Pick<OpenItem, "detail">[], turn: { message: string; recentConversation: string }): boolean {
  if (openItems.length < 2) return false;
  const questions = (lastCoTurn(turn.recentConversation).match(/\?/g) ?? []).length;
  if (questions < 2) return false;
  const msg = turn.message.toLowerCase();
  const namesOne = openItems.some((i) => i.detail && msg.includes(i.detail.toLowerCase()));
  return !namesOne;
}

// A follow-up question ("how did X go?", "who did you meet?") only counts as
// answered if Co's most recent turn isn't a different question. Eval c098:
// "not much really, just busy" answered Co's greeting question, but an older
// outcome follow-up was resolved as "not mentioned".
export function followUpStillCurrent(item: Pick<OpenItem, "kind" | "detail">, recentConversation: string): boolean {
  if (item.kind !== "outcome_followup" && item.kind !== "event_checkin") return true;
  const last = lastCoTurn(recentConversation);
  if (!last || !last.includes("?")) return true;
  if (/\bhow('d| did| was)\b[^?]{0,40}\b(go|went|it)\b|\bhow was\b|\bwho did you\b|\bdid you (go|make it|end up)\b|\b(meet|met|talk(ed)? to) anyone\b/i.test(last)) return true;
  const detailWords = (item.detail ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  return detailWords.some((w) => last.toLowerCase().includes(w));
}

export function decideActions<T extends RoutableItem>(
  out: RouterOutput,
  openItems: T[],
  turn: { message: string; recentConversation: string },
): Decision<T> {
  const d: Decision<T> = {
    resolve: null,
    placeCall: false,
    scheduleCall: false,
    cancelCall: false,
    answerCallingQuestion: false,
    callWouldBenefit: false,
    wantsRecommendation: false,
    clarifyContext: "",
    clarifyAbout: null,
  };

  const byId = new Map(openItems.map((i) => [i.id, i]));
  const ambiguous = [...new Set(out.ambiguousBetween)].map((id) => byId.get(id)).filter((i): i is NonNullable<typeof i> => !!i);

  if (ambiguous.length >= 2) {
    d.clarifyContext = `\nTheir message could be answering more than one thing you asked: ${ambiguous
      .map(plainOption)
      .join(", or ")}. Don't assume. Ask them briefly and naturally which one they meant, in one short line. Don't act on either yet.`;
    d.clarifyAbout = "items";
  } else if (out.answers) {
    const item = byId.get(out.answers.itemId);
    const valueOk = item && ANSWER_VALUES[item.kind].includes(out.answers.value);
    if (item && valueOk) {
      const irreversible = isIrreversible(item.kind, out.answers.value);
      const ok = irreversible
        ? out.confidence === "high" && askIsFresh(item, turn.message, turn.recentConversation) && !coAskedSeveralThings(openItems, turn)
        : out.confidence !== "low" && followUpStillCurrent(item, turn.recentConversation);
      if (ok) {
        d.resolve = { item, value: out.answers.value };
      } else if (irreversible) {
        d.clarifyContext = `\nIt sounds like they might be saying yes to ${plainOption(item)}, but it isn't clear. Don't act on it yet. Check with them briefly, in one short line, that that's what they meant.`;
        d.clarifyAbout = "items";
      }
    }
  }

  // Placing a call is irreversible: only on a high-confidence explicit
  // request, or a high-confidence accept of a real open offer (resolved above).
  // A future time or a cancel always wins over "call now", even if the
  // router also read it as accepting the offer (eval c105: "can you call me
  // tomorrow at 2pm" must schedule, never dial).
  const wantsLater = out.call === "schedule_request" || out.call === "cancel_scheduled_call";
  if (wantsLater) {
    // fall through to schedule/cancel below
  } else if (d.resolve?.item.kind === "call_offer" && d.resolve.value === "accept") {
    d.placeCall = true;
  } else if (out.call === "explicit_request") {
    if (out.confidence === "high") {
      d.placeCall = true;
    } else if (!d.clarifyContext) {
      d.clarifyContext = `\nThey may be asking you to call them, but it isn't clear. Don't place a call. Ask briefly whether they want you to call them now.`;
      d.clarifyAbout = "call";
    }
  }
  if (!d.placeCall) {
    d.scheduleCall = out.call === "schedule_request";
    d.cancelCall = out.call === "cancel_scheduled_call";
    d.answerCallingQuestion = out.call === "asks_about_calling";
    d.callWouldBenefit = out.call === "would_benefit";
  }

  d.wantsRecommendation = out.wantsRecommendation;
  if (out.beyondAsk !== undefined) d.beyondAsk = out.wantsRecommendation ? out.beyondAsk : null;
  // Unclear what they want: ask first instead of searching on a guess.
  if (out.wantsRecommendation && out.askUnclear && !d.clarifyContext) {
    d.wantsRecommendation = false;
    d.clarifyContext = `\nWhat they're asking for could mean different things, so don't search or suggest anything yet. Ask them this, in your own words, as one short question: ${out.askUnclear}`;
    d.clarifyAbout = "ask";
  }
  return d;
}
