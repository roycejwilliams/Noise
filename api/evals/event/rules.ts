// Model-free checks for "no one should feel left out" (Royce, 2026-09-22):
// the end-of-event unmatched follow-up (pairing the leftovers, an honest
// solo acknowledgment) and the member-initiated intro for someone Co never
// recommended. No API calls, no database: npx tsx evals/event/rules.ts
import "dotenv/config";
import { readFileSync } from "fs";
import { unmatchedPairPrompt, matchNudgePrompt } from "../../src/services/eventScoring.js";

const cases: [boolean, string][] = [];
const c = (ok: boolean, label: string) => cases.push([ok, label]);

// ---------------------------------------------------------------------------
// The paired-leftovers message must never read as a confident match — that
// framing is earned by MATCH_NUDGE_MIN_SCORE, which this pool never cleared.
{
  const pairPrompt = unmatchedPairPrompt({ recipientFirstName: "Jordan", otherFirstName: "Ellis", eventName: "Cache Me Outside", shareReason: "both building in climate tech", feedback: null });
  c(/NOT a confident/i.test(pairPrompt), "the pair prompt explicitly rules out confident-match framing");
  c(/don't (call it a match|oversell)/i.test(pairPrompt), "the pair prompt tells the model not to oversell it");
  c(!/worth them meeting/i.test(pairPrompt), "the pair prompt never uses matchNudgePrompt's confident phrase");
  const realPrompt = matchNudgePrompt({ recipientFirstName: "Jordan", otherFirstName: "Ellis", eventName: "Cache Me Outside", shareReason: "both building in climate tech", feedback: null });
  c(/worth them meeting/i.test(realPrompt) && !/NOT a confident/i.test(realPrompt), "a real match nudge is unchanged, still confident");
  c(pairPrompt !== realPrompt, "the two prompts are genuinely different, not aliases of each other");
}

// ---------------------------------------------------------------------------
// The score gate bypass is scoped to the new pass only — a normal live
// scoring pass (no honestLowConfidence) must still require the real
// threshold, so this never quietly loosens what counts as a real match.
{
  const es = readFileSync(new URL("../../src/services/eventScoring.ts", import.meta.url), "utf8");
  c(/if \(top\.score < MATCH_NUDGE_MIN_SCORE && !opts\.honestLowConfidence\) return false;/.test(es), "the score gate only bypasses when honestLowConfidence is explicitly set");
  c(/opts\.honestLowConfidence \? unmatchedPairPrompt : matchNudgePrompt/.test(es), "the draft picks the honest prompt only for the honestLowConfidence path");
  c(/export function unmatchedPairPrompt/.test(es), "unmatchedPairPrompt is exported for evals");
}

// ---------------------------------------------------------------------------
// The end-of-event pass fires near the end of the event, not hours later —
// same cutoff maybeSendMatchNudge itself stops sending real matches at, so
// this never arrives before Co would've had one more real chance to match
// them, and never so late it reads as a next-day afterthought.
{
  const followUp = readFileSync(new URL("../../src/services/eventUnmatchedFollowUp.ts", import.meta.url), "utf8");
  c(/MATCH_NUDGE_END_CUTOFF_MINUTES/.test(followUp), "scheduling reuses the same end-cutoff constant as the real match nudge");
  c(/new Date\(eventTiming\.end_at\)\.getTime\(\) - MATCH_NUDGE_END_CUTOFF_MINUTES \* 60_000/.test(followUp), "the send time is end_at minus the cutoff, not end_at plus hours");
  c(!/CHECKIN_FOLLOWUP_DELAY_HOURS/.test(followUp), "this isn't the +3h debrief cadence — it's meant to still read as during the event");
}

// A person already matched, or already told once, is never processed again.
{
  const followUp = readFileSync(new URL("../../src/services/eventUnmatchedFollowUp.ts", import.meta.url), "utf8");
  c(/wasAlreadyNudgedForMatch\(eventId, person\.user_id\)\) && !\(await wasAlreadyNoticed/.test(followUp), "the unmatched pool excludes anyone already nudged or already noticed");
  c(/stillUnmatched\.length >= 2/.test(followUp), "pairing only runs the group scoring pass with two or more people to pair");
}

// ---------------------------------------------------------------------------
// A member-named intro reuses the real double opt-in machinery end to end —
// no separate, weaker consent path for a self-initiated request.
{
  const handoff = readFileSync(new URL("../../src/services/eventGuestMatchHandoff.ts", import.meta.url), "utf8");
  c(/export async function requestIntroToNamedGuest/.test(handoff), "requestIntroToNamedGuest is exported");
  c(/await recordOptIn\(eventId, requester\.user_id, requester\.first_name, target\.user_id, target\.first_name, "interested"\);/.test(handoff), "the requester's ask itself is recorded as their real opt-in");
  c(/hasReciprocalOptIn\(eventId, requester\.user_id, target\.user_id\)/.test(handoff), "it checks for the other side's opt-in before ever sending an intro email");
  c(/await maybeAskCandidateDirectly\(eventId, eventName, requester\.first_name, target, requester\)/.test(handoff), "without a reciprocal yes yet, it asks the other side, it never emails unilaterally");

  // The name resolver only trusts a real guest list — it must never invent
  // a person or silently guess between two people with the same first name.
  c(/export async function resolveNamedEventGuest/.test(handoff), "resolveNamedEventGuest is exported");
  c(/matches\.length > 1\) return \{ error:/.test(handoff), "two guests with the same name is refused, not guessed");
  c(/!matches\.length\) return \{ error:/.test(handoff), "no guest matching the name is refused, not invented");
  c(/g\.user_id !== userId/.test(handoff), "the requester themselves is excluded from their own guest-list search");
}

// The conversational tool only acts on a real resolved guest, and tells the
// model to say so plainly rather than guess when nothing resolves.
{
  const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  c(/requestEventIntro: tool\(\{/.test(tools), "the requestEventIntro tool exists");
  c(/const resolved = await resolveNamedEventGuest\(ctx\.userId, personName\)/.test(tools), "it resolves against the real guest list, not a guess from the model");
  c(/if \("error" in resolved\)/.test(tools), "an unresolved name returns the real error instead of proceeding");
  c(/Tell them plainly, don't guess who they mean\./.test(tools), "the tool tells the model not to guess when the name doesn't resolve");
  c(/only connect them once both say yes/.test(tools), "the tool's own success note is honest that this isn't instant or guaranteed");
}

// ---------------------------------------------------------------------------
// The migration and cron wiring exist, so scheduling and processing are
// actually reachable, not just defined.
{
  const migrations = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
  c(/CREATE TABLE IF NOT EXISTS event_unmatched_followups/.test(migrations), "event_unmatched_followups table is migrated");
  c(/CREATE TABLE IF NOT EXISTS event_unmatched_notices/.test(migrations), "event_unmatched_notices table is migrated");
  c(/UNIQUE \(event_api_id, user_id\)/.test(migrations.slice(migrations.indexOf("event_unmatched_followups"))), "scheduling is idempotent per (event, user)");

  const jobs = readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  c(/processDueUnmatchedFollowUps/.test(jobs), "the due-queue processor is wired into a cron");

  const es = readFileSync(new URL("../../src/services/eventScoring.ts", import.meta.url), "utf8");
  c(/scheduleUnmatchedFollowUp\(eventId, resolvedName, matched, eventTiming, opts\)/.test(es), "scheduling is triggered from the same place the real scoring pass runs");
}

console.log(`event rules: ${cases.length - cases.filter(([ok]) => !ok).length}/${cases.length} passed`);
const failed = cases.filter(([ok]) => !ok);
if (failed.length) {
  for (const [, label] of failed) console.log(`FAIL ${label}`);
  process.exitCode = 1;
}
