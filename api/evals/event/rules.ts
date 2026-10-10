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
// The end-of-event pass fires near the end of the event, not hours later.
// Since 2026-10-07 it is due a little before the cutoff where
// maybeSendMatchNudge stops sending (the cutoff + one cron period +
// delivery), so its own pair nudges can still go out, and never so late it
// reads as a next-day afterthought.
{
  const followUp = readFileSync(new URL("../../src/services/eventUnmatchedFollowUp.ts", import.meta.url), "utf8");
  c(/MATCH_NUDGE_END_CUTOFF_MINUTES/.test(followUp), "scheduling reuses the same end-cutoff constant as the real match nudge");
  // 2026-10-07: due a full cron period plus delivery time BEFORE the cutoff, so its pair nudges can still send.
  c(/new Date\(withEnd\(eventTiming\)\.end_at\)\.getTime\(\) - UNMATCHED_SEND_BEFORE_END_MINUTES \* 60_000/.test(followUp) && /UNMATCHED_SEND_BEFORE_END_MINUTES = MATCH_NUDGE_END_CUTOFF_MINUTES \+ UNMATCHED_CRON_MINUTES \+ \d+/.test(followUp), "the send time is end_at minus (the cutoff + a cron period + delivery), not end_at plus hours");
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
  c(/if \(matches\.length !== 1\) return \{ error:/.test(handoff), "two guests with the same full name is refused, not guessed");
  c(/if \(!guestPool\.length\) return \{ error:/.test(handoff) && /if \(!last\) return \{ needsDetail: true \}/.test(handoff), "no guest matching the name is refused, not invented, and nobody is looked up without a full name");
  c(/g\.user_id !== userId/.test(handoff), "the requester themselves is excluded from their own guest-list search");
}

// The conversational tool only acts on a real resolved guest, and tells the
// model to say so plainly rather than guess when nothing resolves.
{
  const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  c(/requestEventIntro: tool\(\{/.test(tools), "the requestEventIntro tool exists");
  c(/const resolved = await resolveNamedEventGuest\(ctx\.userId, personName, lastName\)/.test(tools), "it resolves against the real guest list, not a guess from the model");
  c(/if \("error" in resolved\)/.test(tools), "an unresolved name returns the real error instead of proceeding");
  c(/Nothing happens unless both say yes/.test(tools), "the tool's own success fact is honest that this isn't instant or guaranteed");
}

// ---------------------------------------------------------------------------
// No cross-member leaks (Royce, 2026-09-22: "We can't have someone's
// information being pulled from another conversation").
{
  const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  const introTool = tools.slice(tools.indexOf("requestEventIntro: tool({"), tools.indexOf("markTopicAsked: tool({"));
  c(!/couldn't find anyone named|on the guest list for/.test(introTool), "the intro tool never tells the asker whether a named person was found on a guest list");
  c((introTool.match(/Never confirm or deny that the person is someone you know, is a Co member, or was on the guest list/g) ?? []).length === 2, "found and not-found get the same neutral answer, so neither reveals membership");
  c(/don't say whether you know anyone by that first name, how many, or whether they were there/.test(introTool), "asking for the last name never reveals whether, or how many, people have that name");

  const pairPrompt = unmatchedPairPrompt({ recipientFirstName: "Jordan", otherFirstName: "Ellis", eventName: "Cache Me Outside", shareReason: "both building in climate tech", feedback: null });
  c(!/didn't come up as a strong match for anyone|also didn't/i.test(pairPrompt), "the pair prompt never tells the model the other person had no match");
  c(/Say nothing at all about Ellis's night, matches, or situation/.test(pairPrompt), "the pair prompt forbids describing the other person's night");

  const es = readFileSync(new URL("../../src/services/eventScoring.ts", import.meta.url), "utf8");
  c(!/neither had a strong match/.test(es), "the pairing memory (read back into the member's own replies) carries nothing about the other person's night");
  c(/if \(!\(await gateShareReason\(person\.user_id, candidate\.user_id, top\.shareReason/.test(es), "every nudge, pairing included, still passes the share-reason privacy gate");

  const sr = readFileSync(new URL("../../src/services/searchRules.ts", import.meta.url), "utf8");
  c(/return \[\s*k\.userId \?\? "anon",/.test(sr), "the search cache is keyed per member, so one member's cached trace never reaches another");
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

// Saved finds and queued offers only while their ask is open (2026-09-26:
// a closed "chess this weekend" ask kept feeding chess meetups into every search).
{
  const sweepSrc = readFileSync(new URL("../../src/services/eventSurfacingSweep.ts", import.meta.url), "utf8");
  const regSrc = readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8");
  c(/FROM event_backlogs b WHERE b\.user_id = \$1 AND \$\{ASK_STILL_OPEN\("b\.ask_id"\)\}/.test(sweepSrc), "saved finds from a closed ask stop coming back");
  c(/\$\{ASK_STILL_OPEN\("pc\.payload->>'askId'"\)\}/.test(sweepSrc), "queued offers from a closed ask stop coming back");
  c(/if \(!\(await askStillOpen\(p\.askId\)\)\) return \{ skip: "their ask has since closed" \};/.test(regSrc), "a queued offer isn't sent once its ask has closed");
  c(/ASK_STILL_OPEN = \(col: string\) =>\s*`\(\$\{col\} = '\$\{PROFILE_ASK_ID\}' OR \$\{col\} IS NULL/.test(sweepSrc), "profile-based finds (no ask) still count");
}

console.log(`event rules: ${cases.length - cases.filter(([ok]) => !ok).length}/${cases.length} passed`);
const failed = cases.filter(([ok]) => !ok);
if (failed.length) {
  for (const [, label] of failed) console.log(`FAIL ${label}`);
  process.exitCode = 1;
}
