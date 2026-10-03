// Per-type drafting and follow-through for the Layer 7 proactive harness
// (src/harness/proactive.ts). Each type says how to draft its text (always
// under PROACTIVE_RULES + CONFIRMED_FACTS, with code-checked output rules)
// and what to record once it actually went out, or was dropped.
import pool from "../db/db.js";
import { writeMemory } from "../services/memory.js";
import { draftProactive, nameTokens, nextLocalHour, type Candidate, type DraftResult, type ProactiveRegistry } from "./proactive.js";
import { draftEventReveal } from "../agent/eventDiscoverySurfacing.js";
import { draftAskCheckin, type AskCheckinPayload } from "../agent/askCheckin.js";
import { draftCompanionCheckin } from "../agent/companionCheckin.js";
import { draftWindowFollowUp, type WindowFollowUpPayload } from "../agent/windowFollowUp.js";
import { draftCalendarFollow } from "../agent/calendarFollowReachOut.js";
import { draftAskSolicitation } from "../agent/eventAskSolicitation.js";
import { draftPostCall, markPostCallDropped, markPostCallSent } from "../jobs/postCallFollowUp.js";
import { askStillOpen, isShortNotice, onEventOfferDropped, onEventOfferSent, type EventOfferPayload } from "../services/eventSurfacingSweep.js";
import { endOfLocalDay, followUpDate, type DebriefPayload } from "../services/recommendationOutcome.js";
import { itemDays, localToday, offerable, readDates } from "../services/dateGuard.js";
import { markMatchNudgeSent, type EventMatchNudgePayload } from "../services/eventScoring.js";
import { lapseCloseDate, lapseText } from "../services/membershipLapse.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { prepareReveal } from "../services/networkIntroNudge.js";

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
  const { rows: prof } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [c.userId]).catch(() => ({ rows: [] as any[] }));
  const tz = prof[0]?.city ? await getTimezoneForCity(prof[0].city).catch(() => null) : null;
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
  return draftDebriefText(firstName, p, people, sent, date);
}

export async function draftDebriefText(firstName: string, p: DebriefPayload, people: string[], sent: SentRecord | null = null, date: string | null = null): Promise<DraftResult> {
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
    task: isOpportunity
      ? `Ask if they got a chance to look into or apply to "${p.eventName}" (a real opportunity Co pointed them to on the date above, not an event) — did anything come of it. If what Co said about it shows it's still ahead of today, SKIP. One text, not a survey.`
      : `Ask how "${p.eventName}" was, naming the event.${people.length ? ` Name one of the people Co pointed them to and ask if they ended up talking.` : " Ask who they met or what stood out."}${walkin ? " Then offer, in the same text, to find time for a call this week so you can get to know them and point them to better people next time." : ""} One text, not a survey.`,
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
      // Their ask closed since this was queued: don't send it (2026-09-26).
      if (!(await askStillOpen(p.askId))) return skip("their ask has since closed");
      // Still ahead today, checked when it's about to go out, not only when
      // it was queued (services/dateGuard.ts).
      const when = offerable(readDates(itemDays(p.match), localToday()));
      if (!when.ok) return skip(`not offered: ${when.why}`);
      // How this ties to the rest of what they've said (services/connectDots.ts).
      const { gatherDots, findDots, whyContext } = await import("../services/connectDots.js");
      const known = await gatherDots(c.userId);
      const dots = p.reminder ? [] : await findDots({ ...known, now: `Co is about to offer them: ${p.match.name}${"description" in p.match && p.match.description ? `, ${String(p.match.description).slice(0, 300)}` : ""} (it came up for their ask: "${p.askText}")` });
      const r = await draftEventReveal(person, p.askText, p.fromProfile, p.match, { reminder: p.reminder, again: p.again, dots: dots.map((d) => d.link), why: whyContext(known) });
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
      if ("why" in prepared) return skip(`no tease: ${prepared.why}`);
      c.payload.preparedReveal = prepared.message;
      return { messages: [text], text, rules: { maxSentences: 2, maxChars: 200, mustNotInclude: [candidate.first_name] } };
    },
    async onSent(c) {
      const { askId, candidate, preparedReveal } = c.payload;
      await removeNetworkBacklogItem(c.userId, askId, candidate.candidate_id);
      await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_offer_pending', $2)`, [
        c.userId,
        JSON.stringify({ askId, candidate, ...(preparedReveal ? { reveal: preparedReveal } : {}) }),
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
      const r = await draftCompanionCheckin(person.firstName, c.payload.recap ?? "", c.payload.thread ?? null, c.payload.item ?? null, c.payload.curious ?? null, c.payload.story ?? null, c.payload.advice ?? null);
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
    async onSent(c) {
      await markPostCallSent(c.payload.followUpId);
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
      const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [c.userId]);
      const zone = rows[0]?.city ? await getTimezoneForCity(rows[0].city).catch(() => null) : null;
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
