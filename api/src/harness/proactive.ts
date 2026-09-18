// Layer 7 harness: Co texting first (Royce, 2026-09-14). Before this, about
// ten senders each drafted and sent on their own, and whichever claimed the
// shared 24h throttle first won; four senders skipped it entirely. Live
// result: duplicate texts seconds apart, a check-in three days running, 4am
// outcome follow-ups, a surfacing run that fired ~20 times in 7 minutes.
//
// Now every proactive sender only PRODUCES a candidate (enqueueCandidate).
// runProactiveDispatch is the one place that sends:
//
//   gather  — pending candidates, this person's proactive send ledger, when
//             they last texted Co, their local time
//   gate    — code rules (evaluateCandidates), no model involved
//   propose — code picks the highest-priority eligible candidate
//   draft   — DRAFT_MODEL writes it under PROACTIVE_RULES + CONFIRMED_FACTS,
//             may return SKIP; checkDraft validates the text in code
//   send    — sendWithLedger re-checks the caps and idempotency key inside
//             the same transaction as the send, then the type's onSent hook
//             writes memories and marks source rows
//   record  — recordDecision(layer 7, "proactive.dailyPick")
//
// Transactional texts (event change notices, call reminders, missed-call
// texts) don't compete for the daily pick; they go through sendExempt, which
// still enforces the idempotency key and, where asked, local hours. Layer 6
// in-room nudges during a live event are owned by eventScoring.ts and stay
// outside this harness.
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { describeFailed, gate, recordDecision, type GateCheck } from "./core.js";
import { MODELS } from "../models.js";
import { capitalizeSentences } from "../services/textStyle.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { getEmotionalContext, renderEmotionalContext } from "./emotion.js";

// The person's emotional context for whatever draft runs inside dispatch,
// without threading it through every registry and agent draft call.
const feelingForDraft = new AsyncLocalStorage<string>();

// Draft with how they've been feeling in view, the way the daily pick does.
export function draftWithFeeling<T>(feeling: string, fn: () => Promise<T>): Promise<T> {
  return feelingForDraft.run(feeling, fn);
}

// Judgment with side effects (which text goes to a person, and its words)
// runs on Sonnet 5 per Royce's model policy (2026-09-14).
// The eval (evals/proactive/run.ts --draft-model) can compare models; in
// production this is always Sonnet 5.
export const DRAFT_MODEL = process.env.PROACTIVE_EVAL_DRAFT_MODEL || MODELS.sonnet;

export type ProactiveType =
  | "event_offer"
  | "network_tease"
  | "ask_checkin"
  | "companion"
  | "calendar_follow"
  | "ask_solicitation"
  | "debrief"
  | "post_call"
  | "product_update"
  | "window_followup"
  // A guest-match nudge for a matched pair with no real event timing to be
  // "in-room" for (eventMatching.ts's self-reported/recommended-event path —
  // code review, 2026-09-17). Unlike eventScoring.ts's live in-room nudge,
  // this has no event to be inside the window of, so it goes through the
  // normal daily pick instead of bypassing it: local hours, the daily/weekly
  // caps, and opt-out all apply.
  | "event_match_nudge";

// co_event: Co's own event, announced to nearby users on creation (services/coEventAnnouncement.ts).
// direct_ask: a reply-triggered direct ask to a THIRD person who didn't just
// text (eventGuestMatchHandoff.ts's maybeAskCandidateDirectly/
// askConnectionMethod, networkIntroNudge.ts's askCandidateDirectly) — see
// sendExemptWhenAllowed below.
// search_result: the answer to a texted search that ran past the reply's time
// cap, sent when it lands (services/lateSearchResult.ts).
export type ExemptType = "event_change" | "call_reminder" | "missed_call" | "co_event" | "direct_ask" | "search_result";

export type TypePolicy = {
  priority: number;
  // No second send of this type within N days, whatever the target.
  typeGapDays?: number;
  // No second send on the same topic (e.g. the same ask) within N days.
  topicGapDays?: number;
};

// Higher priority wins when the code (not the model) picks. Time-bound
// things first; the "just thinking about you" check-in last.
export const TYPE_POLICY: Record<ProactiveType, TypePolicy> = {
  debrief: { priority: 90 },
  post_call: { priority: 80 },
  calendar_follow: { priority: 70, typeGapDays: 3650 },
  event_offer: { priority: 60 },
  ask_solicitation: { priority: 55 },
  network_tease: { priority: 50 },
  event_match_nudge: { priority: 50 },
  ask_checkin: { priority: 30, topicGapDays: 14 },
  // After a time frame they searched has passed; about them, not a pitch.
  window_followup: { priority: 35, typeGapDays: 5 },
  product_update: { priority: 20, typeGapDays: 7 },
  companion: { priority: 10, typeGapDays: 14 },
};

export const RULES = {
  startHour: 9,
  endHour: 20,
  maxPerLocalDay: 1,
  maxPer7Days: 3,
  // The room lane (events, in-room nudges, intros) has its own caps, so
  // follow-ups and check-ins can't use up the slot an event needed
  // (2026-09-18: five pending follow-ups competed with one event offer).
  roomMaxPerLocalDay: 1,
  roomMaxPer7Days: 4,
  unansweredPauseHours: 72,
  maxDraftAttempts: 2,
  // After the model decides nothing is worth sending, don't ask it again for
  // this person until this many hours pass (or a new candidate arrives).
  pickNoneHoldHours: 6,
};

export type Candidate = {
  id: string;
  userId: string;
  type: ProactiveType;
  targetKey: string;
  topicKey: string;
  summary: string;
  priority: number;
  dueAt: Date;
  expiresAt: Date | null;
  payload: any;
  attempts: number;
  createdAt: Date;
};

export type SendRecord = {
  type: string;
  targetKey: string;
  topicKey: string | null;
  sentAt: Date;
  exempt: boolean;
};

export type PickState = {
  now: Date;
  timezone: string | null;
  optedOut: boolean;
  candidates: Candidate[];
  // This person's proactive send ledger (at least the last 14 days).
  sends: SendRecord[];
  // Last time they texted Co, from any channel that logs text_exchange.
  lastInboundAt: Date | null;
  // Emotion loop: struggling in the last day (harness/emotion.ts).
  needsCare?: boolean;
};

// While someone is struggling, asks, check-ins on asks, and product updates
// wait. Anything that brings them into a room or toward a person still goes
// out (Royce, 2026-09-18: "we can't isolate them until the perfect event is
// right"). Holding event offers on bad days meant a member frustrated about
// getting nothing kept getting nothing; the draft carries their feelings.
// ask_solicitation is never held: it's only queued for an event guest with no
// stated ask, and without an answer they're never scored for a match, so
// holding it would isolate them from the room.
export const HOLD_WHILE_STRUGGLING = new Set<ProactiveType>([
  "ask_checkin",
  "product_update",
  "calendar_follow",
]);

export type CandidateEvaluation = { candidate: Candidate; checks: GateCheck[]; ok: boolean };

export type Evaluation = {
  userChecks: GateCheck[];
  userOk: boolean;
  perCandidate: CandidateEvaluation[];
  eligible: Candidate[];
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 9am-8pm in their own time zone. With no usable time zone, only the UTC
// hours when every continental US zone is inside 9am-8pm (16:00-24:00 UTC)
// count. This used to fail open, which is how unknown-city users got texts
// at any hour.
export function localHourOk(now: Date, timezone: string | null): boolean {
  if (timezone) {
    const local = DateTime.fromJSDate(now).setZone(timezone);
    if (local.isValid) return local.hour >= RULES.startHour && local.hour < RULES.endHour;
  }
  const utcHour = now.getUTCHours();
  return utcHour >= 16;
}

function startOfLocalDay(now: Date, timezone: string | null): Date {
  if (timezone) {
    const local = DateTime.fromJSDate(now).setZone(timezone);
    if (local.isValid) return local.startOf("day").toJSDate();
  }
  return new Date(now.getTime() - DAY);
}

function unansweredSince(send: SendRecord, lastInboundAt: Date | null): boolean {
  return !lastInboundAt || lastInboundAt.getTime() < send.sentAt.getTime();
}

// Two lanes, each with its own daily/weekly caps and its own unanswered
// pause: things that bring someone into a room or toward a person (openings
// included), and everything else. An ignored check-in no longer silences
// events for 72 hours. Openings had a lane of their own for a day; merged back
// (Royce, 2026-09-18: "A third set of caps is guesswork at this volume").
export type Lane = "room" | "other";
const ROOM_LANE = new Set<string>(["event_offer", "event_match_nudge", "network_tease", "in_room"]);
export function laneOf(type: string): Lane {
  return ROOM_LANE.has(type) ? "room" : "other";
}

export const LANE_CAPS: Record<Lane, { perDay: number; per7Days: number }> = {
  room: { perDay: RULES.roomMaxPerLocalDay, per7Days: RULES.roomMaxPer7Days },
  other: { perDay: RULES.maxPerLocalDay, per7Days: RULES.maxPer7Days },
};

export function userLevelChecks(state: Omit<PickState, "candidates">, opts: { skipHours?: boolean; lane?: Lane } = {}): GateCheck[] {
  const lane = opts.lane ?? "other";
  const maxDay = LANE_CAPS[lane].perDay;
  const maxWeek = LANE_CAPS[lane].per7Days;
  const counted = state.sends.filter((s) => !s.exempt && laneOf(s.type) === lane);
  const dayStart = startOfLocalDay(state.now, state.timezone);
  const today = counted.filter((s) => s.sentAt >= dayStart && s.sentAt <= state.now).length;
  const week = counted.filter((s) => state.now.getTime() - s.sentAt.getTime() < 7 * DAY && s.sentAt <= state.now).length;
  // One-way pause: an unanswered event or intro pauses check-ins too, but an
  // unanswered check-in never pauses events. So follow-ups can't isolate
  // anyone from rooms, and someone who isn't replying still gets one text.
  const pauseSource = lane === "room" ? counted : state.sends.filter((s) => !s.exempt);
  const lastCounted = pauseSource.filter((s) => s.sentAt <= state.now).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  const pauseActive =
    !!lastCounted &&
    state.now.getTime() - lastCounted.sentAt.getTime() < RULES.unansweredPauseHours * HOUR &&
    unansweredSince(lastCounted, state.lastInboundAt);

  const checks: GateCheck[] = [{ name: "not_opted_out", pass: !state.optedOut, reason: "they opted out of texts" }];
  if (!opts.skipHours) {
    checks.push({
      name: "local_hours",
      pass: localHourOk(state.now, state.timezone),
      reason: `outside ${RULES.startHour}am-${RULES.endHour - 12}pm ${state.timezone ?? "(no time zone, US-safe UTC window)"}`,
    });
  }
  checks.push(
    { name: "daily_cap", pass: today < maxDay, reason: `${today} ${lane}-lane proactive text(s) already today` },
    { name: "weekly_cap", pass: week < maxWeek, reason: `${week} ${lane}-lane proactive texts in the last 7 days` },
    {
      name: "unanswered_pause",
      pass: !pauseActive,
      reason: lastCounted ? `last proactive text (${lastCounted.type}) at ${lastCounted.sentAt.toISOString()} has no reply yet` : undefined,
    },
  );
  return checks;
}

export function candidateChecks(c: Candidate, state: Pick<PickState, "now" | "sends" | "lastInboundAt" | "needsCare">): GateCheck[] {
  const policy = TYPE_POLICY[c.type];
  const sameTarget = state.sends.find((s) => s.targetKey === c.targetKey);
  const unansweredTopic = state.sends.find((s) => s.topicKey && s.topicKey === c.topicKey && unansweredSince(s, state.lastInboundAt));
  const lastOfType = state.sends
    .filter((s) => s.type === c.type)
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  const lastOfTopic = state.sends
    .filter((s) => s.topicKey && s.topicKey === c.topicKey)
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];

  const checks: GateCheck[] = [
    { name: "due", pass: c.dueAt.getTime() <= state.now.getTime(), reason: `not due until ${c.dueAt.toISOString()}` },
    { name: "not_expired", pass: !c.expiresAt || c.expiresAt.getTime() > state.now.getTime(), reason: "expired" },
    { name: "not_sent_before", pass: !sameTarget, reason: `${c.targetKey} already sent` },
    {
      name: "no_reask_unanswered",
      pass: !unansweredTopic,
      reason: unansweredTopic ? `already asked about ${c.topicKey} and they never replied` : undefined,
    },
  ];
  if (policy.typeGapDays !== undefined) {
    checks.push({
      name: "type_gap",
      pass: !lastOfType || state.now.getTime() - lastOfType.sentAt.getTime() >= policy.typeGapDays * DAY,
      reason: `a ${c.type} went out within ${policy.typeGapDays} days`,
    });
  }
  if (policy.topicGapDays !== undefined) {
    checks.push({
      name: "topic_gap",
      pass: !lastOfTopic || state.now.getTime() - lastOfTopic.sentAt.getTime() >= policy.topicGapDays * DAY,
      reason: `${c.topicKey} came up within ${policy.topicGapDays} days`,
    });
  }
  if (state.needsCare && HOLD_WHILE_STRUGGLING.has(c.type)) {
    checks.push({ name: "emotional_timing", pass: false, reason: "they've been struggling in the last day; this can wait" });
  }
  return checks;
}

const PERSON_CHECKS = new Set(["not_opted_out", "local_hours"]);

export function evaluateCandidates(state: PickState): Evaluation {
  // Opt-out and local hours apply to the person; caps and the unanswered
  // pause apply per lane, so each candidate is checked against its own lane.
  const byLane: Record<Lane, GateCheck[]> = {
    room: userLevelChecks(state, { lane: "room" }),
    other: userLevelChecks(state, { lane: "other" }),
  };
  const userChecks = byLane.other.filter((k) => PERSON_CHECKS.has(k.name));
  const userOk = gate(userChecks).ok;
  const perCandidate = state.candidates.map((candidate) => {
    const laneChecks = byLane[laneOf(candidate.type)].filter((k) => !PERSON_CHECKS.has(k.name));
    const checks = [...laneChecks, ...candidateChecks(candidate, state)];
    return { candidate, checks, ok: gate(checks).ok };
  });
  const eligible = userOk ? perCandidate.filter((p) => p.ok).map((p) => p.candidate) : [];
  return { userChecks, userOk, perCandidate, eligible };
}

// Deterministic pick: priority, then whichever expires soonest, then oldest.
export function codePick(eligible: Candidate[]): Candidate | null {
  const sorted = [...eligible].sort(
    (a, b) =>
      b.priority - a.priority ||
      (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) ||
      a.dueAt.getTime() - b.dueAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return sorted[0] ?? null;
}

// ---------- drafting

export const PROACTIVE_RULES = `PROACTIVE RULES
- One message, one reason. If you can't name the specific thing you're reaching out about, return SKIP.
- Name the concrete thing (event name, person, what they said) whenever the task allows naming it. Never "the event" or "someone cool."
- Never state what another person said, feels, or wants unless it's written in CONFIRMED_FACTS.
- Never restate internal reasoning ("matches your stated goal", "fit score", "based on your profile").
- If you're asking for a decision, end with one yes/no question. Otherwise don't ask anything.
- Max 2 sentences. No greeting line, no sign-off.
- Normal capitalization: start with a capital letter. You're texting first, so there's no lowercase style to mirror.`;

export type Facts = Record<string, string | number | boolean | string[] | null | undefined>;

export function renderFacts(facts: Facts): string {
  const lines = Object.entries(facts)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join("; ") : String(v)}`);
  return lines.length ? lines.join("\n") : "- (nothing beyond what's described below)";
}

// Returns the cleaned message, or null when the model chose SKIP.
export async function draftProactive(opts: {
  functionId: string;
  firstName: string;
  facts: Facts;
  task: string;
  model?: string;
}): Promise<string | null> {
  const feeling = feelingForDraft.getStore();
  const { text } = await generateText({
    model: anthropic(opts.model ?? DRAFT_MODEL),
    experimental_telemetry: { isEnabled: true, functionId: opts.functionId },
    prompt: `${CO_VOICE}

${CO_TEXT_CHANNEL} You're texting ${opts.firstName}. Co is reaching out first; they didn't just text you.

${PROACTIVE_RULES}

CONFIRMED_FACTS (the only facts you may state)
${renderFacts(opts.facts)}
${feeling ? `\nHOW THEY'VE BEEN FEELING (let it shape how you say this, never whether you say it: it's not a reason to SKIP. If they've been struggling, be gentler and lower-pressure, and acknowledge it briefly and warmly in your own words before the rest. Never name the feeling)\n${feeling}\n` : ""}

TASK
${opts.task}

Return ONLY the message text, or exactly SKIP.`,
  });
  const trimmed = text.trim().replace(/^["']|["']$/g, "").trim();
  if (!trimmed || /^skip\b[.!]?$/i.test(trimmed)) return null;
  return cleanCoMessage(trimmed);
}

export type OutputRules = {
  maxSentences?: number;
  maxChars?: number;
  allowUrl?: boolean;
  allowGreeting?: boolean;
  // At least one of these must appear (case-insensitive), e.g. the event name.
  mustIncludeAny?: string[];
  // None of these may appear, e.g. the event name in a tease.
  mustNotInclude?: string[];
  forbidden?: { pattern: RegExp; reason: string }[];
};

const ALWAYS_FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /!{2,}|(?:!.*){3,}/, reason: "piled-up exclamation points" },
  { pattern: /[—–]/, reason: "em dash" },
  { pattern: /\b(keep (my|an) eyes? (open|out)|keep (watching|looking|tracking|track of|an eye out)|be on the lookout|want me to (watch|look|keep|track))\b/i, reason: "offers to keep watching; the sweep already does that without asking" },
  { pattern: /\bjust (checking|touching) (in|base)\b/i, reason: "generic check-in filler" },
  { pattern: /\b(someone|anyone|people) (cool|interesting)\b/i, reason: "vague instead of naming the person" },
  { pattern: /\b(someone|a person) (asking|looking) for\b/i, reason: "engine reasoning leaked" },
  { pattern: /\b(fit score|stated goal|your profile|based on your (ask|goals?))\b/i, reason: "internal reasoning leaked" },
  { pattern: /\bi('ll| will) (send|text|follow up|let you know|reach out)\b.*\b(later|soon|tomorrow)\b/i, reason: "promise of a later action" },
];

function sentenceCount(text: string): number {
  return text
    .replace(/\b(Mr|Mrs|Ms|Dr|St|vs|etc)\./gi, "$1")
    .split(/[.?](?:\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

// Significant words of a name, for "did the draft actually name it" checks:
// the model may shorten "Co Test Event 2 (SF Founders Meetup)" to "the SF
// Founders Meetup", which should still count.
export function nameTokens(name: string): string[] {
  const stop = new Set(["event", "events", "the", "and", "with", "for", "test", "co", "meetup", "night", "presents"]);
  return Array.from(new Set(name.toLowerCase().match(/[a-z0-9']{4,}/g) ?? [])).filter((w) => !stop.has(w));
}

export function checkDraft(text: string, rules: OutputRules): GateCheck[] {
  const lower = text.toLowerCase();
  const checks: GateCheck[] = [
    { name: "draft_not_empty", pass: text.trim().length > 0 },
    {
      name: "draft_length",
      pass: text.length <= (rules.maxChars ?? 320),
      reason: `${text.length} chars (max ${rules.maxChars ?? 320})`,
    },
  ];
  // Proactive texts open with a capital letter: Co only mirrors lowercase
  // when replying to someone who texts that way, and here nobody just did.
  checks.push({ name: "draft_capitalized", pass: !/^[a-z]/.test(text.trim()), reason: "starts lowercase" });
  if (rules.maxSentences !== undefined) {
    const n = sentenceCount(text);
    checks.push({ name: "draft_sentences", pass: n <= rules.maxSentences, reason: `${n} sentences (max ${rules.maxSentences})` });
  }
  if (!rules.allowUrl) {
    checks.push({ name: "draft_no_url", pass: !/(https?:\/\/|www\.|lu\.ma\/|\.com\/)/i.test(text), reason: "links go out as their own message" });
  }
  if (!rules.allowGreeting) {
    checks.push({ name: "draft_no_greeting", pass: !/^(hey|hi|hello|good (morning|afternoon|evening))\b/i.test(text.trim()), reason: "opens with a greeting" });
  }
  if (rules.mustIncludeAny?.length) {
    const wanted = rules.mustIncludeAny.map((w) => w.toLowerCase()).filter(Boolean);
    checks.push({
      name: "draft_names_the_thing",
      pass: !wanted.length || wanted.some((w) => lower.includes(w)),
      reason: `doesn't mention any of: ${wanted.join(", ")}`,
    });
  }
  for (const banned of rules.mustNotInclude ?? []) {
    if (!banned) continue;
    checks.push({ name: "draft_withholds", pass: !lower.includes(banned.toLowerCase()), reason: `reveals "${banned}" too early` });
  }
  for (const f of [...ALWAYS_FORBIDDEN, ...(rules.forbidden ?? [])]) {
    checks.push({ name: "draft_forbidden", pass: !f.pattern.test(text), reason: f.reason });
  }
  return checks;
}

// ---------- registry contract (implemented in proactiveRegistry.ts)

export type Person = { userId: string; firstName: string; phoneNumber: string; city: string | null; timezone: string | null };

// messages: sent in order, links as their own message. text: the part the
// model wrote, which is what checkDraft validates.
export type DraftResult = { messages: string[]; text: string; rules: OutputRules } | { skip: string };

export type TypeSpec = {
  draft(c: Candidate, person: Person): Promise<DraftResult>;
  onSent?(c: Candidate, person: Person, messages: string[]): Promise<void>;
  onDropped?(c: Candidate, status: "skipped" | "expired"): Promise<void>;
};

export type ProactiveRegistry = Record<ProactiveType, TypeSpec>;

// ---------- persistence

function rowToCandidate(r: any): Candidate {
  return {
    id: String(r.id),
    userId: r.user_id,
    type: r.type,
    targetKey: r.target_key,
    topicKey: r.topic_key,
    summary: r.summary,
    priority: r.priority,
    dueAt: new Date(r.due_at),
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    payload: r.payload,
    attempts: r.attempts,
    createdAt: new Date(r.created_at),
  };
}

export type EnqueueInput = {
  userId: string;
  type: ProactiveType;
  targetKey: string;
  topicKey?: string;
  summary: string;
  payload: any;
  dueAt?: Date;
  expiresAt?: Date | null;
  priority?: number;
  // Combine with an already-pending candidate for the same target (e.g. a
  // debrief collecting both the outcome follow-up and the event check-in).
  merge?: (existing: any, incoming: any) => any;
};

// Producers call this instead of sending. Idempotent per (user, target): a
// target that was already sent, skipped, or expired is never re-queued, so a
// sweep re-running every hour can't turn into repeated texts.
// A re-enqueue never pushes an expiry later (code review, 2026-09-17): the
// hourly ask check-in and companion crons re-enqueue a pending candidate with
// "now + N days" every tick, so a candidate blocked by the caps kept moving
// its own expiry out and never expired. The earlier of the two wins; null
// means "no expiry", so a real expiry on either side is kept.
export function mergeExpiry(existing: Date | null, incoming: Date | null): Date | null {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return existing.getTime() <= incoming.getTime() ? existing : incoming;
}

export async function enqueueCandidate(input: EnqueueInput): Promise<{ queued: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id, status, payload, expires_at FROM proactive_candidates WHERE user_id = $1 AND target_key = $2 FOR UPDATE`,
      [input.userId, input.targetKey],
    );
    const priority = input.priority ?? TYPE_POLICY[input.type].priority;
    const dueAt = input.dueAt ?? new Date();
    if (existing.rows[0]) {
      if (existing.rows[0].status !== "pending") {
        await client.query("ROLLBACK");
        return { queued: false };
      }
      const payload = input.merge ? input.merge(existing.rows[0].payload, input.payload) : input.payload;
      const expiresAt = mergeExpiry(existing.rows[0].expires_at ? new Date(existing.rows[0].expires_at) : null, input.expiresAt ?? null);
      await client.query(
        `UPDATE proactive_candidates
         SET payload = $2, summary = $3, due_at = $4, expires_at = $5, priority = $6, updated_at = NOW()
         WHERE id = $1`,
        [existing.rows[0].id, JSON.stringify(payload), input.summary, dueAt, expiresAt, priority],
      );
      await client.query("COMMIT");
      return { queued: true };
    }
    const alreadySent = await client.query(`SELECT 1 FROM proactive_sends WHERE user_id = $1 AND target_key = $2`, [
      input.userId,
      input.targetKey,
    ]);
    if (alreadySent.rows[0]) {
      await client.query("ROLLBACK");
      return { queued: false };
    }
    const inserted = await client.query(
      `INSERT INTO proactive_candidates (user_id, type, target_key, topic_key, summary, payload, due_at, expires_at, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`,
      [
        input.userId,
        input.type,
        input.targetKey,
        input.topicKey ?? input.targetKey,
        input.summary,
        JSON.stringify(input.payload),
        dueAt,
        input.expiresAt ?? null,
        priority,
      ],
    );
    await client.query("COMMIT");
    // New work for this person: let the pick model look again.
    if (inserted.rows[0]) {
      await pool.query(`UPDATE proactive_user_state SET hold_until = NULL WHERE user_id = $1`, [input.userId]).catch(() => {});
    }
    return { queued: Boolean(inserted.rows[0]) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

type Queryable = Pick<PoolClient, "query"> | typeof pool;

async function loadSends(db: Queryable, userId: string): Promise<SendRecord[]> {
  const { rows } = await db.query(
    `SELECT type, target_key, topic_key, sent_at, exempt FROM proactive_sends
     WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '30 days'`,
    [userId],
  );
  // Topic/type gaps can be longer than 30 days (calendar_follow is once
  // ever), so those two lookups also get the most recent row per type/topic.
  const { rows: older } = await db.query(
    `SELECT DISTINCT ON (type, topic_key) type, target_key, topic_key, sent_at, exempt FROM proactive_sends
     WHERE user_id = $1 AND sent_at <= NOW() - INTERVAL '30 days'
     ORDER BY type, topic_key, sent_at DESC`,
    [userId],
  );
  return [...rows, ...older].map((r: any) => ({
    type: r.type,
    targetKey: r.target_key,
    topicKey: r.topic_key,
    sentAt: new Date(r.sent_at),
    exempt: r.exempt,
  }));
}

async function loadLastInbound(db: Queryable, userId: string): Promise<Date | null> {
  const { rows } = await db.query(
    `SELECT MAX(created_at) AS at FROM co_memories
     WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User %'`,
    [userId],
  );
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

async function loadPerson(userId: string): Promise<(Person & { optedOut: boolean }) | null> {
  const { rows } = await pool.query(
    `SELECT u.first_name, u.phone_number, COALESCE(u.sms_opted_out, false) AS sms_opted_out, cp.city
     FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r?.phone_number) return null;
  const timezone = r.city ? await getTimezoneForCity(r.city).catch(() => null) : null;
  return {
    userId,
    firstName: r.first_name || "there",
    phoneNumber: r.phone_number,
    city: r.city ?? null,
    timezone,
    optedOut: r.sms_opted_out,
  };
}

// ---------- pick proposal

// Code picks by priority, then soonest expiry, then due time. A model pick
// was tried first but only ever ran when 2+ candidates were eligible on the
// same day (rare under the caps), and the draft step can still return SKIP
// when a text would be noise, so it wasn't earning its cost.
export function proposePick(eligible: Candidate[]): { pick: Candidate | null; reason: string; source: "code" } {
  const pick = codePick(eligible);
  return { pick, reason: pick ? `highest priority of ${eligible.length} eligible` : "nothing eligible", source: "code" };
}

// ---------- sending

// Re-checks everything that could have changed since the gather, holds a
// per-person advisory lock, and writes the idempotency key in the same
// transaction as the FIRST message's send only (code review, 2026-09-17).
// Used to write the key around the whole multi-message send: if message 1
// (e.g. a link) delivered but message 2 then failed, the whole transaction
// rolled back, undoing the claim along with it — the next tick saw "never
// sent" and resent the link. Now the claim only commits once message 1 is
// actually confirmed delivered (so a total failure before anything went out
// still rolls back cleanly and can retry from scratch, same as before), and
// every message after that is sent outside the transaction: a later failure
// can only ever mean a missed message, never a duplicate one. Returns which
// messages actually went out so the caller only remembers/acts on those.
async function sendWithLedger(
  c: Candidate,
  person: Person,
  messages: string[],
): Promise<{ sent: true; delivered: string[] } | { sent: false; failed: GateCheck[] }> {
  const client = await pool.connect();
  const delivered: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`proactive:${person.userId}`]);
    // Re-read opted-out inside the lock (code review, 2026-09-17): the
    // caller's gather can be minutes stale, and a STOP sent while a draft was
    // being written must still block this send. Was hardcoded false here,
    // meaning opt-out was never actually enforced at send time.
    const optedOutNow = await client
      .query(`SELECT COALESCE(sms_opted_out, false) AS opted_out FROM users WHERE id = $1`, [person.userId])
      .then((r) => r.rows[0]?.opted_out === true);
    const sends = await loadSends(client, person.userId);
    const lastInboundAt = await loadLastInbound(client, person.userId);
    const now = new Date();
    const checks = [
      ...userLevelChecks({ now, timezone: person.timezone, optedOut: optedOutNow, sends, lastInboundAt }, { lane: laneOf(c.type) }),
      ...candidateChecks(c, { now, sends, lastInboundAt }),
    ];
    const g = gate(checks);
    if (!g.ok) {
      await client.query("ROLLBACK");
      return { sent: false, failed: g.failed };
    }
    const ins = await client.query(
      `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, candidate_id, message, exempt)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`,
      [person.userId, c.type, c.targetKey, c.topicKey, c.id, messages.join("\n\n")],
    );
    if (!ins.rows[0]) {
      await client.query("ROLLBACK");
      return { sent: false, failed: [{ name: "not_sent_before", pass: false, reason: "idempotency key taken" }] };
    }
    // First message inside the transaction: a failure here rolls the claim
    // back entirely, so nothing was delivered and a later tick can retry
    // cleanly from scratch.
    await sendblue.messages.send({ number: person.phoneNumber, content: messages[0], from_number: process.env.SENDBLUE_PHONE_NUMBER! });
    delivered.push(messages[0]);
    await client.query(`UPDATE proactive_candidates SET status = 'sent', decided_at = NOW(), updated_at = NOW() WHERE id = $1`, [c.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (!delivered.length) throw err; // nothing delivered — safe to retry the whole send later
    return { sent: true, delivered }; // message 1 delivered but the claim commit itself failed; treat as sent, don't retry
  } finally {
    client.release();
  }

  // Claim is durable now. Remaining messages are sent outside the
  // transaction; a failure here can only mean a missed message, never a
  // resend of what already went out.
  for (let i = 1; i < messages.length; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await sendblue.messages.send({ number: person.phoneNumber, content: messages[i], from_number: process.env.SENDBLUE_PHONE_NUMBER! });
      delivered.push(messages[i]);
    } catch (err: any) {
      console.error(
        `proactive: sendWithLedger message ${i + 1}/${messages.length} failed for ${person.userId} (ledger already claimed, not retried, ${delivered.length} delivered):`,
        err?.message ?? err,
      );
      break;
    }
  }
  return { sent: true, delivered };
}

// For transactional texts outside the daily pick. Still idempotent per
// target, still logged in the ledger (exempt = true, so they don't count
// toward caps or the unanswered pause).
//
// Writes the idempotency key in the same transaction as message 1's send
// only (code review, 2026-09-17), same reasoning as sendWithLedger above:
// coEventAnnouncement's two-message send (link, then caption) used to write
// the claim and send everything inside one transaction, so a caption
// failure after the link delivered rolled the claim back too — the next
// 10-minute retry saw "never sent" and resent the link. A total failure
// before message 1 delivers still rolls back cleanly (retry from scratch);
// once message 1 is confirmed delivered the claim commits, so anything
// after that can only miss a message, never duplicate one. `delivered`
// reports what actually went out so callers (and their memories) only ever
// reflect real deliveries.
export async function sendExempt(opts: {
  userId: string;
  phoneNumber: string;
  type: ExemptType;
  targetKey: string;
  messages: string[];
  timezone?: string | null;
  respectHours?: boolean;
}): Promise<{ sent: boolean; reason?: string; delivered?: string[] }> {
  // Monitoring visibility (code review, 2026-09-17): send failures and
  // hours/opt-out blocks at send time had nothing writing a decision at
  // all, so harness/monitor.ts had no signal that could ever see them.
  const record = (outcome: "act" | "skip", action: string, reason?: string) =>
    recordDecision({ layer: 7, decision: "proactive.exemptSend", userId: opts.userId, outcome, action, reason, proposal: { type: opts.type, targetKey: opts.targetKey } }).catch(() => {});

  if (opts.respectHours && !localHourOk(new Date(), opts.timezone ?? null)) {
    await record("skip", "blocked_hours", "outside local hours");
    return { sent: false, reason: "outside local hours" };
  }
  const client = await pool.connect();
  const delivered: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`proactive:${opts.userId}`]);
    // Re-read opted-out inside the lock, same reasoning as sendWithLedger
    // (code review, 2026-09-17): exempt sends skipped this check entirely
    // before, so even STOP couldn't stop a transactional text.
    const optedOutNow = await client
      .query(`SELECT COALESCE(sms_opted_out, false) AS opted_out FROM users WHERE id = $1`, [opts.userId])
      .then((r) => r.rows[0]?.opted_out === true);
    if (optedOutNow) {
      await client.query("ROLLBACK");
      await record("skip", "blocked_opted_out", "opted out");
      return { sent: false, reason: "opted out" };
    }
    const ins = await client.query(
      `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt)
       VALUES ($1, $2, $3, $3, $4, true)
       ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`,
      [opts.userId, opts.type, opts.targetKey, opts.messages.join("\n\n")],
    );
    if (!ins.rows[0]) {
      await client.query("ROLLBACK");
      return { sent: false, reason: "already sent" }; // idempotent no-op, not worth a decision row
    }
    await sendblue.messages.send({ number: opts.phoneNumber, content: opts.messages[0], from_number: process.env.SENDBLUE_PHONE_NUMBER! });
    delivered.push(opts.messages[0]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (!delivered.length) {
      await record("skip", "send_failed", `${err instanceof Error ? err.message : err}`);
      throw err; // nothing delivered — safe to retry the whole send later
    }
  } finally {
    client.release();
  }
  if (!delivered.length) {
    await record("skip", "send_failed", "send failed before anything delivered");
    return { sent: false, reason: "send failed before anything delivered" };
  }

  for (let i = 1; i < opts.messages.length; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await sendblue.messages.send({ number: opts.phoneNumber, content: opts.messages[i], from_number: process.env.SENDBLUE_PHONE_NUMBER! });
      delivered.push(opts.messages[i]);
    } catch (err: any) {
      console.error(
        `sendExempt(${opts.type}): message ${i + 1}/${opts.messages.length} failed for ${opts.userId} (ledger already claimed, not retried, ${delivered.length} delivered):`,
        err?.message ?? err,
      );
      break;
    }
  }
  for (const m of delivered) {
    await writeMemory(opts.userId, "text_exchange", `Co replied: ${m}`).catch((err: any) =>
      console.error(`sendExempt(${opts.type}): text_exchange log failed (non-fatal):`, err?.message ?? err),
    );
  }
  await record("act", delivered.length < opts.messages.length ? "sent_partial" : "sent", delivered.length < opts.messages.length ? `${delivered.length}/${opts.messages.length} delivered` : undefined);
  return { sent: true, delivered };
}

// For a reply-triggered direct ask to a THIRD person who didn't just text Co
// (code review, 2026-09-17: eventGuestMatchHandoff.ts's
// maybeAskCandidateDirectly/askConnectionMethod and networkIntroNudge.ts's
// askCandidateDirectly sent a raw sendblue message with no opt-out or hours
// check at all, since the trigger was the OTHER person's reply, not this
// recipient's). Sends now if it's inside their local hours; otherwise
// schedules exactly one in-process retry for the next local 9am instead of
// texting at night. Opt-out is still enforced by sendExempt itself, at send
// time, whichever branch runs.
//
// Best-effort, not a durable queue: a process restart between now and the
// scheduled retry loses it. Acceptable here since these are low-volume,
// reply-triggered sends, not a cron-polled backlog — unlike the announcement
// and event-change queues, which are DB-backed because they're seeded from
// a webhook that has no in-process continuation to hold a timer on.
export async function sendExemptWhenAllowed(opts: {
  userId: string;
  phoneNumber: string;
  type: ExemptType;
  targetKey: string;
  messages: string[];
  timezone: string | null;
}): Promise<{ sent: boolean; queued: boolean; reason?: string }> {
  if (localHourOk(new Date(), opts.timezone)) {
    const result = await sendExempt(opts).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) }));
    return { sent: result.sent, queued: false, reason: result.reason };
  }
  const at = nextLocalHour(new Date(), opts.timezone, RULES.startHour);
  const delayMs = Math.max(0, at.getTime() - Date.now());
  setTimeout(() => {
    sendExempt(opts).catch((err: any) =>
      console.error(`sendExemptWhenAllowed(${opts.type}): deferred send failed for ${opts.userId} (non-fatal):`, err?.message ?? err),
    );
  }, delayMs);
  return { sent: false, queued: true, reason: `outside local hours, retrying at ${at.toISOString()}` };
}

// Layer 6 in-room nudges during a live event are sent by eventScoring.ts,
// outside the daily pick, because they only make sense while the event is
// happening. They still go in the ledger as counted (non-exempt) sends, so
// the daily pick's caps and unanswered pause see them and don't stack a
// second discretionary text on the same day.
// At most this many in-room texts (match nudge + additive offers) per person
// per event. Replaces the old 24h tryClaimProactiveNudge claim, which also
// blocked a legitimate additive offer later the same night.
export const MAX_IN_ROOM_SENDS_PER_EVENT = 3;

export async function inRoomSendAllowed(userId: string, eventId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proactive_sends WHERE user_id = $1 AND type = 'in_room' AND target_key LIKE $2`,
    [userId, `in_room:%:${eventId}%`],
  );
  return (rows[0]?.n ?? 0) < MAX_IN_ROOM_SENDS_PER_EVENT;
}

export async function recordInRoomSend(userId: string, targetKey: string, message: string): Promise<void> {
  await pool
    .query(
      `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt)
       VALUES ($1, 'in_room', $2, $2, $3, false)
       ON CONFLICT (user_id, target_key) DO NOTHING`,
      [userId, targetKey, message],
    )
    .catch((err: any) => console.error("recordInRoomSend failed (non-fatal):", err?.message ?? err));
}

// ---------- dispatch

async function dropCandidate(registry: ProactiveRegistry, c: Candidate, status: "skipped" | "expired", reason: string): Promise<void> {
  await pool.query(
    `UPDATE proactive_candidates SET status = $2, skip_reason = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
    [c.id, status, reason],
  );
  await registry[c.type].onDropped?.(c, status).catch((err: any) =>
    console.error(`proactive: onDropped(${c.type}) failed (non-fatal):`, err?.message ?? err),
  );
}

// Records a blocked/skip decision only when the blocking reason changed, so
// an every-15-minutes tick outside someone's hours doesn't flood the log.
async function recordSkipOnce(userId: string, reason: string, decision: Parameters<typeof recordDecision>[0]): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO proactive_user_state (user_id, last_skip_reason, last_skip_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET last_skip_reason = EXCLUDED.last_skip_reason, last_skip_at = NOW()
     WHERE proactive_user_state.last_skip_reason IS DISTINCT FROM EXCLUDED.last_skip_reason
        OR proactive_user_state.last_skip_at < NOW() - INTERVAL '24 hours'
     RETURNING user_id`,
    [userId, reason],
  );
  if (rows[0]) await recordDecision(decision);
}

export async function dispatchForUser(registry: ProactiveRegistry, userId: string): Promise<void> {
  const person = await loadPerson(userId);
  if (!person) return;

  const hold = await pool.query(`SELECT hold_until FROM proactive_user_state WHERE user_id = $1`, [userId]);
  if (hold.rows[0]?.hold_until && new Date(hold.rows[0].hold_until) > new Date()) return;

  const { rows: candRows } = await pool.query(
    `SELECT * FROM proactive_candidates WHERE user_id = $1 AND status = 'pending'`,
    [userId],
  );
  const state: PickState = {
    now: new Date(),
    timezone: person.timezone,
    optedOut: person.optedOut,
    candidates: candRows.map(rowToCandidate),
    sends: await loadSends(pool, userId),
    lastInboundAt: await loadLastInbound(pool, userId),
  };
  const emotional = await getEmotionalContext(userId);
  state.needsCare = emotional.needsCare;
  const ev = evaluateCandidates(state);
  const proposal = {
    candidates: ev.perCandidate.map((p) => ({
      id: p.candidate.id,
      type: p.candidate.type,
      target: p.candidate.targetKey,
      summary: p.candidate.summary,
      failed: p.checks.filter((c) => !c.pass).map((c) => c.name),
    })),
  };

  if (!ev.userOk || !ev.eligible.length) {
    const failed = ev.userOk ? [] : gate(ev.userChecks).failed;
    const reason = failed.length ? describeFailed(failed) : "no eligible candidate";
    await recordSkipOnce(userId, failed.map((f) => f.name).join(",") || "no_eligible", {
      layer: 7,
      decision: "proactive.dailyPick",
      userId,
      outcome: "skip",
      proposal,
      checks: ev.userChecks,
      reason,
    });
    return;
  }

  const picked = proposePick(ev.eligible);
  if (!picked.pick) {
    await pool.query(
      `INSERT INTO proactive_user_state (user_id, hold_until) VALUES ($1, NOW() + ($2 || ' hours')::interval)
       ON CONFLICT (user_id) DO UPDATE SET hold_until = EXCLUDED.hold_until`,
      [userId, RULES.pickNoneHoldHours],
    );
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", proposal, checks: ev.userChecks, reason: `pick: none (${picked.reason})` });
    return;
  }
  const c = picked.pick;
  const pickChecks = ev.perCandidate.find((p) => p.candidate.id === c.id)?.checks ?? [];

  let draft: DraftResult;
  try {
    draft = await feelingForDraft.run(renderEmotionalContext(emotional), () => registry[c.type].draft(c, person));
  } catch (err: any) {
    await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
    if (c.attempts + 1 >= RULES.maxDraftAttempts) await dropCandidate(registry, c, "skipped", `draft error: ${err?.message ?? err}`);
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal, checks: [...ev.userChecks, ...pickChecks], reason: `draft failed: ${err?.message ?? err}` });
    return;
  }

  if ("skip" in draft) {
    await dropCandidate(registry, c, "skipped", draft.skip);
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source }, checks: [...ev.userChecks, ...pickChecks], reason: `draft skipped: ${draft.skip}` });
    return;
  }

  // Co texts first here, so there's no lowercase style to mirror.
  draft = { ...draft, text: capitalizeSentences(draft.text), messages: draft.messages.map(capitalizeSentences) };
  const draftChecks = checkDraft(draft.text, draft.rules);
  const dg = gate(draftChecks);
  if (!dg.ok) {
    await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
    if (c.attempts + 1 >= RULES.maxDraftAttempts) await dropCandidate(registry, c, "skipped", `draft failed checks: ${describeFailed(dg.failed)}`);
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, draft: draft.text }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks], reason: `draft failed checks: ${describeFailed(dg.failed)}` });
    return;
  }

  let result: Awaited<ReturnType<typeof sendWithLedger>>;
  try {
    result = await sendWithLedger(c, person, draft.messages);
  } catch (err: any) {
    // Send failed and the ledger row rolled back. Retry on a later tick, up
    // to the attempt limit, instead of every 15 minutes until it expires.
    await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
    if (c.attempts + 1 >= RULES.maxDraftAttempts) await dropCandidate(registry, c, "skipped", `send error: ${err?.message ?? err}`);
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks], reason: `send failed: ${err?.message ?? err}` });
    return;
  }
  if (!result.sent) {
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks, ...result.failed], reason: `blocked at send: ${describeFailed(result.failed)}` });
    return;
  }

  // Memories and onSent only reflect what was actually delivered (code
  // review, 2026-09-17) — a partial send (e.g. the link went out but the
  // caption failed) used to still write "Co replied" memories and run
  // onSent for messages that never reached the person.
  for (const m of result.delivered) {
    await writeMemory(userId, "text_exchange", `Co replied: ${m}`).catch((err: any) =>
      console.error("proactive: text_exchange log failed (non-fatal):", err?.message ?? err),
    );
  }
  await registry[c.type].onSent?.(c, person, result.delivered).catch((err: any) =>
    console.error(`proactive: onSent(${c.type}) failed (non-fatal):`, err?.message ?? err),
  );
  await recordDecision({
    layer: 7,
    decision: "proactive.dailyPick",
    userId,
    outcome: "act",
    action: `send:${c.type}`,
    proposal: { ...proposal, picked: c.id, pickSource: picked.source, messages: draft.messages, delivered: result.delivered.length },
    checks: [...ev.userChecks, ...pickChecks, ...draftChecks],
    reason: result.delivered.length < draft.messages.length ? `${picked.reason} (partial send: ${result.delivered.length}/${draft.messages.length} delivered)` : picked.reason,
  });
}

export async function runProactiveDispatch(registry: ProactiveRegistry): Promise<void> {
  const expired = await pool.query(
    `UPDATE proactive_candidates SET status = 'expired', skip_reason = 'expired', decided_at = NOW(), updated_at = NOW()
     WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= NOW()
     RETURNING *`,
  );
  for (const r of expired.rows) {
    const c = rowToCandidate(r);
    await registry[c.type]?.onDropped?.(c, "expired").catch((err: any) =>
      console.error(`proactive: onDropped(${c.type}) failed (non-fatal):`, err?.message ?? err),
    );
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT user_id FROM proactive_candidates WHERE status = 'pending' AND due_at <= NOW()`,
  );
  // Different people in parallel, each person strictly one at a time (the
  // advisory lock in sendWithLedger also covers overlapping ticks).
  const ids = rows.map((r: any) => r.user_id as string);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        await dispatchForUser(registry, id);
      } catch (err: any) {
        console.error(`proactive: dispatch failed for ${id} (non-fatal):`, err?.message ?? err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
}

// Next local `hour`:00 strictly after `after`, in their time zone (US-safe
// 17:00 UTC when unknown). Used for "the morning after" debriefs.
export function nextLocalHour(after: Date, timezone: string | null, hour: number): Date {
  if (timezone) {
    const local = DateTime.fromJSDate(after).setZone(timezone);
    if (local.isValid) {
      let t = local.set({ hour, minute: 0, second: 0, millisecond: 0 });
      if (t <= local) t = t.plus({ days: 1 });
      return t.toJSDate();
    }
  }
  const t = new Date(after);
  t.setUTCHours(17, 0, 0, 0);
  if (t <= after) t.setUTCDate(t.getUTCDate() + 1);
  return t;
}
