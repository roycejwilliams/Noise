// What Co has asked each member in the room, per pair of people (Royce, 2026-10-07: "offers and answers are tracked per
// pair of people. A member's yes binds to the offer it answers, not to whatever name is in Co's notes.").
//
// One row per (event, member, the person the offer is about). An additive offer ("more people just got here, want to
// hear who?") is about no one yet: its key is 'additive' and it carries who arrived, which the member is only told after
// their yes, through the same share gate as a nudge (eventGuestMatchHandoff.ts handleAdditiveReply).
//
// A reply binds to the member's most recent OPEN offer. A member is never asked a second yes-or-no about another person
// while one is still open: a direct ask for them waits ('queued') until they answer, so "yes" can only mean one person.
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
  status: "queued" | "open" | "answered";
  opened_at: Date | null;
  event_name: string | null;
};

const REPLY_EXPIRY_DAYS = 7;
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

export async function hasOpenOffer(personId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM event_match_offers WHERE person_id = $1 AND status = 'open' AND opened_at > NOW() - ($2 || ' days')::interval LIMIT 1`,
    [personId, REPLY_EXPIRY_DAYS],
  );
  return rows.length > 0;
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

// Co already asked (or they already answered) this member about this person at this event. A queued ask doesn't count.
export async function offeredAbout(eventId: string, personId: string, candidateId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status <> 'queued'`, [eventId, personId, candidateId]);
  return rows.length > 0;
}
