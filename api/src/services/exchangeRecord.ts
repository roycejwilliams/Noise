// The whole exchange (Royce, 2026-11-03: "Cue needs to keep track of what you mean, what you've already told it, what it's already done,
// and what's still unresolved", and "judge its next move against the whole exchange, not just whether the next sentence sounds
// reasonable"). One running record per member, read before every move, built from what already exists. Nothing here is a new store
// of their words.
//   done        what Cue sent: the links, finds, cards and documents and the questions and offers in this thread (the #343 window), plus
//               the finds on file (TurnContext.sent, from the ledger and the offer stores), each with an id (D1, D2, ...)
//   told        the questions of Cue's in the thread they already answered, with their answer: read each turn from the window by the turn
//               read (services/readTurn.ts), never stored
//   meant       what "that / it / the second one" points to, resolved by the turn read against the done list; a correction ("not that
//               one") is kept with it. Stored briefly (MEANT_HOURS) as Cue's own item labels, never their words, so it carries forward
//   unresolved  their asks, what Cue carries for them (tasks, promises, briefs, documents, loops) and their threads, each in a state
//               (open, delivered), plus what they closed lately (solved or dropped at their word). Silence never counts as solved
// The move (answer, summarize, steps, act, close, feeling, ask, quiet) is chosen by the turn read on text, and by the call brain itself
// on a call; the draft is checked against it in harness/moveCheck.ts. Pure, apart from the loaders at the bottom.
import { questionsIn, turnsFromConversation } from "../harness/repeatAsk.js";

export const EXCHANGE_MOVES = ["answer", "summarize", "steps", "act", "close", "feeling", "ask", "quiet"] as const;
export type ExchangeMove = (typeof EXCHANGE_MOVES)[number];
// What each move asks of the reply. Meanings, not lines to say.
export const MOVE_MEANINGS: Record<ExchangeMove, string> = {
  answer: "answer what they asked, from what's true",
  summarize: "sum up what they asked about, as the whole reply: no advice, plan or question they didn't ask for",
  steps: "give the steps, in order, and stop after the last one",
  act: "do the thing or deliver it now with your tools, then say what they get",
  close: "they're closing or said it's done: acknowledge it once, warmly and briefly, and stop. No new question, find, offer or link",
  feeling: "stay with what they feel: no plans, finds or offers in this reply",
  ask: "ask the one question you can't go on without, and nothing they already told you",
  quiet: "say nothing more than a reaction",
};
export const MOVES_GUIDE = `Pick the move from the whole exchange, not from their last line alone: what they asked and corrected, what Cue already did or asked, what's still open, how they feel, and their rules. Their latest message always wins over the record: if they ask for something again, bring a closed thing back, or didn't catch what you asked, that's what you answer. "close" only when their latest message closes and asks nothing: a thanks with a question or a request is "answer" or "act", and closing words that carry distress ("I'm done with all of it") are "feeling", never "close". The moves: ${EXCHANGE_MOVES.map((m) => `${m} (${MOVE_MEANINGS[m]})`).join("; ")}.`;

export type DoneKind = "link" | "find" | "card" | "document" | "question" | "offer";
// replied: they wrote back after it (a question or offer they've had the chance to answer).
export type DoneItem = { id: string; kind: DoneKind; label: string; url: string | null; replied: boolean };
export type UnresolvedState = "open" | "delivered" | "solved" | "dropped";
// closedAt: when it closed (closed items read from the stores): their words lift it only when said after that (see moveCheck.ts).
export type UnresolvedItem = { id: string; label: string; state: UnresolvedState; closedAt?: string | null };
export type Told = { q: string; a: string };
// item / notItem: done ids this turn. label / notLabel: their labels (what carries to the next turn).
// between: when their words and the exchange don't settle which item it is, the two or more it could equally be (then item is null):
// the one case Cue asks which. A "that" the exchange settles is never asked about.
export type Meant = { phrase: string; item: string | null; label: string | null; notItem: string | null; notLabel: string | null; between?: string[] };
// Kept between turns: Cue's own item labels only, never their words (review of #368).
export type StoredMeant = { label: string | null; notLabel: string | null };
export type ExchangeBase = { done: DoneItem[]; unresolved: UnresolvedItem[]; priorMeant: StoredMeant[] };
// reopens: closed items (solved or dropped) their latest message brings back; for this turn they're theirs again (review of #368: the
// member's latest message always wins over the record).
export type ExchangeRead = { move: ExchangeMove; meant: Meant | null; told: Told[]; closes: { item: string; how: "solved" | "dropped" }[]; reopens: string[]; again: string | null };
export type ExchangeRecord = ExchangeBase & { read: ExchangeRead | null };

export const DONE_MAX = 16;
export const UNRESOLVED_MAX = 16;
export const MEANT_HOURS = 24;

const URL = /https?:\/\/[^\s)>\]"']+/g;
export const normUrl = (u: string) => u.replace(/[.,;!?]+$/, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
// An offer in Cue's own words: a question proposing to do or send something.
export const OFFER_Q = /\b(?:want me to|should i|shall i|do you want me to|would you like me to|want the (?:link|details)|want (?:a|the) (?:copy|list|deck|doc|draft))\b/i;
// A question asking whether a find interests them, in Cue's own words.
export const INTEREST_Q = /\b(?:interest(?:s|ed)? you|interested\??$|worth a look|worth (?:it|your time|carving out)|on your radar|appeal to you|fit for you|sound (?:good|fun|like you))\b/i;

// Pure: what Cue already did in this exchange. The thread is the reply's window as text ("User said:" / "Co replied:" lines, oldest
// first); sent is what's on file as sent (finds and events), newest first. Newest first, at most DONE_MAX, numbered D1...
export function doneFrom(recentConversation: string, sent: { name: string; url: string | null }[] = []): DoneItem[] {
  const turns = turnsFromConversation(recentConversation);
  const raw: Omit<DoneItem, "id">[] = [];
  const seenUrl = new Set<string>();
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.from !== "co") continue;
    const replied = turns.slice(i + 1).some((x) => x.from === "them" && x.text.trim());
    const card = t.text.match(/\[sent (?:Cue|Co)'s contact card\]/i);
    if (card) raw.push({ kind: "card", label: "Cue's contact card", url: null, replied });
    const doc = t.text.match(/\[sent a document: ([^\]]+)\]/i);
    if (doc) raw.push({ kind: "document", label: doc[1].trim().slice(0, 120), url: null, replied });
    for (const u of t.text.match(URL) ?? []) {
      const k = normUrl(u);
      if (seenUrl.has(k)) continue;
      seenUrl.add(k);
      const named = sent.find((s) => s.url && normUrl(s.url) === k);
      raw.push({ kind: "link", label: named?.name.slice(0, 120) ?? k.slice(0, 120), url: u.replace(/[.,;!?]+$/, ""), replied });
    }
    for (const q of questionsIn(t.text.replace(URL, ""))) raw.push({ kind: OFFER_Q.test(q) ? "offer" : "question", label: q.slice(0, 200), url: null, replied });
  }
  for (const s of sent) {
    if (s.url && seenUrl.has(normUrl(s.url))) continue;
    if (s.url) seenUrl.add(normUrl(s.url));
    raw.push({ kind: "find", label: s.name.slice(0, 120), url: s.url, replied: true });
  }
  return raw.slice(0, DONE_MAX).map((d, i) => ({ id: `D${i + 1}`, ...d }));
}

export type ClosedRow = { label: string; how: "solved" | "dropped"; at?: string | null };
// Pure: what's still open for them, then what they closed lately. Open asks and threads are open; what Cue carries is open until it's
// done, then delivered (delivered is not solved: only their word solves it). Numbered U1...
export function unresolvedFrom(o: { asks?: { text: string }[]; carrying?: { label: string; state: "due" | "outstanding" | "done" }[]; threads?: { text: string }[]; closed?: ClosedRow[] }): UnresolvedItem[] {
  const out: Omit<UnresolvedItem, "id">[] = [
    ...(o.asks ?? []).map((a) => ({ label: a.text, state: "open" as const })),
    ...(o.carrying ?? []).map((c) => ({ label: c.label, state: c.state === "done" ? ("delivered" as const) : ("open" as const) })),
    ...(o.threads ?? []).map((t) => ({ label: t.text, state: "open" as const })),
  ];
  const seen = new Set(out.map((x) => x.label.toLowerCase()));
  for (const c of o.closed ?? []) if (!seen.has(c.label.toLowerCase())) (seen.add(c.label.toLowerCase()), out.push({ label: c.label, state: c.how, ...(c.at ? { closedAt: c.at } : {}) }));
  return out.slice(0, UNRESOLVED_MAX).map((u, i) => ({ id: `U${i + 1}`, label: u.label.replace(/\s+/g, " ").slice(0, 160), state: u.state, ...(u.closedAt ? { closedAt: u.closedAt } : {}) }));
}

const itemLine = (d: DoneItem) => `${d.id} ${d.kind}: ${d.label}${d.url && d.kind !== "link" ? ` (${d.url})` : d.url && d.label !== normUrl(d.url).slice(0, 120) ? ` (${d.url})` : ""}${(d.kind === "question" || d.kind === "offer") && !d.replied ? " [no answer yet]" : ""}`;

// The part of the turn read's prompt that carries the record (services/readTurn.ts turnReadAddendum), and the fields it asks for.
export function exchangeAddendum(b: ExchangeBase | null | undefined): string {
  if (!b) return "";
  const done = b.done.map((d) => `- ${itemLine(d)}`).join("\n") || "- (nothing yet)";
  const open = b.unresolved.map((u) => `- ${u.id} [${u.state}] ${u.label}`).join("\n") || "- (nothing)";
  const prior = b.priorMeant.length ? `\nEarlier in this conversation, what their pointing words meant (Cue's own items): ${b.priorMeant.map((m) => `${m.label ?? "unclear"}${m.notLabel ? `, not ${m.notLabel}` : ""}`).join("; ")}. A correction carries forward until they say otherwise.\n` : "";

  return `

What Cue already did in this exchange (newest first, by id):
${done}

What's open or closed for them (by id; only their word makes something solved or dropped, never silence):
${open}
${prior}
"move": the one move for Cue's reply. ${MOVES_GUIDE} One of: ${EXCHANGE_MOVES.map((m) => `"${m}"`).join(", ")}.
"refers_to": when their message points at something with "that", "it", "this one", "the second one", "him" or similar, {"phrase": "their pointing word or two", "item": the D id it means, or null when it isn't on the list or the exchange doesn't settle which, "not_item": the D id they say they did NOT mean (a correction like "no, the other one"), or null, "between": only when two or more D ids fit equally and nothing in the exchange (what was last discussed, what they reacted to, what they asked about) settles which, those ids; otherwise []}; otherwise null. Resolve it from the exchange whenever you can: "between" is for a real tie, not for caution.
"answered": Cue's questions in the conversation above (or offers in the list) that they have already answered, each {"q": "Cue's question, word for word", "a": "their answer, in a few of their words"}; [] if none. Count an answer even if it came several texts later or in other words.
"closes": items on the open list their latest message says are done, solved or dropped, each {"item": "U id", "how": "solved" | "dropped"}; [] if none. Only their own words close something.
"reopens": U ids of items marked solved or dropped that their latest message brings back or asks about again; [] if none.
"asks_again": the D id they're asking Cue to send or say again, or null.`;
}

const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().slice(0, n) : null);
// Pure: the read's record fields, held to the ids that exist. Null when the read gave no move.
export function parseExchangeRead(obj: any, b: ExchangeBase | null | undefined): ExchangeRead | null {
  if (!b) return null;
  const move = EXCHANGE_MOVES.find((m) => m === obj?.move);
  if (!move) return null;
  const doneId = (v: unknown) => { const id = s(v, 8)?.toUpperCase() ?? null; return id && b.done.some((d) => d.id === id) ? id : null; };
  const labelOf = (id: string | null) => (id ? b.done.find((d) => d.id === id)?.label ?? null : null);
  const r = obj?.refers_to;
  const item = r && typeof r === "object" ? doneId(r.item) : null;
  // A tie only when no one item was named, and only between real, distinct ids (two or more).
  const between = !item && r && typeof r === "object" && Array.isArray(r.between) ? [...new Set(r.between.map((v: unknown) => doneId(v)).filter((v: string | null): v is string => !!v))].slice(0, 4) as string[] : [];
  const meant: Meant | null = r && typeof r === "object" && s(r.phrase, 40) ? { phrase: s(r.phrase, 40)!, item, label: labelOf(item), notItem: doneId(r.not_item), notLabel: labelOf(doneId(r.not_item)), ...(between.length >= 2 ? { between } : {}) } : null;
  const told: Told[] = (Array.isArray(obj?.answered) ? obj.answered : []).map((t: any) => ({ q: s(t?.q, 200), a: s(t?.a, 200) })).filter((t: any): t is Told => !!t.q && !!t.a).slice(0, 6);
  const reopens = (Array.isArray(obj?.reopens) ? obj.reopens : []).map((v: unknown) => s(v, 8)?.toUpperCase() ?? "").filter((id: string) => b.unresolved.some((u) => u.id === id && (u.state === "solved" || u.state === "dropped"))).slice(0, 6);
  const closes = (Array.isArray(obj?.closes) ? obj.closes : [])
    .map((c: any) => ({ item: s(c?.item, 8)?.toUpperCase() ?? "", how: c?.how === "dropped" ? ("dropped" as const) : ("solved" as const) }))
    .filter((c: { item: string }) => b.unresolved.some((u) => u.id === c.item && (u.state === "open" || u.state === "delivered")))
    .slice(0, 6);
  const again = doneId(obj?.asks_again);
  // A close that also asks for something again, or brings something back, is a request: answered, never closed over (review of #368).
  const asked = move === "close" && (again || reopens.length) ? "act" : move;
  return { move: asked, meant: meant && (meant.item || meant.notItem || meant.between?.length) ? meant : null, told, closes, reopens, again };
}

// Pure: the move's logged reason, built by code from the read's fields (review of #368: never the model's free text).
export function moveReason(r: ExchangeRead, closeHeld = false): string {
  return [`move=${r.move}`, closeHeld ? "close held: safety or a heavy moment" : null, r.again ? "asked for something again" : null, r.reopens.length ? `brought back ${r.reopens.length}` : null, r.closes.length ? `closed ${r.closes.length}` : null, r.told.length ? `answered ${r.told.length} earlier` : null, r.meant?.notItem ? "corrected a referent" : r.meant?.item ? "pointed at an item" : r.meant?.between?.length ? "referent unclear" : null].filter(Boolean).join("; ");
}

// Pure: the record as the reply's per-turn lines (the uncached tail: harness/replyGrounding.ts renderReplyFacts), or null when there's
// nothing to say. A text turn whose read failed gets none (review of #368: no "never again" or "don't reopen" without a read of their
// latest message; the reply runs as before). A call has no turn read: its note keeps the record, softened by "unless they ask".
export function recordLines(rec: ExchangeRecord | null | undefined, o: { call?: boolean } = {}): string | null {
  if (!rec || (!rec.read && !o.call)) return null;
  const r = rec.read;
  const back = new Set(r?.reopens ?? []);
  const closing = new Map((r?.closes ?? []).map((c) => [c.item, c.how]));
  const lines: string[] = [];
  if (rec.done.length) lines.push(`Already done in this exchange (never send or offer these again unless they ask, and then say it's again): ${rec.done.map(itemLine).join("; ")}.`);
  if (r?.told.length) lines.push(`They already told you (never ask these again; build on the answer): ${r.told.map((t) => `"${t.q}" → "${t.a}"`).join("; ")}.`);
  const tie = r?.meant?.between?.length ? r.meant.between.map((id) => rec.done.find((d) => d.id === id)).filter((d): d is DoneItem => !!d) : [];
  if (r?.meant && tie.length >= 2) lines.push(`"${r.meant.phrase}" in their message could mean ${tie.map((d) => `${d.id} (${d.label})`).join(" or ")}, and nothing in the exchange settles which: ask which one, in one short question, and do nothing else with it until they say.`);
  else if (r?.meant?.item || r?.meant?.notItem) lines.push(`"${r.meant.phrase}" in their message means ${r.meant.item ? `${r.meant.item} (${r.meant.label})` : "something not on the list: ask which"}${r.meant.notItem ? `, not ${r.meant.notItem} (${r.meant.notLabel}); they corrected that, so act on the correction` : ""}.`);
  else if (rec.priorMeant[0]) lines.push(`Earlier their pointing words meant ${rec.priorMeant[0].label ?? "something unclear"}${rec.priorMeant[0].notLabel ? `, not ${rec.priorMeant[0].notLabel}` : ""}; that still stands unless they changed it.`);
  const closed = rec.unresolved.filter((u) => !back.has(u.id) && (closing.has(u.id) || u.state === "solved" || u.state === "dropped"));
  if (closed.length) lines.push(`Closed at their word (don't bring these up yourself: no finds, offers or questions about them, unless they bring one back): ${closed.map((u) => `${u.id} ${u.label} (${closing.get(u.id) ?? u.state})`).join("; ")}.`);
  const reopened = rec.unresolved.filter((u) => back.has(u.id));
  if (reopened.length) lines.push(`They're bringing back what they had closed: ${reopened.map((u) => `${u.id} ${u.label}`).join("; ")}. It's theirs to reopen: help with it.`);
  const open = rec.unresolved.filter((u) => !closing.has(u.id) && (u.state === "open" || u.state === "delivered"));
  if (open.length) lines.push(`Still open: ${open.map((u) => `${u.id} ${u.label}${u.state === "delivered" ? " (delivered, not confirmed solved)" : ""}`).join("; ")}.`);
  if (r?.again) lines.push(`They asked for ${r.again} again: send it, and say it's the same one again.`);
  if (r) lines.push(`This turn's move: ${r.move}. ${MOVE_MEANINGS[r.move][0].toUpperCase()}${MOVE_MEANINGS[r.move].slice(1)}.`);
  return lines.length ? `The whole exchange (Cue's record, by id; ids are for you, never for your text):\n${lines.map((l) => `  - ${l}`).join("\n")}` : null;
}

// ---------------------------------------------------------------- loaders (one member's rows each)

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

// What they closed in the last 14 days at their word: their asks, loops, Cue's tasks and threads closed as done or dropped, never by
// staleness, expiry or an archive. Labels only (Cue's own titles, and the ask as Cue filed it). Their asks are where most of the 11-03
// reopenings came from (venue, DJ, weekend finds after the ask was dropped or solved). An ask counts only when they closed it: done or
// found (member: the turn's learning read) or off (moved_on, quoted from their words). Never 'moved' (it moved lanes at their yes, to a
// goal or a look-out: still live), never Cue's own closeAsk (its reason can be "replaced by a newer ask"), and never one they REMOVED in
// what Cue knows (whatCoKnows.ts writes closed 'member' plus a profile_corrections row, item_ref ask:<id>, removed): removed is gone,
// never shown back. Asks get their own share, so loops and tasks never crowd them out.
export const CLOSED_ASKS_MAX = 6;
export const CLOSED_OTHER_MAX = 8;
export async function closedLately(userId: string, db: Q): Promise<ClosedRow[]> {
  const [asks, other] = await Promise.all([
    db.query(
      `SELECT ac.ask_text AS label, CASE WHEN ac.closed_reason = 'moved_on' THEN 'dropped' ELSE 'done' END AS status, ac.resolved_at AS closed_at
       FROM ask_checkins ac
       WHERE ac.user_id = $1 AND ac.resolved_at IS NOT NULL AND ac.expired_at IS NULL AND ac.closed_reason IN ('member','moved_on') AND ac.resolved_at > NOW() - INTERVAL '14 days'
         AND NOT EXISTS (SELECT 1 FROM profile_corrections pc WHERE pc.user_id = ac.user_id AND to_jsonb(pc)->>'item_ref' = 'ask:' || ac.ask_id AND to_jsonb(pc)->>'removed' = 'true')
       ORDER BY ac.resolved_at DESC LIMIT ${CLOSED_ASKS_MAX}`,
      [userId],
    ),
    db.query(
      `(SELECT title AS label, status, closed_at FROM open_loops WHERE user_id = $1 AND status IN ('done','dropped') AND COALESCE(closed_reason,'') NOT IN ('stale','archived') AND closed_at > NOW() - INTERVAL '14 days')
     UNION ALL
     (SELECT goal AS label, status, closed_at FROM co_tasks WHERE user_id = $1 AND status IN ('done','dropped') AND closed_at > NOW() - INTERVAL '14 days' AND COALESCE(outcome,'') ~* 'their word|they said|no longer|dropped:')
     UNION ALL
     (SELECT text AS label, 'done' AS status, closed_at FROM member_threads WHERE user_id = $1 AND status = 'resolved' AND closed_at > NOW() - INTERVAL '14 days')
     ORDER BY closed_at DESC LIMIT ${CLOSED_OTHER_MAX}`,
      [userId],
    ),
  ]);
  return [...asks.rows, ...other.rows].filter((r) => typeof r.label === "string" && r.label.trim()).map((r) => ({ label: String(r.label), how: r.status === "dropped" ? "dropped" : "solved", at: r.closed_at ? new Date(r.closed_at).toISOString() : null }));
}

// What "that" meant in their last turns (MEANT_HOURS), from the decision log (Cue's own item labels, never their words).
export async function priorMeant(userId: string, db: Q): Promise<StoredMeant[]> {
  const { rows } = await db.query(
    `SELECT proposal FROM harness_decisions WHERE user_id = $1 AND decision = 'turn.meant' AND created_at > NOW() - ($2 || ' hours')::interval ORDER BY created_at DESC LIMIT 2`,
    [userId, String(MEANT_HOURS)],
  );
  return rows.map((r) => r.proposal ?? {}).filter((p) => p.label || p.notLabel).map((p) => ({ label: p.label ?? null, notLabel: p.notLabel ?? null }));
}

// The record's reads from the database (what they closed lately, what "that" meant lately), started as soon as the turn starts so the
// turn read never waits on them (review of #368). A failed read leaves its part empty, never the turn.
export type ExchangeFacts = { closed: ClosedRow[]; meant: StoredMeant[] };
export async function loadExchangeFacts(userId: string, db?: Q): Promise<ExchangeFacts> {
  const q = db ?? (await import("../db/db.js")).default;
  const [closed, meant] = await Promise.all([closedLately(userId, q).catch(() => []), priorMeant(userId, q).catch(() => [])]);
  return { closed, meant };
}
// Pure: the base the turn read gets, from the window, the turn's picture and those reads.
export function baseFrom(recentConversation: string, ctx: { sent?: { name: string; url: string | null }[]; asks?: { text: string }[]; carrying?: { label: string; state: "due" | "outstanding" | "done" }[]; threads?: { text: string }[] } | null, f: ExchangeFacts | null): ExchangeBase {
  return { done: doneFrom(recentConversation, (ctx?.sent ?? []).slice(0, 8)), unresolved: unresolvedFrom({ asks: ctx?.asks, carrying: ctx?.carrying, threads: ctx?.threads, closed: f?.closed ?? [] }), priorMeant: f?.meant ?? [] };
}
// The base in one call (calls, tests).
export async function loadExchangeBase(userId: string, o: { recentConversation: string; ctx: { sent?: { name: string; url: string | null }[]; asks?: { text: string }[]; carrying?: { label: string; state: "due" | "outstanding" | "done" }[]; threads?: { text: string }[] } | null; db?: Q }): Promise<ExchangeBase> {
  const db = o.db ?? (await import("../db/db.js")).default;
  return baseFrom(o.recentConversation, o.ctx, await loadExchangeFacts(userId, db));
}

// ---------------------------------------------------------------- calls

// A call's record: what Cue did in the text thread's window and on file, what they closed lately, what "that" meant lately. No turn read
// runs on a call: the call brain picks the move itself from this and the call (callTurnNote), and its sentences are held to it
// (services/callLlmProxy.ts, harness/moveCheck.ts callSentenceMiss).
export async function loadCallExchange(userId: string, db?: Q): Promise<ExchangeRecord> {
  const q = db ?? (await import("../db/db.js")).default;
  const { threadWindow } = await import("./threadWindow.js");
  const { rows } = await q.query(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' ORDER BY created_at DESC LIMIT 60`, [userId]);
  const recent = threadWindow(rows as { content: string }[]).map((r) => r.content).join("\n");
  const base = await loadExchangeBase(userId, { recentConversation: recent, ctx: null, db: q });
  return { ...base, read: null };
}
// Pure: the call turn's note (after their words, past the cache breakpoint): the record and how to pick the move.
export function callTurnNote(rec: ExchangeRecord | null | undefined): string | null {
  if (!rec) return null;
  const lines = recordLines(rec, { call: true });
  return `(Cue's note, not their words.) ${MOVES_GUIDE} Say only what that move needs.${lines ? `\n${lines}` : ""}`;
}

// ---------------------------------------------------------------- the call's read of their latest words (review of #368)
// A call has no turn read, so before a sentence is held for repeating something, one short read of what they said decides whether it
// repeats at all: a question counts as answered only when their reply answers it ("what?", "sorry?", a mishear or a change of subject is
// not an answer), and anything their latest words ask for again or bring back is theirs for this turn. Started with the turn, never
// awaited by the voice: until it lands (or when it fails) nothing is held for repeating (the call runs as before).
export type CallReadInput = { questions: { q: string; reply: string }[]; sent: string[]; closed: string[]; latest: string };
export type CallTurnRead = { answered: string[]; again: string[]; back: string[] };
export function callReadPrompt(i: CallReadInput): string {
  const qs = i.questions.map((x, n) => `Q${n + 1}. Cue asked: "${x.q}" Their next words: "${x.reply}"`).join("\n") || "(none)";
  const sent = i.sent.map((x, n) => `T${n + 1}. ${x}`).join("\n") || "(none)";
  const closed = i.closed.map((x, n) => `C${n + 1}. ${x}`).join("\n") || "(none)";
  return `On a phone call, Cue is about to answer the member. Read only what the member said.

Questions Cue asked earlier on this call, each with the member's next words:
${qs}

Things Cue already sent them:
${sent}

Things they had said were done or dropped:
${closed}

Their latest words: "${i.latest}"

Return ONLY JSON: {"answered": ["Q ids their next words actually answer; "what?", "sorry?", "huh", a mishear, a change of subject or no real answer is not an answer"], "again": ["T ids their latest words ask for again"], "back": ["C ids their latest words bring back or ask about again"]}`;
}
export function parseCallRead(raw: string, i: CallReadInput): CallTurnRead | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const pick = (v: unknown, prefix: string, list: string[]) => (Array.isArray(v) ? v : []).map((x) => String(x).trim().toUpperCase()).filter((x) => new RegExp(`^${prefix}\\d+$`).test(x)).map((x) => list[Number(x.slice(1)) - 1]).filter((x): x is string => !!x);
  return { answered: pick(j.answered, "Q", i.questions.map((x) => x.q)), again: pick(j.again, "T", i.sent), back: pick(j.back, "C", i.closed) };
}
export type CallReader = (prompt: string) => Promise<string>;
export const CALL_READ_TIMEOUT_MS = 2500;
const haikuCallReader: CallReader = async (prompt) => {
  const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 200, abortSignal: AbortSignal.timeout(CALL_READ_TIMEOUT_MS), experimental_telemetry: { isEnabled: true, functionId: "call.exchangeRead" }, prompt });
  return text;
};
// Nothing to read (no question answered, nothing sent or closed): no model call, an empty read.
export async function readCallTurn(i: CallReadInput, reader: CallReader = haikuCallReader): Promise<CallTurnRead | null> {
  if (!i.questions.length && !i.sent.length && !i.closed.length) return { answered: [], again: [], back: [] };
  return parseCallRead(await reader(callReadPrompt(i)), i);
}
