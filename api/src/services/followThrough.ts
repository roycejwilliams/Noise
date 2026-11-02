// What Co said it would do, held to what actually happened (2026-10-08 call review). After one call:
//   - a promise task closed itself as done because a document had gone out the DAY BEFORE, on another focus
//   - the same commitment, said three ways and asked for once, became two tasks and three searches
//   - a name the member had texted ("Jeremy Toce") was counted as invented because only the first name was said on the call
// The checks here are facts, not judgment: did something matching go out after the promise, is it the same commitment as
// a task already open, is a specific in the member's own texts or Co's records. Pure helpers first, then the loaders.
import pool from "../db/db.js";
import { notToTeammate } from "./teamLines.js";

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "for", "with", "on", "at", "by", "from", "about", "into", "over",
  "their", "his", "her", "my", "our", "your", "you", "we", "they", "them", "it", "its", "that", "this", "these", "those",
  "more", "other", "if", "something", "real", "fits", "after", "hang", "up", "what", "when", "once", "will", "would",
  "can", "could", "just", "also", "then", "there", "here", "some", "any", "all", "like", "kind", "know", "get", "got",
  "i'll", "ill", "i'm", "let", "me", "him", "she", "he", "yeah", "yes", "okay", "uh", "um", "really", "actually",
  "keep", "word", "call", "promise", "text", "send", "co", "co's", "cue", "cue's", "set",
]);
// Crude stem: planning/planned/plans -> plan, documents -> docume (first six letters), so the same word in two forms matches.
const stem = (w: string) => w.replace(/'s$/, "").replace(/(?:ing|ed|es|s)$/, "").replace(/([b-df-hj-np-tv-z])\1$/, "$1").slice(0, 6);

export function significant(s: string): string[] {
  const out = new Set<string>();
  for (const w of String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/)) {
    if (w.length > 2 && !STOP.has(w)) out.add(stem(w));
  }
  return [...out];
}

// Share of the smaller word set found in the other.
export function overlap(a: string, b: string): number {
  const A = significant(a), B = new Set(significant(b));
  const small = A.length <= B.size ? A : [...B];
  const big = A.length <= B.size ? B : new Set(A);
  if (!small.length) return 0;
  return small.filter((w) => big.has(w)).length / small.length;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const PLACEHOLDER = /^\(?(?:said on a call|their message)\)?$/i;
export const goalBody = (g: string) => String(g ?? "").replace(/^(?:Keep your word from the call|Keep your promise|Keep an eye out, as promised on a call):\s*/i, "").replace(/^"|"$/g, "");

// Two commitments are the same one when they answer the same words of theirs, or their goals say the same thing.
export function sameCommitment(a: { goal?: string | null; theirWords?: string | null }, b: { goal?: string | null; theirWords?: string | null }): boolean {
  const ta = norm(a.theirWords), tb = norm(b.theirWords);
  if (ta.length >= 24 && tb.length >= 24 && !PLACEHOLDER.test(ta) && !PLACEHOLDER.test(tb)) {
    const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (l.includes(s.slice(0, Math.min(s.length, 120)))) return true;
    if (significant(s).length >= 4 && overlap(ta, tb) >= 0.7) return true;
  }
  const ga = goalBody(a.goal ?? ""), gb = goalBody(b.goal ?? "");
  return Math.min(significant(ga).length, significant(gb).length) >= 2 && overlap(ga, gb) >= 0.6;
}

// Within ONE call, an ask and a promise that share most of their key words are the same thing said two ways ("three private dining
// rooms near Hayes Valley that seat twelve" / "a few private dinner venue options for twelve near Hayes Valley"), so the looser bar
// is safe here and only here (2026-10-08 live test: they opened two tasks).
export function sameCallCommitment(a: { goal?: string | null; theirWords?: string | null }, b: { goal?: string | null; theirWords?: string | null }): boolean {
  if (sameCommitment(a, b)) return true;
  const ga = goalBody(a.goal ?? ""), gb = goalBody(b.goal ?? "");
  const shared = significant(ga).filter((w) => new Set(significant(gb)).has(w)).length;
  return shared >= 4 || (shared >= 3 && overlap(ga, gb) >= 0.5);
}

// forThis: sent by the task keeping this promise (its own texts are about it by construction).
export type Sent = { at: Date; text: string; kind: "text" | "link" | "document"; forThis?: boolean };

// Only words that name a document: a plan or a summary can go out as a plain text, so they don't set the kind.
const WANTS_DOC = /\b(?:docs?|documents?|pdfs?|write[- ]?ups?|memos?|one[- ]pagers?|research brief|venue brief)\b/i;
const WANTS_LINKS = /\b(?:links?|urls?)\b/i;
// A plan Co said it would put together, write up or draft is a document too (Royce, 2026-10-08: "A promised plan or doc goes through
// writeDocument, never as a wall of text"). "Text you the plan for Saturday" stays a text: only a plan Co is writing counts.
const WRITES_A_PLAN = /\b(?:put(?:ting)? together|pull(?:ing)? together|writ(?:e|ing) up|draft(?:ing)?|sketch(?:ing)? out|map(?:ping)? out)\b[^.!?]{0,80}\b(?:plan|planning|playbook|strategy|proposal|outline|roadmap)\b|\bplanning doc\b/i;

// Pure: is this commitment a document (a doc, PDF, write-up, memo, or a plan Co is writing)? The goal is Co's own words; their
// words count only for naming a document, never for the plan rule (their "plan" is often an event, not a page).
export function wantsDocument(goal: string, theirWords?: string | null): boolean {
  const g = goalBody(goal);
  return WANTS_DOC.test(`${g} ${theirWords ?? ""}`) || WRITES_A_PLAN.test(g);
}

// Pure: a promise whose deliverable is bringing something up again at a time ("I'll bring it back up tomorrow afternoon", "I'll remind
// you Friday"). Read from Cue's own promise sentence (what Cue said it would do), never from the member's words. There is nothing to
// find first: the text that brings it up is the delivery, so it goes in its window (services/taskTurn.ts), never moves quietly.
const BRINGS_IT_UP = /\b(?:bring(?:ing)? (?:it|this|that|them|these|those|(?:the|your) [\w'-]+(?: [\w'-]+){0,3}) (?:back )?up|bring(?:ing)? (?:back )?up|remind(?:ing)? you|nudg(?:e|ing) you)\b/i;
export function reminderPromise(t: { source?: string | null; goal: string }): boolean {
  return t.source === "promise" && BRINGS_IT_UP.test(goalBody(t.goal));
}

// A promise made in a reply (or a proactive text) opens its task while that text is being checked, before it goes out: the text that
// makes the promise, and the rest of that same reply, are sent in the seconds after the task row (dev, 2026-11-02: every promise
// task whose sentence went out did so 1 to 10 s after its row). Those sends are the promise being made, never it being kept (closure
// audit 11-02: task 1089's own "I'll bring it back up tomorrow afternoon", sent 2 s after its row, closed it as kept; task 1096's
// acknowledgment did the same). A call's promise is made on the call, which ended before its task was written: nothing to skip.
export const PROMISE_TURN_MS = 60_000;
export function promiseTurnEnd(goal: string, at: Date): Date {
  return /^Keep your promise:/i.test(String(goal ?? "").trim()) ? new Date(at.getTime() + PROMISE_TURN_MS) : at;
}

// Pure: a send that only says the promise again ("Sounds good, I'll bring it back up tomorrow afternoon."), whenever it went.
export function repeatsPromise(goal: string, text: string): boolean {
  const said = norm(goalBody(goal)), sent = norm(text);
  if (said.length < 12 || sent.length < 4) return false;
  return sent.includes(said) || (sent.length >= 12 && said.includes(sent));
}

// Pure: was the promise kept by something sent after its own turn, and of the kind it promised (a document for a document, a link for
// links)? Anything sent before the promise, in the turn that made it, or that only repeats it, never counts, however well it matches.
// The task keeping it (forThis) sends only on its own wakes, so its sends are never the promising turn.
export function promiseKeptBy(p: { goal: string; theirWords?: string | null; at: Date; turnEnd?: Date }, sends: Sent[]): { kept: boolean; by: Sent | null; why: string } {
  const what = `${goalBody(p.goal)} ${p.theirWords ?? ""}`;
  const kind: Sent["kind"] | "any" = wantsDocument(p.goal, p.theirWords) ? "document" : WANTS_LINKS.test(what) ? "link" : "any";
  // Anything else: something about the promised thing, i.e. sent by the task keeping it, or sharing what the promise is about
  // (its goal or their words). A link or document on another subject doesn't keep it (2026-10-07: any unrelated doc or link did),
  // and a text also has to be a real message, not a stub.
  const theirs = PLACEHOLDER.test(norm(p.theirWords)) ? "" : String(p.theirWords ?? "");
  const about = (s: Sent) => !!s.forThis || overlap(goalBody(p.goal), s.text) > 0 || (!!theirs && overlap(theirs, s.text) > 0);
  // A promise to bring something up names no subject of its own ("I'll bring it back up tomorrow afternoon"), so shared words prove
  // nothing ("back", "tomorrow"): only the task keeping it bringing it up keeps it.
  const bringUp = BRINGS_IT_UP.test(goalBody(p.goal));
  const fits = (s: Sent) =>
    bringUp ? !!s.forThis && s.kind === "text" && s.text.trim().length >= 20
    : kind === "document" ? s.kind === "document"
    : kind === "link" ? s.kind === "link" || s.kind === "document"
    : about(s) && (s.kind !== "text" || s.text.trim().length >= 20);
  const turnEnd = (p.turnEnd ?? promiseTurnEnd(p.goal, p.at)).getTime();
  const ownTurn = (s: Sent) => !s.forThis && s.at.getTime() <= turnEnd;
  const after = sends.filter((s) => s.at.getTime() > p.at.getTime()).sort((x, y) => x.at.getTime() - y.at.getTime());
  const counted = after.filter((s) => !ownTurn(s) && !repeatsPromise(p.goal, s.text));
  const by = counted.find(fits) ?? null;
  if (by) return { kept: true, by, why: `${by.kind === "document" ? "a document" : by.kind === "link" ? "a link" : "a text"} went out at ${by.at.toISOString().slice(0, 16).replace("T", " ")} UTC, after the promise` };
  const earlier = sends.filter((s) => s.at.getTime() <= p.at.getTime() && fits(s)).sort((x, y) => y.at.getTime() - x.at.getTime())[0];
  const own = after.filter((s) => (ownTurn(s) || repeatsPromise(p.goal, s.text)) && (bringUp || fits(s)))[0];
  const want = bringUp ? "the text that brings it up" : kind === "document" ? "a document" : kind === "link" ? "a link" : "a text about it";
  return {
    kept: false,
    by: null,
    why: `nothing went out after the promise (${p.at.toISOString().slice(0, 16).replace("T", " ")} UTC) that keeps it: it needs ${want}${counted.length ? `, and what went out since isn't one` : ""}${own ? `. "${own.text.slice(0, 80)}" was the promise being made (the reply that made it, or the promise said again), so it doesn't count` : ""}${earlier ? `. "${earlier.text.slice(0, 80)}" was sent ${earlier.at.toISOString().slice(0, 16).replace("T", " ")} UTC, before the promise, so it doesn't count` : ""}`,
  };
}

// What Co actually sent a member since a time: texts (outbound_messages) and its own record of sends (co_facts, by when it
// happened, not when the row was written: a backfilled row can be written hours after the send).
// taskId: the task asking. Its own texts from earlier wakes (proactive_sends keyed task:<id>:...) are marked forThis, so a delivery
// it already made keeps its promise on a later wake too, and is never sent a second time.
export async function sendsSince(userId: string, since: Date, taskId?: number | null): Promise<Sent[]> {
  const [texts, facts, mine] = await Promise.all([
    // The after-call confirmation (services/callFollowThrough.ts) and a miss warning (taskTurn.ts, type task_window) say the thing is coming; neither is the thing itself.
    pool.query(
      `SELECT om.content, om.sent_at FROM outbound_messages om WHERE om.user_id = $1 AND om.sender = 'co' AND om.sent_at > $2
         AND NOT EXISTS (SELECT 1 FROM proactive_sends ps WHERE ps.user_id = om.user_id AND ps.type IN ('call_confirm', 'task_window') AND ps.message = om.content)
       ORDER BY om.sent_at LIMIT 200`,
      [userId, since],
    ),
    pool.query(
      `SELECT relation, object_label, url, happened_at FROM co_facts
       WHERE owner_user_id = $1 AND subject = 'co' AND relation IN ('sent', 'texted') AND retired_at IS NULL AND NOT (meta ? 'ledger') AND COALESCE(happened_at, created_at) > $2
       ORDER BY happened_at LIMIT 200`,
      [userId, since],
    ),
    taskId != null
      ? pool.query(`SELECT message FROM proactive_sends WHERE user_id = $1 AND starts_with(target_key, $2) AND sent_at > $3 LIMIT 50`, [userId, `task:${taskId}:`, since])
      : Promise.resolve({ rows: [] as any[] }),
  ]);
  // A task send of several messages is one row, its messages joined by a blank line (harness/proactive.ts sendExempt).
  const own = new Set(mine.rows.flatMap((r: any) => String(r.message ?? "").split("\n\n")).map((m: string) => m.trim()).filter(Boolean));
  const out: Sent[] = texts.rows.map((r: any) => ({ at: new Date(r.sent_at), text: String(r.content ?? ""), kind: /^\s*https?:\/\/\S+\s*$/.test(String(r.content ?? "")) ? "link" : "text", ...(own.has(String(r.content ?? "").trim()) ? { forThis: true } : {}) }));
  for (const f of facts.rows) {
    const label = String(f.object_label ?? "");
    const kind: Sent["kind"] = /^a document\b/i.test(label) ? "document" : f.url || /https?:\/\//.test(label) ? "link" : "text";
    if (kind !== "text") out.push({ at: new Date(f.happened_at), text: label, kind });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ---- specifics a call grader flagged, checked against what the member texted and Co's records

// Pure: the names, places and numbers in a statement: capitalized words (not sentence openers), quoted bits, and numbers.
const NOT_NAMES = new Set(["I", "I'll", "I'm", "I've", "Cue", "Cue's", "Co", "Co's", "The", "A", "An", "And", "But", "So", "Then", "If", "When", "Yes", "No", "Got", "Thanks", "Good", "Okay", "OK", "You", "You're", "Your", "We", "They", "It", "That", "This", "What", "Who", "Where", "How", "Also", "Failure", "Success", "Member", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
export function specificsIn(s: string): string[] {
  const out = new Set<string>();
  for (const m of String(s ?? "").matchAll(/['"“‘]([^'"”’]{2,60})['"”’]/g)) out.add(m[1].trim());
  for (const m of String(s ?? "").matchAll(/\b[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)*/g)) {
    const words = m[0].split(/\s+/).map((w) => w.replace(/['’-]+$/, "")).filter((w) => w && !NOT_NAMES.has(w.replace(/[’]/g, "'")));
    if (words.length) out.add(words.join(" "));
  }
  for (const m of String(s ?? "").matchAll(/\$?\d[\d,.:]*(?:\s?(?:am|pm|k|%))?/gi)) out.add(m[0].trim());
  return [...out].filter((x) => x.length >= 2);
}

const inText = (needle: string, hay: string) => {
  const n = norm(needle);
  return n.length >= 2 && ` ${norm(hay)} `.includes(` ${n} `);
};

// Pure: the specifics in `flagged` that the call itself doesn't have, and of those, which the member's texts or Co's
// records do. `backed` is true only when there was something to check and all of it is on record.
export function specificsOnRecord(flagged: string[], call: string, records: string): { missingFromCall: string[]; onRecord: string[]; unbacked: string[]; backed: boolean } {
  const missingFromCall = [...new Set(flagged)].filter((x) => !inText(x, call));
  const onRecord = missingFromCall.filter((x) => inText(x, records));
  const unbacked = missingFromCall.filter((x) => !inText(x, records));
  return { missingFromCall, onRecord, unbacked, backed: missingFromCall.length > 0 && unbacked.length === 0 };
}

// The member's own texts ("User said: ..." lines only, never Co's) and Co's records about them (co_facts), as one text to look
// specifics up in (newest first, bounded). Summaries Co's models wrote are left out: an impression is never proof.
export async function memberRecordText(userId: string, days = 60): Promise<string> {
  const [mem, calls, facts] = await Promise.all([
    pool.query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > NOW() - make_interval(days => $2) ORDER BY created_at DESC LIMIT 400`,
      [userId, days],
    ),
    // What they said on earlier calls is their own words too ("user:" lines only).
    pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND created_at > NOW() - make_interval(days => $2) ORDER BY created_at DESC LIMIT 20`, [userId, days]),
    // Working-set exit facts are audit, not Co's record of what it did: they never crowd it out (review of #133).
    pool.query(`SELECT subject, relation, object_label FROM co_facts WHERE owner_user_id = $1 AND retired_at IS NULL AND relation <> 'exited' AND NOT (meta ? 'ledger') ORDER BY created_at DESC LIMIT 400`, [userId]),
  ]);
  const theirCallLines = calls.rows.flatMap((r: any) => String(r.content ?? "").split("\n").filter((l) => /^\s*user\s*:/i.test(l)));
  return [...mem.rows.map((r: any) => String(r.content ?? "")), ...theirCallLines, ...facts.rows.map((r: any) => `${r.subject} ${r.relation} ${r.object_label ?? ""}`)].join("\n").slice(0, 200_000);
}
