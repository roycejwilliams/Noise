import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Resend } from "resend";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { writeMemory } from "./memory.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { checkBothYes, draftWithConsent, eventOptedIn, gateIntroAction } from "../harness/introConsent.js";
import { MODELS } from "../models.js";

// Model policy (Royce, 2026-09-14): Haiku for the narrow yes/no reads (code
// acts on them only through the consent checks); Sonnet 5 for drafts that
// name another person and for replies inside an intro thread.
const CLASSIFY_MODEL = MODELS.haiku;
const NAMING_DRAFT_MODEL = MODELS.sonnet;

// Double opt-in handoff (Royce, 2026-09-07 — "should Co make a group chat
// once they've been opted in", "sit in the group chat as like a personal
// agent, not replying until it's asked a question"), on top of the
// event-guest match nudge (services/eventScoring.ts). The nudge only ever
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
};

// Mirrors sendblue.ts's other pending-offer lookups exactly (same
// created_at-cutoff + NOT EXISTS resolved-row pattern) — a nudge nobody
// ever answers eventually falls out of consideration rather than staying
// "pending" forever.
const MATCH_NUDGE_REPLY_EXPIRY_DAYS = 7;

export async function findPendingMatchNudge(userId: string): Promise<PendingMatchNudge | null> {
  const { rows } = await pool.query(
    `SELECT n.event_id, n.candidate_id, u.first_name AS candidate_first_name, u.phone_number AS candidate_phone, u.email AS candidate_email
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

  try {
    await sendblue.messages.send({
      number: candidate.phone_number,
      content: message,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error("maybeAskCandidateDirectly: send failed (non-fatal):", err?.message ?? err);
    return;
  }

  // Confirmed live, 2026-09-07: without this, a bare "yes" reply to this
  // exact message is unresolvable — routes/sendblue.ts's recentConversation
  // is built only from co_memories.text_exchange rows, and this send used
  // to leave no trace there. Match its "Co replied: ..." convention exactly
  // so the classifier can see what was just asked.
  await writeMemory(candidate.user_id, "text_exchange", `Co replied: ${message}`).catch((err: any) =>
    console.error("maybeAskCandidateDirectly: text_exchange log failed (non-fatal):", err?.message ?? err),
  );

  await pool
    .query(
      `INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, person_id) DO NOTHING`,
      [eventId, candidate.user_id, asker.user_id, 100],
    )
    .catch((err: any) => console.error("maybeAskCandidateDirectly: nudge-row insert failed (non-fatal):", err?.message ?? err));
}

// The actual handoff, once both sides are genuinely in — a real Sendblue
// group iMessage thread, not a simulated one. Sendblue's group API only
// exposes add_recipient, no leave/remove-self (confirmed live, 2026-09-07),
// so Co staying in the group afterward is the deliberate design, not a
// workaround: it sits quietly and only replies when directly addressed
// (see handleGroupMessage below), same "silence by default" instinct as
// companionCheckin.ts.
async function createIntroGroup(
  eventId: string,
  eventName: string,
  a: MatchNudgeCandidate,
  b: MatchNudgeCandidate,
): Promise<void> {
  const { a: aYes, b: bYes } = await bothOptedIn(eventId, a.user_id, b.user_id);
  if (!(await gateIntroAction(a.user_id, "eventGuestMatchHandoff.introGroup", [checkBothYes(aYes, bYes)], { eventId, b: b.user_id }))) return;

  const introText = `Hey both — ${a.first_name}, ${b.first_name} — figured you two should actually meet before ${eventName}. I'll mostly stay out of the way here, but say the word if you ever want me for anything.`;
  let groupId: string | undefined;
  try {
    const response: any = await sendblue.groups.sendMessage({
      content: cleanCoMessage(introText),
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      numbers: [a.phone_number, b.phone_number],
    });
    groupId = response?.group_id ?? response?.data?.group_id;
  } catch (err: any) {
    console.error("createIntroGroup: send failed (non-fatal):", err?.message ?? err);
    return;
  }
  if (!groupId) {
    console.error("createIntroGroup: no group_id in Sendblue response, can't track this group for future replies");
    return;
  }

  await pool
    .query(
      `INSERT INTO event_intro_groups (group_id, event_id, event_name, person_a_id, person_b_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id) DO NOTHING`,
      [groupId, eventId, eventName, a.user_id, b.user_id],
    )
    .catch((err: any) => console.error("createIntroGroup: event_intro_groups insert failed (non-fatal):", err?.message ?? err));

  await writeMemory(a.user_id, "event_intro_group_created", `Connected ${a.first_name} and ${b.first_name} in a group chat ahead of "${eventName}".`);
  await writeMemory(b.user_id, "event_intro_group_created", `Connected ${a.first_name} and ${b.first_name} in a group chat ahead of "${eventName}".`);
}

// Email alternative to the group chat (Royce, 2026-09-07: "Co should give
// them 2 options -> connect by phone or email"). One email, both people as
// recipients — the classic double-opt-in warm-intro convention (each
// already has the other's email visible, same as a group thread gives each
// person the other's number) — rather than two separate one-sided emails.
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

// Asks whoever's "yes" completes the reciprocal opt-in how they'd like to
// connect, rather than assuming a group chat — see event_intro_method_
// pending's migration comment. Only the completing person is asked; their
// answer decides the medium for both, same as they're the one whose
// message actually closes the loop.
async function askConnectionMethod(eventId: string, askedPerson: MatchNudgeCandidate, other: MatchNudgeCandidate): Promise<void> {
  const { a: aYes, b: bYes } = await bothOptedIn(eventId, askedPerson.user_id, other.user_id);
  if (!(await gateIntroAction(askedPerson.user_id, "eventGuestMatchHandoff.askMethod", [checkBothYes(aYes, bYes)], { eventId, other: other.user_id }))) return;
  const message = cleanCoMessage(`Want me to connect you two by text or would email work better?`);
  try {
    await sendblue.messages.send({ number: askedPerson.phone_number, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  } catch (err: any) {
    console.error("askConnectionMethod: send failed (non-fatal):", err?.message ?? err);
    return;
  }
  await pool
    .query(
      `INSERT INTO event_intro_method_pending (event_id, person_id, candidate_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, person_id, candidate_id) DO NOTHING`,
      [eventId, askedPerson.user_id, other.user_id],
    )
    .catch((err: any) => console.error("askConnectionMethod: pending insert failed (non-fatal):", err?.message ?? err));
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
    // Skips the text/email choice and goes straight to email (Royce,
    // 2026-09-07: "if we can't do group chat accurately... I don't want
    // it"). Confirmed live: Sendblue's "Allow Inbound First" is locked on
    // under the current plan, so createIntroGroup fails on any brand-new
    // thread — offering "text" as a real choice when it silently can't
    // deliver is worse than not offering it. askConnectionMethod/
    // createIntroGroup stay in place, dormant, to re-enable once that
    // plan restriction is resolved.
    await sendIntroEmail(eventId, eventName, person, candidate);
  } else {
    await maybeAskCandidateDirectly(eventId, eventName, person.first_name, candidate, person);
  }
}

export type PendingMethodChoice = {
  event_id: string;
  event_name: string;
  a: MatchNudgeCandidate;
  b: MatchNudgeCandidate;
};

const METHOD_CHOICE_EXPIRY_DAYS = 3;

export async function findPendingMethodChoice(userId: string): Promise<PendingMethodChoice | null> {
  const { rows } = await pool.query(
    `SELECT p.event_id, p.candidate_id,
            ua.first_name AS a_first_name, ua.phone_number AS a_phone, ua.email AS a_email,
            ub.first_name AS b_first_name, ub.phone_number AS b_phone, ub.email AS b_email
     FROM event_intro_method_pending p
     JOIN users ua ON ua.id = p.person_id
     JOIN users ub ON ub.id = p.candidate_id
     WHERE p.person_id = $1
       AND p.asked_at > NOW() - ($2 || ' days')::interval
     ORDER BY p.asked_at DESC LIMIT 1`,
    [userId, METHOD_CHOICE_EXPIRY_DAYS],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    event_id: r.event_id,
    event_name: "the event",
    a: { user_id: userId, first_name: r.a_first_name, phone_number: r.a_phone, email: r.a_email },
    b: { user_id: r.candidate_id, first_name: r.b_first_name, phone_number: r.b_phone, email: r.b_email },
  };
}

export type MethodChoiceClassification = "phone" | "email" | "unclear";

export async function handleMethodChoiceReply(pending: PendingMethodChoice, classification: MethodChoiceClassification): Promise<void> {
  if (classification === "unclear") return;
  await pool
    .query(`DELETE FROM event_intro_method_pending WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3`, [
      pending.event_id,
      pending.a.user_id,
      pending.b.user_id,
    ])
    .catch((err: any) => console.error("handleMethodChoiceReply: pending delete failed (non-fatal):", err?.message ?? err));

  if (classification === "phone") {
    await createIntroGroup(pending.event_id, pending.event_name, pending.a, pending.b);
  } else {
    await sendIntroEmail(pending.event_id, pending.event_name, pending.a, pending.b);
  }
}

// Group-message handling — entirely separate from the normal 1:1
// conversation pipeline. Co only ever speaks here when directly mentioned
// by name; every other group message is read (implicitly, via Sendblue's
// own delivery) and ignored, never treated as a personal conversational
// turn the way a 1:1 text would be.
const MENTION_PATTERN = /\bco\b/i;

export async function isTrackedIntroGroup(groupId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_intro_groups WHERE group_id = $1`, [groupId]);
  return rows.length > 0;
}

export async function handleGroupMessage(groupId: string, senderNumber: string, content: string): Promise<void> {
  if (!MENTION_PATTERN.test(content)) return; // not addressed to Co — stay quiet, this is the default

  const { rows } = await pool.query(
    `SELECT eig.event_name, eig.event_id, eig.person_a_id, eig.person_b_id,
            ua.first_name AS a_first_name, ua.phone_number AS a_phone,
            ub.first_name AS b_first_name, ub.phone_number AS b_phone
     FROM event_intro_groups eig
     JOIN users ua ON ua.id = eig.person_a_id
     JOIN users ub ON ub.id = eig.person_b_id
     WHERE eig.group_id = $1`,
    [groupId],
  );
  const group = rows[0];
  if (!group) return; // not a group Co is tracking

  // Co only speaks in a thread for a pair that both said yes.
  const { a: aYes, b: bYes } = await bothOptedIn(group.event_id, group.person_a_id, group.person_b_id);
  if (!(await gateIntroAction(group.person_a_id, "eventGuestMatchHandoff.groupReply", [checkBothYes(aYes, bYes)], { groupId }))) return;

  const senderFirstName = senderNumber === group.a_phone ? group.a_first_name : senderNumber === group.b_phone ? group.b_first_name : null;

  let reply: string;
  try {
    const { text } = await generateText({
      model: anthropic(NAMING_DRAFT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "eventGuestMatchHandoff.groupReply" },
      prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're sitting quietly in a group iMessage thread with ${group.a_first_name} and ${group.b_first_name} — you introduced them ahead of "${group.event_name}" and mostly stay out of their actual conversation, only speaking when directly addressed, which just happened.

${senderFirstName ? `${senderFirstName} just said: "${content}"` : `Someone in the group just said: "${content}"`}

Reply briefly and naturally, like someone who's still around but never trying to take over the conversation between them. Ground everything only in what's actually in this message — you don't have any other context about their conversation so far. No em dashes, 1-2 sentences unless they genuinely asked something that needs more room. Return ONLY the reply text.`,
    });
    reply = cleanCoMessage(text.trim());
  } catch (err: any) {
    console.error("handleGroupMessage: reply draft failed (non-fatal):", err?.message ?? err);
    return;
  }

  try {
    await sendblue.groups.sendMessage({
      group_id: groupId,
      content: reply,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error("handleGroupMessage: send failed (non-fatal):", err?.message ?? err);
  }
}
