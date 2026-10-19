// What Co has asked each member in the room, per pair of people (Royce, 2026-10-07: "offers and answers are tracked per
// pair of people. A member's yes binds to the offer it answers, not to whatever name is in Co's notes.").
//
// One row per (event, member, the person the offer is about). An additive offer ("more people just got here, want to
// hear who?") is about no one yet: its key is 'additive' and it carries who arrived, which the member is only told after
// their yes, through the same share gate as a nudge (eventGuestMatchHandoff.ts handleAdditiveReply).
//
// A reply binds to the member's open offer. While a question is fresh (OPEN_SLOT_MINUTES), a direct ask for them waits ('queued')
// until they answer. Past that, the next ask may go, so two questions can be open at once, never more (MAX_OPEN_QUESTIONS); with
// two open, a reply binds only if it names one of them (services/messageRouter.ts namesOneOpenIntro), and otherwise Cue asks which
// (review of #211: a bare "yes" bound to the newer question and sent the intro email to the wrong person).
// A direct ask takes that one slot ('sending') before it is drafted, under a lock (claimAskSlot), and opens it once it reaches
// them: the slot used to be taken only after the send, so asks drafted at the same moment all went (room simulation, 2026-10-14:
// three yeses to one person at once sent all three asks back to back, and their next "yes" bound to whichever was newest).
import pool from "../db/db.js";

export type OfferKind = "nudge" | "direct_ask" | "additive";
export type Offer = {
  event_id: string;
  person_id: string;
  candidate_key: string;
  kind: OfferKind;
  candidate_id: string | null;
  candidate_ids: string[];
  asker_id: string | null;
  status: "queued" | "sending" | "open" | "answered" | "expired";
  opened_at: Date | null;
  event_name: string | null;
};

const REPLY_EXPIRY_DAYS = 7;
// A slot taken for a send that never confirmed (the server died while drafting) stops holding the slot after this long.
export const SLOT_CLAIM_MINUTES = 10;
// An unanswered question holds the member's one slot this long (Royce, 2026-10-19: a member who never answers shouldn't block every
// intro behind it all night). After that the next waiting ask goes; the earlier question isn't expired and stays answerable for
// REPLY_EXPIRY_DAYS (a bare "yes" binds to their most recent open question, as always).
export const OPEN_SLOT_MINUTES = 20;
// At most this many questions about people open at once (review of #211). With this many open, no new one goes, however long they
// have waited: the next waits for an answer (or for the room to close), so the 20-minute release can't pile them up.
export const MAX_OPEN_QUESTIONS = 2;
// The one slot: a question opened in the last OPEN_SLOT_MINUTES, or a direct ask on its way.
const SLOT_TAKEN = `((status = 'open' AND opened_at > NOW() - ($2 || ' minutes')::interval) OR (status = 'sending' AND opened_at > NOW() - ($3 || ' minutes')::interval))`;
const keyOf = (kind: OfferKind, candidateId: string | null) => (kind === "additive" ? "additive" : String(candidateId));

export async function openOffer(o: { eventId: string; eventName?: string | null; personId: string; kind: OfferKind; candidateId?: string | null; candidateIds?: string[]; askerId?: string | null }): Promise<void> {
  await pool.query(
    `INSERT INTO event_match_offers (event_id, person_id, candidate_key, kind, candidate_id, candidate_ids, asker_id, event_name, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, 'open', NOW())
     ON CONFLICT (event_id, person_id, candidate_key) DO UPDATE SET kind = EXCLUDED.kind, candidate_ids = EXCLUDED.candidate_ids, asker_id = EXCLUDED.asker_id, event_name = COALESCE(EXCLUDED.event_name, event_match_offers.event_name), status = 'open', opened_at = NOW(), answered_at = NULL, answer = NULL`,
    [o.eventId, o.personId, keyOf(o.kind, o.candidateId ?? null), o.kind, o.candidateId ?? null, o.candidateIds ?? [], o.askerId ?? null, o.eventName ?? null],
  );
}

// A direct ask that has to wait: they still have an open question about someone else.
export async function queueOffer(o: { eventId: string; eventName?: string | null; personId: string; candidateId: string; askerId: string }): Promise<void> {
  await pool.query(
    `INSERT INTO event_match_offers (event_id, person_id, candidate_key, kind, candidate_id, asker_id, event_name, status)
     VALUES ($1, $2, $3, 'direct_ask', $4, $5, $6, 'queued')
     ON CONFLICT (event_id, person_id, candidate_key) DO NOTHING`,
    [o.eventId, o.personId, o.candidateId, o.candidateId, o.askerId, o.eventName ?? null],
  );
}

// Their one slot is taken: a fresh open question, a direct ask on its way to them, or MAX_OPEN_QUESTIONS already open.
export async function hasOpenOffer(personId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_match_offers WHERE person_id = $1 AND ${SLOT_TAKEN} LIMIT 1`, [personId, OPEN_SLOT_MINUTES, SLOT_CLAIM_MINUTES]);
  return rows.length > 0 || (await openQuestionCount(personId)) >= MAX_OPEN_QUESTIONS;
}

// How many questions about people they have open, answerable (REPLY_EXPIRY_DAYS), however old.
const OPEN_COUNT_SQL = `SELECT count(*)::int AS n FROM event_match_offers WHERE person_id = $1 AND status = 'open' AND opened_at > NOW() - ($2 || ' days')::interval`;
export async function openQuestionCount(personId: string, q: { query: typeof pool.query } = pool): Promise<number> {
  const { rows } = await q.query(OPEN_COUNT_SQL, [personId, REPLY_EXPIRY_DAYS]);
  return Number(rows[0]?.n ?? 0);
}

// Every question they have open, newest first: what a reply could be answering (services/messageRouter.ts gatherOpenItems).
export async function openOffers(personId: string): Promise<Offer[]> {
  const { rows } = await pool.query(
    `SELECT event_id, person_id, candidate_key, kind, candidate_id, candidate_ids, asker_id, status, opened_at, event_name FROM event_match_offers
     WHERE person_id = $1 AND status = 'open' AND opened_at > NOW() - ($2 || ' days')::interval
     ORDER BY opened_at DESC LIMIT 10`,
    [personId, REPLY_EXPIRY_DAYS],
  );
  return rows as Offer[];
}

// Take their one slot for a direct ask, or queue the ask when it's taken. One at a time per person (a transaction lock on them),
// so of several asks drafted at once exactly one is claimed and the rest wait their turn (sendNextQueued).
export async function claimAskSlot(o: { eventId: string; eventName?: string | null; personId: string; candidateId: string; askerId: string }): Promise<"claimed" | "queued"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`offer-slot:${o.personId}`]);
    const { rows } = await client.query(`SELECT 1 FROM event_match_offers WHERE person_id = $1 AND ${SLOT_TAKEN} LIMIT 1`, [o.personId, OPEN_SLOT_MINUTES, SLOT_CLAIM_MINUTES]);
    if (rows.length || (await openQuestionCount(o.personId, client as any)) >= MAX_OPEN_QUESTIONS) {
      await client.query(
        `INSERT INTO event_match_offers (event_id, person_id, candidate_key, kind, candidate_id, asker_id, event_name, status)
         VALUES ($1, $2, $3, 'direct_ask', $4, $5, $6, 'queued')
         ON CONFLICT (event_id, person_id, candidate_key) DO NOTHING`,
        [o.eventId, o.personId, o.candidateId, o.candidateId, o.askerId, o.eventName ?? null],
      );
      await client.query("COMMIT");
      return "queued";
    }
    // A queued ask being sent now takes the slot in place.
    await client.query(
      `INSERT INTO event_match_offers (event_id, person_id, candidate_key, kind, candidate_id, asker_id, event_name, status, opened_at)
       VALUES ($1, $2, $3, 'direct_ask', $4, $5, $6, 'sending', NOW())
       ON CONFLICT (event_id, person_id, candidate_key) DO UPDATE SET status = 'sending', opened_at = NOW() WHERE event_match_offers.status IN ('queued', 'sending')`,
      [o.eventId, o.personId, o.candidateId, o.candidateId, o.askerId, o.eventName ?? null],
    );
    await client.query("COMMIT");
    return "claimed";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The ask isn't going now (blocked, moved on, held for their morning or the pause, or failed): the slot is free again.
// Once it reaches them, afterDirectAskSent opens it instead (openOffer).
export async function releaseAskSlot(eventId: string, personId: string, candidateId: string): Promise<void> {
  await pool.query(`DELETE FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status = 'sending'`, [eventId, personId, candidateId]);
}

// The offer a reply answers: their most recent open one.
export async function latestOpenOffer(personId: string): Promise<Offer | null> {
  const { rows } = await pool.query(
    `SELECT event_id, person_id, candidate_key, kind, candidate_id, candidate_ids, asker_id, status, opened_at, event_name FROM event_match_offers
     WHERE person_id = $1 AND status = 'open' AND opened_at > NOW() - ($2 || ' days')::interval
     ORDER BY opened_at DESC LIMIT 1`,
    [personId, REPLY_EXPIRY_DAYS],
  );
  return (rows[0] as Offer) ?? null;
}

// Whether this member has any offer rows at all (older nudges, from before this table, are read the old way).
export async function hasAnyOffer(personId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_match_offers WHERE person_id = $1 LIMIT 1`, [personId]);
  return rows.length > 0;
}

export async function answerOffer(eventId: string, personId: string, candidateKey: string, answer: "yes" | "no"): Promise<void> {
  await pool.query(
    `UPDATE event_match_offers SET status = 'answered', answered_at = NOW(), answer = $4 WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3`,
    [eventId, personId, candidateKey, answer],
  );
}

// The next direct ask that was waiting on them, once nothing is open.
export async function nextQueued(personId: string): Promise<Offer | null> {
  if (await hasOpenOffer(personId)) return null;
  const { rows } = await pool.query(
    `SELECT event_id, person_id, candidate_key, kind, candidate_id, candidate_ids, asker_id, status, opened_at, event_name FROM event_match_offers
     WHERE person_id = $1 AND status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    [personId],
  );
  return (rows[0] as Offer) ?? null;
}

// Direct asks whose send never confirmed (the server died while drafting; SLOT_CLAIM_MINUTES on): each goes back in line, where it
// was, and is returned so its person's queue is drained (review of #211: after a restart, the asks queued behind a dead one stayed
// queued, and the dead one was never retried). One UPDATE, so two instances never take the same one. A room that's closed has none.
export async function peopleWithQueuedAsks(): Promise<string[]> {
  // Everyone with a direct ask waiting: once their open question is past OPEN_SLOT_MINUTES unanswered, the drain sends the next one.
  const { rows } = await pool.query(`SELECT DISTINCT person_id FROM event_match_offers WHERE status = 'queued'`);
  return rows.map((r: any) => String(r.person_id));
}

export async function requeueStaleAsks(): Promise<string[]> {
  const { rows } = await pool.query(
    `UPDATE event_match_offers SET status = 'queued', opened_at = NULL
      WHERE status = 'sending' AND opened_at <= NOW() - ($1 || ' minutes')::interval RETURNING person_id`,
    [SLOT_CLAIM_MINUTES],
  );
  return [...new Set(rows.map((r: any) => String(r.person_id)))];
}

// A queued ask that won't go (blocked by the pair record, already asked another way, the room moved on): it leaves the line, so it
// can't sit at its head and hold every ask behind it (review of #211).
export async function dropQueued(eventId: string, personId: string, candidateKey: string): Promise<void> {
  await pool.query(`UPDATE event_match_offers SET status = 'expired' WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status = 'queued'`, [eventId, personId, candidateKey]);
}

// Co already asked (or they already answered) this member about this person at this event, or that ask is on its way. A queued
// ask doesn't count.
export async function offeredAbout(eventId: string, personId: string, candidateId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status <> 'queued'`, [eventId, personId, candidateId]);
  return rows.length > 0;
}
