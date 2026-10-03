import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Resend } from "resend";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { enqueueCandidate, sendExemptWhenAllowed } from "../harness/proactive.js";
import { writeMemory } from "./memory.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import type { MatchNudgeCandidate } from "./eventGuestMatchHandoff.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { gateNetworkCandidate } from "../harness/matchGate.js";
import { checkBothYes, draftWithConsent, gateIntroAction, networkOptedIn } from "../harness/introConsent.js";
import { getActiveAsks } from "./matching.js";
import { getTimezoneForCity } from "./geocoding.js";
import { MODELS } from "../models.js";
import { CO_EMAIL_FROM } from "./emailFrom.js";
import { galleryEmail } from "./emailDesign.js";

// Model policy (Royce, 2026-09-14): Haiku for the yes/no reply reads (code
// acts on them only through the consent checks); Sonnet 5 for drafts that
// name another person.
const CLASSIFY_MODEL = MODELS.haiku;
const NAMING_DRAFT_MODEL = MODELS.sonnet;

async function statedAsksFor(userId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return getActiveAsks(rows[0]?.intent);
}

// This person's timezone, for the hours check on a reply-triggered direct
// ask (code review, 2026-09-17 — see harness/proactive.ts's sendExemptWhenAllowed).
async function timezoneFor(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const city = rows[0]?.city;
  return city ? await getTimezoneForCity(city).catch(() => null) : null;
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

// A pair already has a network_introductions row (suggested, decided, or
// introduced either way) — never re-suggest it, regardless of which
// person's ask or which relevance direction produced the candidate again.
async function alreadySuggested(personId: string, candidateId: string): Promise<boolean> {
  const [a, b] = canonicalPair(personId, candidateId);
  const { rows } = await pool.query(`SELECT 1 FROM network_introductions WHERE person_a_id = $1 AND person_b_id = $2`, [a, b]);
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
    summary: `Someone in Co's network who fits what they're looking for (not named until they say yes): ${item.candidate.match_reason.slice(0, 160)}`,
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
         ON CONFLICT (person_a_id, person_b_id) DO NOTHING`,
        [a, b, pending.candidate.match_reason, pending.askId],
      )
      .catch((err: any) => console.error("resolveNetworkTeaseReply: decline write failed (non-fatal):", err?.message ?? err));
    return `\nThey just passed on even hearing who it was (internal only, never say the name back to them). Acknowledge lightly, no pressure, don't explain further.`;
  }

  // Re-gate at reveal time: the candidate may have gone inactive, been
  // introduced another way, or the reason may not pass the privacy check.
  const candidateId = pending.candidate.candidate_id;
  const cantReveal = `\nThey said yes to hearing who it was, but that introduction isn't available anymore. Say so briefly and honestly, don't name or describe anyone, and don't promise another one.`;
  if (!(await gateNetworkCandidate(userId, candidateId, pending.candidate.match_reason, "reveal"))) return cantReveal;

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
async function sendNetworkIntroEmail(a: MatchNudgeCandidate, b: MatchNudgeCandidate, matchReason: string): Promise<boolean> {
  const [aYes, bYes] = await Promise.all([networkOptedIn(a.user_id, b.user_id), networkOptedIn(b.user_id, a.user_id)]);
  if (!(await gateIntroAction(a.user_id, "networkIntroNudge.introEmail", [checkBothYes(aYes, bYes)], { b: b.user_id }))) return false;
  const subject = `Introducing ${a.first_name} and ${b.first_name}`;
  const html = galleryEmail({
    preview: `Co thinks you two should meet.`,
    eyebrow: "An introduction",
    headline: `${a.first_name}, meet ${b.first_name}.`,
    body: [matchReason, "Co figured you two should actually meet. Consider this your introduction."],
    close: "You both said yes. Take it from here.",
  });
  if (!ALLOW_REAL_SENDS) {
    console.log(`[sendNetworkIntroEmail stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${a.email}, ${b.email}: ${subject}`);
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
      const { error } = await resend.emails.send({ from: CO_EMAIL_FROM, to: [a.email, b.email], cc: ["hello@copatible.com"], subject, html });
      if (error) throw new Error(error.message);
    } catch (err: any) {
      console.error("sendNetworkIntroEmail: send failed (non-fatal):", err?.message ?? err);
      return false;
    }
  }
  await writeMemory(a.user_id, "event_intro_email_sent", `Sent a network intro email connecting ${a.first_name} and ${b.first_name}: ${matchReason}`);
  // Introduced after both said yes: the only people a relay can reach (services/relay.ts).
  await import("./relay.js").then((r) => r.recordConnection(a.user_id, b.user_id, "network_intro")).catch(() => {});
  return true;
}

async function askCandidateDirectly(candidate: MatchNudgeCandidate, asker: MatchNudgeCandidate, matchReason: string, askId: string | null): Promise<void> {
  // The message tells the candidate the asker wants an intro, so that has
  // to be on record first.
  const askerOptedIn = await networkOptedIn(asker.user_id, candidate.user_id);
  const message = await draftWithConsent(
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
        experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.directAsk.draft" },
        prompt: networkDirectAskPrompt({ recipientFirstName: candidate.first_name, askerFirstName: asker.first_name, feedback }),
      });
      return cleanCoMessage(text.trim());
    },
  );
  if (!message) return;

  // Opt-out and local hours at send time, queued for the next allowed hour
  // if it's night for them (code review, 2026-09-17) — triggered by the
  // ASKER's reply, not anything this candidate just did. sendExempt writes
  // the text_exchange memory itself once actually delivered.
  const result = await sendExemptWhenAllowed({
    userId: candidate.user_id,
    phoneNumber: candidate.phone_number,
    type: "direct_ask",
    targetKey: `network_direct_ask:${[candidate.user_id, asker.user_id].sort().join(":")}`,
    messages: [message],
    timezone: await timezoneFor(candidate.user_id),
  });
  if (!result.sent && !result.queued) {
    console.error(`askCandidateDirectly: send failed for ${candidate.user_id} (non-fatal):`, result.reason);
    return;
  }
  await stashIntroOfferPending(
    candidate.user_id,
    {
      edge_id: "",
      candidate_id: asker.user_id,
      first_name: asker.first_name,
      phone_number: asker.phone_number,
      email: asker.email,
      match_score: 0,
      match_reason: matchReason,
      share_safe: true,
    },
    askId,
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
    return `\nThey just passed on being connected with ${pending.candidate.first_name} (internal only, never say this name back to them as a pressure tactic). Acknowledge lightly, no pressure, don't explain further.`;
  }

  const { rows } = await pool.query(
    `INSERT INTO network_introductions (person_a_id, person_b_id, status, match_reason, ask_id, ${interestedCol})
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (person_a_id, person_b_id) DO UPDATE SET
       ${interestedCol} = COALESCE(network_introductions.${interestedCol}, NOW()),
       status = CASE WHEN network_introductions.status IN ('introduced', 'declined') THEN network_introductions.status
                     WHEN network_introductions.${otherInterestedCol} IS NOT NULL THEN 'both_interested' ELSE $3 END
     RETURNING status, ${otherInterestedCol} IS NOT NULL AS both_interested`,
    [aId, bId, initialStatus, pending.candidate.match_reason, pending.askId],
  );
  const bothInterested = rows[0]?.both_interested === true;
  // Already introduced (a repeated reply, a retried turn): no second intro.
  if (rows[0]?.status === "introduced") {
    return `\nThey said yes to ${pending.candidate.first_name} again; the two of them were already introduced by email. Acknowledge briefly, don't send or promise another intro.`;
  }

  if (bothInterested) {
    // Only the call that marks it introduced sends the email (2026-10-01 next-live run: two calls sent two).
    const claimed = await pool
      .query(`UPDATE network_introductions SET status = 'introduced', introduced_at = NOW() WHERE person_a_id = $1 AND person_b_id = $2 AND status <> 'introduced' RETURNING 1`, [aId, bId])
      .then((r) => r.rows.length > 0)
      // A failed mark keeps the old behaviour (send); only a confirmed "already introduced" stops it.
      .catch((err: any) => { console.error("resolveNetworkIntroReply: introduced-mark failed (non-fatal):", err?.message ?? err); return null; });
    if (claimed === false) return `\nThey said yes to ${pending.candidate.first_name}; that intro has already gone out. Acknowledge briefly, don't send or promise another.`;
    const candidateInfo: MatchNudgeCandidate = {
      user_id: pending.candidate.candidate_id,
      first_name: pending.candidate.first_name,
      phone_number: pending.candidate.phone_number,
      email: pending.candidate.email,
    };
    const emailed = await sendNetworkIntroEmail(person, candidateInfo, pending.candidate.match_reason);
    if (!emailed) {
      return `\nThey just said yes to being connected with ${pending.candidate.first_name}, and ${pending.candidate.first_name} had already said yes too. The intro email to both of them failed to send. Tell them plainly that both of you are in, but the intro email didn't go through yet. Don't say it was sent.`;
    }
    // "Did it help?" for the intro itself: a follow-up for both people about
    // five days out, delivered through the same next-morning debrief as events
    // (tier 0 marks an intro; services/outcomes.ts records the answer).
    const followupDate = new Date(Date.now() + 4 * 24 * 3600_000).toISOString().slice(0, 10);
    for (const [uid, otherName] of [[person.user_id, pending.candidate.first_name], [pending.candidate.candidate_id, person.first_name]] as const) {
      await pool
        .query(
          `INSERT INTO recommendation_outcome_followups (user_id, ask_text, tier, match_name, match, send_at)
           SELECT $1::uuid, $2::text, 0, $3::text, $4::jsonb, NOW() + INTERVAL '5 days'
           WHERE NOT EXISTS (SELECT 1 FROM recommendation_outcome_followups WHERE user_id = $1 AND lower(match_name) = lower($3))`,
          [uid, "an intro Co made", `your intro to ${otherName}`, JSON.stringify({ kind: "intro", event_date: followupDate })],
        )
        .catch((err: any) => console.error("resolveNetworkIntroReply: intro follow-up schedule failed (non-fatal):", err?.message ?? err));
    }
    return `\nThey just said yes to being connected with ${pending.candidate.first_name}, and ${pending.candidate.first_name} had already said yes too — you've already sent a real intro email to both of them. Acknowledge warmly and briefly, don't repeat the email content back.`;
  }

  const candidateInfo: MatchNudgeCandidate = {
    user_id: pending.candidate.candidate_id,
    first_name: pending.candidate.first_name,
    phone_number: pending.candidate.phone_number,
    email: pending.candidate.email,
  };
  await askCandidateDirectly(candidateInfo, person, pending.candidate.match_reason, pending.askId);
  return `\nThey just said yes to being connected with ${pending.candidate.first_name}. Acknowledge it warmly and briefly — you're now waiting to hear back from ${pending.candidate.first_name}, don't promise a specific thing is happening yet.`;
}

// Exported so evals/intro can run the exact production prompt.
export function networkRevealPrompt(p: { recipientFirstName: string; otherFirstName: string; shareReason: string; feedback: string | null }): string {
  return `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${p.recipientFirstName}. You just told them someone in the network crossed your mind, and they said yes, they want to hear who. Draft a short, warm text (2-3 sentences, no em dashes, normal sentence capitalization) naming ${p.otherFirstName} and explaining in your own words why they're worth meeting: ${p.shareReason}. Use only that reason, and never say ${p.otherFirstName} wants to meet them or said anything about them. End by asking if they'd like you to see if ${p.otherFirstName} is open to it too. Return ONLY the message text.${p.feedback ? `\n\n${p.feedback}` : ""}`;
}

// Exported so evals/intro can run the exact production prompt.
export function networkDirectAskPrompt(p: { recipientFirstName: string; askerFirstName: string; feedback: string | null }): string {
  return `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${p.recipientFirstName}. You suggested ${p.recipientFirstName} to ${p.askerFirstName} as someone worth meeting, and ${p.askerFirstName} said yes to an intro. That is all that happened: ${p.askerFirstName} didn't bring ${p.recipientFirstName} up, ask about them, or reach out on their own, so never say or imply that. Draft a short, warm text (1-2 sentences, no greeting, no em dashes, normal sentence capitalization) saying you think the two of them would get along and ${p.askerFirstName} is up for an intro, and asking if ${p.recipientFirstName} would be open to it too. Low-pressure, genuinely a question. Don't share any contact details. Return ONLY the message text.${p.feedback ? `\n\n${p.feedback}` : ""}`;
}
