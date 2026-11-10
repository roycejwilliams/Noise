import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { DateTime } from "luxon";
import type { TierMatch } from "./tieredRecommendation.js";
import { memberZone } from "./memberTime.js";
import { enqueueCandidate, nextLocalHour } from "../harness/proactive.js";
import { dayIn, eventEndOf, formOf } from "./findForm.js";
import { followUpEvidence as followUpEvidenceSync } from "./followUpEvidence.js";

// Outcome-learning loop (Royce, 2026-09-02: "Co follows up" + the shared
// "named someone?" classifier + wiring signal weighting into future
// matching — Notion V1 board rows 7/12/13, confirmed fully unbuilt before
// this).
//
// Widened 2026-09-17 (Royce, "close the loop on outcomes" for Tier 3): a
// Tier 3 opportunity has no attendees to "meet," so it never gets the
// event-anchored "who did you meet?" question (draftDebriefText below asks
// something Tier-3-appropriate instead), but it's still worth knowing
// whether it went anywhere — that's what getTier3CategoryBias reads back
// into proposeOpportunityQuery. No event_date to anchor "the day after," so
// Tier 3 gets a fixed delay instead (TIER3_FOLLOWUP_DELAY_DAYS below).
//
// Same due-timestamp + nullable claim column + partial index convention as
// post_call_follow_ups (jobs/postCallFollowUp.ts) — see migrations.ts's
// recommendation_outcome_followups table. The outcome itself is written as
// a co_memories row ('recommendation_outcome'), not a new table — that's
// exactly what co_memories already exists for (event_offer_pending/
// event_offer_resolved/recap all follow this same shape).
const TIER3_FOLLOWUP_DELAY_DAYS = 5;

// The day a follow-up is about: a real event's own date, the last day when it spans. Never an opening's window (2026-11-04: a job
// listing's statedDates anchored a morning-after "how was it"). statedDates count only for a find classified as an event
// (services/findForm.ts); a listing, program or fellowship (an opening, or a deadline) has no such day.
export function followUpDate(match: any): string | null {
  if (!match || formOf(match) === "opening") return null;
  const isEvent = match.form === "event" || match.kind === "co_event" || match.kind === "public_event" || !!match.event_date || !!match.details?.startAt;
  if (!isEvent) return null;
  const d = dayIn(match.event_date) ?? eventEndOf(match);
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

// A program, cohort, fellowship, accelerator, grant or open call is surfaced once as a community that fits; nothing asks "how was it"
// about it (the purpose boundary, Royce 2026-11-04). Only a real event, one with a day to anchor "the morning after", gets the follow-up.
// Decided by what the find IS, never by words in its name (a "Pitch Competition", a "Demo Day", a "Mentorship Program Kickoff Mixer"
// and a "Funding Mixer" are dated rooms): findForm.formOf (a deadline makes it an opening, an event platform's listing is an event),
// and for a find that only states dates (a web or X post) a real start time as well as the date.
const hasStartTime = (m: any): boolean => /T\d{2}:\d{2}/.test(String(m?.details?.startAt ?? m?.statedDates?.start ?? "")) || /\b\d{1,2}(?::\d{2})?\s*[ap]m\b/i.test(String(m?.start_time ?? m?.details?.startTime ?? ""));
export function isRealEventForFollowUp(match: any): boolean {
  if (!followUpDate(match)) return false;
  if (match?.kind === "intro") return true; // "did it help?" for an introduction Cue made (services/networkIntroNudge.ts)
  const form = formOf(match);
  if (form === "opening") return false; // it has a deadline to apply by: an opening, not a room to go to
  // An event platform's listing (Noise's own, or the public feed) is a dated room by what it is.
  if (match?.kind === "co_event" || match?.kind === "public_event" || match?.tier === 1 || match?.tier === 2) return true;
  return form === "event" && hasStartTime(match);
}

// Parked, not scheduled (2026-11-04): a reveal files the find's details so a later sign can arm a follow-up, and nothing is queued
// or sent from it. harness_status 'awaiting_evidence' is read by no sender (enqueueDueOutcomeFollowUps takes only NULL).
export const AWAITING_EVIDENCE = "awaiting_evidence";

export async function scheduleOutcomeFollowUp(userId: string, askText: string, match: TierMatch): Promise<void> {
  const eventDate = followUpDate(match);
  if (!isRealEventForFollowUp(match)) return; // only a real event, with a day to anchor "the morning after", is parked for a follow-up

  try {
    await pool.query(
      // One parked find per recommended event/opening, however many times it got recommended (2026-09-14: the same event produced
      // two follow-ups sent 2 seconds apart).
      `INSERT INTO recommendation_outcome_followups (user_id, ask_text, tier, match_name, match, send_at, harness_status)
       SELECT $1::uuid, $2::text, $3::int, $4::text, $5::jsonb,
         CASE WHEN $6::date IS NOT NULL THEN $6::date + INTERVAL '1 day 11 hours' ELSE NOW() + ($7 || ' days')::interval END, '${AWAITING_EVIDENCE}'
       WHERE NOT EXISTS (
         SELECT 1 FROM recommendation_outcome_followups
         WHERE user_id = $1 AND (
           (match ->> 'event_api_id') = ($5::jsonb ->> 'event_api_id')
           -- The same name is the same find only when either side has no event id: a recurring event (same name, a new event id)
           -- is a new find, never folded into an old row.
           OR (lower(match_name) = lower($4) AND ((match ->> 'event_api_id') IS NULL OR ($5::jsonb ->> 'event_api_id') IS NULL))
         )
       )`,
      [userId, askText, (match as any).tier ?? 3, match.name, JSON.stringify(match), eventDate, TIER3_FOLLOWUP_DELAY_DAYS],
    );
    // Parked first from a sweep or search (no ask text yet): the reply that reveals it brings the words.
    if (askText) {
      await pool.query(
        `UPDATE recommendation_outcome_followups SET ask_text = $2 WHERE user_id = $1 AND ask_text = '' AND (('event:' || (match ->> 'event_api_id')) = $3 OR ('name:' || lower(match_name)) = $3)`,
        [userId, askText, (match as any).event_api_id ? `event:${(match as any).event_api_id}` : `name:${String(match.name).toLowerCase()}`],
      );
    }
  } catch (err: any) {
    console.error("scheduleOutcomeFollowUp: insert failed (non-fatal):", err?.message ?? err);
  }
}

const KEY_MATCH = `(('event:' || (match ->> 'event_api_id')) = $2 OR ('name:' || lower(match_name)) = $2)`;

// A sign that they meant to go (said they're going or signed up): the parked follow-up becomes a real one. An event's is due the
// morning after its own date; an opening has no such day, so it waits the fixed delay from now. Never for a declined find.
// By event id when the key carries one. A name key (the find had no event id) arms a row with no event id, or the one row of that name
// that has one: a recurring same-name find (several event ids) is ambiguous by name alone, so a name never arms an old row of it.
export async function armOutcomeFollowUp(userId: string, itemKey: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE recommendation_outcome_followups rof
     SET harness_status = NULL,
         send_at = CASE WHEN match ->> 'form' = 'event' OR match ->> 'kind' IN ('co_event', 'public_event') OR match ->> 'event_date' IS NOT NULL OR match #>> '{details,startAt}' IS NOT NULL
                        THEN send_at ELSE NOW() + ($3 || ' days')::interval END
     WHERE user_id = $1 AND harness_status = '${AWAITING_EVIDENCE}' AND (
       ('event:' || (match ->> 'event_api_id')) = $2
       OR (('name:' || lower(match_name)) = $2 AND (
         (match ->> 'event_api_id') IS NULL
         OR (SELECT count(*) FROM recommendation_outcome_followups o WHERE o.user_id = rof.user_id AND lower(o.match_name) = lower(rof.match_name) AND (o.match ->> 'event_api_id') IS NOT NULL) = 1
       ))
     )`,
    [userId, itemKey, TIER3_FOLLOWUP_DELAY_DAYS],
  );
  return rowCount ?? 0;
}

// A parked find nobody confirmed is not kept forever: an event's expires 3 days after its date, an opening 30 days after it was
// parked. Pure: whether one parked row is past that.
export const PARKED_EVENT_GRACE_DAYS = 3;
export const PARKED_OPENING_DAYS = 30;
export function parkedRowExpired(row: { match: any; created_at: Date | string }, now: Date = new Date()): boolean {
  const date = followUpDate(row.match);
  if (date) return Date.parse(`${date}T00:00:00Z`) + (PARKED_EVENT_GRACE_DAYS + 1) * 86_400_000 <= now.getTime();
  return new Date(row.created_at).getTime() + PARKED_OPENING_DAYS * 86_400_000 <= now.getTime();
}
export async function expireParkedFollowUps(now: Date = new Date()): Promise<number> {
  // Every parked row is read, a page at a time by id, so expired rows past the first page are still reached.
  let after = "00000000-0000-0000-0000-000000000000";
  const ids: string[] = [];
  for (let page = 0; page < 200; page++) {
    const { rows } = await pool.query(
      `SELECT id, match, created_at FROM recommendation_outcome_followups WHERE harness_status = '${AWAITING_EVIDENCE}' AND sent_at IS NULL AND id > $1::uuid ORDER BY id LIMIT 500`,
      [after],
    );
    for (const r of rows) if (parkedRowExpired(r, now)) ids.push(r.id);
    if (rows.length < 500) break;
    after = rows[rows.length - 1].id;
  }
  if (!ids.length) return 0;
  await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped', drop_reason = $2 WHERE id = ANY($1::uuid[])`, [ids, "no sign they went or meant to go before it expired"]);
  return ids.length;
}

// They said no (or the record shows nothing): the parked or armed follow-up that hasn't gone is dropped, with the reason kept.
export async function dropOutcomeFollowUp(userId: string, itemKey: string, reason: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE recommendation_outcome_followups SET harness_status = 'dropped', drop_reason = $3
     WHERE user_id = $1 AND sent_at IS NULL AND COALESCE(harness_status, '') IN ('', '${AWAITING_EVIDENCE}', 'queued') AND ${KEY_MATCH}`,
    [userId, itemKey, reason.slice(0, 200)],
  );
  return rowCount ?? 0;
}

// Same expiry reasoning as sendblue.ts's EVENT_OFFER_EXPIRY_DAYS — a reply
// classifier shouldn't be trying to resolve a "who did you meet?" follow-up
// from weeks ago against unrelated later conversation.
const OUTCOME_FOLLOWUP_EXPIRY_DAYS = 7;

export type PendingOutcomeFollowUp = {
  id: string;
  tier: number;
  match_name: string;
  ask_text: string;
};

// Mirrors sendblue.ts's pendingEventOffer lookup shape exactly (same
// created_at-cutoff + NOT EXISTS resolved-row pattern), scoped to this
// feature's own table instead of co_memories.
export async function findPendingOutcomeFollowUp(userId: string): Promise<PendingOutcomeFollowUp | null> {
  const { rows } = await pool.query(
    `SELECT id, tier, match_name, ask_text FROM recommendation_outcome_followups
     WHERE user_id = $1 AND sent_at IS NOT NULL
       AND sent_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM co_memories r
         WHERE r.user_id = $1 AND r.memory_type = 'recommendation_outcome'
           AND (r.content::jsonb ->> 'followupId') = recommendation_outcome_followups.id::text
       )
     ORDER BY sent_at DESC LIMIT 1`,
    [userId, OUTCOME_FOLLOWUP_EXPIRY_DAYS],
  );
  return rows[0] ?? null;
}

export type NamedOutcome = "named_positive" | "named_critical" | "not_mentioned" | "unrelated";

export async function recordOutcome(userId: string, followupId: string, tier: number, outcome: NamedOutcome): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation_outcome', $2)`, [
      userId,
      JSON.stringify({ followupId, tier, outcome }),
    ])
    .catch((err: any) => console.error("recordOutcome: memory write failed (non-fatal):", err?.message ?? err));
}

// Tier-weighting loop-back (Notion board row 12, "wire signal weighting into
// the standing profile") — TierMatch carries no per-person identity (see
// this session's research), so "reinforce/deprioritize" is scoped to which
// TIER tends to land for this person, matching the diamond's own "not
// mentioned -> adjusts tier weighting" language. Net positive-minus-critical
// per tier; a user with no history gets all zeros, which keeps
// eventSurfacingSweep.ts's sort behaving exactly as it does today (tier-
// number order) until real signal exists.
export async function getTierBias(userId: string): Promise<Record<number, number>> {
  const bias: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT content::jsonb ->> 'tier' AS tier, content::jsonb ->> 'outcome' AS outcome
       FROM co_memories WHERE user_id = $1 AND memory_type = 'recommendation_outcome'`,
      [userId],
    );
    for (const row of rows) {
      const tier = Number(row.tier);
      if (!(tier in bias)) continue;
      if (row.outcome === "named_positive") bias[tier] += 1;
      else if (row.outcome === "named_critical") bias[tier] -= 1;
    }
  } catch (err: any) {
    console.error("getTierBias: query failed (non-fatal, no bias applied):", err?.message ?? err);
  }
  return bias;
}

// Same idea as getTierBias, one level more specific: which KIND of Tier 3
// opportunity (tieredRecommendation.ts's category — accelerator, investor,
// mentor, etc.) has actually gone somewhere for this person before, not just
// whether Tier 3 in general has. Read back into proposeOpportunityQuery as
// an optional hint (2026-09-17, "close the loop on outcomes"). The category
// isn't stored on the co_memories outcome row itself — it's already sitting
// in recommendation_outcome_followups.match (the whole TierMatch was stored
// there at schedule time), so this joins back to it rather than needing a
// new column. Real signal here takes days to accumulate (a Tier 3 follow-up
// is deliberately delayed TIER3_FOLLOWUP_DELAY_DAYS) — an empty map is the
// honest, expected result for a while, and the caller already treats "no
// opinion" as "don't mention it," so this is safe to call from day one.
export async function getTier3CategoryBias(userId: string): Promise<Record<string, number>> {
  const bias: Record<string, number> = {};
  try {
    const { rows } = await pool.query(
      `SELECT rof.match ->> 'category' AS category, m.content::jsonb ->> 'outcome' AS outcome
       FROM co_memories m
       JOIN recommendation_outcome_followups rof ON rof.id::text = (m.content::jsonb ->> 'followupId')
       WHERE m.user_id = $1 AND m.memory_type = 'recommendation_outcome' AND (m.content::jsonb ->> 'tier')::int = 3`,
      [userId],
    );
    for (const row of rows) {
      const category = typeof row.category === "string" && row.category ? row.category : null;
      if (!category) continue;
      bias[category] = (bias[category] ?? 0) + (row.outcome === "named_positive" ? 1 : row.outcome === "named_critical" ? -1 : 0);
    }
  } catch (err: any) {
    console.error("getTier3CategoryBias: query failed (non-fatal, no bias applied):", err?.message ?? err);
  }
  return bias;
}

// A "closest miss" (real event that didn't quite fit) used to be presented
// fresh every single search, even when it's the literal same event a daily
// sweep surfaces again tomorrow — reading like Co forgot it already told
// them (2026-09-17, "close the loop conversationally on near-misses").
// Reuses co_memories the same way the outcome-learning rows do — no new
// table. Scoped to name+ask rather than a real id since a closest miss has
// no stable identity the way a sent recommendation does (Tier 3 in
// particular has no event_api_id at all).
const CLOSEST_MISS_RECALL_DAYS = 5;

export async function wasClosestMissRecentlyMentioned(userId: string, name: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM co_memories
       WHERE user_id = $1 AND memory_type = 'closest_miss_mentioned'
         AND lower(content::jsonb ->> 'name') = lower($2)
         AND created_at > NOW() - ($3 || ' days')::interval
       LIMIT 1`,
      [userId, name, CLOSEST_MISS_RECALL_DAYS],
    );
    return rows.length > 0;
  } catch (err: any) {
    console.error("wasClosestMissRecentlyMentioned: query failed (non-fatal, treated as not yet mentioned):", err?.message ?? err);
    return false;
  }
}

export async function recordClosestMissMentioned(userId: string, name: string, askText: string): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'closest_miss_mentioned', $2)`, [
      userId,
      JSON.stringify({ name, askText }),
    ])
    .catch((err: any) => console.error("recordClosestMissMentioned: write failed (non-fatal):", err?.message ?? err));
}

// Layer 7 (2026-09-14): no longer sends. Each due follow-up becomes part of
// one "debrief" candidate per event (merged with the end-of-night check-in
// from eventCheckinFollowUp.ts and the walk-in call offer), due the morning
// after at 10am their time. Live before this: three follow-ups all at 4am
// Pacific, one a duplicate two seconds after the other.
// A registration Cue made for them (services/eventRegistration: on the guest list, waiting on the host or a spot) for any of these keys
// or this link: evidence they meant to go (Royce, 2026-11-10). Read by the enqueue below and the debrief's own send-time read.
export const REGISTERED_STATUSES = ["registered", "already_registered", "pending_approval", "waitlisted"];
export async function registeredFor(userId: string, keys: string[], urls: string | null | readonly (string | null)[] = null): Promise<boolean> {
  const links = (Array.isArray(urls) ? urls : [urls]).filter((u): u is string => !!u);
  const { rows } = await pool.query(
    `SELECT 1 FROM event_registrations WHERE user_id = $1 AND status = ANY($2::text[]) AND (item_key = ANY($3::text[]) OR event_url = ANY($4::text[])) LIMIT 1`,
    [userId, REGISTERED_STATUSES, keys, links],
  );
  return rows.length > 0;
}

// Pure: the evidence from what was read, the ONE mapping queue time and send time share (review of #445: the send read passed reactions
// raw, so "already_did_it" was ignored there and a row queued on it was dropped at send). The reaction router's "already_did_it" is a
// stated plan or going (outcomes.ts records it as acted).
export function evidenceOf(i: { rows: { result: string; provenance?: string | null }[]; reactions: string[]; registered: boolean; came?: boolean; walkin?: boolean }): import("./followUpEvidence.js").Evidence {
  const rows = [...i.rows, ...i.reactions.filter((x) => x === "already_did_it").map(() => ({ result: "acted", provenance: "stated" }))];
  return followUpEvidenceSync({ rows, reactions: i.reactions, registered: i.registered, came: i.came, walkin: i.walkin });
}

// Pure: a follow-up row's keys, the same ones its outcomes and reactions are recorded under.
export function followUpKeys(row: { id: string; match_name: string; match: any }): string[] {
  const id = row.match?.event_api_id;
  return [...new Set([`followup:${row.id}`, id ? `event:${id}` : `name:${String(row.match_name ?? "").toLowerCase()}`])];
}

// What the record says about one follow-up row (services/followUpEvidence.ts): a yes or a stated plan, a registration, a check-in or a
// walk-in, their stated word. "Cue sent it" and silence are never evidence (Royce, 2026-11-10: a 10-30 send with no reply queued a
// morning-after debrief on 11-10). Throws when it can't be read: the caller holds the row.
export async function rowEvidence(userId: string, row: { id: string; match_name: string; match: any }): Promise<import("./followUpEvidence.js").Evidence> {
  const keys = followUpKeys(row);
  const [outcomes, reactions, registered] = await Promise.all([
    pool.query(`SELECT result, provenance FROM suggestion_outcomes WHERE user_id = $1 AND item_key = ANY($2::text[])`, [userId, keys]).then((r) => r.rows),
    pool.query(`SELECT reaction FROM revealed_offers WHERE user_id = $1 AND item_key = ANY($2::text[]) AND reaction IS NOT NULL`, [userId, keys]).then((r) => r.rows.map((x: any) => String(x.reaction))),
    registeredFor(userId, keys, row.match?.url ?? null),
  ]);
  return evidenceOf({ rows: outcomes, reactions, registered });
}

export async function enqueueDueOutcomeFollowUps(): Promise<void> {
  await expireParkedFollowUps().catch((err: any) => console.error("recommendationOutcome: expiring parked finds failed (non-fatal):", err?.message ?? err));
  const { rows } = await pool.query(
    `SELECT rof.id, rof.user_id, rof.ask_text, rof.match_name, rof.match, rof.send_at, cp.city
     FROM recommendation_outcome_followups rof
     JOIN users u ON u.id = rof.user_id
     LEFT JOIN co_profiles cp ON cp.user_id = rof.user_id
     WHERE rof.sent_at IS NULL AND rof.harness_status IS NULL AND u.sms_opted_out = false
       AND rof.send_at <= NOW() + INTERVAL '2 days'
     LIMIT 50`,
  );
  for (const row of rows) {
    const match = row.match ?? {};
    // Tier 1/2 anchor on the event's own date ("the day after"); Tier 3 has
    // no event to anchor on, so its already-computed send_at (a fixed delay
    // from when it was recommended) is the anchor instead (2026-09-17).
    const eventDate: string | undefined = followUpDate(match) ?? undefined;
    const anchor: Date | null = eventDate ? null : row.send_at instanceof Date ? row.send_at : row.send_at ? new Date(row.send_at) : null;
    // One queued before the boundary for a program or a thing with no event day: closed without a text (nothing asks "how was it").
    if (!isRealEventForFollowUp(match)) {
      await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped', drop_reason = $2 WHERE id = ANY($1::uuid[])`, [[row.id], "not a real event: openings and programs aren't followed up"]);
      continue;
    }
    if (!eventDate && !anchor) {
      await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped' WHERE id = $1`, [row.id]);
      continue;
    }
    // No evidence they meant to go: never queued (Royce's rule, 2026-11-04; 2026-11-10: rows from before the parked design, created when
    // Cue sent a find, were still queued with no reply). A no is dropped with its reason; nothing yet goes back to waiting for a sign
    // (parked), where a later yes, registration or check-in can still arm it. Unreadable: left for the next run.
    const ev = await rowEvidence(row.user_id, row).catch(() => null);
    if (!ev) continue;
    if (ev.level === "none") {
      await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = $2, drop_reason = $3 WHERE id = $1`, [row.id, ev.declined ? "dropped" : AWAITING_EVIDENCE, ev.declined ? ev.why : null]);
      continue;
    }
    const timezone = await memberZone(row.user_id);
    // Only mark 'queued' on an actual queue (code review, 2026-09-17) — see
    // enqueueDebrief's comment.
    const result = await enqueueDebrief({
      userId: row.user_id,
      eventApiId: match.event_api_id ?? null,
      eventName: row.match_name,
      eventEnd: eventDate ? endOfLocalDay(eventDate, timezone) : anchor!,
      eventDate: eventDate ?? null,
      form: formOf(match) === "opening" || !eventDate ? "opening" : "event",
      timezone,
      part: { outcomeFollowupIds: [row.id], askText: row.ask_text },
    }).catch((err: any) => {
      console.error(`recommendationOutcome: enqueueDebrief failed for ${row.id} (non-fatal):`, err?.message ?? err);
      return { queued: false };
    });
    await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = $2 WHERE id = $1`, [row.id, result.queued ? "queued" : "skipped"]);
  }
}

export function endOfLocalDay(isoDate: string, timezone: string | null): Date {
  const d = DateTime.fromISO(isoDate, { zone: timezone ?? "America/Los_Angeles" });
  return (d.isValid ? d.endOf("day") : DateTime.fromISO(isoDate).endOf("day")).toJSDate();
}

export type DebriefPayload = {
  eventApiId: string | null;
  eventName: string;
  // The day it's about, when known (followUpDate). Never followed up before.
  eventDate?: string | null;
  // What the find is (services/findForm.ts): an opening (a listing, program, fellowship, job) never gets an event's "how was it".
  // Older payloads carry none and are read as before.
  form?: "event" | "opening" | null;
  outcomeFollowupIds: string[];
  checkinFollowupIds: string[];
  walkinCheckinIds: string[];
  askText: string | null;
};

// Shared by the three debrief sources. One candidate per (person, event).
// Returns whether it actually queued (code review, 2026-09-17): this used
// to return void, so all three callers had no way to tell a real queue from
// a no-op (the harness candidate already sent/dropped/expired) and marked
// their own source row 'queued' regardless either way.
export async function enqueueDebrief(opts: {
  userId: string;
  eventApiId: string | null;
  eventName: string;
  eventEnd: Date;
  eventDate?: string | null;
  form?: "event" | "opening" | null;
  timezone: string | null;
  part: Partial<Pick<DebriefPayload, "outcomeFollowupIds" | "checkinFollowupIds" | "walkinCheckinIds" | "askText">>;
}): Promise<{ queued: boolean }> {
  const payload: DebriefPayload = {
    eventApiId: opts.eventApiId,
    eventName: opts.eventName,
    eventDate: opts.eventDate ?? null,
    form: opts.form ?? null,
    outcomeFollowupIds: opts.part.outcomeFollowupIds ?? [],
    checkinFollowupIds: opts.part.checkinFollowupIds ?? [],
    walkinCheckinIds: opts.part.walkinCheckinIds ?? [],
    askText: opts.part.askText ?? null,
  };
  const dueAt = nextLocalHour(opts.eventEnd, opts.timezone, 10);
  return enqueueCandidate({
    userId: opts.userId,
    type: "debrief",
    targetKey: `debrief:${opts.eventApiId ?? opts.eventName.toLowerCase()}`,
    summary: `Morning-after follow-up on "${opts.eventName}" (asks whether they went; how it went only with evidence they did)`,
    payload,
    dueAt,
    expiresAt: new Date(dueAt.getTime() + 3 * 24 * 60 * 60 * 1000),
    merge: (existing: DebriefPayload, incoming: DebriefPayload) => ({
      ...existing,
      eventName: existing.eventName || incoming.eventName,
      eventDate: existing.eventDate ?? incoming.eventDate ?? null,
      form: existing.form === "event" || incoming.form === "event" ? "event" : existing.form ?? incoming.form ?? null,
      askText: existing.askText ?? incoming.askText,
      outcomeFollowupIds: Array.from(new Set([...(existing.outcomeFollowupIds ?? []), ...incoming.outcomeFollowupIds])),
      checkinFollowupIds: Array.from(new Set([...(existing.checkinFollowupIds ?? []), ...incoming.checkinFollowupIds])),
      walkinCheckinIds: Array.from(new Set([...(existing.walkinCheckinIds ?? []), ...incoming.walkinCheckinIds])),
    }),
  });
}
