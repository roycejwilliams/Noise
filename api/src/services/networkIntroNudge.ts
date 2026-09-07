import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { tryClaimProactiveNudge } from "./proactiveThrottle.js";
import { writeMemory } from "./memory.js";
import {
  handleMatchNudgeReply,
  recordOptIn,
  hasReciprocalOptIn,
  type MatchNudgeCandidate,
  type MatchNudgeReplyClassification,
} from "./eventGuestMatchHandoff.js";

// "What about actually surfacing someone with a background that can help?"
// (Royce, 2026-09-07) — services/relevance.ts's Stage 3 sweep already
// computes real person-to-person matches into relevance_edges, but nothing
// ever revealed them: agent/askCheckin.ts is explicitly told "Co has some
// open leads for this, but nothing to introduce yet — don't imply anything
// is imminent." This closes that gap using the SAME double opt-in machinery
// already built for the event guest-match nudge (services/
// eventGuestMatchHandoff.ts) — reused, not duplicated, by giving each
// candidate its own synthetic "event_id" (`network:<relevance_edge id>`),
// so event_guest_match_nudges/event_guest_match_opt_ins/event_intro_groups
// all just work per (person, candidate) pair without any schema changes.
//
// Recommends a real SHORTLIST, 1-5 people (Royce, 2026-09-07: "I want them
// to recommend between 1-5 people"), not just a single top match — closer
// to how a real well-connected friend would say "a few people come to
// mind," not a single forced pairing.

const NETWORK_NUDGE_MIN_SCORE = 60; // same bar as the event guest-match nudge — a genuinely strong match, not the best of a weak field
const MAX_NETWORK_CANDIDATES = 5;

function networkEventId(relevanceEdgeId: string): string {
  return `network:${relevanceEdgeId}`;
}

type ShortlistCandidate = {
  edge_id: string;
  candidate_id: string;
  first_name: string;
  phone_number: string;
  email: string;
  match_score: number;
  match_reason: string;
};

async function findShortlistCandidates(personId: string): Promise<ShortlistCandidate[]> {
  // A person can have several open relevance_edges to the SAME candidate
  // (different ask_ids logged across separate sweeps) — DISTINCT ON keeps
  // only that candidate's single best-scoring edge, so the shortlist is 1-5
  // distinct PEOPLE, never the same person twice at different scores.
  const { rows } = await pool.query(
    `SELECT edge_id, candidate_id, match_score, match_reason, first_name, phone_number, email FROM (
       SELECT DISTINCT ON (re.candidate_id) re.id AS edge_id, re.candidate_id, re.match_score, re.match_reason,
              u.first_name, u.phone_number, u.email
       FROM relevance_edges re
       JOIN users u ON u.id = re.candidate_id
       WHERE re.person_id = $1 AND re.status = 'open' AND re.match_score >= $2
         AND NOT EXISTS (
           SELECT 1 FROM event_guest_match_nudges n
           WHERE n.person_id = re.person_id AND n.candidate_id = re.candidate_id AND n.event_id LIKE 'network:%'
         )
       ORDER BY re.candidate_id, re.match_score DESC
     ) distinct_candidates
     ORDER BY match_score DESC
     LIMIT $3`,
    [personId, NETWORK_NUDGE_MIN_SCORE, MAX_NETWORK_CANDIDATES],
  );
  return rows;
}

// Entry point — called from relevance.ts's sweepAllOpenAsks, once per user,
// after both sweep directions have logged this cycle's relevance_edges.
export async function maybeSendNetworkIntroNudges(personId: string): Promise<void> {
  const candidates = await findShortlistCandidates(personId);
  if (!candidates.length) return;

  const { rows: personRows } = await pool.query(`SELECT first_name, phone_number FROM users WHERE id = $1`, [personId]);
  const person = personRows[0];
  if (!person) return;

  if (!(await tryClaimProactiveNudge(personId))) {
    console.log(`networkIntroNudge: throttled for ${personId} (proactive nudge used elsewhere in last 24h)`);
    return;
  }

  let message: string;
  try {
    const list = candidates
      .map((c) => `${c.first_name}: ${c.match_reason}`)
      .join("\n");
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.draft" },
      prompt: `You are Co, texting ${person.first_name}. You found ${candidates.length === 1 ? "someone" : `${candidates.length} people`} in the network worth them meeting:
${list}

Draft a short, warm text (2-4 sentences, no exclamation points, no em dashes) naming ${candidates.length === 1 ? "this person" : "each person by first name"} and the real reason each is worth meeting, in your own words — not a bare list, but not a hard sell either, like a well-connected friend genuinely thinking of them. End by asking which (if any) they'd like an actual introduction to. Return ONLY the message text.`,
    });
    message = cleanCoMessage(text.trim());
  } catch (err: any) {
    console.error("maybeSendNetworkIntroNudges: draft failed (non-fatal):", err?.message ?? err);
    return;
  }

  try {
    await sendblue.messages.send({ number: person.phone_number, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  } catch (err: any) {
    console.error("maybeSendNetworkIntroNudges: send failed (non-fatal):", err?.message ?? err);
    return;
  }

  for (const c of candidates) {
    await pool
      .query(
        `INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id, person_id) DO NOTHING`,
        [networkEventId(c.edge_id), personId, c.candidate_id, c.match_score],
      )
      .catch((err: any) => console.error("maybeSendNetworkIntroNudges: nudge-row insert failed (non-fatal):", err?.message ?? err));
  }

  await writeMemory(
    personId,
    "event_guest_match_nudge",
    `Surfaced a network shortlist to ${person.first_name}: ${candidates.map((c) => `${c.first_name} (${c.match_reason})`).join("; ")}.`,
  );
}

export type PendingNetworkNudge = {
  event_id: string;
  candidate: MatchNudgeCandidate;
};

const NETWORK_NUDGE_REPLY_EXPIRY_DAYS = 7;

// Unlike the event nudge's findPendingMatchNudge (single most recent), a
// network shortlist can have up to 5 simultaneously pending — a reply names
// whichever specific person(s) it's actually about, so the classifier below
// needs the whole list, not just the latest one.
export async function findPendingNetworkNudges(userId: string): Promise<PendingNetworkNudge[]> {
  const { rows } = await pool.query(
    `SELECT n.event_id, n.candidate_id, u.first_name, u.phone_number, u.email
     FROM event_guest_match_nudges n
     JOIN users u ON u.id = n.candidate_id
     WHERE n.person_id = $1
       AND n.event_id LIKE 'network:%'
       AND n.sent_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM event_guest_match_opt_ins o
         WHERE o.event_id = n.event_id AND o.person_id = n.person_id AND o.candidate_id = n.candidate_id
       )
     ORDER BY n.sent_at DESC`,
    [userId, NETWORK_NUDGE_REPLY_EXPIRY_DAYS],
  );
  return rows.map((r: any) => ({
    event_id: r.event_id,
    candidate: { user_id: r.candidate_id, first_name: r.first_name, phone_number: r.phone_number, email: r.email },
  }));
}

export type NetworkShortlistDecision = { event_id: string; candidate_id: string; classification: MatchNudgeReplyClassification };

// One classification pass over the whole pending shortlist at once — a
// reply might name one person, several, or none; anyone not clearly
// addressed stays pending rather than being silently assumed one way or
// the other.
//
// Confirmed live, 2026-09-07: the same real candidate can show up as TWO
// pending entries under different synthetic event_ids — their own edge
// from this person's shortlist sweep, plus a separate edge created when
// the candidate's OWN shortlist nudge led to a direct ask back to this
// person. A prompt built from the raw (possibly duplicate-name) pending
// list gave the classifier an unparseable "Royce, Jacqueline, Royce" and
// it just gave up on both Royce entries. Deduping to one prompt line per
// distinct person, then fanning the resulting decision back out to every
// event_id that names them, fixes both the prompt and the result.
export async function classifyNetworkShortlistReply(
  replyText: string,
  pending: PendingNetworkNudge[],
  recentConversation?: string,
): Promise<NetworkShortlistDecision[]> {
  if (!pending.length) return [];
  const distinctCandidates = Array.from(new Map(pending.map((p) => [p.candidate.user_id, p.candidate])).values());
  try {
    const names = distinctCandidates.map((c) => c.first_name).join(", ");
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "networkIntroNudge.classifyShortlistReply" },
      prompt: `Co recently texted this person a shortlist of people worth meeting: ${names}. This does NOT mean every message from them now is answering that — if the recent conversation shows they're clearly responding to something else, none of these apply.
${recentConversation ? `\nRecent conversation, in order:\n${recentConversation}\n` : ""}
Their reply: "${replyText}"

For EACH name in the shortlist (${names}), classify their response to that specific person as one of: "interested", "not_interested", or "unrelated" (they didn't actually address this specific person one way or the other — leave it pending, don't guess).

Return ONLY valid JSON, no preamble: {"Name1": "interested|not_interested|unrelated", "Name2": "..."}`,
    });
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as Record<string, string>;
    const decisions: NetworkShortlistDecision[] = [];
    for (const candidate of distinctCandidates) {
      const cls = parsed[candidate.first_name];
      if (cls !== "interested" && cls !== "not_interested") continue;
      for (const p of pending.filter((p) => p.candidate.user_id === candidate.user_id)) {
        decisions.push({ event_id: p.event_id, candidate_id: candidate.user_id, classification: cls });
      }
    }
    return decisions;
  } catch (err: any) {
    console.error("classifyNetworkShortlistReply: failed (non-fatal, treating as no decisions):", err?.message ?? err);
    return [];
  }
}

export async function handleNetworkShortlistReply(
  decisions: NetworkShortlistDecision[],
  pending: PendingNetworkNudge[],
  person: MatchNudgeCandidate,
): Promise<void> {
  const handledCandidates = new Set<string>();
  for (const decision of decisions) {
    if (handledCandidates.has(decision.candidate_id)) continue;
    const matches = pending.filter((p) => p.candidate.user_id === decision.candidate_id);
    if (!matches.length) continue;
    handledCandidates.add(decision.candidate_id);

    // Resolve through whichever event_id the OTHER person already answered
    // on, so this actually closes an existing loop instead of opening a
    // redundant second thread for the same real pair; fall back to
    // whichever entry is pending first if neither side has answered yet.
    let authoritative = matches[0];
    for (const m of matches) {
      if (await hasReciprocalOptIn(m.event_id, person.user_id, decision.candidate_id)) {
        authoritative = m;
        break;
      }
    }

    await handleMatchNudgeReply(
      authoritative.event_id,
      "a real connection Co found",
      decision.classification,
      person,
      authoritative.candidate,
    );

    // Any OTHER pending event_id for this same real candidate is now
    // redundant — record the same answer there too so it stops showing as
    // pending, without a second round of asks/messages.
    for (const m of matches) {
      if (m.event_id === authoritative.event_id) continue;
      await recordOptIn(
        m.event_id,
        person.user_id,
        person.first_name,
        decision.candidate_id,
        m.candidate.first_name,
        decision.classification === "interested" ? "interested" : "declined",
      ).catch((err: any) => console.error("handleNetworkShortlistReply: redundant opt-in record failed (non-fatal):", err?.message ?? err));
    }
  }
}
