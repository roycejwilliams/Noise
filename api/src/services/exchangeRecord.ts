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
export const MOVES_GUIDE = `Pick the move from the whole exchange, not from their last line alone: what they asked and corrected, what Cue already did or asked, what's still open, how they feel, and their rules. The moves: ${EXCHANGE_MOVES.map((m) => `${m} (${MOVE_MEANINGS[m]})`).join("; ")}.`;

export type DoneKind = "link" | "find" | "card" | "document" | "question" | "offer";
// replied: they wrote back after it (a question or offer they've had the chance to answer).
export type DoneItem = { id: string; kind: DoneKind; label: string; url: string | null; replied: boolean };
export type UnresolvedState = "open" | "delivered" | "solved" | "dropped";
export type UnresolvedItem = { id: string; label: string; state: UnresolvedState };
export type Told = { q: string; a: string };
// item / notItem: done ids this turn. label / notLabel: their labels (what carries to the next turn).
export type Meant = { phrase: string; item: string | null; label: string | null; notItem: string | null; notLabel: string | null };
export type StoredMeant = { phrase: string; label: string | null; notLabel: string | null };
export type ExchangeBase = { done: DoneItem[]; unresolved: UnresolvedItem[]; priorMeant: StoredMeant[] };
export type ExchangeRead = { move: ExchangeMove; why: string | null; meant: Meant | null; told: Told[]; closes: { item: string; how: "solved" | "dropped" }[]; again: string | null };
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

export type ClosedRow = { label: string; how: "solved" | "dropped" };
// Pure: what's still open for them, then what they closed lately. Open asks and threads are open; what Cue carries is open until it's
// done, then delivered (delivered is not solved: only their word solves it). Numbered U1...
export function unresolvedFrom(o: { asks?: { text: string }[]; carrying?: { label: string; state: "due" | "outstanding" | "done" }[]; threads?: { text: string }[]; closed?: ClosedRow[] }): UnresolvedItem[] {
  const out: Omit<UnresolvedItem, "id">[] = [
    ...(o.asks ?? []).map((a) => ({ label: a.text, state: "open" as const })),
    ...(o.carrying ?? []).map((c) => ({ label: c.label, state: c.state === "done" ? ("delivered" as const) : ("open" as const) })),
    ...(o.threads ?? []).map((t) => ({ label: t.text, state: "open" as const })),
  ];
  const seen = new Set(out.map((x) => x.label.toLowerCase()));
  for (const c of o.closed ?? []) if (!seen.has(c.label.toLowerCase())) (seen.add(c.label.toLowerCase()), out.push({ label: c.label, state: c.how }));
  return out.slice(0, UNRESOLVED_MAX).map((u, i) => ({ id: `U${i + 1}`, label: u.label.replace(/\s+/g, " ").slice(0, 160), state: u.state }));
}

const itemLine = (d: DoneItem) => `${d.id} ${d.kind}: ${d.label}${d.url && d.kind !== "link" ? ` (${d.url})` : d.url && d.label !== normUrl(d.url).slice(0, 120) ? ` (${d.url})` : ""}${(d.kind === "question" || d.kind === "offer") && !d.replied ? " [no answer yet]" : ""}`;

// The part of the turn read's prompt that carries the record (services/readTurn.ts turnReadAddendum), and the fields it asks for.
export function exchangeAddendum(b: ExchangeBase | null | undefined): string {
  if (!b) return "";
  const done = b.done.map((d) => `- ${itemLine(d)}`).join("\n") || "- (nothing yet)";
  const open = b.unresolved.map((u) => `- ${u.id} [${u.state}] ${u.label}`).join("\n") || "- (nothing)";
  const prior = b.priorMeant.length ? `\nEarlier in this conversation, what their words pointed to (Cue's own items): ${b.priorMeant.map((m) => `"${m.phrase}" meant ${m.label ?? "unclear"}${m.notLabel ? `, not ${m.notLabel}` : ""}`).join("; ")}. A correction carries forward until they say otherwise.\n` : "";

  return `

What Cue already did in this exchange (newest first, by id):
${done}

What's open or closed for them (by id; only their word makes something solved or dropped, never silence):
${open}
${prior}
"move": the one move for Cue's reply. ${MOVES_GUIDE} One of: ${EXCHANGE_MOVES.map((m) => `"${m}"`).join(", ")}.
"move_why": a few words on why, from the exchange (no names, no quotes).
"refers_to": when their message points at something with "that", "it", "this one", "the second one", "him" or similar, {"phrase": "their pointing word or two", "item": the D id it means, or null when it isn't on the list, "not_item": the D id they say they did NOT mean (a correction like "no, the other one"), or null}; otherwise null.
"answered": Cue's questions in the conversation above (or offers in the list) that they have already answered, each {"q": "Cue's question, word for word", "a": "their answer, in a few of their words"}; [] if none. Count an answer even if it came several texts later or in other words.
"closes": items on the open list their latest message says are done, solved or dropped, each {"item": "U id", "how": "solved" | "dropped"}; [] if none. Only their own words close something.
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
  const meant: Meant | null = r && typeof r === "object" && s(r.phrase, 40) ? { phrase: s(r.phrase, 40)!, item: doneId(r.item), label: labelOf(doneId(r.item)), notItem: doneId(r.not_item), notLabel: labelOf(doneId(r.not_item)) } : null;
  const told: Told[] = (Array.isArray(obj?.answered) ? obj.answered : []).map((t: any) => ({ q: s(t?.q, 200), a: s(t?.a, 200) })).filter((t: any): t is Told => !!t.q && !!t.a).slice(0, 6);
  const closes = (Array.isArray(obj?.closes) ? obj.closes : [])
    .map((c: any) => ({ item: s(c?.item, 8)?.toUpperCase() ?? "", how: c?.how === "dropped" ? ("dropped" as const) : ("solved" as const) }))
    .filter((c: { item: string }) => b.unresolved.some((u) => u.id === c.item && (u.state === "open" || u.state === "delivered")))
    .slice(0, 6);
  return { move, why: s(obj?.move_why, 160), meant: meant && (meant.item || meant.notItem) ? meant : null, told, closes, again: doneId(obj?.asks_again) };
}

// Pure: the record as the reply's per-turn lines (the uncached tail: harness/replyGrounding.ts renderReplyFacts), or null when there's
// nothing to say. The move's reason is logged only, never put here.
export function recordLines(rec: ExchangeRecord | null | undefined): string | null {
  if (!rec) return null;
  const r = rec.read;
  const closing = new Map((r?.closes ?? []).map((c) => [c.item, c.how]));
  const lines: string[] = [];
  if (rec.done.length) lines.push(`Already done in this exchange (never send or offer these again unless they ask, and then say it's again): ${rec.done.map(itemLine).join("; ")}.`);
  if (r?.told.length) lines.push(`They already told you (never ask these again; build on the answer): ${r.told.map((t) => `"${t.q}" → "${t.a}"`).join("; ")}.`);
  if (r?.meant?.item || r?.meant?.notItem) lines.push(`"${r.meant.phrase}" in their message means ${r.meant.item ? `${r.meant.item} (${r.meant.label})` : "something not on the list: ask which"}${r.meant.notItem ? `, not ${r.meant.notItem} (${r.meant.notLabel}); they corrected that, so act on the correction` : ""}.`);
  else if (rec.priorMeant[0]) lines.push(`Earlier "${rec.priorMeant[0].phrase}" meant ${rec.priorMeant[0].label ?? "something unclear"}${rec.priorMeant[0].notLabel ? `, not ${rec.priorMeant[0].notLabel}` : ""}; that still stands unless they changed it.`);
  const closed = rec.unresolved.filter((u) => closing.has(u.id) || u.state === "solved" || u.state === "dropped");
  if (closed.length) lines.push(`Closed at their word (don't reopen: no finds, offers or questions about these): ${closed.map((u) => `${u.id} ${u.label} (${closing.get(u.id) ?? u.state})`).join("; ")}.`);
  const open = rec.unresolved.filter((u) => !closing.has(u.id) && (u.state === "open" || u.state === "delivered"));
  if (open.length) lines.push(`Still open: ${open.map((u) => `${u.id} ${u.label}${u.state === "delivered" ? " (delivered, not confirmed solved)" : ""}`).join("; ")}.`);
  if (r?.again) lines.push(`They asked for ${r.again} again: send it, and say it's the same one again.`);
  if (r) lines.push(`This turn's move: ${r.move}. ${MOVE_MEANINGS[r.move][0].toUpperCase()}${MOVE_MEANINGS[r.move].slice(1)}.`);
  return lines.length ? `The whole exchange (Cue's record, by id; ids are for you, never for your text):\n${lines.map((l) => `  - ${l}`).join("\n")}` : null;
}

// ---------------------------------------------------------------- loaders (one member's rows each)

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

// What they closed in the last 14 days at their word: loops, Cue's tasks and threads closed as done or dropped, never by staleness or
// an archive. Labels only (Cue's own titles).
export async function closedLately(userId: string, db: Q): Promise<ClosedRow[]> {
  const { rows } = await db.query(
    `(SELECT title AS label, status, closed_at FROM open_loops WHERE user_id = $1 AND status IN ('done','dropped') AND COALESCE(closed_reason,'') NOT IN ('stale','archived') AND closed_at > NOW() - INTERVAL '14 days')
     UNION ALL
     (SELECT goal AS label, status, closed_at FROM co_tasks WHERE user_id = $1 AND status IN ('done','dropped') AND closed_at > NOW() - INTERVAL '14 days' AND COALESCE(outcome,'') ~* 'their word|they said|no longer|dropped:')
     UNION ALL
     (SELECT text AS label, 'done' AS status, closed_at FROM member_threads WHERE user_id = $1 AND status = 'resolved' AND closed_at > NOW() - INTERVAL '14 days')
     ORDER BY closed_at DESC LIMIT 8`,
    [userId],
  );
  return rows.filter((r) => typeof r.label === "string" && r.label.trim()).map((r) => ({ label: String(r.label), how: r.status === "dropped" ? "dropped" : "solved" }));
}

// What "that" meant in their last turns (MEANT_HOURS), from the decision log (Cue's own item labels, never their words).
export async function priorMeant(userId: string, db: Q): Promise<StoredMeant[]> {
  const { rows } = await db.query(
    `SELECT proposal FROM harness_decisions WHERE user_id = $1 AND decision = 'turn.meant' AND created_at > NOW() - ($2 || ' hours')::interval ORDER BY created_at DESC LIMIT 2`,
    [userId, String(MEANT_HOURS)],
  );
  return rows.map((r) => r.proposal ?? {}).filter((p) => typeof p.phrase === "string").map((p) => ({ phrase: String(p.phrase).slice(0, 40), label: p.label ?? null, notLabel: p.notLabel ?? null }));
}

// The base the turn read gets: done from the window and what's on file as sent, unresolved from the turn's picture plus what they closed
// lately, and what "that" meant lately. A failed read leaves its part empty, never the turn.
export async function loadExchangeBase(userId: string, o: { recentConversation: string; ctx: { sent?: { name: string; url: string | null }[]; asks?: { text: string }[]; carrying?: { label: string; state: "due" | "outstanding" | "done" }[]; threads?: { text: string }[] } | null; db?: Q }): Promise<ExchangeBase> {
  const db = o.db ?? (await import("../db/db.js")).default;
  const [closed, meant] = await Promise.all([closedLately(userId, db).catch(() => []), priorMeant(userId, db).catch(() => [])]);
  return { done: doneFrom(o.recentConversation, (o.ctx?.sent ?? []).slice(0, 8)), unresolved: unresolvedFrom({ asks: o.ctx?.asks, carrying: o.ctx?.carrying, threads: o.ctx?.threads, closed }), priorMeant: meant };
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
  const lines = recordLines(rec);
  return `(Cue's note, not their words.) ${MOVES_GUIDE} Say only what that move needs.${lines ? `\n${lines}` : ""}`;
}
