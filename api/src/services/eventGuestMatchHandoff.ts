import { withMember } from "./llmUsage.js";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Resend } from "resend";
import pool from "../db/db.js";
import { cleanCoMessage } from "./sendblue.js";
import { writeMemory } from "./memory.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { checkBothYes, draftWithConsent, eventOptedIn, eventPromptLine, gateIntroAction } from "../harness/introConsent.js";
import { sendExemptWhenAllowed } from "../harness/proactive.js";
import { MODELS } from "../models.js";
import { CO_EMAIL_FROM } from "./emailFrom.js";
import { galleryEmail } from "./emailDesign.js";
import { recordDecision } from "../harness/core.js";
import { foldName, guestName } from "./guestName.js";

// This person's timezone, for the hours check on a reply-triggered direct
// ask (code review, 2026-09-17 — see sendExemptWhenAllowed).
async function timezoneFor(userId: string): Promise<string | null> {
  // Their stored zone (memberTime.ts memberZone, the one source of truth): never a fresh lookup of a bare city (2026-10-29 place audit).
  return (await import("./memberTime.js")).memberZone(userId);
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
// Every question about a person they have open, newest first (services/inRoomOffers.ts openOffers): with two open, the reply path
// sees both and binds a reply only to the one it names (messageRouter.ts namesOneOpenIntro). Only the people this member was
// already told about (a first name per question; none for an additive offer, whose arrivals they haven't been told). Without any
// open offer row: the old per-person nudge, as findPendingMatchNudge reads it.
export async function findPendingMatchNudges(userId: string): Promise<PendingMatchNudge[]> {
  const offers = await (await import("./inRoomOffers.js")).openOffers(userId).catch(() => null);
  if (!offers?.length) {
    const one = await findPendingMatchNudge(userId);
    return one ? [one] : [];
  }
  const out: PendingMatchNudge[] = [];
  for (const offer of offers) {
    if (offer.kind === "additive") {
      out.push({ event_id: offer.event_id, event_name: offer.event_name ?? "the event", candidate_id: "", candidate_first_name: "", candidate_phone: "", candidate_email: "", anonymous: true, kind: "additive", candidate_ids: offer.candidate_ids ?? [], asked_at: offer.opened_at });
    } else if (offer.candidate_id) {
      const { rows: who } = await pool.query(`SELECT first_name, phone_number, email FROM users WHERE id = $1`, [offer.candidate_id]);
      if (who[0]) out.push({ event_id: offer.event_id, event_name: offer.event_name ?? "the event", candidate_id: offer.candidate_id, candidate_first_name: who[0].first_name, candidate_phone: who[0].phone_number, candidate_email: who[0].email, anonymous: false, kind: offer.kind, asked_at: offer.opened_at });
    }
  }
  return out;
}

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
       AND NOT EXISTS (SELECT 1 FROM event_room_closures c WHERE c.event_id = n.event_id AND c.closed_at IS NOT NULL)
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
  // false for a member who asked for this intro by name (requestIntroToNamedGuest): the line below exists only when the person they
  // named was found, so a later reply that read it ("Cue's record: Jo said yes to being introduced to Sarah", introFacts) told them
  // Sarah is someone Cue knows. Their ask is already in co_facts, the same line found or not (coFacts.ts toolAction). The opt-in row,
  // the offer and the pair record still drive the double opt-in; the asker hears of it only from the intro email's own record
  // (sendIntroEmail) once both have said yes (2026-10-28, Royce: "found/not-found results shouldn't leak through later memory").
  memory = true,
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
  // The pair record (services/roomMatching.ts): one answer per side; a no declines the pair for good.
  await (await import("./roomMatching.js")).notePairAnswer(eventId, personId, candidateId, status === "interested" ? "yes" : "no").catch(() => {});
  if (memory) await writeMemory(
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
  const RM = await import("./roomMatching.js");
  // Already asked (or already answered) about this person, from either path.
  if ((await hasPendingOrAnsweredNudge(eventId, candidate.user_id, asker.user_id)) || (await O.offeredAbout(eventId, candidate.user_id, asker.user_id))) return;
  // The pair record: never asked twice, never after a decline at any event, never once the room's asks expired. The asker
  // is never told why (their answer from Co is the same either way).
  if (await RM.mayAsk(eventId, candidate.user_id, asker.user_id, "eventGuestMatchHandoff.directAsk")) return;
  // The emergency pause: the asker was already told Co would check, so the ask isn't dropped. It waits in deferred_sends
  // (which holds it while the pause is on) and goes once the pause lifts, if the event and the pair are still valid then.
  const paused = await RM.matchingPause(eventId);
  // The line Co wrote for THIS person when it judged the pair (only theirs; it rests on the asker's shareable ask).
  const pair = await RM.pairRow(eventId, candidate.user_id, asker.user_id);
  const { a } = RM.orderPair(candidate.user_id, asker.user_id);
  const valueLine = pair?.value_verdict === "strong" ? RM.usableLine(a === candidate.user_id ? pair.value_line_a : pair.value_line_b) : "";
  const askerSide = await RM.gatherValueSide(asker.user_id);
  // An ask held for their morning (services/deferredSends.ts) opens its offer only once it reaches them, so a held ask
  // counts here too: the same one is already asked, and any other is their open question.
  const D = await import("./deferredSends.js");
  if (await D.isQueued(candidate.user_id, directAskKey(eventId, candidate.user_id, asker.user_id))) return;
  // One yes-or-no about a person at a time: while they have another question open (or another ask is on its way to them),
  // this one waits and goes out once they've answered (sendNextQueued), so their "yes" can only ever mean one person. The slot
  // is taken here, before drafting, so asks drafted at the same moment can't all go (inRoomOffers.ts claimAskSlot).
  if (await D.hasQueuedWithPrefix(candidate.user_id, "direct_ask:")) {
    await O.queueOffer({ eventId, eventName, personId: candidate.user_id, candidateId: asker.user_id, askerId: asker.user_id });
    return;
  }
  if ((await O.claimAskSlot({ eventId, eventName, personId: candidate.user_id, candidateId: asker.user_id, askerId: asker.user_id })) === "queued") return;
  let delivered = false;
  try {

  // The message tells the candidate the asker wants an intro, so that has
  // to be on record first.
  const askerOptedIn = await eventOptedIn(eventId, asker.user_id, candidate.user_id);
  // The event as it really is: the only source of a day or time in the text (harness/introConsent.ts checkInventedSpecifics).
  const info = await RM.eventTiming(eventId).catch(() => null);
  const introEvent = { name: eventName, start_at: info?.start_at ?? null, end_at: info?.end_at ?? null, timezone: info?.timezone ?? null, venue: info?.venue ?? null };
  const message = await withMember(candidate.user_id, () =>
    draftWithConsent(
    {
      decision: "eventGuestMatchHandoff.directAsk",
      recipientId: candidate.user_id,
      otherUserIds: [asker.user_id],
      event: introEvent,
      said: [...askerSide.shared, ...(valueLine ? [valueLine] : [])],
      // The asker's private words (private asks, profile, notes) never reach the person being asked.
      extraDraftChecks: (d) => [RM.checkNoPrivateQuote(d, askerSide.privateTexts, askerSide.shared, "no_private_quote", [eventName, askerFirstName, candidate.first_name])],
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
        // The text goes to the candidate: theirs.
        experimental_telemetry: { isEnabled: true, functionId: "eventGuestMatchHandoff.directAsk.draft" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${candidate.first_name} about "${eventName}." ${askerFirstName}, who's also going, said they'd like to be introduced. ${eventPromptLine(introEvent, eventName)} Draft a short, warm text (1-2 sentences, no em dashes) letting ${candidate.first_name} know and asking if they'd be open to it too. Low-pressure, genuinely a question, not an assumption. Don't share any contact details.${valueLine ? ` Why it could be worth it for ${candidate.first_name}, in your own words (say nothing else about ${askerFirstName}): ${valueLine}` : ""} Return ONLY the message text.${feedback ? `\n\n${feedback}` : ""}`,
      });
      return cleanCoMessage(text.trim());
    },
  ));
  if (!message) return;

  // Read the pair again right before the ask goes (concurrency audit finding 8, 2026-10-12): drafting takes seconds, and when
  // both say yes at the same moment the other side's yes lands in between. Their yes already sent the email; asking them
  // "X is up for an intro, open to it?" after they said yes is wrong. Any answer of theirs, or a pair that's moved on, stops it.
  const stale = await RM.directAskStale(eventId, candidate.user_id, asker.user_id);
  if (stale) {
    await recordDecision({ layer: 6, decision: "match.pair", userId: candidate.user_id, outcome: "skip", action: "eventGuestMatchHandoff.directAsk.recheck", proposal: { eventId, askerId: asker.user_id }, checks: [{ name: "pair_still_waiting_on_them", pass: false, reason: stale }] }).catch(() => {});
    return;
  }

  // Opt-out and local hours checked at send time, queued for the next
  // allowed hour if it's night for them (code review, 2026-09-17): this
  // used to send a raw sendblue message unconditionally, triggered by the
  // ASKER's reply, not anything this recipient just did. sendExempt (inside
  // sendExemptWhenAllowed) writes the text_exchange memory itself once
  // actually delivered, so there's no separate write needed here. The open
  // offer is written once the ask actually reaches them (afterDirectAskSent,
  // now or at their 8am): opened while it was only queued, a "yes" they
  // texted about something else before the morning bound to the asker.
  const send = {
    userId: candidate.user_id,
    phoneNumber: candidate.phone_number,
    type: "direct_ask" as const,
    targetKey: directAskKey(eventId, candidate.user_id, asker.user_id),
    messages: [message],
    timezone: await timezoneFor(candidate.user_id),
    after: { kind: "event_direct_ask" as const, payload: { eventId, eventName, candidateId: candidate.user_id, askerId: asker.user_id } },
  };
  if (paused) {
    const q = await D.enqueueDeferredSend({ ...send, dueAt: new Date() }).catch((err: any) => ({ queued: false, reason: String(err?.message ?? err) }));
    await recordDecision({ layer: 6, decision: "match.pause", userId: candidate.user_id, outcome: "skip", action: "eventGuestMatchHandoff.directAsk.held", proposal: { eventId, askerId: asker.user_id, queued: q.queued }, reason: paused }).catch(() => {});
    return;
  }
  const result = await sendExemptWhenAllowed(send);
  if (!result.sent && !result.queued) {
    console.error(`maybeAskCandidateDirectly: send failed for ${candidate.user_id} (non-fatal):`, result.reason);
  }
  delivered = result.sent;
  } finally {
    // Sent: afterDirectAskSent has opened the slot as their question. Anything else (blocked, moved on, held, failed): free it,
    // and the next ask waiting on them goes now (it would otherwise wait for an answer to a question they never got).
    if (!delivered) {
      await O.releaseAskSlot(eventId, candidate.user_id, asker.user_id).catch((err: any) => console.error("maybeAskCandidateDirectly: releasing the slot failed (non-fatal):", err?.message ?? err));
      await sendNextQueued(candidate.user_id).catch((err: any) => console.error("maybeAskCandidateDirectly: the next queued ask failed (non-fatal):", err?.message ?? err));
    }
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
  await (await import("./roomMatching.js")).notePairAsked(p.eventId, p.candidateId, p.askerId).catch(() => {});
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
// Pure: what a Resend reply means for the intro. The same idempotency key with a different body ("invalid_idempotent_request")
// means an earlier send with this key went: the email is out, so the pair is recorded as introduced. A concurrent request
// with the key is still in flight: not sent yet, the claim stays until it goes stale.
export function introSendOutcome(error: { name?: string | null; statusCode?: number | null } | null | undefined): "sent" | "already_sent" | "in_flight" | "failed" {
  if (!error) return "sent";
  if (error.name === "invalid_idempotent_request") return "already_sent";
  if (error.name === "concurrent_idempotent_requests") return "in_flight";
  return "failed";
}

// Pure: the email itself, from the pair in one order (by id) and the event's own name, so a retry after a crash builds the
// very same email the first try did (the idempotency key covers the same body only).
export function introEmailContent(eventName: string, x: { user_id: string; first_name: string }, y: { user_id: string; first_name: string }): { subject: string; html: string; first: string; second: string } {
  const [a, b] = x.user_id < y.user_id ? [x, y] : [y, x];
  return {
    subject: `Introducing ${a.first_name} and ${b.first_name}`,
    html: galleryEmail({
      preview: `From ${eventName}: Cue thinks you two should meet.`,
      eyebrow: "An introduction",
      headline: `${a.first_name}, meet ${b.first_name}.`,
      // Sent once both say yes: in the room, or after it. Never "before it".
      body: [`You were both at ${eventName}, and Cue thought you two should meet. Consider this your introduction.`],
      close: "You both said yes. Take it from here.",
    }),
    first: a.user_id,
    second: b.user_id,
  };
}

async function sendIntroEmail(eventId: string, _callerEventName: string, a: MatchNudgeCandidate, b: MatchNudgeCandidate): Promise<boolean> {
  const { a: aYes, b: bYes } = await bothOptedIn(eventId, a.user_id, b.user_id);
  const RM = await import("./roomMatching.js");
  // The emergency pause holds the email (the pair stays both_yes); services/roomMatching.ts retryHeldIntros sends it once
  // the pause lifts. Nothing is said to either member about the hold.
  const paused = await RM.matchingPause(eventId);
  const pauseCheck = paused ? { name: "matching_not_paused", pass: false, reason: paused } : { name: "matching_not_paused", pass: true };
  // Already introduced (the pair record): never a second email.
  const sentBefore = (await RM.pairRows(a.user_id, b.user_id)).some((r) => r.intro_sent_at);
  const onceCheck = sentBefore ? { name: "intro_once", pass: false, reason: "already introduced" } : { name: "intro_once", pass: true };
  // They already know each other another way (introduced elsewhere, one of them said so, a personal invite): no intro email between
  // them (services/knownConnections.ts). Checked right before the send, so a connection added while it waited stops it.
  const connected = sentBefore ? null : await (await import("./knownConnections.js")).alreadyConnected(a.user_id, b.user_id);
  if (connected?.known) {
    await gateIntroAction(a.user_id, "eventGuestMatchHandoff.introEmail", [{ name: "not_already_connected", pass: false, reason: connected.why }], { eventId, b: b.user_id });
    // Final: a held email is never retried for a pair that already knows each other.
    if (aYes && bYes) await RM.noteIntroFailed(eventId, a.user_id, b.user_id, "already connected", true);
    return false;
  }
  // Held by the pause: marked once on the pair (logged once), sent by retryHeldIntros when it lifts.
  if (paused && aYes && bYes && !sentBefore) {
    await RM.noteIntroHeld(eventId, a.user_id, b.user_id, paused);
    return false;
  }
  // Only one call sends it (live run 2026-10-12: both said yes at the same moment, each turn saw the other's yes, and the email
  // went twice). The claim is the pair's intro_sent_at, taken atomically before the send and given back if the send fails.
  const claim = aYes && bYes && !paused && !sentBefore ? await RM.claimIntroSend(eventId, a.user_id, b.user_id) : "ok";
  const claimCheck = claim === "taken" ? { name: "intro_claim", pass: false, reason: "another reply is already sending this intro" } : { name: "intro_claim", pass: true };
  if (!(await gateIntroAction(a.user_id, "eventGuestMatchHandoff.introEmail", [checkBothYes(aYes, bYes), pauseCheck, onceCheck, claimCheck], { eventId, b: b.user_id }))) return false;
  // No email on file for one of them: nothing to retry.
  if (!a.email || !b.email) {
    if (claim === "claimed") await RM.releaseIntroClaim(eventId, a.user_id, b.user_id);
    await RM.noteIntroFailed(eventId, a.user_id, b.user_id, "missing email", true);
    return false;
  }

  // One source for the event's name (services/roomMatching.ts eventTiming), whoever replied first and on every retry. Unreadable
  // right now: counted as a failed try (retried by retryHeldIntros), never sent under another name.
  const eventName = (await RM.eventTiming(eventId).catch(() => null))?.name ?? null;
  if (!eventName) {
    if (claim === "claimed") await RM.releaseIntroClaim(eventId, a.user_id, b.user_id);
    await RM.noteIntroFailed(eventId, a.user_id, b.user_id, "event name unreadable");
    return false;
  }
  const { subject, html } = introEmailContent(eventName, a, b);
  if (!ALLOW_REAL_SENDS) {
    console.log(`[sendIntroEmail stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${a.email}, ${b.email}: ${subject}`);
  } else {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Co cc'd (Royce, 2026-09-07: "Co would need to be the driver of the
      // email") — visibly present so a reply-all naturally includes it.
      // One email per pair per event, even if a stale claim is ever taken again after a send went out (Resend keeps the key 24h).
      const { error } = await resend.emails.send({ from: CO_EMAIL_FROM, to: [a.email, b.email], cc: ["hello@copatible.com"], subject, html }, { idempotencyKey: `event-intro:${eventId}:${[a.user_id, b.user_id].sort().join(":")}` });
      const outcome = introSendOutcome(error as any);
      if (outcome === "already_sent") console.log(`sendIntroEmail: ${eventId} pair was already emailed under this key; recording it as sent`);
      else if (outcome === "in_flight") {
        // Another send with this key is still going: leave the claim to go stale (a retake then gets the original reply).
        await RM.noteIntroFailed(eventId, a.user_id, b.user_id, "a send with this key is in flight");
        return false;
      } else if (error) throw new Error(error.message);
    } catch (err: any) {
      console.error("sendIntroEmail: send failed (non-fatal):", err?.message ?? err);
      if (claim === "claimed") await RM.releaseIntroClaim(eventId, a.user_id, b.user_id);
      await RM.noteIntroFailed(eventId, a.user_id, b.user_id, String(err?.message ?? err).slice(0, 120));
      return false;
    }
  }
  // The send is confirmed first: from here the claim is spent and the pair reads as introduced.
  await RM.notePairIntroSent(eventId, a.user_id, b.user_id);
  await writeMemory(a.user_id, "event_intro_email_sent", `Sent an intro email connecting ${a.first_name} and ${b.first_name} ahead of "${eventName}".`);
  await writeMemory(b.user_id, "event_intro_email_sent", `Sent an intro email connecting ${a.first_name} and ${b.first_name} ahead of "${eventName}".`);
  // Introduced after both said yes: the only people a relay can reach (services/relay.ts).
  await import("./relay.js").then((r) => r.recordConnection(a.user_id, b.user_id, "event_intro")).catch(() => {});
  return true;
}

// An intro email the pause held (services/roomMatching.ts retryHeldIntros): both yeses are read fresh again inside.
export async function sendHeldIntro(eventId: string, aId: string, bId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT id AS user_id, first_name, phone_number, email FROM users WHERE id = ANY($1::uuid[])`, [[aId, bId]]);
  const a = rows.find((r: any) => r.user_id === aId);
  const b = rows.find((r: any) => r.user_id === bId);
  if (!a || !b) return false;
  const { eventTiming } = await import("./roomMatching.js");
  const name = (await eventTiming(eventId).catch(() => null))?.name ?? "the event";
  return sendIntroEmail(eventId, name, a, b);
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
// Names are read through services/guestName.ts, the same reading the guard's once-per-person key uses (review of #294).
export async function resolveNamedEventGuest(userId: string, nameGuess: string, lastNameGuess?: string | null): Promise<ResolvedEventGuest> {
  const { first, last } = guestName(nameGuess, lastNameGuess);
  if (!first) return { error: "no name given" };
  if (!last) return { needsDetail: true };
  const { rows: recent } = await pool.query(
    `SELECT event_api_id, event_name FROM event_checkin_followups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!recent[0]) return { error: "no recent Noise event on file for them to have met someone at" };
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
  // Their own request, not Co's suggestion: the pair is theirs (origin 'member'), not blocked on Co's taste, and logged.
  const RM = await import("./roomMatching.js");
  await RM.notePairMemberRequested(eventId, requester.user_id, target.user_id);
  await recordDecision({ layer: 6, decision: "match.valueLines", userId: requester.user_id, outcome: "act", action: "member_requested", proposal: { eventId, targetId: target.user_id }, reason: "a member asked for this intro by name; the value gate applies to Cue's own suggestions" }).catch(() => {});
  await recordOptIn(eventId, requester.user_id, requester.first_name, target.user_id, target.first_name, "interested", false);

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
export async function sendNextQueued(personId: string): Promise<void> {
  const O = await import("./inRoomOffers.js");
  // The oldest waiting ask goes; one that won't go leaves the line so the next can (a few at most per call).
  for (let tries = 0; tries < 5; tries++) {
    const next = await O.nextQueued(personId).catch(() => null);
    if (!next) return;
    const { rows } = next.asker_id ? await pool.query(`SELECT id AS user_id, first_name, phone_number, email FROM users WHERE id = ANY($1::uuid[])`, [[personId, next.asker_id]]) : { rows: [] as any[] };
    const me = rows.find((r: any) => r.user_id === personId);
    const asker = rows.find((r: any) => r.user_id === next.asker_id);
    if (me && asker) await maybeAskCandidateDirectly(next.event_id, next.event_name ?? "the event", asker.first_name, me, asker);
    // Still waiting in line after its turn came: it isn't going (a queued ask that's sent takes the slot, 'sending' then 'open').
    const { rows: still } = await pool.query(`SELECT 1 FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status = 'queued'`, [next.event_id, personId, next.candidate_key]);
    if (!still.length) return;
    if (await O.hasOpenOffer(personId)) return; // it went back in line behind a question that opened meanwhile: its turn comes again
    // Another direct ask to them is held (their morning, or the matching pause; deferredSends.ts): this one waits behind it, it isn't
    // dropped (review of #211: the waiting ask was expired, breaking "the asker was already told Co would check").
    if (await (await import("./deferredSends.js")).hasQueuedWithPrefix(personId, "direct_ask:")) return;
    await O.dropQueued(next.event_id, personId, next.candidate_key);
  }
}

// After a restart cut a direct ask off mid-draft: the dead ask goes back in line and each person's line moves again (jobs/index.ts).
export async function drainStaleAsks(): Promise<number> {
  const O = await import("./inRoomOffers.js");
  // ... and anyone whose waiting ask sits behind a question unanswered past OPEN_SLOT_MINUTES (sendNextQueued sends only once the slot
  // is free, so a fresh open question still holds it).
  const people = [...new Set([...(await O.requeueStaleAsks()), ...(await O.peopleWithQueuedAsks())])];
  for (const personId of people) await sendNextQueued(personId).catch((err: any) => console.error(`drainStaleAsks: ${personId} (non-fatal, next run tries again):`, err?.message ?? err));
  return people.length;
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
  const [{ MATCH_NUDGE_MIN_SCORE }, { rankingFor }, { gateShareReason }, RM] = await Promise.all([import("./eventScoring.js"), import("./eventBrief.js"), import("../harness/matchGate.js"), import("./roomMatching.js")]);
  // The emergency pause: nobody is named.
  if (await RM.matchingPause(eventId)) return { revealed: null };
  // Still in the room right now (services/roomMatching.ts inRoomNow), both of them.
  const [room, ranking] = await Promise.all([RM.inRoomNow(eventId).catch(() => ({ open: false, people: [] as any[] })), rankingFor(eventId, person.user_id)]);
  const here = new Map(room.people.map((g: any) => [g.user_id, g]));
  const options = room.open && here.has(person.user_id) ? ranking.filter((r) => candidateIds.includes(r.candidate_id) && here.has(r.candidate_id) && r.shareReason && r.score >= MATCH_NUDGE_MIN_SCORE).sort((a, b) => b.score - a.score) : [];
  for (const r of options) {
    if (!(await gateShareReason(person.user_id, r.candidate_id, r.shareReason, "eventGuestMatchHandoff.additiveReveal"))) continue;
    if (await RM.mayAsk(eventId, person.user_id, r.candidate_id, "eventGuestMatchHandoff.additiveReveal")) continue;
    const v = await RM.valueGate(eventId, eventName, person.user_id, r.candidate_id, "eventGuestMatchHandoff.additiveReveal", { allow: [eventName] });
    if (!v.ok) continue;
    const line = v.lineFor(person.user_id);
    if (!line) continue;
    const who = here.get(r.candidate_id)!;
    await O.openOffer({ eventId, eventName, personId: person.user_id, kind: "nudge", candidateId: who.user_id });
    await RM.notePairAsked(eventId, person.user_id, who.user_id);
    await writeMemory(person.user_id, "event_guest_match_nudge", `Told ${person.first_name} that ${who.first_name} also got to "${eventName}" and is worth meeting: ${line}`);
    return { revealed: { first_name: who.first_name, shareReason: line } };
  }
  await sendNextQueued(person.user_id);
  return { revealed: null };
}
