import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Resend } from "resend";
import pool from "../db/db.js";
import { cleanCoMessage } from "./sendblue.js";
import { writeMemory } from "./memory.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { checkBothYes, draftWithConsent, eventOptedIn, gateIntroAction } from "../harness/introConsent.js";
import { sendExemptWhenAllowed } from "../harness/proactive.js";
import { getTimezoneForCity } from "./geocoding.js";
import { MODELS } from "../models.js";
import { getEventGuestList } from "./luma.js";
import { matchGuestsToUsers, dedupeByUserId } from "./eventScoring.js";
import { mergeWalkinsIntoGuestPool } from "./eventWalkinCheckin.js";

// This person's timezone, for the hours check on a reply-triggered direct
// ask (code review, 2026-09-17 — see sendExemptWhenAllowed).
async function timezoneFor(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]);
  const city = rows[0]?.city;
  return city ? await getTimezoneForCity(city).catch(() => null) : null;
}

// Model policy (Royce, 2026-09-14): Haiku for the narrow yes/no reads (code
// acts on them only through the consent checks); Sonnet 5 for drafts that
// name another person and for replies inside an intro thread.
const CLASSIFY_MODEL = MODELS.haiku;
const NAMING_DRAFT_MODEL = MODELS.sonnet;

// Double opt-in handoff (Royce, 2026-09-07), on top of the event-guest match
// nudge (services/eventScoring.ts). The introduction is one email to both
// people. Co never puts two people in a group text: Sendblue can only reply
// to a number that has already texted in ("Allow Inbound First" is locked on
// under the current plan), so it can't start a thread with two people, and
// the group-chat code that once lived here (2026-09-07 to 2026-09-20) never
// delivered a single thread. Removed on Royce's call, 2026-09-20. The nudge only ever
// tells ONE side about a candidate — nothing shares contact info or
// facilitates contact until BOTH people have said yes, same reasoning a
// real introduction would use: you don't hand out someone's number to a
// stranger who hasn't agreed to it.
//
// event_guest_match_nudges (already exists) doubles as "has this person
// been told about this candidate and is awaiting a reply" regardless of
// whether that nudge came from the automatic scoring pass or from a direct
// reciprocal ask triggered here once the other side opts in first — see
// maybeAskCandidateDirectly below. That's what lets the SAME pending-reply
// check in routes/sendblue.ts cover both origins with one code path.

export type MatchNudgeCandidate = {
  user_id: string;
  first_name: string;
  phone_number: string;
  email: string;
};

export type PendingMatchNudge = {
  event_id: string;
  event_name: string;
  candidate_id: string;
  candidate_first_name: string;
  candidate_phone: string;
  candidate_email: string;
  // They weren't told who (an event Co doesn't run): never name them yet.
  anonymous?: boolean;
};

// Mirrors sendblue.ts's other pending-offer lookups exactly (same
// created_at-cutoff + NOT EXISTS resolved-row pattern) — a nudge nobody
// ever answers eventually falls out of consideration rather than staying
// "pending" forever.
const MATCH_NUDGE_REPLY_EXPIRY_DAYS = 7;

// event_guest_match_nudges is keyed (event_id, person_id) — one row per
// person per event, kept current by maybeAskCandidateDirectly's UPSERT
// above (code review, 2026-09-17), so ORDER BY sent_at DESC LIMIT 1 here
// always resolves a reply against the candidate they were MOST RECENTLY
// actually asked about, never a stale one from an earlier match.
export async function findPendingMatchNudge(userId: string): Promise<PendingMatchNudge | null> {
  const { rows } = await pool.query(
    `SELECT n.event_id, n.candidate_id, n.anonymous, u.first_name AS candidate_first_name, u.phone_number AS candidate_phone, u.email AS candidate_email
     FROM event_guest_match_nudges n
     JOIN users u ON u.id = n.candidate_id
     WHERE n.person_id = $1
       AND n.event_id NOT LIKE 'network:%'
       AND n.sent_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM event_guest_match_opt_ins o
         WHERE o.event_id = n.event_id AND o.person_id = n.person_id AND o.candidate_id = n.candidate_id
       )
     ORDER BY n.sent_at DESC LIMIT 1`,
    [userId, MATCH_NUDGE_REPLY_EXPIRY_DAYS],
  );
  if (!rows[0]) return null;
  // event_name isn't stored on event_guest_match_nudges itself — pull the
  // one this same event most recently used elsewhere (event_intro_groups
  // and the nudge's own writeMemory line both had it) is overkill for a
  // classify prompt; falling back to a generic phrase here is fine, the
  // reply drafted below never repeats the event name back verbatim anyway.
  return {
    event_id: rows[0].event_id,
    event_name: "the event",
    candidate_id: rows[0].candidate_id,
    candidate_first_name: rows[0].candidate_first_name,
    candidate_phone: rows[0].candidate_phone,
    candidate_email: rows[0].candidate_email,
    anonymous: !!rows[0].anonymous,
  };
}

export type MatchNudgeReplyClassification = "interested" | "not_interested" | "unrelated";

export async function recordOptIn(
  eventId: string,
  personId: string,
  personFirstName: string,
  candidateId: string,
  candidateFirstName: string,
  status: "interested" | "declined",
): Promise<void> {
  await pool
    .query(
      `INSERT INTO event_guest_match_opt_ins (event_id, person_id, candidate_id, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, person_id, candidate_id) DO NOTHING`,
      [eventId, personId, candidateId, status],
    )
    .catch((err: any) => console.error("recordOptIn: insert failed (non-fatal):", err?.message ?? err));
  await writeMemory(
    personId,
    "event_guest_match_optin",
    `${personFirstName} ${status === "interested" ? "said yes to" : "passed on"} being introduced to ${candidateFirstName}.`,
  );
}

export async function hasReciprocalOptIn(eventId: string, personId: string, candidateId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM event_guest_match_opt_ins
     WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3 AND status = 'interested'`,
    [eventId, candidateId, personId],
  );
  return rows.length > 0;
}

// Both people said yes to each other for this event, read fresh from the
// opt-in table (never inferred from the caller's flow).
async function bothOptedIn(eventId: string, aId: string, bId: string): Promise<{ a: boolean; b: boolean }> {
  const [a, b] = await Promise.all([eventOptedIn(eventId, aId, bId), eventOptedIn(eventId, bId, aId)]);
  return { a, b };
}

async function hasPendingOrAnsweredNudge(eventId: string, personId: string, candidateId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3`,
    [eventId, personId, candidateId],
  );
  return rows.length > 0;
}

// Asymmetric case: the candidate was never independently nudged about this
// person (their own top match was someone else, or scoring hasn't reached
// them the same way) — so once the first person opts in, ask the candidate
// directly rather than silently waiting on a nudge that may never come.
// Reuses event_guest_match_nudges as the "awaiting a reply" record so
// findPendingMatchNudge picks up their answer the same way it would a
// normal scoring-driven nudge.
async function maybeAskCandidateDirectly(
  eventId: string,
  eventName: string,
  askerFirstName: string,
  candidate: MatchNudgeCandidate,
  asker: MatchNudgeCandidate,
): Promise<void> {
  if (await hasPendingOrAnsweredNudge(eventId, candidate.user_id, asker.user_id)) return; // already asked (or already answered) from their own side

  // The message tells the candidate the asker wants an intro, so that has
  // to be on record first.
  const askerOptedIn = await eventOptedIn(eventId, asker.user_id, candidate.user_id);
  const message = await draftWithConsent(
    {
      decision: "eventGuestMatchHandoff.directAsk",
      recipientId: candidate.user_id,
      preChecks: [
        askerOptedIn
          ? { name: "asker_opted_in", pass: true }
          : { name: "asker_opted_in", pass: false, reason: `${askerFirstName} has no recorded yes for this intro` },
      ],
      facts: {
        otherFirstName: askerFirstName,
        otherOptedIn: askerOptedIn,
        recipientOptedIn: false,
        recipientFirstName: candidate.first_name,
        otherPhone: asker.phone_number,
        otherEmail: asker.email,
      },
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(NAMING_DRAFT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "eventGuestMatchHandoff.directAsk.draft" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${candidate.first_name} about "${eventName}." ${askerFirstName}, who's also going, said they'd like to be introduced. Draft a short, warm text (1-2 sentences, no em dashes) letting ${candidate.first_name} know and asking if they'd be open to it too. Low-pressure, genuinely a question, not an assumption. Don't share any contact details. Return ONLY the message text.${feedback ? `\n\n${feedback}` : ""}`,
      });
      return cleanCoMessage(text.trim());
    },
  );
  if (!message) return;

  // Opt-out and local hours checked at send time, queued for the next
  // allowed hour if it's night for them (code review, 2026-09-17): this
  // used to send a raw sendblue message unconditionally, triggered by the
  // ASKER's reply, not anything this recipient just did. sendExempt (inside
  // sendExemptWhenAllowed) writes the text_exchange memory itself once
  // actually delivered, so there's no separate write needed here.
  const result = await sendExemptWhenAllowed({
    userId: candidate.user_id,
    phoneNumber: candidate.phone_number,
    type: "direct_ask",
    targetKey: `direct_ask:${eventId}:${candidate.user_id}:${asker.user_id}`,
    messages: [message],
    timezone: await timezoneFor(candidate.user_id),
  });
  if (!result.sent && !result.queued) {
    console.error(`maybeAskCandidateDirectly: send failed for ${candidate.user_id} (non-fatal):`, result.reason);
    return;
  }

  // UPSERT, not ON CONFLICT DO NOTHING (code review, 2026-09-17): the
  // recipient can already have a row here for a DIFFERENT match (an earlier
  // automatic scoring-pass nudge, or a direct ask about someone else) —
  // event_guest_match_nudges is keyed (event_id, person_id), one row per
  // person per event. DO NOTHING left that old candidate_id in place while
  // the message just sent asked about a completely different person
  // (`asker`), so a later "yes" reply resolved via findPendingMatchNudge
  // recorded the opt-in against the WRONG candidate and could connect the
  // wrong pair. hasPendingOrAnsweredNudge above already confirmed there's no
  // row specifically about (event, candidate, asker), so it's always
  // correct here to make the row reflect what they were just actually
  // asked — findPendingMatchNudge then always resolves a reply against the
  // most recent real ask.
  await pool
    .query(
      `INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, person_id) DO UPDATE SET candidate_id = EXCLUDED.candidate_id, score = EXCLUDED.score, sent_at = NOW()`,
      [eventId, candidate.user_id, asker.user_id, 100],
    )
    .catch((err: any) => console.error("maybeAskCandidateDirectly: nudge-row upsert failed (non-fatal):", err?.message ?? err));
}

// The introduction itself (Royce, 2026-09-07). One email, both people as
// recipients: the classic double-opt-in warm-intro convention, where each
// already has the other's email visible — rather than two separate
// one-sided emails.
// Reuses otpActions.ts's ALLOW_REAL_SENDS gate directly instead of its
// sendEmail (that function is a tightly-coupled dispatcher for a fixed set
// of existing templates — appsubmit/welcome/otp/etc — not a generic
// send-anything utility, so a new Resend call here is more honest than
// bolting an unrelated template onto it).
async function sendIntroEmail(eventId: string, eventName: string, a: MatchNudgeCandidate, b: MatchNudgeCandidate): Promise<boolean> {
  const { a: aYes, b: bYes } = await bothOptedIn(eventId, a.user_id, b.user_id);
  if (!(await gateIntroAction(a.user_id, "eventGuestMatchHandoff.introEmail", [checkBothYes(aYes, bYes)], { eventId, b: b.user_id }))) return false;

  const subject = `Introducing ${a.first_name} and ${b.first_name}`;
  const html = `<p>Hi both,</p><p>Figured you two should actually meet before ${eventName} — you're both on my radar for it, so consider this your intro. Take it from here!</p><p>— Co</p>`;
  if (!ALLOW_REAL_SENDS) {
    console.log(`[sendIntroEmail stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${a.email}, ${b.email}: ${subject}`);
  } else {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Co cc'd (Royce, 2026-09-07: "Co would need to be the driver of the
      // email") — visibly present so a reply-all naturally includes it.
      const { error } = await resend.emails.send({ from: "Co <hello@copatible.com>", to: [a.email, b.email], cc: ["hello@copatible.com"], subject, html });
      if (error) throw new Error(error.message);
    } catch (err: any) {
      console.error("sendIntroEmail: send failed (non-fatal):", err?.message ?? err);
      return false;
    }
  }
  await writeMemory(a.user_id, "event_intro_email_sent", `Sent an intro email connecting ${a.first_name} and ${b.first_name} ahead of "${eventName}".`);
  await writeMemory(b.user_id, "event_intro_email_sent", `Sent an intro email connecting ${a.first_name} and ${b.first_name} ahead of "${eventName}".`);
  return true;
}

export type ResolvedEventGuest = { eventId: string; eventName: string; target: MatchNudgeCandidate } | { error: string };

// Resolves "I met Sarah" to a real guest at the member's most recent Co
// event — event_checkin_followups is scheduled as soon as their
// registration is known (services/eventCheckinFollowUp.ts), before the
// event even starts, so this also covers "still at the event right now."
// Known limitation, not built here: always the MOST RECENT event, never one
// they name explicitly ("at the one last month") — not added speculatively,
// this is the case that actually came up.
export async function resolveNamedEventGuest(userId: string, nameGuess: string): Promise<ResolvedEventGuest> {
  const { rows: recent } = await pool.query(
    `SELECT event_api_id, event_name FROM event_checkin_followups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!recent[0]) return { error: "no recent Co event on file for them to have met someone at" };
  const eventId: string = recent[0].event_api_id;
  const eventName: string = recent[0].event_name;

  const [guests, walkins] = await Promise.all([
    getEventGuestList(eventId).then(matchGuestsToUsers).catch(() => []),
    mergeWalkinsIntoGuestPool(eventId).catch(() => []),
  ]);
  const guestPool = dedupeByUserId([...guests, ...walkins]).filter((g) => g.user_id !== userId);

  const needle = nameGuess.trim().toLowerCase();
  if (!needle) return { error: "no name given" };
  const matches = guestPool.filter((g) => {
    const name = g.first_name.trim().toLowerCase();
    return name === needle || name.startsWith(needle) || needle.startsWith(name);
  });
  if (!matches.length) return { error: `couldn't find anyone named "${nameGuess}" on the guest list for "${eventName}"` };
  if (matches.length > 1) return { error: `more than one "${nameGuess}" was at "${eventName}" — ask which one, or something else about them, to tell them apart` };

  const g = matches[0];
  return { eventId, eventName, target: { user_id: g.user_id, first_name: g.first_name, phone_number: g.phone_number, email: g.email } };
}

// A member naming someone Co never nudged them about (Royce, 2026-09-22:
// "if someone they met during the event was not recommended Co can still
// intro that person"). requester has already told Co they want this — that
// IS their opt-in, read the same way a "yes" reply to a real nudge is — so
// this records it directly rather than waiting for a nudge Co never sent.
// Everything after that reuses the exact same double opt-in machinery as a
// real match: reciprocal check, direct ask to the other side, email intro
// once both have said yes. See agent/conversationTools.ts's
// requestEventIntro tool for where this is actually called from.
export async function requestIntroToNamedGuest(
  eventId: string,
  eventName: string,
  requester: MatchNudgeCandidate,
  target: MatchNudgeCandidate,
): Promise<boolean> {
  await recordOptIn(eventId, requester.user_id, requester.first_name, target.user_id, target.first_name, "interested");

  if (await hasReciprocalOptIn(eventId, requester.user_id, target.user_id)) {
    return sendIntroEmail(eventId, eventName, requester, target);
  }
  await maybeAskCandidateDirectly(eventId, eventName, requester.first_name, target, requester);
  return true;
}

// Entry point called from routes/sendblue.ts once a reply to a pending
// match nudge is classified. Handles both directions: person is the one
// who just replied, candidate is who the nudge was about.
export async function handleMatchNudgeReply(
  eventId: string,
  eventName: string,
  classification: MatchNudgeReplyClassification,
  person: MatchNudgeCandidate,
  candidate: MatchNudgeCandidate,
): Promise<void> {
  if (classification === "unrelated") return;

  await recordOptIn(
    eventId,
    person.user_id,
    person.first_name,
    candidate.user_id,
    candidate.first_name,
    classification === "interested" ? "interested" : "declined",
  );
  if (classification !== "interested") return;

  if (await hasReciprocalOptIn(eventId, person.user_id, candidate.user_id)) {
    // Both said yes: introduce them by email. There is deliberately no
    // "text instead" option (see the note at the top of this file).
    await sendIntroEmail(eventId, eventName, person, candidate);
  } else {
    await maybeAskCandidateDirectly(eventId, eventName, person.first_name, candidate, person);
  }
}
