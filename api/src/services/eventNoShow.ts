// The no-show flow for Noise's own events (Royce, 2026-10-23: "if Cue didn't see someone check in, ask if they're there; if not,
// instead of a goodbye send 'Sorry you couldn't make it...', offer something else". Details decided the same day, memory
// project_noshow_flow.md):
//   1. About NOSHOW_ASK_AFTER_START_MINUTES after a Noise event starts, a registered guest with no evidence they came (no Luma
//      door check-in, no arrival Cue saw, no walk-in check-in: services/eventUnmatchedFollowUp.ts cameTonight) gets ONE
//      "did you make it?" text (noShowAskText). Ledgered once per member per event (proactive_sends noshow_ask:<event>).
//   2. They say they're there: Cue's own reply records the arrival (agent/conversationTools.ts markArrived), so the normal
//      in-room flow and the end-of-night goodbye apply. They say they didn't make it: updateGoing records it, and the sorry
//      note is queued for when the night is over.
//   3. No answer at all (no text from them after the ask): treated as not there, and the same note goes the next morning in
//      their own time, but ONLY when the door was tracked that night (at least one Luma check-in recorded for the event). An
//      untracked door and no answer gets nothing. Any other reply from them, with no evidence and no "no", is unclear: nothing.
//   4. The note (proactive type noshow_note, harness/proactiveRegistry.ts), from the approved fixed lines only, no model draft
//      (review of #272): what the night was without any names (the event's name, and one sentence verbatim from its own Luma
//      description when that sentence is safe), then one offer: a double opt-in intro to one person from that night who fits what
//      they're working on (a strong ranked fit who came, whose ask they agreed may be shared, AND who has already said yes to an
//      intro with this member, since the reveal tells this member they came; through the network intro path:
//      the note asks "want me to tell you who?", a yes reveals the name and asks about the intro, both yes sends the email), else
//      the next Noise table if one is on the calendar. It never names or describes anyone who came, and never says who or how
//      many came. A hard week (harness/emotion.ts needsCare) changes the tone, never whether it goes or what it offers: gentler
//      words, the same offer, and never a word saying Cue knows they've been struggling (Royce, 2026-10-23).
//   5. The words were approved by Royce 2026-10-23 (NOSHOW_COPY_APPROVED); false would stop everything, nothing asked, queued or sent.
//   6. Delivery: the ask through sendExempt (opt-out read at send time, their local hours, the pause, the ledger), held by the
//      matching kill switch and a safety hold; the note through the daily pick (harness/proactive.ts dispatch: ledger once,
//      local hours, opt-out, safety hold, pacing). A test-range number (555-01xx) never gets either outside tests. Logs carry
//      ids only.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { checkDraft, enqueueCandidate, nameTokens, nextLocalHour, RULES, sendExempt, type Candidate, type DraftResult, type OutputRules, type Person } from "../harness/proactive.js";
import { effectiveEnd, roomPhase } from "../harness/introConsent.js";
import { cameTonight, lumaCheckedIn, type CheckedIn } from "./eventUnmatchedFollowUp.js";
import { getEventGuestList, type LumaGuest } from "./luma.js";
import { namesAnyone } from "./preArrival.js";

export const NOSHOW_ASK_AFTER_START_MINUTES = 45;
// The note is queued at most this long after the night ends, then the question is settled for good (nothing owed).
export const NOSHOW_SETTLE_HOURS = 24;
// A queued note expires this long after it's due.
export const NOSHOW_NOTE_EXPIRY_HOURS = 48;
// The same bar as an in-room match nudge and a network intro.
export const NOSHOW_STRONG_SCORE = 60;

// The ask's line and the note's fixed lines are member-facing copy, approved by Royce 2026-10-23 (the hard-week
// line dropped: the gentleness is in the rest of the note, never a word saying Cue knows they're struggling). Set back to false,
// nothing is asked, queued, drafted or sent, and nothing is marked done. A code constant, no env switch (the CLOSE_APPROVED pattern).
export const NOSHOW_COPY_APPROVED: boolean = true;
let awaitingApprovalNoted = false;
function approved(o?: boolean): boolean {
  if (o ?? NOSHOW_COPY_APPROVED) return true;
  if (!awaitingApprovalNoted) console.log("eventNoShow: the no-show ask and note wait on their copy's approval (NOSHOW_COPY_APPROVED); nothing asked, queued or sent");
  awaitingApprovalNoted = true;
  return false;
}

// A test-range number (+1 any area code 555-01xx) never gets the ask or the note outside tests, whatever the environment
// (services/testNumbers.ts logs those sends on co-test; this flow skips them altogether). Tests open it explicitly.
let testNumbersOpen = false;
export function openTestNumbersForTests(on = true): void {
  testNumbersOpen = on;
}
export function testRangeNumber(phone: unknown): boolean {
  return typeof phone === "string" && /^1?\d{3}55501\d{2}$/.test(phone.replace(/\D/g, ""));
}
const mayText = (phone: unknown) => !!phone && (testNumbersOpen || !testRangeNumber(phone));

// ---------------------------------------------------------------- copy (pure)

const zoneOf = (z: string | null | undefined) => (z && DateTime.now().setZone(z).isValid ? z : "America/Los_Angeles");

// The ask: one line, fixed.
export function noShowAskText(e: { name: string; start_at: string; timezone?: string | null }): string {
  const when = DateTime.fromISO(e.start_at, { zone: zoneOf(e.timezone) }).hour >= 17 ? "tonight" : "today";
  return `Did you make it to ${e.name} ${when}? No pressure either way.`;
}

export type NoShowOffer = { kind: "intro" } | { kind: "next_table"; name: string; startAt: string; timezone: string | null; url: string | null } | { kind: "none" };

export function nextTableDate(startAt: string, timezone: string | null): string {
  return DateTime.fromISO(startAt, { zone: zoneOf(timezone) }).toFormat("cccc, LLLL d");
}

// The note, from the approved fixed lines only (Royce, 2026-10-23), never a model draft (review of #272: a draft check can't catch
// every way a model describes who came, "Twelve of us filled the table", "The room was packed"). The sorry line, then the one line
// on what the night was when the event's own Luma description gives a safe one verbatim (aboutLine), then the offer.
export function noShowNote(eventName: string, offer: NoShowOffer, soft: boolean, about: string | null = null): string {
  // One sorry line whatever the week: a hard week is never named (Royce, 2026-10-23).
  const lines = [`Sorry you couldn't make it to ${eventName}.`];
  if (about) lines.push(about);
  if (offer.kind === "intro") lines.push(soft ? "There was someone there I think you'd get a lot from knowing, whenever you feel up to it. Want me to tell you who?" : "There was someone there I think you'd get a lot from knowing. Want me to tell you who?");
  if (offer.kind === "next_table") lines.push(`The next table is ${offer.name} on ${nextTableDate(offer.startAt, offer.timezone)}, if you'd like to join.`);
  return lines.join(" ");
}

// Who came, or what the room was like, said any other way than a name: a count, "everyone", "were there", "the room was packed".
export const WHO_CAME = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|a few|several|a handful of|a couple of|lots of|many|so many|a dozen|dozens of|some of the)\s+(of us|of you|people|guests|members|founders|folks|friends|strangers)\b|\b(everyone|everybody)\b|\bwho (came|was there|were there|showed up|made it)\b|\b(were|was) there\b|\bpeople (came|showed up|who came)\b|\b(room|table) (was|were) (packed|full)\b|\bfilled the (room|table)\b|\bpacked\b/i;

// Pure: the one line on what the night was, verbatim from the event's own Luma description (its first sentence), or null. It is
// dropped, never edited, when it could say anything about who came or names anyone on the night's list, asks something, carries a
// link or a dash, or runs long. This is the seam for a future judge (a check that the line says nothing about the room or its
// people); none is wired.
export function aboutLine(description: string | null | undefined, names: string[]): string | null {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  const first = text.match(/^[^.!?]*[.!]/)?.[0]?.trim() ?? "";
  if (first.length < 12 || first.length > 200) return null;
  if (/[—–?]|https?:\/\/|www\./i.test(first) || WHO_CAME.test(first) || namesAnyone(first, names)) return null;
  return first;
}

// Pure: when the ask goes. The room open (not its last 30 minutes, not over) and at least NOSHOW_ASK_AFTER_START_MINUTES in.
export function askDue(e: { start_at: string; end_at: string | null; timezone?: string | null }, now: Date, closedAt: Date | null = null): boolean {
  return roomPhase(e, now, closedAt) === "open" && now.getTime() >= new Date(e.start_at).getTime() + NOSHOW_ASK_AFTER_START_MINUTES * 60_000;
}

export type NoShowRow = { asked_at: Date; not_going_at: Date | null; last_inbound_at: Date | null };
export type NoShowVerdict = "came" | "said_no" | "no_answer" | "unclear";
// Pure: what an asked guest's night was, once it's over. Evidence they came wins; then their "no" (said after the ask);
// then silence (no text of theirs since the ask) is no answer; any other reply is unclear.
export function verdict(came: boolean, r: NoShowRow): NoShowVerdict {
  if (came) return "came";
  if (r.not_going_at && r.not_going_at.getTime() >= r.asked_at.getTime()) return "said_no";
  if (!r.last_inbound_at || r.last_inbound_at.getTime() <= r.asked_at.getTime()) return "no_answer";
  return "unclear";
}

// Pure: when the note is due. A "no": once the night is over. No answer: their next morning (RULES.startHour, member-local), and
// only when the door was tracked. Null: nothing owed.
export function noteDueAt(v: NoShowVerdict, o: { end: Date; zone: string | null; doorTracked: boolean }): Date | null {
  if (v === "said_no") return o.end;
  if (v === "no_answer" && o.doorTracked) return nextLocalHour(o.end, o.zone, RULES.startHour);
  return null;
}

// ---------------------------------------------------------------- data

async function people(ids: string[]): Promise<Map<string, { user_id: string; first_name: string; phone_number: string; email: string }>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`SELECT id AS user_id, first_name, phone_number, email FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r: any) => [String(r.user_id), r]));
}

// The guest list once: the door check-ins, and whether the door was tracked at all. Null when the read failed (tried again later).
async function door(eventId: string): Promise<{ guests: LumaGuest[] | undefined; lumaIn: CheckedIn; tracked: boolean } | null> {
  const { isTestEvent } = await import("./roomMatching.js");
  if (isTestEvent(eventId)) return { guests: undefined, lumaIn: lumaCheckedIn(undefined), tracked: false };
  const guests = await getEventGuestList(eventId).catch(() => null);
  if (!guests) return null;
  return { guests, lumaIn: lumaCheckedIn(guests), tracked: guests.some((g) => !!g.checked_in_at) };
}

const log = (eventId: string, userId: string, what: string) => console.log(`eventNoShow: event=${eventId} member=${userId} ${what}`);

// ---------------------------------------------------------------- 1. the ask (cron, every 15 minutes)

export async function runNoShowAsks(now = new Date(), opts: { approved?: boolean } = {}): Promise<number> {
  if (!approved(opts.approved)) return 0;
  const P = await import("./eventPresence.js");
  const RM = await import("./roomMatching.js");
  let sent = 0;
  for (const event of await P.presenceEvents()) {
    if (!askDue(event, now, await RM.roomClosedAt(event.api_id))) continue;
    const d = await door(event.api_id);
    if (!d) continue; // Luma read failed: Cue can't tell who checked in, so nobody is asked this pass.
    const members = await P.eventMembers(event.api_id);
    const who = await people(members.map((m) => m.user_id));
    const { rows: pres } = await pool
      .query(`SELECT user_id, noshow_asked_at, not_going_at FROM event_presence WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])`, [event.api_id, members.map((m) => m.user_id)])
      .catch(() => ({ rows: [] as any[] }));
    const row = new Map(pres.map((r: any) => [String(r.user_id), r]));
    for (const m of members) {
      const p = who.get(m.user_id);
      if (!p || !mayText(p.phone_number)) continue;
      const r = row.get(m.user_id);
      if (r?.noshow_asked_at || r?.not_going_at) continue;
      if (await cameTonight(event.api_id, p, d.lumaIn)) continue;
      if ((await sendAsk(event, p, now).catch(() => "failed")) === "sent") sent++;
    }
  }
  return sent;
}

async function sendAsk(event: { api_id: string; name: string; start_at: string; timezone?: string | null }, p: { user_id: string; phone_number: string }, now: Date): Promise<"sent" | "held" | "failed"> {
  const { inRoomSendAllowed } = await import("../harness/proactive.js");
  // The pause and the matching kill switch hold it; the in-room limit doesn't (one line, once, like the close).
  if (!(await inRoomSendAllowed(p.user_id, event.api_id, { close: true }))) return "held";
  // Someone who may not have been safe in the last few days isn't asked about a party.
  if (await (await import("./safety.js")).safetyHoldActive(p.user_id)) {
    log(event.api_id, p.user_id, "ask held: safety hold");
    return "held";
  }
  const zone = await (await import("./memberTime.js")).memberZone(p.user_id).catch(() => null);
  const r = await sendExempt({ userId: p.user_id, phoneNumber: p.phone_number, type: "co_event", targetKey: `noshow_ask:${event.api_id}`, messages: [noShowAskText(event)], timezone: zone ?? event.timezone ?? null, respectHours: true, now });
  // Sent now, or by an earlier pass that crashed before marking it: either way it was asked.
  if (r.sent || r.reason === "already sent") {
    await pool.query(
      `INSERT INTO event_presence (event_api_id, user_id, noshow_asked_at) VALUES ($1, $2, NOW())
       ON CONFLICT (event_api_id, user_id) DO UPDATE SET noshow_asked_at = COALESCE(event_presence.noshow_asked_at, NOW())`,
      [event.api_id, p.user_id],
    );
    log(event.api_id, p.user_id, "asked if they made it");
    return r.sent ? "sent" : "held";
  }
  return "held";
}

// Their open ask, for a "no" that comes after the night is over (agent/conversationTools.ts updateGoing): the latest ask in the
// last NOSHOW_SETTLE_HOURS that hasn't been settled.
export async function openNoShowAsk(userId: string): Promise<{ eventApiId: string } | null> {
  const { rows } = await pool
    .query(
      `SELECT event_api_id FROM event_presence WHERE user_id = $1 AND noshow_asked_at > NOW() - ($2 || ' hours')::interval AND noshow_settled_at IS NULL
       ORDER BY noshow_asked_at DESC LIMIT 1`,
      [userId, NOSHOW_SETTLE_HOURS],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows[0] ? { eventApiId: String(rows[0].event_api_id) } : null;
}

// ---------------------------------------------------------------- 2. after the night (cron, every 15 minutes): settle each ask

export async function runNoShowNotes(now = new Date(), opts: { approved?: boolean } = {}): Promise<number> {
  if (!approved(opts.approved)) return 0;
  const { rows } = await pool.query(
    `SELECT event_api_id, user_id, noshow_asked_at, not_going_at FROM event_presence
     WHERE noshow_asked_at IS NOT NULL AND noshow_settled_at IS NULL AND noshow_asked_at > NOW() - INTERVAL '3 days'`,
  );
  const byEvent = new Map<string, any[]>();
  for (const r of rows) byEvent.set(String(r.event_api_id), [...(byEvent.get(String(r.event_api_id)) ?? []), r]);
  const RM = await import("./roomMatching.js");
  const { lastInboundAt } = await import("../harness/proactive.js");
  const { memberZone } = await import("./memberTime.js");
  let queued = 0;
  for (const [eventId, asked] of byEvent) {
    const timing = await RM.eventTiming(eventId).catch(() => null);
    if (!timing) continue; // unreadable: tried again next pass
    if (roomPhase(timing, now, await RM.roomClosedAt(eventId)) !== "over") continue;
    const end = new Date(effectiveEnd(timing));
    const d = await door(eventId);
    const who = await people(asked.map((r) => String(r.user_id)));
    for (const r of asked) {
      const userId = String(r.user_id);
      const p = who.get(userId);
      const settle = (outcome: string) =>
        pool.query(`UPDATE event_presence SET noshow_settled_at = NOW(), noshow_outcome = $3 WHERE event_api_id = $1 AND user_id = $2 AND noshow_settled_at IS NULL`, [eventId, userId, outcome]);
      if (!p) {
        await settle("gone");
        continue;
      }
      const came = await cameTonight(eventId, p, d?.lumaIn ?? { emails: new Set(), phones: new Set() });
      const v = verdict(came, { asked_at: new Date(r.noshow_asked_at), not_going_at: r.not_going_at ? new Date(r.not_going_at) : null, last_inbound_at: await lastInboundAt(userId).catch(() => null) });
      // Without the guest list, silence can't be told from a door check-in: tried again next pass, until the settle window ends.
      if (v === "no_answer" && !d && now.getTime() - end.getTime() < NOSHOW_SETTLE_HOURS * 3_600_000) continue;
      const zone = await memberZone(userId).catch(() => null);
      const due = noteDueAt(v, { end, zone, doorTracked: !!d?.tracked });
      if (due && mayText(p.phone_number)) {
        const q = await enqueueCandidate({
          userId,
          type: "noshow_note",
          targetKey: `noshow_note:${eventId}`,
          // Its own topic: the pre-arrival text's topic (event:<id>) would hold it as a re-ask of an unanswered text (review of #272).
          topicKey: `noshow_note:${eventId}`,
          summary: `They didn't make it to "${timing.name}": a short note, what the night was (no names), and one offer`,
          payload: { eventId, name: timing.name, startAt: timing.start_at, timezone: timing.timezone ?? null, said: v },
          dueAt: due,
          expiresAt: new Date(due.getTime() + NOSHOW_NOTE_EXPIRY_HOURS * 3_600_000),
        });
        if (q.queued) queued++;
      }
      await settle(due ? `${v}:queued` : v);
      log(eventId, userId, `settled: ${v}${due ? ", note queued" : ""}`);
      await recordDecision({ layer: 6, decision: "event.noshow", userId, outcome: due ? "act" : "skip", action: v, proposal: { eventId, doorTracked: !!d?.tracked } }).catch(() => {});
    }
  }
  return queued;
}

// ---------------------------------------------------------------- 3. the note (built when the daily pick picks it, harness/proactiveRegistry.ts)

export type IntroPick = { askId: string | null; candidate: { edge_id: string; candidate_id: string; first_name: string; phone_number: string; email: string; match_score: number; match_reason: string; share_safe: true } };

// One person from that night who fits what they're working on: their strongest ranked fit at the event (NOSHOW_STRONG_SCORE or
// more) whose reason rests on an ask that person agreed may be shared, who has evidence they came, who isn't already a pair with
// them at this event, and who passes the network intro gate (shareable reason, never suggested or declined, both active).
export async function strongConsentingFit(eventId: string, userId: string, lumaIn: CheckedIn): Promise<IntroPick | null> {
  const { rows } = await pool.query(`SELECT ranked_candidates FROM event_guest_rankings WHERE event_id = $1 AND person_id = $2`, [eventId, userId]).catch(() => ({ rows: [] as any[] }));
  const ranked = (Array.isArray(rows[0]?.ranked_candidates) ? rows[0].ranked_candidates : []).filter((r: any) => typeof r?.score === "number" && r.score >= NOSHOW_STRONG_SCORE && typeof r.shareReason === "string" && r.shareReason.trim() && r.candidate_id !== userId);
  ranked.sort((a: any, b: any) => b.score - a.score);
  if (!ranked.length) return null;
  const who = await people(ranked.map((r: any) => String(r.candidate_id)));
  const { gateNetworkCandidate } = await import("../harness/matchGate.js");
  const paired = async (a: string, b: string) => (await pool.query(`SELECT 1 FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3`, [eventId, a, b]).catch(() => ({ rows: [] as any[] }))).rows.length > 0;
  const askId = await newestAskId(userId);
  for (const r of ranked) {
    const c = who.get(String(r.candidate_id));
    if (!c?.phone_number) continue;
    if (!(await cameTonight(eventId, c, lumaIn))) continue;
    if ((await paired(userId, c.user_id)) || (await paired(c.user_id, userId))) continue;
    if (!(await gateNetworkCandidate(userId, c.user_id, r.shareReason, "queue"))) continue;
    return { askId, candidate: { edge_id: "", candidate_id: c.user_id, first_name: c.first_name, phone_number: c.phone_number, email: c.email, match_score: r.score, match_reason: r.shareReason, share_safe: true } };
  }
  return null;
}

async function newestAskId(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const { isOpenAsk } = await import("../harness/profileWrite.js");
  const open = (Array.isArray(rows[0]?.intent) ? rows[0].intent : []).filter((i: any) => isOpenAsk(i) && i?.type === "seeking" && i?.id);
  return open.length ? String(open[open.length - 1].id) : null;
}

// The next Noise table on the calendar, after now (never the night they missed).
async function nextTable(eventId: string, now: Date): Promise<NoShowOffer | null> {
  const events = await (await import("./eventPresence.js")).presenceEvents().catch(() => []);
  const next = events.filter((e) => e.api_id !== eventId && new Date(e.start_at).getTime() > now.getTime()).sort((a, b) => +new Date(a.start_at) - +new Date(b.start_at))[0];
  return next ? { kind: "next_table", name: next.name, startAt: next.start_at, timezone: next.timezone ?? null, url: next.url ?? null } : null;
}

// The event's own Luma description (aboutLine takes one verbatim sentence from it): never the room, never who came.
async function aboutTheNight(eventId: string): Promise<string | null> {
  const events = await (await import("./eventPresence.js")).presenceEvents().catch(() => []);
  const url = events.find((e) => e.api_id === eventId)?.url;
  if (!url) return null;
  const d = await (await import("./eventDetails.js")).fetchLumaEventDetails(url).catch(() => null);
  return d?.description ?? null;
}

export type NoteDeps = {
  approved?: boolean;
  struggling: (userId: string) => Promise<boolean>;
  about: (eventId: string) => Promise<string | null>;
  now: () => Date;
  // The network reveal, drafted and gated before the offer goes (services/networkIntroNudge.ts prepareReveal).
  reveal: (userId: string, firstName: string, candidate: IntroPick["candidate"]) => Promise<{ message: string; optedIn: boolean } | { why: string; retry: boolean }>;
};
const defaultDeps: NoteDeps = {
  reveal: async (...a) => (await import("./networkIntroNudge.js")).prepareReveal(...a),
  struggling: async (userId) => !!(await (await import("../harness/emotion.js")).getEmotionalContext(userId).catch(() => null))?.needsCare,
  about: aboutTheNight,
  now: () => new Date(),
};

export async function draftNoShowNote(c: Candidate, person: Person, deps: NoteDeps = defaultDeps): Promise<DraftResult> {
  const p = c.payload as { eventId: string; name: string; startAt: string; timezone: string | null };
  // Unapproved, it waits (and expires on its own clock): nothing drafted or sent.
  if (!approved(deps.approved)) return { defer: new Date(deps.now().getTime() + 3_600_000), reason: "the no-show note's copy waits on approval" };
  if (!mayText(person.phoneNumber)) return { skip: "a test-range number" };
  const d = await door(p.eventId);
  const lumaIn = d?.lumaIn ?? { emails: new Set<string>(), phones: new Set<string>() };
  // They came after all (a late door check-in, an arrival recorded since): no "sorry you couldn't make it".
  if (await cameTonight(p.eventId, { user_id: c.userId, email: await emailOf(c.userId), phone_number: person.phoneNumber }, lumaIn)) return { skip: "they came after all" };
  const soft = await deps.struggling(c.userId).catch(() => false);
  // The offer: an intro to one person from that night, with its reveal drafted and checked now (the network tease's rule: never ask
  // "want me to tell you who?" without the answer in hand); else the next table. A hard week changes how it's said, never the offer.
  let offer: NoShowOffer = { kind: "none" };
  const pick = await strongConsentingFit(p.eventId, c.userId, lumaIn).catch(() => null);
  if (pick) {
    const prepared = await deps.reveal(c.userId, person.firstName, pick.candidate).catch(() => null);
    // Only when that person has already said yes to being introduced to this member (review of #272): a yes to the note reveals
    // their name, which tells this member they came, and agreeing to share their ask was never agreeing to share that.
    if (prepared && "message" in prepared && prepared.optedIn === true) {
      offer = { kind: "intro" };
      c.payload.intro = { askId: pick.askId, candidate: pick.candidate, reveal: prepared.message, revealOptedIn: prepared.optedIn };
    }
  }
  if (offer.kind === "none") offer = (await nextTable(p.eventId, deps.now())) ?? offer;
  if (offer.kind !== "intro") delete c.payload.intro;
  // Every name on the night's list, theirs aside: none may appear (the candidate's included).
  const members = await (await import("./eventPresence.js")).eventMembers(p.eventId).catch(() => [] as { user_id: string; first_name: string }[]);
  const names = [...members.filter((m) => m.user_id !== c.userId).map((m) => m.first_name), ...(pick ? [pick.candidate.first_name] : [])].filter(Boolean);
  const rules: OutputRules = { maxSentences: 4, maxChars: 420, mustIncludeAny: nameTokens(p.name).length ? nameTokens(p.name) : [p.name], mustNotInclude: pick ? [pick.candidate.first_name] : [] };
  const about = aboutLine(await deps.about(p.eventId).catch(() => null), names.filter((n) => !p.name.toLowerCase().includes(n.toLowerCase())));
  // The fixed lines pass the harness's checks on their own; a description line that tips the note over them is left out.
  let text = noShowNote(p.name, offer, soft, about);
  if (about && !checkDraft(text, rules).every((k) => k.pass)) text = noShowNote(p.name, offer, soft, null);
  const link = offer.kind === "next_table" && offer.url ? [offer.url] : [];
  return { messages: [text, ...link], text, rules };
}

async function emailOf(userId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT first_name, phone_number, email FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return rows[0]?.email ?? "";
}

// Once the note went: an intro offer is now their open question (the network tease's record), so "yes" reveals who and asks
// about the intro, and both yeses send the one email (services/networkIntroNudge.ts).
export async function afterNoShowNoteSent(c: Candidate): Promise<void> {
  const intro = c.payload?.intro;
  if (intro?.candidate?.candidate_id) {
    await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_offer_pending', $2)`, [c.userId, JSON.stringify(intro)]);
  }
  log(c.payload?.eventId, c.userId, `note sent${intro ? " with an intro offer" : ""}`);
}
