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
import { CO_EMAIL_FROM } from "./emailFrom.js";
import { galleryEmail } from "./emailDesign.js";

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
  // Which offer this reply answers (services/inRoomOffers.ts). An additive offer is about no one yet: candidate_* are
  // empty and candidate_ids holds who arrived, named only after their yes and the share gate (handleAdditiveReply).
  kind?: "nudge" | "direct_ask" | "additive";
  candidate_ids?: string[];
  asked_at?: Date | null;
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
  // The offer they were asked most recently and haven't answered, per pair (services/inRoomOffers.ts).
  const offer = await (await import("./inRoomOffers.js")).latestOpenOffer(userId).catch(() => null);
  if (offer?.kind === "additive") {
    return { event_id: offer.event_id, event_name: offer.event_name ?? "the event", candidate_id: "", candidate_first_name: "", candidate_phone: "", candidate_email: "", anonymous: true, kind: "additive", candidate_ids: offer.candidate_ids ?? [], asked_at: offer.opened_at };
  }
  if (offer?.candidate_id) {
    const { rows: who } = await pool.query(`SELECT first_name, phone_number, email FROM users WHERE id = $1`, [offer.candidate_id]);
    if (who[0]) return { event_id: offer.event_id, event_name: offer.event_name ?? "the event", candidate_id: offer.candidate_id, candidate_first_name: who[0].first_name, candidate_phone: who[0].phone_number, candidate_email: who[0].email, anonymous: false, kind: offer.kind, asked_at: offer.opened_at };
  }
  // Nudges from before the offers table (and anonymous heads-ups from the daily pick): the old per-person row.
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
  await (await import("./inRoomOffers.js")).answerOffer(eventId, personId, candidateId, status === "interested" ? "yes" : "no").catch(() => {});
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
  const O = await import("./inRoomOffers.js");
  // Already asked (or already answered) about this person, from either path.
  if ((await hasPendingOrAnsweredNudge(eventId, candidate.user_id, asker.user_id)) || (await O.offeredAbout(eventId, candidate.user_id, asker.user_id))) return;
  // An ask held for their morning (services/deferredSends.ts) opens its offer only once it reaches them, so a held ask
  // counts here too: the same one is already asked, and any other is their open question.
  const D = await import("./deferredSends.js");
  if (await D.isQueued(candidate.user_id, directAskKey(eventId, candidate.user_id, asker.user_id))) return;
  // One yes-or-no about a person at a time: while they have another question open, this one waits and goes out once
  // they've answered (sendNextQueued), so their "yes" can only ever mean one person.
  if ((await O.hasOpenOffer(candidate.user_id)) || (await D.hasQueuedWithPrefix(candidate.user_id, "direct_ask:"))) {
    await O.queueOffer({ eventId, eventName, personId: candidate.user_id, candidateId: asker.user_id, askerId: asker.user_id });
    return;
  }

  // The message tells the candidate the asker wants an intro, so that has
  // to be on record first.
  const askerOptedIn = await eventOptedIn(eventId, asker.user_id, candidate.user_id);
  const message = await draftWithConsent(
    {
      decision: "eventGuestMatchHandoff.directAsk",
      recipientId: candidate.user_id,
      otherUserIds: [asker.user_id],
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
  // actually delivered, so there's no separate write needed here. The open
  // offer is written once the ask actually reaches them (afterDirectAskSent,
  // now or at their 9am): opened while it was only queued, a "yes" they
  // texted about something else before the morning bound to the asker.
  const result = await sendExemptWhenAllowed({
    userId: candidate.user_id,
    phoneNumber: candidate.phone_number,
    type: "direct_ask",
    targetKey: directAskKey(eventId, candidate.user_id, asker.user_id),
    messages: [message],
    timezone: await timezoneFor(candidate.user_id),
    after: { kind: "event_direct_ask", payload: { eventId, eventName, candidateId: candidate.user_id, askerId: asker.user_id } },
  });
  if (!result.sent && !result.queued) {
    console.error(`maybeAskCandidateDirectly: send failed for ${candidate.user_id} (non-fatal):`, result.reason);
  }
}

const directAskKey = (eventId: string, candidateId: string, askerId: string) => `direct_ask:${eventId}:${candidateId}:${askerId}`;

// Their open question is now this one, about the asker, as its own pair (services/inRoomOffers.ts). Their nudge row
// about someone else is left as it was: it used to be overwritten here, so a reply meant for that person bound to
// the asker instead.
export async function afterDirectAskSent(p: { eventId: string; eventName: string; candidateId: string; askerId: string }): Promise<void> {
  const O = await import("./inRoomOffers.js");
  await O.openOffer({ eventId: p.eventId, eventName: p.eventName, personId: p.candidateId, kind: "direct_ask", candidateId: p.askerId, askerId: p.askerId }).catch((err: any) =>
    console.error("maybeAskCandidateDirectly: opening the offer failed (non-fatal):", err?.message ?? err),
  );
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
  const html = galleryEmail({
    preview: `From ${eventName}: Co thinks you two should meet.`,
    eyebrow: "An introduction",
    headline: `${a.first_name}, meet ${b.first_name}.`,
    // Sent once both say yes: in the room, or after it. Never "before it".
    body: [`You were both at ${eventName}, and Co thought you two should meet. Consider this your introduction.`],
    close: "You both said yes. Take it from here.",
  });
  if (!ALLOW_REAL_SENDS) {
    console.log(`[sendIntroEmail stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${a.email}, ${b.email}: ${subject}`);
  } else {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Co cc'd (Royce, 2026-09-07: "Co would need to be the driver of the
      // email") — visibly present so a reply-all naturally includes it.
      const { error } = await resend.emails.send({ from: CO_EMAIL_FROM, to: [a.email, b.email], cc: ["hello@copatible.com"], subject, html });
      if (error) throw new Error(error.message);
    } catch (err: any) {
      console.error("sendIntroEmail: send failed (non-fatal):", err?.message ?? err);
      return false;
    }
  }
  await writeMemory(a.user_id, "event_intro_email_sent", `Sent an intro email connecting ${a.first_name} and ${b.first_name} ahead of "${eventName}".`);
  await writeMemory(b.user_id, "event_intro_email_sent", `Sent an intro email connecting ${a.first_name} and ${b.first_name} ahead of "${eventName}".`);
  // Introduced after both said yes: the only people a relay can reach (services/relay.ts).
  await import("./relay.js").then((r) => r.recordConnection(a.user_id, b.user_id, "event_intro")).catch(() => {});
  return true;
}

export type ResolvedEventGuest = { eventId: string; eventName: string; target: MatchNudgeCandidate } | { needsDetail: true } | { error: string };

// Resolves "I met Sarah" to a real guest at the member's most recent Co
// event — event_checkin_followups is scheduled as soon as their
// registration is known (services/eventCheckinFollowUp.ts), before the
// event even starts, so this also covers "still at the event right now."
// Known limitation, not built here: always the MOST RECENT event, never one
// they name explicitly ("at the one last month") — not added speculatively,
// this is the case that actually came up.
// Who they mean is found only by an exact first AND last name (2026-10-07): a prefix match told Jo about Noor when Noor
// met Jordan, and answering "two people have that name" told a probe who's a member. So Co always asks for the last
// name first, the same way whoever they name and whether or not anyone matches; only then is the guest list read.
const foldName = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z' -]+/g, " ").replace(/\s+/g, " ").trim();
export async function resolveNamedEventGuest(userId: string, nameGuess: string, lastNameGuess?: string | null): Promise<ResolvedEventGuest> {
  const parts = foldName(nameGuess).split(" ").filter(Boolean);
  const first = parts[0] ?? "";
  const last = foldName(lastNameGuess ?? "") || parts.slice(1).join(" ");
  if (!first) return { error: "no name given" };
  if (!last) return { needsDetail: true };
  const { rows: recent } = await pool.query(
    `SELECT event_api_id, event_name FROM event_checkin_followups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!recent[0]) return { error: "no recent Co event on file for them to have met someone at" };
  const eventId: string = recent[0].event_api_id;
  const eventName: string = recent[0].event_name;

  // The same "in the room" as scoring (eventScoring.ts inRoomPool): a declined or archived guest is never found here.
  const { inRoomPool } = await import("./eventScoring.js");
  const guestPool = (await inRoomPool(eventId).catch(() => [])).filter((g) => g.user_id !== userId && foldName(g.first_name) === first);
  if (!guestPool.length) return { error: `nobody named "${first} ${last}" on the guest list for "${eventName}"` };
  const { rows: lasts } = await pool.query(`SELECT id AS user_id, last_name FROM users WHERE id = ANY($1::uuid[])`, [guestPool.map((g) => g.user_id)]);
  const lastOf = new Map(lasts.map((r: any) => [String(r.user_id), foldName(r.last_name)]));
  const matches = guestPool.filter((g) => lastOf.get(g.user_id) === last);
  // None, or more than one with the same full name: no one is contacted, and Co answers exactly as it does for "not found".
  if (matches.length !== 1) return { error: `no single guest named "${first} ${last}" at "${eventName}"` };
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
  if (classification === "interested") {
    if (await hasReciprocalOptIn(eventId, person.user_id, candidate.user_id)) {
      // Both said yes: introduce them by email. There is deliberately no
      // "text instead" option (see the note at the top of this file).
      await sendIntroEmail(eventId, eventName, person, candidate);
    } else {
      await maybeAskCandidateDirectly(eventId, eventName, person.first_name, candidate, person);
    }
  }
  // They've answered: a direct ask that was waiting on them can go now.
  await sendNextQueued(person.user_id);
}

// The next direct ask that waited while they had another question open (services/inRoomOffers.ts).
async function sendNextQueued(personId: string): Promise<void> {
  const next = await (await import("./inRoomOffers.js")).nextQueued(personId).catch(() => null);
  if (!next?.asker_id) return;
  const { rows } = await pool.query(`SELECT id AS user_id, first_name, phone_number, email FROM users WHERE id = ANY($1::uuid[])`, [[personId, next.asker_id]]);
  const me = rows.find((r: any) => r.user_id === personId);
  const asker = rows.find((r: any) => r.user_id === next.asker_id);
  if (me && asker) await maybeAskCandidateDirectly(next.event_id, next.event_name ?? "the event", asker.first_name, me, asker);
}

// Their answer to "more people just got here, want to hear who?" (eventScoring.ts maybeSendAdditiveOffer). A no closes
// it. A yes names at most ONE of the people who arrived: still in the room (eventScoring.ts inRoomPool), ranked for them,
// with a reason that passes the same share gate as a nudge. That person becomes their open question, so their next yes
// is about them. Nobody passes: nobody is named. Never anything from Co's notes.
export async function handleAdditiveReply(
  eventId: string,
  eventName: string,
  classification: MatchNudgeReplyClassification,
  person: MatchNudgeCandidate,
  candidateIds: string[],
): Promise<{ revealed: { first_name: string; shareReason: string } | null }> {
  if (classification === "unrelated") return { revealed: null };
  const O = await import("./inRoomOffers.js");
  await O.answerOffer(eventId, person.user_id, "additive", classification === "interested" ? "yes" : "no");
  if (classification !== "interested") {
    await sendNextQueued(person.user_id);
    return { revealed: null };
  }
  const [{ inRoomPool, MATCH_NUDGE_MIN_SCORE }, { rankingFor }, { gateShareReason }] = await Promise.all([import("./eventScoring.js"), import("./eventBrief.js"), import("../harness/matchGate.js")]);
  const [room, ranking] = await Promise.all([inRoomPool(eventId).catch(() => []), rankingFor(eventId, person.user_id)]);
  const here = new Map(room.map((g) => [g.user_id, g]));
  const options = ranking.filter((r) => candidateIds.includes(r.candidate_id) && here.has(r.candidate_id) && r.shareReason && r.score >= MATCH_NUDGE_MIN_SCORE).sort((a, b) => b.score - a.score);
  for (const r of options) {
    if (!(await gateShareReason(person.user_id, r.candidate_id, r.shareReason, "eventGuestMatchHandoff.additiveReveal"))) continue;
    const who = here.get(r.candidate_id)!;
    await O.openOffer({ eventId, eventName, personId: person.user_id, kind: "nudge", candidateId: who.user_id });
    await writeMemory(person.user_id, "event_guest_match_nudge", `Told ${person.first_name} that ${who.first_name} also got to "${eventName}" and is worth meeting: ${r.shareReason}`);
    return { revealed: { first_name: who.first_name, shareReason: r.shareReason! } };
  }
  await sendNextQueued(person.user_id);
  return { revealed: null };
}
