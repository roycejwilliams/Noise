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
import { offerFollowUp } from "../services/offerFollowUp.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { safetyHoldActive } from "../services/safety.js";
import { repeatQuestionCheck } from "./repeatAsk.js";
import { payloadFirst, theirAskOf } from "./payloadFirst.js";
import { getEmotionalContext, renderEmotionalContext } from "./emotion.js";
import { kindOf, loadKindRestraint, loadStoredPrefs, RESTRAINT, suppressedKinds, syncKindPreferences, type ProactiveKind } from "../services/kindRestraint.js";

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
  // Co doesn't know them yet and their membership will close unless they
  // reply (services/membershipLapse.ts, 2026-09-22).
  | "membership_lapse"
  // Before a Co event they're going to (services/preArrival.ts, 2026-09-30).
  | "pre_arrival"
  // The member brief, the day before a Co event, and the one question at RSVP that lets it name them (services/eventBrief.ts, 2026-10-05).
  | "event_brief"
  | "brief_name_ask"
  // After the member tells Co who they met: what stood out, and a note per person for them to send (services/eventFollowThrough.ts).
  | "event_followthrough"
  // Member-facing Mo (mo/memberFlow.ts): the one offer, the voice to approve, the people to pick, and what came back.
  | "mo_member_offer"
  | "mo_member_voice"
  | "mo_member_batch"
  | "mo_member_update"
  // The one "still on your plate?" ask for a loop nobody has signalled on for a week (services/loopLifecycle.ts, 2026-10-06).
  | "loop_check"
  // Rare, seasonal check-in on a goal (services/goalJourney.ts): never on the 7-day ask clock.
  | "goal_checkin"
  // A goal closed at their word: a companion moment that acknowledges the arc, not a status flip.
  | "goal_closed"
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
  // Weekly by design; the gap stops two in one week if one was delayed.
  membership_lapse: { priority: 25, typeGapDays: 6 },
  // Time-bound: hours before the event, once per event (its own target key).
  pre_arrival: { priority: 95 },
  // Once per event each, timed to the day before and to the RSVP.
  event_brief: { priority: 90 },
  brief_name_ask: { priority: 92 },
  event_followthrough: { priority: 93 },
  mo_member_offer: { priority: 40 },
  mo_member_voice: { priority: 86 },
  mo_member_batch: { priority: 87 },
  mo_member_update: { priority: 88 },
  // Once per loop (its own target key); it is a question, so it is the lowest of the companion kind.
  loop_check: { priority: 12, typeGapDays: 3 },
  // Seasonal: one in eight weeks at most (also enforced where it is queued); the closing moment is a reply to what they said.
  goal_checkin: { priority: 9, typeGapDays: 56 },
  goal_closed: { priority: 86 },
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
const ROOM_LANE = new Set<string>(["event_offer", "event_match_nudge", "network_tease", "in_room", "pre_arrival", "event_brief", "brief_name_ask", "event_followthrough", "intro_nudge"]);
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
  const checks: GateCheck[] = [{ name: "not_opted_out", pass: !state.optedOut, reason: "they opted out of texts" }];
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
// (an event change, a reminder they set, a task update) still don't space:
// they're ledgered exempt and aren't answer types. An exempt event offer is an
// answer or rode along in a counted text, so it spaces either way.
function spaces(s: SendRecord): boolean {
  return !s.exempt || ANSWERING_TYPES.has(s.type) || s.type === "event_offer";
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

// answering: a reply (isAnswering) doesn't wait on the last text of its type
// (two time frames they named are two replies); the same topic still waits.
export function candidateChecks(c: Candidate, state: Pick<PickState, "now" | "sends" | "lastInboundAt" | "needsCare" | "safetyHold" | "undeliveredYes" | "suppressedKinds">, opts: { answering?: boolean } = {}): GateCheck[] {
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
  if (state.needsCare && HOLD_WHILE_STRUGGLING.has(c.type)) {
    checks.push({ name: "emotional_timing", pass: false, reason: "they've been struggling in the last day; this can wait" });
  }
  // Restraint with memory (services/kindRestraint.ts): a kind of text they let pass twice in a row isn't sent again until they answer
  // one. An answer to their own explicit ask (an event offer for an open ask) is never held back: they asked.
  const kind = kindOf(c.type, c.payload);
  if (kind && !(kind === "find" && isAnswering(c)) && state.suppressedKinds?.includes(kind)) {
    checks.push({ name: "kind_restraint", pass: false, reason: `they let the last ${RESTRAINT.ignoredToSuppress} ${kind} texts pass with no reply or reaction; Co stopped sending these until they answer one` });
  }
  // One goal surface a season, across the seasonal check-in and the goal nudge (services/goalJourney.ts GOAL_CHECKIN).
  if (c.type === "goal_checkin" || c.type === "goal_nudge") {
    const lastGoal = state.sends.filter((s) => (s.type === "goal_checkin" || s.type === "goal_nudge") && s.sentAt <= state.now).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
    checks.push({
      name: "goal_season",
      pass: !lastGoal || state.now.getTime() - lastGoal.sentAt.getTime() >= GOAL_SEASON_DAYS * DAY,
      reason: lastGoal ? `a ${lastGoal.type} went out within ${GOAL_SEASON_DAYS} days` : undefined,
    });
  }
  return checks;
}

const PERSON_CHECKS = new Set(["not_opted_out", "local_hours"]);
// The quota an answer skips. Spacing is not in it: every text keeps it.
const QUOTA_CHECKS = new Set(["daily_cap", "weekly_cap", "unanswered_pause", "engagement_pace"]);

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
const ANSWERING_TYPES = new Set<string>(["network_tease", "ask_checkin", "window_followup", "debrief", "pre_arrival", "post_call", "event_followthrough", "mo_member_voice", "mo_member_batch", "mo_member_update", "goal_closed"]);
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
    const laneChecks = (pacedByEngagement(candidate) ? byLane : legacyByLane)[laneOf(candidate.type)].filter(
      (k) => !PERSON_CHECKS.has(k.name) && !(answering && QUOTA_CHECKS.has(k.name)) && !(candidate.type === "companion" && k.name === "weekly_cap"),
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
export function pickSiblingOffers(primary: Candidate, eligible: Candidate[]): Candidate[] {
  const tierOf = (c: Candidate) => Number((c.payload as { match?: { tier?: number } })?.match?.tier ?? 0);
  const isReminder = (c: Candidate) => Boolean((c.payload as { reminder?: boolean })?.reminder);
  if (primary.type !== "event_offer" || isReminder(primary)) return [];
  const seen = new Set([tierOf(primary)]);
  const out: Candidate[] = [];
  const ranked = [...eligible]
    .filter((c) => c.type === "event_offer" && c.id !== primary.id && !isReminder(c))
    .sort((a, b) => b.priority - a.priority || (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) || a.dueAt.getTime() - b.dueAt.getTime());
  for (const c of ranked) {
    const t = tierOf(c);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(c);
  }
  return out;
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
  const redo = redraftFor.getStore();
  const build = (own: string | null) => `${CO_VOICE}

${CO_TEXT_CHANNEL} You're texting ${opts.firstName}. Co is reaching out first; they didn't just text you.

${opts.maxSentences && opts.maxSentences !== 2 ? PROACTIVE_RULES.replace("Max 2 sentences", `Max ${opts.maxSentences} sentences`) : PROACTIVE_RULES}

CONFIRMED_FACTS (the only facts you may state)
${renderFacts(opts.facts)}
${feeling ? `\nHOW THEY'VE BEEN FEELING (let it shape how you say this, never whether you say it: it's not a reason to SKIP. If they've been struggling, be gentler and lower-pressure, and acknowledge it briefly and warmly in your own words before the rest. Never name the feeling)\n${feeling}\n` : ""}

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

export async function enqueueCandidate(input: EnqueueInput): Promise<{ queued: boolean }> {
  // Advice follow-ups, time-frame follow-ups, ask check-ins and debriefs: Co
  // decides when (services/followUps.ts). What it sends still comes back here.
  if (!input.fromCo) {
    const F = await import("../services/followUps.js");
    if (F.followUpsByCo() && F.handedToCo(input)) return F.startFollowUp(input);
  }
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
  about: { recentConversation: string; feeling: string; taste?: string | null },
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
Their recent texts with you (oldest first):
${about.recentConversation.slice(-2500) || "(none)"}

Ready to send:
${eligible.map((c) => `- ${c.id} [${c.type}] ${c.summary}`).join("\n")}

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
export function needsRelevanceCheck(c: Candidate, now: Date): boolean {
  if (!isAnswering(c) || now.getTime() - c.createdAt.getTime() <= RELEVANCE_RECHECK_HOURS * HOUR) return false;
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
export async function stillRelevant(c: Candidate, about: { recentConversation: string; now: Date; timezone: string | null }): Promise<{ relevant: boolean; why: string } | null> {
  const day = (d: Date) => localStamp(d, about.timezone);
  try {
    const { text } = await Promise.race([
      generateText({
        model: anthropic(DRAFT_MODEL),
        maxOutputTokens: 300,
        experimental_telemetry: { isEnabled: true, functionId: "proactive.stillRelevant" },
        prompt: `A text Co was going to send this member has been waiting since ${day(c.createdAt)}. It's now ${day(about.now)}.

What it was going to do: [${c.type}] ${c.summary}

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
    const answering = isAnswering(c);
    const checks = [
      ...userLevelChecks({ now, timezone: person.timezone, optedOut: optedOutNow, sends, lastInboundAt }, { lane: laneOf(c.type), ignorePacing: opts.ignorePacing, legacyPace: !pacedByEngagement(c) }).filter(
        (k) => !(answering && QUOTA_CHECKS.has(k.name)) && !(c.type === "companion" && k.name === "weekly_cap"),
      ),
      ...candidateChecks(c, { now, sends, lastInboundAt, undeliveredYes: c.type === "network_tease" ? await import("../services/networkIntroNudge.js").then((m) => m.lastTeaseUndelivered(person.userId)).catch(() => false) : false, suppressedKinds: await loadKindRestraint(client, person.userId, now).then((r) => suppressedKinds(r.verdicts)).catch(() => opts.suppressedKinds ?? []) }, { answering }),
    ];
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
      [person.userId, c.type, c.targetKey, c.topicKey, c.id, messages.join("\n\n"), sendIsExempt(c, extras.map((e) => e.candidate), opts.ignorePacing === true), kindOf(c.type, c.payload)],
    );
    if (!ins.rows[0]) {
      await client.query("ROLLBACK");
      return { sent: false, failed: [{ name: "not_sent_before", pass: false, reason: "idempotency key taken" }] };
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
}): Promise<{ sent: boolean; reason?: string; delivered?: string[] }> {
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

// dryRun drafts and composes what would go out, prints it, and stops before the ledger and the send.
export async function dispatchForUser(registry: ProactiveRegistry, userId: string, opts: { ignorePacing?: boolean; dryRun?: boolean } = {}): Promise<void> {
  const person = await loadPerson(userId);
  if (!person) return;

  const hold = await pool.query(`SELECT hold_until, space_until FROM proactive_user_state WHERE user_id = $1`, [userId]);
  if (hold.rows[0]?.hold_until && new Date(hold.rows[0].hold_until) > new Date()) return;
  // Spacing after work was handed to a task (harness/payloadFirst.ts). Unlike
  // hold_until, new candidates don't clear it.
  if (hold.rows[0]?.space_until && new Date(hold.rows[0].space_until) > new Date()) return;

  const { rows: candRows } = await pool.query(
    `SELECT * FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND NOT (type = ANY($2::text[]))`,
    [userId, pausedTypes()],
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
  state.safetyHold = await safetyHoldActive(userId);
  state.undeliveredYes = await import("../services/networkIntroNudge.js").then((m) => m.lastTeaseUndelivered(userId)).catch(() => false);
  // Kinds they keep letting pass (services/kindRestraint.ts); the learned preference is written when it flips. A read that fails
  // holds what's stored, never more than that.
  const restraint = await loadKindRestraint(pool, userId, state.now).catch((err: any) => {
    console.error("proactive: kind restraint read failed (non-fatal, holding what's stored):", err?.message ?? err);
    return null;
  });
  state.suppressedKinds = restraint
    ? suppressedKinds(restraint.verdicts)
    : await loadStoredPrefs(pool, userId).then((p) => p.filter((x) => x.state === "suppressed").map((x) => x.kind)).catch(() => []);
  if (restraint && !opts.dryRun) await syncKindPreferences(userId, restraint.verdicts, restraint.stored).catch(() => 0);
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

  const recent = await pool
    .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' ORDER BY created_at DESC LIMIT 12`, [userId])
    .then((r) => r.rows.map((x: any) => String(x.content)).reverse().join("\n"))
    .catch(() => "");
  const taste = await import("../services/outcomes.js").then((m) => m.tasteSummary(userId)).catch(() => null);
  const picked = await choosePick(ev.eligible, { recentConversation: recent, feeling: renderEmotionalContext(emotional), taste });
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

  if (needsRelevanceCheck(c, state.now)) {
    const r = await stillRelevant(c, { recentConversation: recent, now: state.now, timezone: person.timezone });
    if (!opts.dryRun) await settleRelevance(c, r);
    if (!r) {
      await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `recheck:${c.type}`, proposal: { ...proposal, picked: c.id }, checks: [...ev.userChecks, ...pickChecks], reason: `relevance check unanswered; held ${RELEVANCE_RETRY_HOURS}h` });
      return;
    }
    if (!r.relevant) {
      if (!opts.dryRun) await dropCandidate(registry, c, "skipped", `stale: ${r.why}`);
      await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `archive:${c.type}`, proposal: { ...proposal, picked: c.id }, checks: [...ev.userChecks, ...pickChecks], reason: `no longer relevant: ${r.why}` });
      return;
    }
  }

  let draft: DraftResult;
  try {
    draft = await feelingForDraft.run(renderEmotionalContext(emotional), () => registry[c.type].draft(c, person));
  } catch (err: any) {
    await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
    if (c.attempts + 1 >= RULES.maxDraftAttempts) await dropCandidate(registry, c, "skipped", `draft error: ${err?.message ?? err}`);
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal, checks: [...ev.userChecks, ...pickChecks], reason: `draft failed: ${err?.message ?? err}` });
    return;
  }

  if ("defer" in draft) {
    await pool.query(
      `UPDATE proactive_candidates SET due_at = $2, expires_at = $3, updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [c.id, draft.defer, new Date(draft.defer.getTime() + 3 * 24 * 3_600_000)],
    );
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `defer:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source, deferTo: draft.defer.toISOString() }, checks: [...ev.userChecks, ...pickChecks], reason: `deferred: ${draft.reason}` });
    return;
  }

  if ("skip" in draft) {
    await dropCandidate(registry, c, "skipped", draft.skip);
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, pickSource: picked.source }, checks: [...ev.userChecks, ...pickChecks], reason: `draft skipped: ${draft.skip}` });
    return;
  }

  // Co texts first here, so there's no lowercase style to mirror.
  draft = { ...draft, text: capitalizeSentences(draft.text), messages: draft.messages.map(capitalizeSentences) };
  // The draft's own rules plus: never a question Co already asked after which
  // they wrote back (harness/repeatAsk.ts).
  const withRepeat = (checks: GateCheck[], text: string): GateCheck[] => {
    const again = repeatQuestionCheck(text, recent);
    return again.pass ? checks : [...checks, again as GateCheck];
  };
  let draftChecks = withRepeat(checkDraft(draft.text, draft.rules), draft.text);
  let dg = gate(draftChecks);
  // One rewrite, told what to fix, before the day's text is given up.
  if (!dg.ok) {
    const first = { draft: draft.text, failed: describeFailed(dg.failed) };
    const second = await feelingForDraft
      .run(renderEmotionalContext(emotional), () => draftAgain(first, () => registry[c.type].draft(c, person)))
      .catch(() => null);
    if (second && "messages" in second) {
      const fixed = { ...second, text: capitalizeSentences(second.text), messages: second.messages.map(capitalizeSentences) };
      const fixedChecks = withRepeat(checkDraft(fixed.text, fixed.rules), fixed.text);
      const fg = gate(fixedChecks);
      await recordDecision({ layer: 7, decision: "proactive.redraft", userId, outcome: fg.ok ? "act" : "skip", action: `send:${c.type}`, proposal: { picked: c.id, first: first.draft, second: fixed.text }, checks: fixedChecks, reason: `first draft broke: ${first.failed}` }).catch(() => {});
      if (fg.ok) {
        draft = fixed;
        draftChecks = fixedChecks;
        dg = fg;
      }
    }
  }
  if (!dg.ok) {
    await pool.query(`UPDATE proactive_candidates SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1`, [c.id]);
    if (c.attempts + 1 >= RULES.maxDraftAttempts) await dropCandidate(registry, c, "skipped", `draft failed checks: ${describeFailed(dg.failed)}`);
    await recordDecision({ layer: 7, decision: "proactive.dailyPick", userId, outcome: "skip", action: `send:${c.type}`, proposal: { ...proposal, picked: c.id, draft: draft.text }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks], reason: `draft failed checks: ${describeFailed(dg.failed)}` });
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
  if (pf && "handedTo" in pf) {
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
  if (pf && "hold" in pf) {
    // Not asked instead: dropped, and its source asks again on its own schedule
    // (a re-queued target is a no-op once dropped, so this can't loop hourly).
    await dropCandidate(registry, c, "skipped", `payload first: ${pf.hold}`);
    await recordSkipOnce(userId, `payload_first_hold:${c.type}`, { layer: 7, decision: "proactive.payloadFirst", userId, outcome: "skip", action: `hold:${c.type}`, proposal: { ...proposal, picked: c.id, instead_of: draft.text }, checks: [...ev.userChecks, ...pickChecks, ...draftChecks], reason: pf.hold });
    return;
  }

  // Every tier with something goes out together, then one question after the last.
  let outgoing = draft.messages;
  const extras: { candidate: Candidate; messages: string[] }[] = [];
  if (c.type === "event_offer" && !(c.payload as { reminder?: boolean }).reminder) {
    for (const sib of pickSiblingOffers(c, ev.eligible)) {
      try {
        if (needsRelevanceCheck(sib, state.now)) {
          const r = await stillRelevant(sib, { recentConversation: recent, now: state.now, timezone: person.timezone });
          if (!opts.dryRun) await settleRelevance(sib, r);
          if (!r) continue;
          if (!r.relevant) {
            if (!opts.dryRun) await dropCandidate(registry, sib, "skipped", `stale: ${r.why}`);
            continue;
          }
        }
        const d = await feelingForDraft.run(renderEmotionalContext(emotional), () => registry.event_offer.draft(sib, person));
        if ("skip" in d || "defer" in d) continue;
        const msgs = d.messages.map(capitalizeSentences);
        const sibGate = gate(checkDraft(capitalizeSentences(d.text), d.rules));
        if (!sibGate.ok) {
          // A sibling offer dropped at its draft is on the record (2026-10-08 sweep review: these drops were silent).
          if (!opts.dryRun) recordDecision({ layer: 7, decision: "proactive.sibling_dropped", userId: c.userId, outcome: "skip", action: "draft_failed", reason: describeFailed(sibGate.failed), proposal: { candidate: sib.id, tier: (sib.payload as any)?.match?.tier ?? null } }).catch(() => {});
          continue;
        }
        extras.push({ candidate: sib, messages: msgs });
      } catch (err: any) {
        console.error("proactive: sibling offer draft failed (non-fatal):", err?.message ?? err);
      }
    }
    // The closing question is Co's own, about what it just sent (2026-09-28:
    // the fixed "Does anything here catch your eye?" read as a script). The
    // old pool is the fallback when the written line is late or breaks a rule.
    const sentNames = [c, ...extras.map((e) => e.candidate)].map((x) => String((x.payload as { match?: { name?: string } }).match?.name ?? "")).filter(Boolean);
    const { lineInVoice } = await import("../services/voiceLine.js");
    const stock = offerFollowUp(1 + extras.length);
    const closing = await lineInVoice({
      purpose: `End a run of ${sentNames.length === 1 ? "one thing" : `${sentNames.length} things`} you just texted them with one short, natural question asking whether ${sentNames.length === 1 ? "it" : "any of them"} interests them. Only the question, nothing else.`,
      facts: [`Co just sent them: ${sentNames.join("; ")}.`],
      examples: [],
      fallback: stock,
    }).catch(() => ({ text: stock, written: false }));
    outgoing = [...draft.messages, ...extras.flatMap((e) => e.messages), /\?\s*$/.test(closing.text) ? closing.text : stock];
  }

  if (opts.dryRun) {
    console.log(`[dispatch dryRun] would send ${outgoing.length} text(s) for ${c.targetKey} plus ${extras.length} batched:`);
    outgoing.forEach((m, i) => console.log(`  ${i + 1}. ${m.replace(/\n/g, " / ")}`));
    return;
  }

  let result: Awaited<ReturnType<typeof sendWithLedger>>;
  try {
    result = await sendWithLedger(c, person, outgoing, { ...opts, suppressedKinds: state.suppressedKinds }, extras);
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
    proposal: { ...proposal, picked: c.id, pickSource: picked.source, pickWhy: picked.reason, messages: outgoing, batched: extras.map((e) => e.candidate.targetKey), delivered: result.delivered.length },
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
