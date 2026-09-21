// The message router's classification half, asked of Jev (see services/jev.ts).
// Mirrors services/messageRouter.ts: which waiting item a message answers, what
// it does about calling, and whether it asks for a search, an invite, or the
// update list. It leaves out the router's free-text fields (beyondAsk,
// askUnclear, reason), which need a model that writes.
//
// A Jev answer per waiting item is asked in parallel: "is this a reply to it?"
// and "what did they answer?". Code then picks the item, the same way the
// router's own code gates do, so a wrong yes can't place a call: the same
// decideActions gates still run on top of what this returns.
import { askJev, choiceOf, confidenceLabel, DEFAULT_THRESHOLDS, jevShadowEnabled, noulP, type JevQuestion, type JevThresholds } from "./jev.js";
import { recordShadow } from "./jevClassifiers.js";
import { ANSWER_VALUES, type OpenItemKind, type RouteInput, type RouterOutput } from "./messageRouter.js";

const CALL_CHOICES: Record<string, string> = {
  explicit_request:
    'They directly ask Co to call them now, or to talk by phone with no future time ("call me", "can you call me"). A command, not a question about the feature. Not this if they only mention a call while questioning, declining, or complaining about one ("why did you call me", "stop calling").',
  asks_about_calling:
    'A question about whether or how PHONE CALLS with Co work ("can I just call you?", "how do I call you back?"). Questions about other Co features (memory, APIs, how it works in general) are not this. When in doubt between a call request and a question about calling, it is the question.',
  schedule_request:
    'A call at a specific future date or time, including changing a time already set ("push that to 4pm"), even if the time is only complete combined with earlier messages.',
  cancel_scheduled_call: "Cancel a scheduled call, with no new time.",
  would_benefit:
    "None of the above, but what they describe is complex or emotional enough that voice would genuinely help. Never for short, light, or logistical messages.",
  none: "Anything else. Accepting or declining a waiting call offer is not a call request; use none.",
};

// What each answer value means, per kind of waiting item (from the router's rules).
const VALUE_MEANING: Partial<Record<OpenItemKind, Record<string, string>>> = {
  call_offer: {
    accept: "They clearly say yes to Co calling them.",
    decline: "They say no to a call, or say they'd rather keep texting.",
  },
  outcome_followup: {
    named_positive: "They name or describe someone specific they met, or a specific good outcome (no names needed).",
    named_critical: 'A real negative assessment ("waste of time", "nobody interesting"), with or without a name.',
    not_mentioned: 'Neutral or non-committal ("it was fine", "didn\'t go", "no one really").',
  },
  event_checkin: {
    named_positive: "They name or describe someone specific they met, or a specific good outcome (no names needed).",
    named_critical: 'A real negative assessment ("waste of time", "nobody interesting"), with or without a name.',
    not_mentioned: 'Neutral or non-committal ("it was fine", "didn\'t go", "no one really").',
  },
  match_nudge: { yes: "They want to be connected or introduced to that specific person.", no: "They are passing." },
  network_intro: { yes: "They want to be connected or introduced to that specific person.", no: "They are passing." },
  event_tease: { yes: "They want to hear more.", no: "They are passing." },
  network_tease: { yes: "They want to hear who.", no: "They are passing." },
  walkin_ask: { answered: "Their message says what they hope to find or who they want to meet." },
  offer_reaction: {
    interested: 'They react with interest ("ooh I\'ll check it out").',
    not_interested: "They say it isn't for them.",
    already_did_it: "They say they already did it or applied.",
  },
};

const REPLY_RULES =
  "Only yes if the message is genuinely a reply to THIS waiting item. If they are just talking, or replying to something else Co said, it is no. A short reply (yes, sure, no, I'm interested) answers what Co asked MOST RECENTLY in the recent conversation; if Co's most recent message asked something that is not this item, the short reply answers that instead. A bare acknowledgment (thanks, ok, got it, sounds good, cool, nice) is not a yes to anything. Tapback reactions (Liked, Loved, Emphasized, Laughed at) are reactions, not answers.";

export type JevRouted = {
  output: RouterOutput;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  // The raw probabilities, for the shadow log and for tuning thresholds.
  detail: { call: string; callConfidence: number; pRec: number; pInvite: number; pUpdates: number; replies: number[] };
};

export async function routeWithJev(input: RouteInput, t: JevThresholds = DEFAULT_THRESHOLDS): Promise<JevRouted | null> {
  const items = input.openItems;
  const state = {
    latest_message: input.message,
    // Their docs: accuracy falls as unrelated state grows. Keep the recent turns only.
    recent_conversation: input.recentConversation.length > 1800 ? input.recentConversation.slice(-1800) : input.recentConversation,
    waiting_items: items.map((it, i) => ({ n: i + 1, what_co_asked: it.description })),
  };

  const questions: Record<string, JevQuestion> = {
    call: {
      type: "choice",
      instructions: "What is their latest message doing about Co calling them?",
      criteria: CALL_CHOICES,
    },
    wants_recommendation: {
      type: "noul",
      instructions:
        'Are they asking Co to find, suggest, or surface something concrete in the world right now (events, programs, people, opportunities), like "find me a networking event", "anything real you can find for me", "found anything for me?", "what\'s the vibes for Sunday?"?',
      criteria: {
        true: "A request to find or surface something concrete right now.",
        false:
          'They are only answering a waiting item, asking about something Co already sent ("where\'s the link?", "who is hosting it?"), a false-premise callback, wanting Co\'s own opinion or advice, or venting or telling Co about their life.',
      },
    },
    wants_invite: {
      type: "noul",
      instructions:
        'Do they want to bring someone into Co itself: asking for an invite, how a friend can join or get in, asking Co to add someone or send them a code, or how many invites they have left ("can my friend Sam join?", "send my friend a code")?',
      criteria: {
        true: "They want to bring a person into Co.",
        false: 'Bringing someone to an event ("can I bring a friend to Sunday\'s dinner?"), just talking about a friend, or telling Co they were invited somewhere.',
      },
    },
    asks_for_updates: {
      type: "noul",
      instructions: 'Are they asking what is new or changed with Co itself ("any updates?", "what\'s new?")?',
      criteria: {
        true: 'A bare updates question ("Updates?", "any updates for me?").',
        false: 'A casual greeting, "found anything for me?" (a search ask), an update on their own week, or updates on a named topic ("any updates on the grants?").',
      },
    },
  };
  items.forEach((it, i) => {
    questions[`reply_${i}`] = {
      type: "noul",
      instructions: `Is their latest message genuinely a reply to waiting item ${i + 1}, where Co asked: ${it.description}? ${REPLY_RULES}`,
    };
    const allowed = ANSWER_VALUES[it.kind] ?? [];
    const meaning = VALUE_MEANING[it.kind] ?? {};
    questions[`value_${i}`] = {
      type: "choice",
      instructions: `If their latest message is a reply to waiting item ${i + 1} (${it.description}), what did they answer?`,
      criteria: Object.fromEntries(allowed.map((v) => [v, meaning[v] ?? null])),
    };
  });

  const r = await askJev(state, questions);
  if (!r) return null;

  const pRec = noulP(r.answers.wants_recommendation);
  const pInvite = noulP(r.answers.wants_invite);
  const pUpdates = noulP(r.answers.asks_for_updates);
  const call = choiceOf(r.answers.call);
  if (pRec === null || pInvite === null || pUpdates === null || !call) return null;

  const replies = items.map((_, i) => noulP(r.answers[`reply_${i}`]) ?? 0);
  const ranked = replies.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
  const best = ranked[0];
  const second = ranked[1];
  const isReply = !!best && best.p >= t.yes;
  // Two waiting items both plausibly answered and too close to call: ambiguous, so code asks which.
  const ambiguous = isReply && !!second && second.p >= t.yes && best.p - second.p < 0.15;

  let answers: RouterOutput["answers"] = null;
  const conf: number[] = [];
  if (isReply && !ambiguous) {
    const value = choiceOf(r.answers[`value_${best.i}`]);
    if (value) {
      answers = { itemId: items[best.i].id, value: value.choice };
      conf.push(best.p, value.confidence);
    }
  }
  if (call.choice !== "none") conf.push(call.confidence);

  const output: RouterOutput = {
    answers,
    ambiguousBetween: ambiguous ? [items[best.i].id, items[second.i].id] : [],
    call: call.choice as RouterOutput["call"],
    wantsRecommendation: pRec >= t.yes,
    asksForUpdates: pUpdates >= t.yes,
    wantsInvite: pInvite >= t.yes,
    // The router's own confidence gates irreversible actions; here it is the weakest
    // of the answers that actually matter for this message.
    confidence: confidenceLabel(conf.length ? Math.min(...conf) : 1, t),
    reason: "jev",
  };
  return {
    output,
    latencyMs: r.ms,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    detail: { call: call.choice, callConfidence: call.confidence, pRec, pInvite, pUpdates, replies },
  };
}

// What the shadow log compares between the two routers.
export function routerView(o: Pick<RouterOutput, "answers" | "ambiguousBetween" | "call" | "wantsRecommendation" | "asksForUpdates"> & { wantsInvite?: boolean }) {
  return {
    answers: o.answers ? `${o.answers.itemId}=${o.answers.value}` : null,
    ambiguous: o.ambiguousBetween.length > 0,
    call: o.call,
    rec: o.wantsRecommendation,
    updates: o.asksForUpdates,
    invite: !!o.wantsInvite,
  };
}

// Runs Jev's read of the same message beside the router's, on co-test only (see
// jevShadowEnabled). Compares what would act, not the free-text reason. Safe to
// call without awaiting; never throws.
export async function shadowRoute(userId: string, input: RouteInput, current: RouterOutput): Promise<void> {
  if (!jevShadowEnabled(process.env, "router")) return;
  try {
    const started = Date.now();
    const jev = await routeWithJev(input);
    if (!jev) return;
    const a = routerView(current);
    const b = routerView(jev.output);
    const agree = JSON.stringify(a) === JSON.stringify(b);
    await recordShadow("router", userId, a, { ...b, confidence: jev.output.confidence, ...jev.detail }, agree, Date.now() - started);
  } catch (err: any) {
    console.error("jev: router shadow failed (non-fatal):", err?.message ?? err);
  }
}
