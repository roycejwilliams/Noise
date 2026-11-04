// What's waiting for a member (Royce, 2026-11-02, notification grouping part C, item 9: "Pull. 'Anything for me?' returns everything waiting,
// best first. What Cue knows shows what's waiting. A reply may mention one waiting item"). Part A (harness/door.ts) made everything Cue
// starts a candidate at one door; the pick sends from there. This is the member's side of the same door:
//
//   the list      what the pick is holding for them: pending, due, not past its valid-until, not a type that's paused or parked, and not
//                 about something they closed. Best first by the door's own bands (matching first: a possible intro, then requested
//                 results, a find, a check-in), then the pick's own order. Expired items are never in it (and are dropped by the dispatch's
//                 expiry, logged by id).
//   what to say   a label that names nothing but the item itself (an event is its public name; a possible intro is only "someone I think
//                 you should meet", never a name or where it stands for the other person), stripped of other members' details like
//                 every line of what Cue knows. A read that can't strip returns nothing, never an unstripped label.
//   pull          "anything for me?" runs the pick right now, as the answer to their text (harness/proactive.ts DispatchOpts.pulled): the
//                 same bands, caps (three texts, or two finds with their captions, in one message), expiry, closed-subject and draft
//                 checks, and the same send-time ledger, so what went is marked sent, counts, can't be sent again and lands in the exchange
//                 record. Their own rules still hold it; their hours, the gathering window, the spacing and the conversation going on do not
//                 (they asked). It never reveals more than the message itself would have.
//   one mention   a normal reply may mention one waiting item, only when it fits (waitingMention): an instruction to the reply, nothing sent.
//   calls         a call's briefing carries the same list (callWaitingLines), spoken best first, at most MAX_SPOKEN, never sent mid-call.
import pool from "../db/db.js";
import { heldTypes } from "../services/proactivePause.js";
import { BAND_NAME, type Band } from "./door.js";
import { isPossibleIntro } from "./attention.js";
import type { Candidate } from "./proactive.js";

// How much one pull sends or one call says: the door's own limits (at most 3 bubbles, or 2 find links with captions; the composer and the
// bundle cap enforce the send side, MAX_PICKED_TOGETHER). A call speaks no more than three.
export const MAX_SPOKEN = 3;
// How long a pull waits for the pick (drafts are model calls); past it the pick goes on by itself and the member is told it's coming.
export const PULL_TIMEOUT_MS = 15_000;
// How long a pull waits for a pick already running for this member before it runs itself (or says nothing can go).
export const PULL_BUSY_WAIT_MS = 5_000;

// held: the names of the pick's own checks that stop it going now (safety_hold, away_hold, kind_restraint, emotional_timing, hard_day,
// team_hold, member_rule, ...). Empty: it could go on a pull right now.
export type WaitingItem = { id: string; type: string; band: Band; label: string; intro: boolean; expiresAt: Date | null; held: string[] };
export const couldGo = (items: WaitingItem[]): WaitingItem[] => items.filter((i) => i.held.length === 0);
// A safety hold hides the item altogether; any other hold is shown as held.
export const visibleHeld = (items: WaitingItem[]): WaitingItem[] => items.filter((i) => !i.held.includes("safety_hold"));

// Pure: what the member is told an item is. Nothing about anyone else: a possible intro is never named and its state never said.
export function waitingLabel(c: Pick<Candidate, "type" | "payload" | "targetKey">): string {
  const p = (c.payload ?? {}) as { match?: { name?: unknown } | null; door?: boolean; cls?: string; heavy?: unknown };
  if (isPossibleIntro(c)) return "someone I think you should meet";
  if (c.type === "event_offer") {
    const name = typeof p.match?.name === "string" ? p.match.name.trim().slice(0, 100) : "";
    return name ? `a find for you: ${name}` : "something I found for you";
  }
  if (p.door === true) return p.cls === "requested" ? "what you asked me for" : "something I found for you";
  return "a note from me";
}

// Pure: the pending candidates as the member's list: due, unexpired, best first. closed: the ids of candidates whose subject they closed.
export function waitingFrom(cands: Candidate[], now: Date, o: { band: (c: Candidate) => Band; closed?: Set<string>; label?: (c: Candidate) => string | null; held?: (c: Candidate) => string[] }): WaitingItem[] {
  const t = now.getTime();
  return cands
    .filter((c) => c.dueAt.getTime() <= t && (!c.expiresAt || c.expiresAt.getTime() > t) && !o.closed?.has(c.id))
    .map((c) => ({ c, band: o.band(c) }))
    .sort((a, b) => b.band - a.band || b.c.priority - a.c.priority || (a.c.expiresAt?.getTime() ?? Infinity) - (b.c.expiresAt?.getTime() ?? Infinity) || a.c.createdAt.getTime() - b.c.createdAt.getTime())
    .flatMap(({ c, band }) => {
      const label = o.label ? o.label(c) : waitingLabel(c);
      return label ? [{ id: c.id, type: c.type, band, label, intro: isPossibleIntro(c), expiresAt: c.expiresAt, held: o.held ? o.held(c) : [] }] : [];
    });
}

// What's waiting for this member now. Never throws: a read that fails is "nothing to show", not a guess (callers that need to say
// "nothing" use waitingOrNull).
export async function waitingOrNull(userId: string, now: Date = new Date()): Promise<WaitingItem[] | null> {
  try {
    const P = await import("./proactive.js");
    const { rows } = await pool.query(
      `SELECT * FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND due_at <= $2 AND (expires_at IS NULL OR expires_at > $2) AND NOT (type = ANY($3::text[]))`,
      [userId, now, heldTypes()],
    );
    const { proactiveRegistry } = await import("./proactiveRegistry.js");
    const cands = (rows as any[]).map(P.rowToCandidate).filter((c) => c.type in proactiveRegistry);
    if (!cands.length) return [];
    const { loadClosedSubjects } = await import("./closedSubject.js");
    const closed = await loadClosedSubjects(userId);
    const dead = new Set(P.closedAmong(cands, closed).map((f) => f.candidate.id));
    // Other members' details out of every label, failing closed (services/memberSafeMemories.ts).
    const { memberSafeLine } = await import("../services/memberSafeMemories.js");
    const safe = await memberSafeLine(userId);
    // Through the pick's own checks: what could go now, and what is held and why. A read that can't be made holds everything.
    const checks = await P.pulledChecks(userId, cands, now);
    return waitingFrom(cands, now, { band: (c) => P.bandOfCandidate(c, now), closed: dead, label: (c) => safe(waitingLabel(c)), held: (c) => (checks ? checks.get(c.id) ?? [] : ["unread"]) });
  } catch (err: any) {
    console.error("waiting: the list couldn't be read (non-fatal):", err?.message ?? err);
    return null;
  }
}
export async function loadWaiting(userId: string, now: Date = new Date()): Promise<WaitingItem[]> {
  return (await waitingOrNull(userId, now)) ?? [];
}

// ---------------------------------------------------------------- what the reply and the call are told

// Pure: the one line a normal reply may use. The first item that isn't a possible intro (an intro goes through its own consent and is never
// raised in passing), and never when the member's own turn is already asking for the list (the pull answers that). null: nothing to mention.
export function waitingMention(items: WaitingItem[]): string | null {
  items = couldGo(items);
  const one = items.find((i) => !i.intro);
  if (!one) return null;
  return `Cue is holding ${items.length === 1 ? "one thing" : `${items.length} things`} for them. This reply may mention at most one of them, in a short clause, and only if it fits what they're talking about right now: "${one.label}". Never list them, never say more than that one, and leave it out if the conversation is about something else or they're having a hard time. If they ask whether there's anything for them, use anythingForMe.`;
}

// Pure: the same list on a call (services/callBriefing.ts), in the call brain's own terms. Best first, at most MAX_SPOKEN, labels only.
// Spoken, never sent mid-call; offered as a text. Nothing here is delivered or marked delivered by the call.
export function callWaitingLines(items: WaitingItem[]): string[] {
  items = couldGo(items);
  const shown = items.slice(0, MAX_SPOKEN);
  if (!shown.length) return [];
  return [
    `Cue is holding ${items.length} thing${items.length === 1 ? "" : "s"} for them. Only if they ask whether there's anything for them (or it plainly fits), say them best first, at most ${MAX_SPOKEN}, in your own words from these labels and nothing more. Don't promise to text the details or say when anything will arrive; they can ask in a text:`,
    ...shown.map((i) => `- ${i.label} (${BAND_NAME[i.band]})`),
  ];
}

// ---------------------------------------------------------------- pull

export type PullResult =
  | { status: "nothing" }
  | { status: "sent"; delivered: string[]; ids: string[]; left: number }
  | { status: "none_ready"; waiting: number }
  | { status: "busy" }
  | { status: "slow" }
  | { status: "unread" };

// "Anything for me?": the pick, now, as the answer to their text. Returns what went (the delivered texts), or why nothing did. Bounded
// (PULL_TIMEOUT_MS in all): a pick already running is waited for a moment, then this one runs; if the lock still can't be had, or the
// pick doesn't finish in time, it says so and promises nothing.
export async function pullWaiting(userId: string, o: { now?: Date; timeoutMs?: number; busyWaitMs?: number } = {}): Promise<PullResult> {
  const t0 = Date.now();
  const total = o.timeoutMs ?? PULL_TIMEOUT_MS;
  const now = o.now ?? new Date();
  const items = await waitingOrNull(userId, now);
  if (items === null) return { status: "unread" };
  if (!items.length) return { status: "nothing" };
  const ready = couldGo(items);
  if (!ready.length) return { status: "none_ready", waiting: items.length };
  const P = await import("./proactive.js");
  const { proactiveRegistry } = await import("./proactiveRegistry.js");
  // A pick already running for this member: wait for it a moment (the lock is taken atomically by pullDispatch, so nothing slips between).
  const busyUntil = Date.now() + (o.busyWaitMs ?? PULL_BUSY_WAIT_MS);
  while (P.dispatchBusy(userId) && Date.now() < busyUntil) await new Promise((r) => setTimeout(r, 200));
  const went: { delivered: string[]; ids: string[] } = { delivered: [], ids: [] };
  let ran = false;
  const run = P.pullDispatch(proactiveRegistry, userId, { pulled: true, onWent: (w) => (went.delivered.push(...w.delivered), went.ids.push(...w.candidates)) }).then((r) => { ran = r; return "done" as const; });
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<"slow">((r) => { t = setTimeout(() => r("slow"), Math.max(1000, total - (Date.now() - t0))); t.unref?.(); });
  try {
    const first = await Promise.race([run, timeout]);
    if (first === "slow" && !went.delivered.length) return { status: "slow" };
  } finally {
    if (t) clearTimeout(t);
  }
  if (!went.delivered.length) return ran ? { status: "none_ready", waiting: items.length } : { status: "busy" };
  const left = couldGo((await waitingOrNull(userId, new Date())) ?? []);
  return { status: "sent", delivered: went.delivered, ids: went.ids, left: left.length };
}
