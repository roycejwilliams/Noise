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
import { awayHoldReason, awayHoldsCandidate, type AwayState } from "../services/away.js";
import { inventedFailure } from "../services/speakable.js";
import { proactivePaused, pausedTypes } from "../services/proactivePause.js";
import { brandSafe } from "../services/brandGuard.js";
import { feedbackFor, unbackedSpecifics } from "./proactiveSpecifics.js";
import { narratesInternalState } from "../services/speakable.js";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import pool from "../db/db.js";
import { recordProactiveText } from "../services/coFacts.js";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { hoursZone, isReasonableLocalHour, REASONABLE_HOUR_START, REASONABLE_HOUR_END } from "../services/localHours.js";
import { localStamp, memberZone } from "../services/memberTime.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { describeFailed, gate, recordDecision, type GateCheck } from "./core.js";
import { MODELS } from "../models.js";
import { capitalizeSentences } from "../services/textStyle.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { repeatQuestionCheck } from "./repeatAsk.js";
import { payloadFirst, theirAskOf } from "./payloadFirst.js";
import { afterComposeWait, afterPayloadFirst, afterRelevance, judgeDailyPick, lastDayVeto, logDraftDecision, sends, type DraftDecision } from "../brain/index.js";
import { renderEmotionalContext } from "./emotion.js";
import { kindOf, loadKindRestraint, RESTRAINT, suppressedKinds, syncKindPreferences, type ProactiveKind } from "../services/kindRestraint.js";
import { captionNumbersBacked, sendCheckDryRun } from "../services/sendCheck.js";
import type { KnowledgeSection, MemberKnowledge, MemberRules } from "../services/memberKnowledge.js";

// The seasonal goal window (services/goalJourney.ts GOAL_CHECKIN.everyDays), here so the gate needs no DB import.
export const GOAL_SEASON_DAYS = 56;

// The person's emotional context for whatever draft runs inside dispatch,
// without threading it through every registry and agent draft call.
const feelingForDraft = new AsyncLocalStorage<string>();

// A second try at a draft that failed its checks (2026-09-28): the draft and
// what it broke, so the rewrite fixes that instead of the day's text being
// lost. Two companion check-ins to Jacqueline on 09-23 opened "Hey
// Jacqueline," and nothing went out.
const redraftFor = new AsyncLocalStorage<{ draft: string; failed: string }>();
export function draftAgain<T>(first: { draft: string; failed: string }, fn: () => Promise<T>): Promise<T> {
  return redraftFor.run(first, fn);
}

// Draft with how they've been feeling in view, the way the daily pick does.
export function draftWithFeeling<T>(feeling: string, fn: () => Promise<T>): Promise<T> {
  return feelingForDraft.run(feeling, fn);
}

// What Co knows about the member (services/memberKnowledge.ts), read ONCE per dispatch and handed to every draft inside it the same
// way as the feeling: the block draftProactive adds (memberDraftBlock), and the knowledge itself for a type that needs to read it
// (draftKnowledge). Outside a dispatch there is none and drafts are exactly as before.
const memberForDraft = new AsyncLocalStorage<{ k: MemberKnowledge; block: string } | null>();
export function draftWithKnowledge<T>(k: MemberKnowledge | null, rules: MemberRules | null, fn: () => Promise<T>): Promise<T> {
  return memberForDraft.run(k && rules ? { k, block: memberDraftBlock(k, rules) } : null, fn);
}
export function draftKnowledge(): MemberKnowledge | null {
  return memberForDraft.getStore()?.k ?? null;
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
  | "event_match_nudge"
  // A page or deck they've been using is about to expire; one word keeps it (services/coPages/expiry.ts, 2026-10-11).
  | "artifact_expiry"
  // One solved plan for a want with a window, in a real gap (services/bounce.ts, the bounce, 2026-10-15): proposed once.
  | "bounce_proposal"
  | "bounce_watch"
  | "bounce_calendar_offer"
  // Before a Co event they're going to (services/preArrival.ts, 2026-09-30).
  | "pre_arrival"
  // The member brief, the day before a Co event, and the one question at RSVP that lets it name them (services/eventBrief.ts, 2026-10-05).
  | "event_brief"
  | "brief_name_ask"
  // Once before a Co event, to a guest with nothing shareable: may Co tell a good match what they're looking for (services/askSharing.ts).
  | "room_share_ask"
  // After the member tells Co who they met: what stood out, and a note per person for them to send (services/eventFollowThrough.ts).
  | "event_followthrough"
  // The one "still on your plate?" ask for a loop nobody has signalled on for a week (services/loopLifecycle.ts, 2026-10-06).
  | "loop_check"
  // Rare, seasonal check-in on a goal (services/goalJourney.ts): never on the 7-day ask clock.
  | "goal_checkin"
  // A goal closed at their word: a companion moment that acknowledges the arc, not a status flip.
  | "goal_closed"
  // The goal recheck's one text (services/goalRecheck.ts, 2026-10-13): a searched goal quiet for two weeks, not raised in a reply.
  | "goal_recheck"
  // Member-state nudges (services/memberStateNudges.ts, 2026-10-08): Co acting when something it carries for them changes. An intro
  // they haven't brought up, a deadline on something they said yes to, a goal gone quiet, something they said they'd do coming due.
  | "intro_nudge"
  | "deadline_nudge"
  | "goal_nudge"
  | "commitment_nudge";

// co_event: Co's own event, announced to nearby users on creation (services/coEventAnnouncement.ts).
// direct_ask: a reply-triggered direct ask to a THIRD person who didn't just
// text (eventGuestMatchHandoff.ts's maybeAskCandidateDirectly/
// networkIntroNudge.ts's askCandidateDirectly) — see
// sendExemptWhenAllowed below.
// search_result: the answer to a texted search that ran past the old reply
// search's time cap (removed 2026-10-01: Co's own loop shares finds as it goes);
// kept so older records still read.
// task_update: Co's own report on work it is doing for them over days (services/taskTurn.ts).
// call_confirm: the text right after a call that confirms what Co said it would send (services/callFollowThrough.ts).
// task_window: the one line that tells them a commitment will miss its window, and the new time, before it passes (services/taskTurn.ts).
export type ExemptType = "event_change" | "call_reminder" | "missed_call" | "co_event" | "direct_ask" | "search_result" | "task_update" | "call_confirm" | "task_window";

// What each proactive message is for (companion / offer / ops) lives in
// ./proactivePurpose.ts, dependency-free so model-free checks can read it.
export { PROACTIVE_PURPOSE, typesWithPurpose, type ProactivePurpose } from "./proactivePurpose.js";
import { PROACTIVE_PURPOSE as PROACTIVE_PURPOSE_MAP } from "./proactivePurpose.js";

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
  // 7 days, not 14 (2026-09-22): two weeks of silence on something they
  // asked for reads as Co forgetting it.
  ask_checkin: { priority: 30, topicGapDays: 7 },
  // After a time frame they searched has passed; about them, not a pitch.
  window_followup: { priority: 35, typeGapDays: 5 },
  product_update: { priority: 20, typeGapDays: 7 },
  // Every ~4 days at most, not 14 (2026-09-28, Royce: two weeks apart is an
  // acquaintance, not a companion). Still skipped when there's nothing real.
  companion: { priority: 10, typeGapDays: 4 },
  // Once per artifact per lifetime (its own target key), before the date it names.
  artifact_expiry: { priority: 30 },
  // Once per want, ever (bounce_proposals), and only while its find and gap hold.
  bounce_proposal: { priority: 85 },
  // A plan they asked Cue to keep an eye on changed: once per plan (its own target key), before it starts.
  bounce_watch: { priority: 90 },
  // The one calendar offer, ever (calendar_offers).
  bounce_calendar_offer: { priority: 40 },
  // Time-bound: hours before the event, once per event (its own target key).
  pre_arrival: { priority: 95 },
  // Once per event each, timed to the day before and to the RSVP.
  event_brief: { priority: 90 },
  brief_name_ask: { priority: 92 },
  room_share_ask: { priority: 91 },
  event_followthrough: { priority: 93 },
  // Once per loop (its own target key); it is a question, so it is the lowest of the companion kind.
  loop_check: { priority: 12, typeGapDays: 3 },
  // Seasonal: one in eight weeks at most (also enforced where it is queued); the closing moment is a reply to what they said.
  goal_checkin: { priority: 9, typeGapDays: 56 },
  goal_closed: { priority: 86 },
  // Once per quiet stretch per goal (recheck_asked_at); one recheck text every few days at most, so goals due together never pile up.
  goal_recheck: { priority: 10, typeGapDays: 3 },
  // Member-state nudges: once per state (their own target key carries the state's fingerprint). Time-bound first.
  // One deadline heads-up a day at most (final review of #108).
  deadline_nudge: { priority: 75, typeGapDays: 1 },
  intro_nudge: { priority: 45, typeGapDays: 2 },
  commitment_nudge: { priority: 40, typeGapDays: 2 },
  // Shares the seasonal window with goal_checkin (goal_season in candidateChecks): never a drumbeat.
  goal_nudge: { priority: 11, typeGapDays: 21 },
};

export const RULES = {
  // The one window for everything Co starts (services/localHours.ts, 8am-9pm, Royce 2026-10-08).
  startHour: REASONABLE_HOUR_START,
  endHour: REASONABLE_HOUR_END,
  maxPerLocalDay: 1,
  maxPer7Days: 3,
  // The room lane (events, in-room nudges, intros) has its own caps, so
  // follow-ups and check-ins can't use up the slot an event needed
  // (2026-09-18: five pending follow-ups competed with one event offer).
  roomMaxPerLocalDay: 1,
  roomMaxPer7Days: 4,
  // After one unanswered text Co waits a day; after two in a row, three days.
  // A busy or building member who hasn't replied isn't ignoring Co, so one
  // quiet text must not silence events for 72 hours (2026-09-21).
  unansweredPauseHours: 24,
  unansweredPauseHoursAfterTwo: 72,
  unansweredPauseHoursAfterThree: 7 * 24,
  unansweredPauseHoursAfterFour: 14 * 24,
  // Any two unprompted texts are at least this far apart, whatever their lane
  // (2026-09-22): lanes now pause separately, so without this a check-in could
  // land 15 minutes after an unanswered offer.
  minHoursBetweenTexts: 3,
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
  // They said yes to "want to hear who?" and no reveal followed
  // (networkIntroNudge.lastTeaseUndelivered): no new tease until it clears.
  undeliveredYes?: boolean;
  // A safety concern in the last three days (services/safety.ts).
  safetyHold?: boolean;
  // Kinds of message this member keeps letting pass, so Co stopped sending them (services/kindRestraint.ts).
  suppressedKinds?: ProactiveKind[];
  // They said they're away from home (services/away.ts): finds tied to where they live wait until they're back.
  away?: AwayState | null;
  // Their text arrived in the last few minutes or its reply turn is still running, so any text Co starts now would land in the middle
  // of the conversation (concurrency audit, 2026-10-12; intelligence audit: a check-in went 40 seconds after Co's reply). Every
  // proactive and Co-initiated text waits; it's requeued, never dropped.
  midConversation?: boolean;
  // When they joined (users.created_at): no companion check-in in their first day (NEW_MEMBER_QUIET_HOURS).
  joinedAt?: Date | null;
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
  "goal_checkin",
  "product_update",
  "calendar_follow",
  "goal_nudge",
  "commitment_nudge",
  "goal_recheck",
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

// 8am-9pm in their own time zone. With no usable time zone, the same window
// measured in Pacific (services/localHours.ts FALLBACK_ZONE). This used to fail
// open, which is how unknown-city users got texts at any hour.
// The pause grows with every text in a row that went unanswered (2026-10-04,
// Royce, brand fix 3): a day after one, three after two, a week after three, two
// weeks after four or more. Before, it stopped at three days, so a member who
// had gone quiet still heard from Co twice a week indefinitely.
export function unansweredPauseFor(unansweredCount: number): number {
  if (unansweredCount >= 4) return RULES.unansweredPauseHoursAfterFour;
  if (unansweredCount >= 3) return RULES.unansweredPauseHoursAfterThree;
  return unansweredCount >= 2 ? RULES.unansweredPauseHoursAfterTwo : RULES.unansweredPauseHours;
}

// How engaged someone is, from the one thing the pick state carries: when they
// last texted Co, and how many of Co's texts since went unanswered. The caps
// stay the ceiling (1 a day, 3 a week, 4 for the room lane); this only brings
// the pace down for someone who has gone quiet, and a text from them restores
// it at once.
export type EngagementTier = "engaged" | "active" | "quiet" | "dormant" | "gone";
export const ENGAGEMENT = {
  engagedDays: 3,
  activeDays: 7,
  quietDays: 14,
  dormantDays: 30,
  // Four texts in a row with no reply is dormant whatever the calendar says.
  unansweredForDormant: 4,
};
export const CADENCE: Record<EngagementTier, { weeklyCap: number | null; minGapHours: number }> = {
  engaged: { weeklyCap: null, minGapHours: 0 },
  active: { weeklyCap: null, minGapHours: 0 },
  // Quiet for a week or two: at most two a week.
  quiet: { weeklyCap: 2, minGapHours: 0 },
  // Two to four weeks: one a week at most.
  dormant: { weeklyCap: 1, minGapHours: 7 * 24 },
  // Over a month, or no reply to four in a row: one every two weeks.
  gone: { weeklyCap: 1, minGapHours: 14 * 24 },
};
export function engagementTier(now: Date, lastInboundAt: Date | null, unansweredCount: number): EngagementTier {
  if (unansweredCount >= ENGAGEMENT.unansweredForDormant) return lastInboundAt && now.getTime() - lastInboundAt.getTime() <= ENGAGEMENT.quietDays * DAY ? "dormant" : "gone";
  if (!lastInboundAt) return unansweredCount >= 2 ? "quiet" : "active";
  const days = (now.getTime() - lastInboundAt.getTime()) / DAY;
  if (days <= ENGAGEMENT.engagedDays) return "engaged";
  if (days <= ENGAGEMENT.activeDays) return "active";
  if (days <= ENGAGEMENT.quietDays) return "quiet";
  return days <= ENGAGEMENT.dormantDays ? "dormant" : "gone";
}

// The one hours rule texts and calls share (services/localHours.ts): 8am-9pm their time, Pacific as a zone when theirs isn't known.
export function localHourOk(now: Date, timezone: string | null): boolean {
  return isReasonableLocalHour(timezone, now);
}

function startOfLocalDay(now: Date, timezone: string | null): Date {
  return DateTime.fromJSDate(now).setZone(hoursZone(timezone)).startOf("day").toJSDate();
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
const ROOM_LANE = new Set<string>(["event_offer", "event_match_nudge", "network_tease", "in_room", "pre_arrival", "event_brief", "brief_name_ask", "room_share_ask", "event_followthrough", "intro_nudge"]);
export function laneOf(type: string): Lane {
  return ROOM_LANE.has(type) ? "room" : "other";
}

export const LANE_CAPS: Record<Lane, { perDay: number; per7Days: number }> = {
  room: { perDay: RULES.roomMaxPerLocalDay, per7Days: RULES.roomMaxPer7Days },
  other: { perDay: RULES.maxPerLocalDay, per7Days: RULES.maxPer7Days },
};

// ignorePacing skips the daily cap, weekly cap and unanswered pause. Only a hand-run
// dispatch sets it (scripts/forceDispatch.ts); the cron never does.
export function userLevelChecks(state: Omit<PickState, "candidates">, opts: { skipHours?: boolean; lane?: Lane; ignorePacing?: boolean; legacyPace?: boolean } = {}): GateCheck[] {
  const lane = opts.lane ?? "other";
  const maxDay = LANE_CAPS[lane].perDay;
  const maxWeek = LANE_CAPS[lane].per7Days;
  const counted = state.sends.filter((s) => !s.exempt && laneOf(s.type) === lane);
  const dayStart = startOfLocalDay(state.now, state.timezone);
  const today = counted.filter((s) => s.sentAt >= dayStart && s.sentAt <= state.now).length;
  // Companion check-ins sit outside the weekly count (2026-09-28): the 3 a week
  // went to debriefs and follow-ups first, so a check-in was blocked 10 times in
  // two weeks. Their own 4-day rhythm (TYPE_POLICY) is their weekly limit; the
  // daily cap, spacing and unanswered pause still apply. Not a third lane
  // (Royce, 2026-09-18: "A third set of caps is guesswork at this volume").
  const week = counted.filter((s) => s.type !== "companion" && state.now.getTime() - s.sentAt.getTime() < 7 * DAY && s.sentAt <= state.now).length;
  // Each lane waits only on its own unanswered texts (2026-09-22). An
  // unanswered check-in still never pauses events (so follow-ups can't
  // isolate anyone from rooms), and now an unanswered offer never pauses Co
  // checking in on the person either: it used to, which is how an ignored
  // event offer kept a post-call reflection from ever going out.
  const pauseSource = counted;
  const lastCounted = pauseSource.filter((s) => s.sentAt <= state.now).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  const unansweredCount = pauseSource.filter((s) => s.sentAt <= state.now && unansweredSince(s, state.lastInboundAt)).length;
  // Pace follows engagement within the caps: a quiet member hears less, a
  // dormant one far less, and one text from them restores the full pace.
  // In-room nudges are sent to people who are busy in the room: their silence
  // says nothing about engagement, so they never push the tier or the long pauses.
  const unansweredOutsideRoom = pauseSource.filter((s) => s.type !== "in_room" && s.sentAt <= state.now && unansweredSince(s, state.lastInboundAt)).length;
  // legacyPace: the pace as it was before engagement scaling, for what must never be
  // slowed by it (a safety follow-up, an ask to an event guest).
  const tier = opts.legacyPace ? "active" : engagementTier(state.now, state.lastInboundAt, unansweredOutsideRoom);
  const cadence = CADENCE[tier];
  const effectiveWeek = cadence.weeklyCap === null ? maxWeek : Math.min(maxWeek, cadence.weeklyCap);
  const sinceLast = lastCounted ? (state.now.getTime() - lastCounted.sentAt.getTime()) / HOUR : Infinity;
  const pauseActive =
    !!lastCounted &&
    state.now.getTime() - lastCounted.sentAt.getTime() < (opts.legacyPace ? unansweredPauseFor(Math.min(unansweredCount, 2)) : Math.max(unansweredPauseFor(Math.min(unansweredCount, 2)), unansweredPauseFor(unansweredOutsideRoom))) * HOUR &&
    unansweredSince(lastCounted, state.lastInboundAt);

  const spacing = spacingCheck(state);
  const checks: GateCheck[] = [
    { name: "not_opted_out", pass: !state.optedOut, reason: "they opted out of texts" },
    { name: "mid_conversation", pass: !state.midConversation, reason: "they're mid-conversation with Co right now" },
  ];
  if (!opts.skipHours) {
    checks.push({
      name: "local_hours",
      pass: localHourOk(state.now, state.timezone),
      reason: `outside ${RULES.startHour}am-${RULES.endHour - 12}pm ${state.timezone ?? "Pacific (no time zone on file)"}`,
    });
  }
  if (!opts.ignorePacing) {
    checks.push(
      { name: "daily_cap", pass: today < maxDay, reason: `${today} ${lane}-lane proactive text(s) already today` },
      { name: "weekly_cap", pass: week < effectiveWeek, reason: `${week} ${lane}-lane proactive texts in the last 7 days${effectiveWeek < maxWeek ? ` (${tier}: ${effectiveWeek} a week)` : ""}` },
      { name: "engagement_pace", pass: sinceLast >= cadence.minGapHours, reason: `${tier}: at least ${Math.round(cadence.minGapHours / 24)} days between texts; the last was ${Math.round(sinceLast)}h ago` },
      spacing,
      {
        name: "unanswered_pause",
        pass: !pauseActive,
        reason: lastCounted ? `last proactive text (${lastCounted.type}) at ${lastCounted.sentAt.toISOString()} has no reply yet` : undefined,
      },
    );
  }
  return checks;
}

// Spacing between any two texts Co sends first, whatever their lane, answers
// included even though they don't count against the caps (Royce, 2026-10-02:
// "uncapped = no weekly quota, not no pacing"). Counting only capped texts let
// a profile offer land 15 minutes after a debrief (review of #55). Notices
// (an event change, a reminder they set) still don't space (task texts do, since #129):
// they're ledgered exempt and aren't answer types. An exempt event offer is an
// answer or rode along in a counted text, so it spaces either way.
// Task texts space too (review of #129): a find going out 15 minutes after a task update was the 11:30 incident reversed.
const TASK_TEXT_TYPES = new Set(["task_update", "task_window"]);
function spaces(s: SendRecord): boolean {
  return !s.exempt || ANSWERING_TYPES.has(s.type) || s.type === "event_offer" || TASK_TEXT_TYPES.has(s.type);
}
export function spacingCheck(state: Pick<PickState, "now" | "sends">): GateCheck {
  const lastAny = state.sends
    .filter((s) => spaces(s) && s.sentAt <= state.now)
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  return {
    name: "spacing",
    pass: !lastAny || state.now.getTime() - lastAny.sentAt.getTime() >= RULES.minHoursBetweenTexts * HOUR,
    reason: lastAny ? `a ${lastAny.type} went out less than ${RULES.minHoursBetweenTexts}h ago` : undefined,
  };
}

// The gates a Co-initiated exempt text waits on (sendExempt coInitiated, issue #126): spacing from any text Co sent first,
// the engagement pace, the unanswered pause, and the backoff for its kind. Not the daily/weekly caps: those are the offer
// lanes' quota, and a task text was never counted in them. Quiet hours are checked by the caller (respectHours).
const CO_INITIATED_GATES = new Set(["spacing", "engagement_pace", "unanswered_pause", "mid_conversation"]);
export function coInitiatedChecks(state: Omit<PickState, "candidates">, kind: ProactiveKind | null): GateCheck[] {
  const checks = userLevelChecks(state, { lane: "other", skipHours: true }).filter((c) => CO_INITIATED_GATES.has(c.name));
  if (kind) checks.push({ name: "kind_restraint", pass: !state.suppressedKinds?.includes(kind), reason: `they keep letting ${kind} texts pass` });
  return checks;
}
// How recent a text of theirs counts as mid-conversation, and how soon a text held for it looks again.
export const MID_CONVERSATION_MINUTES = 3;
export const MID_CONVERSATION_RETRY_MINUTES = 5;
// When a held Co-initiated text is worth another look, from the gate that held it (review of #129: a spacing-only retry woke a
// task paused on an unanswered text every hour until it ran out of wakes). Spacing clears at a known time; the unanswered pause
// and the engagement pace wait a day (their reply wakes a task that texted them sooner); a kind they've backed off from, a week.
export const CO_INITIATED_RETRY_HOURS = { spacing: 0, unanswered_pause: 24, engagement_pace: 24, kind_restraint: 24 * 7 } as const;
export function coInitiatedRetryAt(state: Pick<PickState, "now" | "sends">, failed: string[] = ["spacing"]): Date {
  // Held only because they're mid-conversation: a few minutes, not an hour (it's requeued, never dropped).
  const others = failed.filter((f) => f !== "mid_conversation");
  if (failed.length && !others.length) return new Date(state.now.getTime() + MID_CONVERSATION_RETRY_MINUTES * 60_000);
  failed = others;
  const last = state.sends.filter((s) => spaces(s) && s.sentAt <= state.now).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  const spaced = failed.includes("spacing") && last ? last.sentAt.getTime() + RULES.minHoursBetweenTexts * HOUR : 0;
  const waits = failed.map((f) => (CO_INITIATED_RETRY_HOURS as Record<string, number>)[f] ?? 24);
  return new Date(Math.max(spaced, state.now.getTime() + Math.max(1, ...waits) * HOUR));
}

// The Co-initiated gate, read inside the caller's lock (like sendWithLedger: a text that just went is seen). The backoff is read only
// for a send with a kind, and one it can't read holds that send (retried at retryAt) rather than going past a backoff it couldn't see.
async function coInitiatedHold(client: Queryable, o: { userId: string; timezone: string | null; now: Date; kind: ProactiveKind | null }): Promise<{ failed: GateCheck[]; sends: SendRecord[] }> {
  const sends = await loadSends(client, o.userId);
  const lastInboundAt = await loadLastInbound(client, o.userId);
  const suppressed = o.kind ? await loadKindRestraint(client, o.userId, o.now).then((r) => suppressedKinds(r.verdicts)).catch(() => null) : [];
  // Can't tell: held a few minutes rather than texting into a conversation (fail safe, requeued).
  const midConversation = await midConversationNow(client, o.userId, o.now, lastInboundAt);
  const failed = suppressed
    ? coInitiatedChecks({ now: o.now, timezone: o.timezone, optedOut: false, sends, lastInboundAt, suppressedKinds: suppressed, midConversation }, o.kind).filter((c) => !c.pass)
    : [{ name: "kind_restraint", pass: false, reason: "couldn't read their backoff" }];
  return { failed, sends };
}

// A Co-initiated send that isn't a text through sendExempt (a look-out's document, PDF or Google Doc, services/documentDelivery.ts):
// the same gate and the same ledger row, claimed before it goes (Royce, 2026-10-09: "a Co lookout must not be able to send an
// uncounted PDF"). The caller delivers, then releases the claim if nothing went out, so a send that failed never counts as let pass.
export async function claimCoInitiatedSend(o: { userId: string; type: ExemptType; targetKey: string; message: string; kind: ProactiveKind | null; timezone: string | null; now?: Date }): Promise<{ ok: true; ledgerId: number } | { ok: false; reason: string; retryAt?: Date }> {
  if (proactivePaused()) return { ok: false, reason: "proactive outreach is paused" };
  const now = o.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`proactive:${o.userId}`]);
    const out = await client.query(`SELECT COALESCE(sms_opted_out, false) AS opted_out FROM users WHERE id = $1`, [o.userId]).then((r) => r.rows[0]?.opted_out === true);
    if (out) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "opted out" };
    }
    const { failed, sends } = await coInitiatedHold(client, { userId: o.userId, timezone: o.timezone, now, kind: o.kind });
    if (failed.length) {
      await client.query("ROLLBACK");
      const reason = failed.map((c) => c.reason ?? c.name).join("; ");
      await recordDecision({ layer: 7, decision: "proactive.exemptSend", userId: o.userId, outcome: "skip", action: "held_co_initiated", reason, proposal: { type: o.type, targetKey: o.targetKey } }).catch(() => {});
      return { ok: false, reason: `held: ${reason}`, retryAt: coInitiatedRetryAt({ now, sends }, failed.map((c) => c.name)) };
    }
    const ins = await client.query(
      `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, kind)
       VALUES ($1, $2, $3, $3, $4, true, $5)
       ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`,
      [o.userId, o.type, o.targetKey, o.message, o.kind],
    );
    await client.query("COMMIT");
    return ins.rows[0] ? { ok: true, ledgerId: Number(ins.rows[0].id) } : { ok: false, reason: "already sent" };
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, reason: `couldn't claim the send (${String(err?.message ?? err).slice(0, 80)})` };
  } finally {
    client.release();
  }
}
// Nothing went out: the claim comes off the ledger, so it never counts as sent or let pass.
export async function releaseCoInitiatedClaim(userId: string, ledgerId: number): Promise<void> {
  await pool.query(`DELETE FROM proactive_sends WHERE user_id = $1 AND id = $2`, [userId, ledgerId]);
}

// A watching offer Co made inside a reply ("want me to keep an eye out for X?"): logged as a Co-initiated find, so a yes that opens a
// member look-out was paid for at the door (Royce, 2026-10-09, option 1). Bookkeeping after the reply went; never a gate on it.
export const REPLY_WATCH_OFFER_TYPE = "watch_offer";
export async function recordReplyWatchOffer(userId: string, message: string, now: Date = new Date()): Promise<void> {
  await pool.query(
    `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, kind, sent_at)
     VALUES ($1, $2, $3, $3, $4, true, 'find', $5)
     ON CONFLICT (user_id, target_key) DO NOTHING`,
    [userId, REPLY_WATCH_OFFER_TYPE, `${REPLY_WATCH_OFFER_TYPE}:${now.getTime()}`, message.slice(0, 2000), now],
  );
}

// Whether the offer in Co's last line is on the ledger as a find (logged by a reply in the last two days). Matched on the words, so a
// reply's beats split or joined differently still match.
export async function replyWatchOfferLogged(userId: string, lastCoLine: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT message FROM proactive_sends WHERE user_id = $1 AND type = $2 AND sent_at > NOW() - INTERVAL '48 hours' ORDER BY sent_at DESC LIMIT 10`,
    [userId, REPLY_WATCH_OFFER_TYPE],
  );
  return rows.some((r: any) => watchOfferMatches(String(r.message ?? ""), lastCoLine));
}
// Pure: a logged offer is the one in this line of Co's.
export function watchOfferMatches(logged: string, lastCoLine: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const a = n(logged), b = n(lastCoLine);
  return a.length >= 12 && (b.includes(a) || a.includes(b));
}

// answering: a reply (isAnswering) doesn't wait on the last text of its type
// (two time frames they named are two replies); the same topic still waits.
// A new member's first day has no companion check-in (intelligence audit, 2026-10-12: all seven new members got one within about 20
// minutes of joining, one 40 seconds after Co's reply). The door (services/theDoor.ts) already tells them what Co does next and when
// (the first look, today or tomorrow, a task that texts them itself); a check-in before then talks over that promise. A safety
// follow-up is never held by it.
export const NEW_MEMBER_QUIET_HOURS = 24;
export function candidateChecks(c: Candidate, state: Pick<PickState, "now" | "sends" | "lastInboundAt" | "needsCare" | "safetyHold" | "undeliveredYes" | "suppressedKinds" | "away" | "joinedAt">, opts: { answering?: boolean } = {}): GateCheck[] {
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
  if (PROACTIVE_PURPOSE_MAP[c.type] === "companion" && (c.payload as { safetyFollowUp?: boolean } | null)?.safetyFollowUp !== true && state.joinedAt) {
    checks.push({
      name: "new_member_quiet",
      pass: state.now.getTime() - state.joinedAt.getTime() >= NEW_MEMBER_QUIET_HOURS * HOUR,
      reason: `they joined less than ${NEW_MEMBER_QUIET_HOURS}h ago; the first check-in waits a day`,
    });
  }
  if (policy.typeGapDays !== undefined && !opts.answering) {
    checks.push({
      name: "type_gap",
      // The day-after check-in following a safety concern never waits on the last check-in.
      pass: !lastOfType || (c.payload as { safetyFollowUp?: boolean })?.safetyFollowUp === true || state.now.getTime() - lastOfType.sentAt.getTime() >= policy.typeGapDays * DAY,
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
  const tried = Date.parse(String((c.payload as { relevanceTriedAt?: string })?.relevanceTriedAt ?? ""));
  if (tried && state.now.getTime() - tried < RELEVANCE_RETRY_HOURS * HOUR) {
    checks.push({ name: "relevance_retry", pass: false, reason: "Co couldn't say if it's still relevant; trying again shortly" });
  }
  // "Asked, got yes, delivered nothing, asked again" (2026-10-03): a tease is a
  // question whose answer is a reveal; while an earlier yes is still owed its
  // answer, asking another one just repeats the loop.
  if (c.type === "network_tease" && state.undeliveredYes) {
    checks.push({ name: "no_undelivered_yes", pass: false, reason: "they said yes to hearing who and nothing was delivered; no new tease until that clears" });
  }
  if (state.safetyHold && PROACTIVE_PURPOSE_MAP[c.type] === "offer") {
    checks.push({ name: "safety_hold", pass: false, reason: "they may not have been safe in the last few days; no offers" });
  }
  // Away from home, in their own words (services/away.ts, 2026-10-11: Jacqueline said she was traveling and SF finds kept coming):
  // a find Co started that brings them into a room waits until they're back; an answer to their own ask never does (awayHoldsCandidate).
  // It stays pending, so a find
  // still ahead when they return can go then; one whose date passes expires as usual.
  if (state.away && awayHoldsCandidate(c)) {
    checks.push({ name: "away_hold", pass: false, reason: awayHoldReason(state.away) });
  }
  if (state.needsCare && HOLD_WHILE_STRUGGLING.has(c.type)) {
    checks.push({ name: "emotional_timing", pass: false, reason: "they've been struggling in the last day; this can wait" });
  }
  // Restraint with memory (services/kindRestraint.ts): a kind of text they let pass twice in a row isn't sent again until they answer
  // one. An answer to their own explicit ask (an event offer for an open ask) is never held back: they asked.
  const kind = kindOf(c.type, c.payload);
  if (kind && !(kind === "find" && isAnswering(c)) && state.suppressedKinds?.includes(kind)) {
    checks.push({ name: "kind_restraint", pass: false, reason: `they let the last ${RESTRAINT.ignoredToSuppress} ${kind} texts pass with no reply or reaction; Co stopped sending these until they answer one` });
  }
  // One goal surface a season, across the seasonal check-in and the goal nudge (services/goalJourney.ts GOAL_CHECKIN). A goal recheck
  // text (services/goalRecheck.ts) counts as one too, so the three never land close together.
  if (c.type === "goal_checkin" || c.type === "goal_nudge") {
    const lastGoal = state.sends.filter((s) => (s.type === "goal_checkin" || s.type === "goal_nudge" || s.type === "goal_recheck") && s.sentAt <= state.now).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
    checks.push({
      name: "goal_season",
      pass: !lastGoal || state.now.getTime() - lastGoal.sentAt.getTime() >= GOAL_SEASON_DAYS * DAY,
      reason: lastGoal ? `a ${lastGoal.type} went out within ${GOAL_SEASON_DAYS} days` : undefined,
    });
  }
  return checks;
}

const PERSON_CHECKS = new Set(["not_opted_out", "local_hours"]);
// A safety follow-up is never held for a conversation going on (review of the concurrency fix: dispatch runs every 30 minutes, so a
// hold could delay it that long). Every other proactive text waits.
const isSafetyFollowUp = (c: Pick<Candidate, "payload">) => (c.payload as { safetyFollowUp?: boolean } | null)?.safetyFollowUp === true;
const safetyPassesHold = (k: GateCheck, c: Pick<Candidate, "payload">) => k.name === "mid_conversation" && isSafetyFollowUp(c);
// The quota an answer skips. Spacing is not in it: every text keeps it.
const QUOTA_CHECKS = new Set(["daily_cap", "weekly_cap", "unanswered_pause", "engagement_pace"]);
// A morning find (Royce, 2026-10-13: after the 9am sweep, "members get their finds" right away, the usual send limits not applying):
// a find the picker chose right after their 9am sweep, marked by services/dailySweep.ts with that day (payload.morningDay). On that
// day it skips the pacing (the caps, the unanswered pause, the engagement pace and the spacing) and doesn't count against the caps.
// Hours, opt-out, mid-conversation and every candidate check (safety, away, emotional timing, repeats) still apply.
const MORNING_SKIPS = new Set([...QUOTA_CHECKS, "spacing"]);
export function morningFind(c: Pick<Candidate, "type" | "payload">, now: Date, timezone: string | null): boolean {
  const day = (c.payload as { morningDay?: string } | null)?.morningDay;
  return c.type === "event_offer" && typeof day === "string" && day === DateTime.fromJSDate(now).setZone(hoursZone(timezone)).toISODate();
}

// Replies, not broadcasts (Royce, 2026-10-02): anything answering a member's
// explicit ask, a conversation they're in, or a deadline they care about goes
// out whenever it's ready: no daily or weekly quota, no unanswered pause, and
// it isn't counted against the caps. It still keeps 3h spacing from any text
// Co sent. Only unsolicited discovery ("saw this and thought of you") has a
// quota. Opt-out, local hours, never-twice, safety and the struggling hold
// still apply. An answer that's waited over a day is re-checked first
// (stillRelevant).
//   - An event offer for an open ask (not from their profile), including a
//     reminder about one. A reminder or a 30-day resurface of a profile offer
//     is still discovery: they never asked, and may have ignored it.
//   - A network tease: always for an open ask (networkIntroNudge.ts).
//   - Follow-ups on what they said or did: an ask check-in, a time frame they
//     named, a debrief on an event they went to, a pre-arrival text, the text
//     after a call they were on.
// Discovery: profile offers, guest-match nudges. Companion check-ins (advice
// follow-ups too) keep their own 4-day rhythm and the daily cap, as before.
// deadline_nudge is NOT here: it's Co's own heads-up, so the daily and weekly caps and the type gap apply (review of the branch,
// 2026-10-08: three yeses in a weekend meant three heads-ups in a day).
const ANSWERING_TYPES = new Set<string>(["network_tease", "ask_checkin", "window_followup", "debrief", "pre_arrival", "post_call", "event_followthrough", "goal_closed"]);
export function isAnswering(c: Pick<Candidate, "type" | "payload">): boolean {
  const p = (c.payload ?? {}) as { askId?: string | null; fromProfile?: boolean; again?: boolean };
  if (ANSWERING_TYPES.has(c.type)) return true;
  if (c.type === "event_offer") return !!p.askId && p.askId !== "profile" && p.fromProfile !== true && p.again !== true;
  return false;
}

// What the engagement pace never holds: a safety follow-up, and the ask sent to an
// event guest who hasn't stated one (never held, so they aren't left out of the room).
export function pacedByEngagement(c: Pick<Candidate, "type" | "payload">): boolean {
  return !(c.type === "ask_solicitation" || (c.payload as { safetyFollowUp?: boolean } | null)?.safetyFollowUp === true);
}

export function evaluateCandidates(state: PickState, opts: { ignorePacing?: boolean } = {}): Evaluation {
  // Opt-out and local hours apply to the person; caps and the unanswered
  // pause apply per lane, so each candidate is checked against its own lane.
  const byLane: Record<Lane, GateCheck[]> = {
    room: userLevelChecks(state, { lane: "room", ignorePacing: opts.ignorePacing }),
    other: userLevelChecks(state, { lane: "other", ignorePacing: opts.ignorePacing }),
  };
  const legacyByLane: Record<Lane, GateCheck[]> = {
    room: userLevelChecks(state, { lane: "room", ignorePacing: opts.ignorePacing, legacyPace: true }),
    other: userLevelChecks(state, { lane: "other", ignorePacing: opts.ignorePacing, legacyPace: true }),
  };
  const userChecks = byLane.other.filter((k) => PERSON_CHECKS.has(k.name));
  const userOk = gate(userChecks).ok;
  const perCandidate = state.candidates.map((candidate) => {
    const answering = isAnswering(candidate);
    const morning = morningFind(candidate, state.now, state.timezone);
    const laneChecks = (pacedByEngagement(candidate) ? byLane : legacyByLane)[laneOf(candidate.type)].filter(
      (k) => !PERSON_CHECKS.has(k.name) && !(answering && QUOTA_CHECKS.has(k.name)) && !(morning && MORNING_SKIPS.has(k.name)) && !(candidate.type === "companion" && k.name === "weekly_cap") && !safetyPassesHold(k, candidate),
    );
    const checks = [...laneChecks, ...candidateChecks(candidate, state, { answering })];
    return { candidate, checks, ok: gate(checks).ok };
  });
  const eligible = userOk ? perCandidate.filter((p) => p.ok).map((p) => p.candidate) : [];
  return { userChecks, userOk, perCandidate, eligible };
}

// Whether a text stays off the caps. One text counts once however many offers
// ride in it (the extras are always exempt); it counts at all only when
// something in it is discovery, so a profile offer riding along with an
// answer still uses one of the week's discovery sends.
export function sendIsExempt(primary: Candidate, extras: Candidate[], ignorePacing = false): boolean {
  return ignorePacing || [primary, ...extras].every(isAnswering);
}

// Every tier that has something goes out together (2026-09-21): the picked
// offer plus the best other waiting offer from each tier not yet in the group.
// Reminders (a deadline heads-up) ride alone.
// How many of the daily pick's choices go in one message (its own send limit).
export const MAX_PICKED_TOGETHER = 3;
// Up to three discovery finds a day, whatever sends them (Royce's ruling relayed 2026-10-14: "one per tier means up to 3 morning finds a
// day"): the morning bundle counts toward it, a later pick that day goes only while the day's count is under it, and a retried morning
// run never queues past it (services/sweepShadow.ts). Answers to what they asked for are never capped (#55: answers are uncapped), and
// don't count. The weekly cap stays skipped for the morning; silence pacing is the guardrail.
export const DAILY_FIND_CAP = 3;
// Pure: a find Co brings up itself (not an answer to their ask, not a deadline reminder): what the day's cap counts.
export function isDiscoveryFind(c: Pick<Candidate, "type" | "payload">): boolean {
  return c.type === "event_offer" && !(c.payload as { reminder?: boolean } | null)?.reminder && !isAnswering(c);
}
// Pure: how many more discovery finds may go today.
export function findsLeftToday(sentToday: number): number {
  return Math.max(0, DAILY_FIND_CAP - sentToday);
}
// Pure: a find bundle under the day's cap. An answer leads whatever the count; a discovery lead waits for tomorrow at the cap; discovery
// siblings are trimmed to what's left, answers never.
export function capBundle<T extends Pick<Candidate, "type" | "payload">>(lead: T, sibs: T[], left: number): { deferLead: boolean; sibs: T[] } {
  if (isDiscoveryFind(lead) && left <= 0) return { deferLead: true, sibs: [] };
  let room = left - (isDiscoveryFind(lead) ? 1 : 0);
  return { deferLead: false, sibs: sibs.filter((x) => !isDiscoveryFind(x) || room-- > 0) };
}
// The SQL twin of isDiscoveryFind, for a candidate row's payload.
const DISCOVERY_SQL = `type = 'event_offer' AND COALESCE(payload->>'reminder', 'false') <> 'true' AND NOT (COALESCE(payload->>'askId', '') NOT IN ('', 'profile') AND COALESCE(payload->>'fromProfile', 'false') <> 'true' AND COALESCE(payload->>'again', 'false') <> 'true')`;
// Discovery finds that went out today, in their day. db: the send's own locked connection when re-checked at send time. Unreadable reads
// as the cap reached at the call sites: nothing extra goes on a guess.
export async function findsSentToday(userId: string, zone: string | null, now: Date, db: Queryable = pool): Promise<number> {
  const start = DateTime.fromJSDate(now).setZone(hoursZone(zone)).startOf("day").toJSDate();
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM proactive_candidates WHERE user_id = $1 AND status = 'sent' AND ${DISCOVERY_SQL} AND COALESCE(decided_at, updated_at) >= $2`, [userId, start]);
  return Number(rows[0]?.n ?? 0);
}
const isPicked = (c: Candidate) => c.type === "event_offer" && Boolean((c.payload as { picked?: boolean })?.picked) && !(c.payload as { reminder?: boolean })?.reminder;
// Most time-bound first: priority (a pick's last day sets it), then whichever expires soonest, then oldest.
const byUrgency = (a: Candidate, b: Candidate) => b.priority - a.priority || (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) || a.dueAt.getTime() - b.dueAt.getTime();
// A morning find (payload.morningDay): the 9am floor's picks go out together, ahead of any earlier pick still waiting.
const morningOf = (c: Candidate) => (c.payload as { morningDay?: string } | null)?.morningDay ?? null;
// Pure: when the pick is one of the daily pick's choices, the bundle leads with the most time-bound of them (Royce, 2026-10-09:
// Fleet Week first), whichever of them was picked. A morning find leads among that morning's finds only.
export function leadPick(primary: Candidate, eligible: Candidate[]): Candidate {
  if (!isPicked(primary)) return primary;
  const day = morningOf(primary);
  return [primary, ...eligible.filter((c) => c.id !== primary.id && isPicked(c) && (!day || morningOf(c) === day))].sort(byUrgency)[0];
}

export function pickSiblingOffers(primary: Candidate, eligible: Candidate[]): Candidate[] {
  const tierOf = (c: Candidate) => Number((c.payload as { match?: { tier?: number } })?.match?.tier ?? 0);
  const isReminder = (c: Candidate) => Boolean((c.payload as { reminder?: boolean })?.reminder);
  if (primary.type !== "event_offer" || isReminder(primary)) return [];
  const seen = new Set([tierOf(primary)]);
  const out: Candidate[] = [];
  const ranked = [...eligible]
    .filter((c) => c.type === "event_offer" && c.id !== primary.id && !isReminder(c))
    .sort(byUrgency);
  // The daily pick's choices go together (Royce, 2026-10-09: "One message replaces the drip"): each with its link and caption, one
  // question after the last. Still the one find-send a day. One per tier, never two from the same tier (Royce, 2026-10-14: "one find
  // per tier"), so at most MAX_PICKED_TOGETHER; a morning's finds go with that morning's finds first.
  if (isPicked(primary)) {
    const day = morningOf(primary);
    // The picker's tiers (sweepSelect.ts tierOf): 1 Co events, 2 events, anything else an opening.
    const pickTier = (c: Candidate) => { const t = tierOf(c); return t === 1 || t === 2 ? t : 3; };
    const taken = new Set([pickTier(primary)]);
    const picked = ranked.filter(isPicked).sort((a, b) => Number(!!day && morningOf(b) === day) - Number(!!day && morningOf(a) === day));
    for (const c of picked) {
      const t = pickTier(c);
      if (taken.has(t)) continue;
      taken.add(t);
      out.push(c);
    }
    return out.slice(0, MAX_PICKED_TOGETHER - 1);
  }
  for (const c of ranked) {
    const t = tierOf(c);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(c);
  }
  return out;
}

// Pure: what a failed bundle does to its lead. A lead the composer skipped is dropped (a skipped tier pick also queues its tier's next
// best); any other failure counts an attempt and drops it at the last one (as before the tier PR: review, the tier-next branch had
// captured this else).
export function failedBundleActions(res: { leadSkipped?: boolean; tierSkipped?: boolean }, attempts: number): ("drop_skipped" | "queue_tier_next" | "count_attempt" | "drop_failed")[] {
  if (res.leadSkipped) return res.tierSkipped ? ["drop_skipped", "queue_tier_next"] : ["drop_skipped"];
  return attempts + 1 >= RULES.maxDraftAttempts ? ["count_attempt", "drop_failed"] : ["count_attempt"];
}

// Deterministic pick: a companion message first (2026-09-22, Royce: Co is a
// companion first; events are the wedge), then priority, then whichever
// expires soonest, then oldest. On 2026-09-22 an event offer boosted to 85
// because the member seemed frustrated beat a post-call reflection (80), and
// the offer's unanswered pause then kept the reflection from ever going out.
// The offer still goes: it's in its own lane with its own daily slot, so it
// just waits for the next pick.
const isCompanion = (c: Candidate) => PROACTIVE_PURPOSE_MAP[c.type] === "companion";
export function codePick(eligible: Candidate[]): Candidate | null {
  const sorted = [...eligible].sort(
    (a, b) =>
      Number(isCompanion(b)) - Number(isCompanion(a)) ||
      b.priority - a.priority ||
      (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) ||
      a.dueAt.getTime() - b.dueAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return sorted[0] ?? null;
}

// Urgency beats relationship maintenance (Royce, 2026-10-09: at 2:45 the pick sent a debrief while Fleet Week waited on its
// final day). A find whose useful life ends before the next realistic send slot goes ahead of a companion message that can wait;
// one with days left never jumps the queue. What can't wait isn't jumped: a post-call text (they just hung up) or anything that
// itself expires sooner.
const FIND_TYPES = new Set(["event_offer", "event_match_nudge", "deadline_nudge"]);
// Real candidates that can't wait for tomorrow either: a post-call text (they just hung up), what goes before an event (the note, the
// brief, the brief's name ask, a guest's ask before it), and a lapse notice. A find never jumps these (review of #132).
const CANT_WAIT = new Set(["post_call", "pre_arrival", "event_brief", "brief_name_ask", "room_share_ask", "ask_solicitation", "artifact_expiry"]);

// Pure: when a find's useful life ends: its own expiry, or the end of the last day the picker gave it, whichever is first.
export function findEndsAt(c: Pick<Candidate, "expiresAt" | "payload">, zone: string | null): Date | null {
  const lastDay = (c.payload as { lastDay?: string } | null)?.lastDay;
  const dayEnd = lastDay ? DateTime.fromISO(lastDay, { zone: hoursZone(zone) }).endOf("day").toJSDate() : null;
  const ends = [c.expiresAt, dayEnd].filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  return ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null;
}

// Pure: when the find could next go if something else goes now. Spacing from now, inside their hours (8am to 9pm their time); and
// tomorrow when the find's own lane has used today's counted slot, counting the other send only when it's counted and in that lane
// (review of #132: an answer isn't counted, and an event offer is in the room lane, so a debrief at 2:45 left Fleet Week a 5:45 slot).
export function nextSendSlot(o: { now: Date; zone: string | null; findLane: Lane; findCounted: boolean; countedToday: Record<Lane, number>; other: { lane: Lane; counted: boolean } | null }): Date {
  const z = hoursZone(o.zone);
  const local = DateTime.fromJSDate(o.now).setZone(z);
  const tomorrow = local.plus({ days: 1 }).set({ hour: RULES.startHour, minute: 0, second: 0, millisecond: 0 });
  let t = DateTime.fromJSDate(new Date(o.now.getTime() + RULES.minHoursBetweenTexts * HOUR)).setZone(z);
  const used = o.countedToday[o.findLane] + (o.other && o.other.counted && o.other.lane === o.findLane ? 1 : 0);
  const capped = o.findCounted && used >= LANE_CAPS[o.findLane].perDay;
  if (capped || !t.hasSame(local, "day") || t.hour >= RULES.endHour) t = tomorrow;
  else if (t.hour < RULES.startHour) t = t.set({ hour: RULES.startHour, minute: 0, second: 0, millisecond: 0 });
  return t.toJSDate();
}

// Pure: the find that has to go now or not at all, if any. Only a find the daily picker chose (payload.picked: it already weighed
// their stated taste), only when what would go instead can wait (no can't-wait type, nothing else ending before the find does), and
// only when its end comes before the next slot it could realistically get. Soonest-ending first.
export function expiringFind(eligible: Candidate[], o: { now: Date; zone: string | null; sends: SendRecord[] }): { pick: Candidate; endsAt: Date; nextSlot: Date } | null {
  if (eligible.some((c) => CANT_WAIT.has(c.type))) return null;
  const others = eligible.filter((c) => !FIND_TYPES.has(c.type));
  if (!others.length) return null;
  const dayStart = startOfLocalDay(o.now, o.zone);
  const countedToday: Record<Lane, number> = { room: 0, other: 0 };
  for (const s of o.sends) if (!s.exempt && s.sentAt >= dayStart && s.sentAt <= o.now) countedToday[laneOf(s.type)]++;
  // What would go instead: the companion-first code pick among the rest.
  const other = codePick(others);
  const otherInfo = other ? { lane: laneOf(other.type), counted: !isAnswering(other) } : null;
  const finds = eligible
    .filter((c) => FIND_TYPES.has(c.type) && (c.payload as { picked?: boolean } | null)?.picked === true)
    .map((c) => ({ c, endsAt: findEndsAt(c, o.zone) }))
    .filter((x): x is { c: Candidate; endsAt: Date } => !!x.endsAt && x.endsAt.getTime() > o.now.getTime())
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
  for (const f of finds) {
    // Something else ending first can't wait either.
    if (others.some((c) => c.expiresAt && c.expiresAt.getTime() <= f.endsAt.getTime())) continue;
    const nextSlot = nextSendSlot({ now: o.now, zone: o.zone, findLane: laneOf(f.c.type), findCounted: !isAnswering(f.c), countedToday, other: otherInfo });
    if (f.endsAt.getTime() <= nextSlot.getTime()) return { pick: f.c, endsAt: f.endsAt, nextSlot };
  }
  return null;
}

// A find on its last day outranks what is still true tomorrow (Royce, 2026-10-12: Fleet Week was queued top priority on its last
// day and lost both daily runs to debriefs). expiringFind covers a find that would miss its next slot; this covers the rest of its
// last day: when what was chosen to go (Co's pick) is not a find, can wait (not a can't-wait type) and is still true tomorrow, a
// picked find whose end falls inside their local today goes first instead, soonest-ending first. Only finds in the eligible set,
// so caps, hours and spacing still apply; the chosen message waits for its next slot.
// Never past a safety follow-up or an answer owed to them (an answering type other than a debrief, which is Co's own question and
// the case this rule is for).
export function lastDayFirst(chosen: Candidate | null, eligible: Candidate[], o: { now: Date; zone: string | null }): { pick: Candidate; endsAt: Date } | null {
  if (!chosen || FIND_TYPES.has(chosen.type) || CANT_WAIT.has(chosen.type)) return null;
  if (isSafetyFollowUp(chosen) || (isAnswering(chosen) && chosen.type !== "debrief")) return null;
  const endOfToday = DateTime.fromJSDate(o.now).setZone(hoursZone(o.zone)).endOf("day").toJSDate();
  if (chosen.expiresAt && chosen.expiresAt.getTime() <= endOfToday.getTime()) return null;
  const finds = eligible
    .filter((c) => FIND_TYPES.has(c.type) && (c.payload as { picked?: boolean } | null)?.picked === true)
    .map((c) => ({ pick: c, endsAt: findEndsAt(c, o.zone) }))
    .filter((x): x is { pick: Candidate; endsAt: Date } => !!x.endsAt && x.endsAt.getTime() > o.now.getTime() && x.endsAt.getTime() <= endOfToday.getTime())
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
  return finds[0] ?? null;
}

// Pure: when a candidate stops being true, as a fact for Co's pick: a find's end (findEndsAt), else its own expiry.
export function endsFact(c: Pick<Candidate, "type" | "expiresAt" | "payload">, o: { now: Date; zone: string | null }): string {
  const end = FIND_TYPES.has(c.type) ? findEndsAt(c, o.zone) : c.expiresAt;
  if (!end || Number.isNaN(end.getTime())) return "no end date, still true tomorrow";
  const z = hoursZone(o.zone);
  const today = DateTime.fromJSDate(o.now).setZone(z);
  const at = DateTime.fromJSDate(end).setZone(z);
  if (at.hasSame(today, "day")) return `last day today, ends ${localStamp(end, o.zone)}`;
  return `still true tomorrow, ends ${localStamp(end, o.zone)}`;
}

// ---------- drafting

// Principles, not scripts (Royce, 2026-09-28: "I don't want the language to be
// so strict"). No quoted phrasings: the model copies examples it's shown.
export const PROACTIVE_RULES = `PROACTIVE RULES
- One message, one reason. If you can't name the specific thing you're reaching out about, return SKIP.
- Name the actual thing: the event by its name, the person, what they said.
- Only say what another person said, feels, or wants when it's written in CONFIRMED_FACTS.
- Days, dates, times, events, deadlines and commitments: state one only if it is in CONFIRMED_FACTS as a date or something they said just now. Background facts tell you who they are; they are never a source for a date, an event or what they are preparing for. If you don't have one, ask instead of stating (a question about what is coming up this week invents nothing).
- Talk like a person who noticed something, never like a system explaining why it matched them.
- If you're asking for a decision, end with one yes/no question. Otherwise don't ask anything.
- Keep it short, a text or two, and get to what you're reaching out about. Say it your own way each time; a greeting is fine when it's natural, never a formula.
- Start with a capital letter. You're texting first, so there's no lowercase style to mirror.`;

export type Facts = Record<string, string | number | boolean | string[] | null | undefined>;

export function renderFacts(facts: Facts): string {
  const lines = Object.entries(facts)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join("; ") : String(v)}`);
  return lines.length ? lines.join("\n") : "- (nothing beyond what's described below)";
}

// ---------- what Co knows about them (services/memberKnowledge.ts)

// The sections a dispatch reads, in its one memberKnowledge call. Claims stay out: a draft states only CONFIRMED_FACTS.
export const DISPATCH_KNOWLEDGE: readonly KnowledgeSection[] = ["goals", "asks", "delivered", "carrying", "lessons", "corrections", "preferences", "restraint", "exchanges", "person"];
// The transcript the pick, the relevance check, the repeat-question check and payload first read: the last 12 exchanges, as far
// back as they go (the same window the dispatch always read).
export const DISPATCH_EXCHANGES = { exchanges: 12, exchangeDays: 365 } as const;
// Types whose draft builds its own member section from memberKnowledge (jobs/postCallFollowUp.ts, PR #121): the dispatch hands
// them no member block, so the lists and rules aren't in the prompt twice.
export const OWN_MEMBER_CONTEXT: ReadonlySet<ProactiveType> = new Set<ProactiveType>(["post_call"]);

// Pure: the exchanges as the thread is stored ("User said: ..." / "Co replied: ..." / "[Call] ..."), oldest first, for the code
// that parses it (harness/repeatAsk.ts turnsFromConversation, harness/payloadFirst.ts theirText). With stamps, each line opens
// with when it was said in their zone, for the model reads (the pick, the relevance check).
export function exchangeTranscript(k: Pick<MemberKnowledge, "exchanges" | "identity">, o: { stamped?: boolean } = {}): string {
  return k.exchanges
    .map((e) => {
      const line = e.from === "member" ? `User said: ${e.text}` : e.call ? `[Call] ${e.text}` : `Co replied: ${e.text}`;
      return o.stamped ? `[${localStamp(e.verifiedAt, k.identity.zone)}] ${line}` : line;
    })
    .join("\n");
}

// Pure: what a proactive draft is told about the member, and the member-level rules (memberRules: discretion, member safety,
// grounding, delivery shape, restraint, quiet hours) as they are, never restated. Background only: CONFIRMED_FACTS stays the one
// source of what the text states, and the date guard (proactiveSpecifics.ts) reads only those. The gates already ran in code, so
// none of this is a reason to SKIP a text that is cleared to go.
export function memberDraftBlock(k: MemberKnowledge, rules: MemberRules): string {
  const day = (iso: string) => localStamp(iso, k.identity.zone).replace(/,.*$/, "");
  const cap = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const lines: string[] = [];
  const active = k.goals.filter((g) => g.state === "active").slice(0, 4);
  const past = k.goals.filter((g) => g.state !== "active").slice(0, 3);
  if (active.length) lines.push(`- Where they say they're headed (the lens: never recite it): ${active.map((g) => cap(g.text, 120)).join("; ")}`);
  if (past.length) lines.push(`- Goals that are done or set aside (history, never current direction): ${past.map((g) => `${cap(g.text, 100)} (${g.state})`).join("; ")}`);
  if (k.asks.length) lines.push(`- What they've asked Co for that's still open: ${k.asks.slice(0, 5).map((a) => cap(a.text, 120)).join("; ")}`);
  const sent = k.delivered.slice(0, 10);
  if (sent.length) lines.push(`- Already sent them (don't re-pitch any as new; a reminder, follow-up or update about one is fine): ${sent.map((d) => `${cap(d.what, 80)} (${d.kind}, ${day(d.at)}${d.reaction ? `, they reacted: ${cap(d.reaction, 40)}` : ""})`).join("; ")}`);
  const carrying = k.carrying.filter((c) => c.state !== "done").slice(0, 6);
  if (carrying.length) lines.push(`- What Co is carrying for them: ${carrying.map((c) => `${cap(c.what, 100)} (${c.kind}, ${c.state}${c.told ? ", they know" : ""})`).join("; ")}`);
  if (k.corrections.length) lines.push(`- They corrected (only the corrected version exists): ${k.corrections.slice(0, 4).map((c) => `${c.field}: ${c.now ? cap(c.now, 80) : "(removed)"}, not ${cap(c.was, 60)}`).join("; ")}`);
  const stated = k.preferences.filter((p) => p.source === "stated");
  const landed = k.preferences.filter((p) => p.source !== "stated");
  if (stated.length) lines.push(`- What kind of room they've said they want (their words): ${stated.map((p) => cap(p.text, 300)).join("; ")}`);
  if (landed.length) lines.push(`- What has landed with them before: ${landed.map((p) => cap(p.text, 300)).join("; ")}`);
  if (k.lessons.length) lines.push(`- What Co has learned about texting them: ${k.lessons.slice(0, 4).map((l) => cap(l.text, 160)).join("; ")}`);
  const memberRules = [rules.discretion, rules.memberSafety, rules.grounding, rules.deliveryShape, rules.restraint, rules.quietHours].filter((r) => r && r.trim()).join("\n\n");
  return `WHAT YOU KNOW ABOUT THEM (background: it shapes what you say and what you leave out; it is never a source for a date, an event or a commitment, and never something to state that CONFIRMED_FACTS doesn't have)
${lines.length ? lines.join("\n") : "- (nothing more on file)"}

MEMBER RULES (they hold for this member everywhere; code already cleared this text to go, so none of them is a reason to SKIP it)
${memberRules}`;
}

// A test seam: a fake model for draftProactive, so the guard below can be exercised with zero tokens.
let testModel: ((prompt: string) => Promise<string>) | null = null;
export function setProactiveModelForTests(fn: typeof testModel): void {
  testModel = fn;
}

// Returns the cleaned message, or null when the model chose SKIP, or when the draft states a day, event or commitment that
// nothing real backs (harness/proactiveSpecifics.ts): it is redrafted once with the problem named, and then not sent.
export async function draftProactive(opts: {
  functionId: string;
  firstName: string;
  facts: Facts;
  task: string;
  model?: string;
  // Most types are one or two sentences; a few (post-call reflection) need room.
  maxSentences?: number;
  // Fact keys whose words are current (the call that just ended): a day they said there backs a day in the message. Anything
  // else that was said earlier, or is only background, cannot back a date.
  freshKeys?: string[];
}): Promise<string | null> {
  const feeling = feelingForDraft.getStore();
  const member = memberForDraft.getStore()?.block ?? null;
  const redo = redraftFor.getStore();
  const build = (own: string | null) => `${CO_VOICE}

${CO_TEXT_CHANNEL} You're texting ${opts.firstName}. Co is reaching out first; they didn't just text you.

${opts.maxSentences && opts.maxSentences !== 2 ? PROACTIVE_RULES.replace("Max 2 sentences", `Max ${opts.maxSentences} sentences`) : PROACTIVE_RULES}

CONFIRMED_FACTS (the only facts you may state)
${renderFacts(opts.facts)}
${member ? `\n${member}\n` : ""}${feeling ?`\nHOW THEY'VE BEEN FEELING (let it shape how you say this, never whether you say it: it's not a reason to SKIP. If they've been struggling, be gentler and lower-pressure, and acknowledge it briefly and warmly in your own words before the rest. Never name the feeling)\n${feeling}\n` : ""}

TASK
${opts.task}
${redo ? `\nYOUR LAST DRAFT (not sent)\n"${redo.draft}"\nIt broke: ${redo.failed}. Write it again with that fixed, keeping what it said.\n` : ""}${own ? `\nYOUR LAST DRAFT (not sent)\n"${own}"\nIt broke: ${feedbackFor(unbackedSpecifics(own, opts.facts, { freshKeys: opts.freshKeys }))}\n` : ""}
Return ONLY the message text, or exactly SKIP.`;
  const generate = async (own: string | null): Promise<string | null> => {
    const prompt = build(own);
    const raw = testModel ? await testModel(prompt) : (await generateText({ model: anthropic(opts.model ?? DRAFT_MODEL), experimental_telemetry: { isEnabled: true, functionId: opts.functionId }, prompt })).text;
    const trimmed = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (!trimmed || /^skip\b[.!]?$/i.test(trimmed)) return null;
    return brandSafe(cleanCoMessage(trimmed));
  };
  const first = await generate(null);
  if (!first) return null;
  if (!unbackedSpecifics(first, opts.facts, { freshKeys: opts.freshKeys }).length) return first;
  // A day, event or commitment nothing real backs: once more, told exactly what to cut or turn into a question.
  const second = await generate(first);
  if (!second) return null;
  const left = unbackedSpecifics(second, opts.facts, { freshKeys: opts.freshKeys });
  if (!left.length) return second;
  console.log(`proactive: ${opts.functionId} not sent: it still states ${left.map((l) => `"${l.text}"`).join(", ")} that nothing real backs`);
  return null;
}

export type OutputRules = {
  maxSentences?: number;
  maxChars?: number;
  allowUrl?: boolean;
  allowGreeting?: boolean;
  // At least one of these must appear (case-insensitive), e.g. the event name.
  mustIncludeAny?: string[];
  // A second set that must also appear (e.g. who an event is for, next to its name).
  mustAlsoIncludeAny?: { words: string[]; reason: string; ignoring?: string[] };
  // None of these may appear, e.g. the event name in a tease.
  mustNotInclude?: string[];
  forbidden?: { pattern: RegExp; reason: string }[];
  // The record a find's caption was drafted from (Phase B, B4): every price and count it states must be on it (services/sendCheck.ts).
  backedBy?: string;
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
  // Never a failure nobody checked (Royce, 2026-10-09: "the link wasn't working" was invented). A proactive draft has no check
  // in front of it, so it never says something is broken, down or failed.
  checks.push({ name: "draft_invented_failure", pass: !inventedFailure(text), reason: "says something is broken, failed or unavailable with no check behind it; leave it out" });
  // A sanity limit, not a style rule: well past the guidance before it blocks
  // (2026-09-28: exact caps made every text the same shape).
  if (rules.maxSentences !== undefined) {
    const n = sentenceCount(text);
    const limit = rules.maxSentences + 2;
    checks.push({ name: "draft_sentences", pass: n <= limit, reason: `${n} sentences (max ${limit})` });
  }
  // One question at most in a text Co sends first: stacked questions read
  // like a form (counted by question marks or sentences that open like one).
  {
    const asks = text
      .split(/(?<=[.?!])\s+/)
      .filter((x) => /\?\s*$/.test(x) || /^(how|what|when|where|who|why|did|do|does|are|is|was|were|want|would|could|can|should|any)\b/i.test(x.trim())).length;
    checks.push({ name: "draft_one_question", pass: asks <= 1, reason: `asks ${asks} questions in one text` });
  }
  if (!rules.allowUrl) {
    checks.push({ name: "draft_no_url", pass: !/(https?:\/\/|www\.|lu\.ma\/|\.com\/)/i.test(text), reason: "links go out as their own message" });
  }
  if (rules.mustIncludeAny?.length) {
    const wanted = rules.mustIncludeAny.map((w) => w.toLowerCase()).filter(Boolean);
    checks.push({
      name: "draft_names_the_thing",
      pass: !wanted.length || wanted.some((w) => lower.includes(w)),
      reason: `doesn't mention any of: ${wanted.join(", ")}`,
    });
  }
  if (rules.mustAlsoIncludeAny?.words.length) {
    const wanted = rules.mustAlsoIncludeAny.words.map((w) => w.toLowerCase()).filter(Boolean);
    // The event's own name doesn't count ("HOT GIRL HIKE CLUB: SESSION 6" contains the word without saying who
    // it's for), however the draft punctuates it. Whole words only: "men" is not in "moment".
    const norm = (t: string) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}'\u2019]+/gu, " ").replace(/\u2019/g, "'").replace(/\s+/g, " ").trim()} `;
    let rest = norm(text);
    // Any stretch of the name that carries an audience word, longest first: Co shortens "Hot Girl Hike Club: Session 6"
    // to "Hot Girl Hike" and the shorter form must not count either.
    const wantedSet = new Set(wanted.map((w) => w.replace(/\u2019/g, "'")));
    for (const name of rules.mustAlsoIncludeAny.ignoring ?? []) {
      const nw = norm(name).trim().split(" ").filter(Boolean);
      for (let len = nw.length; len >= 1; len--) {
        for (let i = 0; i + len <= nw.length; i++) {
          const piece = nw.slice(i, i + len);
          if (piece.some((w) => wantedSet.has(w))) rest = rest.split(` ${piece.join(" ")} `).join(" ");
        }
      }
    }
    checks.push({ name: "draft_says_who_it_is_for", pass: wanted.some((w) => rest.includes(` ${w.replace(/\u2019/g, "'")} `)), reason: `${rules.mustAlsoIncludeAny.reason} (one of: ${wanted.join(", ")})` });
  }
  for (const banned of rules.mustNotInclude ?? []) {
    if (!banned) continue;
    checks.push({ name: "draft_withholds", pass: !lower.includes(banned.toLowerCase()), reason: `reveals "${banned}" too early` });
  }
  for (const f of [...ALWAYS_FORBIDDEN, ...(rules.forbidden ?? [])]) {
    checks.push({ name: "draft_forbidden", pass: !f.pattern.test(text), reason: f.reason });
  }
  // A find's prices and counts, on its record (Phase B, B4, 2026-10-10: task texts were checked, find captions weren't).
  if (rules.backedBy !== undefined) {
    const b = captionNumbersBacked(text, rules.backedBy);
    checks.push({ name: "draft_numbers_backed", pass: b.ok, reason: b.problems.join("; ") || "ok" });
  }
  // One voice standard with calls (services/speakable.ts): no "Starting the…", "working on", "once it's worth sending".
  const narration = narratesInternalState(text);
  checks.push({ name: "draft_narrates_state", pass: !narration, reason: narration ?? "narrates Co's own state" });
  return checks;
}

// ---------- registry contract (implemented in proactiveRegistry.ts)

export type Person = { userId: string; firstName: string; phoneNumber: string; city: string | null; timezone: string | null };

// messages: sent in order, links as their own message. text: the part the
// model wrote, which is what checkDraft validates.
// defer: not yet, but still worth sending later (a follow-up about an event
// that hasn't happened); the candidate moves to that time instead of dropping.
export type DraftResult = { messages: string[]; text: string; rules: OutputRules } | { skip: string } | { defer: Date; reason: string };

export type TypeSpec = {
  draft(c: Candidate, person: Person): Promise<DraftResult>;
  onSent?(c: Candidate, person: Person, messages: string[]): Promise<void>;
  onDropped?(c: Candidate, status: "skipped" | "expired", reason?: string): Promise<void>;
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
  // Set when Co itself decided to check in now (services/followUps.ts).
  fromCo?: boolean;
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

export async function enqueueCandidate(input: EnqueueInput, retried = false): Promise<{ queued: boolean }> {
  // Advice follow-ups, time-frame follow-ups, ask check-ins and debriefs: Co
  // decides when (services/followUps.ts). What it sends still comes back here.
  if (!input.fromCo) {
    const F = await import("../services/followUps.js");
    if (F.followUpsByCo() && F.handedToCo(input)) return F.startFollowUp(input);
  }
  const client = await pool.connect();
  let released = false;
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
      const merged = input.merge ? input.merge(existing.rows[0].payload, input.payload) : input.payload;
      // Co's relevance verdict survives a re-enqueue, so it isn't paid for again.
      const { relevantAt, relevanceTriedAt } = (existing.rows[0].payload ?? {}) as { relevantAt?: string; relevanceTriedAt?: string };
      const payload = { ...merged, ...(relevantAt ? { relevantAt } : {}), ...(relevanceTriedAt ? { relevanceTriedAt } : {}) };
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
    // Another enqueue of the same target inserted first (concurrency audit, 2026-10-12: its row didn't exist for this one's FOR
    // UPDATE, so both reached the insert). Once more, so this one merges into that row instead of being dropped.
    if (!inserted.rows[0] && !retried) {
      client.release();
      released = true;
      return enqueueCandidate(input, true);
    }
    // New work for this person: let the pick model look again.
    if (inserted.rows[0]) {
      await pool.query(`UPDATE proactive_user_state SET hold_until = NULL WHERE user_id = $1`, [input.userId]).catch(() => {});
    }
    return { queued: Boolean(inserted.rows[0]) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (!released) client.release();
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

// Their stamp (written the moment a text arrives, before its turn runs), Co's last reply to them, and whether a turn for one of their
// texts hasn't finished (inbound_webhook_handles, bounded so a crashed turn doesn't hold forever).
// Pure: mid-conversation when their text, or Co's own last reply to them, is within MID_CONVERSATION_MINUTES (the intelligence audit's
// check-in went 40 seconds after Co's reply), or a turn for one of their texts is still running.
export function midConversationFrom(o: { now: Date; lastInboundAt: Date | null; lastCoReplyAt: Date | null; turnRunning: boolean }): boolean {
  const recent = (at: Date | null) => !!at && o.now.getTime() - at.getTime() < MID_CONVERSATION_MINUTES * 60_000 && at.getTime() <= o.now.getTime() + 60_000;
  return o.turnRunning || recent(o.lastInboundAt) || recent(o.lastCoReplyAt);
}
// Can't tell: held a few minutes rather than texting into a conversation (fail safe, requeued).
async function midConversationNow(db: Queryable, userId: string, now: Date, lastInboundAt: Date | null): Promise<boolean> {
  if (midConversationFrom({ now, lastInboundAt, lastCoReplyAt: null, turnRunning: false })) return true;
  return loadMidConversation(db, userId, now).catch(() => true);
}
async function loadJoinedAt(db: Queryable, userId: string): Promise<Date | null> {
  const { rows } = await db.query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
  return rows[0]?.created_at ? new Date(rows[0].created_at) : null;
}
async function loadMidConversation(db: Queryable, userId: string, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT
       (SELECT d.last_inbound_at FROM phone_debounce d WHERE d.phone = u.phone_number) AS stamped_at,
       (SELECT MAX(m.created_at) FROM co_memories m WHERE m.user_id = u.id AND m.memory_type = 'text_exchange' AND m.content LIKE 'Co replied:%'
          AND m.created_at > $2::timestamptz - make_interval(mins => $3)) AS co_reply_at,
       EXISTS (SELECT 1 FROM inbound_webhook_handles h WHERE h.finished_at IS NULL AND h.received_at > NOW() - INTERVAL '15 minutes' AND h.payload->>'number' = u.phone_number) AS running
     FROM users u WHERE u.id = $1`,
    [userId, now, MID_CONVERSATION_MINUTES],
  );
  const r = rows[0];
  if (!r) return false;
  return midConversationFrom({ now, lastInboundAt: r.stamped_at ? new Date(r.stamped_at) : null, lastCoReplyAt: r.co_reply_at ? new Date(r.co_reply_at) : null, turnRunning: !!r.running });
}

// Their last message to Co on any channel (a text, or a call where they spoke): a timestamp only, never what they said. Also the 9am
// floor's engagement read (services/dailySweep.ts searchCadence).
export async function lastInboundAt(userId: string): Promise<Date | null> {
  return loadLastInbound(pool, userId);
}
async function loadLastInbound(db: Queryable, userId: string): Promise<Date | null> {
  const { rows } = await db.query(
    `SELECT MAX(created_at) AS at FROM co_memories
     WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User %' OR content LIKE '[Call]%')`,
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
  const timezone = await memberZone(userId);
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

// Co's pick, read even when the "why" was cut off: the id comes first.
export function readPick(text: string): { id: string; why: string } | null {
  const whole = text.match(/\{[\s\S]*\}/);
  if (whole) {
    try {
      const j = JSON.parse(whole[0]);
      if (j?.id !== undefined) return { id: String(j.id), why: String(j.why ?? "") };
    } catch {}
  }
  const id = text.match(/"id"\s*:\s*"?([^",}\s]+)"?/);
  if (!id) return null;
  return { id: id[1], why: text.match(/"why"\s*:\s*"([^"]*)/)?.[1] ?? "" };
}

// Co chooses (Royce, 2026-09-25: "Co value is in it's intelligence"). When
// two or more are eligible, Co reads the person (recent texts, how they've
// been feeling) and picks the one that fits them right now. Everything that
// decides what's eligible (caps, hours, opt-outs, spacing) stays in code, and
// Co can't pick "nothing": feelings shape how Co says it, never whether a
// member hears about something (feedback: never isolate frustrated members).
// Any failure, or a pick that isn't eligible, falls back to code priority.
// Only runs when there's a real choice, so most days cost nothing.
export async function choosePick(
  eligible: Candidate[],
  about: { recentConversation: string; feeling: string; taste?: string | null; statedTaste?: string | null; person?: string | null; zone?: string | null; now?: Date },
): Promise<{ pick: Candidate | null; reason: string; source: "code" | "co" }> {
  if (eligible.length < 2) return proposePick(eligible);
  try {
    const { text } = await Promise.race([
      generateText({
        model: anthropic(DRAFT_MODEL),
        // 200 cut Co's answer off mid-sentence (2026-09-28: half its picks
        // were thrown away and code priority chose instead).
        maxOutputTokens: 1000,
        experimental_telemetry: { isEnabled: true, functionId: "proactive.choosePick" },
        prompt: `${CO_VOICE}

You're about to text this member first. Several things are ready to go; pick the ONE that fits them best right now, the way a friend who knows them would. Staying close to what's going on in their life comes before offers.

How they've been: ${about.feeling || "(nothing notable)"}
What's landed with them before: ${about.taste || "(nothing recorded yet)"}
${about.statedTaste ? `What kind of room they've said they want (their words): ${about.statedTaste}\n` : ""}
${about.person ? `What you know about them:\n${about.person.slice(0, 2500)}\n` : ""}Their recent texts with you (oldest first):
${about.recentConversation.slice(-2500) || "(none)"}

Ready to send (each says when it stops being true; something on its last day today can't wait for tomorrow, something still true tomorrow can):
${eligible.map((c) => `- ${c.id} [${c.type}] ${c.summary} (${endsFact(c, { now: about.now ?? new Date(), zone: about.zone ?? null })})`).join("\n")}

Return ONLY JSON: {"id": "<one id from the list>", "why": "one short line"}`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pick timed out")), 15_000)),
    ]);
    const parsed = readPick(text);
    const pick = eligible.find((c) => c.id === String(parsed?.id ?? ""));
    if (pick) return { pick, reason: `Co's pick of ${eligible.length}: ${String(parsed?.why ?? "").slice(0, 200)}`, source: "co" };
    console.error("proactive: Co's pick named nothing eligible, using priority (non-fatal):", text.slice(0, 300));
  } catch (err: any) {
    console.error("proactive: Co's pick failed, using priority (non-fatal):", err?.message ?? err);
  }
  const fallback = proposePick(eligible);
  return { ...fallback, reason: `${fallback.reason} (Co's pick unavailable)` };
}

// An answer that has waited more than a day is re-read before it goes
// (Royce, 2026-10-02): if what it answers has passed or been settled, it's
// archived silently instead of sent late.
// Waiting is counted from when it was queued. due_at moves (a re-enqueue, a
// draft that defers), so measuring from it let a long-waiting answer skip the
// check (re-review of #55). Something queued days ahead of its morning is
// checked once when it comes due: one extra call, never a missed check. A
// "still relevant" answer is kept on the candidate for a day, so a draft that
// skips or defers doesn't pay for it again.
export const RELEVANCE_RECHECK_HOURS = 24;
// Every find too, goal finds included (Phase B, B6, 2026-10-10): a find for where they're headed waited as long as one for an ask and
// was never re-judged; now both are, against their page as it is now (stillRelevant reads the source first).
export function needsRelevanceCheck(c: Candidate, now: Date): boolean {
  if (!(isAnswering(c) || c.type === "event_offer") || now.getTime() - c.createdAt.getTime() <= RELEVANCE_RECHECK_HOURS * HOUR) return false;
  const checked = Date.parse(String((c.payload as { relevantAt?: string })?.relevantAt ?? ""));
  return !(checked && now.getTime() - checked < RELEVANCE_RECHECK_HOURS * HOUR);
}
// When Co can't say, it sits out this long (relevance_retry) and the next item
// gets its turn; then it's checked again, never sent unchecked.
export const RELEVANCE_RETRY_HOURS = 2;

// Records Co's answer on the candidate: relevant is remembered for a day; no
// answer is stamped so the item sits out without moving its clock.
async function settleRelevance(c: Candidate, r: { relevant: boolean } | null): Promise<void> {
  if (r && !r.relevant) return; // dropped by the caller
  const key = r ? "relevantAt" : "relevanceTriedAt";
  await pool.query(`UPDATE proactive_candidates SET payload = payload || jsonb_build_object($2::text, NOW()::text), updated_at = NOW() WHERE id = $1`, [c.id, key]).catch(() => {});
}

export function readRelevance(text: string): { relevant: boolean; why: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j?.relevant !== "boolean") return null;
    return { relevant: j.relevant, why: String(j.why ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

// Co reads it against the conversation since. null when Co couldn't answer:
// the caller holds it for the next tick, neither sending nor archiving.
// A find reads its source first (Phase B, B6, 2026-10-10: this read only the conversation, never the page): a real check where one
// exists. Its page re-read (services/sendCheck.ts checkBeforeSend) settles sold out, gone and past in code, with its exit fact; what
// the page says now goes to the model with the conversation; a page that can't be read now holds it (null), never sends it unread.
export async function stillRelevant(c: Candidate, about: { recentConversation: string; now: Date; timezone: string | null; checkDeps?: import("../services/sendCheck.js").SendCheckDeps }): Promise<{ relevant: boolean; why: string } | null> {
  const day = (d: Date) => localStamp(d, about.timezone);
  let source: string | null = null;
  if (c.type === "event_offer") {
    const S = await import("../services/sendCheck.js");
    const s = await S.checkBeforeSend(c, about.timezone, about.checkDeps).catch(() => null);
    if (!s || "defer" in s) return null;
    if ("skip" in s) return { relevant: false, why: s.skip };
    source = S.sourceLine(s.match, about.now);
  }
  try {
    const { text } = await Promise.race([
      generateText({
        model: anthropic(DRAFT_MODEL),
        maxOutputTokens: 300,
        experimental_telemetry: { isEnabled: true, functionId: "proactive.stillRelevant" },
        prompt: `A text Co was going to send this member has been waiting since ${day(c.createdAt)}. It's now ${day(about.now)}.

What it was going to do: [${c.type}] ${c.summary}
${source ? `\n${source}\n` : ""}
Their recent texts with Co (oldest first):
${about.recentConversation.slice(-2500) || "(none)"}

Is it still relevant? It's stale only if one of these is true:
- what it's about is over and asking now would read as late (an event or window that ended days ago, a "morning-after" question days after)
- the conversation since already covered or settled it
- they said they no longer want it
Anything else is relevant. Whether now is a good moment, or that they're talking about something else, is decided elsewhere and is never a reason. A date that hasn't come yet is not stale.

Return ONLY JSON: {"relevant": true|false, "why": "one short line"}`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("relevance check timed out")), 15_000)),
    ]);
    return readRelevance(text);
  } catch (err: any) {
    console.error("proactive: relevance check failed (non-fatal, held):", err?.message ?? err);
    return null;
  }
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
  opts: { ignorePacing?: boolean; suppressedKinds?: ProactiveKind[] } = {},
  extras: { candidate: Candidate; messages: string[] }[] = [],
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
    // Read again at send time, inside the lock: a draft can take a minute, and they may have texted meanwhile.
    const midConversation = await midConversationNow(client, person.userId, now, lastInboundAt);
    const joinedAt = await loadJoinedAt(client, person.userId).catch(() => null);
    const answering = isAnswering(c);
    const morning = morningFind(c, now, person.timezone);
    const checks = [
      // A safety follow-up is never held for the conversation (isSafetyFollowUp).
      ...userLevelChecks({ now, timezone: person.timezone, optedOut: optedOutNow, sends, lastInboundAt, midConversation: midConversation && !isSafetyFollowUp(c) }, { lane: laneOf(c.type), ignorePacing: opts.ignorePacing, legacyPace: !pacedByEngagement(c) }).filter(
        (k) => !(answering && QUOTA_CHECKS.has(k.name)) && !(morning && MORNING_SKIPS.has(k.name)) && !(c.type === "companion" && k.name === "weekly_cap"),
      ),
      ...candidateChecks(c, { now, sends, lastInboundAt, joinedAt, undeliveredYes: c.type === "network_tease" ? await import("../services/networkIntroNudge.js").then((m) => m.lastTeaseUndelivered(person.userId)).catch(() => false) : false, suppressedKinds: await loadKindRestraint(client, person.userId, now).then((r) => suppressedKinds(r.verdicts)).catch(() => opts.suppressedKinds ?? []) }, { answering }),
    ];
    // The day's discovery cap, read again inside the lock, so two sends at once can't both pass it (review of the tier PR).
    const discovery = [c, ...extras.map((e) => e.candidate)].filter(isDiscoveryFind).length;
    if (discovery) {
      const sentToday = await findsSentToday(person.userId, person.timezone, now, client).catch(() => DAILY_FIND_CAP);
      checks.push({ name: "daily_find_cap", pass: sentToday + discovery <= DAILY_FIND_CAP, reason: `${sentToday} discovery find(s) went today; this send has ${discovery}; the day's cap is ${DAILY_FIND_CAP}` });
    }
    const g = gate(checks);
    if (!g.ok) {
      await client.query("ROLLBACK");
      return { sent: false, failed: g.failed };
    }
    // The kind goes on the ledger (services/kindRestraint.ts): what restraint reads to learn which kinds they let pass.
    const ins = await client.query(
      `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, candidate_id, message, exempt, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`,
      [person.userId, c.type, c.targetKey, c.topicKey, c.id, messages.join("\n\n"), sendIsExempt(c, extras.map((e) => e.candidate), opts.ignorePacing === true) || morning, kindOf(c.type, c.payload)],
    );
    if (!ins.rows[0]) {
      await client.query("ROLLBACK");
      return { sent: false, failed: [{ name: "not_sent_before", pass: false, reason: "idempotency key taken" }] };
    }
    // A morning find goes out once (review, 2026-10-13): once their morning text is on the ledger, what's left of that morning's picks
    // falls back to the normal pacing, so no second unpaced text follows half an hour later. Same transaction: rolled back with it.
    if (morning) {
      await client.query(
        `UPDATE proactive_candidates SET payload = payload - 'morningDay', updated_at = NOW()
          WHERE user_id = $1 AND status = 'pending' AND payload ? 'morningDay' AND id <> ALL($2::bigint[])`,
        [person.userId, [c.id, ...extras.map((e) => e.candidate.id)].map(Number)],
      );
    }
    // Offers that ride along count as part of this one send: ledgered as
    // exempt so the day's cap sees a single text, and marked sent together.
    // Their kind is read from the candidate behind each row (services/kindRestraint.ts loadKindHistory), and rows sent together
    // count as one text there.
    for (const e of extras) {
      await client.query(
        `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, candidate_id, message, exempt)
         VALUES ($1, $2, $3, $4, $5, $6, true) ON CONFLICT (user_id, target_key) DO NOTHING`,
        [person.userId, e.candidate.type, e.candidate.targetKey, e.candidate.topicKey, e.candidate.id, e.messages.join("\n\n")],
      );
      await client.query(`UPDATE proactive_candidates SET status = 'sent', decided_at = NOW(), updated_at = NOW() WHERE id = $1`, [e.candidate.id]);
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
  // Thread the first message under this message of theirs (an inline reply);
  // a refused one goes out plain (services/inlineReply.ts).
  replyTo?: string | null;
  // The moment the hours check reads (a turn run on a pinned clock passes its own); the real time otherwise.
  now?: Date;
  // A text Co starts itself (a task update, a window warning), not one the member is owed: it waits on the same spacing, pace,
  // unanswered pause and kind backoff as every other text Co sends first (issue #126; Royce, 2026-10-09: an 11:30 task update
  // went out 15 minutes after another text). `kind` is the restraint kind it counts as, when it has one.
  coInitiated?: { kind: ProactiveKind | null };
}): Promise<{ sent: boolean; reason?: string; delivered?: string[]; retryAt?: Date }> {
  if (proactivePaused()) return { sent: false, reason: "proactive outreach is paused" };
  // Monitoring visibility (code review, 2026-09-17): send failures and
  // hours/opt-out blocks at send time had nothing writing a decision at
  // all, so harness/monitor.ts had no signal that could ever see them.
  const record = (outcome: "act" | "skip", action: string, reason?: string) =>
    recordDecision({ layer: 7, decision: "proactive.exemptSend", userId: opts.userId, outcome, action, reason, proposal: { type: opts.type, targetKey: opts.targetKey } }).catch(() => {});

  if (opts.respectHours && !localHourOk(opts.now ?? new Date(), opts.timezone ?? null)) {
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
    if (opts.coInitiated) {
      const now = opts.now ?? new Date();
      const { failed, sends } = await coInitiatedHold(client, { userId: opts.userId, timezone: opts.timezone ?? null, now, kind: opts.coInitiated.kind });
      if (failed.length) {
        await client.query("ROLLBACK");
        const reason = failed.map((c) => c.reason ?? c.name).join("; ");
        await record("skip", "held_co_initiated", reason);
        return { sent: false, reason: `held: ${reason}`, retryAt: coInitiatedRetryAt({ now, sends }, failed.map((c) => c.name)) };
      }
    }
    // The kind goes on the ledger for a Co-initiated text too, so restraint learns from it (services/kindRestraint.ts).
    const ins = await client.query(
      `INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, kind)
       VALUES ($1, $2, $3, $3, $4, true, $5)
       ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`,
      [opts.userId, opts.type, opts.targetKey, opts.messages.join("\n\n"), opts.coInitiated?.kind ?? null],
    );
    if (!ins.rows[0]) {
      await client.query("ROLLBACK");
      return { sent: false, reason: "already sent" }; // idempotent no-op, not worth a decision row
    }
    const first = { number: opts.phoneNumber, content: opts.messages[0], from_number: process.env.SENDBLUE_PHONE_NUMBER! };
    if (opts.replyTo) {
      await sendblue.messages.send({ ...first, reply_to: { message_handle: opts.replyTo } } as typeof first).catch(() => sendblue.messages.send(first));
    } else {
      await sendblue.messages.send(first);
    }
    delivered.push(opts.messages[0]);
    await client.query("COMMIT");
    await recordProactiveText(opts.userId, opts.type, opts.messages[0], ins.rows[0].id);
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
// maybeAskCandidateDirectly and networkIntroNudge.ts's
// askCandidateDirectly sent a raw sendblue message with no opt-out or hours
// check at all, since the trigger was the OTHER person's reply, not this
// recipient's), and for relays, reminders and stale heads-ups. Sends now if
// it's inside their local hours; otherwise queues it for their next local 8am
// instead of texting at night. Opt-out is still enforced by sendExempt itself,
// at send time, whichever branch runs.
//
// Durable (2026-10-07): the held send is a deferred_sends row the minute cron
// sends (services/deferredSends.ts), not an in-process timer a restart or
// deploy lost. `after` is what the send means for the record (a relay's
// status, a reminder's sent_at, an intro ask's pending offer); it runs only
// once the text actually went, now or in the morning, so nothing says "sent"
// while it's only queued.
export async function sendExemptWhenAllowed(opts: {
  userId: string;
  phoneNumber: string;
  type: ExemptType;
  targetKey: string;
  messages: string[];
  timezone: string | null;
  after?: import("../services/deferredSends.js").AfterSend;
  now?: Date;
}): Promise<{ sent: boolean; queued: boolean; reason?: string; dueAt?: Date }> {
  const D = await import("../services/deferredSends.js");
  const now = opts.now ?? new Date();
  const { after, ...send } = opts;
  if (localHourOk(now, opts.timezone)) {
    const result = await sendExempt({ ...send, now }).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) }));
    const o = D.outcomeOf(result, false);
    // Inline "already sent" is an earlier send of the same key, not this one: the caller's record stays as it was.
    if (result.reason !== "already sent") await D.runAfter(after, o === "sent" ? "sent" : o === "skipped" ? "skipped" : "failed");
    return { sent: result.sent, queued: false, reason: result.reason };
  }
  const at = nextLocalHour(now, opts.timezone, RULES.startHour);
  const q = await D.enqueueDeferredSend({ ...send, dueAt: at, after }).catch((err: any) => ({ queued: false, reason: `queue failed: ${String(err?.message ?? err)}` }) as { queued: boolean; reason?: string });
  if (!q.queued) {
    console.error(`sendExemptWhenAllowed(${opts.type}): not queued for ${opts.userId}: ${q.reason}`);
    if (q.reason !== "already sent") await D.runAfter(after, "failed");
    return { sent: false, queued: false, reason: q.reason };
  }
  return { sent: false, queued: true, reason: `outside local hours, queued for ${at.toISOString()}`, dueAt: at };
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

// Every in-room text Co starts (the match nudge, the additive offer, the end-of-night texts) asks here right before it
// sends, so the pause (services/proactivePause.ts) holds them like every other send path: nothing goes out, the claim is
// released, and a later pass sends it once the pause lifts.
export async function inRoomSendAllowed(userId: string, eventId: string): Promise<boolean> {
  if (proactivePaused()) return false;
  // The matching kill switch, global or this event (services/roomMatching.ts), read fresh.
  if (await (await import("../services/roomMatching.js")).matchingPause(eventId)) return false;
  // Counted per event, exactly: a prefix match let three texts at evt-1234 use up the limit at evt-12.
  const { rows } = await pool.query(`SELECT target_key FROM proactive_sends WHERE user_id = $1 AND type = 'in_room' AND target_key LIKE 'in_room:%'`, [userId]);
  return rows.filter((r: any) => inRoomKeyEvent(String(r.target_key)) === eventId).length < MAX_IN_ROOM_SENDS_PER_EVENT;
}

// The event an in-room send was for, from its key: in_room:<kind>:<eventId>, and the additive offer adds :<timestamp>.
export function inRoomKeyEvent(key: string): string | null {
  const m = key.match(/^in_room:([a-z_]+):(.+)$/);
  if (!m) return null;
  return m[1] === "additive" ? m[2].replace(/:\d+$/, "") : m[2];
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
  await recordProactiveText(userId, "in_room", message, targetKey);
}

// ---------- dispatch

export async function dropCandidate(registry: ProactiveRegistry, c: Candidate, status: "skipped" | "expired", reason: string): Promise<void> {
  await pool.query(
    `UPDATE proactive_candidates SET status = $2, skip_reason = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
    [c.id, status, reason],
  );
  await registry[c.type].onDropped?.(c, status, reason).catch((err: any) =>
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

// The member-level state every send decision reads, from the member record's one restraint read (services/memberKnowledge.ts; Phase A6:
// dispatch read the hold, emotion, safety, kind restraint and last inbound itself, then the record read them all again for drafting).
// Dispatch and the sweep gate (sweepHold, Phase A3) both build it here, so a sweep is never run for a member dispatch would hold.
export type MemberSendState = { state: Omit<PickState, "candidates">; holdUntil: Date | null; spaceUntil: Date | null; raw: import("../services/memberKnowledge.js").RawRestraint };
export async function memberSendState(userId: string, person: { timezone: string | null; optedOut: boolean }, now: Date): Promise<MemberSendState> {
  const MK = await import("../services/memberKnowledge.js");
  const [raw, sends, undeliveredYes, joinedAt] = await Promise.all([
    MK.realKnowledgeDeps.restraint(userId, now),
    loadSends(pool, userId),
    import("../services/networkIntroNudge.js").then((m) => m.lastTeaseUndelivered(userId)).catch(() => false),
    loadJoinedAt(pool, userId).catch(() => null),
  ]);
  const midConversation = await midConversationNow(pool, userId, now, raw.lastInboundAt);
  return {
    state: {
      now,
      timezone: person.timezone,
      optedOut: person.optedOut,
      sends,
      lastInboundAt: raw.lastInboundAt,
      needsCare: !!raw.emotional?.needsCare,
      safetyHold: raw.safetyHold,
      undeliveredYes,
      // Kinds they keep letting pass (services/kindRestraint.ts). A read that fails holds what's stored, never more than that.
      suppressedKinds: raw.suppressed,
      away: raw.away ?? null,
      midConversation,
      joinedAt,
    },
    holdUntil: raw.holdUntil,
    spaceUntil: raw.spaceUntil,
    raw,
  };
}

// Pure: whether a hold or the space after a handed-off task is on (dispatch sends nothing then; new candidates don't clear space).
export function heldNow(s: Pick<MemberSendState, "holdUntil" | "spaceUntil">, now: Date): "hold" | "space" | null {
  if (s.holdUntil && s.holdUntil.getTime() > now.getTime()) return "hold";
  if (s.spaceUntil && s.spaceUntil.getTime() > now.getTime()) return "space";
  return null;
}

// The sweep gate (Phase A3, 2026-10-10 audit: restraint, pause and dormancy were checked only at dispatch, so a member whose finds
// couldn't go out still cost a full sweep a day, and the finds often expired before the backoff let one through). A sweep runs only
// when dispatch would let what it finds go out, by dispatch's own checks on a find of that kind:
//   - an ask's find answers them: only what holds every send for days stops it (opted out, a safety hold, finds paused for everyone);
//   - a goal's find is discovery: the pace that holds discovery stops it too (kind restraint, the weekly cap, the engagement pace that
//     slows a quiet or dormant member, the unanswered pause).
// Never a hold or the space after a task (review of #134): a hold is the pick's "nothing to send now", which a new find clears, so
// holding the sweep on it would keep the new find from ever coming; the space is hours. Hours, the daily cap and spacing clear within
// the day too. Returns why it's held; empty: it runs.
export type SweepKind = "ask" | "goal" | "floor_goal";
export const SWEEP_BLOCKERS: Record<SweepKind, readonly string[]> = {
  ask: ["not_opted_out", "safety_hold"],
  // away_hold (services/away.ts): a goal's discovery sweep finds things where they live; while they're away it would only pile up.
  goal: ["not_opted_out", "safety_hold", "kind_restraint", "weekly_cap", "engagement_pace", "unanswered_pause", "away_hold"],
  // The 9am floor's goal search (services/dailySweep.ts): the timers a send sets (the weekly cap, the engagement pace, the unanswered
  // pause) gate only the send, never the search (Royce, 2026-10-14: "no timer may gate whether a member's goals get searched ... A send
  // can never reduce what Co knows"). What it finds goes to the pool and waits for the send step. What isn't a timer still holds it.
  floor_goal: ["not_opted_out", "safety_hold", "kind_restraint", "away_hold"],
};
// The send-set timers a search never waits on (the floor's goal search; pinned in evals/goals/planCurrent.ts).
export const SEND_TIMERS: readonly string[] = ["weekly_cap", "engagement_pace", "unanswered_pause", "daily_cap", "spacing"];
export function sweepBlockedBy(s: Pick<MemberSendState, "state" | "holdUntil" | "spaceUntil">, kind: SweepKind, paused: string[] = pausedTypes()): string[] {
  const find: Candidate = {
    id: "sweep",
    userId: "",
    type: "event_offer",
    targetKey: "event_offer:sweep",
    topicKey: "sweep",
    summary: "",
    priority: 50,
    dueAt: s.state.now,
    expiresAt: null,
    payload: kind === "ask" ? { askId: "sweep-ask", fromProfile: false } : { askId: PROFILE_ASK_ID_FOR_GATE, fromProfile: true }, // goal and floor_goal alike
    attempts: 0,
    createdAt: s.state.now,
  };
  // A conversation going on never holds a sweep: mid_conversation isn't one of SWEEP_BLOCKERS (what it finds waits at send time).
  const ev = evaluateCandidates({ ...s.state, candidates: [find] });
  const failed = [...ev.userChecks, ...(ev.perCandidate[0]?.checks ?? [])].filter((c) => !c.pass && SWEEP_BLOCKERS[kind].includes(c.name)).map((c) => c.name);
  return [...(paused.includes("event_offer") ? ["paused"] : []), ...new Set(failed)];
}
const PROFILE_ASK_ID_FOR_GATE = "profile";
// An ask's sweep stops only on what holds every send for days (SWEEP_BLOCKERS.ask): finds paused for everyone, a safety hold, opted out.
// Those are read alone (the same readers the full state uses), so a member held for days with an ask due costs one query an hour, not
// the full restraint read (review of #134). A goal's sweep needs the pace, so it reads the full state.
export async function sweepHold(userId: string, kind: SweepKind, now = new Date()): Promise<string[]> {
  if (kind === "ask") {
    if (pausedTypes().includes("event_offer")) return ["paused"];
    const { rows } = await pool.query(`SELECT COALESCE(sms_opted_out, false) AS out, phone_number FROM users WHERE id = $1`, [userId]);
    if (!rows[0]?.phone_number) return ["no_phone"];
    if (rows[0].out) return ["not_opted_out"];
    const { safetyHoldActive } = await import("../services/safety.js");
    return (await safetyHoldActive(userId)) ? ["safety_hold"] : [];
  }
  const person = await loadPerson(userId);
  if (!person) return ["no_phone"];
  return sweepBlockedBy(await memberSendState(userId, person, now), kind);
}

// dryRun drafts and composes what would go out, prints it, and stops before the ledger and the send.
export async function dispatchForUser(registry: ProactiveRegistry, userId: string, opts: { ignorePacing?: boolean; dryRun?: boolean } = {}): Promise<void> {
  // A dry run's drafts and relevance reads re-read finds but write nothing (Phase B, services/sendCheck.ts sendCheckDryRun).
  if (opts.dryRun && !sendCheckDryRun.getStore()) return sendCheckDryRun.run(true, () => dispatchForUser(registry, userId, opts));
  const person = await loadPerson(userId);
  // No phone on file: nothing can go. Said, not silent (Royce, 2026-10-13: "No silent skips anywhere in the chain").
  if (!person) {
    if (!opts.dryRun) await recordSkipOnce(userId, "no_phone", { layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", reason: "no phone number on file, so nothing can be sent" });
    return;
  }

  const now = new Date();
  const member = await memberSendState(userId, person, now);
  // A hold, or the spacing after work was handed to a task (harness/payloadFirst.ts): nothing goes. Unlike hold_until, new candidates
  // don't clear the space.
  // Said, not silent (Royce, 2026-10-13): why nothing goes, once per hold.
  const heldBy = heldNow(member, now);
  if (heldBy && !opts.dryRun) {
    const until = heldBy === "hold" ? member.holdUntil : member.spaceUntil;
    await recordSkipOnce(userId, `${heldBy}:${until?.toISOString() ?? ""}`, { layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: heldBy, reason: heldBy === "hold" ? `held until ${until?.toISOString()} (Co's pick had nothing to send; a new find clears it)` : `space until ${until?.toISOString()} after work was handed to a task` });
  }
  if (heldNow(member, now)) return;

  const { rows: candRows } = await pool.query(
    `SELECT * FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND NOT (type = ANY($2::text[]))`,
    [userId, pausedTypes()],
  );
  // A queued find whose ask has closed since it was queued is dead (Royce, 2026-10-12): it leaves the queue here, before the pick
  // sees it, not only when it's drafted. A reminder is exempt (services/askLifecycle.ts servesClosedAsk).
  const AL = await import("../services/askLifecycle.js");
  const closedAsks = await AL.closedAskRefs(userId).catch(() => new Set<string>());
  // A kind the registry no longer has (a removed feature's queued row) is left where it is, never picked or drafted.
  const all = candRows.map(rowToCandidate).filter((c) => c.type in registry);
  const dead = all.filter((c) => c.type === "event_offer" && AL.servesClosedAsk(c.payload as { askId?: string; reminder?: boolean }, closedAsks));
  if (!opts.dryRun) for (const c of dead) await dropCandidate(registry, c, "skipped", "their ask has since closed");
  const state: PickState = { ...member.state, candidates: all.filter((c) => !dead.includes(c)) };
  // The learned preference is written when it flips, from the same read.
  if (member.raw.kinds && !opts.dryRun) await syncKindPreferences(userId, member.raw.kinds.verdicts, member.raw.kinds.stored).catch(() => 0);
  const ev = evaluateCandidates(state, opts);
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
    // Each held candidate's own failed checks are in the key and the reason (Royce, 2026-10-13: "No silent skips anywhere in the chain,
    // including the conversation hold"): a find held because they're mid-conversation used to read as the day's earlier "no_eligible"
    // and wasn't logged. Only the same skip for the same reasons is logged once.
    const held = ev.perCandidate.filter((p) => !p.ok).map((p) => ({ id: p.candidate.id, failed: p.checks.filter((c) => !c.pass) }));
    const heldKey = held.map((h) => `${h.id}=${h.failed.map((f) => f.name).join("+")}`).join(",");
    const reason = failed.length ? describeFailed(failed) : held.length ? `no eligible candidate: ${held.map((h) => `${h.id} held (${describeFailed(h.failed)})`).join("; ")}` : "no eligible candidate";
    if (!opts.dryRun) await recordSkipOnce(userId, failed.map((f) => f.name).join(",") || (heldKey ? `no_eligible:${heldKey}` : "no_eligible"), {
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

  // What Co knows about them, read once for this dispatch (services/memberKnowledge.ts), with another member's details already
  // stripped inside it. The gates above keep their own reads, exactly as they were. A read that fails (a failed name lookup fails
  // closed) leaves the transcript empty and the drafts as they were, never unstripped.
  const MK = await import("../services/memberKnowledge.js");
  // Restraint is the read the gates above made (one read, Phase A6).
  const known = await MK.memberKnowledge(userId, { now: state.now, include: DISPATCH_KNOWLEDGE, ...DISPATCH_EXCHANGES }, { restraint: async () => member.raw }).catch((err: any) => {
    console.error("proactive: member knowledge read failed (non-fatal, drafting without it):", err?.message ?? err);
    return null;
  });
  const rules = known ? MK.memberRules(known) : null;
  // As stored, for the code that parses the thread (repeat question, payload first); stamped in their zone for the model reads.
  const recent = known ? exchangeTranscript(known) : "";
  const recentStamped = known ? exchangeTranscript(known, { stamped: true }) : "";
  // How what Co sent landed, and, apart from it, the kind of room they've said they want (services/roomTaste.ts).
  const taste = known?.preferences.filter((p) => p.source !== "stated").map((p) => p.text).join(" ") || null;
  const statedTaste = known?.preferences.filter((p) => p.source === "stated").map((p) => p.text).join(" ") || null;
  // How they've been, from the one emotion read the gates used (null when it failed: no feeling line rather than a second read).
  const feelingText = member.raw.emotional ? renderEmotionalContext(member.raw.emotional) : "";
  const drafting = <T,>(type: ProactiveType, fn: () => Promise<T>): Promise<T> => (OWN_MEMBER_CONTEXT.has(type) ? draftWithKnowledge(null, null, () => feelingForDraft.run(feelingText, fn)) : draftWithKnowledge(known, rules, () => feelingForDraft.run(feelingText, fn)));
  // The brain decides what goes (brain/index.ts), from the reads here, one stage at a time; this function acts only on its decision,
  // and a text goes out only when the last decision delivers this candidate (sends). The gates above already vetoed what isn't
  // eligible; the guards below (last day first, the draft's checks, the send-time ledger) keep their veto after it.
  // A find on its last chance goes before what can wait (expiringFind); otherwise Co picks.
  const urgent = expiringFind(ev.eligible, { now: state.now, zone: person.timezone, sends: state.sends });
  const chosen = urgent ? null : await choosePick(ev.eligible, { recentConversation: recentStamped, feeling: feelingText, taste, statedTaste, person: known?.person?.text ?? null, zone: person.timezone, now: state.now });
  let decision: DraftDecision = judgeDailyPick({
    urgent: urgent ? { id: urgent.pick.id, why: `expires before the next send slot (ends ${localStamp(urgent.endsAt, person.timezone)}, next slot ${localStamp(urgent.nextSlot, person.timezone)}): it goes ahead of what can wait` } : null,
    chosen: chosen ? { id: chosen.pick?.id ?? null, why: chosen.reason, source: chosen.source } : { id: null, why: "", source: "code" },
    noneHoldHours: RULES.pickNoneHoldHours,
  });
  // Co decides; code guards the fact: a picked find on its last day goes before what is still true tomorrow (lastDayFirst).
  const lastDay = urgent ? null : lastDayFirst(chosen?.pick ?? null, ev.eligible, { now: state.now, zone: person.timezone });
  decision = lastDayVeto(decision, lastDay ? { id: lastDay.pick.id, why: `its last day is today (ends ${localStamp(lastDay.endsAt, person.timezone)}), and what else was ready is still true tomorrow: it goes first` } : null);
  const picked = { pick: ev.eligible.find((x) => x.id === decision.pick) ?? null, reason: decision.why, source: decision.source };
  const done = (type: string | null) => {
    if (opts.dryRun) console.log(`[dispatch dryRun] brain: ${decision.kind}${type ? `:${type}` : ""} pick=${decision.pick} (${decision.why.slice(0, 160)})`);
    else logDraftDecision(userId, decision, type);
  };
  if (decision.kind === "wait" || !picked.pick) {
    if (!opts.dryRun) await pool.query(
      `INSERT INTO proactive_user_state (user_id, hold_until) VALUES ($1, NOW() + ($2 || ' hours')::interval)
       ON CONFLICT (user_id) DO UPDATE SET hold_until = EXCLUDED.hold_until`,
      [userId, decision.holdHours ?? RULES.pickNoneHoldHours],
    );
    if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", proposal, checks: ev.userChecks, reason: decision.why });
    done(null);
    return;
  }
  const c = leadPick(picked.pick, ev.eligible);
  // The bundle leads with the most time-bound of the day's picks (leadPick, code): the decision follows it.
  if (c.id !== decision.pick) decision = { ...decision, pick: c.id };
  const pickChecks = ev.perCandidate.find((p) => p.candidate.id === c.id)?.checks ?? [];

  if (needsRelevanceCheck(c, state.now)) {
    const r = await stillRelevant(c, { recentConversation: recentStamped, now: state.now, timezone: person.timezone });
    if (!opts.dryRun) await settleRelevance(c, r);
    decision = afterRelevance(decision, r, RELEVANCE_RETRY_HOURS);
    if (decision.kind === "wait" && !decision.drop) {
      if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `recheck:${c.type}`, proposal: { ...proposal, picked: c.id }, checks: [...ev.userChecks, ...pickChecks], reason: decision.why });
      done(c.type);
      return;
    }
    if (decision.drop) {
      if (!opts.dryRun) await dropCandidate(registry, c, "skipped", decision.drop);
      if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `archive:${c.type}`, proposal: { ...proposal, picked: c.id }, checks: [...ev.userChecks, ...pickChecks], reason: decision.why });
      done(c.type);
      return;
    }
  }

  // A find bundle is composed as one thought (harness/bundleComposer.ts, Phase C): the lead, the picks or tiers waiting with it, the
  // pick's why for each and its view of the set, the record and the thread, in one model call; its own checks inside. A reminder
  // rides alone and keeps its own draft.
  const bundled = c.type === "event_offer" && !(c.payload as { reminder?: boolean }).reminder;
  let composed: import("./bundleComposer.js").Composed | null = null;
  if (bundled) {
    const B = await import("./bundleComposer.js");
    const { prepareOffer } = await import("./proactiveRegistry.js");
    // The day's discovery cap (capBundle): a discovery lead at the cap waits for tomorrow (it isn't dropped); an answer always goes;
    // discovery siblings are trimmed to what's left.
    const left = findsLeftToday(await findsSentToday(userId, person.timezone, state.now).catch(() => DAILY_FIND_CAP));
    const capped = capBundle(c, pickSiblingOffers(c, ev.eligible), left);
    if (capped.deferLead) {
      if (!opts.dryRun) {
        const tomorrow = DateTime.fromJSDate(state.now).setZone(hoursZone(person.timezone)).plus({ days: 1 }).startOf("day").toJSDate();
        await pool.query(`UPDATE proactive_candidates SET due_at = GREATEST(due_at, $2), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [c.id, tomorrow]);
        await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `daily_find_cap:${c.type}`, proposal: { ...proposal, picked: c.id, deferTo: tomorrow.toISOString() }, checks: [...ev.userChecks, ...pickChecks], reason: `the day's ${DAILY_FIND_CAP} finds have gone out: it waits for tomorrow` });
      }
      done(c.type);
      return;
    }
    const sibs: Candidate[] = [];
    for (const sib of capped.sibs) {
      if (needsRelevanceCheck(sib, state.now)) {
        const r = await stillRelevant(sib, { recentConversation: recentStamped, now: state.now, timezone: person.timezone }).catch(() => null);
        if (!opts.dryRun) await settleRelevance(sib, r);
        if (!r) continue;
        if (!r.relevant) {
          if (!opts.dryRun) await dropCandidate(registry, sib, "skipped", `stale: ${r.why}`);
          continue;
        }
      }
      sibs.push(sib);
    }
    // Each find made ready before anything is written, so the composer writes for the set that can go (nothing dropped after).
    const items: import("./bundleComposer.js").BundleItem[] = [];
    for (const x of [c, ...sibs]) {
      const prep: import("./proactiveRegistry.js").PreparedOffer = await prepareOffer(x, person).catch((err: any) => ({ skip: `couldn't be prepared: ${err?.message ?? err}` }));
      // Its page re-read wants another look later (Phase B): the lead waits (never past its own expiry); a sibling stays pending.
      if ("defer" in prep) {
        if (x.id === c.id) {
          if (!opts.dryRun) {
            await pool.query(
              `UPDATE proactive_candidates SET due_at = $2, expires_at = CASE WHEN type = 'event_offer' AND expires_at IS NOT NULL THEN LEAST(expires_at, $3) ELSE $3 END, updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
              [c.id, prep.defer, new Date(prep.defer.getTime() + 3 * 24 * 3_600_000)],
            );
            await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `defer:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source, deferTo: prep.defer.toISOString() }, checks: [...ev.userChecks, ...pickChecks], reason: `deferred: ${prep.reason}` });
          }
          done(c.type);
          return;
        }
        continue;
      }
      if ("skip" in prep) {
        if (x.id === c.id) {
          if (!opts.dryRun) await dropCandidate(registry, c, "skipped", prep.skip);
          if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source }, checks: [...ev.userChecks, ...pickChecks], reason: `draft skipped: ${prep.skip}` });
          done(c.type);
          return;
        }
        // A sibling its page re-read exited (its fact written) or held is archived, never left waiting (Phase B).
        if ((prep.exited || prep.held) && !opts.dryRun) await dropCandidate(registry, x, "skipped", prep.skip);
        if (!opts.dryRun) recordDecision({ layer: 7, decision: "proactive.sibling_dropped", userId, outcome: "skip", action: prep.exited ? "exited" : prep.held ? "held" : "not_ready", reason: prep.skip, proposal: { candidate: x.id } }).catch(() => {});
        continue;
      }
      const pk = (x.payload as { pick?: { whyMember?: string; whyNow?: string; tierPick?: boolean } }).pick;
      // No why-member (a tier pick the picker didn't send itself): no pick line, the find's own facts speak for it.
      items.push({ candidate: x, item: prep.item, pick: pk?.whyMember ? { whyMember: pk.whyMember, whyNow: pk.whyNow ?? "" } : null, again: Boolean((x.payload as { again?: boolean }).again), ...(pk?.tierPick && morningFind(x, state.now, person.timezone) ? { tierPick: true } : {}) });
    }
    // The pick's set line only for a bundle of exactly the finds it chose together (review of #135: a set line could describe finds
    // that didn't make it into the message).
    const set = B.setFor(items);
    const live = !!state.lastInboundAt && state.now.getTime() - state.lastInboundAt.getTime() < B.LIVE_MINUTES * 60_000;
    const mayWait = B.mayWait(items.map((b) => ({ waits: Number((b.candidate.payload as { waits?: number }).waits ?? 0), expiresAt: b.candidate.expiresAt })), state.now);
    const res = await B.composeBundle({
      firstName: person.firstName,
      items,
      set,
      // Only the code's own reason (the expiring-find rule): choosePick's free text sees every candidate's summary, which can name
      // another member, so it never reaches a member-facing prompt (review of #135).
      leadWhy: picked.source === "code" ? picked.reason : null,
      memberBlock: known && rules ? memberDraftBlock(known, rules) : null,
      feeling: feelingText || null,
      thread: recentStamped,
      recent,
      threadLive: live,
      mayWait,
    }).catch((err: any): import("./bundleComposer.js").ComposeResult => ({ fail: `the composer failed: ${err?.message ?? err}`, calls: 0, notes: [] }));
    // A live conversation about something else: the whole bundle waits an hour rather than landing on top of it (C5), so the next
    // tick doesn't lead with a sibling and compose again; each wait is counted (B.mayWait caps them and never waits past expiry).
    if ("wait" in res) {
      decision = afterComposeWait(decision, res.wait, new Date(state.now.getTime() + 3_600_000));
      done(c.type);
      const at = decision.until!;
      if (!opts.dryRun) await pool.query(`UPDATE proactive_candidates SET due_at = $2, payload = jsonb_set(payload, '{waits}', to_jsonb(COALESCE((payload->>'waits')::int, 0) + 1)), updated_at = NOW() WHERE id = ANY($1::bigint[]) AND status = 'pending'`, [items.map((b) => b.candidate.id), at]);
      if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `defer:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source, deferTo: at.toISOString() }, checks: [...ev.userChecks, ...pickChecks], reason: decision.why });
      return;
    }
    if ("fail" in res) {
      if (!opts.dryRun) {
        for (const a of failedBundleActions(res, c.attempts)) {
          if (a === "drop_skipped") await dropCandidate(registry, c, "skipped", `draft skipped: ${res.fail}`);
          // A morning tier pick is never left out for fit without its tier's next best going (review of the tier PR).
          if (a === "queue_tier_next") await import("../services/sweepShadow.js").then((S) => S.queueTierNext(userId, c, `the composer skipped the tier's pick: ${res.fail}`)).catch(() => null);
          if (a === "count_attempt") await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
          if (a === "drop_failed") await dropCandidate(registry, c, "skipped", `draft failed checks: ${res.fail}`);
        }
      }
      // Logged the way every failed draft is, so the proactive_blocked monitor counts composed bundles too (review of #135).
      if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, composerCalls: res.calls, notes: res.notes }, checks: [...ev.userChecks, ...pickChecks], reason: res.leadSkipped ? `draft skipped: ${res.fail}` : `draft failed checks: composer: ${res.fail}` });
      done(c.type);
      return;
    }
    composed = res;
    // The closing line's guardrail, in code (Royce, 2026-10-13): it stays only when what it says about them is backed by what Co knows
    // (bundleComposer.ts closingLinePrompt; Haiku, fail-safe: an unbacked line or a read that fails is left out, the finds still go).
    if (res.opening && !opts.dryRun) {
      const aboutThem = [known && rules ? memberDraftBlock(known, rules) : "", feelingText ? `How they've been: ${feelingText}` : "", recentStamped].filter(Boolean).join("\n\n").slice(-12_000);
      const verdict = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 200, abortSignal: AbortSignal.timeout(20_000), prompt: B.closingLinePrompt(res.opening, aboutThem) })
        .then((r) => B.readClosingJudgment(r.text))
        .catch((err: any) => ({ backed: false, why: `the read failed: ${String(err?.message ?? err).slice(0, 120)}` }));
      if (!verdict.backed) {
        const line = res.opening;
        // Exactly where it sits: right after the last caption, before the closing question (bundleComposer.ts).
        const at = res.messages.length - (res.closing ? 2 : 1);
        const messages = res.messages[at] === line ? [...res.messages.slice(0, at), ...res.messages.slice(at + 1)] : res.messages;
        const words = [...res.perItem.map((p) => p.messages[p.messages.length - 1]), res.closing].filter(Boolean) as string[];
        composed = { ...res, opening: null, messages, text: words.join("\n"), notes: [...res.notes, `closing line left out: ${verdict.why}`] };
        if (!opts.dryRun) recordDecision({ layer: 7, decision: "proactive.closing_line", userId, outcome: "skip", action: "left_out", reason: verdict.why, proposal: { candidate: c.id, line } }).catch(() => {});
      }
    }
    for (const d of res.dropped) if (!opts.dryRun) recordDecision({ layer: 7, decision: "proactive.sibling_dropped", userId, outcome: "skip", action: "composer", reason: d.why, proposal: { candidate: d.item.candidate.id } }).catch(() => {});
    // A morning tier pick left out after being told it goes: its tier's next best is queued (review of the tier PR).
    // The skipped pick itself comes out (skipped twice for fit), so its tier never sends two.
    for (const d of res.dropped) {
      if (!d.tierSkipped || opts.dryRun) continue;
      await dropCandidate(registry, d.item.candidate, "skipped", d.why).catch(() => {});
      await import("../services/sweepShadow.js").then((S) => S.queueTierNext(userId, d.item.candidate, d.why)).catch(() => null);
    }
  }

  // Where their finds come from, said once (services/wantPlace.ts, Royce 2026-10-15): the first find searched in a place they didn't name
  // in the want itself carries one line, right before the closing question. It's marked said only once it was delivered.
  let placeNote: { key: string; line: string } | null = null;
  if (composed && !opts.dryRun) {
    const W = await import("../services/wantPlace.js");
    let after: string | null = null;
    for (const it of composed.perItem) {
      const s = (it.candidate.payload as { match?: { searchedIn?: { key: string | null; place: string | null; source: string } } }).match?.searchedIn;
      if (!s?.key || s.source !== "told") continue;
      const row = await W.realPlaceDeps.row(userId, s.key).catch(() => null);
      const line = W.noteDue(row, person.city ?? null);
      if (line) {
        placeNote = { key: s.key, line };
        after = it.messages[it.messages.length - 1] ?? null;
        break;
      }
    }
    if (placeNote) {
      // Right after its own find's caption, so it's about that find; before the closing question when the caption can't be found.
      const i = after ? composed.messages.lastIndexOf(after) : -1;
      const at = i >= 0 ? i + 1 : composed.messages.length - (composed.closing ? 1 : 0);
      composed = { ...composed, messages: [...composed.messages.slice(0, at), placeNote.line, ...composed.messages.slice(at)], text: `${composed.text}\n${placeNote.line}`, notes: [...composed.notes, "where their finds come from, said once"] };
    }
  }

  let draft: DraftResult;
  try {
    draft = composed ? { messages: composed.messages, text: composed.text, rules: {} } : await drafting(c.type, () => registry[c.type].draft(c, person));
  } catch (err: any) {
    if (!opts.dryRun) {
      await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
      if (c.attempts + 1 >= RULES.maxDraftAttempts) await dropCandidate(registry, c, "skipped", `draft error: ${err?.message ?? err}`);
      await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal, checks: [...ev.userChecks, ...pickChecks], reason: `draft failed: ${err?.message ?? err}` });
    }
    done(c.type);
    return;
  }

  if ("defer" in draft) {
    // A find's defer (a re-read held it, Phase B) never pushes it past its own expiry: a dated row would outlive its date.
    if (!opts.dryRun) await pool.query(
      `UPDATE proactive_candidates SET due_at = $2, expires_at = CASE WHEN type = 'event_offer' AND expires_at IS NOT NULL THEN LEAST(expires_at, $3) ELSE $3 END, updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [c.id, draft.defer, new Date(draft.defer.getTime() + 3 * 24 * 3_600_000)],
    );
    if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `defer:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source, deferTo: draft.defer.toISOString() }, checks: [...ev.userChecks, ...pickChecks], reason: `deferred: ${draft.reason}` });
    done(c.type);
    return;
  }

  if ("skip" in draft) {
    if (!opts.dryRun) await dropCandidate(registry, c, "skipped", draft.skip);
    if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source }, checks: [...ev.userChecks, ...pickChecks], reason: `draft skipped: ${draft.skip}` });
    done(c.type);
    return;
  }

  // Co texts first here, so there's no lowercase style to mirror. (A composed bundle was tidied and checked inside the composer.)
  if (!composed) draft = { ...draft, text: capitalizeSentences(draft.text), messages: draft.messages.map(capitalizeSentences) };
  // The draft's own rules plus: never a question Co already asked after which
  // they wrote back (harness/repeatAsk.ts).
  const withRepeat = (checks: GateCheck[], text: string): GateCheck[] => {
    const again = repeatQuestionCheck(text, recent);
    return again.pass ? checks : [...checks, again as GateCheck];
  };
  // A composed bundle's checks ran inside the composer: its record says so, with how many calls it took and what was left out.
  let draftChecks: GateCheck[] = composed ? [{ name: "composer_checks", pass: true, reason: `${composed.calls} call(s)${composed.notes.length ? `; ${composed.notes.join("; ")}` : ""}${composed.dropped.length ? `; ${composed.dropped.length} left out` : ""}` }] : withRepeat(checkDraft(draft.text, draft.rules), draft.text);
  let dg = gate(draftChecks);
  // One rewrite, told what to fix, before the day's text is given up.
  if (!dg.ok) {
    const first = { draft: draft.text, failed: describeFailed(dg.failed) };
    const second = await drafting(c.type, () => draftAgain(first, () => registry[c.type].draft(c, person)))
      .catch(() => null);
    if (second && "messages" in second) {
      const fixed = { ...second, text: capitalizeSentences(second.text), messages: second.messages.map(capitalizeSentences) };
      const fixedChecks = withRepeat(checkDraft(fixed.text, fixed.rules), fixed.text);
      const fg = gate(fixedChecks);
      if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.redraft", userId, outcome: fg.ok ? "act" : "skip", action: `send:${c.type}`, proposal: { picked: c.id, first: first.draft, second: fixed.text }, checks: fixedChecks, reason: `first draft broke: ${first.failed}` }).catch(() => {});
      if (fg.ok) {
        draft = fixed;
        draftChecks = fixedChecks;
        dg = fg;
      }
    }
  }
  if (!dg.ok) {
    if (!opts.dryRun) {
      await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
      if (c.attempts + 1 >= RULES.maxDraftAttempts) await dropCandidate(registry, c, "skipped", `draft failed checks: ${describeFailed(dg.failed)}`);
    }
    if (!opts.dryRun) await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, draft: draft.text }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks], reason: `draft failed checks: ${describeFailed(dg.failed)}` });
    done(c.type);
    return;
  }

  // Payload first (harness/payloadFirst.ts, 2026-10-04): a text asking whether
  // Co should do something it could just do goes to one of its tasks instead,
  // which does the work and sends the result. Questions stay for what the
  // member owns and for steps that are irreversible or seen by others.
  const pf = await payloadFirst({ userId, kind: c.type, draft: draft.messages.join("\n"), recent, theirAsk: theirAskOf(c.payload), dryRun: opts.dryRun }).catch(() => null);
  if (pf && "wouldHandOff" in pf) {
    console.log(`[dispatch dryRun] payload first: would do the work instead of sending "${draft.text}" (${pf.wouldHandOff})`);
    return;
  }
  decision = afterPayloadFirst(decision, pf && "handedTo" in pf ? { handedTo: String(pf.handedTo), why: pf.why } : pf && "hold" in pf ? { hold: pf.hold } : null);
  if (decision.kind === "act" && pf && "handedTo" in pf) {
    done(c.type);
    if (opts.dryRun) return;
    await dropCandidate(registry, c, "skipped", `payload first: handed to task ${pf.handedTo}`);
    // The task's result lands within 15 minutes: nothing else goes out first,
    // the same spacing as between any two texts (review of #59).
    await pool.query(
      `INSERT INTO proactive_user_state (user_id, space_until) VALUES ($1, NOW() + ($2 || ' hours')::interval)
       ON CONFLICT (user_id) DO UPDATE SET space_until = GREATEST(COALESCE(proactive_user_state.space_until, NOW()), EXCLUDED.space_until)`,
      [userId, RULES.minHoursBetweenTexts],
    );
    await recordDecision({ layer: 7, decision: "proactive.payloadFirst", userId, outcome: "act", action: `task:${pf.handedTo}`, proposal: { ...proposal, picked: c.id, instead_of: draft.text, started: pf.started }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks], reason: pf.why });
    return;
  }
  if (decision.drop && pf && "hold" in pf) {
    done(c.type);
    if (opts.dryRun) return;
    // Not asked instead: dropped, and its source asks again on its own schedule
    // (a re-queued target is a no-op once dropped, so this can't loop hourly).
    await dropCandidate(registry, c, "skipped", decision.drop);
    await recordSkipOnce(userId, `payload_first_hold:${c.type}`, { layer: 7, decision: "proactive.payloadFirst", userId, outcome: "skip", action: `hold:${c.type}`, proposal: { ...proposal, picked: c.id, instead_of: draft.text }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks], reason: pf.hold });
    return;
  }

  // A composed bundle goes out as written: each find's link and caption, the tie-back line, and its closing question
  // (harness/bundleComposer.ts). Each included find is ledgered with its own link and caption.
  const outgoing = draft.messages;
  // A stopped-looking line owed for RECHECK_TEXT_AFTER_DAYS (no reply carried it) rides in this text, which goes anyway
  // (services/askRetire.ts, Royce 2026-10-13: no silent expiries, never a text of its own). Code-written, once. Never in a composed
  // bundle: what goes out there is what the composer wrote.
  let rideNote: import("../services/askRetire.js").StopNote | null = null;
  let sending = outgoing;
  if (!composed) {
    const A = await import("../services/askRetire.js");
    // Never a heavy check-in, never while they're struggling; through the member fence, the first owed note that passes it whole.
    // The dispatch's one restraint read (memberSendState): struggling now means no note.
    if (A.noteMayRide(c, !!member.state.needsCare)) {
      const { memberFence } = await import("../services/sourceFence.js");
      const fence = await memberFence(userId).catch(() => null);
      rideNote = fence && !fence.failed ? await A.pendingStopNotes(userId).then((n) => A.firstSurviving(A.notesToRide(n, state.now), fence.strip)).catch(() => null) : null;
      if (rideNote) {
        const { carryLaneNotes } = await import("../services/laneMoves.js");
        sending = A.rideAlong(outgoing, rideNote.line, (d, p) => carryLaneNotes(d, p));
      }
    }
  }
  const extras: { candidate: Candidate; messages: string[] }[] = composed ? composed.perItem.slice(1) : [];

  // Bound: only a deliver of this candidate goes out (brain/index.ts sends).
  if (!sends(decision, c.id)) {
    console.error(`proactive: the decision for ${userId} doesn't deliver ${c.id} (${decision.kind}: ${decision.why}); nothing sent`);
    done(c.type);
    return;
  }
  done(c.type);
  if (opts.dryRun) {
    console.log(`[dispatch dryRun] would send ${sending.length} text(s) for ${c.targetKey} plus ${extras.length} batched:`);
    sending.forEach((m, i) => console.log(`  ${i + 1}. ${m.replace(/\n/g, " / ")}`));
    return;
  }

  let result: Awaited<ReturnType<typeof sendWithLedger>>;
  try {
    result = await sendWithLedger(c, person, sending, { ...opts, suppressedKinds: state.suppressedKinds }, extras);
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
  // Co's record of what it did (services/coFacts.ts).
  if (result.delivered.length) await recordProactiveText(userId, c.type, result.delivered.join(" "), c.id);
  if (placeNote && result.delivered.includes(placeNote.line)) {
    await import("../services/wantPlace.js").then((W) => W.markNoted(userId, placeNote!.key)).catch((err: any) => console.error("proactive: marking where their finds come from as said failed (non-fatal):", err?.message ?? err));
  }
  // The stopped-looking line, told once it was delivered (services/askRetire.ts).
  if (rideNote) {
    const A = await import("../services/askRetire.js");
    if (A.noteCarried(result.delivered.join("\n"), rideNote)) await A.markNotesTold(userId, [rideNote], "text").catch((err: any) => console.error("proactive: marking the stopped-looking line told failed (non-fatal):", err?.message ?? err));
  }
  await registry[c.type].onSent?.(c, person, result.delivered).catch((err: any) =>
    console.error(`proactive: onSent(${c.type}) failed (non-fatal):`, err?.message ?? err),
  );
  for (const e of extras) {
    await registry[e.candidate.type].onSent?.(e.candidate, person, e.messages).catch((err: any) =>
      console.error(`proactive: onSent(${e.candidate.type}) for a batched offer failed (non-fatal):`, err?.message ?? err),
    );
  }
  await recordDecision({
    layer: 7,
    decision: "proactive.dailyPick",
    userId,
    outcome: "act",
    action: `send:${c.type}`,
    proposal: { ...proposal, picked: c.id, pickSource: picked.source, pickWhy: picked.reason, messages: sending, batched: extras.map((e) => e.candidate.targetKey), delivered: result.delivered.length },
    checks: [...ev.userChecks, ...pickChecks, ...draftChecks],
    reason: result.delivered.length < draft.messages.length ? `${picked.reason} (partial send: ${result.delivered.length}/${draft.messages.length} delivered)` : picked.reason,
  });
}

export { proactivePaused } from "../services/proactivePause.js";

export async function runProactiveDispatch(registry: ProactiveRegistry): Promise<void> {
  if (proactivePaused()) return;
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

// Next local `hour`:00 strictly after `after`, in their time zone (the
// fallback zone, Pacific, when unknown). Used for "the morning after" debriefs.
export function nextLocalHour(after: Date, timezone: string | null, hour: number): Date {
  const local = DateTime.fromJSDate(after).setZone(hoursZone(timezone));
  let t = local.set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (t <= local) t = t.plus({ days: 1 });
  return t.toJSDate();
}
