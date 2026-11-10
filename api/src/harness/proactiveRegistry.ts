import { DateTime } from "luxon";
// Per-type drafting and follow-through for the Layer 7 proactive harness
// (src/harness/proactive.ts). Each type says how to draft its text (always
// under PROACTIVE_RULES + CONFIRMED_FACTS, with code-checked output rules)
// and what to record once it actually went out, or was dropped.
import { isStated } from "../services/provenance.js";
import { followUpEvidence, PRESUMES_THEY_WENT } from "../services/followUpEvidence.js";
import pool from "../db/db.js";
import { notToTeammate } from "../services/teamLines.js";
import { writeMemory } from "../services/memory.js";
import { MODELS } from "../models.js";
import { draftKnowledge, draftProactive, nameTokens, nextLocalHour, type Candidate, type DraftResult, type Person, type ProactiveRegistry, type TypeSpec } from "./proactive.js";
import type { DoorPayload } from "./door.js";
import { SUBJECT_CLOSED } from "./closedSubject.js";
import { draftEventReveal } from "../agent/eventDiscoverySurfacing.js";
import { draftAskCheckin, recentAskCheckins, type AskCheckinPayload } from "../agent/askCheckin.js";
import { draftCompanionCheckin } from "../agent/companionCheckin.js";
import { solicitationGoals } from "../agent/eventAskSolicitation.js";
import { draftWindowFollowUp, type WindowFollowUpPayload } from "../agent/windowFollowUp.js";
import { draftCalendarFollow } from "../agent/calendarFollowReachOut.js";
import { draftAskSolicitation } from "../agent/eventAskSolicitation.js";
import { draftPostCall, isHeldRecap, markCarriedCorrections, markPostCallDropped, markPostCallSent, POST_CALL_SKIP } from "../jobs/postCallFollowUp.js";
import { askStillOpen, isShortNotice, onEventOfferDropped, onEventOfferSent, type EventOfferPayload } from "../services/eventSurfacingSweep.js";
import { endOfLocalDay, followUpDate, type DebriefPayload } from "../services/recommendationOutcome.js";
import { itemDays, localToday, offerable, readDates } from "../services/dateGuard.js";
import { markMatchNudgeSent, type EventMatchNudgePayload } from "../services/eventScoring.js";
import { memberZone } from "../services/memberTime.js";
import { prepareReveal, recordTease } from "../services/networkIntroNudge.js";
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

// People Co pointed them to at this event, only from recorded nudges. A yes they gave by naming someone themselves
// (requestEventIntro, co_pairs origin 'member') isn't Cue pointing them anywhere, and it exists only when that person was found:
// named in the debrief, it told them so. Left out until the intro email went (2026-10-28, Royce: "found/not-found results
// shouldn't leak through later memory or replies").
export const PEOPLE_POINTED_TO_SQL = `SELECT DISTINCT u.id, u.first_name FROM event_guest_match_nudges n JOIN users u ON u.id = n.candidate_id
     WHERE n.event_id = $1 AND n.person_id = $2 AND u.first_name <> ''
     UNION
     SELECT DISTINCT u.id, u.first_name FROM event_guest_match_opt_ins o JOIN users u ON u.id = o.candidate_id
     WHERE o.event_id = $1 AND o.person_id = $2 AND o.status = 'interested' AND u.first_name <> ''
       AND NOT EXISTS (SELECT 1 FROM co_pairs p WHERE p.event_id = o.event_id AND p.a_id = LEAST(o.person_id, o.candidate_id)
         AND p.b_id = GREATEST(o.person_id, o.candidate_id) AND p.origin = 'member' AND p.intro_sent_at IS NULL)`;
// Pure: the people still worth asking about, and the ones they already told Cue about (their own side of that night's pair says, in
// their words, whether they met or how it went: noteRoomMeeting on a text, the call's read). An already-told person is never asked
// again (2026-11-03: "met Ellis, great talk" at 10pm, then "did you and Ellis end up talking?" the next morning). Inferred evidence
// doesn't count; the other side's never does. told carries what they said, theirs only, so the debrief never asks "who did you meet?"
// about someone they already named (review of #376).
export type PointedPeople = { ask: string[]; told: { name: string; what: string }[] };
const TOLD_WORDS: Record<string, string> = { "met:yes": "they met", "met:no": "they didn't meet", "useful:yes": "it was worth it", "useful:somewhat": "it was fine", "useful:no": "it wasn't a fit" };
export function stillToAsk(people: { id: string; first_name: string }[], pairs: { a_id: string; b_id: string; a_evidence?: any; b_evidence?: any }[], userId: string): PointedPeople {
  const told = new Map<string, string>();
  for (const r of pairs) {
    const mine = r.a_id === userId ? r.a_evidence : r.b_id === userId ? r.b_evidence : null;
    const said = [mine?.met?.how === "stated" ? TOLD_WORDS[`met:${mine.met.value}`] : null, mine?.useful?.how === "stated" ? TOLD_WORDS[`useful:${mine.useful.value}`] : null].filter(Boolean);
    if (said.length) told.set(String(r.a_id === userId ? r.b_id : r.a_id), [...new Set(said)].join(", "));
  }
  const ask = [...new Set(people.filter((p) => !told.has(String(p.id))).map((p) => p.first_name))];
  const toldList = people.filter((p) => told.has(String(p.id))).map((p) => ({ name: p.first_name, what: told.get(String(p.id))! }));
  return { ask, told: toldList.filter((t, i) => toldList.findIndex((x) => x.name === t.name) === i) };
}
export async function peopleCoPointedTo(userId: string, eventApiId: string | null): Promise<PointedPeople> {
  if (!eventApiId) return { ask: [], told: [] };
  const { rows } = await pool.query(PEOPLE_POINTED_TO_SQL, [eventApiId, userId]);
  if (!rows.length) return { ask: [], told: [] };
  // A pair read that fails asks about nobody by name (the debrief then asks who they met), never someone they may have answered.
  const pairs = await pool
    .query(`SELECT a_id, b_id, a_evidence, b_evidence FROM co_pairs WHERE event_id = $1 AND (a_id = $2 OR b_id = $2)`, [eventApiId, userId])
    .then((r) => r.rows)
    .catch(() => null);
  if (!pairs) return { ask: [], told: [] };
  return stillToAsk(rows.map((r: any) => ({ id: String(r.id), first_name: r.first_name })), pairs, userId);
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

// The follow-up won't go: its source rows are dropped, with why (the harness records the skip itself).
async function dropDebriefSources(p: DebriefPayload, reason: string): Promise<void> {
  const why = reason.slice(0, 200);
  if (p.outcomeFollowupIds?.length) await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped', drop_reason = $2 WHERE id = ANY($1::uuid[])`, [p.outcomeFollowupIds, why]).catch(() => {});
  if (p.checkinFollowupIds?.length) await pool.query(`UPDATE event_checkin_followups SET harness_status = 'dropped', drop_reason = $2 WHERE id = ANY($1::uuid[])`, [p.checkinFollowupIds, why]).catch(() => {});
}

// The longest a debrief waits on whether they made it, from when it was first queued.
export const DEBRIEF_WAIT_MAX_HOURS = 72;
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
  // What the record supports (Royce, 2026-11-04, permanent: never assume a member went). Attended: a Luma door scan at Noise's own
  // event, an arrival Cue saw, a walk-in, or their stated word that they went. Intent: they said they're going, or registered. Nothing
  // else earns a follow-up, and a "no" drops it. Read now, so a reaction or a scan after it was queued counts.
  let came = false;
  let doorMissed = false;
  if (p.eventApiId) {
    // A Noise event they didn't make it to: the no-show flow covers the night (services/eventCheckinFollowUp.ts debriefForEvent).
    const CF = await import("../services/eventCheckinFollowUp.js");
    const said = await CF.debriefForEvent(c.userId, p.eventApiId);
    const door = said === "send" ? await CF.doorStanding(c.userId, p.eventApiId) : null;
    const settle = said === "send" && door ? (door.say === "wait" ? "wait" : "send") : said;
    // A wait never outlives the debrief's first 3 days: each defer moves the candidate's expiry on, so the bound is its age (review
    // of #275). Still unknown then (the night never settled, the door never read): nothing is sent on a guess.
    if (settle === "skip") return skip("they didn't make it: the no-show flow covers that night");
    if (settle === "wait") {
      if (Date.now() - c.createdAt.getTime() > DEBRIEF_WAIT_MAX_HOURS * 3_600_000) return skip("whether they made it never settled");
      return { defer: new Date(Date.now() + 2 * 3_600_000), reason: "whether they made it isn't settled yet" };
    }
    came = !!door?.came;
    // Registered at a door Luma tracked that night, never scanned: the no-show flow owns them (its ask, then its note), not a debrief,
    // unless their own stated word that they went says otherwise (decided below, once the evidence is read).
    doorMissed = !!(door && !door.came && door.tracked && !(p.walkinCheckinIds ?? []).length);
  }
  const keys = await debriefItemKeys(p);
  // A stated "went" counts only if it was said after this event started (or, with no date, after this find was sent): an old "I went"
  // to a same-name event (a recurring dinner) is not evidence they went to this one.
  const startedAt = date ? DateTime.fromISO(date, { zone: tz ?? "America/Los_Angeles" }).startOf("day").toJSDate() : new Date(c.createdAt.getTime() - 3 * 86_400_000);
  const rows = await pool
    .query(`SELECT item_key, result, provenance, created_at FROM suggestion_outcomes WHERE user_id = $1 AND item_key = ANY($2::text[])`, [c.userId, keys])
    .then((r) => (r.rows as { item_key: string; result: string; provenance: string | null; created_at?: Date | string }[]).filter((x) => !((x.result === "helped" || x.result === "didnt_help") && x.created_at && new Date(x.created_at) < startedAt)))
    .catch(() => []);
  const reactions = await pool
    .query(`SELECT reaction FROM revealed_offers WHERE user_id = $1 AND item_key = ANY($2::text[]) AND reaction IS NOT NULL`, [c.userId, keys])
    .then((r) => r.rows.map((x: any) => String(x.reaction)))
    .catch(() => [] as string[]);
  const evidence = followUpEvidence({ rows, reactions, came, walkin: (p.walkinCheckinIds ?? []).length > 0, registered: (p.checkinFollowupIds ?? []).length > 0 });
  if (doorMissed && evidence.level !== "attended") return skip("the door was tracked and they weren't scanned: the no-show flow covers that night");
  // Their stated word is the only evidence, and the debrief is only about a recommendation: they already told Cue how it went, so a
  // debrief would re-ask it (settleFollowUpForResult closes the row when they say it; this covers one queued before they did).
  if (evidence.level === "attended" && !came && !(p.walkinCheckinIds ?? []).length && !(p.checkinFollowupIds ?? []).length) return skip("they already told Cue how it went");
  if (evidence.level === "none") {
    await dropDebriefSources(p, evidence.declined ? `declined: ${evidence.why}` : evidence.why);
    return skip(evidence.declined ? "they said it isn't for them: no follow-up" : "no sign they went or meant to go: no follow-up");
  }
  // A follow-up on something Co sent needs a record that Co sent it.
  const sent = p.outcomeFollowupIds?.length ? await whatCoSent(c.userId, p.outcomeFollowupIds) : null;
  const onlyAboutASend = (!p.eventApiId || p.form === "opening") && !(p.checkinFollowupIds ?? []).length && !(p.walkinCheckinIds ?? []).length;
  if (onlyAboutASend && !sent) return skip("no record of Cue sending it to them");
  const pointed = await peopleCoPointedTo(c.userId, p.eventApiId);
  // They already told Cue how it went with everyone Cue pointed them to, and the debrief carries nothing else (no walk-in call offer,
  // no recommendation follow-up): nothing is left to ask (review of #376).
  if (pointed.told.length && !pointed.ask.length && !(p.walkinCheckinIds ?? []).length && !(p.outcomeFollowupIds ?? []).length) return skip("they already told Cue how it went with everyone Cue pointed them to");
  const people = pointed.ask;
  // Did they go? Only a door scan, an arrival, a check-in, a walk-in, or their own stated word that they went (Royce, 2026-10-09:
  // "How was the Claude Founder Salon?" went to someone Co had only recommended it to; 2026-10-12 review: word matching read "going
  // to practice my pitch before the launch" as having gone). Otherwise the debrief asks whether they made it.
  return draftDebriefText(firstName, p, people, sent, date, evidence.level === "attended", pointed.told);
}

// The outcome keys one debrief is about: the event's own key, each recommendation it follows up (its event or name key, and the
// "followup:<id>" key its answer is stored under), and its name.
async function debriefItemKeys(p: DebriefPayload): Promise<string[]> {
  // With an event id, the name is never a key: a same-name event (a recurring dinner) is another event.
  const keys = new Set<string>(p.eventApiId ? [`event:${p.eventApiId}`] : [`name:${p.eventName.toLowerCase()}`]);
  if (p.outcomeFollowupIds?.length) {
    const { rows } = await pool.query(`SELECT id, match FROM recommendation_outcome_followups WHERE id = ANY($1::uuid[])`, [p.outcomeFollowupIds]).catch(() => ({ rows: [] as any[] }));
    for (const r of rows) {
      keys.add(`followup:${r.id}`);
      if (r.match?.event_api_id) keys.add(`event:${r.match.event_api_id}`);
      if (r.match?.name && !p.eventApiId && !r.match?.event_api_id) keys.add(`name:${String(r.match.name).toLowerCase()}`);
    }
  }
  return [...keys];
}

// Pure: whether the record says they went: a walk-in, a door scan or arrival Cue saw (came), or their own stated word that they went
// and how it was (a stated helped / didn't help). A stated "going" is a plan, not having gone: it gets the question, never "how was it"
// (services/provenance.ts). Being on the guest list (a check-in follow-up row) is registering, not going: since 2026-11-04 it never
// counts (it was the 9-07 fallback, "registered + event ended"). Rows are already scoped to this debrief's item keys.
export function wentOnRecord(p: Pick<DebriefPayload, "walkinCheckinIds"> & { checkinFollowupIds?: string[] }, rows: { result: string; provenance?: string | null }[], came = false): boolean {
  if (came || (p.walkinCheckinIds ?? []).length) return true;
  return rows.some((r) => (r.result === "helped" || r.result === "didnt_help") && isStated(r.provenance));
}

// No longer read by the debrief (wentOnRecord above, 2026-10-12): word matching never decides they went. Kept only because layer 1
// (evals/proactive/restraint126.ts) still exercises it; removing it needs that eval changed.
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
// Moved to services/followUpEvidence.ts (the text-side drafters outside this file use it too); re-exported for its callers.
export { PRESUMES_THEY_WENT };

export async function draftDebriefText(firstName: string, p: DebriefPayload, people: string[], sent: SentRecord | null = null, date: string | null = null, went = false, told: { name: string; what: string }[] = []): Promise<DraftResult> {
  const walkin = (p.walkinCheckinIds ?? []).length > 0;
  // A Tier 3 opportunity (accelerator, investor, mentor — see
  // tieredRecommendation.ts's category) has no eventApiId (it's not a real
  // Luma event) and never comes with check-in/walk-in data (those only
  // exist for a physical event). "Who did you meet there?" doesn't apply —
  // ask whether they actually did anything with it instead (2026-09-17,
  // closing the loop on outcomes for Tier 3).
  // Decided by what the find is (services/findForm.ts), not by whether it has an event id: a listing or program on an event platform
  // has one too and used to get the event's "how was X" (2026-11-04). Payloads from before carry no form and read as they did.
  const isOpportunity = p.form ? p.form === "opening" : !p.eventApiId && !walkin && (p.checkinFollowupIds ?? []).length === 0;
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
      ...(told.length ? { they_already_told_cue_how_it_went_with: told.map((t) => `${t.name}: ${t.what}`).join("; ") } : {}),
      what_they_were_looking_for: p.askText,
      they_checked_in_at_the_door: walkin ? "yes, and Cue doesn't know them well yet" : null,
    },
    task: !went && !isOpportunity
      ? `Cue only suggested "${p.eventName}" to them; nothing says they went. Ask, lightly, whether they ended up making it, naming it. Never assume they went: no "how was it", no "who did you meet". One easy question, no pressure either way.`
      : isOpportunity
      ? `Ask if they got a chance to look into or apply to "${p.eventName}" (an opening Cue pointed them to on the date above, not an event) — did anything come of it. If what Cue said about it shows it's still ahead of today, SKIP. One text, not a survey.`
      : `Ask how "${p.eventName}" was, naming the event.${people.length ? ` Name one of the people Cue pointed them to and ask if they ended up talking.` : told.length ? " They already told you how it went with the people in they_already_told_cue_how_it_went_with: never ask about them again or ask who they met; ask only what else stood out." : " Ask who they met or what stood out."}${walkin ? " Then offer, in the same text, to find time for a call this week so you can get to know them and point them to better people next time." : ""} One text, not a survey.`,
  });
  if (!text) return skip("model chose SKIP");
  // Code backstop: an unconfirmed debrief never takes for granted that they went.
  // An opening (a listing, program, job) never gets "how was it" either, whatever the record says.
  if ((!went || isOpportunity) && PRESUMES_THEY_WENT.test(text)) return skip("it assumes they went, and nothing says they did");
  return {
    messages: [text],
    text,
    rules: { maxSentences: walkin ? 3 : 2, maxChars: walkin ? 320 : 240, mustIncludeAny: nameTokens(p.eventName).length ? nameTokens(p.eventName) : [p.eventName] },
  };
}

// One offer, made ready to say at send time (Phase C: the bundle composer and the single reveal both use it). Their ask still open, its
// dates still ahead in their zone (services/dateGuard.ts), and how it ties to the rest of what they've said (services/connectDots.ts).
// skip with exited/held: its page re-read settled it (Phase B, services/sendCheck.ts): its fact is written (exited) or it's held for
// the daily re-reads (held); the caller archives the row. defer: anything uncertain, read again later.
export type PreparedOffer = { skip: string; exited?: boolean; held?: boolean } | { defer: Date; reason: string } | { dots: string[]; why: string; item: import("../agent/eventDiscoverySurfacing.js").RevealItem };
export async function prepareOffer(c: Candidate, person: Person): Promise<PreparedOffer> {
  const p = c.payload as EventOfferPayload;
  // Their ask closed since this was queued: don't send it (2026-09-26).
  if (!(await askStillOpen(p.askId))) return { skip: "their ask has since closed" };
  // Its own page, read again now (Phase B, services/sendCheck.ts): sold out, gone or past exits on its fact; the rest is said from the
  // refreshed record (p.match), never the one captured days ago.
  const fresh = await (await import("../services/sendCheck.js")).checkBeforeSend(c, person.timezone);
  if (!("ok" in fresh)) return fresh;
  const when = offerable(readDates(itemDays(p.match, person.timezone), localToday(person.timezone)));
  if (!when.ok) return { skip: (await import("../services/guardDrops.js")).dateDropped(c.userId, "proactive.offer", `not offered: ${when.why}`) };
  const { gatherDots, findDots, whyContext } = await import("../services/connectDots.js");
  const known = await gatherDots(c.userId);
  const dots = p.reminder ? [] : (await findDots({ ...known, now: `Cue is about to offer them: ${p.match.name}${"description" in p.match && p.match.description ? `, ${String(p.match.description).slice(0, 300)}` : ""} (${p.fromProfile ? `Cue noticed it for them from where they're headed, not an ask: ${p.askText}` : `it came up for their ask: "${p.askText}"`})` })).map((d) => d.link);
  const why = whyContext(known);
  const { revealItem } = await import("../agent/eventDiscoverySurfacing.js");
  return { dots, why, item: revealItem(p.askText, p.fromProfile, p.match, { dots, why }) };
}

// A text waiting at the door (harness/door.ts): written and checked by the path that made it, sent as written by the pick. What it
// means for the record runs once it went (its after step, a task's sent links), or, when it never goes, the after step hears so and
// the task gets a note: never silent.
// While matching is paused an intro ask waits (it moves out by DOOR_PAUSE_RETRY_MINUTES, never dropped, so the asker is never told it
// failed); a pair that no longer stands (both said yes meanwhile, declined, introduced) is dropped, as the direct send did.
export const DOOR_PAUSE_RETRY_MINUTES = 30;
async function doorStillStands(c: Candidate, now: Date = new Date()): Promise<{ skip: string } | { defer: Date; reason: string } | null> {
  const after = (c.payload as DoorPayload).after;
  if (after?.kind === "network_intro_ask") {
    const p = after.payload as { candidateId?: string; askerId?: string };
    if (await (await import("../services/roomMatching.js")).matchingPause(null)) return { defer: new Date(now.getTime() + DOOR_PAUSE_RETRY_MINUTES * 60_000), reason: "matching is paused: the intro ask waits" };
    const NI = await import("../services/networkIntroNudge.js");
    const stale = await NI.networkAskStale(String(p.candidateId ?? ""), String(p.askerId ?? ""));
    if (stale) return { skip: `the intro ask no longer stands: ${stale}` };
  }
  return null;
}
export const DOOR_DROPPED_NOTE = "The text queued for them never went, so they were never told";
const doorEntry: TypeSpec = {
  async draft(c) {
    const p = (c.payload ?? {}) as DoorPayload;
    const messages = Array.isArray(p.messages) ? p.messages.filter((m) => typeof m === "string" && m.trim()) : [];
    if (p.door !== true || !messages.length) return skip("nothing written to send");
    const stands = await doorStillStands(c);
    if (stands) return stands;
    return { messages, text: messages.filter((m) => !/^https?:\/\/\S+$/.test(m.trim())).join("\n"), rules: {} };
  },
  // Only now is it texted: the task's count and last-texted time move when it went, never when it was queued (review of #361).
  async onSent(c, _person, delivered) {
    const p = (c.payload ?? {}) as DoorPayload;
    const D = await import("../services/deferredSends.js");
    if (p.after) await D.runAfter(p.after as import("../services/deferredSends.js").AfterSend, "sent");
    if (p.taskId != null) {
      const T = await import("../services/coTasks.js");
      await T.markTextedAt(c.userId, Number(p.taskId), p.awaitingReply ?? true).catch(() => {});
      const urls = delivered.filter((m) => /^https?:\/\/\S+$/.test(m.trim()));
      if (urls.length) {
        const { recordSentItems } = await import("../services/coFacts.js");
        await recordSentItems(c.userId, urls.map((url) => ({ name: url, url })), "taskTurn").catch(() => {});
      }
      if (p.close) await T.closeTask(c.userId, Number(p.taskId), p.close.status, p.close.outcome).catch(() => false);
    }
  },
  // Never silent: the after step hears it never went, and the task gets the note even when it's already closed, so nothing that reads
  // the task later says it was delivered. A task kept open for this line closes as not told.
  async onDropped(c, status, reason) {
    const p = (c.payload ?? {}) as DoorPayload;
    const D = await import("../services/deferredSends.js");
    if (p.after) await D.runAfter(p.after as import("../services/deferredSends.js").AfterSend, "skipped", undefined, reason ?? status);
    if (p.taskId != null) {
      const T = await import("../services/coTasks.js");
      // Dropped because what it served closed at their word (harness/closedSubject.ts): never "tell them again", which would reopen it.
      const closedNow = !!reason && reason.startsWith(SUBJECT_CLOSED);
      await T.noteOnTask(c.userId, Number(p.taskId), closedNow ? `${DOOR_DROPPED_NOTE}: what it served had closed, so it stays unsaid unless they bring it back.` : `${DOOR_DROPPED_NOTE} (${status}${reason ? `: ${reason.slice(0, 120)}` : ""}). If it still matters, tell them again when you next can.`, null, { evenClosed: true }).catch(() => null);
      if (p.close) await T.closeTask(c.userId, Number(p.taskId), "dropped", `${p.close.outcome}; never told them (${status})`.slice(0, 300)).catch(() => false);
    }
  },
};

// The last companion check-in on this thread (either queue's key), and whether a text or call of theirs came after it. null: the read
// failed (threadChase holds the check-in). row null: none went.
async function threadLastCheckin(userId: string, threadId: string): Promise<{ row: { sentAt: Date; message: string | null } | null; theirSince: boolean } | null> {
  try {
    const { rows } = await pool.query(
      `SELECT sent_at, message FROM proactive_sends WHERE user_id = $1 AND type = 'companion' AND (target_key LIKE $2 OR target_key LIKE $3) ORDER BY sent_at DESC LIMIT 1`,
      [userId, `companion:thread:${threadId}:%`, `companion:reflection:${threadId}:%`],
    );
    if (!rows[0]) return { row: null, theirSince: false };
    const sentAt = new Date(rows[0].sent_at);
    const { rows: since } = await pool.query(
      `SELECT 1 FROM co_memories WHERE user_id = $1 AND created_at > $2 AND (memory_type = 'call_transcript' OR (memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()})) LIMIT 1`,
      [userId, sentAt],
    );
    return { row: { sentAt, message: rows[0].message ?? null }, theirSince: since.length > 0 };
  } catch {
    return null;
  }
}

export const proactiveRegistry: ProactiveRegistry = {
  event_offer: {
    // A reminder rides alone and is drafted here; every other offer goes out through the bundle composer (harness/bundleComposer.ts),
    // which uses prepareOffer below for each find.
    async draft(c, person) {
      const prep = await prepareOffer(c, person);
      if ("skip" in prep) return { ...skip(prep.skip), ...(prep.exited ? { exited: true } : {}), ...(prep.held ? { held: true } : {}) } as DraftResult;
      if ("defer" in prep) return prep;
      const p = c.payload as EventOfferPayload;
      const r = await draftEventReveal(person, p.askText, p.fromProfile, p.match, { reminder: p.reminder, again: p.again, dots: prep.dots, why: prep.why });
      return r ?? skip("model chose SKIP");
    },
    async onSent(c) {
      await onEventOfferSent(c.userId, c.payload as EventOfferPayload, revealedNow(c));
      const p = c.payload as EventOfferPayload;
      await writeMemory(c.userId, "event_discovery_surfacing", `Sent directly${isShortNotice(p.match) ? " (short notice)" : ""}: ${p.match.name}`);
    },
    async onDropped(c, status, reason) {
      await onEventOfferDropped(c.userId, c.payload as EventOfferPayload, status, c.id, c.targetKey, reason ?? null);
    },
  },

  // One solved plan for a want with a window, in a real gap (services/bounce.ts, the bounce, 2026-10-15). Read again before it
  // goes: the find (gone, sold out or past never pings) and the gap (busy now, or their stated time removed: silence).
  bounce_proposal: {
    async draft(c, person) {
      const p = c.payload;
      const B = await import("../services/bounce.js");
      const { checkBeforeSend } = await import("../services/sendCheck.js");
      const found = await checkBeforeSend({ id: c.id, userId: c.userId, payload: p }, p.zone ?? null);
      if ("skip" in found) return { ...skip(`the find: ${found.skip}`), ...(found.exited ? { exited: true } : {}) } as DraftResult;
      if ("defer" in found) return found;
      if (!(await B.gapStillHolds(c.userId, p.gap, p.times, p.zone).catch(() => false))) return skip("the gap no longer holds");
      const { facts, task } = B.proposalBrief({ want: p.want, match: p.match, gap: p.gap, times: p.times, zone: p.zone });
      // A roundup shared as a roundup (services/sendCheck.ts roundupShare): framed as a list, never checked terms (round-5 review of #441).
      const R = p.match?.sendAsRoundup ? await import("../agent/eventDiscoverySurfacing.js") : null;
      const text = await draftProactive({ functionId: "bounce.proposal.draft", firstName: person.firstName, facts, task: R ? `This link is${R.ROUNDUP_NOTE.replace(/^ \(|\)$/g, " ")}. ${task}` : task, maxSentences: 2 });
      if (!text) return skip("model chose SKIP");
      return { messages: [text], text, rules: { maxSentences: 2, maxChars: 300, mustIncludeAny: nameTokens(String(p.match?.name ?? "")), ...(R ? { forbidden: [R.UNCHECKED_CLAIM] } : {}) } };
    },
    async onSent(c, _person, messages) {
      await pool.query(`UPDATE bounce_proposals SET status = 'proposed', sent_at = NOW(), message = $2 WHERE id = $1 AND status = 'queued'`, [c.payload.proposalId, messages.join(" ").slice(0, 600)]);
    },
    async onDropped(c, _status, reason) {
      // The find it was for is remembered on the want (plan.dropped), so the next run never picks the same find again (bounce.ts).
      await pool.query(`UPDATE bounce_proposals SET status = 'dropped', answer_words = $2, plan = jsonb_set(COALESCE(plan, '{}'::jsonb), '{dropped}', COALESCE(plan->'dropped', '[]'::jsonb) || to_jsonb(find_name || '|' || COALESCE(find_day::text, ''))) WHERE id = $1 AND status = 'queued'`, [c.payload.proposalId, String(reason ?? "").slice(0, 300)]).catch(() => {});
    },
  },

  // The plan they asked Cue to keep an eye on changed (services/bounce.ts runBounceWatches): said once, before it starts.
  bounce_watch: {
    async draft(c, person) {
      const p = c.payload;
      const B = await import("../services/bounce.js");
      const until = B.watchUntil(p.plan);
      if (until && until.getTime() <= Date.now()) return skip("the plan has started");
      const { facts, task } = B.watchBrief({ what: p.what, plan: p.plan });
      const text = await draftProactive({ functionId: "bounce.watch.draft", firstName: person.firstName, facts, task, maxSentences: 2 });
      if (!text) return skip("model chose SKIP");
      return { messages: [text], text, rules: { maxSentences: 2, maxChars: 300, mustIncludeAny: nameTokens(String(p.plan?.match?.name ?? "")) } };
    },
  },

  // The one calendar offer, ever (services/bounce.ts queueCalendarOffer): only while a plan still needs it and they haven't connected.
  bounce_calendar_offer: {
    async draft(c, person) {
      const p = c.payload;
      const C = await import("../services/cueGrants.js");
      if (await C.calendarConnected(c.userId).catch(() => null)) return skip("they've connected their calendar since");
      const B = await import("../services/bounce.js");
      if (!(await B.calendarMomentReached(c.userId).catch(() => false))) return skip("no plan needs their calendar any more");
      const { facts, task } = B.calendarOfferBrief({ want: p.want, findNames: p.findNames ?? [] });
      const text = await draftProactive({ functionId: "bounce.calendarOffer.draft", firstName: person.firstName, facts, task, maxSentences: 2 });
      if (!text) return skip("model chose SKIP");
      return { messages: [text], text, rules: { maxSentences: 2, maxChars: 300 } };
    },
  },

  network_tease: {
    async draft(c, person) {
      const candidate = c.payload.candidate;
      // The matching kill switch (all events): waits, never dropped.
      const paused = await (await import("../services/roomMatching.js")).matchingPause(null);
      if (paused) return { defer: new Date(Date.now() + 30 * 60_000), reason: paused };
      // A closed ask makes no offers (services/askLifecycle.ts).
      if (!(await (await import("../services/askLifecycle.js")).askIsOpenRef(c.userId, c.payload.askId))) return skip("their ask has since closed");
      const text = await draftProactive({
        functionId: "networkIntroNudge.tease.draft",
        firstName: person.firstName,
        facts: { what_is_true: "someone in Cue's network fits what they've told you they're looking for" },
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
      await recordTease(c.userId, candidate.candidate_id, String(candidate.match_reason ?? ""), askId ?? null);
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
      const r = await draftAskCheckin(person.firstName, c.payload as AskCheckinPayload, await recentAskCheckins(c.userId));
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
      // A thread Co took on since it was queued is Co's to deliver now, not a question for them (memberThreads.ts coOwns).
      const { coOwns, ownedWorkFor } = await import("./memberThreads.js");
      const owned = await ownedWorkFor(c.userId);
      if (c.payload.thread && coOwns(c.payload.thread.text, owned)) return skip("Cue owns this thread: an open task delivers it");
      // Once per problem, no chasing (agent/companionCheckin.ts threadChase): the last check-in on this thread, and whether anything of
      // theirs came since. Its words ride to the draft so they're never repeated.
      let thread = c.payload.thread ?? null;
      if (thread && c.payload.threadId) {
        const last = await threadLastCheckin(c.userId, String(c.payload.threadId));
        const { threadChase } = await import("../agent/companionCheckin.js");
        const chase = threadChase(last === null ? { sentAt: new Date(0) } : last.row, last === null ? null : last.theirSince);
        if (!chase.ok) return skip(`not chased: ${chase.why}`);
        if (last?.row?.message) thread = { ...thread, lastSaid: last.row.message };
      }
      // A moment is said only while the record still backs it: a "went" needs their stated going (services/milestones.ts).
      if (c.payload.story?.key && !(await import("../services/milestones.js").then((M) => M.milestoneConfirmed(c.userId, c.payload.story.key)).catch(() => false))) return skip("the moment isn't confirmed by them: only theirs to say");
      const r = await draftCompanionCheckin(person.firstName, c.payload.recap ?? "", thread, c.payload.item ?? null, c.payload.curious ?? null, c.payload.story ?? null, c.payload.advice ?? null, c.payload.heavy ?? null, owned);
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
      const r = await draftAskSolicitation(person.firstName, c.payload.eventName, await solicitationGoals(c.userId));
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
      // Read again now, as the brief and the name question are (2026-11-03): queued up to 3 hours before the start, it went to someone
      // who had since said they can't make it ("Cue won't send them anything more about it"), or who had left the list.
      // Its own window first (review of #377): past payload.until it never goes, and a wait never runs past it.
      if (!p.until || Date.now() > new Date(p.until).getTime()) return skip("window closed");
      const read = await P.presenceRead(p.eventId, c.userId);
      if (!read) return P.preArrivalWait(p.until, new Date(), "couldn't read whether they're still going");
      const row = read.row;
      if (row?.not_going_at) return skip("they said they can't make it");
      if (row?.pre_arrival_sent_at) return skip("already sent for this event");
      const members = await import("../services/eventPresence.js").then((e) => e.eventMembers(p.eventId)).catch(() => null);
      // A guest-list outage is not "no longer registered", and with no list the no-names check below would have nothing to check.
      if (!members) return P.preArrivalWait(p.until, new Date(), "couldn't read the guest list just now");
      if (!members.some((m) => m.user_id === c.userId)) return skip("no longer registered");
      const [ask, fits] = await Promise.all([P.statedAsk(c.userId), P.strongFits(p.eventId, c.userId, members)]);
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

  // After a Noise event they didn't make it to (services/eventNoShow.ts): what the night was, never who came, and one offer. The
  // words are Royce's approved fixed lines (no model draft); nothing goes while NOSHOW_COPY_APPROVED is false.
  noshow_note: {
    async draft(c, person) {
      return (await import("../services/eventNoShow.js")).draftNoShowNote(c, person);
    },
    async onSent(c) {
      await (await import("../services/eventNoShow.js")).afterNoShowNoteSent(c);
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
      await writeMemory(c.userId, "event_brief_ask", `Asked if Cue may name them in the member brief for "${c.payload.name}"`);
    },
  },

  // Once before a Co event, to a guest nobody in the room can be pointed to yet (services/askSharing.ts): may Co tell a good
  // match what they're looking for? Words fixed in code; the asks offered are read again now (still undecided, about people,
  // not personal), and nothing goes if they've shared one since, said they can't make it, or were asked already.
  room_share_ask: {
    async draft(c) {
      const S = await import("../services/askSharing.js");
      const B = await import("../services/eventBrief.js");
      const { shareableAsks } = await import("../services/matching.js");
      const p = c.payload;
      const f = await B.presenceFlags(p.eventId, c.userId);
      const { rows: pres } = await pool.query(`SELECT share_asked_at FROM event_presence WHERE event_api_id = $1 AND user_id = $2`, [p.eventId, c.userId]);
      const intent = (await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [c.userId])).rows[0]?.intent;
      const offer = await S.offerableShareAsks(intent);
      const due = S.shareQuestionDue({ notGoing: f.notGoing, nameAskPending: false, shareAsked: Boolean(pres[0]?.share_asked_at), hasShareableAsk: shareableAsks(intent).length > 0, offerable: offer.length, startAt: p.startAt, now: new Date() });
      if (!due.due) return skip(due.why);
      // The matching pause (services/roomMatching.ts): the question waits, and expires only when the event starts.
      const paused = await (await import("../services/roomMatching.js")).matchingPause(p.eventId);
      if (paused) return { defer: new Date(Date.now() + 30 * 60_000), reason: paused };
      const text = S.roomShareAskMessage(p.name, offer);
      if (!text) return skip("nothing to offer");
      c.payload.offered = offer.map((a) => a.id);
      return { messages: [text], text, rules: { maxSentences: 7, maxChars: 900, mustIncludeAny: nameTokens(p.name).length ? nameTokens(p.name) : [p.name] } };
    },
    async onSent(c) {
      const offered: string[] = Array.isArray(c.payload.offered) ? c.payload.offered.map(String) : [];
      // The asks offered, in the order shown, so "1 and 3" maps to the right ones; marks this event asked (never again).
      await pool.query(
        `INSERT INTO event_presence (event_api_id, user_id, share_asked_at, share_ask_ids, share_answered_at) VALUES ($1, $2, NOW(), $3, NULL)
         ON CONFLICT (event_api_id, user_id) DO UPDATE SET share_asked_at = NOW(), share_ask_ids = $3, share_answered_at = NULL`,
        [c.payload.eventId, c.userId, offered],
      );
      await writeMemory(c.userId, "event_brief_ask", `Asked, before "${c.payload.name}", whether Cue may tell a good match in the room what they're looking for`);
    },
  },

  // A loop nobody has signalled on for a week: ask once whether it is still on their plate, then let it expire if they don't say.
  // A question only; the loop may not be stated as current (services/loopLifecycle.ts).
  loop_check: {
    async draft(c, person) {
      const { rows } = await pool.query(`SELECT closed_at, last_confirmed_at, title, detail FROM open_loops WHERE id = $1 AND user_id = $2`, [c.payload.loopId, c.userId]);
      if (!rows[0] || rows[0].closed_at) return skip("the loop has closed since");
      // A loop whose subject they had Cue forget is closed as removed, with no text: their choice, not a cancel. Its row and what the
      // draft would read (the payload's title and note) are both checked; if their removals can't be read, nothing is drafted.
      const L = await import("../services/openLoops.js");
      const removed = await L.loopRemovals(c.userId);
      if (removed === null) return skip("their removals couldn't be read: not drafted");
      const W = await import("../services/whatCoKnows.js");
      if (L.loopSaysRemoved({ title: String(rows[0].title ?? ""), detail: rows[0].detail ?? null }, removed, W) || L.loopSaysRemoved({ title: String(c.payload.title ?? ""), note: typeof c.payload.note === "string" ? c.payload.note : null }, removed, W)) {
        await L.closeRemovedLoop(c.userId, Number(c.payload.loopId));
        return skip("removed at their request: the loop is closed, no text");
      }
      const text = await draftProactive({
        functionId: "loopLifecycle.check.draft",
        firstName: person.firstName,
        // A note that came with the loop (services/inboundFile.ts: the file Co couldn't open, and what would work instead).
        facts: { the_thing_they_asked_about: c.payload.title, ...(typeof c.payload.note === "string" && c.payload.note ? { what_would_work: c.payload.note } : {}) },
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
      const entry = (Array.isArray(rows[0]?.intent) ? rows[0].intent : []).find((e: any) => e?.id === c.payload.goalId && e?.kind === "goal" && e?.status === "active");
      if (!entry) return skip("that goal is not open any more");
      // The purpose boundary, asked again when the check-in wakes (it may have been queued before the goal was read as outside).
      if ((await import("../services/goalJourney.js")).goalIsOutside(entry)) return skip("that goal is outside what Cue checks in on");
      // Its state in what Co knows about them (the dispatch's one read): a goal closed since is history, not a question.
      const known = draftKnowledge();
      if (known) {
        const { goalCheckinState, GOAL_DONE_SKIP } = await import("../services/goalJourney.js");
        if (goalCheckinState(known.goals, String(c.payload.text ?? "")) === "done") return skip(GOAL_DONE_SKIP);
      }
      // The goal recheck (services/goalRecheck.ts): a goal gone idle for no answer is treated as done (the check-in is marked done
      // with it); one whose recheck is out waits for the answer.
      {
        const { goalHash, goalStates } = await import("../services/goalEdges.js");
        const { GOAL_DONE_SKIP } = await import("../services/goalJourney.js");
        const R = await import("../services/goalRecheck.js");
        const st = (await goalStates(c.userId).catch(() => new Map()) as Map<string, import("../services/goalEdges.js").GoalStateRow>).get(goalHash(String(c.payload.text ?? "")));
        if (st && R.isRecheckIdle(st)) return skip(GOAL_DONE_SKIP);
        if (st?.state === "active" && R.recheckAskOpen(st.recheckAskedAt)) return skip("the goal recheck already asked about it");
      }
      const text = await draftProactive({
        functionId: "goalJourney.checkin.draft",
        firstName: person.firstName,
        facts: { the_direction_they_named_to_you: c.payload.text },
        task: "Ask one light question about whether this direction still holds, naming it in their own plain words and making it easy to say it has shifted. The shape: \"Still chasing the pre-seed, or has that shifted?\". One sentence, two at most. Say nothing about how long ago it was, no date, no advice, no offer, no pressure.",
      });
      return text ? { messages: [text], text, rules: { maxSentences: 2, maxChars: 200 } } : skip("model chose SKIP");
    },
    async onSent(c, _p, messages) {
      const { markGoalCheckedIn } = await import("../services/goalJourney.js");
      await markGoalCheckedIn(c.userId, c.payload.goalId);
      // The seasonal check-in is the goal recheck's question too (services/goalRecheck.ts) when the judge reads it as asking whether
      // they still want it: one covers both.
      const { goalHash } = await import("../services/goalEdges.js");
      await import("../services/goalRecheck.js").then((R) => R.noteRecheckSent(c.userId, goalHash(String(c.payload.text ?? "")), String(c.payload.text ?? ""), messages.join("\n"), "goal_checkin")).catch(() => {});
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
      // One acknowledgment: when Cue's own reply in the turn that closed it already said it (the #368 close move, or the reply's own
      // words), the moment doesn't go (services/goalJourney.ts replyAcknowledgedClose). A read that fails sends it as before.
      const GJ = await import("../services/goalJourney.js");
      const turn = await GJ.closingTurnReply(c.userId, c.createdAt).catch(() => null);
      const ack = turn ? GJ.replyAcknowledgedClose({ ...turn, goal: String(c.payload.text ?? "") }) : null;
      if (ack?.acknowledged) return skip(`${GJ.ACKNOWLEDGED_IN_REPLY}: ${ack.why}`);
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

  // The goal recheck's one text (services/goalRecheck.ts, Royce 2026-10-13): a searched goal with nothing from them in two weeks, and
  // no exchange to raise it in. One light question naming it; asked counts only once a text that raised it went out.
  goal_recheck: {
    async draft(c, person) {
      const R = await import("../services/goalRecheck.js");
      // A find ask's retirement question rides the same type (services/askRetire.ts, 2026-10-13): one in flight, one at a time.
      if (c.payload?.kind === "ask") {
        const A = await import("../services/askRetire.js");
        const due = await A.retireTextStillDue(c.userId, String(c.payload.askId), c.payload.queuedAt ?? null);
        if (!due.ok) return skip(due.why);
        const text = await draftProactive({
          functionId: "askRetire.text.draft",
          firstName: person.firstName,
          facts: { what_they_asked_you_to_look_for: due.text.slice(0, 200) },
          task: "Ask one short, light question with the word still in it, in the shape \"Still want me looking for X, or should I let it go?\". Name it in their own plain words, and make it easy to let it go. One sentence. Never the words keep looking or keep an eye out, no exclamation point, no date, nothing about how long it has been, no advice.",
        });
        if (!text) return skip("model chose SKIP");
        const read = await R.judgeRecheckAsked(due.text, text, undefined, "ask");
        if (!read.asked) return skip(`the draft didn't ask whether they still want it looked for (${read.reason})`);
        return { messages: [text], text, rules: { maxSentences: 2, maxChars: 200, forbidden: [{ pattern: /!/, reason: "exclamation point" }] } };
      }
      const still = await R.recheckTextStillDue(c.userId, String(c.payload.goalHash), { queuedAt: c.payload.queuedAt ?? null, lastSignalAt: c.payload.lastSignalAt ?? null });
      if (!still.ok) return skip(still.why);
      const text = await draftProactive({
        functionId: "goalRecheck.text.draft",
        firstName: person.firstName,
        facts: { the_goal_in_their_words: still.goal.slice(0, 200) },
        task: "Ask one short, light question with the word still in it: do they still want things for this, or has it run its course? Name it in their own plain words, and make it easy to say it's over. One sentence. Never an offer to keep looking or watching, no exclamation point, no date, nothing about how long it has been, no advice.",
      });
      if (!text) return skip("model chose SKIP");
      // A Haiku read of the draft (judgeRecheckAsked): it goes only if it asks whether they still want this goal, never an offer.
      const read = await R.judgeRecheckAsked(still.goal, text);
      if (!read.asked) return skip(`the draft didn't ask whether they still want it (${read.reason})`);
      return { messages: [text], text, rules: { maxSentences: 2, maxChars: 200, forbidden: [{ pattern: /!/, reason: "exclamation point" }] } };
    },
    async onSent(c) {
      if (c.payload?.kind === "ask") {
        await import("../services/askRetire.js").then((A) => A.markRetireAsked(c.userId, String(c.payload.askId), String(c.payload.text ?? ""), "text"));
        return;
      }
      const R = await import("../services/goalRecheck.js");
      await R.markRecheckAsked(c.userId, String(c.payload.goalHash), String(c.payload.goal ?? ""), "text");
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
      // A wait (the pause, an outage) can carry the row past its window; the brief never lands that late.
      if (p.until && Date.now() > new Date(p.until).getTime()) return skip("the brief's window has closed");
      // The matching pause (services/roomMatching.ts), as for every in-room send: the brief waits while it's on.
      const RM = await import("../services/roomMatching.js");
      const paused = await RM.matchingPause(p.eventId);
      if (paused) return { defer: new Date(Date.now() + 30 * 60_000), reason: paused };
      const fetched = await eventMembers(p.eventId).catch(() => null);
      // A guest-list outage is not "no longer registered": try again shortly instead of dropping their brief for good.
      if (!fetched) return { defer: new Date(Date.now() + 30 * 60_000), reason: "couldn't read the guest list just now" };
      const members = fetched;
      if (!members.some((m) => m.user_id === c.userId)) return skip("no longer registered");
      const others = members.filter((m) => m.user_id !== c.userId);
      const [flags, rankedAll] = await Promise.all([B.namedYes(p.eventId, others.map((m) => m.user_id)), B.rankingFor(p.eventId, c.userId)]);
      // The pair record, as the in-room sends read it: a declined, introduced or blocked pair is never named or counted.
      const blocks = await B.briefPairBlocks(p.eventId, c.userId, rankedAll.map((r) => r.candidate_id));
      if (!blocks) return { defer: new Date(Date.now() + 30 * 60_000), reason: "couldn't read the pair records just now" };
      const ranked = rankedAll.filter((r) => !blocks.has(r.candidate_id));
      // Their asks that are open and shareable right now: a stored reason that isn't one of them is never named.
      const { shareableAsks } = await import("../services/matching.js");
      const { rows: profs } = await pool.query(`SELECT user_id, intent FROM co_profiles WHERE user_id = ANY($1::uuid[])`, [others.map((m) => m.user_id)]);
      const stillShareable = new Map<string, string[]>(profs.map((r: any) => [String(r.user_id), shareableAsks(r.intent).map((a) => String(a.text))]));
      // Per person named: the same privacy check the in-room nudge uses (a reason that fails it keeps them a count, not a name),
      // then the same per-side value gate (services/roomMatching.ts valueGate, its policy as is) with this member's own line
      // present. A pair the gate blocks is neither named nor counted, and the next one in line is considered instead.
      const nameOk = new Set(flags.yes);
      const dropped = new Set<string>();
      const passed = new Set<string>();
      let chosen = B.pickNamed({ ranked, recipientId: c.userId, members: others, nameOk, notGoing: flags.notGoing, stillShareable });
      for (let again = true; again; ) {
        again = false;
        for (const pk of chosen.picks) {
          if (passed.has(pk.id)) continue;
          if (!(await gateShareReason(c.userId, pk.id, pk.reason, "event_brief"))) nameOk.delete(pk.id);
          else {
            const v = await RM.valueGate(p.eventId, p.name, c.userId, pk.id, "eventBrief.named", { allow: [p.name, ...(p.venue ? [p.venue] : [])] });
            if (!v.ok && v.transient) return { defer: new Date(Date.now() + 30 * 60_000), reason: "the value read failed; trying again shortly" };
            if (v.ok && v.lineFor(c.userId)) {
              passed.add(pk.id);
              continue;
            }
            dropped.add(pk.id);
          }
          chosen = B.pickNamed({ ranked: ranked.filter((r) => !dropped.has(r.candidate_id)), recipientId: c.userId, members: others, nameOk, notGoing: flags.notGoing, stillShareable });
          again = true;
          break;
        }
      }
      const picks = chosen.picks;
      const unnamedFits = chosen.unnamedFits;
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
        await writeMemory(c.userId, "followup_context", `Cue's follow-up asked about "${p.eventName}", which Cue sent them on ${sent.date}${sent.caption ? `: "${sent.caption}"` : ""}.`).catch(() => {});
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
          `Cue proactively offered: "${messages.join(" ")}" (morning-after follow-up after checking in at "${p.eventName}")`,
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

  // The text after a call. A recap offer held from before recaps were removed (isHeldRecap) is closed without a draft.
  post_call: {
    async draft(c, person) {
      if (isHeldRecap(c)) return skip("recap offers are no longer made");
      const r = await draftPostCall(c.userId, person.firstName, c.payload.followUpId);
      // The call corrections this draft was written with ride to onSent, so only those are marked delivered.
      // Its SKIP is a judgment about the content (POST_CALL_TASK: the call already landed it, the texts since covered it, or there's
      // nothing to add), so it is a fit skip: never a mood wait (harness/proactive.ts firstDraftMoodWait excludes POST_CALL_SKIP), and
      // never the mood fallback line in its place (Royce, 2026-11-09:
      // a hard day doesn't justify an automatic comforting text).
      return r ? { messages: [r.text], text: r.text, rules: r.rules, ...(r.corrections.length ? { meta: { callCorrectionIds: r.corrections.map((x) => x.id) } } : {}) } : skip(POST_CALL_SKIP);
    },
    async onSent(c, _p, messages, meta) {
      if (isHeldRecap(c)) return;
      await markPostCallSent(c.payload.followUpId);
      // The corrections it was drafted with went with it: delivered, so the next text knows it was meant to take them back (harness/callGrounding.ts).
      await markCarriedCorrections(c.userId, meta).catch((err: any) => console.error("postCallFollowUp: marking call corrections delivered failed (non-fatal):", err?.message ?? err));
    },
    async onDropped(c, status) {
      // A held recap ending (its own lifetime, or a fact that no longer holds) leaves the call's own record alone: its text went.
      if (isHeldRecap(c)) return;
      await markPostCallDropped(c.payload.followUpId, status);
    },
  },

  // Human-written bullets go out verbatim; only the intro/closing lines are
  // model-drafted, and those are what the output checks run on.
  // Fixed wording, not a draft (services/nameChange.ts): the one text that tells them Co goes by Cue now, on a day nothing else goes.
  // Re-read at send time: if the line already went out riding in another text, nothing goes.
  name_change: {
    async draft(c) {
      const { rows } = await pool.query(`SELECT 1 FROM proactive_sends WHERE user_id = $1 AND target_key = $2`, [c.userId, c.targetKey]);
      if (rows[0]) return skip("already told");
      const { NAME_CHANGE_TEXT } = await import("../services/nameChange.js");
      return { messages: [NAME_CHANGE_TEXT], text: NAME_CHANGE_TEXT, rules: { maxChars: 120, maxSentences: 3 } };
    },
  },

  // The voice read's one question (services/voiceReadConsent.ts): fixed words, read again at send time. Asked already, answered, the
  // read not available here, or nothing on file to ask about means nothing goes; no answer means it stays off.
  voice_read_ask: {
    async draft(c) {
      const C = await import("../services/voiceReadConsent.js");
      const { voiceReadTextDue } = await import("../services/voiceRead.js");
      // Cue's own ask and their ask on a call alike: only while nothing is on file, so the question goes once.
      if (!voiceReadTextDue(await C.readVoiceReadConsent(c.userId), (c.payload as { theyAsked?: boolean } | null)?.theyAsked === true, process.env, c.createdAt ? new Date(c.createdAt) : null)) return skip("asked already, answered, or the voice read can't run here");
      return { messages: [C.VOICE_READ_ASK], text: C.VOICE_READ_ASK, rules: C.VOICE_READ_ASK_RULES };
    },
    async onSent(c) {
      await (await import("../services/voiceReadConsent.js")).noteVoiceReadAsked(c.userId);
    },
  },

  // Fixed, approved wording, not a draft (services/announcements.ts): one update announcement, its own text, on a day nothing else
  // goes. Re-read at send time: already told means nothing goes; a member the name notice hasn't reached gets it in the same text.
  announcement: {
    async draft(c, person) {
      return (await import("../services/announcements.js")).draftAnnouncement(c, { zone: person.timezone ?? null });
    },
  },

  // Fixed wording, not a draft (services/introRequestClose.ts): the one neutral close for an intro they asked for by name, 7 days on,
  // the same words whatever happened. Re-read at send time: the intro email went since, or the request is gone, means nothing goes.
  // Sent or dropped, the request row is forgotten.
  intro_close: {
    async draft(c) {
      return (await import("../services/introRequestClose.js")).draftIntroClose(c);
    },
    async onSent(c) {
      await (await import("../services/introRequestClose.js")).forgetIntroRequest(String(c.payload?.requestId ?? ""));
    },
    async onDropped(c) {
      await (await import("../services/introRequestClose.js")).forgetIntroRequest(String(c.payload?.requestId ?? ""));
    },
  },

  // A search they asked for didn't go through (services/searchFailedNotice.ts, approved by Royce 2026-11-09): Cue gets the facts and says
  // it in its own words. Re-read first: the ask closed, or a later search of it went through, means nothing goes.
  search_failed: {
    async draft(c, person) {
      const N = await import("../services/searchFailedNotice.js");
      const p = (c.payload ?? {}) as { askCheckinId?: string; askText?: string };
      if (!p.askCheckinId || !p.askText) return skip("no ask on the notice");
      const still = await N.readStillFailed(c.userId, String(p.askCheckinId)).catch(() => ({ ok: false as const, why: "couldn't re-read the ask" }));
      if (!still.ok) return skip(still.why);
      const text = await draftProactive({ functionId: "searchFailed.draft", firstName: person.firstName, facts: N.searchFailedFacts({ askText: String(p.askText) }), task: N.SEARCH_FAILED_TASK });
      return text ? { messages: [text], text, rules: { ...N.SEARCH_FAILED_RULES } } : skip("model chose SKIP");
    },
    async onSent(c, _p, messages) {
      await writeMemory(c.userId, "check_in", `Told them a search they asked for didn't go through: ${messages.join(" ")}`);
    },
  },

  // Pages and decks are gone (2026-11-04): an expiry notice queued before that is dropped, never sent. The type stays so the queue still reads it.
  artifact_expiry: {
    async draft() {
      return skip("pages and decks are no longer available");
    },
    async onSent() {},
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
      // The matching kill switch (services/roomMatching.ts): waits, never dropped.
      const paused = await (await import("../services/roomMatching.js")).matchingPause(p.eventId);
      if (paused) return { defer: new Date(Date.now() + 30 * 60_000), reason: paused };
      // Queued, then a connection was added (an intro elsewhere, "we already know each other"): it never goes (services/knownConnections.ts).
      const known = await (await import("../services/knownConnections.js")).knownReason(c.userId, p.candidateId, "proactive.eventMatchNudge");
      if (known) return skip(known);
      return { messages: [p.message], text: p.message, rules: p.rules };
    },
    async onSent(c) {
      const p = c.payload as EventMatchNudgePayload;
      await markMatchNudgeSent(p.eventId, c.userId, p.candidateId, p.score, !!p.anonymous);
      await (await import("../services/roomMatching.js")).notePairAsked(p.eventId, c.userId, p.candidateId).catch(() => {});
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
  // At the door (harness/door.ts): texts their own paths wrote, waiting for the pick.
  task_update: doorEntry,
  co_event: doorEntry,
  event_change: doorEntry,
  direct_ask: doorEntry,
};
