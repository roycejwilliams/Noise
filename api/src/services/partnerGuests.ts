// Guests at a partner night (Royce, 2026-10-14, the partner-room spec steps 1, 2, 7 and 8). A guest is someone who isn't a
// member and texted Cue a live night's code (services/partners.ts) from the RSVP link or the door QR.
//
//   1. The guest texts first. That one text is their consent and starts their intake: it makes their guest row for that night.
//      Cue never texts a non-member first: everything here is a reply to a text they just sent.
//      Arrival (being in the room, which is what matching reads) is arrivesBy below. The code text alone never counts: the RSVP
//      link and the door QR carry the same code, so texting it proves nothing about being there (the 10-07 rule for walk-ins,
//      and the open question in #213). "I'm here" in the check-in window, after checking in, does.
//   2. Light intake over a few texts: who they are, what they do, who they're hoping to meet. Each question is asked at most
//      once, and one they already answered in passing is skipped (a short model read proposes what their text says; code keeps
//      only words they used). What they say lives in partner_guests, scoped to that night: it never enters co_profiles, the
//      people graph or anything a member's conversation reads.
//   3. The room closes (the same end every in-room reader uses, plus the room-close buffer): the night's code dies
//      (partners.closePartnerEvent) and each guest resolves. In this PR there is one exit: silence. Everything they told Cue
//      that night is deleted (their answers and the logged texts), and the row stays only as a dated tombstone with no words,
//      so the host read can count the room and a later text gets the after-cutoff line. A guest who joined the club in the
//      meantime keeps what they said: it's theirs, and it travels with them. Consent to be remembered and the invitation after
//      an intro are the partner arc (P5), after the strict double opt-in track.
//   4. After the cutoff: no proactive contact, ever (proactiveCutoff, read by every proactive send path in harness/proactive.ts).
//      If a former guest texts, Cue answers warmly once a day and doesn't work for them.
//
// Every word a guest reads is Royce's copy (services/partnerCopy.ts). A line still pending sends nothing, and a question that
// wasn't sent isn't counted as asked, so the intake picks up where it is once the copy lands.
//
// A member who texts a live night's code is not a guest: they get the walk-in path members already have (routes/sendblue.ts),
// checked in at the door during the check-in window.
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { effectiveEnd } from "../harness/introConsent.js";
import { AGENT, entryState, entryUrl, nextOpenNight, resolveEntryCode, type Partner, type PartnerEvent } from "./partners.js";
import { copyFor, type CopyKey, type CopyVars } from "./partnerCopy.js";
import { looksAutomated } from "./gateGuard.js";

export const GUESTS = {
  maxAnswer: 280,
  maxWho: 120,
  // How often a guest can get the same kind of line that isn't an answer to a question.
  duringNightEveryHours: 3,
  lateEveryHours: 24,
  // The room closes this long after the night's end (services/roomMatching.ts ROOM_CLOSE_BUFFER_MINUTES, the same buffer).
  closeBufferMinutes: 15,
} as const;

export type GuestRow = {
  id: string;
  event_api_id: string;
  user_id: string;
  entered_at: Date;
  arrived_at: Date | null;
  who: string | null;
  work: string | null;
  hoping: string | null;
  asked_who_at: Date | null;
  asked_work_at: Date | null;
  asked_hoping_at: Date | null;
  intake_done_at: Date | null;
  resolved_at: Date | null;
  resolution: "forgotten" | "joined" | null;
};

// who: who they are, in their own words (often just their name).
export type Field = "who" | "work" | "hoping";
const ASK: Record<Field, { at: "asked_who_at" | "asked_work_at" | "asked_hoping_at"; copy: CopyKey }> = {
  who: { at: "asked_who_at", copy: "guest_ask_who" },
  work: { at: "asked_work_at", copy: "guest_ask_work" },
  hoping: { at: "asked_hoping_at", copy: "guest_ask_hoping" },
};
const ORDER: Field[] = ["who", "work", "hoping"];

// ---------------------------------------------------------------- rules (pure)

// When the night's room closes: its end (effectiveEnd) plus the buffer, or when it was closed by hand, whichever is first.
export function nightClosesAt(e: Pick<PartnerEvent, "start_at" | "end_at" | "timezone" | "closed_at">): Date {
  const end = new Date(new Date(effectiveEnd({ start_at: e.start_at, end_at: e.end_at, timezone: e.timezone })).getTime() + GUESTS.closeBufferMinutes * 60_000);
  return e.closed_at && new Date(e.closed_at).getTime() < end.getTime() ? new Date(e.closed_at) : end;
}

// A guest's night is live until it closes and while they haven't been resolved.
export function guestLive(g: Pick<GuestRow, "resolved_at">, e: Pick<PartnerEvent, "start_at" | "end_at" | "timezone" | "closed_at">, now: Date): boolean {
  return !g.resolved_at && now.getTime() < nightClosesAt(e).getTime();
}

// The question the guest was last asked and hasn't answered: what their next text is read as.
export function openQuestion(g: Pick<GuestRow, Field | "asked_who_at" | "asked_work_at" | "asked_hoping_at">): Field | null {
  let last: { f: Field; at: number } | null = null;
  for (const f of ORDER) {
    const at = g[ASK[f].at];
    if (at && !g[f] && (!last || new Date(at).getTime() >= last.at)) last = { f, at: new Date(at).getTime() };
  }
  return last?.f ?? null;
}

// The next question, or done. Never asks twice: a question already asked is skipped whether or not it got an answer, and one
// they already answered in passing is skipped too.
export function nextQuestion(g: Pick<GuestRow, Field | "asked_who_at" | "asked_work_at" | "asked_hoping_at">): Field | null {
  return ORDER.find((f) => !g[f] && !g[ASK[f].at]) ?? null;
}

const words = (t: string) => (t.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);

// Their words only: a value the model proposes is kept only if every word in it is a word in their text (short joining words
// aside), so nothing is invented or scraped from anywhere else.
export function grounded(value: string, theirText: string): boolean {
  const have = new Set(words(theirText));
  const w = words(value);
  return w.length > 0 && w.every((x) => x.length < 3 || have.has(x));
}

// How someone arrives at a partner night (members who checked in with the code, and guests alike). Pending Royce's ruling on
// #213 (how a door-QR walk-in arrives), this is option B: checking in plus a later "I'm here" in the check-in window. The code
// text alone, from wherever it was sent, never puts anyone in the room. If #213 lands on A (a door-only token whose scan counts
// as arriving), the door QR gets its own token and "door_scan" returns true here; nothing else changes.
export type ArrivalSignal = "code_text" | "im_here" | "door_scan";
export function arrivesBy(signal: ArrivalSignal, inCheckinWindow: boolean): boolean {
  return inCheckinWindow && signal === "im_here";
}

export type IntakeProposal = Partial<Record<Field, string | null>>;

// What one text of theirs fills in. The open question gets their whole text when the read found nothing for it (it is their
// answer); anything the read found for other fields is kept only when it's grounded in their words; a field already filled is
// never overwritten.
export function applyAnswer(g: Pick<GuestRow, Field | "asked_who_at" | "asked_work_at" | "asked_hoping_at">, text: string, proposal: IntakeProposal): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  const open = openQuestion(g);
  const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);
  for (const f of ORDER) {
    if (g[f]) continue;
    const v = proposal[f];
    if (typeof v === "string" && v.trim() && grounded(v, text)) out[f] = clean(v, f === "who" ? GUESTS.maxWho : GUESTS.maxAnswer);
  }
  if (open && !out[open] && text.trim()) out[open] = clean(text, open === "who" ? GUESTS.maxWho : GUESTS.maxAnswer);
  return out;
}

// ---------------------------------------------------------------- the intake read

// A short read of one guest text: which of the three it answers, in their words. Nothing it says is kept unless grounded().
export async function readGuestText(text: string, open: Field | null): Promise<IntakeProposal> {
  const { text: raw } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { isEnabled: true, functionId: "partnerGuests.intakeRead", recordInputs: false, recordOutputs: false },
    prompt: `A guest at an event texted this${open ? ` in answer to "${open === "who" ? "who are you" : open === "work" ? "what do you do" : "who are you hoping to meet tonight"}"` : ""}:\n"${text.slice(0, 600)}"\n\nReturn JSON only: {"who": who they are (their name, or how they describe themselves) or null, "work": what they do or null, "hoping": who they're hoping to meet or null}. Use only their own words, copied exactly. null for anything they didn't say.`,
  });
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return { who: typeof j.who === "string" ? j.who : null, work: typeof j.work === "string" ? j.work : null, hoping: typeof j.hoping === "string" ? j.hoping : null };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- data

const GUEST_COLS = `id, event_api_id, user_id, entered_at, arrived_at, who, work, hoping, asked_who_at, asked_work_at, asked_hoping_at, intake_done_at, resolved_at, resolution`;

export async function guestRows(userId: string): Promise<(GuestRow & { event: PartnerEvent; partner: Partner })[]> {
  const { rows } = await pool.query(`SELECT ${GUEST_COLS} FROM partner_guests WHERE user_id = $1 ORDER BY entered_at DESC`, [userId]);
  const out: (GuestRow & { event: PartnerEvent; partner: Partner })[] = [];
  const { partnerEvent } = await import("./partners.js");
  for (const r of rows) {
    const found = await partnerEvent(r.event_api_id);
    if (found) out.push({ ...r, ...found });
  }
  return out;
}

// Lines that aren't answers (the during-night line, the late line, the after-cutoff line) are counted from the decision log,
// so a guest who keeps texting can't make Cue loop.
async function linesSince(userId: string, action: string, hours: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM harness_decisions WHERE user_id = $1 AND decision = 'partner.guestLine' AND action = $2 AND outcome = 'act' AND created_at > NOW() - ($3 || ' hours')::interval`,
    [userId, action, hours],
  );
  return rows[0]?.n ?? 0;
}

const record = (userId: string, action: string, outcome: "act" | "skip", reason?: string, proposal?: unknown) =>
  // No message content is ever logged here: the decision log isn't forgotten at close.
  recordDecision({ layer: 2, decision: "partner.guestLine", userId, outcome, action, reason, proposal }).catch(() => {});

// ---------------------------------------------------------------- the inbound text

export type GuestDeps = {
  now?: Date;
  resolve?: typeof resolveEntryCode;
  rows?: typeof guestRows;
  read?: typeof readGuestText;
  // A reply to their text (routes/sendblue.ts sendAndLog): sent and logged to their conversation.
  send: (line: string) => Promise<boolean>;
  // Logs their text to their conversation (deleted at close with the rest).
  log: (content: string) => Promise<void>;
  isCheckinOpen?: (e: { start_at: string; end_at?: string | null; timezone?: string | null }, now: Date) => boolean;
  isImHere?: (text: string) => boolean;
  inviteCodeIn?: (text: string) => Promise<boolean>;
  memberNight?: typeof memberPartnerNight;
};

// The partner night a member checked in at with its code (their walk-in row) whose check-in window is open now: where their
// "I'm here" lands. Null when none or more than one.
async function memberPartnerNight(userId: string, now: Date, checkinOpen: (e: { start_at: string; end_at?: string | null; timezone?: string | null }, now: Date) => boolean): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT e.api_id, e.start_at, e.end_at, e.timezone FROM event_walkin_checkins w JOIN partner_events e ON e.api_id = w.event_api_id
     WHERE w.person_id = $1 AND e.closed_at IS NULL`,
    [userId],
  );
  const open = rows.filter((r: any) => checkinOpen({ start_at: new Date(r.start_at).toISOString(), end_at: r.end_at ? new Date(r.end_at).toISOString() : null, timezone: r.timezone }, now));
  return open.length === 1 ? String(open[0].api_id) : null;
}

async function unusedInviteCodeIn(text: string): Promise<boolean> {
  const candidates = (await import("./inviteCodes.js")).inviteCodeCandidates(text);
  if (!candidates.length) return false;
  const { rows } = await pool.query(`SELECT 1 FROM invite_codes WHERE code = ANY($1::text[]) AND used_by IS NULL LIMIT 1`, [candidates]);
  return rows.length > 0;
}

export type GuestOutcome =
  | { handled: false; memberCheckin?: { eventApiId: string; eventName: string }; memberArrived?: { eventApiId: string } }
  | { handled: true; action: string };

// One inbound text from someone who might be a partner guest. Not handled means the normal flow takes it (the invite gate for a
// non-member who isn't a guest; the member's normal reply, with the walk-in check-in when it's a member at the door).
export async function handlePartnerText(user: { id: string; invite_verified: boolean }, text: string | null, deps: GuestDeps): Promise<GuestOutcome> {
  const now = deps.now ?? new Date();
  const resolve = deps.resolve ?? resolveEntryCode;
  const checkinOpen = deps.isCheckinOpen ?? (await import("./eventWalkinCheckin.js")).isCheckinOpen;
  const found = text ? await resolve(text).catch(() => null) : null;

  const imHere = deps.isImHere ?? (await import("./eventPresence.js")).isImHere;
  // A member: never a guest. A live night's code in the check-in window is their walk-in check-in (not their arrival); a
  // later "I'm here" at a partner night they checked in at is (arrivesBy). Co events' own arrival is untouched.
  if (user.invite_verified) {
    if (found && entryState(found.partner, found.event, now) === "open" && checkinOpen(found.event, now)) {
      return { handled: false, memberCheckin: { eventApiId: found.event.api_id, eventName: found.event.name } };
    }
    if (!found && text && imHere(text)) {
      const night = await (deps.memberNight ?? memberPartnerNight)(user.id, now, checkinOpen);
      if (night && arrivesBy("im_here", true)) return { handled: false, memberArrived: { eventApiId: night } };
    }
    return { handled: false };
  }

  // Never answer an automated sender (the invite gate's own rule, services/gateGuard.ts).
  if (text && looksAutomated(text)) return { handled: false };
  // A real, unused invite code goes to the invite gate, so a guest can join the club any time, the night included. Only a code
  // that exists: an ordinary eight-letter word ("hardware") is an answer, not a code.
  if (!found && text && (await (deps.inviteCodeIn ?? unusedInviteCodeIn)(text))) return { handled: false };

  const rows = await (deps.rows ?? guestRows)(user.id);
  const say = async (key: CopyKey, vars: CopyVars, action: string): Promise<boolean> => {
    const line = copyFor(key, { agent: AGENT, ...vars });
    if (!line) {
      await record(user.id, action, "skip", "copy pending");
      return false;
    }
    const sent = await deps.send(line);
    await record(user.id, action, sent ? "act" : "skip", sent ? undefined : "send failed");
    return sent;
  };

  if (found) {
    const state = entryState(found.partner, found.event, now);
    const vars = { event: found.event.name, partner: found.partner.name };
    if (state === "open") {
      if (text) await deps.log(`User said: ${text}`);
      // The code text is their consent and check-in, never their arrival by itself (arrivesBy).
      const arrives = arrivesBy("code_text", checkinOpen(found.event, now));
      const { rows: up } = await pool.query(
        `INSERT INTO partner_guests (event_api_id, user_id, entered_at, arrived_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_api_id, user_id) DO UPDATE SET arrived_at = COALESCE(partner_guests.arrived_at, EXCLUDED.arrived_at)
           WHERE partner_guests.resolved_at IS NULL
         RETURNING ${GUEST_COLS}, (xmax = 0) AS fresh`,
        [found.event.api_id, user.id, now, arrives ? now : null],
      );
      const g = up[0] as (GuestRow & { fresh: boolean }) | undefined;
      if (!g) return { handled: true, action: "guest_resolved" };
      await record(user.id, g.fresh ? "entered" : "reentered", "act", undefined, { eventId: found.event.api_id, arrives });
      // The code again (the door QR after the RSVP link): nothing new to ask once intake is done.
      return { handled: true, action: await continueIntake(g, found.event, found.partner, null, deps, say) };
    }
    // A code that isn't live: one line a day, and nothing recorded about them.
    const action = state === "not_open" ? "not_open" : "late";
    if ((await linesSince(user.id, action, GUESTS.lateEveryHours)) > 0) return { handled: true, action: `${action}_quiet` };
    if (state === "not_open") await say("guest_not_open", vars, action);
    else {
      const next = state === "over" ? await nextOpenNight(found.partner, found.event.api_id, now).catch(() => null) : null;
      const link = next ? entryUrl(next.code) : null;
      if (!(next && link && (await say("guest_late_next", { ...vars, next: next.name, link }, action)))) await say("guest_late", vars, action);
    }
    return { handled: true, action };
  }

  // No code: a guest's ongoing texts, or a former guest after the cutoff.
  if (!rows.length) return { handled: false };
  const live = rows.find((r) => guestLive(r, r.event, now));
  if (!live) {
    // Not logged: after the cutoff nothing they say is kept.
    if ((await linesSince(user.id, "after_cutoff", GUESTS.lateEveryHours)) > 0) return { handled: true, action: "after_cutoff_quiet" };
    const last = rows[0];
    await say("guest_after_cutoff", { event: last.event.name, partner: last.partner.name }, "after_cutoff");
    return { handled: true, action: "after_cutoff" };
  }
  if (text) await deps.log(`User said: ${text}`);
  // "I'm here" on the night, after checking in, is their arrival (arrivesBy). It's never read as an intake answer.
  if (text && imHere(text)) {
    if (!live.arrived_at && arrivesBy("im_here", checkinOpen(live.event, now))) {
      await pool.query(`UPDATE partner_guests SET arrived_at = $2 WHERE id = $1 AND arrived_at IS NULL`, [live.id, now]);
      await record(user.id, "arrived", "act", undefined, { eventId: live.event_api_id });
      if (live.intake_done_at) {
        await say("guest_arrived", { event: live.event.name, partner: live.partner.name }, "arrived");
        return { handled: true, action: "guest_arrived" };
      }
    }
    return { handled: true, action: await continueIntake(live, live.event, live.partner, null, deps, say) };
  }
  return { handled: true, action: await continueIntake(live, live.event, live.partner, text, deps, say) };
}

// One step of the intake: their text answers the open question (and anything else it says), then the next question, or the
// done line once, or the during-night line at most every few hours.
async function continueIntake(
  g: GuestRow,
  event: PartnerEvent,
  partner: Partner,
  text: string | null,
  deps: GuestDeps,
  say: (key: CopyKey, vars: CopyVars, action: string) => Promise<boolean>,
): Promise<string> {
  const vars = { event: event.name, partner: partner.name };
  let row = g;
  if (text && !g.intake_done_at) {
    const open = openQuestion(g);
    const proposal = await (deps.read ?? readGuestText)(text, open).catch(() => ({}) as IntakeProposal);
    const fill = applyAnswer(g, text, proposal);
    const keys = Object.keys(fill) as Field[];
    if (keys.length) {
      // Only ever fills a field still empty, so a second text can't overwrite what they already said.
      const { rows } = await pool.query(
        `UPDATE partner_guests SET who = COALESCE(who, $2), work = COALESCE(work, $3), hoping = COALESCE(hoping, $4) WHERE id = $1 AND resolved_at IS NULL RETURNING ${GUEST_COLS}`,
        [g.id, fill.who ?? null, fill.work ?? null, fill.hoping ?? null],
      );
      if (rows[0]) row = rows[0];
    }
  }
  if (row.intake_done_at) {
    if ((await linesSince(row.user_id, "during_night", GUESTS.duringNightEveryHours)) > 0) return "during_night_quiet";
    await say("guest_during_night", vars, "during_night");
    return "during_night";
  }
  // Still waiting on their answer to the last question (they sent a photo, say): nothing new is asked over it.
  if (openQuestion(row)) return "waiting";
  const next = nextQuestion(row);
  if (next) {
    // Counted as asked only once it went out: a question whose copy is pending is asked when the copy lands.
    if (await say(ASK[next].copy, vars, `ask_${next}`)) {
      await pool.query(`UPDATE partner_guests SET ${ASK[next].at} = NOW() WHERE id = $1 AND ${ASK[next].at} IS NULL`, [row.id]);
    }
    return `ask_${next}`;
  }
  // Everything asked once and answered: done, said once.
  if (await say("guest_intake_done", vars, "intake_done")) {
    await pool.query(`UPDATE partner_guests SET intake_done_at = NOW() WHERE id = $1 AND intake_done_at IS NULL`, [row.id]);
  }
  return "intake_done";
}

// ---------------------------------------------------------------- the cutoff

// Pure: whether Cue may text this person first. A member: yes (the usual gates still apply). Someone who was only ever a
// partner guest: only while one of their nights is live, and never after (in this PR nothing texts a guest first at all; the
// intros track will, inside the night). Anyone else isn't decided here.
export function cutoffCheck(o: { member: boolean; guestNights: { resolved_at: Date | null; closes_at: Date }[] }, now: Date): GateCheck {
  const name = "partner_guest_cutoff";
  if (o.member || !o.guestNights.length) return { name, pass: true };
  const live = o.guestNights.some((n) => !n.resolved_at && now.getTime() < new Date(n.closes_at).getTime());
  return live ? { name, pass: true, reason: "a partner guest whose night is on" } : { name, pass: false, reason: "a partner guest after the cutoff: no proactive contact, ever" };
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

// Read at every proactive send (harness/proactive.ts). A failed read holds the send: silence over a text after the cutoff.
export async function proactiveCutoff(userId: string, now = new Date(), db: Queryable = pool): Promise<GateCheck> {
  try {
    const { rows } = await db.query(
      `SELECT coalesce(u.invite_verified, false) AS member, g.resolved_at, e.start_at, e.end_at, e.timezone, e.closed_at
       FROM users u LEFT JOIN partner_guests g ON g.user_id = u.id LEFT JOIN partner_events e ON e.api_id = g.event_api_id
       WHERE u.id = $1`,
      [userId],
    );
    const member = rows[0]?.member === true;
    const guestNights = rows
      .filter((r) => r.start_at)
      .map((r) => ({ resolved_at: r.resolved_at ? new Date(r.resolved_at) : null, closes_at: nightClosesAt({ start_at: new Date(r.start_at).toISOString(), end_at: r.end_at ? new Date(r.end_at).toISOString() : null, timezone: r.timezone ?? null, closed_at: r.closed_at ? new Date(r.closed_at) : null }) }));
    return cutoffCheck({ member, guestNights }, now);
  } catch (err: any) {
    return { name: "partner_guest_cutoff", pass: false, reason: `couldn't read guest state (${String(err?.message ?? err).slice(0, 80)}); held` };
  }
}

// The room closes for each partner night that's due: its code dies for good and each guest resolves. Every 5 minutes with the
// room-close job (jobs/index.ts). Returns what it did, for the log.
export async function runPartnerNightCloses(now = new Date()): Promise<{ eventId: string; forgotten: number; joined: number }[]> {
  const { closePartnerEvent } = await import("./partners.js");
  const { rows } = await pool.query(
    `SELECT DISTINCT e.api_id, e.start_at, e.end_at, e.timezone, e.closed_at FROM partner_events e
     LEFT JOIN partner_guests g ON g.event_api_id = e.api_id AND g.resolved_at IS NULL
     WHERE (e.closed_at IS NULL OR g.id IS NOT NULL) AND e.start_at < $1`,
    [now],
  );
  const out: { eventId: string; forgotten: number; joined: number }[] = [];
  for (const r of rows) {
    const e = { start_at: new Date(r.start_at).toISOString(), end_at: r.end_at ? new Date(r.end_at).toISOString() : null, timezone: r.timezone ?? null, closed_at: r.closed_at ? new Date(r.closed_at) : null };
    if (now.getTime() < nightClosesAt(e).getTime()) continue;
    await closePartnerEvent(r.api_id);
    out.push({ eventId: r.api_id, ...(await resolveGuests(r.api_id, now)) });
  }
  return out;
}

// Forget by default. Each guest of a closed night: one who joined the club keeps what they said (it's theirs); everyone else
// is forgotten: their answers are wiped from the row, and their logged texts since their first text for this night are
// deleted, unless another of their nights is still live (those texts are deleted when that one closes).
export async function resolveGuests(eventId: string, now = new Date()): Promise<{ forgotten: number; joined: number }> {
  const { rows } = await pool.query(
    `SELECT g.id, g.user_id, coalesce(u.invite_verified, false) AS member FROM partner_guests g JOIN users u ON u.id = g.user_id
     WHERE g.event_api_id = $1 AND g.resolved_at IS NULL`,
    [eventId],
  );
  let forgotten = 0;
  let joined = 0;
  for (const r of rows) {
    if (r.member) {
      await pool.query(`UPDATE partner_guests SET resolved_at = $2, resolution = 'joined' WHERE id = $1 AND resolved_at IS NULL`, [r.id, now]);
      joined++;
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const done = await client.query(
        `UPDATE partner_guests SET resolved_at = $2, resolution = 'forgotten', who = NULL, work = NULL, hoping = NULL WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
        [r.id, now],
      );
      if (done.rows.length) {
        const others = await client.query(`SELECT 1 FROM partner_guests WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1`, [r.user_id]);
        if (!others.rows.length) {
          // Their texts with Cue since their first partner text that was forgotten. A non-member has nothing else on file.
          await client.query(
            `DELETE FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange'
               AND created_at >= (SELECT min(entered_at) FROM partner_guests WHERE user_id = $1 AND resolution = 'forgotten')`,
            [r.user_id],
          );
        }
        forgotten++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("partnerGuests: forgetting a guest failed (retried next pass):", (err as any)?.message ?? err);
    } finally {
      client.release();
    }
  }
  await recordDecision({ layer: 6, decision: "partner.nightClosed", userId: null, outcome: "act", action: "resolve", proposal: { eventId, forgotten, joined } }).catch(() => {});
  return { forgotten, joined };
}
