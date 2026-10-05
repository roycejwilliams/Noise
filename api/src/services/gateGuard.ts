// Loop protection for the invite-code gate (2026-09-21). On 09-20 an automated
// reply service (a business autoresponder, not a person) answered Co's invite
// prompts with unsubscribe and auto-reply text, and Co answered every one of
// those with "that code didn't take": 32 texts in 3 minutes to a stranger's
// number, and the daily review flagged it as a broken bot. Two rules:
//
//   1. Co never replies to a message that reads as automated (unsubscribe
//      notices, "do not reply", verification codes, out-of-office, bare STOP).
//   2. Co sends an unverified number at most GATE_REPLY_BUDGET gate replies
//      (the first ask plus wrong-code replies) in any 24 hours. A real person
//      mistyping a code has a few tries; two bots can't loop.
//
// Only applies before a number is verified. A member's own "stop" is handled
// by the normal flow.
import pool from "../db/db.js";
import { GATE_ASK, WRONG_CODE } from "./onboardingLines.js";

// 2 (was 5): the greeting plus one retry. 2026-09-24, a clinic's marketing
// bot got three replies before it stopped; Royce: "I don't want our model to
// respond to them at all. It wastes our money." A real person who mistypes
// twice can text again tomorrow.
export const GATE_REPLY_BUDGET = { max: 2, windowHours: 24 };

const AUTOMATED: RegExp[] = [
  /^\s*(?:stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]?\s*$/i,
  /\b(?:reply|text|send)\s+(?:"|')?(?:stop|end|unsubscribe|cancel|quit)\b/i,
  /\bunsub(?:scrib\w*|all)?\b|\bresub(?:all)?\b/i,
  /\bwe\s+(?:don['’]t|do\s+not)\s+accept\s+(?:inbound|incoming|replies|messages)/i,
  /\bcommands\s+you\s+can\s+use\b/i,
  /\bto\s+stop\b.*\b(?:sms|texts?)\b|\b(?:sms|texts?)\b.*\bto\s+stop\b/i,
  /\byou(?:['’]ve|['’]re|\s+have|\s+are)?\s+(?:been\s+)?(?:opted|unsubscribed)\b/i,
  /\bmsg\s*&\s*data\s*rates\b|\bmessage\s+and\s+data\s+rates\b/i,
  /\bthis\s+(?:number|line|inbox)\s+(?:is|isn['’]t|is\s+not)\s+(?:monitored|checked|able)/i,
  /\b(?:do\s+not|don['’]t)\s+reply\b|\bno[-\s]?reply\b/i,
  /\bauto[-\s]?(?:reply|response|responder|generated)\b|\bautomated\s+(?:message|reply|response|text)\b/i,
  /\bout\s+of\s+(?:the\s+)?office\b/i,
  /\b(?:verification|security|login|one[-\s]?time|confirmation)\s+code\s*(?:is|:)\s*\d{4,8}\b/i,
  /\b\d{4,8}\s+is\s+your\b/i,
  // 2026-09-24, a clinic's marketing bot: "...Want us to call you to
  // schedule? Reply YES or call us at 813-...", then "We are sorry, we did
  // not understand your response. Please reply using YES or NO." twice.
  /\breply\s+(?:with\s+|using\s+)?["'“]?(?:yes|y)["'”]?(?:\s+(?:or|\/)\s+["'“]?(?:no|n)["'”]?)?(?:\s+(?:to|or|if)\b|\s*[.!,]|\s*$)/i,
  /\bwe\s+(?:are\s+sorry,?\s+we\s+)?(?:did\s+not|didn['’]t|could\s+not|couldn['’]t)\s+understand\s+your\s+(?:response|reply|message)/i,
  /\bcall\s+us\s+(?:at|on|today)\b/i,
  /\b(?:invalid|unrecognized)\s+(?:response|reply|keyword|input|command)\b/i,
];

export function looksAutomated(text: string): boolean {
  const t = (text ?? "").trim();
  return !!t && AUTOMATED.some((re) => re.test(t));
}

export type GateDecision = "send" | "silent_automated" | "silent_budget";

// Pure: whether Co may answer this unverified number's message at all.
export function decideGateReply(state: { text: string; recentGateReplies: number }): GateDecision {
  if (looksAutomated(state.text)) return "silent_automated";
  if (state.recentGateReplies >= GATE_REPLY_BUDGET.max) return "silent_budget";
  return "send";
}

// Gate replies Co already sent this number in the window, counted from what
// sendAndLog recorded.
export async function countRecentGateReplies(userId: string): Promise<number> {
  // Loaded here so the pure rules above can be tested without Sendblue keys.
  const { cleanCoMessage } = await import("./sendblue.js");
  const lines = [...GATE_ASK, ...WRONG_CODE].map((l) => `Co replied: ${cleanCoMessage(l)}`);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM co_memories
     WHERE user_id = $1 AND memory_type = 'text_exchange' AND content = ANY($2::text[])
       AND created_at > NOW() - ($3 || ' hours')::interval`,
    [userId, lines, GATE_REPLY_BUDGET.windowHours],
  );
  return rows[0]?.n ?? 0;
}
