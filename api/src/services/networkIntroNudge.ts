import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Resend } from "resend";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { tryClaimProactiveNudge } from "./proactiveThrottle.js";
import { writeMemory } from "./memory.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import type { MatchNudgeCandidate } from "./eventGuestMatchHandoff.js";

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
  match_reason: string;
};

type BacklogItem = { askId: string; candidate: NetworkCandidate };

async function getBacklog(userId: string, askId: string): Promise<BacklogItem[]> {
  const { rows } = await pool.query(`SELECT items FROM network_backlogs WHERE user_id = $1 AND ask_id = $2`, [userId, askId]);
  return (rows[0]?.items as BacklogItem[]) ?? [];
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
    `SELECT edge_id, candidate_id, match_score, match_reason, first_name, phone_number, email FROM (
       SELECT DISTINCT ON (re.candidate_id) re.id AS edge_id, re.candidate_id, re.match_score, re.match_reason,
              u.first_name, u.phone_number, u.email
       FROM relevance_edges re
       JOIN users u ON u.id = re.candidate_id
       WHERE re.person_id = $1 AND re.ask_id = $2 AND re.status = 'open' AND re.match_score >= $3
       ORDER BY re.candidate_id, re.match_score DESC
     ) distinct_candidates
     ORDER BY match_score DESC`,
    [userId, askId, NETWORK_NUDGE_MIN_SCORE],
  );
  const fresh: BacklogItem[] = [];
  for (const row of rows) {
    if (await alreadySuggested(userId, row.candidate_id)) continue;
    fresh.push({ askId, candidate: row });
  }
  return fresh;
}

// Entry point — called once per (user, open ask) on the same daily cadence
// as the relevance sweep itself. Sends a TEASE, no name yet (mirrors
// eventSurfacingSweep.ts's ask-first pattern) — the actual reveal only
// happens once they say they want to hear who.
export async function attemptNetworkSurfacing(
  userId: string,
  firstName: string,
  phoneNumber: string,
  askId: string,
): Promise<{ sent: boolean; throttled: boolean }> {
  let pending = await dropStaleFront(userId, await getBacklog(userId, askId));
  if (!pending.length) {
    pending = await dropStaleFront(userId, await findFreshCandidates(userId, askId));
  }
  if (!pending.length) {
    await saveBacklog(userId, askId, []);
    return { sent: false, throttled: false };
  }

  const [item, ...rest] = pending;

  if (!(await tryClaimProactiveNudge(userId))) {
    await saveBacklog(userId, askId, pending); // nothing consumed — stays at the front for next time
    return { sent: false, throttled: true };
  }

  let message: string;
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.tease.draft" },
      prompt: `You are Co, texting ${firstName}. Someone in the network crossed your mind for them — related to what they've told you they're looking for, but you haven't said who yet. Draft a short, warm text (1-2 sentences, no exclamation points, no em dashes) like a friend who just thought of someone, asking if they'd like to hear who. Don't name anyone or describe them yet. Return ONLY the message text.`,
    });
    message = cleanCoMessage(text.trim());
  } catch (err: any) {
    console.error("attemptNetworkSurfacing: tease draft failed (non-fatal):", err?.message ?? err);
    return { sent: false, throttled: false };
  }

  try {
    await sendblue.messages.send({ number: phoneNumber, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  } catch (err: any) {
    console.error("attemptNetworkSurfacing: send failed (non-fatal):", err?.message ?? err);
    return { sent: false, throttled: false };
  }

  await saveBacklog(userId, askId, rest);
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_offer_pending', $2)`, [
      userId,
      JSON.stringify({ askId, candidate: item.candidate }),
    ])
    .catch((err: any) => console.error("attemptNetworkSurfacing: network_offer_pending write failed (non-fatal):", err?.message ?? err));
  // Royce, 2026-09-08 sweep — this, the tease itself, was the one message
  // in this file's own flow that never got a text_exchange log (the reveal
  // and direct-ask messages downstream of it already do).
  await writeMemory(userId, "text_exchange", `Co replied: ${message}`).catch((err: any) =>
    console.error("attemptNetworkSurfacing: text_exchange log failed (non-fatal):", err?.message ?? err),
  );

  return { sent: true, throttled: false };
}

export type PendingNetworkTease = { askId: string; candidate: NetworkCandidate };

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
  return JSON.parse(rows[0].content);
}

export type TeaseReplyClassification = "interested" | "not_interested" | "unrelated";

export async function classifyNetworkTeaseReply(replyText: string, recentConversation?: string): Promise<TeaseReplyClassification> {
  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.classifyTeaseReply" },
      prompt: `Co just texted this person that someone in the network crossed its mind for them, without saying who, and asked if they'd like to hear who. This does NOT mean every message from them now is a response to that — if the recent conversation shows they're clearly talking about something else, it's unrelated.
${recentConversation ? `\nRecent conversation, in order:\n${recentConversation}\n` : ""}
Their reply: "${replyText}"

Classify as ONE of:
- "interested" — they want to hear who (e.g. "sure", "yeah who", "go on")
- "not_interested" — they're passing
- "unrelated" — normal conversation, not answering this

Return ONLY the classification, nothing else.`,
    });
    const cls = raw.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");
    return cls === "interested" || cls === "not_interested" ? cls : "unrelated";
  } catch (err: any) {
    console.error("classifyNetworkTeaseReply: failed (non-fatal, treating as unrelated):", err?.message ?? err);
    return "unrelated";
  }
}

async function stashIntroOfferPending(personId: string, candidate: NetworkCandidate, askId: string | null): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_intro_offer_pending', $2)`, [
      personId,
      JSON.stringify({ askId, candidate }),
    ])
    .catch((err: any) => console.error("stashIntroOfferPending: write failed (non-fatal):", err?.message ?? err));
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

  let message: string;
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.reveal.draft" },
      prompt: `You are Co, texting ${firstName}. You just told them someone in the network crossed your mind, and they said yes, they want to hear who. Draft a short, warm text (2-3 sentences, no exclamation points, no em dashes) naming ${pending.candidate.first_name} and explaining in your own words why they're worth meeting: ${pending.candidate.match_reason}. End by asking if they'd like you to see if ${pending.candidate.first_name} is open to it too. Return ONLY the message text.`,
    });
    message = cleanCoMessage(text.trim());
  } catch (err: any) {
    console.error("resolveNetworkTeaseReply: reveal draft failed (non-fatal):", err?.message ?? err);
    return null;
  }

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

export async function findPendingNetworkIntroOffer(userId: string): Promise<PendingNetworkIntroOffer | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.content FROM co_memories p
     WHERE p.user_id = $1 AND p.memory_type = 'network_intro_offer_pending'
       AND p.created_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM network_introductions ni
         WHERE (ni.person_a_id = $1 OR ni.person_b_id = $1)
           AND ni.created_at > p.created_at
       )
     ORDER BY p.created_at DESC LIMIT 1`,
    [userId, NETWORK_OFFER_EXPIRY_DAYS],
  );
  if (!rows[0]) return null;
  return JSON.parse(rows[0].content);
}

export async function classifyNetworkIntroReply(
  replyText: string,
  candidateFirstName: string,
  recentConversation?: string,
): Promise<TeaseReplyClassification> {
  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.classifyIntroReply" },
      prompt: `Co is waiting to hear whether this person wants an actual introduction to ${candidateFirstName}. This does NOT mean every message from them now is answering that — if the recent conversation shows they're clearly talking about something else, it's unrelated.
${recentConversation ? `\nRecent conversation, in order:\n${recentConversation}\n` : ""}
Their reply: "${replyText}"

Classify their response about ${candidateFirstName} specifically as ONE of: "interested", "not_interested", or "unrelated" (they didn't actually address this one way or the other).

Return ONLY the classification, nothing else.`,
    });
    const cls = raw.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");
    return cls === "interested" || cls === "not_interested" ? cls : "unrelated";
  } catch (err: any) {
    console.error("classifyNetworkIntroReply: failed (non-fatal, treating as unrelated):", err?.message ?? err);
    return "unrelated";
  }
}

async function sendNetworkIntroEmail(a: MatchNudgeCandidate, b: MatchNudgeCandidate, matchReason: string): Promise<void> {
  const subject = `Introducing ${a.first_name} and ${b.first_name}`;
  const html = `<p>Hi both,</p><p>${matchReason}</p><p>Figured you two should actually meet — consider this your intro, take it from here.</p><p>— Co</p>`;
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
      await resend.emails.send({ from: "Co <hello@copatible.com>", to: [a.email, b.email], cc: ["hello@copatible.com"], subject, html });
    } catch (err: any) {
      console.error("sendNetworkIntroEmail: send failed (non-fatal):", err?.message ?? err);
      return;
    }
  }
  await writeMemory(a.user_id, "event_intro_email_sent", `Sent a network intro email connecting ${a.first_name} and ${b.first_name}: ${matchReason}`);
}

async function askCandidateDirectly(candidate: MatchNudgeCandidate, asker: MatchNudgeCandidate, matchReason: string, askId: string | null): Promise<void> {
  let message: string;
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.directAsk.draft" },
      prompt: `You are Co, texting ${candidate.first_name}. ${asker.first_name} would like to be introduced — you're both in Co's network. Draft a short, warm text (1-2 sentences, no exclamation points, no em dashes) letting ${candidate.first_name} know and asking if they'd be open to it too. Low-pressure, genuinely a question. Return ONLY the message text.`,
    });
    message = cleanCoMessage(text.trim());
  } catch (err: any) {
    console.error("askCandidateDirectly: draft failed (non-fatal):", err?.message ?? err);
    return;
  }
  try {
    await sendblue.messages.send({ number: candidate.phone_number, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  } catch (err: any) {
    console.error("askCandidateDirectly: send failed (non-fatal):", err?.message ?? err);
    return;
  }
  await writeMemory(candidate.user_id, "text_exchange", `Co replied: ${message}`);
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
       ${interestedCol} = NOW(),
       status = CASE WHEN network_introductions.${otherInterestedCol} IS NOT NULL THEN 'both_interested' ELSE $3 END
     RETURNING status, ${otherInterestedCol} IS NOT NULL AS both_interested`,
    [aId, bId, initialStatus, pending.candidate.match_reason, pending.askId],
  );
  const bothInterested = rows[0]?.both_interested === true;

  if (bothInterested) {
    await pool
      .query(`UPDATE network_introductions SET status = 'introduced', introduced_at = NOW() WHERE person_a_id = $1 AND person_b_id = $2`, [aId, bId])
      .catch((err: any) => console.error("resolveNetworkIntroReply: introduced-mark failed (non-fatal):", err?.message ?? err));
    const candidateInfo: MatchNudgeCandidate = {
      user_id: pending.candidate.candidate_id,
      first_name: pending.candidate.first_name,
      phone_number: pending.candidate.phone_number,
      email: pending.candidate.email,
    };
    await sendNetworkIntroEmail(person, candidateInfo, pending.candidate.match_reason);
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
