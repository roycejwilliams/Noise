// Per-type drafting and follow-through for the Layer 7 proactive harness
// (src/harness/proactive.ts). Each type says how to draft its text (always
// under PROACTIVE_RULES + CONFIRMED_FACTS, with code-checked output rules)
// and what to record once it actually went out, or was dropped.
import pool from "../db/db.js";
import { writeMemory } from "../services/memory.js";
import { MODELS } from "../models.js";
import { memberMoOn } from "../services/capabilities.js";
import { draftKnowledge, draftProactive, nameTokens, nextLocalHour, type Candidate, type DraftResult, type Person, type ProactiveRegistry } from "./proactive.js";
import { draftEventReveal } from "../agent/eventDiscoverySurfacing.js";
import { draftAskCheckin, type AskCheckinPayload } from "../agent/askCheckin.js";
import { draftCompanionCheckin } from "../agent/companionCheckin.js";
import { draftWindowFollowUp, type WindowFollowUpPayload } from "../agent/windowFollowUp.js";
import { draftCalendarFollow } from "../agent/calendarFollowReachOut.js";
import { draftAskSolicitation } from "../agent/eventAskSolicitation.js";
import { draftPostCall, markPostCallDropped, markPostCallSent, recordRecapOffer } from "../jobs/postCallFollowUp.js";
import { askStillOpen, isShortNotice, onEventOfferDropped, onEventOfferSent, type EventOfferPayload } from "../services/eventSurfacingSweep.js";
import { endOfLocalDay, followUpDate, type DebriefPayload } from "../services/recommendationOutcome.js";
import { itemDays, localToday, offerable, readDates } from "../services/dateGuard.js";
import { markMatchNudgeSent, type EventMatchNudgePayload } from "../services/eventScoring.js";
import { lapseCloseDate, lapseText } from "../services/membershipLapse.js";
import { memberZone } from "../services/memberTime.js";
import { prepareReveal } from "../services/networkIntroNudge.js";
import { draftStateNudge, onStateNudgeDropped, onStateNudgeSent } from "../services/memberStateNudges.js";

function skip(reason: string): DraftResult {
  return { skip: reason };
}

// The candidate knows its own reveal decision at draft time, so onSent needs
// to know which shape actually went out.
// Every event offer now goes out with its real details (Royce, 2026-09-18,
// superseding the 2026-08-30 ask-first tease): a tease needed a reply before
// anything happened, and an unanswered one blocked the next offer on it.
function revealedNow(_c: Candidate): boolean {
  return true;
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

// What Co actually sent them about it, and when: the link as its own text,
// then the line right after it (2026-09-26: a follow-up said "a few days
// ago" about a send from five days back, and when Royce said Co never sent
// it, Co couldn't see the send and agreed).
export type SentRecord = { date: string; caption: string | null };
async function whatCoSent(userId: string, followupIds: string[]): Promise<SentRecord | null> {
  if (!followupIds.length) return null;
  const { rows: f } = await pool.query(`SELECT match->>'url' AS url, match_name FROM recommendation_outcome_followups WHERE id = ANY($1::uuid[])`, [followupIds]);
  for (const r of f) {
    if (!r.url) continue;
    const { rows } = await pool.query(
      `SELECT l.created_at,
              (SELECT n.content FROM co_memories n WHERE n.user_id = l.user_id AND n.memory_type = 'text_exchange' AND n.content LIKE 'Co replied:%'
                 AND n.created_at > l.created_at AND n.created_at < l.created_at + INTERVAL '2 minutes' AND n.content <> l.content ORDER BY n.created_at LIMIT 1) AS caption
       FROM co_memories l WHERE l.user_id = $1 AND l.memory_type = 'text_exchange' AND l.content = 'Co replied: ' || $2
       ORDER BY l.created_at DESC LIMIT 1`,
      [userId, r.url],
    );
    if (rows[0]) return { date: new Date(rows[0].created_at).toISOString().slice(0, 10), caption: rows[0].caption ? String(rows[0].caption).replace(/^Co replied:\s*/, "") : null };
  }
  return null;
}

async function draftDebrief(c: Candidate, firstName: string): Promise<DraftResult> {
  const p = c.payload as DebriefPayload;
  const tz = await memberZone(c.userId);
  // Never before the day it's about. Older payloads carry no date, so it's
  // read from their follow-up rows.
  let date = p.eventDate ?? null;
  if (!date && p.outcomeFollowupIds?.length) {
    const { rows } = await pool.query(`SELECT match FROM recommendation_outcome_followups WHERE id = ANY($1::uuid[])`, [p.outcomeFollowupIds]).catch(() => ({ rows: [] as any[] }));
    date = rows.map((r: any) => followUpDate(r.match)).filter((d: string | null): d is string => !!d).sort().pop() ?? null;
  }
  if (date) {
    const end = endOfLocalDay(date, tz);
    if (end.getTime() > Date.now()) return { defer: nextLocalHour(end, tz, 10), reason: `"${p.eventName}" is on ${date}, which hasn't happened yet` };
  }
  // A follow-up on something Co sent needs a record that Co sent it.
  const sent = p.outcomeFollowupIds?.length ? await whatCoSent(c.userId, p.outcomeFollowupIds) : null;
  const onlyAboutASend = !p.eventApiId && !(p.checkinFollowupIds ?? []).length && !(p.walkinCheckinIds ?? []).length;
  if (onlyAboutASend && !sent) return skip("no record of Co sending it to them");
  const people = await peopleCoPointedTo(c.userId, p.eventApiId);
  // Did they go? Only a check-in, a walk-in, or their own words say so (Royce, 2026-10-09: "How was the Claude Founder Salon?"
  // went to someone Co had only recommended it to; "I never confirmed I was going to those").
  const theirs = await pool
    .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User%' AND created_at > NOW() - INTERVAL '30 days' ORDER BY created_at DESC LIMIT 200`, [c.userId])
    .then((r) => r.rows.map((x: any) => String(x.content)))
    .catch(() => [] as string[]);
  return draftDebriefText(firstName, p, people, sent, date, attendanceConfirmed(p, theirs));
}

// Pure: whether the record says they went (or meant to): checked in at the door, a walk-in, or their own words naming it with
// going, RSVP or having been there. Co recommending it is never that.
const GOING = /\b(?:i'?m going|i'?ll (?:go|be there)|going to|gonna go|rsvp'?d|registered|signed up|got (?:a )?tickets?|i went|we went|was there|made it|heading to|see you at)\b/i;
// Their own "not going" (review of #129: "I'm not going to the salon" and "I never made it" read as going).
const NOT_GOING = /\b(?:not|never|didn'?t|don'?t|can'?t|cannot|couldn'?t|won'?t|wasn'?t|isn'?t|skip(?:ping|ped)?|pass(?:ing)?|missed|bail(?:ed|ing)?|no longer)\b/i;
export function attendanceConfirmed(p: Pick<DebriefPayload, "eventName" | "checkinFollowupIds" | "walkinCheckinIds">, theirLines: string[]): boolean {
  if ((p.checkinFollowupIds ?? []).length || (p.walkinCheckinIds ?? []).length) return true;
  const words = p.eventName.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3 && !["event", "with", "night", "party", "2026"].includes(w));
  const key = words.slice(0, 3);
  if (!key.length) return false;
  // Whole words only ("founder" never matches "founders" of another event).
  const has = (t: string, w: string) => new RegExp(`\\b${w}\\b`).test(t);
  return theirLines.some((l) => {
    // "can't wait" is eager, not a no.
    const t = l.toLowerCase().replace(/[‘’]/g, "'").replace(/\b(?:can'?t|cannot) wait\b/g, "eager");
    return key.filter((w) => has(t, w)).length >= Math.min(2, key.length) && GOING.test(t) && !NOT_GOING.test(t);
  });
}
// A line that takes for granted they went ("How was…", "anyone stood out", "who did you meet").
export const PRESUMES_THEY_WENT = /\bhow (?:was|did|'d|’d)\b|\bhow['’]d\b|\b(?:anyone|anything|who) stood out\b|\bwho did you (?:meet|talk|end up)\b|\bdid you (?:meet|enjoy|have fun)\b|\bmeet anyone\b|\bwhat did you think of\b/i;

export async function draftDebriefText(firstName: string, p: DebriefPayload, people: string[], sent: SentRecord | null = null, date: string | null = null, went = true): Promise<DraftResult> {
  const walkin = (p.walkinCheckinIds ?? []).length > 0;
  // A Tier 3 opportunity (accelerator, investor, mentor — see
  // tieredRecommendation.ts's category) has no eventApiId (it's not a real
  // Luma event) and never comes with check-in/walk-in data (those only
  // exist for a physical event). "Who did you meet there?" doesn't apply —
  // ask whether they actually did anything with it instead (2026-09-17,
  // closing the loop on outcomes for Tier 3).
  const isOpportunity = !p.eventApiId && !walkin && (p.checkinFollowupIds ?? []).length === 0;
  const text = await draftProactive({
    functionId: "proactive.debrief",
    firstName,
    facts: {
      event: p.eventName,
      when: date ? `it was on ${date}` : isOpportunity ? null : "last night or recently",
      co_sent_it_on: sent?.date ?? null,
      what_co_said_when_it_sent_it: sent?.caption ?? null,
      today: new Date().toISOString().slice(0, 10),
      people_co_pointed_them_to_there: people,
      what_they_were_looking_for: p.askText,
      they_checked_in_at_the_door: walkin ? "yes, and Co doesn't know them well yet" : null,
    },
    task: !went && !isOpportunity
      ? `Co only suggested "${p.eventName}" to them; nothing says they went. Ask, lightly, whether they ended up making it, naming it. Never assume they went: no "how was it", no "who did you meet". One easy question, no pressure either way.`
      : isOpportunity
      ? `Ask if they got a chance to look into or apply to "${p.eventName}" (an opening Co pointed them to on the date above, not an event) — did anything come of it. If what Co said about it shows it's still ahead of today, SKIP. One text, not a survey.`
      : `Ask how "${p.eventName}" was, naming the event.${people.length ? ` Name one of the people Co pointed them to and ask if they ended up talking.` : " Ask who they met or what stood out."}${walkin ? " Then offer, in the same text, to find time for a call this week so you can get to know them and point them to better people next time." : ""} One text, not a survey.`,
  });
  if (!text) return skip("model chose SKIP");
  // Code backstop: an unconfirmed debrief never takes for granted that they went.
  if (!went && !isOpportunity && PRESUMES_THEY_WENT.test(text)) return skip("it assumes they went, and nothing says they did");
  return {
    messages: [text],
    text,
    rules: { maxSentences: walkin ? 3 : 2, maxChars: walkin ? 320 : 240, mustIncludeAny: nameTokens(p.eventName).length ? nameTokens(p.eventName) : [p.eventName] },
  };
}

// One offer, made ready to say at send time (Phase C: the bundle composer and the single reveal both use it). Their ask still open, its
// dates still ahead in their zone (services/dateGuard.ts), and how it ties to the rest of what they've said (services/connectDots.ts).
export async function prepareOffer(c: Candidate, person: Person): Promise<{ skip: string } | { dots: string[]; why: string; item: import("../agent/eventDiscoverySurfacing.js").RevealItem }> {
  const p = c.payload as EventOfferPayload;
  // Their ask closed since this was queued: don't send it (2026-09-26).
  if (!(await askStillOpen(p.askId))) return { skip: "their ask has since closed" };
  const when = offerable(readDates(itemDays(p.match, person.timezone), localToday(person.timezone)));
  if (!when.ok) return { skip: `not offered: ${when.why}` };
  const { gatherDots, findDots, whyContext } = await import("../services/connectDots.js");
  const known = await gatherDots(c.userId);
  const dots = p.reminder ? [] : (await findDots({ ...known, now: `Co is about to offer them: ${p.match.name}${"description" in p.match && p.match.description ? `, ${String(p.match.description).slice(0, 300)}` : ""} (${p.fromProfile ? `Co noticed it for them from where they're headed, not an ask: ${p.askText}` : `it came up for their ask: "${p.askText}"`})` })).map((d) => d.link);
  const why = whyContext(known);
  const { revealItem } = await import("../agent/eventDiscoverySurfacing.js");
  return { dots, why, item: revealItem(p.askText, p.fromProfile, p.match, { dots, why }) };
}

export const proactiveRegistry: ProactiveRegistry = {
  event_offer: {
    // A reminder rides alone and is drafted here; every other offer goes out through the bundle composer (harness/bundleComposer.ts),
    // which uses prepareOffer below for each find.
    async draft(c, person) {
      const prep = await prepareOffer(c, person);
      if ("skip" in prep) return skip(prep.skip);
      const p = c.payload as EventOfferPayload;
      const r = await draftEventReveal(person, p.askText, p.fromProfile, p.match, { reminder: p.reminder, again: p.again, dots: prep.dots, why: prep.why });
      return r ?? skip("model chose SKIP");
    },
    async onSent(c) {
      await onEventOfferSent(c.userId, c.payload as EventOfferPayload, revealedNow(c));
      const p = c.payload as EventOfferPayload;
      await writeMemory(c.userId, "event_discovery_surfacing", `Sent directly${isShortNotice(p.match) ? " (short notice)" : ""}: ${p.match.name}`);
    },
    async onDropped(c) {
      await onEventOfferDropped(c.userId, c.payload as EventOfferPayload);
    },
  },

  network_tease: {
    async draft(c, person) {
      const candidate = c.payload.candidate;
      // A closed ask makes no offers (services/askLifecycle.ts).
      if (!(await (await import("../services/askLifecycle.js")).askIsOpenRef(c.userId, c.payload.askId))) return skip("their ask has since closed");
      const text = await draftProactive({
        functionId: "networkIntroNudge.tease.draft",
        firstName: person.firstName,
        facts: { what_is_true: "someone in Co's network fits what they've told you they're looking for" },
        task: "Say someone in the network came to mind for them, without naming or describing the person, and ask one yes/no question: do they want to hear who. Don't say the other person wants to meet them.",
      });
      if (!text) return skip("model chose SKIP");
      // Never ask "want to hear who?" without the answer in hand: the reveal is
      // checked and drafted now, and stored with the tease (onSent), so a yes
      // delivers it. If it couldn't go out, neither does the tease.
      const prepared = await prepareReveal(c.userId, person.firstName, candidate);
      // A draft that failed is tried again in an hour; a gate that said no is final.
      if ("why" in prepared) return prepared.retry ? { defer: new Date(Date.now() + 3_600_000), reason: `no tease yet: ${prepared.why}` } : skip(`no tease: ${prepared.why}`);
      c.payload.preparedReveal = prepared.message;
      c.payload.preparedRevealOptedIn = prepared.optedIn;
      return { messages: [text], text, rules: { maxSentences: 2, maxChars: 200, mustNotInclude: [candidate.first_name] } };
    },
    async onSent(c) {
      const { askId, candidate, preparedReveal, preparedRevealOptedIn } = c.payload;
      await removeNetworkBacklogItem(c.userId, askId, candidate.candidate_id);
      await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_offer_pending', $2)`, [
        c.userId,
        JSON.stringify({ askId, candidate, ...(preparedReveal ? { reveal: preparedReveal, revealOptedIn: preparedRevealOptedIn === true } : {}) }),
      ]);
    },
    async onDropped(c) {
      await removeNetworkBacklogItem(c.userId, c.payload.askId, c.payload.candidate.candidate_id);
    },
  },

  ask_checkin: {
    async draft(c, person) {
      // A closed ask produces nothing, and an ask Co has already answered or delivered closes here, before any text is written
      // (services/askLifecycle.ts): the check-in is re-checked at send time, not only when it was queued.
      const gate = await (await import("../services/askLifecycle.js")).checkinGate(c.userId, (c.payload as AskCheckinPayload).askCheckinId);
      if (!gate.ok) return skip(gate.why);
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
    // A payload-first drop (the work went to a task, or couldn't be delivered
    // yet) moves the check-in count on, so the next check-in gets a new target
    // and comes back on schedule; otherwise it reused the dropped one and that
    // ask's check-ins stopped for good (re-review of #59).
    async onDropped(c, _status, reason) {
      const next = /^payload first/.test(reason ?? "");
      await pool.query(`UPDATE ask_checkins SET last_checked_at = NOW()${next ? ", checkin_count = checkin_count + 1" : ""} WHERE id = $1`, [(c.payload as AskCheckinPayload).askCheckinId]);
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
      // The next-day check-in is looked at once more now: not on top of a conversation, not after a good moment.
      if (c.payload.heavy) {
        const { heavyFitsNow } = await import("../services/heavyMoment.js");
        const fit = await heavyFitsNow(c.userId, new Date(c.payload.heavy.endedAt ?? 0));
        if (!fit.ok) return skip(`not the moment: ${fit.why}`);
      }
      const r = await draftCompanionCheckin(person.firstName, c.payload.recap ?? "", c.payload.thread ?? null, c.payload.item ?? null, c.payload.curious ?? null, c.payload.story ?? null, c.payload.advice ?? null, c.payload.heavy ?? null);
      return r ? { messages: [r.text], ...r } : skip("model chose SKIP: no specific open thread");
    },
    async onSent(c, _p, messages) {
      await pool.query(`UPDATE co_profiles SET last_companion_checkin_at = NOW() WHERE user_id = $1`, [c.userId]);
      // Asked about it: fresh again, so the next check-in picks another thread.
      if (c.payload.threadId) {
        await pool.query(`UPDATE member_threads SET last_touched_at = NOW() WHERE id = $1 AND user_id = $2`, [c.payload.threadId, c.userId]);
      }
      await writeMemory(c.userId, "companion_checkin", `Companion check-in: ${messages.join(" ")}`);
      // Asked how the advice went: once.
      if (c.payload.advice?.id) {
        const { markFollowedUp } = await import("../services/advice.js");
        await markFollowedUp(c.userId, c.payload.advice.id).catch(() => {});
      }
      // A moment marked: once, and it becomes part of the story Co tells back.
      if (c.payload.story?.key) {
        const { markMilestone } = await import("../services/milestones.js");
        await markMilestone(c.userId, c.payload.story.key).catch(() => {});
      }
      // Asked about it: not again for a while (services/understanding.ts).
      if (c.payload.curious?.topic) {
        const { markTopicAsked } = await import("../services/profileExtraction.js");
        markTopicAsked(c.userId, c.payload.curious.topic);
      }
    },
    // Co choosing SKIP waits the full 14 days. A draft that failed its
    // checks, errored, or expired unsent was never Co's call, so it comes
    // back in about two days (2026-09-28: two failed drafts to Jacqueline on
    // 09-23 held off every check-in until 10-07).
    async onDropped(c, _status, reason) {
      // The next-day check-in never changes when the regular check-in is due.
      if (c.payload.heavy) return;
      const coChoseSkip = /^model chose SKIP/.test(reason ?? "");
      await pool.query(
        `UPDATE co_profiles SET last_companion_checkin_at = NOW() - ($2 || ' days')::interval WHERE user_id = $1`,
        [c.userId, coChoseSkip ? "0" : "12"],
      );
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

  // Before a Co event (services/preArrival.ts): logistics from the event's own
  // fields, a count of who fits (never who), one opener or the "what do you want
  // from it" question, then the location offer, added in code.
  pre_arrival: {
    async draft(c, person) {
      const P = await import("../services/preArrival.js");
      const p = c.payload;
      const [ask, fits, members] = await Promise.all([
        P.statedAsk(c.userId),
        P.strongFits(p.eventId, c.userId),
        import("../services/eventPresence.js").then((e) => e.eventMembers(p.eventId)).catch(() => [] as { first_name: string; user_id: string }[]),
      ]);
      const text = await draftProactive({
        functionId: "agent.preArrival",
        firstName: person.firstName,
        facts: {
          event: p.name,
          starts_at_local_time: P.localStart(p.startAt, p.timezone),
          // The date as a date (not a word), so "today", "tonight" and the weekday are backed by it and nothing else can be.
          the_event_date: P.localDate(p.startAt, p.timezone),
          ...(p.venue ? { venue: p.venue } : {}),
          ...(p.address ? { address: p.address } : {}),
          ...(fits >= P.PRE_ARRIVAL.minCrowd ? { people_coming_who_fit_their_ask: `${fits} (say only that a few people coming fit what they're after; never describe or name anyone)` } : {}),
          ...(ask ? { what_they_are_looking_for: ask } : { what_they_want_from_this_event: "unknown: ask them, in one short question" }),
        },
        task: `They're going to ${p.name} later today. Text them before they head over: when it starts and where (only from the facts), ${fits >= P.PRE_ARRIVAL.minCrowd ? "that a few people coming fit what they're after (no descriptions, no names), " : ""}${ask ? "and one easy opener line they could use, tied to what they're looking for" : "and ask what they're hoping to get out of it tonight, in one short question"}. Warm and brief. Never promise anything, never name or describe another guest, and never offer to contact the host. No sign-off.`,
        maxSentences: 3,
      });
      if (!text) return skip("model chose SKIP");
      const named = P.namesAnyone(text, members.filter((m) => m.user_id !== c.userId).map((m) => m.first_name));
      if (named) return skip(`named another guest (${named})`);
      const row = await P.presenceRow(p.eventId, c.userId);
      const offer = p.canUseLocation && !row?.location_yes_at ? [P.LOCATION_OFFER] : [];
      return { messages: [text, ...offer], text, rules: { maxSentences: 3, maxChars: 420, mustIncludeAny: nameTokens(p.name) } };
    },
    async onSent(c) {
      const p = c.payload;
      await pool.query(
        `INSERT INTO event_presence (event_api_id, user_id, asked_at, pre_arrival_sent_at) VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (event_api_id, user_id) DO UPDATE SET asked_at = COALESCE(event_presence.asked_at, NOW()), pre_arrival_sent_at = NOW()`,
        [p.eventId, c.userId],
      );
      // It asked what they want from the event when Co didn't know: that's the ask, not a second one later.
      await pool.query(`INSERT INTO event_ask_solicitations (event_id, person_id, solicited_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`, [p.eventId, c.userId]).catch(() => {});
      await writeMemory(c.userId, "event_pre_arrival", `Texted them before "${p.name}"`);
    },
  },

  // Member-facing Mo (mo/memberFlow.ts). The words are built in code from the stored rows, so what the member approves is
  // exactly what is sent and nothing here is the model's wording.
  mo_member_offer: {
    async draft(c) {
      if (!memberMoOn()) return skip("member Mo is off");
      const M = await import("../mo/memberFlow.js");
      const row = await M.optInRow(c.userId);
      if (row?.asked_at) return skip("already asked");
      const need = String(c.payload.need ?? "").trim();
      if (!need) return skip("nothing to look for");
      const messages = [`I can look outside the club for ${need}.`, "Want me to? You'd see every person and every word before anything goes out. A yes or a no is fine, and if I don't hear, I won't."];
      return { messages, text: messages.join(" "), rules: { maxSentences: 5, maxChars: 420 } };
    },
    async onSent(c) {
      const M = await import("../mo/memberFlow.js");
      await M.noteOptInAsked(c.userId);
      await writeMemory(c.userId, "mo_member_offer", "Asked if Mo may look outside the club for someone");
    },
  },
  mo_member_voice: {
    async draft(c, person) {
      if (!memberMoOn()) return skip("member Mo is off");
      const M = await import("../mo/memberFlow.js");
      const [row, batch] = await Promise.all([M.optInRow(c.userId), M.openBatch(c.userId)]);
      if (row?.status !== "yes" || row?.paused_at || !batch || row?.voice_approved_at) return skip("nothing to approve");
      const voice = row?.voice_text ?? M.DEFAULT_VOICE;
      c.payload.voice = voice;
      const example = M.composeApproach(voice, { named: false, memberFirstName: person.firstName, need: batch.need_text, why: "You wrote about work like this, which is why I'm writing" });
      const messages = ["Before I reach out to anyone, this is how I'd introduce myself:", example, `Say yes if that sounds right. I'll say "a member of the club" rather than your name, unless you tell me to use your name.`];
      return { messages, text: messages.join("\n\n"), rules: { maxSentences: 12, maxChars: 900 } };
    },
    async onSent(c) {
      const M = await import("../mo/memberFlow.js");
      await M.saveVoice(c.userId, String(c.payload.voice ?? M.DEFAULT_VOICE), false);
    },
  },
  mo_member_batch: {
    async draft(c) {
      if (!memberMoOn()) return skip("member Mo is off");
      const M = await import("../mo/memberFlow.js");
      const { composeApproach } = M;
      const [row, batch] = await Promise.all([M.optInRow(c.userId), M.openBatch(c.userId)]);
      if (row?.status !== "yes" || row?.paused_at || !row?.voice_approved_at || !batch || batch.status !== "open") return skip("nothing to pick from");
      const { rows: u } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [c.userId]);
      const people = (await M.candidatesOf(batch.id, c.userId)).filter((p) => p.status === "pending").map((p) => ({
        n: p.n, label: M.personLabel(p), why: p.why, quote: p.evidence_quote,
        text: composeApproach(row.voice_text ?? M.DEFAULT_VOICE, { named: !!row.voice_named, memberFirstName: u[0]?.first_name ?? "", need: batch.need_text, why: p.why }),
      }));
      if (!people.length) return skip("no one left in the batch");
      const messages = M.batchMessages({ need: batch.need_text, people });
      return { messages, text: messages[0], rules: { maxSentences: 4, maxChars: 400 } };
    },
    async onSent(c) {
      await pool.query(`UPDATE mo_member_batches SET presented_at = COALESCE(presented_at, NOW()) WHERE user_id = $1 AND status = 'open'`, [c.userId]);
    },
  },
  mo_member_update: {
    async draft(c) {
      if (!memberMoOn()) return skip("member Mo is off");
      const M = await import("../mo/memberFlow.js");
      const { rows } = await pool.query(`SELECT * FROM mo_member_candidates WHERE id = $1 AND user_id = $2`, [c.payload.candidateId, c.userId]);
      const p = rows[0];
      if (!p) return skip("no such person for this member");
      const who = M.personLabel(p);
      const text: Record<string, string> = {
        replied: `${who} wrote back and wants the invite. I've sent it. If they join, would you like me to introduce you? A yes or a no is fine. If they never join, nothing happens.`,
        declined: `${who} said no thanks, so I won't contact them again.`,
        question: `${who} replied with a question. I've held it: I won't discuss you or the club until they've joined.`,
      };
      const t = text[String(c.payload.kind)];
      if (!t) return skip("unknown update");
      c.payload.who = who;
      return { messages: [t], text: t, rules: { maxSentences: 4, maxChars: 260 } };
    },
  },

  // After they tell Co who they met at a Co event: what stood out, in their words, and a note for each person worth
  // keeping, for them to send. Built from their own message only (services/eventFollowThrough.ts).
  event_followthrough: {
    async draft(c, person) {
      const F = await import("../services/eventFollowThrough.js");
      const p = c.payload;
      const r = await F.buildFollowThrough({ userId: c.userId, firstName: person.firstName, eventId: p.eventId, eventName: p.name, theirMessage: String(p.theirMessage ?? "") });
      if ("skip" in r) return skip(r.skip);
      c.payload.people = r.people;
      // The harness's text rules (one question, sentence count) are for what Co says: that is the recap. The notes are the
      // member's own words to send; they are checked line by line in services/eventFollowThrough.ts (noteProblem).
      return { messages: r.messages, text: r.messages[0], rules: { maxSentences: 6, maxChars: 900, mustIncludeAny: nameTokens(p.name).length ? nameTokens(p.name) : [p.name] } };
    },
    async onSent(c) {
      const F = await import("../services/eventFollowThrough.js");
      await F.recordFollowThrough(c.userId, c.payload.eventId, Number(c.payload.people) || 0);
      await writeMemory(c.userId, "event_follow_through", `Sent them notes to follow up with people they met at "${c.payload.name}"`);
    },
  },

  // The one question at RSVP that lets the member brief name them (services/eventBrief.ts). The words are fixed
  // in code: a yes or a no is all it takes, and no answer means no name.
  brief_name_ask: {
    async draft(c) {
      const B = await import("../services/eventBrief.js");
      const p = c.payload;
      const f = await B.presenceFlags(p.eventId, c.userId);
      if (f.asked || f.notGoing) return skip("already asked, or not going");
      // Beside it: which of their asks may be told to a good match in the room (services/askSharing.ts). Private by default.
      const S = await import("../services/askSharing.js");
      const asks = S.undecidedAsks((await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [c.userId])).rows[0]?.intent);
      const messages = B.nameAskMessages(p.name, S.shareAskMessage(asks));
      return { messages, text: messages.join(" "), rules: { maxSentences: asks.length ? 7 : 4, maxChars: asks.length ? 900 : 320, mustIncludeAny: nameTokens(p.name).length ? nameTokens(p.name) : [p.name] } };
    },
    async onSent(c) {
      await pool.query(
        `INSERT INTO event_presence (event_api_id, user_id, name_asked_at, name_ask_until) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (event_api_id, user_id) DO UPDATE SET name_asked_at = COALESCE(event_presence.name_asked_at, NOW()), name_ask_until = $3`,
        [c.payload.eventId, c.userId, c.payload.startAt],
      );
      // The asks the share question offered, in the order shown, so "1 and 3" maps to the right ones.
      const S = await import("../services/askSharing.js");
      const offered = S.undecidedAsks((await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [c.userId])).rows[0]?.intent).map((a) => a.id);
      if (offered.length) await pool.query(`UPDATE event_presence SET share_asked_at = NOW(), share_ask_ids = $3, share_answered_at = NULL WHERE event_api_id = $1 AND user_id = $2`, [c.payload.eventId, c.userId, offered]);
      await writeMemory(c.userId, "event_brief_ask", `Asked if Co may name them in the member brief for "${c.payload.name}"`);
    },
  },

  // A loop nobody has signalled on for a week: ask once whether it is still on their plate, then let it expire if they don't say.
  // A question only; the loop may not be stated as current (services/loopLifecycle.ts).
  loop_check: {
    async draft(c, person) {
      const { rows } = await pool.query(`SELECT closed_at, last_confirmed_at FROM open_loops WHERE id = $1 AND user_id = $2`, [c.payload.loopId, c.userId]);
      if (!rows[0] || rows[0].closed_at) return skip("the loop has closed since");
      const text = await draftProactive({
        functionId: "loopLifecycle.check.draft",
        firstName: person.firstName,
        facts: { the_thing_they_asked_about: c.payload.title },
        task: "Ask one short, light question: is this still on their plate, or should you let it go? Don't say when it was mentioned, don't say what happened with it, don't promise anything.",
      });
      return text ? { messages: [text], text, rules: { maxSentences: 2, maxChars: 220 } } : skip("model chose SKIP");
    },
    // Asked means SENT: this starts the 5-day expiry clock (services/loopLifecycle.ts).
    async onSent(c) {
      await pool.query(`UPDATE open_loops SET decay_asked_at = NOW() WHERE id = $1 AND user_id = $2`, [c.payload.loopId, c.userId]);
    },
  },

  // A goal is asked about rarely and seasonally (services/goalJourney.ts): one light question, in their words, never on the 7-day ask
  // clock. Sending it resets the goal's clock, so it comes back in about eight weeks at the earliest.
  goal_checkin: {
    async draft(c, person) {
      const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [c.userId]);
      const still = (Array.isArray(rows[0]?.intent) ? rows[0].intent : []).some((e: any) => e?.id === c.payload.goalId && e?.kind === "goal" && e?.status === "active");
      if (!still) return skip("that goal is not open any more");
      // Its state in what Co knows about them (the dispatch's one read): a goal closed since is history, not a question.
      const known = draftKnowledge();
      if (known) {
        const { goalCheckinState, GOAL_DONE_SKIP } = await import("../services/goalJourney.js");
        if (goalCheckinState(known.goals, String(c.payload.text ?? "")) === "done") return skip(GOAL_DONE_SKIP);
      }
      const text = await draftProactive({
        functionId: "goalJourney.checkin.draft",
        firstName: person.firstName,
        facts: { the_direction_they_named_to_you: c.payload.text },
        task: "Ask one light question about whether this direction still holds, naming it in their own plain words and making it easy to say it has shifted. The shape: \"Still chasing the pre-seed, or has that shifted?\". One sentence, two at most. Say nothing about how long ago it was, no date, no advice, no offer, no pressure.",
      });
      return text ? { messages: [text], text, rules: { maxSentences: 2, maxChars: 200 } } : skip("model chose SKIP");
    },
    async onSent(c) {
      const { markGoalCheckedIn } = await import("../services/goalJourney.js");
      await markGoalCheckedIn(c.userId, c.payload.goalId);
      await writeMemory(c.userId, "check_in", `Asked, as a seasonal check-in, whether this still holds: ${c.payload.text}`);
    },
    // Dropped because the goal is done: marked on the entry so the monthly cron stops re-queuing (and re-dropping) it.
    async onDropped(c, _status, reason) {
      const { GOAL_DONE_SKIP, markGoalCheckinDone } = await import("../services/goalJourney.js");
      if (reason === GOAL_DONE_SKIP) await markGoalCheckinDone(c.userId, String(c.payload.goalId));
    },
  },

  // A goal they closed at their word: a companion moment that acknowledges the arc.
  goal_closed: {
    async draft(c, person) {
      const text = await draftProactive({
        functionId: "goalJourney.closed.draft",
        firstName: person.firstName,
        facts: { the_goal_they_just_closed: c.payload.text, started_in: c.payload.startedIn ?? null, closed_in: c.payload.closedIn ?? null, ...(c.payload.quote ? { their_own_words_about_it: c.payload.quote } : {}) },
        task: "They just told you this goal is done or over. Make it a moment between friends, not a status change: acknowledge the arc in a sentence, using only the months given (\"you were chasing this back in October, and you did it\" when they finished it; gently when they let it go). Warmth, not hype. At most one more short line. No question, no offer, no next step, no advice.",
      });
      return text ? { messages: [text], text, rules: { maxSentences: 3, maxChars: 260 } } : skip("model chose SKIP");
    },
    async onSent(c) {
      await writeMemory(c.userId, "check_in", `Acknowledged a closed goal: ${c.payload.text}`);
    },
  },

  // Member-state nudges (services/memberStateNudges.ts): the state is re-read at draft time, the words come from the facts stored at
  // queue time (the recipient's own record only), and an intro nudge is checked for anything about the other member before it goes.
  intro_nudge: { draft: (c, person) => draftStateNudge(c, person), onSent: (c, _p, messages) => onStateNudgeSent(c, messages), onDropped: (c, status, reason) => onStateNudgeDropped(c, status, reason) },
  deadline_nudge: { draft: (c, person) => draftStateNudge(c, person), onSent: (c, _p, messages) => onStateNudgeSent(c, messages), onDropped: (c, status, reason) => onStateNudgeDropped(c, status, reason) },
  goal_nudge: { draft: (c, person) => draftStateNudge(c, person), onSent: (c, _p, messages) => onStateNudgeSent(c, messages), onDropped: (c, status, reason) => onStateNudgeDropped(c, status, reason) },
  commitment_nudge: { draft: (c, person) => draftStateNudge(c, person), onSent: (c, _p, messages) => onStateNudgeSent(c, messages), onDropped: (c, status, reason) => onStateNudgeDropped(c, status, reason) },

  // The day before a Co event: how many are coming and the two or three worth finding, by name only when they
  // said yes at RSVP, each with a reason from their own stated ask (services/eventBrief.ts).
  event_brief: {
    async draft(c, person) {
      const B = await import("../services/eventBrief.js");
      const { eventMembers } = await import("../services/eventPresence.js");
      const { gateShareReason } = await import("./matchGate.js");
      const { checkDraftFull } = await import("./introConsent.js");
      const { privateFactLeak } = await import("../services/coFacts.js");
      const p = c.payload;
      const f = await B.presenceFlags(p.eventId, c.userId);
      if (f.briefSent || f.notGoing) return skip("already sent, or not going");
      const fetched = await eventMembers(p.eventId).catch(() => null);
      // A guest-list outage is not "no longer registered": try again shortly instead of dropping their brief for good.
      if (!fetched) return { defer: new Date(Date.now() + 30 * 60_000), reason: "couldn't read the guest list just now" };
      const members = fetched;
      if (!members.some((m) => m.user_id === c.userId)) return skip("no longer registered");
      const others = members.filter((m) => m.user_id !== c.userId);
      const [flags, ranked] = await Promise.all([B.namedYes(p.eventId, others.map((m) => m.user_id)), B.rankingFor(p.eventId, c.userId)]);
      // Their asks that are open and shareable right now: a stored reason that isn't one of them is never named.
      const { shareableAsks } = await import("../services/matching.js");
      const { rows: profs } = await pool.query(`SELECT user_id, intent FROM co_profiles WHERE user_id = ANY($1::uuid[])`, [others.map((m) => m.user_id)]);
      const stillShareable = new Map<string, string[]>(profs.map((r: any) => [String(r.user_id), shareableAsks(r.intent).map((a) => String(a.text))]));
      const chosen = B.pickNamed({ ranked, recipientId: c.userId, members: others, nameOk: flags.yes, notGoing: flags.notGoing, stillShareable });
      // The same privacy check the in-room nudge uses, per person named: a reason that fails it is dropped, and the person with it.
      const picks: typeof chosen.picks = [];
      let unnamedFits = chosen.unnamedFits;
      for (const pk of chosen.picks) {
        if (await gateShareReason(c.userId, pk.id, pk.reason, "event_brief")) picks.push(pk);
        else unnamedFits++;
      }
      if (!B.worthSending(picks, unnamedFits)) return skip("nobody to name and too few fit: the pre-arrival text covers it");
      const allowed = new Set(picks.map((x) => x.id));
      const zone = p.timezone ?? null;
      const { DateTime } = await import("luxon");
      const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
      const start = DateTime.fromISO(p.startAt, { zone: z });
      const when = `${start.hasSame(DateTime.now().setZone(z), "day") ? "today" : "tomorrow"} at ${start.toFormat("h:mm a")}`;
      const guestFacts = picks.map((x) => `${x.firstName}: ${x.reason}`).join(" | ");
      // The brief is goals as FRAME, asks as BULLETS (services/goalJourney.ts): where they say they are headed frames the room in one line
      // (never recited), and the bullets carry the specific reasons, which come from asks.
      const lens = await pool.query(`SELECT intent, goals FROM co_profiles WHERE user_id = $1`, [c.userId]).then(async (r) => {
        const g = await import("../services/goalJourney.js");
        const { latestAskEntry } = await import("./profileWrite.js");
        return { goals: g.goalTexts(r.rows[0]?.intent, r.rows[0]?.goals).slice(0, 4), ask: latestAskEntry(r.rows[0]?.intent)?.text ?? null };
      }).catch(() => ({ goals: [] as string[], ask: null as string | null }));
      // Goals with state from what Co knows about them (the dispatch's one read): only an active goal frames the room; one they
      // closed or set aside is history, never where they're headed.
      const known = draftKnowledge();
      if (known?.goals.length) lens.goals =known.goals.filter((g) => g.state === "active").map((g) => g.text).slice(0, 4);
      const run = async (feedback: string | null) =>
        draftProactive({
          functionId: "agent.eventBrief",
          firstName: person.firstName,
          model: MODELS.sonnet,
          maxSentences: 6,
          facts: {
            event: p.name,
            when,
            the_event_date: (await import("../services/preArrival.js")).localDate(p.startAt, p.timezone ?? null),
            ...(p.venue ? { venue: p.venue } : {}),
            members_confirmed: `${members.length}`,
            ...(lens.goals.length ? { where_they_say_they_are_headed_the_frame_only: lens.goals.join("; ") } : {}),
            ...(lens.ask ? { what_they_asked_for_now: lens.ask } : {}),
            ...(picks.length ? { people_to_find_each_said_yes_to_being_named: guestFacts } : {}),
            ...(unnamedFits >= B.BRIEF.minCountToMention ? { others_who_fit_their_ask_no_names: `${unnamedFits} (a count only: never describe or name them)` } : {}),
          },
          task: `${when.startsWith("today") ? "It's today" : "The day before"}: they're going to ${p.name}. Write the member brief in 3 to 4 short paragraphs separated by a blank line, each one a message bubble. First: how many members are confirmed and when it starts. ${picks.length ? `Then, for each person in people_to_find (name, then why in one line, using only the words given after their name as what they're looking for; say it as what that person is looking for, in your own words, never with "said", "told" or "wants to meet", and never that they want to meet the reader). ` : ""}${unnamedFits >= B.BRIEF.minCountToMention ? "Then one line that a few more who fit what they're after will be there, without saying who or what they do. " : ""}${lens.goals.length ? "Frame the room in one line against where they are headed (where_they_say_they_are_headed_the_frame_only), in your own words, without reciting it or quoting it back; the people then follow as short lines, each with its specific reason. " : ""}Warm and brief, no sign-off. Never name anyone not listed, never promise an introduction, never give a phone number or email.${feedback ? ` Your last draft was rejected: ${feedback}. Fix that.` : ""}`,
        });
      const verify = async (text: string): Promise<string | null> => {
        const outsider = B.namesOutsiders(text, members, allowed, c.userId);
        if (outsider) return `it names ${outsider}, who didn't say yes to being named`;
        if (B.briefBubbles(text).length > B.BRIEF.maxBubbles) return `too many bubbles (max ${B.BRIEF.maxBubbles})`;
        for (const pk of picks) {
          const r = await checkDraftFull(text, { otherFirstName: pk.firstName, otherOptedIn: false, recipientOptedIn: false, recipientFirstName: person.firstName, otherStatedAsks: [pk.reason] });
          if (!r.ok) return r.checks.filter((k) => !k.pass).map((k) => k.reason).join("; ") || "breaks the consent rules";
          const leak = await privateFactLeak(text, pk.id).catch(() => null);
          if (leak) return `carries something only ${pk.firstName} may see`;
        }
        return null;
      };
      let text = await run(null);
      if (!text) return skip("model chose SKIP");
      let why = await verify(text);
      if (why) {
        const again = await run(why);
        const whyAgain = again ? await verify(again) : "no redraft";
        if (!again || whyAgain) return skip(`brief broke a rule after one redraft (${whyAgain ?? why})`);
        text = again;
      }
      const messages = B.briefBubbles(text);
      c.payload.namedIds = picks.map((x) => x.id);
      c.payload.confirmed = members.length;
      return { messages, text, rules: { maxSentences: 7, maxChars: 760, mustIncludeAny: nameTokens(p.name).length ? nameTokens(p.name) : [p.name] } };
    },
    async onSent(c) {
      const B = await import("../services/eventBrief.js");
      await B.recordBriefSent(c.payload.eventId, c.userId, Array.isArray(c.payload.namedIds) ? c.payload.namedIds : [], Number(c.payload.confirmed) || 0);
      await writeMemory(c.userId, "event_brief", `Sent them the member brief for "${c.payload.name}"`);
    },
  },

  debrief: {
    async draft(c, person) {
      return draftDebrief(c, person.firstName);
    },
    async onSent(c, _person, messages) {
      const p = c.payload as DebriefPayload;
      // What the follow-up is about, so Co's next replies can see the
      // original send even when it's older than its recent-sends list
      // (harness/replyGrounding.ts reads followup_context).
      const sent = p.outcomeFollowupIds?.length ? await whatCoSent(c.userId, p.outcomeFollowupIds).catch(() => null) : null;
      if (sent) {
        await writeMemory(c.userId, "followup_context", `Co's follow-up asked about "${p.eventName}", which Co sent them on ${sent.date}${sent.caption ? `: "${sent.caption}"` : ""}.`).catch(() => {});
      }
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
    async onSent(c, _p, messages) {
      await markPostCallSent(c.payload.followUpId);
      await recordRecapOffer(c.userId, c.payload.followUpId, messages ?? []).catch(() => false);
    },
    async onDropped(c, status) {
      await markPostCallDropped(c.payload.followUpId, status);
    },
  },

  // Human-written bullets go out verbatim; only the intro/closing lines are
  // model-drafted, and those are what the output checks run on.
  // Fixed wording, not a draft: it names the date their membership closes,
  // which has to be exactly right (services/membershipLapse.ts).
  membership_lapse: {
    async draft(c, person) {
      const final = Boolean(c.payload.final);
      const zone = await memberZone(c.userId);
      const close = await lapseCloseDate(c.userId, final, zone);
      if (!close) return skip("the lapse clock stopped");
      const message = lapseText(person.firstName, close.label, final);
      return { messages: [message], text: message, rules: { maxChars: 260, maxSentences: 3, allowGreeting: true, mustIncludeAny: [close.label] } };
    },
    async onSent(c, _p, messages) {
      if (c.payload.final) {
        // The date the final notice named is the date that holds.
        await pool.query(
          `UPDATE users SET lapse_close_at = GREATEST(lapse_close_at, NOW() + INTERVAL '7 days') WHERE id = $1 AND lapse_started_at IS NOT NULL`,
          [c.userId],
        );
      }
      await writeMemory(c.userId, "check_in", `Membership notice: ${messages.join(" ")}`);
    },
  },

  product_update: {
    async draft(c, person) {
      const { intro, closing, bulletList } = c.payload as { intro: string; closing: string; bulletList: string };
      const message = `Hey ${person.firstName}, ${intro}\n\n${bulletList}\n\n${closing}`;
      return { messages: [message], text: `${intro} ${closing}`, rules: { maxChars: 400, allowGreeting: true } };
    },
  },

  // Match nudge for a pair with no real event timing to be "in-room" for
  // (eventMatching.ts's self-reported/recommended-event path — code review,
  // 2026-09-17: this used to send immediately via raw sendblue, bypassing
  // local hours, the daily/weekly caps, and opt-out). The message was
  // already drafted and consent-checked at enqueue time (eventScoring.ts's
  // maybeSendMatchNudge), since that check needs live facts about the
  // candidate's own opt-in status right then; here it's just handed to the
  // harness's normal checks (hours, caps, opt-out) and output format rules.
  event_match_nudge: {
    async draft(c) {
      const p = c.payload as EventMatchNudgePayload;
      return { messages: [p.message], text: p.message, rules: p.rules };
    },
    async onSent(c) {
      const p = c.payload as EventMatchNudgePayload;
      await markMatchNudgeSent(p.eventId, c.userId, p.candidateId, p.score, !!p.anonymous);
      await writeMemory(
        c.userId,
        "event_guest_match_nudge",
        // This note is read back into their replies, so an anonymous
        // heads-up must not carry the other person's name.
        p.anonymous
          ? `Told them another member who's also going to the same thing could be worth meeting, without saying who, and asked if they'd like an intro (score ${p.score})`
          : `Nudged them that ${p.candidateFirstName} is also going to the same thing and worth meeting (score ${p.score})`,
      );
    },
  },
};
