import { notToTeammate } from "../services/teamLines.js";
import { anthropic } from "@ai-sdk/anthropic";
import { alreadySentNames, canSkipReplyAfterResults, isOnlyUpdatesAsk } from "../services/searchRules.js";
import { capitalizeSentences } from "../services/textStyle.js";
import { captureIssueReport } from "../services/issueReports.js";
import { enqueueCandidate, nextLocalHour } from "../harness/proactive.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import type { WindowFollowUpPayload } from "../agent/windowFollowUp.js";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import { randomInt } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { DateTime } from "luxon";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { withAdvisoryLock } from "../db/advisoryLock.js";
import { sendSMS } from "../otpActions.js";
import elevenlabs from "../services/elevenlabs.js";
import { generateEmbedding } from "../services/embeddings.js";
import { detectSeekingMode } from "../services/emotionalTone.js";
import { getEmotionalContext, readTextEmotion, recordEmotionSignals, renderEmotionalContext } from "../harness/emotion.js";
import { buildContextSummary } from "../services/callContext.js";
import { findOrCreateUserByPhone, hasPendingEmail, splitFullName } from "../services/identity.js";
import { redeemInviteCodeIn } from "../services/inviteCodes.js";
import { countRecentGateReplies, decideGateReply } from "../services/gateGuard.js";
import { IDENTITY_RULE, stripUngroundedIdentity } from "../services/identityGuard.js";
import { claimJoinNotice, invitesLeftFor, inviterFirstName, releaseJoinNotice } from "../services/invites.js";
import { decideInviteJoinedGate } from "../services/inviteJoinGate.js";
import { handlePhoneChange } from "../services/phoneChange.js";
import { extensionForMessage, handleTeamText } from "../services/extensions.js";
import { firstSendTimes } from "../services/turnLatency.js";
import { catchUpReaction } from "../services/reactionCatchup.js";
import { gapDescription } from "../services/understanding.js";
import { logJevShadow, startJevShadow } from "../services/jevShadow.js";
import { relayFacts } from "../services/relay.js";
import { CO_WHY } from "../services/coVoice.js";
import { assembleContext, type TurnContext } from "../services/turnContext.js";
import { feedbackInstruction, readTurn, readTurnEnabled, type TurnRead } from "../services/readTurn.js";
import { dotsInstruction, momentInstruction, readMoment, saveLesson, whyContext, type Moment } from "../services/connectDots.js";
import { bareLink, inlineNote, repliedTo, repliedToFact, sentMessageHandle, threadReason } from "../services/inlineReply.js";
import { recordSafetyConcern, SAFETY_INSTRUCTION, soundsLikeCrisis } from "../services/safety.js";
import { describeImage } from "../services/imageRead.js";
import { CALL_OFFER, GATE_ASK, INVITE_JOINED, WELCOME, WELCOME_INVITED, WRONG_CODE, pickLine } from "../services/onboardingLines.js";
import { claimTextLogin } from "../services/textLogin.js";
import {
  INTAKE_EXTRACT_MODEL,
  buildIntakeExtractionPrompt,
  decideIntake,
  gatherIntakeState,
  isEmailOnOtherAccount,
  isValidEmail,
  parseIntakeProposal,
  type IntakeProposal,
} from "../harness/intake.js";
import { isOptInKeyword, isOptOutKeyword } from "../services/optOut.js";
import { captureIntentForTurn, coverageNudgeFrom, coveragePriorContext, getCoverageNudge, RAPPORT_TOPIC_DESCRIPTIONS } from "../services/profileExtraction.js";
import { generateRecommendation, recordRecommendationsSent } from "../services/recommendation.js";
import { isBrowseAsk } from "../services/askWindow.js";
import { recordOfferReaction, reactionFact, type OfferReaction } from "../services/offerReactions.js";
import { searchWithTimeCap } from "../agent/conversationTools.js";
import type { TierMatch } from "../services/tieredRecommendation.js";
import { lookupNamedEvent } from "../services/namedEventLookup.js";
import { detectCheckinPhrase, recordCheckin, hasActiveAsk, recordWalkinAsk } from "../services/eventWalkinCheckin.js";
import { scheduleOutcomeFollowUp, recordOutcome, wasClosestMissRecentlyMentioned, recordClosestMissMentioned } from "../services/recommendationOutcome.js";
import { recordEventCheckinOutcome } from "../services/eventCheckinFollowUp.js";
import { handleMatchNudgeReply } from "../services/eventGuestMatchHandoff.js";
import { resolveNetworkTeaseReply, resolveNetworkIntroReply } from "../services/networkIntroNudge.js";
import { NO_ROUTE, decideActions, gatherOpenItems, routeMessage, type RouterOutput } from "../services/messageRouter.js";
import { recordDecision } from "../harness/core.js";
import { routerGateChecks } from "../harness/routerChecks.js";
import { linkForReply, linksIn, mergeEarlierLink, type LinkRead } from "../services/linkReader.js";
import { addEventFacts, addFact, addHint, addInstruction, addOngoingSearchFacts, countOf, FRESH_SEARCH_INSTRUCTION, gatherReplyFacts, recordSearchNote } from "../harness/replyGrounding.js";
import { runConversationReplyAgent, filterRelevantMemories, CALL_OFFER_EXPIRY_DAYS } from "../agent/conversationReply.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import sendblue, { blockSender, cleanCoMessage, markRead, sendReaction, webhookSecretMatches, sendingAs } from "../services/sendblue.js";
import { TURN_FAILED_NOTE, turnFailedNoteBlocked } from "../services/turnFailure.js";
import { arrivedByText } from "../services/eventPresence.js";
import { lineInVoice } from "../services/voiceLine.js";
import { privacyAlert } from "../services/privacyAlert.js";
import { learnFromTextTurn } from "../services/turnLearning.js";
import { scoreGuestListForEvent } from "../services/eventScoring.js";
import { closingReaction, emojiFor, lastCoLine } from "../services/conversationClose.js";
import { renderMatchLead, sourceOf } from "../services/messageFormat.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { generateVoiceNote } from "../services/voiceNote.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { enrichMatch, renderEventDetails } from "../services/eventDetails.js";
import { refreshPersonSnapshot } from "../harness/personSnapshot.js";
import { recordSuggestionOutcome, resultFromNamedOutcome } from "../services/outcomes.js";
import { sendLateSearchResult } from "../services/lateSearchResult.js";
import { track } from "../services/shutdown.js";
import { sendLimiter } from "../services/sendLimiter.js";

// Serializes webhook processing per phone number. Without this, two
// messages sent seconds apart from the same person can be handled
// concurrently — the second one's queries can run before the first one's
// writes (e.g. a moment being created) have committed, so it falls through
// to the wrong branch entirely (confirmed: a rapid double "Yes" caused the
// second reply to skip the actionable-response handler and hit the general
// fallback instead, producing a hallucinated, unrelated reply).
//
// Backed by a Postgres advisory lock (db/advisoryLock.ts), not an in-memory
// map — a same-process-only lock silently stops protecting anything the
// moment this service runs as more than one replica.
function withPhoneLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(`phone:${phone}`, fn);
}

// How long to hold off Co's free-form reply after an inbound message, in
// case the same person is mid-thought and about to send a follow-up.
// Started at 5s; bumped to 8s after checking a real conversation's actual
// gaps between related messages (16s in one case) — 5s was catching only
// the fastest bursts. Not pushed further toward 16s itself: that would
// make every single-message reply feel sluggish for the common case just
// to fully cover one slower outlier.
const DEBOUNCE_MS = 4000;

// Heuristic-only (no LLM call — this is directly observable, not something
// to infer) read of how the user themselves texts, from their own lines in
// the chronological window already fetched for the reply prompt. Nudges
// phrasing only (length/formality/emoji) — deliberately leaves Co's core
// brand-voice rules (no em dashes) alone, since
// those aren't a per-user mirroring target. Needs at least 2 of the user's
// own messages before saying anything, so a first-ever text doesn't get a
// hint built off n=1.
// Recency-weighted, not a flat average over the whole window (Royce,
// 2026-09-08, confirmed live: "capitalization is no longer working,
// everything being texted back is lowercase") — this used to average
// lowercaseRate/avgWords/emojiRate over every user line in the 10-turn
// window with equal weight, so a real register shift (e.g. today's texts
// switching to normal capitalization) stayed invisible for turns, outvoted
// by older, more casual test messages earlier in the window. Only the
// last STYLE_HINT_RECENT_LINES user messages are considered now, so an
// actual shift in how someone's texting dominates within a message or two
// instead of a full window's worth.
const STYLE_HINT_RECENT_LINES = 4;

// Reply latency budgets, logged per turn (turn.latency). A search turn gets
// longer because a hold message already went out.
const REPLY_BUDGET_MS = 20_000;
const REPLY_BUDGET_SEARCH_MS = 60_000;

// Sent before a search so nobody waits in silence. Not a real reply: a copy
// of the message sent after one of these is still a duplicate.
// Marks the call-or-text question asked at the end of onboarding, so its
// answer can be saved as their contact preference.
const ONBOARDING_CALL_OFFER_PREFIX = "[onboarding]";

// The fallback for the line sent while a search runs, when Co didn't write
// its own. Kept so older logged rows are still recognized.
const HOLD_LINES = ["On it, give me a sec.", "Let me look, one sec.", "Looking now, give me a minute."];
export const HOLD_PREFIX = "Co is looking:";
// After a reaction, the looking text waits this long: a quick search needs none.
const HOLD_AFTER_ACK_MS = 8_000;
// Co's own hold line, used only when it's a short plain line with no link.
export function holdLineFrom(line: string | null | undefined): string | null {
  const t = cleanCoMessage(String(line ?? "")).trim();
  if (!t || t.length > 140 || /https?:\/\/|www\./i.test(t)) return null;
  return t;
}

function deriveStyleHint(chronological: { content: string }[]): string {
  const userLines = chronological
    .map((m) => m.content)
    .filter((c) => c.startsWith("User said: ") || c.startsWith("User sent a voice memo: "))
    .map((c) => c.replace(/^User (said|sent a voice memo): /, ""))
    .slice(-STYLE_HINT_RECENT_LINES);

  if (userLines.length < 2) return "";

  const avgWords =
    userLines.reduce((sum, l) => sum + l.trim().split(/\s+/).length, 0) / userLines.length;
  const emojiRate =
    userLines.filter((l) => /\p{Emoji_Presentation}/u.test(l)).length / userLines.length;
  const lowercaseRate =
    userLines.filter((l) => l === l.toLowerCase() && /[a-z]/.test(l)).length / userLines.length;

  const notes: string[] = [];
  if (avgWords <= 6) {
    notes.push("they text short and to the point — keep your replies just as brief, don't pad them out");
  } else if (avgWords >= 20) {
    notes.push("they text in longer, fuller messages — a slightly fuller reply than usual is fine here");
  }
  if (emojiRate >= 0.3) {
    notes.push("they use emoji — an occasional one back is fine, don't force it every message");
  }
  if (lowercaseRate >= 0.6) {
    notes.push("they text casually with minimal punctuation, so keep your tone relaxed (but always write in normal sentence case)");
  }

  return notes.length ? `\nHow they text (match this energy, not their exact words): ${notes.join("; ")}.` : "";
}

// Marks a visible gap between conversation lines whenever there's a real
// pause since the previous one — without this, two lines sitting next to
// each other in this block read as equally "just now" to the reply model,
// regardless of whether they were 30 seconds or 2 days apart. Confirmed
// live, 2026-09-04: a real "Call me" from 2 days earlier sat directly above
// an unrelated "For sure" from today with nothing marking the gap, and the
// reply model (told this whole block is "the actual thread") stitched them
// into one exchange — producing a reply that confidently, and wrongly,
// claimed the user had just said "call me" today. Threshold-gated, not
// shown on every line, so an ordinary back-and-forth doesn't get cluttered
// with markers for normal reply-time pauses.
const CONVERSATION_GAP_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function annotateConversationGaps(rows: { content: string; created_at: Date }[]): string {
  const lines: string[] = [];
  let prevTime: Date | null = null;
  for (const row of rows) {
    const time = new Date(row.created_at);
    if (prevTime && time.getTime() - prevTime.getTime() > CONVERSATION_GAP_THRESHOLD_MS) {
      lines.push(`[— ${formatGap(time.getTime() - prevTime.getTime())} later —]`);
    }
    lines.push(row.content);
    prevTime = time;
  }
  return lines.join("\n");
}

// Detect whether a media_url is a voice memo by checking its Content-Type
async function isAudioUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    const contentType = res.headers.get("content-type") ?? "";
    return contentType.startsWith("audio/");
  } catch {
    return false;
  }
}

// iMessage voice memos are real-world always audio/x-caf (Apple's Core
// Audio Format) — this previously hardcoded audio/mp4 + a .m4a filename
// regardless of the actual format, so ElevenLabs tried to decode CAF bytes
// as MP4 and every real iMessage voice memo failed transcription (confirmed
// with a real voice memo: content-type was genuinely audio/x-caf).
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/x-caf": "caf",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

// Transcribe a voice memo by downloading it first, then sending to ElevenLabs Scribe
// Download-first ensures ElevenLabs can access the audio regardless of Sendblue URL auth
async function transcribeVoiceMemo(audioUrl: string): Promise<string> {
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(10000) });
  if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
  const contentType = audioRes.headers.get("content-type")?.split(";")[0].trim() ?? "audio/mp4";
  const extension = AUDIO_EXTENSIONS[contentType] ?? "m4a";
  const arrayBuffer = await audioRes.arrayBuffer();
  const file = new File([arrayBuffer], `voice_memo.${extension}`, { type: contentType });

  const result = await elevenlabs.speechToText.convert({
    modelId: "scribe_v2",
    file,
  });
  return (result as { text: string }).text ?? "";
}

// Numbers Sendblue refused an inline reply to (SMS, or a line without it);
// Co stops trying for them until the next restart.
const inlineRefused = new Set<string>();

// Send Co's reply — voice note if user sent audio, text if they sent text
async function sendCoReply(params: {
  phone: string;
  message: string;
  asVoice: boolean;
  // Thread this text under one of theirs (services/inlineReply.ts).
  replyTo?: string | null;
}): Promise<boolean> {
  const { phone, asVoice } = params;
  // Confirmed live, 2026-09-08 sweep: this, the actual send function behind
  // the main conversational reply path (by far the highest-volume path in
  // the app), never applied cleanCoMessage — despite a since-corrected
  // comment elsewhere (conversationTools.ts) claiming it ran "inside
  // sendCoReply's send call." git history confirms cleanCoMessage has never
  // appeared in this file at all: not just the em dash/en dash cleanup, the
  // LEAKED_METACOMMENTARY safety guard bundled into the same function never
  // applied here either, on the single highest-traffic send path.
  const message = cleanCoMessage(params.message);

  let audioUrl: string | null = null;
  if (asVoice) {
    try {
      audioUrl = await generateVoiceNote(message);
    } catch (err: any) {
      console.error("Voice note generation failed, falling back to text:", err?.message ?? err);
    }
  }

  const body = {
    number: phone,
    content: audioUrl ? "" : message,
    ...(audioUrl ? { media_url: audioUrl } : {}),
    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
  };
  // An inline reply Sendblue refuses (not a V2 line, SMS, an old message) is
  // never sent at all, so it goes again as a plain text.
  if (params.replyTo && !audioUrl && !inlineRefused.has(phone)) {
    try {
      await sendblue.messages.send({ ...body, reply_to: { message_handle: params.replyTo } } as typeof body);
      return true;
    } catch (err: any) {
      if (/send breaker|meta-commentary/.test(String(err?.message))) {
        console.error(`sendCoReply failed for ${phone}:`, err?.message ?? err);
        return false;
      }
      console.error("sendCoReply: inline reply refused, sending it plain (non-fatal):", err?.status ?? "", err?.message ?? err);
      inlineRefused.add(phone);
      recordDecision({ layer: 7, decision: "reply.inline", userId: null, outcome: "skip", action: "refused", reason: String(err?.message ?? err).slice(0, 200) }).catch(() => {});
    }
  }
  try {
    await sendblue.messages.send(body);
  } catch (err: any) {
    // A real delivery failure (e.g. recipient hasn't texted in first) must
    // never crash the whole request — the reply was already generated and
    // stored; this only means Sendblue couldn't deliver it. Confirmed: this
    // was previously an uncaught 500, unlike every other send in this file.
    console.error(`sendCoReply failed for ${phone}:`, err?.message ?? err);
    // Callers need to know (2026-09-17 code review): a refused send used to
    // look like success, so callers logged "Co replied", skipped the
    // fallback, and the person got nothing.
    return false;
  }
  return true;
}

// Sends a message and logs it only if it actually went out.
async function sendAndLog(userId: string, phone: string, message: string, asVoice = false): Promise<boolean> {
  const sent = await sendCoReply({ phone, message, asVoice });
  if (sent) await logTextExchange(userId, `Co replied: ${cleanCoMessage(message)}`);
  return sent;
}

// Persists one side of a text exchange — same insert-then-embed pattern
// Step 3 (inbound) and Step 7 (Co's reply) use below for the main chat flow.
// Pulled out here because the identity-intake branch (Step 1.2) used to
// return early on every path without logging anything: a name/email mixup
// during intake left zero trace in co_memories, unlike every other exchange
// in the app. Embedding is fire-and-forget, matching Step 3/7's own
// non-blocking pattern — nothing here should delay Co's reply.
// True when Co hasn't replied since the message before this one — it owes a
// real answer, so a reaction would swallow it.
// "thursday (Thursday, September 17)": the words they used plus the actual
// dates, so the fit check can't read "Thursday" as any Thursday (2026-09-16:
// an Oct 5-11 event was judged a fit for "Thursday").
// The dates they asked about, so a description never calls an event "outside
// your window" when it sits inside it (2026-09-21: Sep 30 was called outside
// "next week", Sep 28 to Oct 4).
function dateCaveatRule(askedDates: string | null): string {
  if (!askedDates) return "";
  return `\nThe dates they asked about: ${askedDates}. Only say something is outside their dates if its date above really falls outside that range; if it falls inside, say nothing about their dates being off.\n`;
}

function describeTimeFrame(scope: { window: string | null; windowStart?: string | null; windowEnd?: string | null } | null | undefined): string | null {
  if (!scope?.window || !scope.windowStart || !scope.windowEnd) return null;
  const fmt = (iso: string) => DateTime.fromISO(iso, { setZone: true }).toFormat("cccc, LLLL d");
  const start = fmt(scope.windowStart);
  const end = fmt(scope.windowEnd);
  return `${scope.window} (${start === end ? start : `${start} to ${end}`})`;
}

// "2026-09-19" as a person says it: "Saturday, September 19".
function dayLabel(isoDate: string): string {
  const d = DateTime.fromISO(isoDate);
  return d.isValid ? d.toFormat("cccc, LLLL d") : isoDate;
}

async function replyOwed(userId: string): Promise<boolean> {
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories
       WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC LIMIT 6`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  // rows[0] is the message being handled now; look for their previous one.
  const earlier = rows.slice(1);
  const prevUser = earlier.findIndex((r: any) => String(r.content).startsWith("User said:"));
  if (prevUser === -1) return false;
  const since = earlier.slice(0, prevUser);
  return !since.some((r: any) => (String(r.content).startsWith("Co replied:") && !HOLD_LINES.some((l) => String(r.content) === `Co replied: ${l}`)) || String(r.content).startsWith("Mo replied:"));
}

// "You're in" for a good code: names the member who invited them when the
// code was a member's invite (services/invites.ts). Sends it and records the
// claim it makes (who it names, if anyone) so the morning review can check
// it against the invite log, the same as the join-note below.
async function welcomeLineFor(userId: string, phone: string, invitedBy: string | null | undefined): Promise<boolean> {
  const inviter = await inviterFirstName(invitedBy).catch(() => null);
  // pickLine returns "" when a line's variable is missing; the plain welcome
  // needs no variables, so it's always a safe fallback.
  const stock = (inviter ? pickLine(WELCOME_INVITED, { inviter }) : "") || pickLine(WELCOME);
  // Co writes it (services/voiceLine.ts); the stock line is the fallback.
  const { text: line, written } = await lineInVoice({
    purpose: "Welcome someone who just got into Co with a good invite code.",
    facts: inviter ? [`${inviter}, a member, invited them.`, "They're in."] : ["They're in. Someone invited them."],
    examples: inviter ? WELCOME_INVITED.map((l) => l.replace("{inviter}", inviter)) : WELCOME,
    mustInclude: inviter ? [inviter] : [],
    fallback: stock,
  });
  const sent = await sendAndLog(userId, phone, line);
  await recordDecision({
    layer: 3,
    decision: "account.inviteWelcome",
    userId,
    outcome: sent ? "act" : "skip",
    action: inviter ? "named_inviter" : "no_inviter",
    proposal: { ...(inviter ? { inviter } : {}), written },
  }).catch(() => {});
  return sent;
}

// Once someone who came in on a member's invite finishes onboarding, Co
// tells that member, once (services/invites.ts claimJoinNotice). Records the
// outcome either way — this is the note flagged 2026-09-20 as an unbacked
// claim ("Jacqueline's in. Good taste, Royce.") with nothing in the decision
// log behind it, even though it was true.
async function tellInviterTheyJoined(newUser: { id: string; first_name?: string | null }): Promise<void> {
  const record = (action: string, outcome: "act" | "skip", userId: string | null, extra: Record<string, unknown> = {}) =>
    recordDecision({ layer: 3, decision: "account.inviteJoined", userId, outcome, action, proposal: extra }).catch(() => {});

  const claimedInviterId = await claimJoinNotice(newUser.id);

  let priorInviterId: string | null = null;
  let inviterReachable = false;
  let inviterPhone: string | null = null;
  let inviterName: string | null = null;

  if (!claimedInviterId) {
    // claimJoinNotice returns null for either "nobody invited them" or "the
    // note already went out" — this extra read only tells the two apart for
    // the decision log; it changes nothing about what happens next.
    const prior = await pool.query(
      `SELECT created_by FROM invite_codes WHERE used_by = $1 AND created_by IS NOT NULL AND inviter_notified_at IS NOT NULL LIMIT 1`,
      [newUser.id],
    );
    priorInviterId = prior.rows[0]?.created_by ?? null;
  } else {
    const { rows } = await pool.query(
      `SELECT first_name, phone_number FROM users
       WHERE id = $1 AND identity_captured = true AND NOT sms_opted_out`,
      [claimedInviterId],
    );
    // Archived test accounts (co-test) are opted out, so they drop out here too.
    inviterReachable = Boolean(rows[0]?.phone_number);
    inviterPhone = rows[0]?.phone_number ?? null;
    inviterName = rows[0]?.first_name ?? null;
  }

  const gate = decideInviteJoinedGate({
    newUserId: newUser.id,
    claimedInviterId,
    priorInviterId,
    inviterReachable,
    friend: newUser.first_name?.trim() || null,
  });

  if (!gate.attempt) {
    await record(gate.action, "skip", gate.userId);
    // Unreachable/no-name are temporary states (opted out today, back tomorrow;
    // name captured a minute later), so don't burn the one-shot claim on them.
    if (claimedInviterId && (gate.action === "inviter_unreachable" || gate.action === "no_friend_name")) await releaseJoinNotice(newUser.id);
    return;
  }

  const left = await invitesLeftFor(gate.userId);
  const stock = pickLine(INVITE_JOINED, { name: inviterName, friend: gate.friend, left });
  const { text: line } = stock
    ? await lineInVoice({
        purpose: `Tell ${inviterName ?? "a member"} that the friend they invited just joined Co.`,
        facts: [`${gate.friend} joined Co on their invite.`, `They have ${left} invite${left === 1 ? "" : "s"} left; one only counts once someone joins.`],
        examples: INVITE_JOINED.map((l) => l.replace("{friend}", gate.friend ?? "").replace("{name}", inviterName ?? "").replace("{left}", String(left))),
        mustInclude: gate.friend ? [gate.friend] : [],
        fallback: stock,
      })
    : { text: "" };
  const sent = line ? await sendAndLog(gate.userId, inviterPhone!, line) : false;
  await record(sent ? "sent" : "send_failed", sent ? "act" : "skip", gate.userId, { friend: gate.friend, left });
  // The claim was already stamped, so an unsent note would be lost forever
  // with no retry (2026-09-20 code review). Hand it back instead.
  if (!sent) await releaseJoinNotice(newUser.id);
}

async function logTextExchange(userId: string, content: string): Promise<void> {
  const inserted = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2) RETURNING id`,
    [userId, content],
  );
  generateEmbedding(content)
    .then((emb) =>
      pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
        `[${emb.join(",")}]`,
        inserted.rows[0].id,
      ]),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
}

export function sendblueRouter(io: Server): Router {
  const router = Router();

  // POST /sendblue/webhook
  // Handles: inbound messages (text + voice memos), outbound delivery status, typing indicators
  router.post(
    "/webhook",
    async (req: Request, webhookRes: Response, next: NextFunction) => {
      // Only Sendblue can post here (2026-09-17 code review: with no check,
      // anyone with the URL could fake an inbound text from any number and
      // opt someone out, plant memories, trigger texts or calls, or claim a
      // test-site login code). Sendblue sends the webhook secret set in its
      // dashboard back in the sb-signing-secret header.
      const expectedSecret = process.env.SENDBLUE_WEBHOOK_SECRET;
      if (!expectedSecret) {
        // Fail closed in production specifically, per Royce's instruction —
        // co-test (RAILWAY_ENVIRONMENT_NAME === "dev") and local dev still
        // get through unverified, but log loudly either way so a missing
        // secret is never silently accepted.
        if (process.env.NODE_ENV === "production") {
          console.error("sendblue webhook: SENDBLUE_WEBHOOK_SECRET is not set in production, refusing every delivery until it is");
          webhookRes.status(503).send({ received: false });
          return;
        }
        console.error("sendblue webhook: SENDBLUE_WEBHOOK_SECRET is not set, accepting an UNVERIFIED delivery (fine for local/dev only)");
      } else if (!webhookSecretMatches(expectedSecret, req.get("sb-signing-secret"))) {
        console.error(`sendblue webhook: rejected a delivery without a valid sb-signing-secret (from ${req.ip})`);
        webhookRes.status(401).send({ received: false });
        return;
      }

      const lockKey: string | undefined = req.body?.number;

      // Ack every delivery first, before any database or model work
      // (2026-09-15: a 25-second turn outlasted Sendblue's wait, it resent the
      // same text five more times, and the copies jammed the phone's lock).
      // Everything below answers a stand-in that ignores the response.
      webhookRes.status(200).send({ received: true });
      const res: any = { headersSent: true, status: () => res, send: () => res, json: () => res, sendStatus: () => res };

      // One inbound text is handled once, however many times it's delivered.
      const handle: unknown = req.body?.message_handle;
      if (typeof handle === "string" && handle && !req.body?.is_outbound && req.body?.type !== "typing") {
        const fresh = await pool
          .query(`INSERT INTO inbound_webhook_handles (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING RETURNING handle`, [handle])
          .then((r) => r.rows.length > 0)
          .catch(() => true);
        if (!fresh) {
          await recordDecision({
            layer: 2,
            decision: "turn.duplicate",
            userId: null,
            outcome: "skip",
            action: "redelivery",
            checks: [{ name: "same_message_handle", pass: false, reason: "Sendblue delivered this text again" }],
          }).catch(() => {});
          return;
        }
        // Keep what arrived until the turn finishes (2026-09-17 code review:
        // a restart mid-turn lost the message, since the ack and this handle
        // row come before any work). Best effort: needs the payload and
        // finished_at columns; see reportUnfinishedTurns below.
        pool
          .query(`UPDATE inbound_webhook_handles SET payload = $2::jsonb WHERE handle = $1`, [handle, JSON.stringify(req.body ?? {})])
          .catch(() => {});
      }

      // Stamped here, before withPhoneLock, not inside run() below. Once a
      // phone's advisory lock is held, a second inbound message for that
      // same phone can't run ANY code — including this very stamp — until
      // the first message's run() has finished and released the lock. If
      // this write lived inside run(), a message that arrived during the
      // first request's debounce wait would be queued behind that same
      // lock and could never become visible during the wait. Stamping out
      // here, ahead of the lock, decouples "record that a message arrived"
      // from "wait in line to be processed."
      const turnStartedAt = new Date();
      let myInboundAt: string | null = null;
      const bodyForStamp = req.body ?? {};
      if (lockKey && !bodyForStamp.is_outbound && typeof bodyForStamp.content === "string") {
        bodyForStamp.content = await claimTextLogin(lockKey, bodyForStamp.content);
      }
      const isGenuineInbound =
        bodyForStamp.type !== "typing" &&
        !bodyForStamp.is_outbound &&
        ((typeof bodyForStamp.content === "string" && bodyForStamp.content.trim().length > 0) ||
          (typeof bodyForStamp.media_url === "string" && bodyForStamp.media_url.length > 0));
      // Read receipt right away for a real 1:1 inbound text (not groups, not
      // Co's own delivery updates), before debounce or reply work.
      if (lockKey && isGenuineInbound && bodyForStamp.message_type !== "group" && !bodyForStamp.group_id) {
        markRead(lockKey).catch(() => {});
        // They texted: Co's run of unprompted texts starts over (sendLimiter.ts).
        sendLimiter.noteInbound(lockKey);
      }
      // Group messages never stamp the 1:1 debounce (2026-09-17 code review:
      // a group text from someone mid-turn in their 1:1 thread cancelled
      // that reply, though the group message never gets a 1:1 reply itself).
      const isGroupMessage = bodyForStamp.message_type === "group" || !!bodyForStamp.group_id;
      if (lockKey && isGenuineInbound && !isGroupMessage) {
        try {
          const stampResult = await pool.query(
            `INSERT INTO phone_debounce (phone, last_inbound_at) VALUES ($1, NOW())
             ON CONFLICT (phone) DO UPDATE SET last_inbound_at = NOW()
             RETURNING last_inbound_at`,
            [lockKey],
          );
          myInboundAt = stampResult.rows[0].last_inbound_at;
        } catch (err: any) {
          // Fail open — if the stamp can't be written, just skip the
          // debounce for this request rather than blocking or crashing on
          // what is a UX nicety, not a correctness requirement.
          console.error("sendblue: phone_debounce stamp failed (non-fatal, debounce skipped):", err?.message ?? err);
          myInboundAt = null;
        }
      }

      const run = async () => {
      try {
        const {
          number,
          content,
          media_url,
          is_outbound,
          status,
          error_code,
          error_message,
          type,
          group_id,
          message_type,
        } = req.body;

        // Group messages are acknowledged and ignored. Co never joins or
        // starts a group text (Sendblue can only reply to a number that has
        // already texted in, so it can't start one, and 2026-09-20 Royce took
        // group chats out of the product), and a group message must never be
        // treated as a personal 1:1 turn.
        if (message_type === "group" || group_id) {
          return res.status(200).send({ received: true });
        }

        // Handle typing indicators
        if (type === "typing") {
          const userResult = await pool.query(
            `SELECT id FROM users WHERE phone_number = $1`,
            [number],
          );
          const user = userResult.rows[0];
          if (user) {
            io.to(`user:${user.id}`).emit("co:user_typing", { number });
          }
          return res.status(200).send({ received: true });
        }

        // Handle outbound delivery status
        if (is_outbound) {
          if (status === "ERROR") {
            console.error(
              `Message to ${number} failed: ${error_code} — ${error_message}`,
            );
            const userResult = await pool.query(
              `SELECT id FROM users WHERE phone_number = $1`,
              [number],
            );
            const user = userResult.rows[0];
            if (user) {
              const delivErrContent = `Co message failed to deliver: ${error_code} — ${error_message}`;
              const delivErrMemory = await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content)
                 VALUES ($1, 'text_exchange', $2) RETURNING id`,
                [user.id, delivErrContent],
              );
              generateEmbedding(delivErrContent)
                .then((emb) =>
                  pool.query(
                    `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                    [`[${emb.join(",")}]`, delivErrMemory.rows[0].id],
                  ),
                )
                .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
            }
          }
          return res.status(200).send({ received: true });
        }

        // Inbound — require phone number and at least one of: text content or media
        const hasText = typeof content === "string" && content.trim().length > 0;
        const hasMedia = typeof media_url === "string" && media_url.length > 0;

        if (!number || (!hasText && !hasMedia)) {
          return res.status(400).send("Missing required fields.");
        }

        // A malformed inbound `number` (confirmed: Sendblue can deliver one,
        // e.g. a bare 5-digit value) was flowing straight through to a real,
        // billed sendSMS call via findOrCreateUserByPhone below — nothing on
        // this path validated shape before either creating a user row or
        // sending. Reject before either happens.
        if (!parsePhoneNumberFromString(number, "US")?.isValid()) {
          console.error(`sendblue webhook: malformed inbound number "${number}" — ignoring`);
          return res.status(200).send({ received: true });
        }

        // Step 1 — Find user by phone number, creating a bare placeholder row
        // if this number has never texted in before. CoPatible no longer
        // collects name/email through a separate form (Framer or otherwise)
        // ahead of time — the conversation with Co itself is the intake now,
        // so an unknown number can't just be dropped the way it used to be.
        let user = await findOrCreateUserByPhone(number);

        // STOP/START handling — checked before anything else (intake,
        // duplicate/debounce, the real reply) so it works regardless of
        // account state, and short-circuits everything below for an
        // opted-out user except START/UNSTOP itself.
        if (hasText && isOptOutKeyword(content)) {
          await pool.query(`UPDATE users SET sms_opted_out = true WHERE id = $1`, [user.id]);
          try {
            await sendblue.messages.send({
              number,
              content: "You've been unsubscribed and won't receive further messages or calls from Co. Text START to resubscribe.",
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (err: any) {
            console.error("sendblue webhook: opt-out confirmation send failed (non-fatal):", err?.message ?? err);
          }
          return res.status(200).send({ received: true, action: "opted_out" });
        }
        if (hasText && isOptInKeyword(content)) {
          await pool.query(`UPDATE users SET sms_opted_out = false WHERE id = $1`, [user.id]);
          try {
            await sendblue.messages.send({
              number,
              content: "You're resubscribed — welcome back.",
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (err: any) {
            console.error("sendblue webhook: opt-in confirmation send failed (non-fatal):", err?.message ?? err);
          }
          return res.status(200).send({ received: true, action: "opted_in" });
        }
        if (user.sms_opted_out) {
          return res.status(200).send({ received: true, action: "opted_out_ignored" });
        }

        // Co Loop Stage 5 extension — response-rate tracking. Any inbound
        // message counts as a response to a pending check-in, regardless of
        // content or which branch below ends up handling it — this only
        // measures engagement, not resolution (that's Stage 6's job via
        // assessResolvedItems). Fire-and-forget, non-blocking.
        pool
          .query(
            `UPDATE ask_checkins
             SET responded_count = responded_count + 1, awaiting_response_since = NULL, last_response_at = NOW()
             WHERE user_id = $1 AND awaiting_response_since IS NOT NULL`,
            [user.id],
          )
          .catch((err: any) => console.error("ask_checkins response tracking failed (non-fatal):", err?.message ?? err));

        // Day-of QR check-in (Royce, 2026-09-10) — detected before the
        // brand-new-contact intake branch below, which returns early: a
        // walk-in's very first-ever message to Co can BE the check-in text
        // itself, and the row needs to exist regardless of whether identity
        // capture has happened yet. Fire-and-forget on the write; never let
        // this block or fail the real reply below.
        let walkinCheckinEventName: string | null = null;
        if (hasText) {
          const checkin = await detectCheckinPhrase(content).catch((err: any) => {
            console.error("sendblue: detectCheckinPhrase failed (non-fatal):", err?.message ?? err);
            return null;
          });
          if (checkin) {
            await recordCheckin(checkin.eventApiId, user.id).catch((err: any) =>
              console.error("sendblue: recordCheckin failed (non-fatal):", err?.message ?? err),
            );
            walkinCheckinEventName = checkin.eventName;
          }
          // A member saying they've arrived is Co's call now
          // (conversationTools.ts markArrived, 2026-09-25).
        }

        // Step 1.1 — Invite code gate for a brand-new contact. Co is
        // referral-only (2026-09-17, Royce: "we're trying to grow so large
        // that we make a secret network" — density and fit over open
        // signup volume). Checked before identity intake so an unverified
        // number never starts the name/email flow. Every pre-existing row
        // has invite_verified defaulted true (migrations.ts), so this only
        // ever applies to a genuinely brand-new placeholder row.
        // Set once the "You're in" welcome goes out, so intake doesn't greet
        // twice, and once their message is logged, so it isn't logged twice.
        let welcomedThisTurn = false;
        let loggedInboundThisTurn = false;
        if (!user.invite_verified) {
          // Even on the very first-ever message, try it as a code first
          // (2026-09-17: a website deep link pre-fills the code as the
          // first message someone sends — a real invite flow, not just a
          // casual "hey", so waiting to ask would make them send it twice).
          // Only falls through to the plain "what's your code?" ask when
          // the first message ISN'T a real code, so a genuine cold "hey"
          // still gets asked rather than told a code was wrong.
          if (hasText) {
            const firstTryRedeemed = await redeemInviteCodeIn(content, user.id);
            if (firstTryRedeemed.ok) {
              await logTextExchange(user.id, `User said: ${content}`);
              loggedInboundThisTurn = true;
              await pool.query(`UPDATE users SET invite_verified = true, invite_asked = true WHERE id = $1`, [user.id]);
              user = { ...user, invite_verified: true, invite_asked: true };
              welcomedThisTurn = await welcomeLineFor(user.id, number, firstTryRedeemed.createdBy);
              // Falls through below into normal identity intake, same turn.
            }
          }
        }
        if (!user.invite_verified) {
          // Never answer an automated sender, and never send one number more
          // than a few gate replies a day (services/gateGuard.ts).
          const gateDecision = decideGateReply({ text: hasText ? content : "", recentGateReplies: await countRecentGateReplies(user.id) });
          if (gateDecision !== "send") {
            if (hasText) await logTextExchange(user.id, `User said: ${content}`);
            // An automated sender is blocked in Sendblue so it can't come back
            // (2026-09-24). Only ever before a number is verified.
            const blocked = gateDecision === "silent_automated" ? await blockSender(number) : false;
            await recordDecision({ layer: 2, decision: "gate.silent", userId: user.id, outcome: "skip", action: gateDecision, proposal: { message: hasText ? content.slice(0, 200) : null, blocked } });
            return res.status(200).send({ received: true, action: gateDecision });
          }
          if (!user.invite_asked) {
            // First contact ever from an unverified number, and it wasn't
            // a valid code — ask for one. Nothing in this inbound message
            // is treated as a failed code attempt (same "don't parse the
            // greeting as an answer" shape as the intake_asked branch below).
            if (hasText) await logTextExchange(user.id, `User said: ${content}`);
            await pool.query(`UPDATE users SET invite_asked = true WHERE id = $1`, [user.id]);
            // Who Co is, then the code (2026-09-19: a bare "Co is invite-only
            // right now" was the first thing anyone saw). services/onboardingLines.ts.
            await sendAndLog(user.id, number, pickLine(GATE_ASK));
            return res.status(200).send({ received: true, action: "invite_code_requested" });
          }

          await logTextExchange(
            user.id,
            hasText ? `User said: ${content}` : "User sent a photo or voice memo (invite code expected)",
          );
          loggedInboundThisTurn = true;
          const redeemed = hasText ? await redeemInviteCodeIn(content, user.id) : { ok: false as const, createdBy: null };
          if (redeemed.ok) {
            await pool.query(`UPDATE users SET invite_verified = true WHERE id = $1`, [user.id]);
            // Reflected locally so the SAME turn falls through into real
            // identity intake below instead of making them text again.
            user = { ...user, invite_verified: true };
            welcomedThisTurn = await welcomeLineFor(user.id, number, redeemed.createdBy);
          } else {
            await sendAndLog(user.id, number, pickLine(WRONG_CODE));
            return res.status(200).send({ received: true, action: "invite_code_rejected" });
          }
        }

        // Texts for an extension (services/extensions.ts), like Mo's team
        // (src/mo/): only from teammates, and only when the extension reads
        // the text as meant for it. Anything else falls through to a normal
        // reply. Not logged as conversation, so it never reaches their own
        // threads.
        if (hasText && user.identity_captured) {
          // They pressed Reply on an extension's own text (Mo's "So on
          // Harneet…"): it goes to that extension, whatever it says
          // (2026-09-28: Co answered it instead).
          const pressed = req.body?.thread_originator?.message_handle ?? req.body?.reply_to?.message_handle;
          const repliedToExt = pressed ? await extensionForMessage(user.id, pressed).catch(() => null) : null;
          const teamHandle = typeof req.body?.message_handle === "string" ? req.body.message_handle : null;
          const teamAck = teamHandle ? (emoji: string) => sendReaction(teamHandle, emoji) : undefined;
          const ext = await handleTeamText(user.id, content, { ...(repliedToExt ? { repliedTo: repliedToExt.content, only: repliedToExt.id } : {}), ack: teamAck }).catch((err: any) => {
            console.error("sendblue: extension reply failed:", err?.message ?? err);
            return null;
          });
          if (repliedToExt) {
            recordDecision({ layer: 2, decision: "team.inlineToExtension", userId: user.id, outcome: ext ? "act" : "skip", action: repliedToExt.id }).catch(() => {});
          }
          if (ext !== null) {
            // Their message to Mo goes in the thread too, marked as said to Mo,
            // so Co can see the whole conversation (services/sendblue.ts
            // logs Mo's replies).
            if (hasText) await logTextExchange(user.id, `User said: ${content} [to ${ext.extension === "mo" ? "Mo" : ext.extension}]`).catch(() => {});
            if (ext.reply) {
              // Recorded as the extension's own text, so a reply under it comes back to it.
              await sendingAs(ext.extension, () => sendblue.messages.send({ number, content: ext.reply, from_number: process.env.SENDBLUE_PHONE_NUMBER! })).catch((err: any) =>
                console.error(`sendblue: ${ext.extension} reply send failed:`, err?.message ?? err),
              );
            }
            return res.status(200).send({ received: true, action: `${ext.extension}_reply` });
          }
        }

        // Changing their phone number (services/phoneChange.ts): handled here,
        // start to finish, before anything else reads the message.
        if (hasText && user.identity_captured) {
          const phoneChangeReply = await handlePhoneChange(
            { id: user.id, phone_number: number, email: user.email ?? null, first_name: user.first_name ?? null },
            content,
          ).catch((err: any) => {
            console.error("sendblue: phone change failed (non-fatal):", err?.message ?? err);
            return null;
          });
          if (phoneChangeReply) {
            await logTextExchange(user.id, `User said: ${content}`);
            await sendAndLog(user.id, number, phoneChangeReply);
            return res.status(200).send({ received: true, action: "phone_change" });
          }
        }

        // Step 1.2 — Name/email intake for a brand-new contact. Gated on
        // identity_captured, not on user existence — the placeholder row
        // from findOrCreateUserByPhone above already exists by this point.
        // Texting in from their own number is itself proof of phone
        // ownership, so unlike Step 1.5 below there's no separate OTP here.
        if (!user.identity_captured) {
          if (!user.intake_asked) {
            // First contact ever from this number — greet, then ask. Nothing
            // in this inbound message is treated as an answer, since Co
            // hasn't asked the question yet.
            if (hasText && !loggedInboundThisTurn) await logTextExchange(user.id, `User said: ${content}`);
            await pool.query(`UPDATE users SET intake_asked = true WHERE id = $1`, [user.id]);
            // Onboarding lines are logged like any Co message, so the
            // conversation and the morning review can see them (they weren't).
            const onboardingSends = [
              ...(welcomedThisTurn ? [] : [{ phone_number: number, welcome: true }]),
              { phone_number: number, intro: true },
              // Contact card (Royce, 2026-09-14): otpActions.ts has always had
              // a save_contact send with the vCard attached, but nothing ever
              // called it, so new people never got Co saved in their phone.
              { phone_number: number, save_contact: true },
              { phone_number: number, intake_ask: true },
            ];
            for (const params of onboardingSends) {
              const result = await sendSMS(params);
              for (const text of result.sent) await logTextExchange(user.id, `Co replied: ${text}`);
            }
            return res.status(200).send({ received: true, action: "intake_started" });
          }

          await logTextExchange(
            user.id,
            hasText ? `User said: ${content}` : "User sent a photo or voice memo (name/email intake)",
          );

          // Layer 1 harness (src/harness/intake.ts): the model only proposes
          // name/email; code decides whether to capture, hold a partial
          // email, or ask, and never re-asks for something already on file.
          const intakeState = await gatherIntakeState(user);
          let extracted: IntakeProposal = { full_name: null, email: null };
          try {
            const { text: rawExtraction } = await generateText({
              model: anthropic(INTAKE_EXTRACT_MODEL),
              experimental_telemetry: { isEnabled: true, functionId: "sendblue.intake.extractIdentity" },
              prompt: buildIntakeExtractionPrompt(intakeState, hasText ? content : null),
            });
            extracted = parseIntakeProposal(rawExtraction);
          } catch (err: any) {
            console.error("sendblue intake: identity extraction failed (non-fatal, asking again):", err?.message ?? err);
          }

          const proposedEmail = extracted.email?.trim() || null;
          const emailTaken = isValidEmail(proposedEmail) ? await isEmailOnOtherAccount(proposedEmail, user.id) : false;
          let intake = decideIntake(intakeState, extracted, {
            emailTakenByOtherAccount: emailTaken,
            replyText: hasText ? content : null,
          });

          if (intake.action === "capture") {
            const { first_name, last_name } = splitFullName(intake.name!);
            const captureIdentity = (username: string) =>
              pool.query(
                `UPDATE users SET first_name = $2, last_name = $3, email = $4, username = $5, identity_captured = true,
                   intake_partial_email = NULL, intake_retries = 0
                 WHERE id = $1 RETURNING *`,
                [user.id, first_name, last_name, intake.email, username],
              );
            const localPart = intake.email!.split("@")[0];
            try {
              let updated;
              try {
                updated = await captureIdentity(localPart);
              } catch (err: any) {
                // usernames are UNIQUE too; two people can share an email
                // local part, which isn't an email conflict at all.
                if (err?.code !== "23505" || !String(err?.constraint ?? "").includes("username")) throw err;
                updated = await captureIdentity(`${localPart}_${user.id.slice(0, 6)}`);
              }
              user = updated.rows[0];
            } catch (err: any) {
              if (err?.code !== "23505") throw err;
              // Lost a race with another account for the same email (or a
              // held partial email was taken since): drop it and ask again.
              intake = decideIntake(
                { ...intakeState, knownName: intake.name, partialEmail: null, knownEmail: null },
                { full_name: intake.name, email: intake.email },
                { emailTakenByOtherAccount: true },
              );
            }
          }

          await recordDecision({
            layer: 1,
            decision: "intake.identity",
            userId: user.id,
            outcome: intake.outcome,
            action: intake.action,
            proposal: extracted,
            checks: intake.checks,
            reason: intake.reason,
          });

          if (intake.action === "capture") {
            const first_name = user.first_name;
            // Last step of onboarding: ask whether they'd rather text or talk
            // (Royce, 2026-09-16: "We don't ask the user if they would prefer
            // a call or text"). Recorded as a pending call offer, so their
            // answer goes through the same router and call gates as any other
            // call offer: "call me" places a call, "text is fine" keeps texting.
            // The first call offer, from the approved lines (Royce,
            // 2026-09-19, after Boardy's "quick 5-minute call" offer): why the
            // call matters for the room, now or a time, texting still fine.
            // Recorded as a pending call offer only once it really went out
            // (2026-09-17 code review: a refused send still recorded it, so a
            // later "yeah" could accept a call they were never offered).
            const kickoffMsg = (
              await lineInVoice({
                purpose: "Right after they gave their name and email: offer a quick five-minute call to get to know them, now or at a time they pick, and make clear texting is fine too.",
                facts: [
                  `Their first name is ${first_name ?? "unknown"}.`,
                  "A quick 5-minute call helps Co know who to introduce them to when they're in the room at Co events.",
                  "They can take the call now, pick a time, or keep texting.",
                ],
                examples: CALL_OFFER.map((l) => l.replace("{name}", first_name ?? "there")),
                mustInclude: first_name ? [first_name] : [],
                fallback: pickLine(CALL_OFFER, { name: first_name }),
              })
            ).text;
            let askedKickoff: string | null = null;
            if (await sendAndLog(user.id, number, kickoffMsg)) askedKickoff = kickoffMsg;
            if (askedKickoff) {
              await pool
                .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_pending', $2)`, [
                  user.id,
                  `${ONBOARDING_CALL_OFFER_PREFIX} Asked whether they'd rather keep texting or take a quick call to get started | Co offered: ${askedKickoff}`,
                ])
                .catch((err: any) => console.error("sendblue: onboarding call-or-text offer write failed (non-fatal):", err?.message ?? err));
            }
            // They came in on a member's invite: tell that member, once.
            await tellInviterTheyJoined(user).catch((err: any) =>
              console.error("sendblue: invite joined note failed (non-fatal):", err?.message ?? err),
            );
            return res.status(200).send({ received: true, action: "identity_captured" });
          }

          const nameChanged = intake.name && intake.name !== intakeState.knownName;
          const nameParts = intake.name ? splitFullName(intake.name) : null;
          await pool.query(
            `UPDATE users SET
               first_name = COALESCE($2, first_name),
               last_name = COALESCE($3, last_name),
               intake_partial_email = COALESCE($4, intake_partial_email),
               intake_retries = intake_retries + 1
             WHERE id = $1`,
            [user.id, nameChanged ? nameParts!.first_name : null, nameChanged ? nameParts!.last_name : null, intake.savePartialEmail],
          );
          const missingReply = intake.reply!;
          await sendAndLog(user.id, number, missingReply);
          return res.status(200).send({ received: true, action: "intake_incomplete" });
        }

        // Step 1.5 — First contact from an unverified self-serve registration.
        // Our Sendblue plan only allows replying to contacts who've texted in
        // first, so the OTP couldn't be sent at registration time. This is
        // that first inbound text — mark verified and send the OTP now as a
        // reply, which the plan permits. Nothing else in this handler applies
        // to a user who hasn't completed signup yet, so return early.
        if (!user.contact_verified) {
          const otp = randomInt(100000, 1000000);
          const expiryTimeStamp = new Date(Date.now() + 300000).toISOString();

          await pool.query(
            `UPDATE users SET contact_verified = true, otp_code = $2, otp_expiry = $3 WHERE id = $1`,
            [user.id, otp, expiryTimeStamp],
          );

          // Three-message introduction: welcome, then what CoPatible is (with
          // the contact card attached), then the verification code — so the
          // code doesn't land as a bare 6-digit text from an unknown number.
          await sendSMS({ phone_number: user.phone_number, welcome: true });
          await sendSMS({ phone_number: user.phone_number, intro: true });
          await sendSMS({ phone_number: user.phone_number, save_contact: true });
          await sendSMS({
            phone_number: user.phone_number,
            otp_code: otp.toString(),
            register: true,
          });

          return res.status(200).send({ received: true, action: "contact_verified" });
        }

        // Step 2 — Detect if inbound is a voice memo; if so, transcribe it.
        // If it's an image, download it for the vision-enabled reply below.
        // Co matches energy: voice in → voice out, text in → text out
        let resolvedContent = content ?? "";
        // Which text they long-pressed and replied to, if any (services/inlineReply.ts).
        // A bare event link is described as the event, from Co's action record.
        const repliedToP = repliedTo(req.body, number).then(async (r) => {
          const link = r?.fromCo ? bareLink(r.text) : null;
          if (!r || !link) return r;
          const { rows } = await pool
            .query(`SELECT object_label FROM co_facts WHERE owner_user_id = (SELECT id FROM users WHERE phone_number = $1 LIMIT 1) AND (url = $2 OR object_label LIKE $2 || '%') ORDER BY happened_at DESC LIMIT 1`, [number, link])
            .catch(() => ({ rows: [] as any[] }));
          const label = String(rows[0]?.object_label ?? "").replace(link, "").trim();
          return label ? { ...r, what: label } : r;
        });
        let isVoice = false;
        let imageForVision: { data: Buffer; mediaType: string } | null = null;
        let photoDescription: string | null = null;

        if (hasMedia) {
          isVoice = await isAudioUrl(media_url);
          if (isVoice) {
            try {
              resolvedContent = await transcribeVoiceMemo(media_url);
              console.log(`Transcribed voice memo from ${number}: "${resolvedContent}"`);
            } catch (transcribeErr: any) {
              console.error("Voice memo transcription failed:", transcribeErr?.message ?? transcribeErr);
              // Fall back to treating as a media message with no text content
              resolvedContent = "[voice memo]";
            }
          } else {
            try {
              const imageRes = await fetch(media_url, { signal: AbortSignal.timeout(10000) });
              if (!imageRes.ok) throw new Error(`Image fetch failed: ${imageRes.status}`);
              const mediaType = imageRes.headers.get("content-type")?.split(";")[0].trim() ?? "image/jpeg";
              const buffer = Buffer.from(await imageRes.arrayBuffer());
              imageForVision = { data: buffer, mediaType };
              // Written down once, for the record and the reply's fact check
              // (services/imageRead.ts, 2026-09-22).
              photoDescription = await describeImage(buffer, mediaType);
              if (!resolvedContent) resolvedContent = photoDescription ? `[sent a photo showing: ${photoDescription}]` : "[sent a photo]";
            } catch (imgErr: any) {
              console.error("Image fetch for vision failed (non-fatal):", imgErr?.message ?? imgErr);
              if (!resolvedContent) resolvedContent = "[sent a photo — couldn't load it]";
            }
          }
        }

        // Step 3 — Store inbound message, generate embedding (in parallel)
        // Which text they replied to stays with their message, so later turns
        // still know what "I'm in" was about (services/inlineReply.ts).
        const inlineTarget = await repliedToP;
        let dotsP: Promise<Moment | null> | null = null;
        // The one picture of this turn (services/turnContext.ts): what Co sent
        // with its details, open asks and threads, feelings, lessons from past
        // pushback, the reply target and the record. Started once the recent
        // conversation is read; everything below reads from it.
        let turnP: Promise<TurnContext> | null = null;
        let turn: TurnContext | null = null;
        const askedAndDoing = async () => {
          const t = turnP ? await turnP.catch(() => null) : null;
          return t ? { asks: t.asks.map((a) => a.text), threads: t.threads } : { asks: [] as string[], threads: [] as { text: string; feeling: string | null }[] };
        };
        // Reacting to something Co sent: the reply ties back to their why.
        let reactingToSent = !!inlineTarget?.fromCo && (!!inlineTarget.what || !!bareLink(inlineTarget.text));
        const inboundContent = isVoice
          ? `User sent a voice memo: ${resolvedContent}${inlineTarget ? ` ${inlineNote(inlineTarget)}` : ""}`
          : `User said: ${resolvedContent}${hasText && imageForVision ? ` [They also sent a photo${photoDescription ? `. It shows: ${photoDescription}` : ""}]` : ""}${inlineTarget ? ` ${inlineNote(inlineTarget)}` : ""}`;

        // A link they texted is read in the background, kept to them (services/linkReader.ts).
        // The first one is also read for this reply (raced below), so Co can react to what the page says.
        // A link and its preview photo can arrive as two texts, with the reply
        // answering the second (2026-09-29: Co described the photo and never
        // used the X post it was read from). So a link in their unanswered
        // texts from the last few minutes counts too.
        let theirLink = hasText ? linksIn(resolvedContent)[0] ?? null : null;
        let linkFromEarlier = false;
        if (!theirLink) {
          const earlier = await pool
            .query(
              `SELECT content FROM co_memories
               WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > NOW() - INTERVAL '3 minutes'
                 AND created_at > COALESCE((SELECT MAX(created_at) FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'Co replied:%'), 'epoch')
               ORDER BY created_at DESC LIMIT 4`,
              [user.id],
            )
            .then((r) => r.rows.map((x: any) => String(x.content)))
            .catch(() => [] as string[]);
          const m = mergeEarlierLink(resolvedContent, hasText, earlier);
          theirLink = m.link;
          linkFromEarlier = m.fromEarlier;
          // The photo-only message now reads with its link, so the reply is about the page.
          if (m.fromEarlier && !hasText) resolvedContent = m.merged;
        }
        const theirLinkP: Promise<LinkRead | null> | null = theirLink
          ? import("../services/linkReader.js").then((l) => l.readLink(theirLink, { ownerUserId: user.id })).catch(() => null)
          : null;
        // "Stop sharing" ends location use for their events at once, before any reply
        // (services/preArrival.ts). A bare STOP already opted them out of everything above.
        if (hasText) {
          const P = await import("../services/preArrival.js");
          if (P.isStopSharing(resolvedContent)) await P.stopSharing(user.id).catch(() => 0);
        }
        // They texted after one of Co's tasks texted them: that task wakes in a few
        // minutes, once this reply is out, instead of at its next scheduled look
        // (services/coTasks.ts wakeOnReply). The 15-minute job is the backstop.
        if (hasText)
          import("../services/coTasks.js")
            .then(async (T) => {
              const woke = await T.wakeOnReply(user.id);
              if (woke) setTimeout(() => import("../services/taskTurn.js").then((t) => t.runDueTasks()).catch(() => {}), (T.TASK_LIMITS.wakeAfterReplyMinutes * 60 + 15) * 1000);
            })
            .catch(() => {});
        if (hasText && linksIn(resolvedContent).length) import("../services/linkReader.js").then((l) => l.readLinksLater(resolvedContent, { ownerUserId: user.id })).catch(() => {});
        const [inboundMemory, queryEmbedding] = await Promise.all([
          pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'text_exchange', $2) RETURNING id`,
            [user.id, inboundContent],
          ),
          generateEmbedding(inboundContent).catch((err) => {
            console.error("Inbound embedding failed (non-fatal):", err);
            return null;
          }),
        ]);

        // Same text sent again within a couple of minutes (confirmed live:
        // people resend when a reply is slow). The reply agent is told so it
        // answers once instead of treating each copy as a new message.
        let repeatContext = "";
        if (hasText) {
          const repeats = await pool
            .query(
              `SELECT COUNT(*)::int AS n FROM co_memories
               WHERE user_id = $1 AND memory_type = 'text_exchange' AND content = $2
                 AND id <> $3 AND created_at > NOW() - INTERVAL '2 minutes'`,
              [user.id, inboundContent, inboundMemory.rows[0].id],
            )
            .then((r) => r.rows[0]?.n ?? 0)
            .catch(() => 0);
          if (repeats > 0) {
            repeatContext = `\nThey've sent this exact message ${repeats + 1} times in the last couple of minutes, probably because your reply felt slow. Answer it once, as a single reply. Don't treat it as new, and don't point out that they repeated it.`;
          }
          // A copy sent while Co was still working on the same message (no
          // Co reply between the earlier copy and this one's arrival) gets
          // no second pass: the first one's search and reply cover it
          // (2026-09-15: five copies each re-ran routing and the paid search).
          // Only when that earlier turn really answered, after this copy
          // arrived (2026-09-17 code review: the earlier copy's turn could
          // bail at the debounce or crash, and this copy was then skipped
          // too, so the person got no reply at all). Turns for one phone run
          // one at a time, so the earlier turn has finished by now.
          if (repeats > 0 && myInboundAt) {
            const resentWhileWaiting = await pool
              .query(
                `SELECT 1 FROM co_memories earlier
                 WHERE earlier.user_id = $1 AND earlier.memory_type = 'text_exchange' AND earlier.content = $2
                   AND earlier.id <> $3 AND earlier.created_at > $4::timestamptz - INTERVAL '3 minutes' AND earlier.created_at < $4::timestamptz
                   AND NOT EXISTS (
                     SELECT 1 FROM co_memories reply
                     WHERE reply.user_id = $1 AND reply.memory_type = 'text_exchange' AND reply.content LIKE 'Co replied:%'
                       AND reply.created_at > earlier.created_at AND reply.created_at < $4::timestamptz
                       AND reply.content <> ALL($5::text[])
                   )
                   AND EXISTS (
                     SELECT 1 FROM co_memories answered
                     WHERE answered.user_id = $1 AND answered.memory_type = 'text_exchange' AND answered.content LIKE 'Co replied:%'
                       AND answered.created_at >= $4::timestamptz
                       AND answered.content <> ALL($5::text[])
                   )
                 LIMIT 1`,
                [user.id, inboundContent, inboundMemory.rows[0].id, myInboundAt, HOLD_LINES.map((l) => `Co replied: ${l}`)],
              )
              .then((r) => r.rows.length > 0)
              .catch(() => false);
            if (resentWhileWaiting) {
              await recordDecision({
                layer: 2,
                decision: "turn.duplicate",
                userId: user.id,
                outcome: "skip",
                action: "no_second_pass",
                checks: [{ name: "resent_while_waiting", pass: false, reason: "same text already handled and answered after this copy arrived" }],
                proposal: { message: resolvedContent, copies: repeats + 1 },
              });
              return res.status(200).send({ received: true, action: "duplicate_while_processing" });
            }
          }
        }

        if (queryEmbedding) {
          pool
            .query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${queryEmbedding.join(",")}]`, inboundMemory.rows[0].id],
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
        }

        // Step 4.5 — Show the animated "..." on the user's device while Co
        // "thinks" — the Claude call below can take a few seconds, and a bare
        // gap before the reply lands reads as broken rather than considered.
        // Non-fatal: a failed typing indicator should never block the reply.
        // Not awaited: the dots are a courtesy, not a step the reply waits on.
        sendblue.typingIndicators
          .send({ number: user.phone_number, from_number: process.env.SENDBLUE_PHONE_NUMBER! })
          .catch((typingErr: any) => console.error("Typing indicator failed (non-fatal):", typingErr?.message ?? typingErr));

        // Step 4.6 — Call-trigger detection. Two cases, per explicit product
        // decision: an explicit ask ("call me") triggers immediately;
        // anything that only SIGNALS voice would help gets OFFERED, and
        // actually placing that call requires a following "yes" — never
        // silently placed. Must compare timestamps, not just existence of a
        // pending offer, or a later unrelated "yeah" could get misread as
        // consenting to a call that was already resolved.
        // Moved up from the old "Step 5" position — the call-offer/schedule
        // classifier below needs the actual conversation thread (a time
        // given in one message and a timezone confirmed in a later one is
        // still a single schedule request), not just this message alone.
        //
        // Bug fix, 2026-09-01 (Royce, diagnosing a real memory-continuity
        // gap live with Co — see callContext.ts's buildContextSummary for
        // the fuller writeup): 8 rows is only 4 conversational turns. A
        // longer real exchange (exactly the kind where continuity matters
        // most) could already be losing its own early turns to this same
        // window mid-conversation, on top of the separate cross-conversation
        // gap buildContextSummary had. Raised to 10 turns' worth; safe for
        // deriveStyleHint below too, which only gets more representative
        // (not worse) with a bigger sample of someone's normal texting style.
        const chronologicalResult = await pool.query(
          `SELECT content, created_at FROM co_memories
           WHERE user_id = $1 AND memory_type = 'text_exchange'
           ORDER BY created_at DESC
           LIMIT 20`,
          [user.id],
        );
        const chronologicalRows = chronologicalResult.rows.reverse();
        const recentConversation = annotateConversationGaps(chronologicalRows);
        if (hasText) {
          turnP = assembleContext(user.id, resolvedContent, {
            inlineTarget,
            ledgerContext: `${inlineTarget ? `${inlineTarget.text}\n` : ""}${recentConversation.split("\n").filter((l) => l.startsWith("Co replied:")).slice(-3).join("\n")}`,
          });
          turnP.catch(() => {});
        }
        const styleHint = deriveStyleHint(chronologicalRows);

        // Emotion loop (harness/emotion.ts): read how this message feels in
        // the context of the conversation, record it, then load the shared
        // picture (this text, recent calls, what keeps coming up) that the
        // reply reasons from. Alongside: whether they want to be heard or
        // helped toward an answer.
        // Latency (2026-09-26): nothing before the router needs these reads,
        // so they run alongside it (and the context reads below) instead of
        // ahead of it; they're awaited once the router is done.
        // One read of the moment replaces these, the router's read, the
        // coverage check, the moment read and the feedback filter
        // (services/readTurn.ts); READ_TURN=off runs them separately as before.
        const oneRead = hasText && readTurnEnabled();
        const seekingAndEmotion = hasText && !oneRead
          ? Promise.all([
              detectSeekingMode(resolvedContent, recentConversation, "sendblue.detectSeekingMode"),
              readTextEmotion(resolvedContent, recentConversation, "sendblue.readTextEmotion"),
            ])
          : Promise.resolve([null, null] as const);

        // These reads don't depend on each other, so they run together.
        const [pendingOfferResult, pendingWalkinCheckinResult, [profileResult, activityCountResult], declinedTopicsResult, openItems] = await Promise.all([
          pool.query(
            `SELECT p.id, p.content, p.created_at FROM co_memories p
           WHERE p.user_id = $1 AND p.memory_type = 'call_offer_pending'
           AND p.created_at > NOW() - ($2 || ' days')::interval
           AND NOT EXISTS (
             SELECT 1 FROM co_memories r
             WHERE r.user_id = $1 AND r.memory_type = 'call_offer_resolved' AND r.created_at > p.created_at
           )
           ORDER BY p.created_at DESC LIMIT 1`,
            [user.id, CALL_OFFER_EXPIRY_DAYS],
          ),
          pool.query(
            `SELECT event_api_id FROM event_walkin_checkins
           WHERE person_id = $1 AND ask_text IS NULL
             AND checked_in_at > NOW() - INTERVAL '1 day'
           ORDER BY checked_in_at DESC LIMIT 1`,
            [user.id],
          ),
          Promise.all([
            pool.query(
              `SELECT life_chapters, goals, blockers, long_term_direction, city, topics_covered, topics_asked
             FROM co_profiles WHERE user_id = $1`,
              [user.id],
            ),
            pool.query(
              `SELECT count(*) FROM co_memories WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript')`,
              [user.id],
            ),
          ]),
          pool.query(
            `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_declined_topic' ORDER BY created_at DESC LIMIT 20`,
            [user.id],
          ),
          gatherOpenItems(user.id, { skipWalkinAsk: !!walkinCheckinEventName }).catch((err: any) => {
            console.error("sendblue: gatherOpenItems failed (non-fatal, routing with no open items):", err?.message ?? err);
            return [];
          }),
        ]);
        const pendingOffer = pendingOfferResult.rows[0] ?? null;
        const hasPendingOffer = !!pendingOffer;

        const pendingWalkinCheckin = pendingWalkinCheckinResult.rows[0] ?? null;
        let walkinAskInstruction = "";
        if (pendingWalkinCheckin && walkinCheckinEventName) {
          const alreadyHasAsk = await hasActiveAsk(user.id).catch((err: any) => {
            console.error("sendblue: hasActiveAsk failed (non-fatal):", err?.message ?? err);
            return true; // fail toward not re-asking rather than risk a duplicate ask on error
          });
          if (!alreadyHasAsk) {
            walkinAskInstruction = `They just checked in at "${walkinCheckinEventName}" and don't have a stated ask on file yet. Ask them directly, once, in their own words: "what are you hoping to find here / who'd be good to meet?" Keep it to that one question this turn, don't pad it with anything else.`;
          }
        }

        const profile = profileResult.rows[0];
        const hasProfile = !!profile?.life_chapters?.length;
        const isFirstRealMessage = parseInt(activityCountResult.rows[0].count, 10) <= 1;

        // Context the reply needs (relevant memories, the rapport topic to
        // raise), started now so it's ready by the time the reply drafts
        // instead of running one after another after the debounce
        // (2026-09-26: ~3.7s of every reply was these, in series).
        const replyContextStarted = Date.now();
        const recentMemoriesP = (async () => {
          const memoriesResult = queryEmbedding
            ? await pool
                .query(
                  `SELECT content FROM co_memories
               WHERE user_id = $1 AND content_embedding IS NOT NULL AND memory_type != 'intent'
               ORDER BY content_embedding <=> $2::vector
               LIMIT 5`,
                  [user.id, `[${queryEmbedding.join(",")}]`],
                )
                .catch((vecErr: any) => {
                  console.error("Vector search failed, falling back to recency:", vecErr);
                  return pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type != 'intent' ORDER BY created_at DESC LIMIT 5`, [user.id]);
                })
            : await pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type != 'intent' ORDER BY created_at DESC LIMIT 5`, [user.id]);
          // Filtered for genuine relevance to what they just said before the
          // reply agent ever sees it (filterRelevantMemories in
          // conversationReply.ts): similarity alone isn't a relevance signal.
          const candidates = memoriesResult.rows.map((m: any) => m.content).filter(Boolean);
          return candidates.length ? await filterRelevantMemories(resolvedContent, candidates) : "";
        })().catch(() => "");
        const routeInput = {
          // Which text they replied to, so "I'm in" under an offer resolves to it.
          message: inlineTarget ? `${resolvedContent} ${inlineNote(inlineTarget)}` : resolvedContent,
          recentConversation,
          openItems,
          declinedCallTopics: declinedTopicsResult.rows.map((r: any) => r.content),
        };
        const readP: Promise<TurnRead> | null =
          oneRead && turnP
            ? propagateAttributes({ userId: user.id, traceName: "sendblue.readTurn" }, () =>
                turnP!.catch(() => null).then((t) => readTurn(routeInput, t, coveragePriorContext(profile))),
              )
            : null;
        readP?.catch(() => {});
        // Jev labels the same text in shadow, logged next to the read; never used for the reply (services/jevShadow.ts).
        const jevShadowP = hasText && readP ? startJevShadow(resolvedContent, lastCoLine(recentConversation), !!inlineTarget?.fromCo) : null;
        const coverageP = readP
          ? readP.then((r) => coverageNudgeFrom(user.id, profile, r.coverage)).catch(() => ({ missingTopic: null, refresh: null }))
          : getCoverageNudge(user.id, recentConversation, profile).catch(() => ({ missingTopic: null, refresh: null }));
        let turnRead: TurnRead | null = null;
        // The reaction Co gave their message to show what it's doing (from the
        // read), so a search knows whether it has already said "on it".
        let ackP: Promise<boolean> = Promise.resolve(false);

        let routerOutput: RouterOutput = NO_ROUTE;
        let routerFailed = false;
        let routerLatencyMs: number | null = null;
        try {
          if (readP) {
            turnRead = await readP;
            logJevShadow(user.id, jevShadowP, turnRead);
            // A reaction right away, before any drafting, so they see Co is on it
            // (Royce, 2026-09-29: Instinct reacts with what it's doing). Not awaited.
            const ackHandle = typeof req.body?.message_handle === "string" ? req.body.message_handle : null;
            if (hasText && turnRead.ack && ackHandle) {
              const ackStarted = Date.now();
              const ackEmoji = turnRead.ack;
              ackP = sendReaction(ackHandle, ackEmoji)
                .then((ok) => {
                  recordDecision({ layer: 3, decision: "turn.ack", userId: user.id, outcome: ok ? "act" : "skip", action: ackEmoji, proposal: { ms: Date.now() - ackStarted } }).catch(() => {});
                  return ok;
                })
                .catch(() => false);
            }
            routerOutput = turnRead.router;
            routerLatencyMs = turnRead.latencyMs;
            dotsP = Promise.resolve(turnRead.moment);
          } else {
            // Connecting the dots, alongside the router (services/connectDots.ts).
            if (hasText && !dotsP && turnP) {
              dotsP = turnP.then((t) =>
                readMoment({
                  asks: t.asks.map((a) => a.text),
                  threads: t.threads,
                  offersThisWeek: t.offersThisWeek,
                  now: `They just texted Co: "${resolvedContent}"${inlineTarget ? ` ${inlineNote(inlineTarget)}` : ""}`,
                  recent: recentConversation.split("\n").slice(-8).join("\n"),
                }),
              );
            }
            const routed = await propagateAttributes({ userId: user.id, traceName: "sendblue.router.route" }, () => routeMessage(routeInput));
            routerOutput = routed.output;
            routerLatencyMs = routed.latencyMs;
          }
        } catch (err: any) {
          routerFailed = true;
          // Fail safe: act on nothing rather than guess.
          console.error("sendblue: message router failed (non-fatal, taking no actions this turn):", err?.message ?? err);
        }
        const decision = decideActions(routerOutput, openItems, { message: resolvedContent, recentConversation });
        const [seekingMode, textEmotion] = oneRead ? [turnRead?.seeking ?? null, turnRead?.emotion ?? null] : await seekingAndEmotion;
        if (textEmotion) {
          await recordEmotionSignals(user.id, [{ source: "text", ...textEmotion, quote: resolvedContent.slice(0, 140), memoryId: inboundMemory.rows[0].id }]);
        }
        const emotional = await getEmotionalContext(user.id);
        // Items other than a call offer only ever resolved on real text, same
        // as the classifiers this replaces.
        const resolvedItem = decision.resolve && (hasText || decision.resolve.item.kind === "call_offer") ? decision.resolve : null;
        const resolvedAs = <K extends string>(kind: K) => (resolvedItem?.item.kind === kind ? resolvedItem : null);

        // Once this turn has actually done something visible (resolved an
        // item, sent a hold line, run a search, sent results), it must not
        // bail out silently at the debounce below with nothing to show for
        // it (2026-09-17 code review, finding #1/#5: a resent message could
        // get no reply at all, and whatever the turn already did — a link
        // sent, an item resolved — had nothing acknowledging it once the
        // turn bailed).
        let turnDidWork = !!resolvedItem;

        // Layer 2 harness record: the router's proposal, the code gates it
        // went through, and what was allowed to run.
        let routerActed = false;
        {
          const checks = routerGateChecks(routerOutput, openItems, decision, { message: resolvedContent, recentConversation }, routerFailed);
          const acted = [
            resolvedItem ? `resolve:${resolvedItem.item.kind}=${resolvedItem.value}` : null,
            decision.placeCall ? "place_call" : null,
            decision.scheduleCall ? "schedule_call" : null,
            decision.cancelCall ? "cancel_call" : null,
            decision.wantsRecommendation ? "recommendation" : null,
          ].filter(Boolean);
          routerActed = acted.length > 0 || !!decision.clarifyContext || !!decision.clarifyAbout;
          recordDecision({
            layer: 2,
            decision: "router.decideActions",
            userId: user.id,
            outcome: acted.length ? "act" : decision.clarifyContext ? "ask" : "skip",
            action: acted.join(",") || (decision.clarifyAbout ? `clarify:${decision.clarifyAbout}` : null),
            proposal: { ...routerOutput, openItems: openItems.map((i) => i.id), latencyMs: routerLatencyMs },
            checks,
            confidence: routerOutput.confidence,
            reason: routerFailed ? "router unavailable" : routerOutput.reason,
          });
        }

        // Invites are Co's own choice now (conversationTools.ts sendInvite,
        // 2026-09-25): no pattern or router flag decides it.

        // How long the search took, and preparing what it found (fit check
        // and description per match), for the latency record below.
        let searchMsForTurn = 0;
        let prepMsForTurn = 0;
        // Set to the last caption sent when the results fully answered a
        // message that was only a search ask; the reply agent is skipped.
        let resultsAnsweredAsk: string | null = null;
        // Names of the results that actually went out this turn.
        let sentThisTurn: string[] = [];

        // Whether to react instead of replying is Co's call now
        // (conversationTools.ts reactInsteadOfReplying, 2026-09-25). What stays
        // hard: never when Co still owes them an answer.
        const owesReply = hasText ? await replyOwed(user.id) : false;

        // Layer 3 harness facts: what's actually true this turn. Branches
        // below add what they did (a link sent, a call that failed) as they
        // act; the reply can only claim what ends up here.
        const factsStarted = Date.now();
        if (inlineTarget) {
          recordDecision({ layer: 2, decision: "turn.inlineReply", userId: user.id, outcome: "act", action: inlineTarget.fromCo ? "to_co" : "to_self", proposal: { repliedTo: inlineTarget.text.slice(0, 200) } }).catch(() => {});
        }
        turn = turnP ? await turnP.catch(() => null) : null;
        // This message's feeling was just recorded; the context read the ones before it.
        if (turn) turn.emotional = emotional;
        const replyFacts = await gatherReplyFacts(user.id, {
          turn: turn ?? undefined,
          context: `${resolvedContent}\n${inlineTarget ? `${inlineTarget.text}\n` : ""}${recentConversation.split("\n").filter((l) => l.startsWith("Co replied:")).slice(-3).join("\n")}`,
          pendingDescriptions: openItems.filter((i) => i.id !== resolvedItem?.item.id).map((i) => i.description),
        });
        // What the link they shared says (waits up to 6s; the reply never depends on it).
        if (theirLinkP && turnRead?.moment?.mode !== "small_talk") {
          const shared = await linkForReply(theirLinkP);
          // A link from their earlier text, answered on a later one (usually its preview photo):
          // the reply is about the page, not the picture.
          if (linkFromEarlier && shared.facts.length) addInstruction(replyFacts, "They sent a link just before this message, and this message may be its preview image or a separate photo. Answer about what the page says, using its text above, and about the photo too if it is something else. Do not answer only the photo.");
          recordDecision({ layer: 3, decision: "turn.link", userId: user.id, outcome: shared.facts.length ? "act" : "skip", action: `${linkFromEarlier ? "earlier_text" : "this_text"}:${shared.facts.length ? "read" : "not_read"}` }).catch(() => {});
          shared.facts.forEach((f) => addFact(replyFacts, "known", f));
          shared.hints.forEach((h) => addHint(replyFacts, h));
          shared.instructions.forEach((i) => addInstruction(replyFacts, i));
        }
        if (decision.wantsRecommendation && hasText) addInstruction(replyFacts, FRESH_SEARCH_INSTRUCTION);
        if (inlineTarget) addFact(replyFacts, "known", repliedToFact(inlineTarget));
        // Unmistakable crisis wording (services/safety.ts): Co gets the
        // guidance and the team hears about it even if Co misses it. Co's own
        // flagSafetyConcern covers everything this list doesn't.
        const crisisWording = hasText && soundsLikeCrisis(resolvedContent);
        if (crisisWording) {
          addInstruction(replyFacts, SAFETY_INSTRUCTION);
          recordSafetyConcern(user.id, user.first_name ?? null, "phrase", "their message used crisis wording").catch(() => {});
        }

        // Threading Co's texts under theirs this turn (services/inlineReply.ts):
        // the first text Co sends, and the first text of search results.
        // "They've texted since" is re-read each time, since a search can
        // take long enough for them to text again.
        const ownHandle = typeof req.body?.message_handle === "string" ? req.body.message_handle : null;
        let threadNextSend = true;
        const threadHandle = async (): Promise<string | null> => {
          const latest = myInboundAt
            ? await pool.query(`SELECT last_inbound_at FROM phone_debounce WHERE phone = $1`, [number]).then((r) => r.rows[0]?.last_inbound_at ?? null).catch(() => null)
            : null;
          // What this turn is about, from the one read: the message Co sent it in.
          const about = turnRead?.aboutSent && turnP ? (await turnP.catch(() => null))?.sent.find((x) => x.name === turnRead!.aboutSent) ?? null : null;
          const aboutSentHandle = about ? await sentMessageHandle(user.id, about).catch(() => null) : null;
          const why = threadReason({
            theyRepliedInline: !!inlineTarget && !!ownHandle,
            newerTextSince: !!ownHandle && !!latest && !!myInboundAt && new Date(latest).getTime() > new Date(myInboundAt).getTime(),
            aboutSentHandle,
            // How long they've waited for this answer.
            slowMs: myInboundAt ? Date.now() - new Date(myInboundAt).getTime() : undefined,
          });
          if (why) recordDecision({ layer: 7, decision: "reply.inline", userId: user.id, outcome: "act", action: why, proposal: why === "about_sent" ? { about: about?.name } : undefined }).catch(() => {});
          return why === "about_sent" ? aboutSentHandle : why ? ownHandle : null;
        };
        const threadedSend: typeof sendCoReply = async (p) => {
          if (!threadNextSend || p.asVoice) return sendCoReply(p);
          threadNextSend = false;
          return sendCoReply({ ...p, replyTo: await threadHandle() });
        };
        // hold: the line sent while a search runs, logged as "Co is looking:"
        // so it never counts as a real answer (the checks below exclude it by
        // prefix now that Co writes its own, not by a fixed list).
        const threadedSendAndLog = async (message: string, asVoice = false, hold = false): Promise<boolean> => {
          const sent = await threadedSend({ phone: user.phone_number, message, asVoice });
          if (sent) await logTextExchange(user.id, `${hold ? HOLD_PREFIX : "Co replied:"} ${cleanCoMessage(message)}`);
          return sent;
        };
        const factsMs = Date.now() - factsStarted;
        // Early warning (2026-09-25): a fast Jev read of whether they're
        // asking about another person's private details or asking Co to
        // contact someone for them. It only puts Co on alert; the privacy
        // lines themselves are hard rules either way. Member text goes to Jev
        // only through the zero-retention gateway where JEV_MEMBER=on.
        if (hasText) {
          const alert = await privacyAlert(resolvedContent).catch(() => null);
          if (alert) {
            addInstruction(replyFacts, alert.instruction);
            recordDecision({ layer: 3, decision: "jev.privacy", userId: user.id, outcome: "act", action: alert.kind, proposal: { p: alert.p } }).catch(() => {});
          }
        }
        // What their photo shows, so details Co takes from it count as on file
        // in the reply's fact check (2026-09-22, services/imageRead.ts).
        if (imageForVision) {
          addFact(
            replyFacts,
            "known",
            photoDescription
              ? `They sent a photo this turn. It shows: ${photoDescription}`
              : "They sent a photo this turn. You can see it attached; its details weren't written down, so describe only what you can see in it.",
          );
        }
        // A problem they're reporting about Co itself is saved for the team
        // (test only, services/issueReports.ts), and the reply can say so.
        // With the one read, feedback is flagged there and Co saves it with its
        // tool (no word filter deciding for it); READ_TURN=off keeps the old capture.
        const reportedIssue = hasText && !oneRead ? await captureIssueReport(user.id, resolvedContent, recentConversation) : null;
        const feedbackNote = feedbackInstruction(turnRead?.feedback ?? []);
        if (feedbackNote) addInstruction(replyFacts, feedbackNote);
        // What has really reached the team, so "is it noted to the team?" gets
        // a true answer (2026-09-18: Co said feedback "goes straight to the
        // team" when nothing had been saved).
        if (!reportedIssue) {
          const recentReports = await pool
            .query(`SELECT summary FROM user_reported_issues WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 3`, [user.id])
            .then((r) => r.rows.map((row: { summary: string }) => row.summary))
            .catch(() => [] as string[]);
          addFact(
            replyFacts,
            "known",
            recentReports.length
              ? `Saved for the team in the last day: ${recentReports.map((s) => `"${s}"`).join("; ")}. Nothing new was saved this turn.`
              : "Nothing they've said has been saved for the team in the last day, including this message. If this message is feedback for the team, save it with saveFeedbackForTeam; otherwise don't say anything was noted for, passed to, or sent to the team.",
          );
        }
        if (reportedIssue) {
          turnDidWork = true;
          addFact(replyFacts, "did_this_turn", `Saved what they reported about how Co works, for the team to look at: "${reportedIssue.summary}"`);
          addInstruction(
            replyFacts,
            "They pointed out a problem with how you work. It's already saved for the team, so don't save it again. Acknowledge it plainly in a sentence, say you've passed it along to the team, and don't promise whether or when it gets fixed. If they gave other, separate feedback in the same message, save that with saveFeedbackForTeam. Then respond to anything else they said.",
          );
        }
        if (repeatContext) addInstruction(replyFacts, repeatContext);
        if (walkinAskInstruction) addInstruction(replyFacts, walkinAskInstruction);
        if (decision.clarifyContext) addInstruction(replyFacts, decision.clarifyContext);

        // Same strings downstream code (and the reply agent) already key on.
        const callAction =
          resolvedAs("call_offer")?.value === "accept"
            ? "accepts_offer"
            : resolvedAs("call_offer")?.value === "decline"
              ? "declines_offer"
              : decision.placeCall
                ? "explicit_request"
                : decision.scheduleCall
                  ? "schedule_request"
                  : decision.cancelCall
                    ? "cancel_scheduled_call"
                    : decision.answerCallingQuestion
                      ? "asks_about_calling"
                      : decision.callWouldBenefit
                        ? "would_benefit"
                        : "none";

        const resolvedCallOffer = resolvedAs("call_offer");
        const onboardingPreference =
          resolvedCallOffer?.item.ref?.kind === "call_offer" && String(resolvedCallOffer.item.ref.content ?? "").startsWith(ONBOARDING_CALL_OFFER_PREFIX);
        if (onboardingPreference && (callAction === "accepts_offer" || callAction === "declines_offer")) {
          const preference = callAction === "accepts_offer" ? "call" : "text";
          await pool.query(`UPDATE users SET contact_preference = $2 WHERE id = $1`, [user.id, preference]).catch(() => {});
          await recordDecision({
            layer: 1,
            decision: "intake.contactPreference",
            userId: user.id,
            outcome: "act",
            action: preference,
            proposal: { message: resolvedContent },
          }).catch(() => {});
        }
        // They just answered the onboarding call-or-text question with text:
        // take that and open the real conversation.
        if (onboardingPreference && callAction === "declines_offer") {
          addInstruction(replyFacts, "They just said they'd rather keep texting. Say that works in a few words, then invite them to share what's on their mind or going on in their life right now. One question, no call offer.");
        }
        if (resolvedCallOffer?.item.ref?.kind === "call_offer") {
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_resolved', $2)`,
            [user.id, callAction],
          ).catch((err: any) => console.error("sendblue: call_offer_resolved memory write failed (non-fatal):", err?.message ?? err));

          // Not for the onboarding call-or-text question (2026-09-17 code
          // review): "text is fine" there is a channel preference, and storing
          // it as a declined topic suppressed later, genuine call offers.
          if (callAction === "declines_offer" && resolvedCallOffer.item.ref.content && !onboardingPreference) {
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_declined_topic', $2)`,
              [user.id, resolvedCallOffer.item.ref.content],
            ).catch((err: any) => console.error("sendblue: call_offer_declined_topic memory write failed (non-fatal):", err?.message ?? err));
          }
        }

        // Walk-in check-in answer. Captured directly rather than checking
        // hasActiveAsk: profile extraction only runs AFTER a reply is sent,
        // so hasActiveAsk would still read false for this exact message and
        // Co would ask the same question a second time.
        const walkinAnswer = resolvedAs("walkin_ask");
        if (walkinAnswer?.item.ref?.kind === "walkin_ask") {
          await recordWalkinAsk(walkinAnswer.item.ref.eventApiId, user.id, content).catch((err: any) =>
            console.error("sendblue: recordWalkinAsk failed (non-fatal):", err?.message ?? err),
          );
        }

        // Their reaction to something Co sent directly (services/offerReactions.ts):
        // saved as the outcome the repeat rule reads, and told to the reply.
        const offerReaction = resolvedAs("offer_reaction");
        if (offerReaction?.item.ref?.kind === "offer_reaction") {
          const reaction = offerReaction.value as OfferReaction;
          try {
            await recordOfferReaction(user.id, offerReaction.item.ref.pending, reaction, content);
            addFact(replyFacts, "known", reactionFact(offerReaction.item.ref.pending, reaction));
            reactingToSent = true;
            await recordDecision({ layer: 6, decision: "offer.reaction", userId: user.id, outcome: "act", action: reaction, proposal: { item: offerReaction.item.ref.pending.itemName, key: offerReaction.item.ref.pending.itemKey, message: content.slice(0, 200) } });
          } catch (err: any) {
            console.error("sendblue: offer reaction handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Resolve the ask-first event/opportunity tease, if one's pending.
        // Only classifies when there's actually something pending — no
        // reason to spend a call checking on every message otherwise.
        // Folded into the SAME reply below via eventOfferContext, never a
        // second message — same reasoning as recommendationContext.
        const resolvedEventTease = resolvedAs("event_tease");
        if (resolvedEventTease?.item.ref?.kind === "event_tease") {
          const pendingEventOffer = resolvedEventTease.item.ref;
          try {
            const eventReplyAction = resolvedEventTease.value === "yes" ? "interested" : "not_interested";

            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'event_offer_resolved', $2)`,
              [user.id, eventReplyAction],
            ).catch((err: any) => console.error("sendblue: event_offer_resolved memory write failed (non-fatal):", err?.message ?? err));

            const parsed = JSON.parse(pendingEventOffer.content) as { askText: string; match: any };
            // Real details and a personal reason for the reveal (filled in on
            // demand for offers queued before details existed).
            const match: any = await enrichMatch(parsed.match, {
              userId: user.id,
              firstName: user.first_name,
              askText: parsed.askText,
              goals: profile?.goals ?? null,
              city: profile?.city ?? null,
              feeling: renderEmotionalContext(emotional),
            });
            // Staleness check (Royce, 2026-08-30) — Tier 1/2 carry the
            // event's own date; if they said yes days after the tease and
            // the event's already passed, revealing it as if it's still
            // live would be misleading. Tier 3 opportunities have an
            // optional `deadline` (set only when the source post stated
            // one explicitly — see tieredRecommendation.ts's TierMatch)
            // checked the same way; a Tier 3 match with no stated deadline
            // (rolling admissions, or the post just didn't say) has
            // nothing to check here. Bug fix, 2026-08-30 (code review):
            // this used to only ever check event_date, so an expired Tier
            // 3 opportunity that had been sitting pending for days could
            // still get revealed as if the application window were open —
            // exactly what `deadline` was added to prevent, just not
            // wired into this reply-resolution path yet.
            // Date-only comparison, not a timestamp one (bug fix,
            // 2026-08-30) — event_date/deadline are bare YYYY-MM-DD with
            // no time component, so `new Date(x) < new Date()` treats ANY
            // time past midnight UTC on that day as already stale,
            // wrongly flagging a same-day evening event as "already
            // passed" hours before it happens. Comparing calendar dates
            // instead means today's date is never stale.
            const todayStr = new Date().toISOString().slice(0, 10);
            const relevantDate: string | undefined = match.event_date ?? match.deadline;
            const isStale = relevantDate && relevantDate < todayStr;
            await recordSuggestionOutcome(
              user.id,
              match.kind === "opportunity" ? "opportunity" : "event",
              match.event_api_id ? `event:${match.event_api_id}` : `name:${String(match.name).toLowerCase()}`,
              match.name,
              eventReplyAction === "interested" ? "interested" : "declined",
            );
            if (eventReplyAction === "interested" && isStale) {
              const passedPhrase = match.event_date ? `it was on ${relevantDate}` : `the application window closed on ${relevantDate}`;
              addFact(replyFacts, "known", `The thing Co teased earlier already passed (${passedPhrase}).`);
              addInstruction(replyFacts, `They just said yes to hearing more about the thing you teased earlier, but it's already passed (${passedPhrase}). Let them know honestly that it's already happened so there's nothing to share, no pressure or apology needed. Never reveal the name "${match.name}" since there's nothing to act on now.`);
            } else if (eventReplyAction === "interested") {
              // Sent deterministically, not via agent tool-calling (Royce,
              // 2026-09-02, confirmed live on a DIFFERENT reveal path that
              // clumped a link mid-sentence into one paragraph) — same fix
              // applied here: the link goes out as its own bare message
              // (real iMessage preview) BEFORE the agent's reply, which
              // then only has to explain why it fits, never repeat the link.
              const linkSent = match.url ? await sendAndLog(user.id, user.phone_number, match.url) : false;
              if (linkSent) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                addFact(replyFacts, "did_this_turn", `Sent the link ${match.url} for "${match.name}" as its own message just before this reply.`);
              }
              addEventFacts(replyFacts, match);
              if (!match.whyItFits) addFact(replyFacts, "known", `Why "${match.name}" fits them: ${match.reason}`);
              addInstruction(replyFacts, `They just said yes to hearing more about the thing you teased earlier. Share why it fits now, naturally, as part of your reply: "${match.name}". Be honest it's a suggestion, not a guarantee it's right for them.${linkSent ? " Don't repeat the link or say you're \"sending\" or \"sharing\" anything, it already went out." : match.url ? " Its link didn't go through, so share it in your reply with shareLink if it helps." : " There's no link for it, so don't mention one."}`);
              // Outcome-learning loop (Royce, 2026-09-02) — schedule the
              // "who did you meet?" follow-up right at the moment real
              // details are actually revealed, same trigger point the
              // Figma board shows. No-op for Tier 3 (no event_date) — see
              // scheduleOutcomeFollowUp.
              scheduleOutcomeFollowUp(user.id, parsed.askText, match).catch((err: any) =>
                console.error("sendblue: scheduleOutcomeFollowUp failed (non-fatal):", err?.message ?? err),
              );
            } else {
              addInstruction(replyFacts, `They just passed on hearing more about the thing you teased earlier (internal only, never say this name to them: "${match.name}"). Acknowledge lightly, no pressure, don't explain what it was.`);
            }
          } catch (err: any) {
            console.error("sendblue: event offer reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Resolve the "who did you meet?" outcome follow-up, if one's
        // pending (Royce, 2026-09-02 — Notion V1 board rows 7/12/13, "Co
        // follows up" + shared classifier + signal weighting loop-back).
        // Same "only classify when something's actually pending, fold into
        // the SAME reply" reasoning as eventOfferContext above.
        const resolvedOutcome = resolvedAs("outcome_followup");
        if (resolvedOutcome?.item.ref?.kind === "outcome_followup") {
          try {
            const pendingOutcomeFollowUp = resolvedOutcome.item.ref.pending;
            const outcome = resolvedOutcome.value as "named_positive" | "named_critical" | "not_mentioned";
            await recordOutcome(user.id, pendingOutcomeFollowUp.id, pendingOutcomeFollowUp.tier, outcome);
            await recordSuggestionOutcome(user.id, pendingOutcomeFollowUp.tier === 0 ? "intro" : pendingOutcomeFollowUp.tier === 3 ? "opportunity" : "event", `followup:${pendingOutcomeFollowUp.id}`, pendingOutcomeFollowUp.match_name, resultFromNamedOutcome(outcome), resolvedContent.slice(0, 160));
            addFact(replyFacts, "did_this_turn", `Recorded what they said about how "${pendingOutcomeFollowUp.match_name}" went.`);
            // Stay-scoped clause (Royce, 2026-09-07, confirmed live) —
            // without this, a name or detail from a DIFFERENT,
            // already-resolved outcome follow-up sitting in
            // recentMemories (e.g. someone named a few messages ago
            // about an unrelated event) got blended into this reply as
            // if it belonged to the outcome actually being resolved here.
            const stayScoped = ` Keep this reply scoped to "${pendingOutcomeFollowUp.match_name}" specifically — don't pull in a name or detail from a different, already-resolved outcome or an unrelated recent memory, even if one is sitting in context.`;
            if (outcome === "named_positive") {
              addInstruction(replyFacts, `They just told you something good came out of "${pendingOutcomeFollowUp.match_name}" — someone worthwhile they met or a good outcome. Respond warmly to what they specifically shared, genuinely glad for them.${stayScoped}`);
            } else if (outcome === "named_critical") {
              addInstruction(replyFacts, `They just told you "${pendingOutcomeFollowUp.match_name}" wasn't worthwhile or didn't go well. Acknowledge that honestly and warmly, no forced positivity, no apologizing on behalf of the thing itself.${stayScoped}`);
            } else {
              addInstruction(replyFacts, `They answered about "${pendingOutcomeFollowUp.match_name}" but didn't name anyone specific or describe a real outcome. Acknowledge lightly, no pressure to elaborate.${stayScoped}`);
            }
          } catch (err: any) {
            console.error("sendblue: outcome follow-up reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Resolve the end-of-night check-in, if one's pending (Notion V1
        // board row 8 — sibling to the outcome follow-up above, but gated on
        // a real Luma check-in at one of Co's own curated events rather than
        // Co merely having recommended something). Same reuse-the-shared-
        // classifier, fold-into-the-same-reply reasoning throughout this file.
        const resolvedCheckin = resolvedAs("event_checkin");
        if (resolvedCheckin?.item.ref?.kind === "event_checkin") {
          try {
            const pendingCheckin = resolvedCheckin.item.ref.pending;
            const outcome = resolvedCheckin.value as "named_positive" | "named_critical" | "not_mentioned";
            await recordEventCheckinOutcome(user.id, pendingCheckin.id, pendingCheckin.event_api_id, outcome);
            await recordSuggestionOutcome(user.id, "event", `event:${pendingCheckin.event_api_id}`, pendingCheckin.event_name, resultFromNamedOutcome(outcome), resolvedContent.slice(0, 160));
            addFact(replyFacts, "did_this_turn", `Recorded what they said about "${pendingCheckin.event_name}".`);
            // Same stay-scoped fix as the outcome follow-up above — a
            // name/detail from a different, already-resolved follow-up
            // could otherwise blend into this reply.
            const stayScoped = ` Keep this reply scoped to "${pendingCheckin.event_name}" specifically — don't pull in a name or detail from a different, already-resolved outcome or an unrelated recent memory, even if one is sitting in context.`;
            if (outcome === "named_positive") {
              addInstruction(replyFacts, `They just told you something good came out of "${pendingCheckin.event_name}" — someone worthwhile they met or a good moment from tonight. Respond warmly to what they specifically shared, genuinely glad for them.${stayScoped}`);
            } else if (outcome === "named_critical") {
              addInstruction(replyFacts, `They just told you "${pendingCheckin.event_name}" wasn't worthwhile or didn't go well. Acknowledge that honestly and warmly, no forced positivity, no apologizing on behalf of the event itself.${stayScoped}`);
            } else {
              addInstruction(replyFacts, `They answered about "${pendingCheckin.event_name}" but didn't name anyone specific or describe a real moment. Acknowledge lightly, no pressure to elaborate.${stayScoped}`);
            }
          } catch (err: any) {
            console.error("sendblue: event check-in reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Double opt-in event-guest handoff (Royce, 2026-09-07 — sibling to
        // the two blocks above, same shared-classifier/fold-into-the-same-
        // reply reasoning, but resolving a match nudge rather than an
        // outcome). See services/eventGuestMatchHandoff.ts for the actual
        // opt-in/reciprocal-ask/group-creation logic — this block only
        // classifies the reply and hands it off.
        const resolvedMatchNudge = resolvedAs("match_nudge");
        if (resolvedMatchNudge?.item.ref?.kind === "match_nudge") {
          try {
            const pendingMatchNudge = resolvedMatchNudge.item.ref.pending;
            const classification = resolvedMatchNudge.value === "yes" ? "interested" : "not_interested";
            await handleMatchNudgeReply(
              pendingMatchNudge.event_id,
              pendingMatchNudge.event_name,
              classification,
              { user_id: user.id, first_name: user.first_name, phone_number: user.phone_number, email: user.email },
              {
                user_id: pendingMatchNudge.candidate_id,
                first_name: pendingMatchNudge.candidate_first_name,
                phone_number: pendingMatchNudge.candidate_phone,
                email: pendingMatchNudge.candidate_email,
              },
            );
            // An anonymous heads-up: they never learned who, so the reply
            // can't either until both say yes.
            const other = pendingMatchNudge.anonymous ? "the other member" : pendingMatchNudge.candidate_first_name;
            if (pendingMatchNudge.anonymous) {
              addInstruction(replyFacts, "They were never told who the other member is. Don't name them, describe them, or hint at who it is, even if asked; say you'll share once you've checked with them.");
            }
            if (classification === "interested") {
              addFact(replyFacts, "did_this_turn", `Recorded that they want to be connected with ${other}. No introduction has been made yet; it depends on ${other} saying yes too.`);
              addInstruction(replyFacts, `They just said yes to being connected with ${other}. Acknowledge it warmly and briefly. You may have already asked them a separate follow-up question about how they'd like to connect (text or email), or you're still waiting on ${other} to answer. Don't promise a specific thing is happening, and don't say what ${other} thinks or wants.`);
            } else {
              addFact(replyFacts, "did_this_turn", `Recorded that they passed on being connected with ${other}.`);
              addInstruction(replyFacts, `They just passed on being connected with ${other} (internal only, never say this name back to them as a pressure tactic). Acknowledge lightly, no pressure, don't explain further.`);
            }
          } catch (err: any) {
            console.error("sendblue: match nudge reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Network intro shortlist, redesigned (Royce, 2026-09-07: "how would
        // you implement the networking recommendation... if you just didn't
        // get fed this information but only know about my product purpose").
        // Two-stage reply, mirroring event-surfacing's tease-then-reveal
        // pattern instead of the old bundled 1-5-name shortlist: (1) a reply
        // to the nameless tease ("want to hear who?"), (2) a reply to the
        // reveal+ask ("it's Celine — want an intro?"). Only one of these two
        // is ever pending for a given person at a time, so — unlike the old
        // design — there's no multi-candidate disambiguation needed at all.
        const resolvedTease = resolvedAs("network_tease");
        if (resolvedTease?.item.ref?.kind === "network_tease") {
          try {
            const classification = resolvedTease.value === "yes" ? "interested" : "not_interested";
            const teaseCandidate = resolvedTease.item.ref.pending.candidate;
            await recordSuggestionOutcome(user.id, "intro", `intro:${teaseCandidate.candidate_id}`, `an intro to ${teaseCandidate.first_name}`, classification === "interested" ? "interested" : "declined");
            const context = await resolveNetworkTeaseReply(user.id, user.first_name, user.phone_number, resolvedTease.item.ref.pending, classification);
            if (context) {
              addInstruction(replyFacts, context);
              if (classification === "interested") {
                addFact(replyFacts, "did_this_turn", `Sent a separate message just before this reply naming ${resolvedTease.item.ref.pending.candidate.first_name} and asking if they want an intro.`);
              }
            }
          } catch (err: any) {
            console.error("sendblue: network tease reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        const resolvedIntro = resolvedAs("network_intro");
        if (resolvedIntro?.item.ref?.kind === "network_intro") {
          try {
            const classification = resolvedIntro.value === "yes" ? "interested" : "not_interested";
            const introCandidate = resolvedIntro.item.ref.pending.candidate;
            await recordSuggestionOutcome(user.id, "intro", `intro:${introCandidate.candidate_id}`, `an intro to ${introCandidate.first_name}`, classification === "interested" ? "interested" : "declined");
            const context = await resolveNetworkIntroReply(
              { user_id: user.id, first_name: user.first_name, phone_number: user.phone_number, email: user.email },
              resolvedIntro.item.ref.pending,
              classification,
            );
            if (context) {
              addInstruction(replyFacts, context);
              const other = resolvedIntro.item.ref.pending.candidate.first_name;
              if (classification === "not_interested") addFact(replyFacts, "did_this_turn", `Recorded that they passed on an intro to ${other}.`);
              else if (/intro email/i.test(context)) addFact(replyFacts, "did_this_turn", `${other} had already said yes, so Co sent an intro email to both of them.`);
              else addFact(replyFacts, "did_this_turn", `Asked ${other} whether they're open to an intro. Waiting to hear back; no intro has been made. If ${other} says yes, Co emails an intro to both of them.`);
            }
          } catch (err: any) {
            console.error("sendblue: network intro-offer reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // "What's new?" is Co's call now (conversationTools.ts
        // sendProductUpdates, 2026-09-25); the list itself still goes out
        // verbatim.

        const shouldTriggerCall = decision.placeCall;

        // Schedule-a-call — a specific future time, not "call me now"
        // (shouldTriggerCall above). Extracted as structured date/time/
        // timezone rather than asking the model to do timezone math itself
        // (unreliable) — luxon does the actual UTC conversion once all three
        // pieces are present. Nothing gets scheduled on a partial
        // extraction; the reply below asks for whatever's missing instead
        // of guessing a timezone, which would silently call someone at the
        // wrong time.
        if (callAction === "schedule_request") {
          try {
            const nowUtc = DateTime.now().toUTC();
            const { text: rawSchedule } = await generateText({
              model: anthropic(MODELS.haiku),
              experimental_telemetry: { isEnabled: true, functionId: "sendblue.scheduleCallExtract" },
              prompt: `A user is texting Co to schedule a call for later. The date, time, and timezone can be spread across several messages (e.g. they gave a time earlier and are only now confirming the date/timezone Co asked for) — read the whole conversation, not just the latest message, to piece it together.

Recent conversation, in order:
${recentConversation || "(start of the conversation)"}

Their latest message: "${resolvedContent}"

For resolving anything relative ("tomorrow", "next Tuesday"), the current UTC date/time is ${nowUtc.toFormat("cccc, LLLL d, yyyy 'at' HH:mm 'UTC'")}.

Extract, combining information from the whole conversation above:
- date: the requested date, as YYYY-MM-DD. null if not stated anywhere or genuinely ambiguous.
- time: the requested time of day, as 24-hour HH:MM. null if not stated anywhere.
- timezone: the IANA timezone name they stated or unambiguously implied (e.g. "America/New_York", "America/Los_Angeles", "America/Chicago", "America/Denver"). null if not stated and not clearly implied — never guess one.

Return ONLY valid JSON, no preamble: {"date": "YYYY-MM-DD or null", "time": "HH:MM or null", "timezone": "IANA name or null"}`,
            });

            const parsed = parseModelJson<{ date: string | null; time: string | null; timezone: string | null }>(rawSchedule);

            if (parsed.date && parsed.time && parsed.timezone) {
              const local = DateTime.fromISO(`${parsed.date}T${parsed.time}`, { zone: parsed.timezone });
              if (local.isValid && local.toUTC() > DateTime.utc()) {
                // A new successfully-scheduled call supersedes any earlier
                // one still pending, rather than both eventually firing —
                // asking again means instead of, not also. Only cancels
                // 'pending' rows; one already claimed/'processing' by the
                // cron is left alone rather than raced.
                const superseded = await pool.query(
                  `UPDATE scheduled_calls SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
                  [user.id],
                );
                await pool.query(
                  `INSERT INTO scheduled_calls (user_id, requested_text, timezone, scheduled_for) VALUES ($1, $2, $3, $4)`,
                  [user.id, resolvedContent, parsed.timezone, local.toUTC().toISO()],
                );
                const formattedTime = local.toFormat("cccc, LLLL d 'at' h:mm a");
                addFact(
                  replyFacts,
                  "did_this_turn",
                  `${superseded.rows.length ? "Rescheduled their call (replacing the earlier booking)" : "Scheduled a call"} for ${formattedTime} (${parsed.timezone}). Co will call them then.`,
                );
                addInstruction(
                  replyFacts,
                  superseded.rows.length
                    ? `They just rescheduled. Confirm the NEW time (${formattedTime}, ${parsed.timezone}) back to them naturally, making clear this is a change from before, not a new addition. Do not place a call now, it's scheduled for later.`
                    : `They just scheduled a call for ${formattedTime} (${parsed.timezone}). Confirm that back to them naturally, referencing the actual day and time so they know it landed correctly. Do not place a call now, it's scheduled for later.`,
                );
              } else {
                addFact(replyFacts, "did_this_turn", `No call was scheduled: the time they gave (${parsed.date} ${parsed.time}, ${parsed.timezone}) is invalid or already past.`);
                addInstruction(replyFacts, "They tried to schedule a call, but the time they gave is invalid or already in the past. Let them know naturally and ask for a time that hasn't passed yet. Do not place a call now.");
              }
            } else {
              const missing = [!parsed.date && "the date", !parsed.time && "the time", !parsed.timezone && "their timezone"]
                .filter(Boolean)
                .join(" and ");
              addFact(replyFacts, "did_this_turn", `No call was scheduled yet: still missing ${missing}.`);
              addInstruction(replyFacts, `They want to schedule a call for later but haven't given ${missing} yet. Ask for exactly that, specifically. Never guess or assume a timezone. Do not place a call now.`);
            }
          } catch (err: any) {
            console.error("sendblue: schedule_request extraction failed (non-fatal):", err?.message ?? err);
            addFact(replyFacts, "did_this_turn", "No call was scheduled: Co couldn't work out the time they meant.");
            addInstruction(replyFacts, "They want to schedule a call for a specific time but something went wrong figuring out when. Ask them to state the day, time, and their timezone clearly. Do not place a call now.");
          }
        } else if (callAction === "cancel_scheduled_call") {
          // No new time to extract here — just clear whatever's pending.
          // Only touches 'pending' rows, same reasoning as the supersede
          // logic above: one already claimed/'processing' by the cron is
          // left alone rather than raced with a cancel.
          try {
            const cancelled = await pool.query(
              `UPDATE scheduled_calls SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
              [user.id],
            );
            addFact(replyFacts, "did_this_turn", cancelled.rows.length ? "Cancelled their scheduled call." : "They asked to cancel a call, but nothing was scheduled.");
            addInstruction(
              replyFacts,
              cancelled.rows.length
                ? "They just cancelled their scheduled call. Confirm that naturally. Do not place a call now."
                : "They're trying to cancel a scheduled call, but nothing is actually scheduled right now. Let them know that naturally, there's nothing to cancel. Do not place a call now.",
            );
          } catch (err: any) {
            console.error("sendblue: cancel_scheduled_call failed (non-fatal):", err?.message ?? err);
            addFact(replyFacts, "did_this_turn", "Trying to cancel their scheduled call failed; it may still be scheduled.");
            addInstruction(replyFacts, "They want to cancel a scheduled call but cancelling it failed. Tell them it didn't go through and ask them to try again in a minute. Don't promise you'll fix it. Do not place a call now.");
          }
        }

        // They asked a plain question about the calling feature — answer it
        // truthfully, don't place a call and don't pretend one is
        // happening. Without this, the classifier alone isn't a strong
        // enough signal on its own to stop the reply from improvising
        // "calling you now" language, and separately, this question being
        // misread as explicit_request would place real outbound Twilio
        // calls to people who were just asking how the feature works.
        if (callAction === "asks_about_calling") {
          addInstruction(replyFacts, `They just asked a plain question about how calling works — answer it directly and honestly, don't place a call, and don't say or imply a call is happening. The true answer: Co can call them — by text right now ("call me") or scheduled for later — and that's real and live. They can also call Co directly anytime, from this exact number — that connects to a real, live conversation with Co. Refer to it only as "this number" or "this exact number," never write out or guess actual digits — you are not given the real number here, and a specific-looking one you invent will be wrong and won't work. Only mention this second part if it's actually what they're asking about; don't volunteer it unprompted.`);
        }

        // Burst limiter — separate from, and in addition to, the topic-aware
        // suppression above. Topic-matching only stops Co re-offering about
        // the SAME thing; on its own it does nothing to stop several
        // DIFFERENT heavy topics in a row each triggering their own offer.
        // Short and topic-blind on purpose: it only needs to cover a burst,
        // not stand in for the topic check above.
        const recentOfferCountResult = await pool.query(
          `SELECT count(*) FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_pending' AND created_at > NOW() - INTERVAL '10 minutes'`,
          [user.id],
        );
        const recentOfferBurstActive = parseInt(recentOfferCountResult.rows[0].count, 10) > 0;

        // Real gap found live, 2026-09-14 (Royce: "Call me" got back "This
        // is text, I can't actually call" — false; Co genuinely can and the
        // classifier correctly recognized the request, but the actual dial
        // attempt failed and the fallthrough reply below had zero context
        // about what happened, so the model invented its own — wrong —
        // explanation). Same fix shape as callFeatureQuestionContext below:
        // ground the reply in the real reason instead of leaving the model
        // to guess why nothing happened.
        if (shouldTriggerCall) {
          const callResult = await triggerCallForUser(user.id, io, { kind: "router_decision" });
          if (callResult.success) {
            const confirmation = "Calling you now.";
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
              [user.id, `Co replied: ${confirmation}`],
            );
            try {
              await sendblue.messages.send({
                number,
                content: confirmation,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`Sendblue call-confirmation send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
            }
            return res.status(200).send({ received: true, action: "call_triggered", call_sid: callResult.call_sid });
          }
          console.error(`sendblue: call trigger failed for user ${user.id} (non-fatal, falling through to normal reply):`, callResult.error);
          // Falls through to the normal reply flow below on failure — a
          // failed dial attempt should never leave the conversation silent.
          const alreadyInProgress = callResult.error === "A call is already in progress for this user.";
          addFact(
            replyFacts,
            "did_this_turn",
            alreadyInProgress
              ? "Tried to call them just now; it didn't go through because a call already shows as in progress for them."
              : "Tried to call them just now; the call attempt failed. The reason isn't known.",
          );
          addInstruction(
            replyFacts,
            alreadyInProgress
              ? `They just asked you to call them, and Co genuinely can (this is real and live) — but a call attempt just failed because a call is already showing as in progress for them. Be honest that something's not letting the call go through right now and you're not sure why, rather than saying calling isn't possible at all. Don't place a call, and don't say "calling you now."`
              : `They just asked you to call them, and Co genuinely can (this is real and live) — but the call attempt just failed. Be honest that something went wrong placing it, without inventing a specific reason you don't actually have, and never claim calling isn't possible. Don't place a call, and don't say "calling you now."`,
          );
        }

        // Two independent reasons Co might fold in a secondary call-offer
        // gesture: content-driven (would_benefit, from the classifier above)
        // or channel-driven — someone with no profile yet, on their first
        // real message, regardless of what that message actually is (a real
        // voice call produces a far richer initial profile than short texts
        // ever will). Fires at most once per person (isFirstRealMessage is
        // only ever true for message #1). Eligibility (this signal +
        // hasPendingOffer/recentOfferBurstActive as hard gates) is now
        // weighed by the reply agent below, not pre-decided here — see
        // agent/conversationReply.ts.
        const isThinProfileFirstMessage = !hasProfile && isFirstRealMessage && callAction === "none";

        // Real action-triggering — mirrors the surface_recommendation Hume
        // tool on the voice path, but iMessage has no tool_call plane to
        // invoke it through, so this is a direct call to the same shared
        // generateRecommendation() gated by the router's wantsRecommendation
        // instead. Folded into the one reply below (never sent as a second
        // message).
        // Co decides whether and what to search (conversationTools.ts
        // searchNow, 2026-09-25: its call, not the router's flag). This is how
        // a search it asks for runs and is sent, unchanged: the hold line, the
        // fit check, link then caption, the ask saved when nothing fits, late
        // results, the time-frame follow-up. What it learns goes into the
        // reply's facts and back to Co as the tool's result.
        let searchedThisTurn = false;
        const searchAndSend = async (what: string, whileLooking: string | null = null): Promise<{ answered: boolean; sentCount: number; briefing: string }> => {
          const factsBefore = replyFacts.facts.length;
          const instructionsBefore = replyFacts.instructions.length;
          let answered = false;
          searchedThisTurn = true;
          try {
            // A struggling person who asks for something still gets it (Royce,
            // 2026-09-18: "we can't isolate them"). Co acknowledges how they're
            // doing in the same reply.
            if (emotional.needsCare) {
              addInstruction(replyFacts, "They've had a hard day. Acknowledge it briefly and warmly, in your own words, then share what you found.");
            }
              // A search is about to actually run: whatever happens, this turn
              // has now done real work and must see it through to a reply.
              turnDidWork = true;
              // Searching all tiers can take a while: say so first, so the
              // person isn't left waiting and resending (2026-09-15: a 70s
              // wait led to the same message sent five times).
              // Co's own words for it when it wrote them (2026-09-28: the fixed
              // "Let me look, one sec" read as a script); the stock line otherwise.
              const holdLine = holdLineFrom(whileLooking) ?? HOLD_LINES[Math.floor(Math.random() * HOLD_LINES.length)];
              // A reaction says "on it" first (👀 here if the read didn't give
              // one); the looking text only goes out when the search runs long
              // (2026-09-29). On SMS, where reactions don't exist, it goes at once as before.
              let acked = await ackP;
              if (!acked && ownHandle) acked = await sendReaction(ownHandle, "👀").catch(() => false);
              let holdSent: Promise<boolean> | null = null;
              const sendHold = () => (holdSent ??= threadedSendAndLog(holdLine, false, true));
              const holdTimer = acked ? setTimeout(() => void sendHold(), HOLD_AFTER_ACK_MS) : null;
              if (!acked) sendHold();
              const RECOMMENDATION_TIME_CAP_MS = 45_000;
              const searchStarted = Date.now();
              searchMsForTurn = 0;
              // A capped search whose result lands after the cap is discarded
              // by the helper itself (agent/conversationTools.ts), not just
              // raced here (2026-09-17 code review: generateRecommendation kept
              // running and writing after Co had already said it found
              // nothing, and its late write could still land after "found
              // nothing" went out).
              const recommendation = await searchWithTimeCap(user.id, what, RECOMMENDATION_TIME_CAP_MS, "sendblue.recommendation", (late) =>
                sendLateSearchResult({ userId: user.id, firstName: user.first_name ?? null, phoneNumber: user.phone_number, city: profile?.city ?? null, askHandle: ownHandle }, what, late),
              );
              searchMsForTurn = Date.now() - searchStarted;
              if (holdTimer) clearTimeout(holdTimer);
              if (holdSent && (await holdSent)) addFact(replyFacts, "did_this_turn", `Told them "${holdLine}" before searching.`);
              if (acked) addFact(replyFacts, "did_this_turn", "Reacted to their message with an emoji to show you were on it.");
              // What this search looked at and ruled out, so the reply never
              // recommends one of them because it was sent earlier (2026-09-16:
              // a search rejected the chess night as "not an AI engineer event"
              // and the reply still called it "your real option").
              const ruledOut = ("scope" in recommendation ? recommendation.scope?.relevanceRejected : null) ?? [];
              if (ruledOut.length) {
                addFact(replyFacts, "did_this_turn", `This search looked at and ruled out: ${ruledOut.map((r) => `"${r.name}" (${r.why})`).join("; ")}.`);
                addInstruction(replyFacts, "Don't recommend or endorse anything this search ruled out, even if you sent it before. If they already have one of those from earlier, say plainly it isn't really what they asked for.");
              }
              if (recommendation.available && recommendation.matches?.length) {
                // Sent DETERMINISTICALLY, not via agent tool-calling (Royce,
                // 2026-09-02, confirmed live) — the previous version asked the
                // conversational agent to execute a multi-step sendReply
                // sequence (link, then description, per match) via prose
                // instructions in its system prompt. Real failure: with two
                // matches AND another context block (updatesContext) active in
                // the same turn, the model correctly sent the first match's
                // link, then gave up on the sequence and crammed the second
                // match's description, its MISSING link, and the unrelated
                // updates content into one giant paragraph — "too wordy and
                // it didn't even send the link for the accelerator." Relying
                // on an LLM to perfectly execute 4+ sequential tool calls
                // while also juggling other simultaneous context isn't
                // reliable enough for something this mechanical. Sending the
                // link and description directly here removes that failure
                // mode entirely — same sendCoReply/logTextExchange helpers
                // and 2s pacing convention conversationTools.ts's sendReply
                // already uses for a real second message.
                // Details, the personal reason, and the text for every match
                // are prepared, then sent in order. Each tier walks its own
                // candidates in small parallel batches, in order, until one
                // fits or they run out (2026-09-17 code review: Tier 2 can
                // return up to 6, and capping this at the first 2 per tier
                // meant a bad first pair discarded the rest, and Co said
                // nothing fit when a later candidate would have). Only the
                // winning candidate per tier gets the sonnet description draft
                // — misfits only need the (cheaper) fit check itself.
                const FIT_CHECK_BATCH = 2;
                const matchesByTier = new Map<number, TierMatch[]>();
                for (const m of recommendation.matches) {
                  const arr = matchesByTier.get(m.tier) ?? [];
                  arr.push(m);
                  matchesByTier.set(m.tier, arr);
                }
                // "What does SF tech week look like? Oct 5th - Oct 11th?" asks
                // what's on, so one per tier undersold it (2026-09-18: five real
                // events passed, one went out, and Co said it was the only one).
                // A time frame or a what's-on question gets up to three a tier.
                const searchScope = "scope" in recommendation ? recommendation.scope : null;
                const perTier = searchScope?.window || isBrowseAsk(resolvedContent) ? 3 : 1;
                const matchCount = [...matchesByTier.values()].reduce((n, c) => n + Math.min(c.length, c[0]?.tier === 1 ? 1 : perTier), 0);
                const prepStarted = Date.now();

                type PreparedMatch = { m: TierMatch; description: string; fits?: boolean; why?: string; em?: Awaited<ReturnType<typeof enrichMatch>> };

                // Drafted in Co's voice from the real record and a personal
                // reason, not the matching engine's raw "name — reason" line.
                // stretch: the fit check said it doesn't quite fit, but it's the
                // closest real thing found, so it goes out with an honest caveat
                // instead of "nothing" (2026-09-18).
                const draftDescription = async (m: TierMatch, em: Awaited<ReturnType<typeof enrichMatch>>, stretch = false): Promise<string> => {
                  let description = `${m.name}. ${em.whyItFits ?? m.reason}`;
                  try {
                    // Their why, so the caption says where this could take it (services/coVoice.ts CO_WHY).
                    const why = whyContext(await askedAndDoing());
                    const askedDates = describeTimeFrame("scope" in recommendation ? recommendation.scope : null);
                    const dateRule = dateCaveatRule(askedDates);
                    const record = em.details ? renderEventDetails(em.name, em.details).join("\n") : em.opportunity ? `What the post says: ${em.opportunity.postText}` : "";
                    const { text: drafted } = await generateText({
                      model: anthropic(MODELS.sonnet),
                      experimental_telemetry: { isEnabled: true, functionId: "sendblue.recommendation.describe" },
                      prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} ${IDENTITY_RULE} You're telling ${user.first_name ?? "them"} about "${m.name}"${"url" in m && m.url ? ". Its link preview is already showing right above this message, so this message is the caption under it: say what it is directly, and don't mention the link, sending it, or \"the one above\"" : ""}${matchCount > 1 ? `. This is one of ${matchCount} you're sending together, so it reads as a bullet in a short list` : ""}.\n\n${stretch ? `It isn't an exact fit for what they asked: ${em.whyItFits ?? "not quite what they described"}. Say that honestly in a few words, then why it could still be worth a look.` : `Why it fits them: ${em.whyItFits ?? m.reason}`}\n${record ? `\nWhat's actually known about it:\n${record}\n` : ""}${why ? `\n${why}\n` : ""}${dateRule}\nWrite ${matchCount > 1 ? "one sentence" : "1-3 sentences"} naming it, the one or two details that matter most to them (when, where), and why it fits. ${CO_WHY}${matchCount > 1 ? " Keep that to a few words in a list." : ""} Only use what's written above. No link. Return ONLY the message.`,
                    });
                    if (drafted.trim()) {
                      // No claim about who they are beyond their own words and profile (services/identityGuard.ts).
                      const grounded = stripUngroundedIdentity(cleanCoMessage(drafted.trim()), `${resolvedContent}\n${(profile?.goals ?? []).join(" ")}\n${profile?.city ?? ""}\n${em.whyItFits ?? ""}\n${why}`);
                      if (grounded) description = grounded;
                    }
                  } catch (err: any) {
                    console.error("sendblue: recommendation description drafting failed (non-fatal, sending plain):", err?.message ?? err);
                  }
                  return description;
                };

                const enrichOne = async (m: TierMatch) => {
                  const em = await enrichMatch(m, {
                    userId: user.id,
                    firstName: user.first_name,
                    askText: resolvedContent,
                    timeFrame: describeTimeFrame("scope" in recommendation ? recommendation.scope : null),
                    goals: profile?.goals ?? null,
                    city: profile?.city ?? null,
                    place: "scope" in recommendation ? (recommendation.scope?.city ?? null) : null,
                    feeling: renderEmotionalContext(emotional),
                  });
                  return { m, em };
                };

                const preparedAll: PreparedMatch[] = [];
                const tierWinners = await Promise.all(
                  [...matchesByTier.values()].map(async (candidates): Promise<PreparedMatch[]> => {
                    const tier = candidates[0]?.tier;
                    if (tier === 1) {
                      // Co's own events are always kept, no fit check.
                      const first = candidates[0];
                      if (!first) return [];
                      const { em } = await enrichOne(first);
                      const p: PreparedMatch = { m: first, description: await draftDescription(first, em), fits: em.fits, why: em.whyItFits };
                      preparedAll.push(p);
                      return [p];
                    }
                    const winners: PreparedMatch[] = [];
                    for (let i = 0; i < candidates.length && winners.length < perTier; i += FIT_CHECK_BATCH) {
                      const batch = candidates.slice(i, i + FIT_CHECK_BATCH);
                      const results = await Promise.all(batch.map(enrichOne));
                      for (const { m, em } of results) {
                        const attempted: PreparedMatch = { m, description: "", fits: em.fits, why: em.whyItFits, em };
                        preparedAll.push(attempted);
                        // Only the personal read says fits what they asked
                        // (services/eventDetails.ts fitPrompt); the first in order
                        // that fit win their tier.
                        if (winners.length < perTier && em.fits !== false) {
                          attempted.description = await draftDescription(m, em);
                          winners.push(attempted);
                        }
                      }
                    }
                    return winners;
                  }),
                );
                prepMsForTurn = Date.now() - prepStarted;
                // Best-fitting first, in the order tiers were returned.
                const prepared = tierWinners.flat();
                // What passed every check but didn't go out this turn, so the
                // reply never calls what it sent the only one (2026-09-18).
                const notSent = recommendation.matches.filter((m) => !prepared.some((p) => p.m === m) && !preparedAll.some((p) => p.m === m && p.fits === false));
                if (prepared.length && notSent.length) {
                  addFact(
                    replyFacts,
                    "known",
                    `The search also turned up ${notSent.length} more real one${notSent.length > 1 ? "s" : ""} you didn't send: ${notSent.map((m) => `"${m.name}"`).join(", ")}. Never say what you sent is the only one; if it helps, offer to send more.`,
                  );
                }
                // Nothing passed the fit check, but real things were found: send
                // the closest one with an honest caveat rather than "nothing"
                // (2026-09-18: a real event near Sep 24 was found and dropped,
                // and the member heard nothing). Only something that's the right
                // kind of thing for what they asked, off on a detail: a funding
                // story went out for "Anyone hiring a design engineer?"
                // (2026-09-18).
                // Never something outside the dates they asked about
                // (2026-09-25: "Anything good this weekend?" got Tech Week,
                // Oct 5-11, as the closest thing). That one is only named in
                // a sentence, without its link, below.
                // Nor somewhere other than where they asked (2026-09-27: "What
                // about in San Francisco?" got a Bengaluru post, undated, so
                // the date rule let it through).
                const offTarget = (p: PreparedMatch) => !!(p.em?.outsideTimeFrame || p.em?.outsidePlace);
                const closest = !prepared.length ? preparedAll.find((p) => p.em?.rightKind === true && !offTarget(p)) : undefined;
                const offWindow = !prepared.length && !closest ? preparedAll.find((p) => p.em?.rightKind === true && offTarget(p)) : undefined;
                if (offWindow) {
                  const what = offWindow.em?.outsidePlace ? "somewhere other than where they asked" : "outside the dates they asked about";
                  addFact(replyFacts, "known", `The closest real one was "${offWindow.m.name}", but it's ${what} (${offWindow.why ?? "a different time or place"}). It was NOT sent.`);
                  addInstruction(replyFacts, "Nothing fits the dates and place they asked about. Say that plainly. You may name the closest one in a short sentence with its dates and place as written in the facts, so they can decide; don't send its link unless they ask.");
                }
                if (closest?.em) {
                  closest.description = await draftDescription(closest.m, closest.em, true);
                  prepared.push(closest);
                  addInstruction(
                    replyFacts,
                    "Nothing you found matched exactly, so you sent the closest real thing with a caveat. Don't apologize for it or call it a fail; if it helps, say what you'll keep looking for.",
                  );
                }
                // Nothing survived the real fit check, but the ask might name one specific event
                // ("What's happening at AfroTech?") that tier 2's own coarse relevance gate let
                // unrelated candidates through for (2026-09-21: 8 SF Tech Week events passed that
                // gate, then all failed here). A live reply's web search is otherwise off
                // (services/namedEventLookup.ts); this is its only path to a real answer, tried
                // once, only as the true last resort.
                if (!prepared.length) {
                  // The first place when the search covered several ("Sacramento + San Francisco").
                  const scopeCity = "scope" in recommendation ? (recommendation.scope?.city?.split(" + ")[0] ?? null) : null;
                  const scopeZone = ("scope" in recommendation && recommendation.scope?.timezone) || "America/Los_Angeles";
                  const named = await lookupNamedEvent(resolvedContent, scopeCity ?? profile?.city ?? null, DateTime.now().setZone(scopeZone).toISODate() ?? DateTime.now().toISODate()!, {
                    userId: user.id,
                    source: "request",
                  }).catch((err: any) => {
                    console.error("sendblue: named event lookup failed (non-fatal):", err?.message ?? err);
                    return { match: null, name: null, blocked: null, rejected: null };
                  });
                  if (named.match) {
                    const { em } = await enrichOne(named.match);
                    const attempted: PreparedMatch = { m: named.match, description: "", fits: em.fits, why: em.whyItFits, em };
                    preparedAll.push(attempted);
                    attempted.description = await draftDescription(named.match, em, em.fits === false);
                    prepared.push(attempted);
                    addInstruction(
                      replyFacts,
                      em.fits === false
                        ? "Nothing else fit, so you looked up the named event itself and sent what its own page actually says, with an honest caveat about what's off. Don't apologize or call it a fail."
                        : "Nothing else fit, so you looked up the named event itself and sent what its own page actually says.",
                    );
                  }
                }
                if (!prepared.length) {
                  addFact(
                    replyFacts,
                    "did_this_turn",
                    `Searched just now. ${countOf(preparedAll.length, "result")} came up and none fit what they asked, so nothing was sent: ${preparedAll.map((p) => `"${p.m.name}" (${p.why ?? "not a fit"})`).join("; ")}.`,
                  );
                  addInstruction(replyFacts, "You searched and nothing that came up fits what they asked. Say that plainly and briefly. Don't send or describe the misfits unless they ask.");
                  // Save the ask before the reply, as the nothing-found branch
                  // already does (2026-09-22). It used to be saved only after
                  // the reply, by Layer 4, so the grounding check saw no open
                  // search and stripped every "I'll keep an eye out" as a false
                  // promise (5 rewrites in one day, each a wasted draft).
                  const turnAsk = await captureIntentForTurn(user.id, `${recentConversation}\nuser: ${resolvedContent}`, { timeoutMs: 4000 }).catch(() => null);
                  if (turnAsk?.ask?.text) {
                    replyFacts.facts = replyFacts.facts.filter((fact) => fact.kind !== "ongoing" && !/isn't searching for anything/.test(fact.text));
                    await addOngoingSearchFacts(replyFacts, user.id);
                  }
                  await recordSearchNote(
                    user.id,
                    `Co searched for "${resolvedContent.slice(0, 120)}" and ${countOf(preparedAll.length, "result")} came up; none fit, so nothing was sent: ${preparedAll.map((p) => `"${p.m.name}" from ${sourceOf(p.m)}${"url" in p.m && p.m.url ? `, link ${p.m.url}` : ""} (${p.why ?? "not a fit"})`).join("; ")}.`,
                  );
                }
                // What they are always comes before its link (Royce,
                // 2026-09-16: Co sent a link, then a message pointing back at
                // it). One thing: a sentence, then the link. Several: one
                // bulleted message the way the product updates read, then each
                // link on its own so every one of them previews.
                // Only what actually went out counts as sent (2026-09-17 code
                // review) — a refused or failed send used to still get logged
                // and recorded, so the reply and recommendation_offered claimed
                // something the person never received.
                const actuallySent: typeof prepared = [];
                if (prepared.length) {
                  // The results thread under their ask too, not just the hold line.
                  threadNextSend = true;
                  if (prepared.length > 1) {
                    const lead = renderMatchLead(prepared.length);
                    await threadedSendAndLog(lead, isVoice);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                  }
                  // Link first, then what it is (Royce, 2026-09-16: "I want the
                  // link first then description"), so the preview lands and the
                  // description reads as the caption under it.
                  for (const p of prepared) {
                    const { m, description } = p;
                    if ("url" in m && m.url) {
                      await threadedSendAndLog(m.url);
                      await new Promise((resolve) => setTimeout(resolve, 1500));
                    }
                    const descriptionSent = await threadedSendAndLog(description, isVoice);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    if (descriptionSent) actuallySent.push(p);
                  }
                  for (const { m, description } of actuallySent) {
                    // That it went out is a fact; what Co wrote about it is Co's own words, a hint.
                    addFact(replyFacts, "did_this_turn", `Sent "${m.name}", found through ${sourceOf(m)}${"url" in m && m.url ? ` (link ${m.url})` : " (no link)"}, just before this reply.`);
                    addHint(replyFacts, `What Co wrote about "${m.name}" when sending it: "${description}"`);
                  }
                  sentThisTurn = actuallySent.map((p) => p.m.name);
                  if (actuallySent.length) {
                    await recordSearchNote(
                      user.id,
                      `Co searched for "${resolvedContent.slice(0, 120)}" and sent ${countOf(actuallySent.length, "thing")}: ${actuallySent.map((p) => `"${p.m.name}" from ${sourceOf(p.m)}`).join("; ")}.`,
                    );
                    // recordRecommendationsSent (services/recommendation.ts)
                    // writes recommendation_offered/recommendation for exactly
                    // the matches that really went out, not everything the
                    // search found (2026-09-17 code review: generateRecommendation
                    // no longer writes these itself).
                    await recordRecommendationsSent(user.id, actuallySent.map((p) => p.m)).catch((err: any) =>
                      console.error("sendblue: recordRecommendationsSent failed (non-fatal):", err?.message ?? err),
                    );
                  }
                }
                // The agent still runs after this (see below) to genuinely
                // respond to what they said — this just tells it the
                // recommendation itself already went out, so it doesn't
                // repeat the details or the link.
                await recordDecision({
                  layer: 5,
                  decision: "recommendation.search",
                  userId: user.id,
                  outcome: actuallySent.length ? "act" : "skip",
                  action: actuallySent.length ? "sent_matches" : prepared.length ? "send_failed" : "nothing_fit",
                  proposal: { message: resolvedContent, holdLine, ms: Date.now() - searchStarted, scope: "scope" in recommendation ? recommendation.scope : null, matches: preparedAll.map((p) => ({ name: p.m.name, tier: p.m.tier, fits: p.fits ?? null, why: p.why ?? null, soldOut: p.m.details?.soldOut ?? null })) },
                });
                // Their message was only the ask: the link and caption answered
                // it, so no third message repeating them. Never when this search
                // ruled out something (the correction only goes out in the
                // reply), and never on their first real message (opening the
                // conversation and the first-contact call offer live in the
                // reply) (code review, 2026-09-16). Gated on what actually sent
                // (2026-09-17 code review), not what was merely prepared — a
                // failed send must not be treated as having answered the ask.
                const rw = "scope" in recommendation ? recommendation.scope?.rewrite : null;
                if (
                  actuallySent.length &&
                  canSkipReplyAfterResults({
                    sentResults: actuallySent.length,
                    original: rw?.original ?? null,
                    rewritten: rw?.rewritten ?? null,
                    ruledOut: ruledOut.length,
                    firstRealMessage: isFirstRealMessage || isThinProfileFirstMessage,
                    beyondAsk: decision.beyondAsk,
                  })
                ) {
                  answered = true;
                }
                if (actuallySent.length)
                  addInstruction(
                    replyFacts,
                    `You already sent them ${actuallySent.length > 1 ? "a few real things" : "something real"} for what they asked, separately from this reply; that answered the ask. Don't repeat the name, link, or details, and don't point back at it ("check it above", "just sent you one", "already sent you"). Respond only to the rest of their message${decision.beyondAsk ? `: ${decision.beyondAsk}` : ""}.`,
                  );
                else if (prepared.length) addInstruction(replyFacts, "You found something real to tell them about, but sending it just failed. Say plainly that something went wrong sending it and you'll need them to ask again in a moment, without naming what it was.");
              } else {
                // Nothing real found right now. Save what they asked for as an
                // ask so the daily search really keeps looking; that's what
                // makes "I'll keep looking" true (replyGrounding's ongoing fact).
                const turnAsk = await captureIntentForTurn(user.id, `${recentConversation}\nuser: ${resolvedContent}`, { timeoutMs: 4000 }).catch(() => null);
                // Ran past the reply's time cap: the search is still going and
                // its result gets sent when it lands (services/lateSearchResult.ts).
                const stillSearching = !recommendation.available && recommendation.reason === "search took too long";
                if (stillSearching) {
                  addFact(replyFacts, "did_this_turn", "Started a search for what they asked for. It's still running and what it finds gets sent to them as soon as it lands.");
                  addInstruction(replyFacts, "Your search is still running. Say you're still looking and will send what turns up shortly. Don't say you found nothing.");
                } else {
                  // What fits may already have been sent: say so instead of "nothing came up".
                  const sentBefore = alreadySentNames("scope" in recommendation ? recommendation.scope?.gatedOut : null);
                  if (sentBefore.length) {
                    addFact(replyFacts, "did_this_turn", `Searched just now for what they asked for. What fits is what you already sent them earlier: ${sentBefore.join("; ")}. Nothing new has turned up since.`);
                    addInstruction(replyFacts, "Tell them plainly that the ones that fit are the ones you already sent (name one or two) and nothing new has come up since. Don't say nothing came up, and don't send them again.");
                  } else addFact(replyFacts, "did_this_turn", `Searched just now for what they asked for and found nothing real that fits yet${recommendation.reason ? ` (${recommendation.reason})` : ""}.`);
                }
                await recordSearchNote(user.id, `Co searched for "${resolvedContent.slice(0, 120)}" and found nothing new${recommendation.reason ? ` (${recommendation.reason})` : ""}.`);
                if (turnAsk?.ask?.text) {
                  replyFacts.facts = replyFacts.facts.filter((fact) => fact.kind !== "ongoing" && !/isn't searching for anything/.test(fact.text));
                  await addOngoingSearchFacts(replyFacts, user.id);
                }
                await recordDecision({
                  layer: 5,
                  decision: "recommendation.search",
                  userId: user.id,
                  outcome: "skip",
                  action: turnAsk?.ask?.text ? "nothing_found_ask_saved" : "nothing_found",
                  checks: [
                    { name: "found_something_real", pass: false, reason: recommendation.reason },
                    { name: "ask_saved_for_daily_search", pass: !!turnAsk?.ask?.text, reason: turnAsk?.ask?.text ?? "no ask captured" },
                  ],
                  proposal: { message: resolvedContent, holdLine, ms: Date.now() - searchStarted, scope: "scope" in recommendation ? recommendation.scope : null },
                });
                const alreadyRecommended = ("alreadyRecommended" in recommendation ? recommendation.alreadyRecommended : null) ?? [];
                const gatedOut = ("scope" in recommendation ? recommendation.scope?.gatedOut : null) ?? [];
                if (alreadyRecommended.length) {
                  // Include the actual date, not just the name (2026-09-17
                  // code review: without it, the reply had nothing to confirm
                  // the match against and hedged into a factually wrong "but
                  // that's not [the date they asked about]" for an event that
                  // genuinely was on that date).
                  addFact(
                    replyFacts,
                    "did_this_turn",
                    `Searched again — the only real match is "${alreadyRecommended.map((m) => `${m.name}"${"event_date" in m && m.event_date ? ` on ${dayLabel(m.event_date)}` : ""}`).join(', "')}, which you already told them about earlier.`,
                  );
                  addInstruction(
                    replyFacts,
                    "You already told them about this earlier — don't say you found nothing. Say plainly that what you already mentioned is still the real answer for what they're asking now (name it by name, naturally, not as if it's new, and confirm the date matches what they asked using the date in the facts — don't guess or hedge on whether it's the same date). Don't resend its link or re-describe it in full unless they ask for the details again.",
                  );
                } else if (gatedOut.length) {
                  addFact(
                    replyFacts,
                    "did_this_turn",
                    `Found real ones but couldn't offer them: ${gatedOut.map((g) => `"${g.name}"${g.date ? ` on ${dayLabel(g.date)}` : ""}${g.url ? `, link ${g.url}` : ""} (${g.reasons.join(", ")})`).join("; ")}.`,
                  );
                  addInstruction(
                    replyFacts,
                    "You did find real things, but none you can offer as asked (for example sold out, or just outside the dates they gave). In one or two short sentences: name what you found, say the day it's on exactly as written in the facts (like \"Saturday, September 19\"), and the plain reason it didn't make the cut (for example \"it's already sold out\"). Don't blur the reason into something vaguer, and don't suggest a generic type of thing instead. If one is close, like just past their dates, say so briefly so they can ask for it if their plans change. Don't send its link unless they ask.",
                  );
                } else if (("scope" in recommendation ? recommendation.scope?.closest : null)) {
                  const closest = ("scope" in recommendation ? recommendation.scope?.closest : null)!;
                  addFact(
                    replyFacts,
                    "did_this_turn",
                    `The closest real event was "${closest.name}"${closest.date ? ` on ${dayLabel(closest.date)}` : ""}${closest.url ? `, link ${closest.url}` : ""}, but ${closest.why}.`,
                  );
                  // Presenting the SAME near-miss fresh every time a daily
                  // sweep re-runs the same ask reads like Co forgot it already
                  // said this (2026-09-17). Told once, referenced as already
                  // known after that, not represented as new each day.
                  const alreadyMentioned = await wasClosestMissRecentlyMentioned(user.id, closest.name).catch(() => false);
                  addInstruction(
                    replyFacts,
                    alreadyMentioned
                      ? "You searched again and nothing new fits what they asked. The closest real one is the same one you already told them about before — say plainly nothing new turned up, and only briefly note it's still the same option from before if it's natural, don't re-explain it from scratch like it's new."
                      : "You searched and nothing real fits what they asked. Say that plainly, then name the closest real one in a short sentence: what it is, the day it's on exactly as written in the facts (like \"Sunday, September 20\"), and why it isn't quite it, so they can decide. Don't send its link unless they ask, and don't make up anything else.",
                  );
                  if (!alreadyMentioned) {
                    recordClosestMissMentioned(user.id, closest.name, resolvedContent.slice(0, 160)).catch(() => {});
                  }
                } else {
                  addInstruction(replyFacts, "You searched and found nothing real yet. Say that plainly. Don't make up a suggestion.");
                }
              }

              // They named a time frame: once it's passed, check in on how it
              // went for them (agent/windowFollowUp.ts). Queued through the
              // proactive harness, so the daily and weekly caps and the
              // unanswered back-off all still apply.
              const scope = "scope" in recommendation ? recommendation.scope : null;
              // Optional color on the search pattern, not a directive
              // (2026-09-17, "make the outcome-learning visible, not just
              // silent"): only ever a soft fact the reply agent may weave in
              // if it actually fits this reply — never forced, never its own
              // sentence just to mention it. Only "flopped" categories are
              // worth surfacing at all; a "worked" pattern already just shows
              // up as a better search, it doesn't need narrating.
              if (scope?.categoryInsight?.flopped.length) {
                addFact(
                  replyFacts,
                  "known",
                  `${scope.categoryInsight.flopped.join(", ")}-type opportunities haven't gone anywhere for them before, based on what they've said in past follow-ups — only mention this if it genuinely fits the reply naturally (e.g. explaining why you searched wider this time), never as its own sentence.`,
                );
              }
              if (scope?.window && scope.windowEnd) {
                const timezone = profile?.city ? await getTimezoneForCity(profile.city).catch(() => null) : null;
                const dueAt = nextLocalHour(new Date(scope.windowEnd), timezone, 11);
                const payload: WindowFollowUpPayload = {
                  label: scope.window,
                  asked: resolvedContent.slice(0, 200),
                  // What they actually got, not everything the search found
                  // (2026-09-18: five were recorded, one was sent).
                  sent: sentThisTurn,
                  dates: describeTimeFrame(scope) ?? undefined,
                };
                const targetKey = `window_followup:${scope.windowEnd.slice(0, 10)}`;
                const queued = await enqueueCandidate({
                  userId: user.id,
                  type: "window_followup",
                  targetKey,
                  topicKey: targetKey,
                  summary: `Ask how ${scope.window} went for them (they asked Co to look for "${resolvedContent.slice(0, 80)}")`,
                  payload,
                  dueAt,
                  expiresAt: new Date(dueAt.getTime() + 3 * 24 * 60 * 60 * 1000),
                }).catch((err: any) => {
                  console.error("sendblue: window follow-up enqueue failed (non-fatal):", err?.message ?? err);
                  return { queued: false, error: String(err?.message ?? err) };
                });
                // Which searches produced a follow-up, and when it's due, so one
                // that never sends can be told apart from one never queued.
                await recordDecision({
                  layer: 6,
                  decision: "proactive.windowFollowUp",
                  userId: user.id,
                  outcome: queued.queued ? "act" : "skip",
                  action: queued.queued ? "queued" : "error" in queued ? "enqueue_failed" : "not_queued",
                  proposal: { targetKey, window: scope.window, windowEnd: scope.windowEnd, dueAt: dueAt.toISOString(), sent: payload.sent },
                  checks: [{ name: "queued", pass: queued.queued, reason: queued.queued ? `due ${dueAt.toISOString()}` : "error" in queued ? queued.error : "already sent or no longer pending for this time frame" }],
                }).catch(() => {});
              }
          } catch (err: any) {
            console.error("sendblue: recommendation failed (non-fatal):", err?.message ?? err);
            addFact(replyFacts, "not_done", "The search didn't finish (something went wrong).");
          }
          const newFacts = replyFacts.facts.slice(factsBefore).map((f) => `${f.kind === "not_done" ? "NOT DONE: " : ""}${f.text}`);
          const newInstructions = replyFacts.instructions.slice(instructionsBefore);
          return {
            answered,
            sentCount: sentThisTurn.length,
            briefing: [...newFacts, ...newInstructions.map((x) => `For this reply: ${x}`)].join("\n"),
          };
        };

        // Step 4.7 — Debounce the free-form reply only. Every deterministic
        // branch above this point (identity intake, OTP, call-trigger) has
        // already returned by now — those are typically single-word confirmations
        // where added latency has no upside, and some (OTP, call-triggering)
        // are actively time-sensitive, so they're deliberately never
        // delayed. Only the conversational reply below is worth waiting on,
        // since it's the one case where replying to a still-incomplete
        // thought reads as Co cutting the user off. myInboundAt is set in
        // the outer handler, before withPhoneLock, precisely so this check
        // can see a message that arrived and is now queued behind this
        // request's phone lock (see the comment there for why).
        // Ack Sendblue's webhook now, before the debounce wait and reply
        // generation below — both can legitimately take longer than
        // Sendblue's own webhook response timeout (~10s observed live).
        // Letting that timeout happen made Sendblue retry the same
        // delivery, and each retry re-ran this entire expensive path from
        // scratch — confirmed live, one inbound text produced ~5 separate
        // replies. The actual reply still goes out via sendCoReply's real
        // Sendblue send call further down, completely independent of this
        // response; this only stops Sendblue from thinking the delivery
        // itself failed. withPhoneLock below is unaffected — it still wraps
        // this whole function and still serializes same-phone processing
        // exactly as before, this just responds to the webhook earlier.
        res.status(200).send({ received: true, action: "processing" });

        // A turn that already did something visible (resolved an item, sent
        // a hold line, ran a search, sent results, saved an issue report)
        // skips the wait and never bails here (2026-09-17 code review,
        // finding #1/#5) — bailing after real side effects happened used to
        // leave the person with nothing explaining them, and the next
        // turn's facts (gatherReplyFacts) don't retroactively cover a reply
        // that never got drafted in the first place. Skipping the wait too
        // means the person isn't kept waiting on top of whatever the search
        // itself already took.
        // The wait runs from when their text arrived, not from here
        // (2026-09-26): it used to start after the router and prep, so every
        // reply paid those seconds and then 4 more. A text that lands within
        // DEBOUNCE_MS of this one still takes over the turn.
        let debounceWaitMs = 0;
        if (myInboundAt && !turnDidWork) {
          debounceWaitMs = Math.max(0, DEBOUNCE_MS - (Date.now() - new Date(myInboundAt).getTime()));
          if (debounceWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));
          const latestStampResult = await pool.query(
            `SELECT last_inbound_at FROM phone_debounce WHERE phone = $1`,
            [number],
          );
          const latestInboundAt = latestStampResult.rows[0]?.last_inbound_at ?? null;
          if (latestInboundAt && new Date(latestInboundAt).getTime() > new Date(myInboundAt).getTime()) {
            // A newer message arrived while this one waited. This
            // message's own content is already safely stored in
            // co_memories (Step 3, above), so the newer message's request
            // — next in line behind this one's phone lock — will see it as
            // conversational context and can respond to both at once. This
            // request bails out without generating or sending anything, so
            // the user doesn't get two overlapping replies. (Webhook already
            // ack'd above, nothing left to send back here.)
            return;
          }
        }

        // Step 5 — Two separate context sources, since they answer different
        // questions. Topical similarity search answers "what's relevant to
        // what they just said" but has no sense of recency or conversation
        // flow (confirmed: it once surfaced an unrelated "3pm" proposal). The
        // chronological block (recentConversation) answers "what did we just
        // say." Both were started before the router (recentMemoriesP,
        // coverageP); the context summary reads state this turn may have
        // changed, so it's read now, alongside them.
        const [recentMemories, { missingTopic, refresh: staleTopic }, contextSummary] = await Promise.all([recentMemoriesP, coverageP, buildContextSummary(user.id)]);
        const replyContextWaitMs = Date.now() - replyContextStarted;

        const toneContext = renderEmotionalContext(emotional);

        // Advisory only, same reasoning as toneContext above — reading a
        // shift the person never actually asked you to notice, not a rule.
        const seekingModeContext =
          seekingMode === "solving"
            ? `They've moved from sharing into wanting a real answer or help deciding — meet that directly. Give them your actual read, grounded in what you know about them, instead of another reflective question or a line that waits for them to ask first.`
            : "";

        let coReply: string;
        {
          // Same persona the real call uses, not a separate thinner one —
          // Co should be the same entity whether someone's talking by voice
          // or text. contextSummary reuses buildContextSummary (the exact
          // same "what Co knows about this person" builder the call channel
          // uses for its own {{context_summary}} fill), so both channels
          // stay genuinely in sync rather than each maintaining their own
          // summary of the same underlying profile. (Read in Step 5 above.)
          // Texts no longer carry the call guide (agent/conversationReply.ts,
          // 2026-09-24), so it isn't fetched from Hume on every text.
          const personaPrompt = null;

          // Step 6 — Decide + send Co's reply via the conversation-reply
          // agent (agent/conversationReply.ts). Replaces the old fixed
          // callOfferContext/topicContext branching and the separate
          // post-hoc callOfferCheck verification call — the agent now
          // decides whether to fold in a call-offer/topic-nudge gesture and
          // records that decision itself via tool calls
          // (offerCall/markTopicAsked), rather than code pre-deciding and a
          // second LLM call inferring after the fact whether the drafted
          // text happened to include one.
          const replyStarted = Date.now();
          // How they like to be texted, learned from this message against
          // Co's last one (services/textingStyle.ts). In the background, so
          // it never slows the reply; the next reply reads it.
          // How they like to be texted is learned after the reply, in the turn's one
          // learning read (services/turnLearning.ts); the next reply reads it.
          const moment = dotsP ? await dotsP : null;
          const dots = moment?.dots ?? [];
          // Messages passed between them and someone they're connected to: each
          // side knows only what the other chose to send (services/relay.ts).
          (await relayFacts(user.id).catch(() => [] as string[])).forEach((line) => addFact(replyFacts, "known", line));
          const momentNote = momentInstruction(moment);
          if (momentNote) addInstruction(replyFacts, momentNote);
          const lessons = turn?.lessons ?? [];
          if (lessons.length) addInstruction(replyFacts, `What you've learned about how to be with them, from times they corrected you: ${lessons.join(" / ")}`);
          if (moment?.lesson) saveLesson(user.id, moment.lesson).catch(() => {});
          if (moment) recordDecision({ layer: 3, decision: "reply.moment", userId: user.id, outcome: "act", action: moment.mode, proposal: { topic: moment.topic, pushback: moment.pushback, lesson: moment.lesson } }).catch(() => {});
          if (reactingToSent) {
            const why = whyContext(await askedAndDoing());
            if (why) addInstruction(replyFacts, `They're reacting to something Co sent them. ${CO_WHY} ${why}`);
          }
          const dotsNote = dotsInstruction(dots);
          if (dotsNote) {
            addInstruction(replyFacts, dotsNote);
            recordDecision({ layer: 3, decision: "reply.dots", userId: user.id, outcome: "act", action: `dots:${dots.length}`, proposal: { dots } }).catch(() => {});
          }
          const { replyText, grounding, toolsCalled } = resultsAnsweredAsk
            ? await recordDecision({
                layer: 3,
                decision: "reply.skipped",
                userId: user.id,
                outcome: "skip",
                action: "results_answered_the_ask",
                proposal: { message: resolvedContent },
                checks: [{ name: "message_was_only_the_ask", pass: true }],
              })
                .catch(() => {})
                .then(() => ({ replyText: resultsAnsweredAsk!, grounding: [] as { latencyMs: number }[], toolsCalled: [] as string[] }))
            : await propagateAttributes(
            { userId: user.id, traceName: "sendblue.generateReply" },
            () =>
              runConversationReplyAgent({
                messageHandle: typeof req.body?.message_handle === "string" ? req.body.message_handle : null,
                replyOwed: owesReply,
                safetyConcern: crisisWording,
                turn,
                searchAndSend,
                userId: user.id,
                phoneNumber: user.phone_number,
                firstName: user.first_name,
                resolvedContent,
                isVoice,
                imageForVision,
                hasPendingOffer,
                recentOfferBurstActive,
                callAction,
                isThinProfileFirstMessage,
                isFirstContact: isFirstRealMessage,
                missingTopic,
                // A stale topic reads as catching up on what's changed (services/understanding.ts).
                missingTopicDescription: staleTopic ? gapDescription(staleTopic) : missingTopic ? RAPPORT_TOPIC_DESCRIPTIONS[missingTopic] : null,
                facts: replyFacts,
                toneContext,
                seekingModeContext,
                styleHint,
                recentConversation,
                recentMemories,
                contextSummary,
                personaPrompt,
                sendCoReply: threadedSend,
              }),
          );
          coReply = replyText;
          // A reaction Co didn't record, caught after the reply (services/reactionCatchup.ts).
          if (hasText && !resultsAnsweredAsk) catchUpReaction(user.id, resolvedContent, toolsCalled ?? [], inlineTarget?.fromCo ? `${inlineTarget.text} ${inlineTarget.what ?? ""}`.trim() : null, turn?.sent).catch(() => {});
          const groundingMs = grounding.reduce((a, g) => a + g.latencyMs, 0);
          const replyMs = Date.now() - replyStarted - groundingMs;
          // Latency budget (2026-09-15: a 70s reply led to five resends).
          // Measured from when the text reached Co to the reply going out.
          if (myInboundAt) {
            const turnMs = Date.now() - new Date(myInboundAt).getTime();
            // What they actually waited, from what was logged as sent this
            // turn, whichever path sent it: the search's hold line and
            // results go out before the reply step (2026-09-27: search turns
            // logged no first-text time at all).
            const sentRows = await pool
              .query(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'Co replied:%' OR content LIKE $3) AND created_at >= $2 ORDER BY created_at LIMIT 20`, [user.id, myInboundAt, `${HOLD_PREFIX}%`])
              .then((r) => r.rows)
              .catch(() => [] as any[]);
            const rowsAsSent = sentRows.map((r: any) => ({ text: String(r.content).replace(/^Co replied:\s*/, "").replace(new RegExp(`^${HOLD_PREFIX}\\s*`), ""), at: new Date(r.created_at), hold: String(r.content).startsWith(HOLD_PREFIX) }));
            const firsts = firstSendTimes(rowsAsSent, new Date(myInboundAt), [...HOLD_LINES, ...rowsAsSent.filter((x: any) => x.hold).map((x: any) => x.text.trim())]);
            recordDecision({
              layer: 3,
              decision: "turn.latency",
              userId: user.id,
              outcome: "act",
              action: searchedThisTurn ? "reply_with_search" : "reply",
              checks: [{ name: "within_budget", pass: turnMs <= (searchedThisTurn ? REPLY_BUDGET_SEARCH_MS : REPLY_BUDGET_MS), reason: `${Math.round(turnMs / 1000)}s` }],
              // Where the time went, so slow turns can be read without
              // guessing (Royce, 2026-09-16: 36s replies).
              // firstSentMs: their text to Co's first text of any kind (a hold
              // line counts); firstAnswerMs: to the first real answer. ms runs
              // to the end of the turn, including steps after the reply went out.
              proposal: { ms: turnMs, firstSentMs: firsts.firstSentMs, firstAnswerMs: firsts.firstAnswerMs, routerMs: routerLatencyMs, factsMs, searchMs: searchMsForTurn, prepMs: prepMsForTurn, replyMs, groundingMs, debounceMs: debounceWaitMs, contextSinceStartMs: replyContextWaitMs },
            }).catch(() => {});
          }
        }

        // Fire-and-forget, the same writes a call's pipeline makes (profile,
        // asks, planned events), so a text-only member's asks reach matching
        // too. One read of the turn now (2026-09-28, services/turnLearning.ts):
        // profile fields, resolved goals/asks, corrections, call cadence, the
        // ask, a planned event and texting style, each through its own gate
        // and write, instead of seven separate calls on the same transcript.
        learnFromTextTurn({
          userId: user.id,
          recentConversation,
          message: resolvedContent,
          coReply,
          coSaidBefore: hasText ? lastCoLine(recentConversation) : null,
        }).catch((err: any) => console.error("sendblue: turn learning failed (non-fatal):", err?.message ?? err));
        // Keep the current picture of them fresh (harness/personSnapshot.ts);
        // rebuilds only when they've said something new, at most every 10 min,
        // with their open threads in the same call.
        refreshPersonSnapshot(user.id).catch(() => {});

        io.to(`user:${user.id}`).emit("co:message", { message: coReply });

        // Webhook already ack'd early, above — nothing left to send back.
        return;
      } catch (error) {
        // If the early ack above already went out, the response is done —
        // next(error) would try to send a second response and throw
        // ERR_HTTP_HEADERS_SENT. Only fall through to the normal error
        // path for a failure that happened before that ack.
        if (res.headersSent) {
          console.error("sendblue: error after early webhook ack (non-fatal, already ack'd):", (error as any)?.message ?? error);
          // They already see "Read"; don't leave them with nothing.
          if (lockKey && isGenuineInbound && !isGroupMessage) {
            await tellMemberTurnFailed(lockKey, turnStartedAt, "turn_error", (error as any)?.constructor?.name ?? "Error");
          }
          return;
        }
        next(error);
      }
      };

      try {
        // Tracked so a restart waits for a reply mid-draft (services/shutdown.ts).
        await track(lockKey ? withPhoneLock(lockKey, run) : run());
      } finally {
        if (typeof handle === "string" && handle && !req.body?.is_outbound && req.body?.type !== "typing") {
          pool.query(`UPDATE inbound_webhook_handles SET finished_at = NOW() WHERE handle = $1`, [handle]).catch(() => {});
        }
      }
    },
  );

  return router;
}

// A turn died after the text was marked read: send the one honest line
// (services/turnFailure.ts), unless Co answered anyway, they've opted out,
// or they were just told. Never throws.
export async function tellMemberTurnFailed(phone: string, receivedAt: Date, source: "turn_error" | "restart", errorClass: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.sms_opted_out, u.archived_at,
         EXISTS (
           SELECT 1 FROM co_memories r
           WHERE r.user_id = u.id AND r.memory_type = 'text_exchange' AND r.content LIKE 'Co replied:%'
             AND r.created_at > $2 AND r.content <> ALL($3::text[])
         ) AS replied,
         (SELECT MAX(n.created_at) FROM co_memories n
           WHERE n.user_id = u.id AND n.memory_type = 'text_exchange' AND n.content = $4) AS last_note_at
       FROM users u WHERE u.phone_number = $1 LIMIT 1`,
      [phone, receivedAt, HOLD_LINES.map((l) => `Co replied: ${l}`), `Co replied: ${TURN_FAILED_NOTE}`],
    );
    const row = rows[0];
    const blocked = turnFailedNoteBlocked({
      member: row ? { optedOut: !!row.sms_opted_out, archived: !!row.archived_at } : null,
      coRepliedSince: !!row?.replied,
      lastNoteAt: row?.last_note_at ? new Date(row.last_note_at) : null,
      receivedAt,
      now: new Date(),
    });
    const sent = blocked ? false : await sendAndLog(row.id, phone, TURN_FAILED_NOTE);
    await recordDecision({
      layer: 2,
      decision: "turn.failed",
      userId: row?.id ?? null,
      outcome: sent ? "act" : "skip",
      action: sent ? "told_member" : blocked ?? "send_failed",
      proposal: { source, errorClass },
      checks: [{ name: "member_not_left_silent", pass: sent || blocked === "already_answered", reason: blocked ?? (sent ? "sent the note" : "the note itself failed to send") }],
    }).catch(() => {});
    return sent;
  } catch (err: any) {
    console.error("sendblue: tellMemberTurnFailed failed:", err?.message ?? err);
    return false;
  }
}

// Inbound texts whose turn never finished (the process restarted or crashed
// mid-turn) and that never got a Co reply afterwards, so they're not lost
// silently (2026-09-17 code review). Meant to run once on startup. It never
// replays the turn (that could double-send); for a text from the last hour
// it sends the one honest "please resend" line instead (2026-09-23). Quietly
// does nothing until the payload and finished_at columns exist.
export async function reportUnfinishedTurns(): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT h.handle, h.payload, h.received_at, u.id AS user_id
       FROM inbound_webhook_handles h
       LEFT JOIN users u ON u.phone_number = h.payload->>'number'
       WHERE h.finished_at IS NULL AND h.payload IS NOT NULL
         AND h.received_at < NOW() - INTERVAL '5 minutes' AND h.received_at > NOW() - INTERVAL '1 day'
         AND NOT EXISTS (
           SELECT 1 FROM co_memories r
           WHERE r.user_id = u.id AND r.memory_type = 'text_exchange' AND r.content LIKE 'Co replied:%'
             AND r.created_at > h.received_at AND r.content <> ALL($1::text[])
         )
       LIMIT 50`,
      [HOLD_LINES.map((l) => `Co replied: ${l}`)],
    );
    for (const row of rows) {
      console.error(`sendblue: inbound text ${row.handle} never finished its turn and got no reply (user ${row.user_id ?? "unknown"})`);
      await recordDecision({
        layer: 2,
        decision: "turn.unfinished",
        userId: row.user_id ?? null,
        outcome: "skip",
        action: "never_answered",
        proposal: { handle: row.handle, message: row.payload?.content ?? null },
        checks: [{ name: "turn_finished", pass: false, reason: "the process stopped mid-turn; nobody answered this text" }],
      }).catch(() => {});
      const phone = row.payload?.number;
      const isGroup = row.payload?.message_type === "group" || !!row.payload?.group_id;
      if (typeof phone === "string" && phone && !isGroup) {
        await tellMemberTurnFailed(phone, new Date(row.received_at), "restart", "Restart");
      }
    }
    // The saved copy of each text is only for this check: drop it after two
    // days so members' messages don't pile up here.
    await pool
      .query(`UPDATE inbound_webhook_handles SET payload = NULL WHERE payload IS NOT NULL AND received_at < NOW() - INTERVAL '2 days'`)
      .catch(() => {});
    return rows.length;
  } catch (err: any) {
    console.error("sendblue: reportUnfinishedTurns skipped (payload/finished_at columns missing?):", err?.message ?? err);
    return 0;
  }
}
