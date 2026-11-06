import { withMember } from "./llmUsage.js";
import { generateText } from "ai";
import { discretionInstruction } from "../harness/discretion.js";
import { anthropic } from "@ai-sdk/anthropic";
import { Resend } from "resend";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { enqueueCandidate, sendExemptWhenAllowed } from "../harness/proactive.js";
import { writeMemory } from "./memory.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import type { MatchNudgeCandidate } from "./eventGuestMatchHandoff.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { gateNetworkCandidate, PAIR_BLOCKED_SQL } from "../harness/matchGate.js";
import { checkBothYes, draftWithConsent, gateIntroAction, networkOptedIn } from "../harness/introConsent.js";
import { shareableAsks } from "./matching.js";
import { MODELS } from "../models.js";
import { CO_EMAIL_FROM } from "./emailFrom.js";
import { galleryEmail } from "./emailDesign.js";
import { recordDecision } from "../harness/core.js";

// Model policy (Royce, 2026-09-14): Haiku for the yes/no reply reads (code
// acts on them only through the consent checks); Sonnet 5 for drafts that
// name another person.
const CLASSIFY_MODEL = MODELS.haiku;
const NAMING_DRAFT_MODEL = MODELS.sonnet;

// Only what they marked shareable counts as "what they told Cue" for the consent checks, as on the room path
// (eventScoring.ts): a private ask handed in here was allowed text for the consent read and the hidden-echo check, so a reveal
// echoing it passed both (context-sources review, 2026-10-27).
async function statedAsksFor(userId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return shareableAsks(rows[0]?.intent).map((a) => String(a.text));
}

// This person's timezone, for the hours check on a reply-triggered direct
// ask (code review, 2026-09-17 — see harness/proactive.ts's sendExemptWhenAllowed).
async function timezoneFor(userId: string): Promise<string | null> {
  // Their stored zone (memberTime.ts memberZone, the one source of truth): never a fresh lookup of a bare city (2026-10-29 place audit).
  return (await import("./memberTime.js")).memberZone(userId);
}

// Redesigned 2026-09-07 (Royce: "how would you implement the networking
// recommendation... if you just didn't get fed this information but only
// know about my product purpose"). Two changes from the original version:
//
// 1. One candidate at a time, backlogged and teased — not a bundled 1-5
//    shortlist in one text. "Oh I was thinking about you" is a friend
//    mentioning ONE thing; a list of names reads like a matching engine's
//    output, which contradicts Co's actual purpose (genuine ongoing
//    companion, not a matchmaking tool). Mirrors eventSurfacingSweep.ts's
//    tease → backlog → reveal pattern exactly, just for people instead of
//    events/opportunities.
// 2. A real canonical-pair relationship table (network_introductions),
//    not a synthetic "network:<edge_id>" event_id reused from
//    event_guest_match_nudges. That hack was the direct cause of a real
//    bug (the same candidate showing up as two separate pending nudges
//    under two different synthetic ids, depending on which direction the
//    relevance edge came from) — a canonical (person_a_id < person_b_id)
//    pair collapses both directions into one row structurally, instead of
//    patching around duplicates after the fact.

const NETWORK_NUDGE_MIN_SCORE = 60; // same bar as the event guest-match nudge
export const NETWORK_OFFER_EXPIRY_DAYS = 7;

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

type NetworkCandidate = {
  edge_id: string;
  candidate_id: string;
  first_name: string;
  phone_number: string;
  email: string;
  match_score: number;
  // Always relevance_edges.share_reason (never the private match_reason),
  // see findFreshCandidates. share_safe marks items built after that fix;
  // anything without it predates it and is dropped.
  match_reason: string;
  share_safe?: boolean;
};

type BacklogItem = { askId: string; candidate: NetworkCandidate };

async function getBacklog(userId: string, askId: string): Promise<BacklogItem[]> {
  const { rows } = await pool.query(`SELECT items FROM network_backlogs WHERE user_id = $1 AND ask_id = $2`, [userId, askId]);
  return ((rows[0]?.items as BacklogItem[]) ?? []).filter((i) => i.candidate?.share_safe === true);
}

async function saveBacklog(userId: string, askId: string, items: BacklogItem[]): Promise<void> {
  await pool
    .query(
      `INSERT INTO network_backlogs (user_id, ask_id, items, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, ask_id) DO UPDATE SET items = $3, updated_at = NOW()`,
      [userId, askId, JSON.stringify(items)],
    )
    .catch((err: any) => console.error("saveBacklog: write failed (non-fatal):", err?.message ?? err));
}

// A pair already declined, introduced, or with both yeses is never re-suggested, regardless of which person's ask or which relevance
// direction produced the candidate again. One nobody answered (or only one side did) blocks only while recent (matchGate.ts
// PAIR_BLOCKED_SQL): silence is not a permanent no.
async function alreadySuggested(personId: string, candidateId: string): Promise<boolean> {
  const [a, b] = canonicalPair(personId, candidateId);
  const { rows } = await pool.query(PAIR_BLOCKED_SQL, [a, b]);
  return rows.length > 0;
}

async function dropStaleFront(userId: string, items: BacklogItem[]): Promise<BacklogItem[]> {
  let rest = items;
  while (rest.length && (await alreadySuggested(userId, rest[0].candidate.candidate_id))) {
    rest = rest.slice(1);
  }
  return rest;
}

async function findFreshCandidates(userId: string, askId: string): Promise<BacklogItem[]> {
  // DISTINCT ON (candidate_id): the same candidate can have several open
  // edges logged against the same ask across separate sweep cycles — keep
  // only their single best-scoring one.
  const { rows } = await pool.query(
    `SELECT edge_id, candidate_id, match_score, match_reason, true AS share_safe, first_name, phone_number, email FROM (
       SELECT DISTINCT ON (re.candidate_id) re.id AS edge_id, re.candidate_id, re.match_score, re.share_reason AS match_reason,
              u.first_name, u.phone_number, u.email
       FROM relevance_edges re
       JOIN users u ON u.id = re.candidate_id
       WHERE re.person_id = $1 AND re.ask_id = $2 AND re.status = 'open' AND re.match_score >= $3
         AND re.share_reason IS NOT NULL AND re.share_reason <> ''
       ORDER BY re.candidate_id, re.match_score DESC
     ) distinct_candidates
     ORDER BY match_score DESC`,
    [userId, askId, NETWORK_NUDGE_MIN_SCORE],
  );
  const fresh: BacklogItem[] = [];
  for (const row of rows) {
    if (await alreadySuggested(userId, row.candidate_id)) continue;
    // Layer 5 match gate: shareable reason is really from their stated ask,
    // pair not already suggested/declined, both people active.
    if (!(await gateNetworkCandidate(userId, row.candidate_id, row.match_reason, "queue"))) continue;
    fresh.push({ askId, candidate: row });
  }
  return fresh;
}

// Entry point — called once per (user, open ask) on the daily sweep. Layer 7
// (2026-09-14): queues the front candidate as a "network_tease" (no name
// yet); src/harness/proactive.ts decides whether it goes out and drafts it.
// The harness's onSent hook (harness/proactiveRegistry.ts) removes it from
// network_backlogs and writes network_offer_pending; a skipped or expired
// tease is removed from the backlog there too.
export async function attemptNetworkSurfacing(
  userId: string,
  _firstName: string,
  _phoneNumber: string,
  askId: string,
): Promise<{ queued: boolean }> {
  // The matching kill switch (services/roomMatching.ts, all-events scope): no new network suggestion while it's on.
  if (await (await import("./roomMatching.js")).matchingPause(null)) return { queued: false };
  let pending = await dropStaleFront(userId, await getBacklog(userId, askId));
  if (!pending.length) {
    pending = await dropStaleFront(userId, await findFreshCandidates(userId, askId));
  }
  await saveBacklog(userId, askId, pending);
  if (!pending.length) return { queued: false };

  const [item] = pending;
  const { queued } = await enqueueCandidate({
    userId,
    type: "network_tease",
    targetKey: `network_tease:${item.candidate.candidate_id}`,
    summary: `Someone in Cue's network who fits what they're looking for (not named until they say yes): ${item.candidate.match_reason.slice(0, 160)}`,
    payload: { askId, candidate: item.candidate },
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });
  return { queued };
}

// reveal: the message that answers "yes", drafted and checked before the tease
// went out (prepareReveal), so a yes always has something to deliver.
export type PendingNetworkTease = { askId: string; candidate: NetworkCandidate; reveal?: string; revealOptedIn?: boolean };

export async function findPendingNetworkTease(userId: string): Promise<PendingNetworkTease | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.content FROM co_memories p
     WHERE p.user_id = $1 AND p.memory_type = 'network_offer_pending'
       AND p.created_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM co_memories r
         WHERE r.user_id = $1 AND r.memory_type = 'network_offer_resolved' AND r.created_at > p.created_at
       )
     ORDER BY p.created_at DESC LIMIT 1`,
    [userId, NETWORK_OFFER_EXPIRY_DAYS],
  );
  if (!rows[0]) return null;
  const parsed = JSON.parse(rows[0].content);
  // Stashed before share_reason existed: its reason may hold private detail.
  return parsed?.candidate?.share_safe === true ? parsed : null;
}

export type TeaseReplyClassification = "interested" | "not_interested" | "unrelated";

async function stashIntroOfferPending(personId: string, candidate: NetworkCandidate, askId: string | null): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_intro_offer_pending', $2)`, [
      personId,
      JSON.stringify({ askId, candidate }),
    ])
    .catch((err: any) => console.error("stashIntroOfferPending: write failed (non-fatal):", err?.message ?? err));
}

// The reveal text for a candidate: consent-checked and in Co's voice. null when
// the draft can't go out.
async function draftReveal(userId: string, firstName: string, candidate: NetworkCandidate): Promise<string | null> {
  const candidateId = candidate.candidate_id;
  return draftWithConsent(
    {
      decision: "networkIntroNudge.reveal",
      recipientId: userId,
      otherUserIds: [candidateId],
      facts: {
        otherFirstName: candidate.first_name,
        otherOptedIn: await networkOptedIn(candidateId, userId),
        recipientOptedIn: false,
        recipientFirstName: firstName,
        otherStatedAsks: await statedAsksFor(candidateId),
        otherPhone: candidate.phone_number,
        otherEmail: candidate.email,
      },
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(NAMING_DRAFT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.reveal.draft" },
        prompt: networkRevealPrompt({ recipientFirstName: firstName, otherFirstName: candidate.first_name, shareReason: candidate.match_reason, feedback }),
      });
      return cleanCoMessage(text.trim());
    },
  );
}

// Before a tease goes out ("someone came to mind, want to hear who?"), the
// answer to "yes" is made and checked: the same privacy gate the reveal runs,
// and the reveal itself drafted. A tease that couldn't be answered used to go
// out anyway and a "Sure" got "Sorry for the false start." (2026-10-03, then a
// second tease at 1pm). why says what stopped it.
// retry: a draft that failed is worth trying again later; a gate that said no
// won't change its mind (review of #59: a flaky draft used to drop the match for good).
export async function prepareReveal(userId: string, firstName: string, candidate: NetworkCandidate): Promise<{ message: string; optedIn: boolean } | { why: string; retry: boolean }> {
  if (!(await gateNetworkCandidate(userId, candidate.candidate_id, candidate.match_reason, "reveal"))) return { why: "the privacy check on the reveal wouldn't pass", retry: false };
  const optedIn = await networkOptedIn(candidate.candidate_id, userId);
  const message = await draftReveal(userId, firstName, candidate);
  return message ? { message, optedIn } : { why: "the reveal couldn't be drafted", retry: true };
}

// They said yes to hearing who, and no reveal followed: the reveal stashes
// network_intro_offer_pending when it goes out. While that's true no new tease
// is sent ("asked, got yes, delivered nothing, asked again"). Clears itself
// after 3 days.
export const UNDELIVERED_YES_DAYS = 3;
export async function lastTeaseUndelivered(userId: string): Promise<boolean> {
  const { rows } = await pool
    .query(
      `SELECT 1 FROM co_memories r
       WHERE r.user_id = $1 AND r.memory_type = 'network_offer_resolved' AND r.content = 'interested'
         AND r.created_at > NOW() - ($2 || ' days')::interval
         AND NOT EXISTS (
           SELECT 1 FROM co_memories s
           WHERE s.user_id = $1 AND s.memory_type = 'network_intro_offer_pending' AND s.created_at > r.created_at
         )
       LIMIT 1`,
      [userId, UNDELIVERED_YES_DAYS],
    )
    .catch(() => ({ rows: [] as unknown[] }));
  return rows.length > 0;
}

// Resolves a reply to the tease — called from routes/sendblue.ts. On
// "interested", reveals who it is AND asks the actual intro question in
// the same message (no third round trip): "It's Celine — [reason]. Want
// me to see if she's open to it too?"
export async function resolveNetworkTeaseReply(
  userId: string,
  firstName: string,
  phoneNumber: string,
  pending: PendingNetworkTease,
  classification: TeaseReplyClassification,
): Promise<string | null> {
  if (classification === "unrelated") return null;

  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_offer_resolved', $2)`, [
      userId,
      classification,
    ])
    .catch((err: any) => console.error("resolveNetworkTeaseReply: resolved-write failed (non-fatal):", err?.message ?? err));

  if (classification === "not_interested") {
    // Passing on hearing who it is at all is treated as a decline on the
    // pair itself — otherwise the same candidate would just resurface from
    // the backlog again next cycle.
    const [a, b] = canonicalPair(userId, pending.candidate.candidate_id);
    await pool
      .query(
        `INSERT INTO network_introductions (person_a_id, person_b_id, status, match_reason, ask_id)
         VALUES ($1, $2, 'declined', $3, $4)
         ON CONFLICT (person_a_id, person_b_id) DO UPDATE SET status = 'declined' WHERE network_introductions.status IN ('suggested', 'a_interested', 'b_interested')`,
        [a, b, pending.candidate.match_reason, pending.askId],
      )
      .catch((err: any) => console.error("resolveNetworkTeaseReply: decline write failed (non-fatal):", err?.message ?? err));
    return `\nThey just passed on even hearing who it was (internal only, never say the name back to them). Acknowledge lightly, no pressure, don't explain further.`;
  }

  // Re-gate at reveal time: the candidate may have gone inactive, been
  // introduced another way, or the reason may not pass the privacy check.
  const candidateId = pending.candidate.candidate_id;
  // A block is discretion, not a failure: no explanation, no apology, no "it fell
  // through" (2026-10-03: this said "say so briefly and honestly" and a "Sure"
  // got "Sorry for the false start."). harness/discretion.ts.
  const cantReveal = discretionInstruction("They said yes to hearing who it was, and you can't go further on that one. Don't promise another one.", { neutral: true });
  // The matching kill switch (all events) blocks it the same way: nobody is named while it's on, same neutral answer.
  if (!(await gateNetworkCandidate(userId, candidateId, pending.candidate.match_reason, "reveal")) || (await (await import("./roomMatching.js")).matchingPause(null))) return cantReveal;

  // The stored reveal was drafted under the other person's consent at the time;
  // if that changed since the tease, it's drafted again (the gate above covers
  // activity and privacy).
  const stillConsented = pending.reveal && pending.revealOptedIn !== undefined ? (await networkOptedIn(candidateId, userId)) === pending.revealOptedIn : false;
  const message = pending.reveal && stillConsented ? pending.reveal : await draftReveal(userId, firstName, pending.candidate);
  if (!message) return cantReveal;

  try {
    await sendblue.messages.send({ number: phoneNumber, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  } catch (err: any) {
    console.error("resolveNetworkTeaseReply: reveal send failed (non-fatal):", err?.message ?? err);
    return null;
  }
  await writeMemory(userId, "text_exchange", `Co replied: ${message}`);
  await stashIntroOfferPending(userId, pending.candidate, pending.askId);

  return `\nThey just said yes to hearing who it was — you've already sent the reveal separately (naming ${pending.candidate.first_name} and asking if they want an intro). Acknowledge briefly that you've got it, don't repeat the name or reason again.`;
}

export type PendingNetworkIntroOffer = { askId: string | null; candidate: NetworkCandidate };

// Resolved once THIS person's own answer to THIS specific offer is on
// record (code review, 2026-09-17): used to check for any network_
// introductions row created after the stash, which closes correctly for
// the original asker (their own row-insert always happens after their
// reveal was stashed) but never for a directly-asked candidate — their
// stash (askCandidateDirectly) always runs AFTER the asker's own
// network_introductions insert, so that row's created_at is always BEFORE
// the candidate's stash and the close-check never matched. A later message
// could then re-run resolveNetworkIntroReply and send a duplicate intro
// email or flip status again. Checking THIS person's own interested column
// (set at the moment THEY reply, always after their own stash) instead of
// the row's creation time fixes it for both directions.
export async function findPendingNetworkIntroOffer(userId: string): Promise<PendingNetworkIntroOffer | null> {
  const { rows } = await pool.query(
    `SELECT id, content, created_at FROM co_memories
     WHERE user_id = $1 AND memory_type = 'network_intro_offer_pending'
       AND created_at > NOW() - ($2 || ' days')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [userId, NETWORK_OFFER_EXPIRY_DAYS],
  );
  if (!rows[0]) return null;
  const parsed = JSON.parse(rows[0].content);
  // Stashed before share_reason existed: its reason may hold private detail.
  if (parsed?.candidate?.share_safe !== true) return null;

  const candidateId: string | undefined = parsed.candidate?.candidate_id;
  if (!candidateId) return parsed;
  const [aId, bId] = canonicalPair(userId, candidateId);
  const ownCol = userId === aId ? "a_interested_at" : "b_interested_at";
  const { rows: introRows } = await pool.query(
    `SELECT status, ${ownCol} AS own_interested_at FROM network_introductions WHERE person_a_id = $1 AND person_b_id = $2`,
    [aId, bId],
  );
  const intro = introRows[0];
  const resolved = !!intro && (intro.status === "declined" || (intro.own_interested_at && new Date(intro.own_interested_at) > new Date(rows[0].created_at)));
  return resolved ? null : parsed;
}

// Returns whether the email actually went out, so Co never says it did when
// it didn't (Resend reports failures in the result, not by throwing).
// Held by the matching pause: the pair goes back to both_interested (it isn't introduced yet), marked held once (logged
// once), and retryHeldNetworkIntros sends it when the pause lifts.
async function holdNetworkIntro(a: MatchNudgeCandidate, b: MatchNudgeCandidate, why: string): Promise<void> {
  const [x, y] = a.user_id < b.user_id ? [a.user_id, b.user_id] : [b.user_id, a.user_id];
  const { rows } = await pool
    .query(
      `UPDATE network_introductions SET status = 'both_interested', introduced_at = NULL, email_held_at = COALESCE(email_held_at, NOW())
       WHERE person_a_id = $1 AND person_b_id = $2 AND email_sent_at IS NULL RETURNING (email_held_at = NOW()) AS first`,
      [x, y],
    )
    .catch(() => ({ rows: [] as any[] }));
  if (rows[0]?.first) await recordDecision({ layer: 6, decision: "match.pause", userId: a.user_id, outcome: "skip", action: "networkIntroEmail.held", proposal: { b: b.user_id }, reason: why }).catch(() => {});
}

// "sent", "held" (the pause; it goes when the pause lifts) or "failed".
// The email's reason (a shared ask, checked at the reveal) is checked once more against both members' hidden parts (private
// asks and blockers, harness/hiddenEcho.ts): both of them read it. A failed read holds the email (fails closed).
export async function introEmailHiddenCheck(reason: string, userIds: string[]): Promise<{ name: string; pass: boolean; reason?: string }> {
  const { hiddenSideOf, SENSITIVE } = await import("../harness/matchGate.js");
  const { hiddenEcho } = await import("../harness/hiddenEcho.js");
  try {
    const sides = await Promise.all(userIds.map((id) => hiddenSideOf(id)));
    const shared = sides.flatMap((x) => x.shared);
    for (const side of sides) {
      // A sensitive word in this member's hidden part gets through only from their own shareable asks, never the other's.
      const why = hiddenEcho(String(reason ?? "").replace(/^what they(?:'|\u2019)ve said they(?:(?:'|\u2019)re looking for| can offer):\s*/i, ""), side.hidden, shared, [], SENSITIVE, side.shared);
      if (why) return { name: "email_no_hidden_echo", pass: false, reason: why };
    }
    return { name: "email_no_hidden_echo", pass: true };
  } catch {
    return { name: "email_no_hidden_echo", pass: false, reason: "couldn't read what they keep private" };
  }
}

async function sendNetworkIntroEmail(a: MatchNudgeCandidate, b: MatchNudgeCandidate, matchReason: string): Promise<"sent" | "held" | "failed"> {
  const [aYes, bYes] = await Promise.all([networkOptedIn(a.user_id, b.user_id), networkOptedIn(b.user_id, a.user_id)]);
  // The matching kill switch (all events) holds the email instead of dropping it; Co never says it went.
  const paused = await (await import("./roomMatching.js")).matchingPause(null);
  if (paused && aYes && bYes) {
    await holdNetworkIntro(a, b, paused);
    return "held";
  }
  // Already connected another way (an event intro, one of them said so, a personal invite): no intro email (services/knownConnections.ts).
  const connected = await (await import("./knownConnections.js")).alreadyConnected(a.user_id, b.user_id, { exceptNetwork: true });
  const connectedCheck = connected.known ? { name: "not_already_connected", pass: false, reason: connected.why } : { name: "not_already_connected", pass: true };
  // A member with no email (none, or the placeholder, never a send address) gets the intro by text (Royce, 2026-11-03: services/
  // introByText.ts). Neither an email nor a phone for one of them: not sent.
  const IT = await import("./introByText.js");
  const channels = IT.introChannels(a as any, b as any);
  const reachCheck = channels.text.some((p) => !p.phone_number) ? { name: "both_reachable", pass: false, reason: "one of them has no email and no phone" } : { name: "both_reachable", pass: true };
  if (!(await gateIntroAction(a.user_id, "networkIntroNudge.introEmail", [checkBothYes(aYes, bYes), await introEmailHiddenCheck(matchReason, [a.user_id, b.user_id]), connectedCheck, reachCheck], { b: b.user_id }))) return "failed";
  // The pair in one order (by id), so a retry from either side or after a crash builds the very same email: the send's
  // idempotency key covers the same body only (as eventGuestMatchHandoff.ts introEmailContent).
  const [p1, p2] = a.user_id < b.user_id ? [a, b] : [b, a];
  const subject = `Introducing ${p1.first_name} and ${p2.first_name}`;
  // The text side first (review of the onboarding branch): if it can't go, nothing is sent and the pair stays retryable, with no
  // email out that a retry could send again.
  const relayOn = (await import("./relay.js")).relayEnabled();
  if (channels.text.length) {
    const t = await IT.textIntro({ to: channels.text, pair: [p1 as any, p2 as any], why: { reason: matchReason }, relayOn, key: `network-intro:${p1.user_id}:${p2.user_id}` });
    if (!t.ok) {
      console.error("sendNetworkIntroEmail: the intro text didn't go (non-fatal):", t.results.find((r) => !r.sent && !r.queued)?.reason);
      return "failed";
    }
  }
  const body = [matchReason, "Cue figured you two should actually meet. Consider this your introduction."];
  const close = IT.emailCloseFor(channels, relayOn);
  const html = galleryEmail({
    preview: `Cue thinks you two should meet.`,
    eyebrow: "An introduction",
    headline: `${p1.first_name}, meet ${p2.first_name}.`,
    body,
    close,
  });
  const emailTo = channels.email.map((p) => p.email as string);
  if (!emailTo.length) {
    // Nobody to email: the text below is the whole intro.
  } else if (!ALLOW_REAL_SENDS) {
    console.log(`[sendNetworkIntroEmail stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${emailTo.join(", ")}: ${subject}`);
  } else {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Co CC'd (Royce, 2026-09-07: "Co would need to be the driver of the
      // email") — visibly present on the thread so a reply-all naturally
      // includes it, matching the group-chat design's spirit. No reply
      // parsing built for this — Resend has no inbound capability at all,
      // and email has no natural "@-mention" convention the way a group
      // chat does, so Co doesn't act on anything that comes back here; the
      // real outcome signal stays the existing proactive SMS check-in.
      // One email per pair, even when a stale claim is retaken after a send went out (Resend keeps the key 24h).
      const { error } = await resend.emails.send({ from: CO_EMAIL_FROM, to: emailTo, cc: ["hello@copatible.com"], subject, html }, { idempotencyKey: `network-intro:${p1.user_id}:${p2.user_id}` });
      const outcome = (await import("./eventGuestMatchHandoff.js")).introSendOutcome(error as any);
      if (outcome === "already_sent") console.log("sendNetworkIntroEmail: this pair was already emailed under this key; recording it as sent");
      else if (outcome === "in_flight") throw new Error("a send with this key is in flight");
      else if (error) throw new Error(error.message);
    } catch (err: any) {
      console.error("sendNetworkIntroEmail: send failed (non-fatal):", err?.message ?? err);
      return "failed";
    }
  }
  const [x, y] = a.user_id < b.user_id ? [a.user_id, b.user_id] : [b.user_id, a.user_id];
  // The send's record, tried a few times: unrecorded, the claim goes stale and is retaken. The retake is bounded to the key's life
  // (NETWORK_RETAKE_MAX_HOURS), so it can't send again; past that it's logged and left.
  if (!(await recordNetworkSent(x, y))) {
    console.error(`sendNetworkIntroEmail: the email went but its record didn't save (${x}, ${y}); a retake within ${NETWORK_RETAKE_MAX_HOURS}h is deduplicated by the key`);
    await recordDecision({ layer: 6, decision: "match.introEmail", userId: a.user_id, outcome: "skip", action: "sent_unrecorded", proposal: { a: x, b: y }, reason: "email_sent_at write failed after the send" }).catch(() => {});
  }
  await writeMemory(a.user_id, "event_intro_email_sent", `Sent a network intro ${channels.text.length ? (channels.email.length ? "by email and text" : "by text") : "email"} connecting ${a.first_name} and ${b.first_name}: ${matchReason}`);
  // Introduced after both said yes: the only people a relay can reach (services/relay.ts).
  await import("./relay.js").then((r) => r.recordConnection(a.user_id, b.user_id, "network_intro")).catch(() => {});
  // Its outcome record (services/roomMatching.ts NETWORK_PAIR_EVENT): the same per-pair record event intros have, each side's own.
  await import("./roomMatching.js").then((RM) => RM.noteNetworkPairIntroduced(a.user_id, b.user_id, matchReason)).catch(() => false);
  return "sent";
}

// "Did it help?" for the intro itself: a follow-up for both people about five days out, delivered through the same
// next-morning debrief as events (tier 0 marks an intro; services/outcomes.ts records the answer).
async function scheduleIntroFollowUps(pairs: (readonly [string, string])[]): Promise<void> {
  const followupDate = new Date(Date.now() + 4 * 24 * 3600_000).toISOString().slice(0, 10);
  for (const [uid, otherName] of pairs) {
    await pool
      .query(
        `INSERT INTO recommendation_outcome_followups (user_id, ask_text, tier, match_name, match, send_at)
         SELECT $1::uuid, $2::text, 0, $3::text, $4::jsonb, NOW() + INTERVAL '5 days'
         WHERE NOT EXISTS (SELECT 1 FROM recommendation_outcome_followups WHERE user_id = $1 AND lower(match_name) = lower($3))`,
        [uid, "an intro Cue made", `your intro to ${otherName}`, JSON.stringify({ kind: "intro", event_date: followupDate })],
      )
      .catch((err: any) => console.error("network intro: follow-up schedule failed (non-fatal):", err?.message ?? err));
  }
}

// Network intro emails that didn't go: held by the matching pause (sent once it lifts), a send that failed, or a claim no send
// confirmed, with the same limits as in-room ones (both still active, both still yes, at most INTRO_MAX_ATTEMPTS tries, within
// INTRO_RETRY_MAX_AGE_MS of the hold or claim), oldest first, every limit in the WHERE clause.
export async function retryHeldNetworkIntros(now = new Date()): Promise<number> {
  const RM = await import("./roomMatching.js");
  // Before the pause check (a long pause is how a claim outlives the key): stranded claims are marked and logged.
  await markStrandedNetworkIntros().catch((err: any) => console.error("network intro: marking stranded claims failed (non-fatal):", err?.message ?? err));
  if (await RM.matchingPause(null)) return 0;
  const { rows } = await pool.query(retryHeldNetworkIntrosSql(RM.INTRO_MAX_ATTEMPTS, RM.INTRO_RETRY_MAX_AGE_MS)).catch(() => ({ rows: [] as any[] }));
  let sent = 0;
  for (const r of rows) {
    // The same claim as a live yes: only the call that marks it introduced sends.
    // A claim no send confirmed (the server died between the claim and the send's record) is retaken once it's stale; the send's
    // idempotency key makes a retake after a send that did go out record it, never send it twice.
    const claimed = await pool
      .query(
        `UPDATE network_introductions SET status = 'introduced', introduced_at = NOW(), email_claimed_at = NOW() WHERE person_a_id = $1 AND person_b_id = $2 AND email_sent_at IS NULL
           AND (status = 'both_interested' OR (status = 'introduced' AND email_claimed_at < NOW() - INTERVAL '${NETWORK_CLAIM_STALE_MINUTES} minutes' AND email_claimed_at > NOW() - INTERVAL '${NETWORK_RETAKE_MAX_HOURS} hours')) RETURNING 1`,
        [r.person_a_id, r.person_b_id],
      )
      .catch(() => ({ rows: [] as any[] }));
    if (!claimed.rows.length) continue;
    const { rows: us } = await pool.query(`SELECT id AS user_id, first_name, phone_number, email FROM users WHERE id = ANY($1::uuid[])`, [[r.person_a_id, r.person_b_id]]);
    const a = us.find((u: any) => u.user_id === r.person_a_id);
    const b = us.find((u: any) => u.user_id === r.person_b_id);
    const result = a && b ? await sendNetworkIntroEmail(a, b, r.match_reason) : "failed";
    if (result === "sent") {
      sent++;
      await scheduleIntroFollowUps([[a.user_id, b.first_name], [b.user_id, a.first_name]] as const);
    } else if (result === "failed") {
      await pool.query(`UPDATE network_introductions SET status = 'both_interested', introduced_at = NULL, email_attempts = email_attempts + 1 WHERE person_a_id = $1 AND person_b_id = $2`, [r.person_a_id, r.person_b_id]).catch(() => {});
    }
  }
  return sent;
}

// A network intro's claim no send confirmed is retaken after this long (the same as an in-room one, roomMatching.ts), and only
// within the send key's life (Resend keeps an idempotency key 24h): a retake later than that could send a second email.
export const NETWORK_CLAIM_STALE_MINUTES = 15;
export const NETWORK_RETAKE_MAX_HOURS = 23;

// What's known about a claimed intro's email: sent (recorded), pending (claimed, still inside the key's life, so a retake can
// finish it), or unknown (claimed, never recorded, past the key's life: it may or may not have gone, and resending could send twice).
export type NetworkEmailState = "sent" | "pending" | "unknown";
export function networkEmailState(r: { email_sent?: unknown; email_outcome?: unknown } | null | undefined): NetworkEmailState {
  if (r?.email_sent === true) return "sent";
  return r?.email_outcome === "unknown" ? "unknown" : "pending";
}

// Pure: what a later yes is told about an intro already claimed. "Sent" only when the send was recorded; "coming" only while a
// retake can still finish it; past that, plainly that Co can't confirm it, with no promise.
// `how`: services/introByText.ts introHowNote, how the intro reaches each of them (a member with no email gets it by text).
export function alreadyIntroducedLine(firstName: string, state: NetworkEmailState, how = ""): string {
  const h = how ? ` ${how}` : "";
  if (state === "sent") return `\nThey said yes to ${firstName} again; the two of them were already introduced.${h} Acknowledge briefly, don't send or promise another intro.`;
  if (state === "unknown") return `\nThey said yes to ${firstName}; both of them are in, but Cue can't confirm the intro went through.${h} Tell them plainly it may not have reached them, and to tell you if they don't have it. Don't say it was sent, and don't promise it's coming.`;
  return `\nThey said yes to ${firstName}; both of them are in and the intro is on its way.${h} Tell them plainly the intro is coming. Don't say it was sent, and don't say when. Don't promise another.`;
}

async function networkEmailSent(x: string, y: string): Promise<NetworkEmailState> {
  const { rows } = await pool.query(`SELECT email_sent_at IS NOT NULL AS email_sent, email_outcome FROM network_introductions WHERE person_a_id = $1 AND person_b_id = $2`, [x, y]).catch(() => ({ rows: [] as any[] }));
  // A failed read is "can't confirm": never said as sent or coming on a guess.
  return rows[0] ? networkEmailState(rows[0]) : "unknown";
}

// Claims no send confirmed, past the key's life (a crash, then a pause that outlasted it): never retaken (that could send twice),
// so marked unknown, once, and logged.
export const STRANDED_NETWORK_INTROS_SQL = `UPDATE network_introductions SET email_outcome = 'unknown'
       WHERE status = 'introduced' AND email_sent_at IS NULL AND email_outcome IS NULL
         AND email_claimed_at <= NOW() - INTERVAL '${NETWORK_RETAKE_MAX_HOURS} hours'
       RETURNING person_a_id, person_b_id, email_claimed_at`;
async function markStrandedNetworkIntros(): Promise<number> {
  const { rows } = await pool.query(STRANDED_NETWORK_INTROS_SQL);
  for (const r of rows) {
    console.error(`network intro: claim from ${new Date(r.email_claimed_at).toISOString()} never confirmed and past the send key's life (${r.person_a_id}, ${r.person_b_id}); outcome unknown`);
    await recordDecision({ layer: 6, decision: "match.introEmail", userId: r.person_a_id, outcome: "skip", action: "outcome_unknown", proposal: { a: r.person_a_id, b: r.person_b_id }, reason: "claim never confirmed, past the idempotency key's life; not retaken" }).catch(() => {});
  }
  return rows.length;
}

// The send's record, retried: true once email_sent_at is written.
export async function recordNetworkSent(x: string, y: string, tries = 3, db: { query: (s: string, p: unknown[]) => Promise<unknown> } = pool): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await db.query(`UPDATE network_introductions SET email_sent_at = COALESCE(email_sent_at, NOW()) WHERE person_a_id = $1 AND person_b_id = $2`, [x, y]);
      return true;
    } catch {
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return false;
}

// Pure, for the checks: the held-email query (held by the pause, failed and counted, or a stale unconfirmed claim), every limit in
// the WHERE clause, oldest first. An intro from before the claim column has no claim and is never retaken.
export function retryHeldNetworkIntrosSql(maxAttempts: number, maxAgeMs: number): string {
  return `SELECT n.person_a_id, n.person_b_id, n.match_reason FROM network_introductions n
       JOIN users ua ON ua.id = n.person_a_id JOIN users ub ON ub.id = n.person_b_id
       WHERE n.email_sent_at IS NULL
         AND ((n.status = 'both_interested' AND (n.email_held_at IS NOT NULL OR n.email_attempts > 0))
           OR (n.status = 'introduced' AND n.email_claimed_at < NOW() - INTERVAL '${NETWORK_CLAIM_STALE_MINUTES} minutes' AND n.email_claimed_at > NOW() - INTERVAL '${NETWORK_RETAKE_MAX_HOURS} hours'))
         AND n.email_attempts < ${maxAttempts}
         AND COALESCE(n.email_held_at, n.email_claimed_at) > NOW() - INTERVAL '${maxAgeMs / 86_400_000} days'
         AND ua.archived_at IS NULL AND ub.archived_at IS NULL AND NOT coalesce(ua.sms_opted_out, false) AND NOT coalesce(ub.sms_opted_out, false)
       ORDER BY COALESCE(n.email_held_at, n.email_claimed_at) ASC
       LIMIT 20`;
}

// Pure: why a direct ask to x about this pair shouldn't go now (x already said yes, the pair declined, both in, introduced).
export function networkAskStaleReason(row: { status?: string | null; a_interested_at?: unknown; b_interested_at?: unknown } | null, xIsA: boolean): string | null {
  if (!row) return null;
  if (xIsA ? row.a_interested_at : row.b_interested_at) return "they already said yes";
  if (row.status && ["both_interested", "introduced", "declined"].includes(row.status)) return `pair is ${row.status}`;
  return null;
}

export async function networkAskStale(x: string, y: string): Promise<string | null> {
  // Right before a queued or deferred ask goes: a connection added meanwhile stops it (services/knownConnections.ts).
  const known = await (await import("./knownConnections.js")).knownReason(x, y, "networkIntroNudge.askStale");
  if (known) return known;
  const [a, b] = x < y ? [x, y] : [y, x];
  const { rows } = await pool.query(`SELECT status, a_interested_at, b_interested_at FROM network_introductions WHERE person_a_id = $1 AND person_b_id = $2`, [a, b]).catch(() => ({ rows: [] as any[] }));
  return networkAskStaleReason(rows[0] ?? null, x === a);
}

export async function askCandidateDirectly(candidate: MatchNudgeCandidate, asker: MatchNudgeCandidate, matchReason: string, askId: string | null): Promise<void> {
  // The message tells the candidate the asker wants an intro, so that has
  // to be on record first.
  const askerOptedIn = await networkOptedIn(asker.user_id, candidate.user_id);
  const message = await withMember(candidate.user_id, () =>
    draftWithConsent(
    {
      decision: "networkIntroNudge.directAsk",
      recipientId: candidate.user_id,
      otherUserIds: [asker.user_id],
      preChecks: [
        askerOptedIn
          ? { name: "asker_opted_in", pass: true }
          : { name: "asker_opted_in", pass: false, reason: `${asker.first_name} has no recorded yes for this intro` },
      ],
      facts: {
        otherFirstName: asker.first_name,
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
        experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.directAsk.draft" },
        prompt: networkDirectAskPrompt({ recipientFirstName: candidate.first_name, askerFirstName: asker.first_name, feedback }),
      });
      return cleanCoMessage(text.trim());
    },
  ));
  if (!message) return;

  // Read the pair again right before the ask goes (concurrency audit finding 8, 2026-10-12): when both say yes at the same
  // moment, the reply whose upsert came first saw "not both" and went on to ask the other side, who had already said yes
  // (and whose own reply sent the email). Their yes, a decline, or a pair already introduced stops it.
  const stale = await networkAskStale(candidate.user_id, asker.user_id);
  if (stale) {
    await recordDecision({ layer: 6, decision: "network.intro", userId: candidate.user_id, outcome: "skip", action: "networkIntroNudge.directAsk.recheck", proposal: { askerId: asker.user_id }, checks: [{ name: "pair_still_waiting_on_them", pass: false, reason: stale }] }).catch(() => {});
    return;
  }

  // Opt-out and local hours at send time, queued for the next allowed hour
  // if it's night for them (code review, 2026-09-17) — triggered by the
  // ASKER's reply, not anything this candidate just did. sendExempt writes
  // the text_exchange memory itself once actually delivered. Their open
  // question about the asker is stashed only once the ask reaches them
  // (afterDirectAskSent, now or at their 8am from services/deferredSends.ts):
  // stashed while queued, a text of theirs before the morning would bind to an
  // ask they never saw.
  const after = { candidateId: candidate.user_id, askerId: asker.user_id, askerFirstName: asker.first_name, askerPhone: asker.phone_number, askerEmail: asker.email, matchReason, askId };
  const send = {
    userId: candidate.user_id,
    phoneNumber: candidate.phone_number,
    type: "direct_ask" as const,
    targetKey: `network_direct_ask:${[candidate.user_id, asker.user_id].sort().join(":")}`,
    messages: [message],
    timezone: await timezoneFor(candidate.user_id),
    after: { kind: "network_intro_ask" as const, payload: after },
    // Through the door (harness/door.ts): ranked as a possible intro (above any find), gathered with what else is ready for them, the
    // pair read again before it goes; good through tomorrow, and the asker hears plainly if it never went.
    door: { summary: "An intro ask: someone Cue knows would like to meet them", validUntil: (await import("../harness/door.js")).doorValidUntil("intro", new Date(), await timezoneFor(candidate.user_id)), intro: true },
  };
  // The matching kill switch: the asker was told Co would check, so the ask waits in deferred_sends (held while the
  // pause is on) instead of being dropped.
  if (await (await import("./roomMatching.js")).matchingPause(null)) {
    await (await import("./deferredSends.js")).enqueueDeferredSend({ ...send, dueAt: new Date() }).catch((err: any) => console.error("askCandidateDirectly: holding the ask failed (non-fatal):", err?.message ?? err));
    return;
  }
  const result = await sendExemptWhenAllowed(send);
  if (!result.sent && !result.queued) {
    console.error(`askCandidateDirectly: send failed for ${candidate.user_id} (non-fatal):`, result.reason);
  }
}

export async function afterDirectAskSent(p: { candidateId: string; askerId: string; askerFirstName: string; askerPhone: string; askerEmail: string; matchReason: string; askId: string | null }): Promise<void> {
  await stashIntroOfferPending(
    p.candidateId,
    {
      edge_id: "",
      candidate_id: p.askerId,
      first_name: p.askerFirstName,
      phone_number: p.askerPhone,
      email: p.askerEmail,
      match_score: 0,
      match_reason: p.matchReason,
      share_safe: true,
    },
    p.askId,
  );
}

// Shared resolution for BOTH directions of the intro question — the
// original asker replying to their own reveal, and a candidate replying to
// a direct ask — since once revealed, "do you want to meet this named
// person" resolves identically either way.
export async function resolveNetworkIntroReply(
  person: MatchNudgeCandidate,
  pending: PendingNetworkIntroOffer,
  classification: TeaseReplyClassification,
): Promise<string | null> {
  return (await resolveNetworkIntroReplyState(person, pending, classification))?.context ?? null;
}

// What happened to the intro on this reply, as data (final review: the reply's fact was picked by matching this file's wording, and a
// repeated yes was told no intro had been made). sendblue picks the fact from `state` (networkIntroFact), never from the words.
export type NetworkIntroState = "declined" | "asked" | "sent" | "held" | "failed" | "already" | "pending" | "unconfirmed";
export type NetworkIntroResult = { context: string; state: NetworkIntroState; how: string };
const ALREADY_STATE: Record<NetworkEmailState, NetworkIntroState> = { sent: "already", pending: "pending", unknown: "unconfirmed" };

// Pure: the reply's fact for each state. Only "sent" says the intro went this turn; "already" says it went earlier.
export function networkIntroFact(state: NetworkIntroState, other: string, how: string): string {
  const h = how ? ` ${how}` : "";
  switch (state) {
    case "declined": return `Recorded that they passed on an intro to ${other}.`;
    case "asked": return `Asked ${other} whether they're open to an intro. Waiting to hear back; no intro has been made. If ${other} says yes, Cue introduces them.`;
    case "sent": return `${other} had already said yes, so Cue sent the intro.${h}`;
    case "held": return `${other} had already said yes too. The intro hasn't gone out yet; Cue will send it.${h}`;
    case "failed": return `${other} had already said yes too. The intro didn't go through yet; Cue will try again.${h}`;
    case "already": return `They and ${other} were already introduced earlier. No new intro went this turn.${h}`;
    case "pending": return `They and ${other} both said yes; the intro is on its way and isn't confirmed sent yet.${h}`;
    case "unconfirmed": return `They and ${other} both said yes, but Cue can't confirm the intro went through.${h}`;
  }
}

export async function resolveNetworkIntroReplyState(
  person: MatchNudgeCandidate,
  pending: PendingNetworkIntroOffer,
  classification: TeaseReplyClassification,
): Promise<NetworkIntroResult | null> {
  if (classification === "unrelated") return null;

  const candidateId = pending.candidate.candidate_id;
  const [aId, bId] = canonicalPair(person.user_id, candidateId);
  const isPersonA = person.user_id === aId;
  const interestedCol = isPersonA ? "a_interested_at" : "b_interested_at";
  const otherInterestedCol = isPersonA ? "b_interested_at" : "a_interested_at";
  const initialStatus = isPersonA ? "a_interested" : "b_interested";

  if (classification === "not_interested") {
    await pool
      .query(
        `INSERT INTO network_introductions (person_a_id, person_b_id, status, match_reason, ask_id)
         VALUES ($1, $2, 'declined', $3, $4)
         ON CONFLICT (person_a_id, person_b_id) DO UPDATE SET status = 'declined'`,
        [aId, bId, pending.candidate.match_reason, pending.askId],
      )
      .catch((err: any) => console.error("resolveNetworkIntroReply: decline write failed (non-fatal):", err?.message ?? err));
    return { state: "declined", how: "", context: `\nThey just passed on being connected with ${pending.candidate.first_name} (internal only, never say this name back to them as a pressure tactic). Acknowledge lightly, no pressure, don't explain further.` };
  }

  const { rows } = await pool.query(
    `INSERT INTO network_introductions (person_a_id, person_b_id, status, match_reason, ask_id, ${interestedCol})
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (person_a_id, person_b_id) DO UPDATE SET
       ${interestedCol} = COALESCE(network_introductions.${interestedCol}, NOW()),
       status = CASE WHEN network_introductions.status IN ('introduced', 'declined') THEN network_introductions.status
                     WHEN network_introductions.${otherInterestedCol} IS NOT NULL THEN 'both_interested' ELSE $3 END
     RETURNING status, ${otherInterestedCol} IS NOT NULL AS both_interested, email_sent_at IS NOT NULL AS email_sent, email_outcome, match_reason`,
    [aId, bId, initialStatus, pending.candidate.match_reason, pending.askId],
  );
  const bothInterested = rows[0]?.both_interested === true;
  // Already introduced (a repeated reply, a retried turn): no second intro. Said as sent only when the send was recorded.
  // How the intro reaches each of them, for every line below (a member with no email gets it by text: never "check your email").
  const how = (await import("./introByText.js")).introHowNote(person as any, { user_id: pending.candidate.candidate_id, first_name: pending.candidate.first_name, phone_number: pending.candidate.phone_number, email: pending.candidate.email });
  if (rows[0]?.status === "introduced") {
    const st = networkEmailState(rows[0]);
    return { state: ALREADY_STATE[st], how, context: alreadyIntroducedLine(pending.candidate.first_name, st, how) };
  }
  // The body comes from the pair's stored reason (the first one written), the same one a retry reads: one body per key.
  const storedReason = String(rows[0]?.match_reason ?? pending.candidate.match_reason);

  if (bothInterested) {
    // Only the call that marks it introduced sends the email (2026-10-01 next-live run: two calls sent two).
    const claimed = await pool
      .query(`UPDATE network_introductions SET status = 'introduced', introduced_at = NOW(), email_claimed_at = NOW() WHERE person_a_id = $1 AND person_b_id = $2 AND status <> 'introduced' RETURNING 1`, [aId, bId])
      .then((r) => r.rows.length > 0)
      // A failed mark keeps the old behaviour (send); only a confirmed "already introduced" stops it.
      .catch((err: any) => { console.error("resolveNetworkIntroReply: introduced-mark failed (non-fatal):", err?.message ?? err); return null; });
    if (claimed === false) {
      const st = await networkEmailSent(aId, bId);
      return { state: ALREADY_STATE[st], how, context: alreadyIntroducedLine(pending.candidate.first_name, st, how) };
    }
    const candidateInfo: MatchNudgeCandidate = {
      user_id: pending.candidate.candidate_id,
      first_name: pending.candidate.first_name,
      phone_number: pending.candidate.phone_number,
      email: pending.candidate.email,
    };
    const emailed = await sendNetworkIntroEmail(person, candidateInfo, storedReason);
    if (emailed === "held") {
      return { state: "held", how, context: `\nThey just said yes to being connected with ${pending.candidate.first_name}, and ${pending.candidate.first_name} had already said yes too. The intro hasn't gone out yet; Cue will send it. ${how} Tell them plainly that both of you are in and the intro is coming. Don't say it was sent, and don't say when.` };
    }
    if (emailed !== "sent") {
      // Not introduced: the pair goes back to waiting on its email, counted, and retryHeldNetworkIntros tries again (before this, a
      // failed send stayed 'introduced' with no email, so nothing retried it and a later yes was told the intro had gone out).
      await pool
        .query(`UPDATE network_introductions SET status = 'both_interested', introduced_at = NULL, email_attempts = email_attempts + 1 WHERE person_a_id = $1 AND person_b_id = $2 AND email_sent_at IS NULL`, [aId, bId])
        .catch((err: any) => console.error("resolveNetworkIntroReply: failed-send revert failed (non-fatal):", err?.message ?? err));
      return { state: "failed", how, context: `\nThey just said yes to being connected with ${pending.candidate.first_name}, and ${pending.candidate.first_name} had already said yes too. The intro failed to send. ${how} Tell them plainly that both of you are in, but the intro didn't go through yet. Don't say it was sent.` };
    }
    await scheduleIntroFollowUps([[person.user_id, pending.candidate.first_name], [pending.candidate.candidate_id, person.first_name]] as const);
    return { state: "sent", how, context: `\nThey just said yes to being connected with ${pending.candidate.first_name}, and ${pending.candidate.first_name} had already said yes too — you've already sent the intro. ${how} Acknowledge warmly and briefly, don't repeat the intro back.` };
  }

  const candidateInfo: MatchNudgeCandidate = {
    user_id: pending.candidate.candidate_id,
    first_name: pending.candidate.first_name,
    phone_number: pending.candidate.phone_number,
    email: pending.candidate.email,
  };
  await askCandidateDirectly(candidateInfo, person, pending.candidate.match_reason, pending.askId);
  return { state: "asked", how, context: `\nThey just said yes to being connected with ${pending.candidate.first_name}. Acknowledge it warmly and briefly — you're now waiting to hear back from ${pending.candidate.first_name}, don't promise a specific thing is happening yet.` };
}

// Exported so evals/intro can run the exact production prompt.
export function networkRevealPrompt(p: { recipientFirstName: string; otherFirstName: string; shareReason: string; feedback: string | null }): string {
  return `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${p.recipientFirstName}. You just told them someone in the network crossed your mind, and they said yes, they want to hear who. Draft a short, warm text (2-3 sentences, no em dashes, normal sentence capitalization) naming ${p.otherFirstName} and explaining in your own words why they're worth meeting: ${p.shareReason}. Use only that reason, and never say ${p.otherFirstName} wants to meet them or said anything about them. End by asking if they'd like you to see if ${p.otherFirstName} is open to it too. Return ONLY the message text.${p.feedback ? `\n\n${p.feedback}` : ""}`;
}

// Exported so evals/intro can run the exact production prompt.
export function networkDirectAskPrompt(p: { recipientFirstName: string; askerFirstName: string; feedback: string | null }): string {
  return `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${p.recipientFirstName}. You suggested ${p.recipientFirstName} to ${p.askerFirstName} as someone worth meeting, and ${p.askerFirstName} said yes to an intro. That is all that happened: ${p.askerFirstName} didn't bring ${p.recipientFirstName} up, ask about them, or reach out on their own, so never say or imply that. Draft a short, warm text (1-2 sentences, no greeting, no em dashes, normal sentence capitalization) saying you think the two of them would get along and ${p.askerFirstName} is up for an intro, and asking if ${p.recipientFirstName} would be open to it too. Low-pressure, genuinely a question. Don't share any contact details. Return ONLY the message text.${p.feedback ? `\n\n${p.feedback}` : ""}`;
}
