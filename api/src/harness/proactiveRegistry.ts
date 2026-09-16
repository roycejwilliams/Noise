// Per-type drafting and follow-through for the Layer 7 proactive harness
// (src/harness/proactive.ts). Each type says how to draft its text (always
// under PROACTIVE_RULES + CONFIRMED_FACTS, with code-checked output rules)
// and what to record once it actually went out, or was dropped.
import pool from "../db/db.js";
import { writeMemory } from "../services/memory.js";
import { draftProactive, nameTokens, type Candidate, type DraftResult, type ProactiveRegistry } from "./proactive.js";
import { draftEventReveal, draftEventTease } from "../agent/eventDiscoverySurfacing.js";
import { draftAskCheckin, type AskCheckinPayload } from "../agent/askCheckin.js";
import { draftCompanionCheckin } from "../agent/companionCheckin.js";
import { draftWindowFollowUp, type WindowFollowUpPayload } from "../agent/windowFollowUp.js";
import { draftCalendarFollow } from "../agent/calendarFollowReachOut.js";
import { draftAskSolicitation } from "../agent/eventAskSolicitation.js";
import { draftPostCall, markPostCallDropped, markPostCallSent } from "../jobs/postCallFollowUp.js";
import { isShortNotice, onEventOfferDropped, onEventOfferSent, type EventOfferPayload } from "../services/eventSurfacingSweep.js";
import type { DebriefPayload } from "../services/recommendationOutcome.js";

function skip(reason: string): DraftResult {
  return { skip: reason };
}

// The candidate knows its own reveal decision at draft time, so onSent needs
// to know which shape actually went out.
function revealedNow(c: Candidate): boolean {
  return isShortNotice((c.payload as EventOfferPayload).match);
}

async function removeNetworkBacklogItem(userId: string, askId: string, candidateId: string): Promise<void> {
  await pool.query(
    `UPDATE network_backlogs
     SET items = COALESCE((SELECT jsonb_agg(i) FROM jsonb_array_elements(items) i WHERE i->'candidate'->>'candidate_id' <> $3), '[]'::jsonb),
         updated_at = NOW()
     WHERE user_id = $1 AND ask_id = $2`,
    [userId, askId, candidateId],
  );
}

// People Co pointed them to at this event, only from recorded nudges.
async function peopleCoPointedTo(userId: string, eventApiId: string | null): Promise<string[]> {
  if (!eventApiId) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT u.first_name FROM event_guest_match_nudges n JOIN users u ON u.id = n.candidate_id
     WHERE n.event_id = $1 AND n.person_id = $2 AND u.first_name <> ''
     UNION
     SELECT DISTINCT u.first_name FROM event_guest_match_opt_ins o JOIN users u ON u.id = o.candidate_id
     WHERE o.event_id = $1 AND o.person_id = $2 AND o.status = 'interested' AND u.first_name <> ''`,
    [eventApiId, userId],
  );
  return rows.map((r: any) => r.first_name);
}

async function draftDebrief(c: Candidate, firstName: string): Promise<DraftResult> {
  const p = c.payload as DebriefPayload;
  const people = await peopleCoPointedTo(c.userId, p.eventApiId);
  return draftDebriefText(firstName, p, people);
}

export async function draftDebriefText(firstName: string, p: DebriefPayload, people: string[]): Promise<DraftResult> {
  const walkin = (p.walkinCheckinIds ?? []).length > 0;
  const text = await draftProactive({
    functionId: "proactive.debrief",
    firstName,
    facts: {
      event: p.eventName,
      when: "last night or recently",
      people_co_pointed_them_to_there: people,
      what_they_were_looking_for: p.askText,
      they_checked_in_at_the_door: walkin ? "yes, and Co doesn't know them well yet" : null,
    },
    task: `Ask how "${p.eventName}" was, naming the event.${people.length ? ` Name one of the people Co pointed them to and ask if they ended up talking.` : " Ask who they met or what stood out."}${walkin ? " Then offer, in the same text, to find time for a call this week so you can get to know them and point them to better people next time." : ""} One text, not a survey.`,
  });
  if (!text) return skip("model chose SKIP");
  return {
    messages: [text],
    text,
    rules: { maxSentences: walkin ? 3 : 2, maxChars: walkin ? 320 : 240, mustIncludeAny: nameTokens(p.eventName).length ? nameTokens(p.eventName) : [p.eventName] },
  };
}

export const proactiveRegistry: ProactiveRegistry = {
  event_offer: {
    async draft(c, person) {
      const p = c.payload as EventOfferPayload;
      if (isShortNotice(p.match)) {
        const r = await draftEventReveal(person, p.askText, p.fromProfile, p.match);
        return r ?? skip("model chose SKIP");
      }
      const r = await draftEventTease(person, p.askText, p.fromProfile, p.match);
      return r ? { messages: [r.text], ...r } : skip("model chose SKIP");
    },
    async onSent(c) {
      await onEventOfferSent(c.userId, c.payload as EventOfferPayload, revealedNow(c));
      const p = c.payload as EventOfferPayload;
      await writeMemory(c.userId, "event_discovery_surfacing", `${revealedNow(c) ? "Revealed directly (short notice)" : "Teased"}: ${p.match.name}`);
    },
    async onDropped(c) {
      await onEventOfferDropped(c.userId, c.payload as EventOfferPayload);
    },
  },

  network_tease: {
    async draft(c, person) {
      const candidate = c.payload.candidate;
      const text = await draftProactive({
        functionId: "networkIntroNudge.tease.draft",
        firstName: person.firstName,
        facts: { what_is_true: "someone in Co's network fits what they've told you they're looking for" },
        task: "Say someone in the network came to mind for them, without naming or describing the person, and ask one yes/no question: do they want to hear who. Don't say the other person wants to meet them.",
      });
      if (!text) return skip("model chose SKIP");
      return { messages: [text], text, rules: { maxSentences: 2, maxChars: 200, mustNotInclude: [candidate.first_name] } };
    },
    async onSent(c) {
      const { askId, candidate } = c.payload;
      await removeNetworkBacklogItem(c.userId, askId, candidate.candidate_id);
      await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_offer_pending', $2)`, [
        c.userId,
        JSON.stringify({ askId, candidate }),
      ]);
    },
    async onDropped(c) {
      await removeNetworkBacklogItem(c.userId, c.payload.askId, c.payload.candidate.candidate_id);
    },
  },

  ask_checkin: {
    async draft(c, person) {
      const r = await draftAskCheckin(person.firstName, c.payload as AskCheckinPayload);
      return r ? { messages: [r.text], ...r } : skip("model chose SKIP");
    },
    async onSent(c) {
      const p = c.payload as AskCheckinPayload;
      await pool.query(
        `UPDATE ask_checkins SET last_checked_at = NOW(), checkin_count = checkin_count + 1, awaiting_response_since = NOW() WHERE id = $1`,
        [p.askCheckinId],
      );
      await writeMemory(c.userId, "check_in", `Checked in on: ${p.askText}`);
    },
    async onDropped(c) {
      await pool.query(`UPDATE ask_checkins SET last_checked_at = NOW() WHERE id = $1`, [(c.payload as AskCheckinPayload).askCheckinId]);
    },
  },

  window_followup: {
    async draft(c, person) {
      const r = await draftWindowFollowUp(person.firstName, c.payload as WindowFollowUpPayload);
      return r ? { messages: [r.text], ...r } : skip("model chose SKIP");
    },
    async onSent(c, _p, messages) {
      await writeMemory(c.userId, "check_in", `Followed up on ${(c.payload as WindowFollowUpPayload).label}: ${messages.join(" ")}`);
    },
    async onDropped() {},
  },

  companion: {
    async draft(c, person) {
      const r = await draftCompanionCheckin(person.firstName, c.payload.recap ?? "");
      return r ? { messages: [r.text], ...r } : skip("model chose SKIP: no specific open thread");
    },
    async onSent(c, _p, messages) {
      await pool.query(`UPDATE co_profiles SET last_companion_checkin_at = NOW() WHERE user_id = $1`, [c.userId]);
      await writeMemory(c.userId, "companion_checkin", `Companion check-in: ${messages.join(" ")}`);
    },
    async onDropped(c) {
      await pool.query(`UPDATE co_profiles SET last_companion_checkin_at = NOW() WHERE user_id = $1`, [c.userId]);
    },
  },

  calendar_follow: {
    async draft(_c, person) {
      const r = await draftCalendarFollow(person.firstName);
      return r ? { messages: [r.text], ...r } : skip("model chose SKIP");
    },
    async onSent(c) {
      await writeMemory(c.userId, "calendar_follow_reach_out", "Reached out after they followed the Co Presents calendar");
    },
  },

  ask_solicitation: {
    async draft(c, person) {
      const r = await draftAskSolicitation(person.firstName, c.payload.eventName);
      return r ? { messages: [r.text], ...r, rules: { ...r.rules, mustIncludeAny: nameTokens(c.payload.eventName) } } : skip("model chose SKIP");
    },
    async onSent(c) {
      await writeMemory(c.userId, "event_ask_solicitation", `Asked what they want from "${c.payload.eventName}"`);
    },
  },

  debrief: {
    async draft(c, person) {
      return draftDebrief(c, person.firstName);
    },
    async onSent(c, _person, messages) {
      const p = c.payload as DebriefPayload;
      if (p.outcomeFollowupIds?.length) {
        await pool.query(`UPDATE recommendation_outcome_followups SET sent_at = NOW(), harness_status = 'sent' WHERE id = ANY($1::uuid[])`, [p.outcomeFollowupIds]);
      }
      if (p.checkinFollowupIds?.length) {
        await pool.query(`UPDATE event_checkin_followups SET sent_at = NOW(), harness_status = 'sent' WHERE id = ANY($1::uuid[])`, [p.checkinFollowupIds]);
      }
      if (p.walkinCheckinIds?.length) {
        await pool.query(`UPDATE event_walkin_checkins SET followup_sent_at = NOW() WHERE id::text = ANY($1::text[])`, [p.walkinCheckinIds]);
        // Same call_offer_pending shape routes/sendblue.ts watches, so a
        // reply with a time becomes a scheduled call.
        await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_pending', $2)`, [
          c.userId,
          `Co proactively offered: "${messages.join(" ")}" (morning-after follow-up after checking in at "${p.eventName}")`,
        ]);
      }
    },
    async onDropped(c) {
      const p = c.payload as DebriefPayload;
      if (p.outcomeFollowupIds?.length) {
        await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped' WHERE id = ANY($1::uuid[])`, [p.outcomeFollowupIds]);
      }
      if (p.checkinFollowupIds?.length) {
        await pool.query(`UPDATE event_checkin_followups SET harness_status = 'dropped' WHERE id = ANY($1::uuid[])`, [p.checkinFollowupIds]);
      }
      if (p.walkinCheckinIds?.length) {
        await pool.query(`UPDATE event_walkin_checkins SET followup_sent_at = NOW() WHERE id::text = ANY($1::text[])`, [p.walkinCheckinIds]);
      }
    },
  },

  post_call: {
    async draft(c, person) {
      const r = await draftPostCall(c.userId, person.firstName, c.payload.followUpId);
      return r ? { messages: [r.text], ...r } : skip("model chose SKIP");
    },
    async onSent(c) {
      await markPostCallSent(c.payload.followUpId);
    },
    async onDropped(c, status) {
      await markPostCallDropped(c.payload.followUpId, status);
    },
  },

  // Human-written bullets go out verbatim; only the intro/closing lines are
  // model-drafted, and those are what the output checks run on.
  product_update: {
    async draft(c, person) {
      const { intro, closing, bulletList } = c.payload as { intro: string; closing: string; bulletList: string };
      const message = `Hey ${person.firstName}, ${intro}\n\n${bulletList}\n\n${closing}`;
      return { messages: [message], text: `${intro} ${closing}`, rules: { maxChars: 400, allowGreeting: true } };
    },
  },
};
