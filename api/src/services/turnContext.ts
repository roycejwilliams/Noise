// One picture of what Co knows, assembled once per turn (Royce, 2026-09-28:
// "Simplify how Co builds a reply: fewer layers, one shared picture of the
// moment"). What Co knew was scattered across co_facts, proactive_candidates
// payloads, revealed_offers, recommendation_offered, member_threads,
// ask_checkins and co_profiles, and each step loaded its own slice: Co said
// "no start time listed" for the Grok Bot night while Luma's 5 PM start was
// on file, and the reaction tool couldn't find an offer Co had sent first.
//
// Every read here is scoped to one member (user_id = $1): nothing about
// anyone else can enter a member's turn through it.
import type { DocOfferContext } from "./documentOffer.js";
import { stampOf } from "./factLabels.js";
import { localDay, localStamp, memberZone, wordsZone } from "./memberTime.js";
import { briefFactLines, openTasks as loadOpenTasks, recentBriefs as loadRecentBriefs, taskFactLines, type BriefView, type CoTask } from "./coTasks.js";
import type { Receipt } from "./deliveryReceipts.js";
import type { Doc } from "./documentSheet.js";
import { receiptDrift, type Drift } from "./receiptDrift.js";
import { adviceLines, loadAdvice } from "./advice.js";
import { loadMilestones, storyLines } from "./milestones.js";
import pool from "../db/db.js";
import { capabilitySheet } from "./capabilities.js";
import { ledgerFacts } from "./coFacts.js";
import { renderEventDetails, type EventDetails } from "./eventDetails.js";
import { describeRead, readLinksLater, savedRead, type LinkRead } from "./linkReader.js";
import { loadKit, type Kit } from "./memberKit.js";
import type { RepliedTo } from "./inlineReply.js";
import { getEmotionalContext, type EmotionalContext } from "../harness/emotion.js";
import { getPersonSnapshot, type PersonSnapshot } from "../harness/personSnapshot.js";

// One entry per thing Co sent them, under the key the router's reaction path
// records outcomes with (offerReactions.ts offerItemKey / revealed_offers), so
// a reaction lands on the same item however it's caught.
export type SentItem = {
  key: string;
  name: string;
  kind: "event" | "opportunity";
  url: string | null;
  sentAt: Date;
  reaction: string | null;
  // Saved or fetched details (time, place). Only for the most recent few.
  details: EventDetails | null;
  // The X post an opportunity came from, when kept.
  postText: string | null;
  // The saved read of its page (services/linkReader.ts), when there is one.
  read?: LinkRead | null;
};

export type TurnContext = {
  userId: string;
  message: string;
  profile: Record<string, any> | null;
  snapshot: PersonSnapshot | null;
  sent: SentItem[];
  asks: { text: string; kind: "find" | "help" }[];
  // line: the thread with its stamp (when they said it, whether it is old): what a call briefing prints. Older than DROP_AFTER_DAYS is left out.
  threads: { text: string; feeling: string | null; line: string }[];
  offersThisWeek: number;
  // As of the last recorded signal; the text route refreshes it after reading this message.
  emotional: EmotionalContext | null;
  lessons: string[];
  inlineTarget: RepliedTo | null;
  ledger: { lines: string[]; named: string[] };
  capabilities: string[];
  // Their own Google Calendar busy times and waiting emails, when connected (services/googleData.ts).
  google?: string[];
  // The details Co has for doing things on their behalf (services/memberKit.ts).
  kit?: Kit;
  // Where they've been with Co, from the record (services/milestones.ts).
  story?: string[];
  // What Co advised them lately (services/advice.ts).
  advice?: string[];
  // Co's open tasks for them (services/coTasks.ts), as scheduled facts.
  tasks?: string[];
  // Their research briefs: running, held for their hours, or finished lately (services/coTasks.ts briefFactLines).
  briefs?: string[];
  // Whether Co may offer to write something up as a document, and any offer still waiting on an answer (services/documentOffer.ts).
  docOffer?: DocOfferContext | null;
  // Documents Co delivered them, newest version each, outstanding first (services/deliveryReceipts.ts receiptLines).
  deliveries?: string[];
  // Goals Co set aside from context that they haven't heard about yet (services/goalEdges.ts untoldSetAsides).
  goalSetAsides?: import("./goalEdges.js").GoalStateRow[];
  // Findable interests on file and the steering so far (services/coldStart.ts): while there are fewer than two, a reply may ask one
  // easy question that lets them name something Co could find (harness/replyGrounding.ts addColdStartSteer).
  coldStart?: import("./coldStart.js").ColdStartView | null;
  // The Co event they're registered for today, if any (services/eventPresence.ts).
  todayEvent?: { eventApiId: string; name: string; startAt: string; timezone: string | null } | null;
  // Everything Co is carrying for them, one ordered view: due first, then outstanding, then done (carryingItems).
  carrying?: CarryItem[];
  // The newest delivered documents, each artifact once, with their text: for "is this about doc #12?" (replyGrounding docHint).
  recentDocs?: { id: number; version: number; title: string; doc: Doc; deliveredAt: Date }[];
  // Delivered documents that no longer match what's true (services/receiptDrift.ts).
  drift?: Drift[];
};

// ---------------------------------------------------------------- what Co is carrying (2026-10-08 review B6)
// Tasks, promises, research briefs, delivered documents and open loops, each in one line, in one order: what's due now, then what's
// outstanding, then what's done, each marked "already told them" when Co has. Pure.
export type CarryItem = { kind: "task" | "promise" | "brief" | "document" | "loop"; label: string; state: "due" | "outstanding" | "done"; told: boolean; dueMs: number | null };
export type LoopLite = { id?: number; title: string; status: string; dueDate: string | null; source: string; detail: string | null };
const DAY = 86_400_000;
export function carryingItems(o: { tasks: CoTask[]; briefs: BriefView[]; receipts: Receipt[]; loops: LoopLite[]; now: Date; zone: string | null }): CarryItem[] {
  const now = o.now.getTime();
  const tomorrow = localDay(new Date(now + DAY), o.zone);
  const items: CarryItem[] = [];
  for (const t of o.tasks.filter((x) => x.status === "open")) {
    const windowDue = t.window && !t.window.closedAt ? new Date(t.window.deadline).getTime() : null;
    const deadlineDue = t.deadline ? new Date(`${t.deadline}T23:59:00Z`).getTime() : null;
    const due = (windowDue !== null && windowDue - now <= DAY) || (!!t.deadline && t.deadline <= tomorrow) || (!!t.nextCheckAt && new Date(t.nextCheckAt).getTime() <= now);
    const promise = t.source === "promise";
    const what = promise ? t.goal.replace(/^Keep your promise:\s*/i, "") : `"${t.goal}"`;
    const by = t.window && !t.window.closedAt ? ` (${t.window.words}, by ${localStamp(t.window.deadline, t.window.zone ?? o.zone)})` : t.deadline ? ` (their deadline ${t.deadline})` : "";
    items.push({ kind: promise ? "promise" : "task", label: `${promise ? `your promise, task #${t.id}` : `task #${t.id}`}: ${what}${by}`, state: due ? "due" : "outstanding", told: promise || !!t.lastTextedAt, dueMs: windowDue ?? deadlineDue });
  }
  for (const b of o.briefs) {
    if (b.status === "open" && b.held) items.push({ kind: "brief", label: `research brief #${b.id}: "${b.goal}" is finished and hasn't reached them`, state: "due", told: false, dueMs: now });
    else if (b.status === "open") items.push({ kind: "brief", label: `research brief #${b.id}: "${b.goal}", running`, state: "outstanding", told: true, dueMs: null });
    else if (b.status === "done") items.push({ kind: "brief", label: `research brief #${b.id}: "${b.goal}", finished`, state: "done", told: true, dueMs: null });
  }
  const newest = new Map<string, Receipt>();
  for (const r of [...o.receipts].sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime())) if (!newest.has(r.docKey)) newest.set(r.docKey, r);
  for (const r of [...newest.values()].slice(0, 5)) {
    if (r.status === "pdf_pending") items.push({ kind: "document", label: `doc #${r.id} "${r.title}": the PDF still follows (the text went)`, state: "outstanding", told: true, dueMs: null });
    else items.push({ kind: "document", label: `doc #${r.id} "${r.title}", version ${r.version}, delivered`, state: "done", told: true, dueMs: null });
  }
  // Task loops are the tasks above; the rest (their notes, an ask, an offer) are the loops' own.
  for (const l of o.loops.filter((x) => x.source !== "task" && x.status !== "done" && x.status !== "dropped").slice(0, 6)) {
    const due = !!l.dueDate && l.dueDate <= tomorrow;
    items.push({ kind: "loop", label: `${l.id != null ? `[loop ${l.id}] ` : ""}${l.title}: ${l.status.replace(/_/g, " ")}${l.detail ? ` (${l.detail.slice(0, 80)})` : ""}${l.dueDate ? `, due ${l.dueDate}` : ""}`, state: due ? "due" : "outstanding", told: false, dueMs: l.dueDate ? new Date(`${l.dueDate}T23:59:00Z`).getTime() : null });
  }
  const rank = { due: 0, outstanding: 1, done: 2 } as const;
  return items.sort((a, b) => rank[a.state] - rank[b.state] || (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity)).slice(0, 14);
}
export function carryingBlock(items: CarryItem[] | null | undefined): string | null {
  if (!items?.length) return null;
  const head = { due: "Due now", outstanding: "Outstanding", done: "Done lately" } as const;
  const parts = (["due", "outstanding", "done"] as const)
    .map((st) => {
      const xs = items.filter((i) => i.state === st);
      return xs.length ? `${head[st]}: ${xs.map((i) => `${i.label}${i.told ? " [already told them]" : ""}`).join("; ")}.` : null;
    })
    .filter(Boolean);
  return `Everything you're carrying for them, in one order (due first; the details are in the facts above${items.some((i) => i.kind === "loop" && /^\[loop \d+\]/.test(i.label)) ? "; [loop N] ids are for updateLoop, never for your texts" : ""}): ${parts.join(" ")} Lead with what's due when it fits; never repeat what's marked already told them unless they ask.`;
}

const nameKey = (n: string) => `name:${n.toLowerCase()}`;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Everything Co sent them in the last 45 days, one list: revealed_offers
// (search results and offers Co sent first), the offers' saved payloads for
// details, and older recommendation_offered rows.
export async function loadSentItems(userId: string, days = 45): Promise<SentItem[]> {
  const [revealed, offers, recs] = await Promise.all([
    pool
      .query(
        `SELECT item_key, item_name, kind, url, sent_at, reaction FROM revealed_offers
         WHERE user_id = $1 AND sent_at > NOW() - make_interval(days => $2) ORDER BY sent_at DESC LIMIT 60`,
        [userId, days],
      )
      .then((r) => r.rows)
      .catch(() => [] as any[]),
    pool
      .query(
        `SELECT payload->'match' AS m, decided_at FROM proactive_candidates
         WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND decided_at > NOW() - make_interval(days => $2)
         ORDER BY decided_at DESC LIMIT 30`,
        [userId, days],
      )
      .then((r) => r.rows)
      .catch(() => [] as any[]),
    pool
      .query(
        `SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'recommendation_offered'
         AND created_at > NOW() - make_interval(days => $2) ORDER BY created_at DESC LIMIT 60`,
        [userId, days],
      )
      .then((r) => r.rows)
      .catch(() => [] as any[]),
  ]);
  return mergeSent(revealed, offers, recs);
}

// Pure: the three sources as one list, one entry per thing, revealed_offers'
// key first (the router's), details and post text filled in from the offers.
export function mergeSent(revealed: any[], offers: any[], recs: any[]): SentItem[] {
  const byName = new Map<string, SentItem>();
  const add = (item: SentItem) => {
    const k = norm(item.name);
    const had = byName.get(k);
    if (!had) byName.set(k, item);
    else {
      // Same thing from another source: keep the first key, fill in what's missing.
      had.url ??= item.url;
      had.details ??= item.details;
      had.postText ??= item.postText;
      had.reaction ??= item.reaction;
    }
  };
  for (const r of revealed) {
    if (!r.item_name) continue;
    add({ key: r.item_key, name: r.item_name, kind: r.kind === "event" ? "event" : "opportunity", url: r.url ?? null, sentAt: new Date(r.sent_at), reaction: r.reaction ?? null, details: null, postText: null });
  }
  for (const r of offers) {
    const m = r.m ?? {};
    if (!m.name) continue;
    add({
      key: m.event_api_id ? `event:${m.event_api_id}` : nameKey(m.name),
      name: m.name,
      kind: m.kind === "opportunity" ? "opportunity" : "event",
      url: m.url ?? null,
      sentAt: new Date(r.decided_at),
      reaction: null,
      details: m.details ?? null,
      postText: m.opportunity?.postText ?? m.evidence ?? null,
    });
  }
  for (const r of recs) {
    let x: any = null;
    try {
      x = JSON.parse(r.content);
    } catch {}
    if (!x?.name) continue;
    add({ key: x.event_api_id ? `event:${x.event_api_id}` : nameKey(x.name), name: x.name, kind: x.event_api_id ? "event" : "opportunity", url: x.url ?? null, sentAt: new Date(r.created_at), reaction: null, details: null, postText: null });
  }
  return [...byName.values()].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
}

// Details for the few most recent sends: saved, else their Luma page, else a
// Luma page linked from the X post (Royce, 2026-09-28: "we must gather time
// and date").
// Saved page reads only: nothing is fetched while they wait (Royce,
// 2026-09-28: every link is read once, when it's sent). A link with no read
// yet is read in the background for next time. An X post's own links are
// read too, and a readable one stands in for the post.
export async function fillDetails(items: SentItem[], opts: { withinDays?: number; max?: number } = {}): Promise<void> {
  const cutoff = Date.now() - (opts.withinDays ?? 5) * 86_400_000;
  const recent = items.filter((i) => i.sentAt.getTime() > cutoff).slice(0, opts.max ?? 5);
  await Promise.all(
    recent.map(async (i) => {
      const own = i.url ? await savedRead(i.url).catch(() => null) : null;
      let read = own;
      if ((!read || read.status !== "ok") && i.postText) {
        for (const link of i.postText.match(/https?:\/\/[^\s)"'<>]+/g) ?? []) {
          const r = await savedRead(link).catch(() => null);
          if (r?.status === "ok") {
            read = r;
            break;
          }
          if (!r) readLinksLater(link);
        }
      }
      i.read = read;
      if (!own && i.url) readLinksLater(i.url);
    }),
  );
}

// What's on file for each recent send, and what isn't, as facts: "I don't
// have the start time" is then only ever true.
export function sentDetailLines(ctx: Pick<TurnContext, "sent"> & { google?: string[] }, withinDays = 5): string[] {
  const cutoff = Date.now() - withinDays * 86_400_000;
  return [...sentLines(ctx, cutoff), ...(ctx.google ?? [])];
}

function sentLines(ctx: Pick<TurnContext, "sent">, cutoff: number): string[] {
  return ctx.sent
    .filter((s) => s.sentAt.getTime() > cutoff)
    .slice(0, 5)
    .map((s) => {
      if (s.read) return describeRead(s.name, s.read).facts.join(" ");
      if (!s.details) return `Co sent them "${s.name}"${s.url ? ` (${s.url})` : ""}; its page hasn't been read yet, so Co has no start time or address for it.`;
      const known = renderEventDetails(s.name, s.details).join(" ");
      const missing = [s.details.startAt ? null : "start time", s.details.venue || s.details.address ? null : "address"].filter(Boolean);
      return `Details on file for "${s.name}", which Co sent them: ${known}${missing.length ? ` Not on file: ${missing.join(", ")}.` : ""}`;
    });
}

// Co's own reads of those pages and anything unconfirmed: hints for drafting,
// never sources for the fact check.
export function sentDetailHints(ctx: Pick<TurnContext, "sent">, withinDays = 5): string[] {
  const cutoff = Date.now() - withinDays * 86_400_000;
  return ctx.sent
    .filter((s) => s.sentAt.getTime() > cutoff && s.read)
    .slice(0, 5)
    .flatMap((s) => describeRead(s.name, s.read!).hints);
}

// A thing Co sent, by the name the member (or Co's tool) used for it.
export function findSent(sent: SentItem[], name: string): SentItem | undefined {
  const want = norm(name);
  return sent.find((x) => norm(x.name) === want) ?? sent.find((x) => norm(x.name).includes(want) || want.includes(norm(x.name)));
}

export async function assembleContext(
  userId: string,
  message: string,
  opts: {
    // The inline-reply target, resolved by the text route as the message arrives.
    inlineTarget?: Promise<RepliedTo | null> | RepliedTo | null;
    // Co's last few lines, so older things they name are found in the record.
    ledgerContext?: string;
  } = {},
): Promise<TurnContext> {
  // Their zone (services/memberTime.ts), read once: stamps, the ledger's days, task times and Google facts are all in it.
  const zone = await memberZone(userId);
  // Tasks and briefs are read once and shared: their fact lines below, and what Co is carrying (carryingItems).
  const once = <T,>(f: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ??= f()); };
  const tasksOnce = once(() => loadOpenTasks(userId));
  const briefsOnce = once(() => loadRecentBriefs(userId));
  const openTasks = (_: string) => tasksOnce();
  const recentBriefs = (_: string) => briefsOnce();
  const [profile, snapshot, sent, asks, threads, offersThisWeek, emotional, lessons, inlineTarget, ledger] = await Promise.all([
    pool.query(`SELECT * FROM co_profiles WHERE user_id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
    getPersonSnapshot(userId).catch(() => null),
    loadSentItems(userId).then(async (items) => {
      await fillDetails(items).catch(() => {});
      return items;
    }),
    pool
      .query(`SELECT ask_text, kind FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY last_mentioned_at DESC NULLS LAST, created_at DESC LIMIT 12`, [userId])
      .then((r) => r.rows.map((x: any) => ({ text: String(x.ask_text ?? ""), kind: x.kind === "help" ? ("help" as const) : ("find" as const) })))
      .catch(() => [] as { text: string; kind: "find" | "help" }[]),
    pool
      .query(`SELECT text, feeling, opened_at, last_touched_at, due_date FROM member_threads WHERE user_id = $1 AND status IN ('open', 'waiting') ORDER BY last_touched_at DESC NULLS LAST LIMIT 8`, [userId])
      .then((r) => r.rows.flatMap((x: any) => {
        const st = stampOf({ saidOn: x.opened_at, confirmedOn: x.last_touched_at, dueOn: x.due_date instanceof Date ? x.due_date.toISOString().slice(0, 10) : x.due_date }, new Date(), wordsZone(zone));
        return st.drop ? [] : [{ text: String(x.text), feeling: x.feeling ?? null, line: `${String(x.text)} (${st.label})` }];
      }))
      .catch(() => [] as { text: string; feeling: string | null; line: string }[]),
    pool
      .query(`SELECT count(*)::int AS n FROM proactive_sends WHERE user_id = $1 AND type = 'event_offer' AND NOT exempt AND sent_at > NOW() - INTERVAL '7 days'`, [userId])
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0),
    getEmotionalContext(userId).catch(() => null),
    pool
      .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'co_lesson' ORDER BY created_at DESC LIMIT 6`, [userId])
      .then((r) => r.rows.map((x: any) => String(x.content)))
      .catch(() => [] as string[]),
    Promise.resolve(opts.inlineTarget ?? null).catch(() => null),
    ledgerFacts(userId, `${message}\n${opts.ledgerContext ?? ""}`, zone).catch(() => ({ lines: [] as string[], named: [] as string[] })),
  ]);
  // Their Google, read from the cache in their own time zone (never fetched while they wait).
  const google = await loadGoogleFacts(userId, zone).catch(() => [] as string[]);
  const [kit, story, advice, tasks, briefs, todayEvent, docOffer] = await Promise.all([
    loadKit(userId).catch(() => ({}) as Kit),
    loadMilestones(userId).then((m) => storyLines(m, 4)).catch(() => [] as string[]),
    loadAdvice(userId).then((a) => adviceLines(a)).catch(() => [] as string[]),
    // In their local time (services/memberTime.ts), with each commitment's window.
    openTasks(userId).then((t) => taskFactLines(t, undefined, zone)).catch(() => [] as string[]),
    // Research briefs aren't work tasks (openTasks leaves them out) but are theirs to see: running, held, or sent lately.
    recentBriefs(userId).then((b) => briefFactLines(b, zone)).catch(() => [] as string[]),
    import("./eventPresence.js").then((e) => e.todayEventFor(userId)).catch(() => null),
    import("./documentOffer.js").then((m) => m.loadDocOfferContext(userId)).catch(() => null),
  ]);
  const receipts = await import("./deliveryReceipts.js").then((R) => R.pgReceipts.forUser(userId, 30)).catch(() => [] as Receipt[]);
  const deliveries = await import("./deliveryReceipts.js").then(async (R) => R.receiptLines(receipts, zone)).catch(() => [] as string[]);
  // Open loops, read only (the text route syncs them): the non-task ones join what Co is carrying.
  const [loops, rejected, notes] = await Promise.all([
    pool
      .query(`SELECT id, title, status, due_date, source, detail FROM open_loops WHERE user_id = $1 AND closed_at IS NULL AND status NOT IN ('done', 'dropped') ORDER BY changed_at DESC LIMIT 12`, [userId])
      .then((r) => r.rows.map((x: any) => ({ id: Number(x.id), title: String(x.title), status: String(x.status), dueDate: x.due_date instanceof Date ? x.due_date.toISOString().slice(0, 10) : x.due_date ?? null, source: String(x.source), detail: x.detail ?? null }) as LoopLite))
      .catch(() => [] as LoopLite[]),
    // Options they passed on lately, for a delivered document that still lists one (services/receiptDrift.ts).
    pool
      .query(`SELECT name, outcome_at FROM research_finds WHERE user_id = $1 AND outcome = 'no' AND outcome_at > NOW() - INTERVAL '30 days' ORDER BY outcome_at DESC LIMIT 20`, [userId])
      .then((r) => r.rows.map((x: any) => ({ name: String(x.name), at: new Date(x.outcome_at) })))
      .catch(() => [] as { name: string; at: Date }[]),
    pool
      .query(`SELECT brief, updated_at FROM search_briefs WHERE user_id = $1`, [userId])
      .then((r) => (r.rows[0]?.brief ? { headcount: typeof r.rows[0].brief.headcount === "number" ? r.rows[0].brief.headcount : null, when: r.rows[0].brief.when ?? null, updatedAt: r.rows[0].updated_at ? new Date(r.rows[0].updated_at) : null } : null))
      .catch(() => null),
  ]);
  const recentDocs = newestDocs(receipts, 3);
  const drift = recentDocs.map((d) => receiptDrift(d, { notes, rejected, eventStartsAt: todayEvent?.startAt ? new Date(todayEvent.startAt) : null })).filter((x): x is Drift => !!x);
  const rawTasks = await tasksOnce().catch(() => [] as CoTask[]);
  const rawBriefs = await briefsOnce().catch(() => [] as BriefView[]);
  const carrying = carryingItems({ tasks: rawTasks, briefs: rawBriefs, receipts, loops, now: new Date(), zone });
  const openWork = [...rawTasks.filter((t) => t.status === "open").map((t) => t.goal), ...rawBriefs.filter((b) => b.status === "open").map((b) => `research brief: ${b.goal}`)];
  // The plan sheet, venue brief and stale-document offers decide per reply from these (services/documentOffer.ts docOfferLines).
  if (docOffer) {
    docOffer.signals = await import("./documentOffer.js")
      .then((m) => m.loadArtifactSignals(userId, { drift, openWork, delivered: [...new Map(receipts.map((r) => [r.docKey, r])).values()].map((r) => ({ title: r.title, kind: r.kind, at: r.deliveredAt })) }))
      .catch(() => null);
  }
  const coldStartP = import("./coldStart.js").then((c) => c.loadColdStart(userId, { profile, asks })).catch(() => null);
  const goalSetAsides = await import("./goalEdges.js").then((g) => g.untoldSetAsides(userId)).catch(() => []);
  const coldStart = await coldStartP;
  return { userId, message, profile, snapshot, sent, asks, threads, offersThisWeek, emotional, lessons, inlineTarget, ledger, capabilities: capabilitySheet(), google, kit, story, advice, tasks, briefs, todayEvent, docOffer, deliveries, carrying, recentDocs, drift, goalSetAsides, coldStart };
}

// Pure: the newest version of each delivered artifact, newest first.
export function newestDocs(receipts: Receipt[], n: number): NonNullable<TurnContext["recentDocs"]> {
  const seen = new Set<string>();
  const out: NonNullable<TurnContext["recentDocs"]> = [];
  for (const r of [...receipts].sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime())) {
    if (seen.has(r.docKey) || !r.doc?.sections) continue;
    seen.add(r.docKey);
    out.push({ id: r.id, version: r.version, title: r.title, doc: r.doc, deliveredAt: r.deliveredAt });
    if (out.length >= n) break;
  }
  return out;
}

async function loadGoogleFacts(userId: string, zone: string | null): Promise<string[]> {
  const { isConnected } = await import("./googleAuth.js");
  if (!(await isConnected(userId)).connected) return [];
  const { googleFactsFor } = await import("./googleData.js");
  return googleFactsFor(userId, zone);
}
