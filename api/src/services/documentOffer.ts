// Offering to write something up (Royce, 2026-10-07). When someone is stuck, vague or circling on their team or their goal, a
// written page is a kind thing to offer. Same shape as the member brief's name question (services/eventBrief.ts): code NOTICES from
// member state, Co OFFERS once in its own words, and nothing is made until they say yes.
//
//   notice  documentOfferDue (pure): an open ask for guidance that has sat for days, a feeling about something that keeps coming up
//           (uncertain, confused, overwhelmed, discouraged), or an open thread they feel unsure about. While they are having a hard
//           time (needsCare: grief, exhaustion) it waits, never cancelled: it stays owed and goes once they're okay again, at the
//           latest at the mood cap (services/moodHold.ts; offerMoodHeld below, and in a reply the heavy-moment gate, replyGrounding.ts
//           heavyHold). Never inside two weeks of an earlier offer, never the same topic twice, never right after a document, never
//           while an offer is still waiting on an answer.
//   offer   Co's tool offerDocument (agent/loopTools.ts) re-checks the same rules in code, records the offer, and Co writes the
//           offer itself. The notice only hands Co a hint; Co decides whether this message is the moment.
//   yes     writeDocument needs their own yes in the message (the registry's `confirm`, agent/toolGuard.ts), whether they are
//           answering the offer or asking for a document themselves.
// "Never push it twice if they pass": an offer is made once per topic and once per fortnight, whatever the answer; an unanswered or
// declined offer is not asked again. Read only with the owner's user id.
import pool from "../db/db.js";
import { getEmotionalContext } from "../harness/emotion.js";
import { asksToResend } from "./documentDelivery.js";
import { driftLine, type Drift } from "./receiptDrift.js";
import { MOOD_HOLD_CAP_HOURS, moodHold, type MoodHold } from "./moodHold.js";

export const OFFER = {
  helpAskDays: 2, // an ask for guidance open this long
  threadDays: 2, // a thread open this long
  recurringMin: 2, // the same feeling about the same thing this many times in two weeks
  cooldownDays: 14, // after any offer
  afterDocumentDays: 3, // after a document was written
  waitingHours: 48, // an offer this recent is still waiting on its answer
};

// Feelings that mean "I don't know which way to go" (not grief, exhaustion or anger at Co: those are care, not direction).
const DIRECTION = /uncertain|unsure|confus|overwhelm|discourag|stuck|lost|torn|nervous|pressur|stress|indecis|clarif|doubt/i;
const CARE = /grief|exhaust|burn|lonel|hopeless|panic|crisis/i;

export type OfferHistoryRow = { topic: string; source: "offered" | "asked"; status: "offered" | "accepted"; at: Date };

// What is being offered (2026-10-08 review A1-A3, A5). One record (document_offers), the kind carried as a prefix on the topic
// ("[plan] dinner at Rich Table, Friday"); a row with no prefix is a document offer, as every row before this was.
//   document  a write-up when they're circling on something (the original offer)
//   plan      (retired 2026-11-04: never offered; kept so old history rows still parse)
//   brief     (retired 2026-11-04: never offered; kept so old history rows still parse)
//   drift     a new version of a delivered document that's gone stale (services/receiptDrift.ts), once per version
//   recap     a one-page recap of a call that landed a decision (jobs/postCallFollowUp.ts)
export const OFFER_KINDS = ["document", "plan", "brief", "drift", "recap"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];
export const kindTopic = (kind: OfferKind, topic: string) => (kind === "document" ? topic : `[${kind}] ${topic}`).slice(0, 240);
export function parseTopic(topic: string): { kind: OfferKind; text: string } {
  const m = String(topic).match(/^\[(plan|brief|drift|recap)\]\s*(.*)$/s);
  return m ? { kind: m[1] as OfferKind, text: m[2] } : { kind: "document", text: String(topic) };
}
export type OfferState = {
  now: Date;
  helpAsks: { text: string; ageDays: number }[];
  threads: { text: string; feeling: string | null; ageDays: number }[];
  recurring: { about: string; emotions: string[]; count: number }[];
  needsCare: boolean;
  // Whether that hard time still holds an offer now (services/moodHold.ts): it ends when they're okay again or at the cap. Missing (a
  // state built without the read's times): struggling holds, as before.
  moodHold?: MoodHold | null;
  // A heavy moment in this very message (a high-intensity hard feeling): no offer of any kind this turn.
  heavyNow?: boolean;
  history: OfferHistoryRow[];
};
export type OfferDecision = { due: true; topic: string; why: string } | { due: false; why: string };

const STOP = new Set("their about with that this have from what your they them been into over they're want need help some more than then when where which would could should being those these there it's".split(" "));
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
// The same topic: most of the shorter one's real words are in the other.
export function sameTopic(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.5;
}
const days = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 86_400_000;

// A hard time decides when, never whether (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). While they're
// struggling (needsCare) an offer waits: it isn't recorded, so it stays owed (the notice is read again every reply, from the same open
// asks, threads and feelings), and it goes once they're okay again (the read clears, or they text normally) or at the latest
// MOOD_HOLD_CAP_HOURS into the hard stretch, whatever the read says then. Only the offer waits: what it's about keeps its own clock
// (an ask that closes, a plan that passes, the fortnight cooldown, once per topic). In a reply the heavy-moment gate (replyGrounding.ts
// heavyHold, the same cap) decides instead, logs it (heavy_offer_hold) and adds the gentle tone at release; this gate holds the
// offerDocument tool and any caller without that moment.
export const OFFER_MOOD_WAIT = `they are having a hard time; the offer waits until they're okay, at most ${MOOD_HOLD_CAP_HOURS}h into it`;
export function offerMoodHeld(s: Pick<OfferState, "needsCare" | "moodHold">): boolean {
  return !!s.needsCare && (s.moodHold ? s.moodHold.hold : true);
}

// Pure: the rules every offer shares, whatever it offers. A hard time makes it wait (offerMoodHeld, capped), never cancels it; a heavy
// moment waits too (heavyNow); never while an offer waits on its answer; one offer a fortnight (a stale document's fix is exempt: it's
// about something they already have, once per version).
export function offerGate(s: Pick<OfferState, "now" | "needsCare" | "moodHold" | "heavyNow" | "history">, kind: OfferKind = "document"): string | null {
  if (offerMoodHeld(s)) return OFFER_MOOD_WAIT;
  if (s.heavyNow) return "this message is a heavy moment; the offer waits for a later reply"; // mood: heavyNow arrives as the capped heavyHold (replyGrounding.ts); the recap's heavy call is documented under postCallFollowUp.ts
  const recent = s.history.filter((h) => h.source === "offered");
  const waiting = recent.find((h) => h.status === "offered" && (s.now.getTime() - h.at.getTime()) / 3_600_000 < OFFER.waitingHours);
  if (waiting) return "an offer is still waiting on their answer";
  if (kind !== "drift" && recent.some((h) => parseTopic(h.topic).kind !== "drift" && days(h.at, s.now) < OFFER.cooldownDays)) return "Cue offered within the last two weeks";
  return null;
}
// Pure: offered before, same kind, same thing (never the same topic twice, whatever the answer was).
export function offeredBefore(history: OfferHistoryRow[], kind: OfferKind, topic: string): boolean {
  return history.some((h) => {
    const t = parseTopic(h.topic);
    return t.kind === kind && (kind === "drift" || kind === "recap" ? t.text.trim() === topic.trim() : sameTopic(t.text, topic));
  });
}

// Pure: is this a moment Co may offer to write something up, and about what.
export function documentOfferDue(s: OfferState): OfferDecision {
  const gate = offerGate(s, "document");
  if (gate) return { due: false, why: gate };
  if (s.history.some((h) => h.status === "accepted" && days(h.at, s.now) < OFFER.afterDocumentDays)) return { due: false, why: "a document was just written for them" };
  const done = (topic: string) => offeredBefore(s.history, "document", topic);

  const stuckThreads = s.threads.filter((t) => t.ageDays >= OFFER.threadDays && t.feeling && DIRECTION.test(t.feeling) && !CARE.test(t.feeling));
  const circling = s.recurring.filter((r) => r.count >= OFFER.recurringMin && r.emotions.some((e) => DIRECTION.test(e)) && !r.emotions.some((e) => CARE.test(e)));
  const helpAsks = s.helpAsks.filter((a) => a.ageDays >= OFFER.helpAskDays);

  // Strongest first: asking for guidance AND feeling it; then asking; then the feeling alone.
  for (const a of helpAsks) {
    const feels = circling.find((r) => sameTopic(r.about, a.text)) ?? stuckThreads.find((t) => sameTopic(t.text, a.text));
    if (feels && !done(a.text)) return { due: true, topic: a.text, why: `they asked for guidance on this ${Math.floor(a.ageDays)} days ago, and it keeps coming up unsettled` };
  }
  for (const a of helpAsks) if (!done(a.text)) return { due: true, topic: a.text, why: `they asked for guidance on this and it has stayed open for ${Math.floor(a.ageDays)} days` };
  for (const r of circling) if (!done(r.about)) return { due: true, topic: r.about, why: `${r.emotions.join(", ")} about this has come up ${r.count} times in two weeks` };
  for (const t of stuckThreads) if (!done(t.text)) return { due: true, topic: t.text, why: `they feel ${t.feeling} about this and it has been open ${Math.floor(t.ageDays)} days` };
  return { due: false, why: "nothing they are unsure about right now" };
}

// ---------------------------------------------------------------- the other artifacts: a stale document (a plan sheet and a venue brief are no longer offered)

// What code can see beyond the document notice: their working notes, the latest plan email, what they already have, and what Co is
// already carrying for them. Loaded once a turn (loadArtifactSignals); every decision on it is pure.
export type ArtifactSignals = {
  notes: { kind: string | null; what: string | null; picked: string | null; when: string | null; headcount: number | null; city: string | null; area: string | null; updatedAt: Date | null } | null;
  emailPlanAt: Date | null;
  // Newest delivered documents (services/deliveryReceipts.ts), title and kind, so nothing they already have is offered.
  delivered: { title: string; kind: string | null; at: Date }[];
  // Goals of the work Co already has under way for them: open tasks and research briefs.
  openWork: string[];
  // Delivered documents that no longer match what's true (services/receiptDrift.ts).
  drift: Drift[];
};
export type ArtifactState = OfferState & ArtifactSignals & { message: string; coLines: string[] };
export type ArtifactDecision = { due: true; kind: OfferKind; topic: string; why: string; line: string } | { due: false; kind: OfferKind; why: string };

// Clock times in a line ("7pm", "7:30 pm", "19:00"), distinct.
export function timesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text).matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) out.add(`${(Number(m[1]) % 12) + (/^p/i.test(m[3]) ? 12 : 0)}:${m[2] ?? "00"}`);
  for (const m of String(text).matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s?(?:a\.?m|p\.?m))/gi)) out.add(`${Number(m[1])}:${m[2]}`);
  return [...out];
}
// Pure: a walkthrough of timed steps (4 or more, each on its own line or sentence with its own time).
export function timedSteps(text: string): number {
  return String(text).split(/\n+|(?<=[.!?])\s+/).filter((l) => timesIn(l).length > 0).length;
}

const HOSTING = /\b(?:host(?:ing)?|throw(?:ing)?|put(?:ting)? on|organi[sz](?:e|ing)|run(?:ning)? (?:a|an|our|my)|plan(?:ning)? (?:a|an|our|my))\b[^.?!]{0,60}\b(?:dinner|party|event|offsite|off-site|meetup|mixer|salon|gathering|launch|retreat|happy hour|reception|celebration|night)\b/i;
const SIZE = /\b\d{1,4}\s*(?:people|guests|of us|ppl|pax|founders|folks|heads)\b|\bfor (?:about |around |~)?\d{1,4}\b/i;
const DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(?:tomorrow|tonight|this weekend|next week|next month)\b|\b\d{1,2}\/\d{1,2}\b/i;
const hasIt = (list: { title: string; kind: string | null; at: Date }[], topic: string, kinds: string[], within: number, now: Date) =>
  list.some((d) => (now.getTime() - d.at.getTime()) / 86_400_000 < within && ((d.kind && kinds.includes(d.kind)) || sameTopic(d.title, topic)));

// Pure: may Co offer this kind of artifact in this reply, and what. Hints only: the tools stay gated on their own yes.
export function artifactOfferDue(kind: OfferKind, s: ArtifactState): ArtifactDecision {
  const gate = offerGate(s, kind);
  if (gate) return { due: false, kind, why: gate };
  const lastCo = s.coLines[s.coLines.length - 1] ?? "";
  if (kind === "drift") {
    const d = s.drift.find((x) => !offeredBefore(s.history, "drift", x.key));
    if (!d) return { due: false, kind, why: s.drift.length ? "already offered for this version" : "nothing they have is out of date" };
    return { due: true, kind, topic: kindTopic("drift", d.key), why: d.reasons.join("; "), line: `${driftLine(d)} If it fits this message, you may say so once, plainly, and offer the corrected version; on a yes, readDocument ${d.docId}, then writeDocument with revises ${d.docId} and changed saying what changed. Only once for this version; if it doesn't fit, leave it.` };
  }
  // A sheet and a venue brief are not offered any more (2026-11-04: plan sheets and research briefs as documents were removed).
  if (kind === "plan" || kind === "brief") return { due: false, kind, why: "Cue no longer offers a sheet or a brief" };
  return { due: false, kind, why: "document offers go through documentOfferDue" };
}

// Pure: the one artifact offer for this reply, if any (at most one offer per reply). A stale document first (it's about what they
// already hold), then nothing else; the document notice is separate (documentOfferDue) and yields to these.
export const ARTIFACT_ORDER: OfferKind[] = ["drift"];
export function nextArtifactOffer(s: ArtifactState): Extract<ArtifactDecision, { due: true }> | null {
  for (const k of ARTIFACT_ORDER) {
    const d = artifactOfferDue(k, s);
    if (d.due) return d;
  }
  return null;
}

// Pure: did a text Co sent make an offer of this kind (bookkeeping for the record, never a gate on what Co says).
const OFFER_ASK = /\b(?:want me to|should i|shall i|would it help (?:if i|to)|happy to|i can|i could|would you like me to|like me to)\b/i;
const KIND_NOUN: Record<OfferKind, RegExp> = {
  document: /\b(?:write (?:it|this|that) up|write-?up|doc(?:ument)?|pdf|one-?pager)\b/i,
  plan: /\b(?:sheet|one-?pager|one page|on (?:a|one) page|itinerary|printable)\b/i,
  brief: /\b(?:brief|rates|minimums|capacity)\b/i,
  drift: /\b(?:updated?|fix(?:ed)?|correct(?:ed)?|new) (?:version|copy|one|doc|plan|sheet)\b|\bupdate (?:it|the (?:doc|plan|sheet|brief))\b/i,
  recap: /\b(?:recap|one-?pager|one page|write (?:it|that|this) up|on (?:a|one) page)\b/i,
};
export function madeArtifactOffer(text: string, kind: OfferKind): boolean {
  return String(text ?? "").split(/(?<=[.!?])\s+|\n+/).some((x) => OFFER_ASK.test(x) && KIND_NOUN[kind].test(x));
}

// Pure: what a waiting offer means when they answer it, by kind.
export function pendingLine(topic: string): string {
  const t = parseTopic(topic);
  const yes: Record<OfferKind, string> = {
    document: "write it with writeDocument",
    plan: "tell them plainly that is not something you do",
    brief: "tell them plainly that is not something you do",
    drift: "readDocument, then send the corrected version with writeDocument (revises, changed)",
    recap: "write the one-page recap of what was decided on the call, from their own words, with writeDocument",
  };
  const what: Record<OfferKind, string> = { document: `write up "${t.text}" as a document`, plan: `do something Cue no longer does ("${t.text}")`, brief: `do something Cue no longer does ("${t.text}")`, drift: `send a corrected version of ${t.text}`, recap: `write up a one-page recap of ${t.text}` };
  return `You offered to ${what[t.kind]} and are waiting on their answer. If this message says yes, or asks for it, ${yes[t.kind]}. If they pass or change the subject, let it go and never offer it again.`;
}

// openWork comes from the turn (services/turnContext.ts), which already read their tasks and briefs.
export async function loadArtifactSignals(userId: string, o: { drift?: Drift[]; delivered?: ArtifactSignals["delivered"]; openWork?: string[] } = {}): Promise<ArtifactSignals> {
  const [notes, emailPlanAt] = await Promise.all([
    pool
      .query(`SELECT brief, updated_at FROM search_briefs WHERE user_id = $1 AND updated_at > NOW() - INTERVAL '7 days'`, [userId])
      .then((r) => {
        const b = r.rows[0]?.brief;
        if (!b) return null;
        return { kind: b.kind ?? null, what: b.what || null, picked: b.picked ?? null, when: b.when ?? null, headcount: typeof b.headcount === "number" ? b.headcount : null, city: b.city ?? null, area: b.area ?? null, updatedAt: r.rows[0].updated_at ? new Date(r.rows[0].updated_at) : null };
      })
      .catch(() => null),
    pool
      .query(`SELECT created_at FROM harness_decisions WHERE user_id = $1 AND decision = 'loop.emailPlan' AND outcome = 'act' ORDER BY created_at DESC LIMIT 1`, [userId])
      .then((r) => (r.rows[0] ? new Date(r.rows[0].created_at) : null))
      .catch(() => null),
  ]);
  return { notes, emailPlanAt, delivered: o.delivered ?? [], openWork: o.openWork ?? [], drift: o.drift ?? [] };
}

// Recorded when Co's text made the offer, so it's never made twice (conversationReply.ts after the turn, the post-call onSent).
export async function recordArtifactOffer(userId: string, kind: OfferKind, topic: string): Promise<void> {
  await pool.query(`INSERT INTO document_offers (user_id, topic, source, status) VALUES ($1, $2, 'offered', 'offered')`, [userId, kindTopic(kind, topic)]);
}

// ---------------------------------------------------------------- after a call (A5)

// Pure: may the post-call text carry one line offering a one-page recap. Code checks the facts (cooldown, care, the hour, no
// commitment from Co, nothing delivered since, no confirmation text); whether the call landed a decision in their words is Co's read.
export function postCallRecapAllowed(o: { gate: Pick<OfferState, "now" | "needsCare" | "heavyNow" | "history">; localHour: number; confirmationSent: boolean; coCommitted: boolean; deliveredSinceCall: boolean; callKey: string }): { ok: true; topic: string } | { ok: false; why: string } {
  const gate = offerGate(o.gate, "recap");
  if (gate) return { ok: false, why: gate };
  if (o.localHour < 8 || o.localHour >= 21) return { ok: false, why: "it's night for them" };
  if (o.confirmationSent) return { ok: false, why: "the confirmation text already went" };
  if (o.coCommitted) return { ok: false, why: "Cue made a commitment on the call; that's what follows, not a recap" };
  if (o.deliveredSinceCall) return { ok: false, why: "a document already went to them since the call" };
  if (offeredBefore(o.gate.history, "recap", o.callKey)) return { ok: false, why: "already offered for this call" };
  return { ok: true, topic: o.callKey };
}
export const RECAP_OFFER_RULE = "Only if they settled a decision or a plan in their own words on this call, you may end with one short line offering to put it on a one-page recap. Otherwise leave it out. Never more than that one line about it.";

// ---------------------------------------------------------------- the record

export async function loadOfferHistory(userId: string): Promise<OfferHistoryRow[]> {
  const { rows } = await pool
    .query(`SELECT topic, source, status, COALESCE(accepted_at, offered_at) AS at FROM document_offers WHERE user_id = $1 AND offered_at > NOW() - INTERVAL '120 days' ORDER BY offered_at DESC LIMIT 40`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ topic: String(r.topic), source: r.source === "asked" ? "asked" : "offered", status: r.status === "accepted" ? "accepted" : "offered", at: new Date(r.at) }) as OfferHistoryRow);
}

export async function loadOfferState(userId: string, now = new Date()): Promise<OfferState> {
  const [asks, threads, emo, history, inbound] = await Promise.all([
    pool
      .query(`SELECT ask_text, created_at FROM ask_checkins WHERE user_id = $1 AND kind = 'help' AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 6`, [userId])
      .then((r) => r.rows.map((x: any) => ({ text: String(x.ask_text), ageDays: days(new Date(x.created_at), now) })))
      .catch(() => [] as OfferState["helpAsks"]),
    pool
      .query(`SELECT text, feeling, opened_at FROM member_threads WHERE user_id = $1 AND status IN ('open', 'waiting') ORDER BY last_touched_at DESC LIMIT 8`, [userId])
      .then((r) => r.rows.map((x: any) => ({ text: String(x.text), feeling: x.feeling ? String(x.feeling) : null, ageDays: days(new Date(x.opened_at), now) })))
      .catch(() => [] as OfferState["threads"]),
    getEmotionalContext(userId, now).catch(() => null),
    loadOfferHistory(userId),
    // Their last text or call (a timestamp only): "okay again" is a normal text after the hard read (services/moodHold.ts).
    import("../harness/proactive.js").then((p) => p.lastInboundAt(userId)).catch(() => null),
  ]);
  return { now, helpAsks: asks, threads, recurring: emo?.recurring ?? [], needsCare: !!emo?.needsCare, moodHold: moodHold(emo, { now, lastInboundAt: inbound }), history };
}

export async function recordOffer(userId: string, topic: string): Promise<void> {
  await pool.query(`INSERT INTO document_offers (user_id, topic, source, status) VALUES ($1, $2, 'offered', 'offered')`, [userId, topic.slice(0, 240)]);
}

// A document was written: the open offer is accepted; a document they simply asked for is recorded as asked.
export async function recordDocumentWritten(userId: string, title: string, now = new Date()): Promise<void> {
  const open = await pool
    .query(`UPDATE document_offers SET status = 'accepted', accepted_at = NOW() WHERE id = (SELECT id FROM document_offers WHERE user_id = $1 AND source = 'offered' AND status = 'offered' AND offered_at > $2 ORDER BY offered_at DESC LIMIT 1) RETURNING id`, [userId, new Date(now.getTime() - 7 * 86_400_000)])
    .catch(() => ({ rows: [] as any[] }));
  if (!open.rows.length) await pool.query(`INSERT INTO document_offers (user_id, topic, source, status, accepted_at) VALUES ($1, $2, 'asked', 'accepted', NOW())`, [userId, title.slice(0, 240)]).catch(() => {});
}

// ---------------------------------------------------------------- what Co is told on a reply

export type DocOfferContext = {
  due: { topic: string; why: string } | null;
  pending: { topic: string } | null;
  lastDocument?: { topic: string } | null;
  // For the other artifacts (a stale document): the shared record and their state, decided per reply.
  history?: OfferHistoryRow[];
  needsCare?: boolean;
  // The mood hold as read when the context loaded (loadOfferState), for a caller without the reply's moment.
  moodHold?: MoodHold | null;
  signals?: ArtifactSignals | null;
  // This reply's moment, set by the reply (harness/replyGrounding.ts): a heavy message, and Co's last few lines.
  moment?: { heavyNow: boolean; coLines: string[] } | null;
};

// Pure: are they asking for a document, or for the one Co made again (send it again, updated, redone, the same request repeated)?
// Guidance for Co, never a gate: it only adds a line telling Co the ask is its go-ahead.
export const DOC_NOUN = /\b(pdf|pdfs|document|documents|doc|docs|write-?up|one-?pager|summary on paper)\b/i;
export const DOC_VERB = /\b(make|create|build|write|put together|send|give|need|want|can you|could you|please|resend|re-?send|redo|re-?do|update|reformat|regenerate|generate|draft|try again|let'?s try)\b/i;
// One rule for a document asked for again (2026-10-08 review B3): asked again -> the same version again (asksToResend, shared with
// writeDocument in services/documentDelivery.ts); asked for a change -> readDocument, then the next version; never re-sent on Co's own
// initiative. A fresh try after one that failed ("let's try again, make me a pdf") is a new document.
export const CHANGE_ASK = /\b(?:update|redo|re-?do|revise|fix|change|edit|tweak|reformat|regenerate|rewrite|shorten|expand)\s+(?:it|that|this|the (?:doc|pdf|plan|document|brief|sheet|notes|summary|one-?pager|write-?up))\b|\b(?:updated|new|newer|latest|reformatted|fresh) (?:version|copy|one)\b|\b(?:add|remove|swap|include|cut)\b[^.?!]{0,40}\b(?:to|from|in|into) (?:it|the (?:doc|pdf|plan|document|brief|sheet))\b/i;
const TRY_AGAIN = /\b(?:try|trying|do|doing) (?:it |that |this )?again\b/i;
export function documentAskIn(message: string, hasRecentDocument = false): { ask: boolean; again: boolean; resend: boolean; change: boolean } {
  const m = String(message ?? "");
  const named = DOC_NOUN.test(m) && DOC_VERB.test(m);
  const aboutOne = hasRecentDocument || DOC_NOUN.test(m);
  const resend = aboutOne && asksToResend(m);
  // "Send it again but add the dinner": asked again WITH a change is a change (asksToResend says no to it for the same reason).
  const againWithChange = /\b(?:again|resend|re-send)\b/i.test(m) && /\b(?:add|adding|remove|include|swap|change|update|fix|but with|without|instead)\b/i.test(m);
  const change = !resend && aboutOne && (CHANGE_ASK.test(m) || againWithChange);
  const retry = named && TRY_AGAIN.test(m);
  const again = resend || change || retry || (named && hasRecentDocument);
  return { ask: named || resend || change, again, resend, change };
}

export async function loadDocOfferContext(userId: string, now = new Date()): Promise<DocOfferContext> {
  const state = await loadOfferState(userId, now);
  const pending = state.history.find((h) => h.source === "offered" && h.status === "offered" && (now.getTime() - h.at.getTime()) / 3_600_000 < OFFER.waitingHours);
  // The notice as if no hard time held it: in a reply the heavy-moment gate (the moment, replyGrounding.ts heavyHold) decides whether it
  // waits, from this message's own read, so an offer that waits stays owed instead of vanishing from the context.
  const d = documentOfferDue({ ...state, needsCare: false });
  const last = state.history.find((h) => h.status === "accepted" && days(h.at, now) < 3);
  return { due: d.due ? { topic: d.topic, why: d.why } : null, pending: pending ? { topic: pending.topic } : null, lastDocument: last ? { topic: last.topic } : null, history: state.history, needsCare: state.needsCare, moodHold: state.moodHold ?? null };
}

// Pure: the lines for a reply. An offer waiting on its answer, or a moment Co may offer (once, if it fits this message). At most one
// offer per reply: a stale document (artifactOfferDue) comes first, else the document notice.
// turn: this message's weight and Co's recent lines, for the other artifacts.
export function docOfferLines(
  c: DocOfferContext | null | undefined,
  message = "",
  turn: { heavyNow?: boolean; coLines?: string[]; now?: Date } = {},
): { pending: string | null; hint: string | null; ask: string | null; offer?: { kind: OfferKind; topic: string } | null } {
  turn = { heavyNow: c?.moment?.heavyNow, coLines: c?.moment?.coLines, ...turn }; // mood: carries the reply's capped heavyHold (replyGrounding.ts)
  const a = documentAskIn(message, !!c?.lastDocument);
  // One rule (2026-10-08): asked for it again -> the same version again; asked for a change -> readDocument, then the next version;
  // never sent again on Co's own initiative.
  const how = a.resend
    ? "They want the one they have again (lost it, can't find it, send it again): send the same version again. readDocument for its text and send that unchanged with writeDocument; never say it's already up or to scroll up. "
    : a.change
      ? "They want a change to one they have: readDocument first, then writeDocument with revises and changed (what changed), the next version. "
      : "";
  const ask = a.ask
    ? `They are asking for a document${a.resend ? " again" : a.change ? ", changed" : ""}. That ask is your go-ahead: call writeDocument now, from what they have said. ${how}Never send a document again on your own. Don't ask what it should cover when the conversation carries it: write it, and say in a line what is thin or still open. Ask first only if two different documents are possible or there is truly nothing from them to base it on.`
    : null;
  if (!c) return { pending: null, hint: null, ask, offer: null };
  const now = turn.now ?? new Date();
  // Never an offer on top of an ask, or while one waits on its answer.
  const artifact = !a.ask && !c.pending && c.signals
    // In a reply the moment (heavyHold, capped) is the one mood gate: needsCare isn't applied a second time from the context's older
    // read. Without a moment, the context's own capped hold (offerMoodHeld) decides.
    ? nextArtifactOffer({ now, helpAsks: [], threads: [], recurring: [], needsCare: c.moment ? false : !!c.needsCare, moodHold: c.moodHold ?? null, heavyNow: !!turn.heavyNow, history: c.history ?? [], ...c.signals, message, coLines: turn.coLines ?? [] })
    : null;
  // Without the reply's moment (a caller that has none), the context's own capped hold makes the notice wait.
  const ctxHeld = !c.moment && offerMoodHeld({ needsCare: !!c.needsCare, moodHold: c.moodHold ?? null });
  const docHint = c.due && !turn.heavyNow && !ctxHeld // mood: the reply's capped heavyHold; the notice itself stays owed (loadDocOfferContext)
    ? `They seem to be looking for direction on "${c.due.topic}" (${c.due.why}). Only if it fits this message (they are not mid-feeling, and did not just ask for something else), you may offer once to put it together as a document for them: one light line in your own words, after calling offerDocument. If it doesn't fit, say nothing about it. Don't write the document until they say yes.`
    : null;
  return {
    ask,
    pending: c.pending ? pendingLine(c.pending.topic) : null,
    hint: artifact ? `${artifact.line} Never during a hard moment, and never more than one offer in this reply.` : docHint,
    offer: artifact ? { kind: artifact.kind, topic: parseTopic(artifact.topic).text } : null,
  };
}
