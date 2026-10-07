// Offering to write something up (Royce, 2026-10-07). When someone is stuck, vague or circling on their team or their goal, a
// written page is a kind thing to offer. Same shape as the member brief's name question (services/eventBrief.ts): code NOTICES from
// member state, Co OFFERS once in its own words, and nothing is made until they say yes.
//
//   notice  documentOfferDue (pure): an open ask for guidance that has sat for days, a feeling about something that keeps coming up
//           (uncertain, confused, overwhelmed, discouraged), or an open thread they feel unsure about. Never when they are having a
//           hard time (needsCare: grief, exhaustion; their state comes first), never inside two weeks of an earlier offer, never the
//           same topic twice, never right after a document, never while an offer is still waiting on an answer.
//   offer   Co's tool offerDocument (agent/loopTools.ts) re-checks the same rules in code, records the offer, and Co writes the
//           offer itself. The notice only hands Co a hint; Co decides whether this message is the moment.
//   yes     writeDocument needs their own yes in the message (the registry's `confirm`, agent/toolGuard.ts), whether they are
//           answering the offer or asking for a document themselves.
// "Never push it twice if they pass": an offer is made once per topic and once per fortnight, whatever the answer; an unanswered or
// declined offer is not asked again. Read only with the owner's user id.
import pool from "../db/db.js";
import { getEmotionalContext } from "../harness/emotion.js";

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
export type OfferState = {
  now: Date;
  helpAsks: { text: string; ageDays: number }[];
  threads: { text: string; feeling: string | null; ageDays: number }[];
  recurring: { about: string; emotions: string[]; count: number }[];
  needsCare: boolean;
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

// Pure: is this a moment Co may offer to write something up, and about what.
export function documentOfferDue(s: OfferState): OfferDecision {
  if (s.needsCare) return { due: false, why: "they are having a hard time; their state comes first" };
  const recent = s.history.filter((h) => h.source === "offered");
  const waiting = recent.find((h) => h.status === "offered" && (s.now.getTime() - h.at.getTime()) / 3_600_000 < OFFER.waitingHours);
  if (waiting) return { due: false, why: "an offer is still waiting on their answer" };
  if (recent.some((h) => days(h.at, s.now) < OFFER.cooldownDays)) return { due: false, why: "Co offered within the last two weeks" };
  if (s.history.some((h) => h.status === "accepted" && days(h.at, s.now) < OFFER.afterDocumentDays)) return { due: false, why: "a document was just written for them" };
  const done = (topic: string) => s.history.some((h) => sameTopic(h.topic, topic));

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

// ---------------------------------------------------------------- the record

export async function loadOfferHistory(userId: string): Promise<OfferHistoryRow[]> {
  const { rows } = await pool
    .query(`SELECT topic, source, status, COALESCE(accepted_at, offered_at) AS at FROM document_offers WHERE user_id = $1 AND offered_at > NOW() - INTERVAL '120 days' ORDER BY offered_at DESC LIMIT 40`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ topic: String(r.topic), source: r.source === "asked" ? "asked" : "offered", status: r.status === "accepted" ? "accepted" : "offered", at: new Date(r.at) }) as OfferHistoryRow);
}

export async function loadOfferState(userId: string, now = new Date()): Promise<OfferState> {
  const [asks, threads, emo, history] = await Promise.all([
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
  ]);
  return { now, helpAsks: asks, threads, recurring: emo?.recurring ?? [], needsCare: !!emo?.needsCare, history };
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

export type DocOfferContext = { due: { topic: string; why: string } | null; pending: { topic: string } | null; lastDocument?: { topic: string } | null };

// Pure: are they asking for a document, or for the one Co made again (send it again, updated, redone, the same request repeated)?
// Guidance for Co, never a gate: it only adds a line telling Co the ask is its go-ahead.
export const DOC_NOUN = /\b(pdf|pdfs|document|documents|doc|docs|write-?up|one-?pager|summary on paper)\b/i;
export const DOC_VERB = /\b(make|create|build|write|put together|send|give|need|want|can you|could you|please|resend|re-?send|redo|re-?do|update|reformat|regenerate|generate|draft|try again|let'?s try)\b/i;
export const RESEND = /\b(again|resend|re-?send|re-?do|redo|re-?make|updated?|regenerate|reformat(?:ted)?|new version|latest version|fresh (?:one|copy|version)|one more time)\b/i;
export function documentAskIn(message: string, hasRecentDocument = false): { ask: boolean; again: boolean } {
  const m = String(message ?? "");
  const named = DOC_NOUN.test(m) && DOC_VERB.test(m);
  const again = RESEND.test(m) && (hasRecentDocument || DOC_NOUN.test(m));
  return { ask: named || again, again: again || (named && hasRecentDocument) };
}

export async function loadDocOfferContext(userId: string, now = new Date()): Promise<DocOfferContext> {
  const state = await loadOfferState(userId, now);
  const pending = state.history.find((h) => h.source === "offered" && h.status === "offered" && (now.getTime() - h.at.getTime()) / 3_600_000 < OFFER.waitingHours);
  const d = documentOfferDue(state);
  const last = state.history.find((h) => h.status === "accepted" && days(h.at, now) < 3);
  return { due: d.due ? { topic: d.topic, why: d.why } : null, pending: pending ? { topic: pending.topic } : null, lastDocument: last ? { topic: last.topic } : null };
}

// Pure: the lines for a reply. An offer waiting on its answer, or a moment Co may offer (once, if it fits this message).
export function docOfferLines(c: DocOfferContext | null | undefined, message = ""): { pending: string | null; hint: string | null; ask: string | null } {
  const a = documentAskIn(message, !!c?.lastDocument);
  const ask = a.ask
    ? `They are asking for a document${a.again ? ", or for it again (a repeat, an update, a redo)" : ""}. That ask is your go-ahead: call writeDocument now, from what they have said. ${a.again ? "Write it and send it again; never say it was already sent, to scroll up, or that nothing changed (you can't see how the old one looked, and writing it again is how they get the latest). " : ""}Don't ask what it should cover when the conversation carries it: write it, and say in a line what is thin or still open. Ask first only if two different documents are possible or there is truly nothing from them to base it on.`
    : null;
  if (!c) return { pending: null, hint: null, ask };
  return {
    ask,
    pending: c.pending ? `You offered to write up "${c.pending.topic}" as a document and are waiting on their answer. If this message says yes, or asks for it, write it with writeDocument. If they pass or change the subject, let it go and never offer it again.` : null,
    hint: c.due
      ? `They seem to be looking for direction on "${c.due.topic}" (${c.due.why}). Only if it fits this message (they are not mid-feeling, and did not just ask for something else), you may offer once to put it together as a document for them: one light line in your own words, after calling offerDocument. If it doesn't fit, say nothing about it. Don't write the document until they say yes.`
      : null,
  };
}
