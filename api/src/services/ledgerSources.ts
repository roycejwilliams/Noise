// The old stores the action ledger (services/ledger.ts) mirrors, read for one member at a time, and the two things done with them:
//   backfillRows     the ledger rows the backfill writes from them (scripts/ledgerBackfill.ts)
//   reconcileMember  each old-store act matched against the member's ledger rows; what's left unmatched, with its contents, and any
//                    act the ledger holds twice (scripts/ledgerReconcile.ts). The reader switch waits on it reporting nothing.
// Snapshot design 2026-10-29 §3 steps 2 and 3. Every read is scoped to one member (user_id = $1 / owner_user_id = $1).
import pg from "pg";
import { toolAction } from "./coFacts.js";
import {
  ITEM_WINDOW_MS, TRIPLE_WINDOW_MS, documentLabel, documentRow, itemKeys, normName, offerRow, recommendationRow, recommendationSegmentRow, recommendationSegments,
  surfacingName, surfacingRow, textedRow, textKey, toolOutcomeRow, transcriptTextRow, writeLedgerRow,
  type LedgerRow, type LedgerStore, type StoredLedgerRow, type ToolReceipt, type WriteResult,
} from "./ledger.js";

export type Sources = {
  userId: string;
  // text_exchange "Co replied: ..." lines, the prefix taken off.
  replied: { id: string; at: Date; text: string }[];
  // Cue's sends by handle (sender 'co').
  outbound: { handle: string; at: Date; content: string }[];
  // Sends recorded under another sender ('mo', 'ops'): not Cue's acts toward them, counted only.
  outboundOther: number;
  tools: { id: string; decision: string; action: string | null; at: Date; proposal: any }[];
  // event_offer_pending, event_discovery_surfacing, event_offer_resolved, recommendation_offered, recommendation.
  memories: { id: string; type: string; at: Date; content: string }[];
  docs: { id: string; at: Date; title: string; channel: string; version: number; docKey: string; link: string | null; status: string }[];
  // The member's ledger rows as they are.
  ledger: StoredLedgerRow[];
};

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
// The driver's own reading of a timestamptz (what a RETURNING row's Date is).
const pgTime = (t: unknown): Date => pg.types.getTypeParser(1184, "text")(String(t)) as Date;
export const MEMORY_TYPES = ["event_offer_pending", "event_discovery_surfacing", "event_offer_resolved", "recommendation_offered", "recommendation"];
const REPLIED = /^Co replied: ?/;

// One member's old stores and ledger rows, in one round trip. Reads only; every part is scoped to the member ($1).
// Times come back as Postgres text and are read by the driver's own timestamptz parser, so a backfilled row's happened_at is the
// exact Date the live write used (both truncate to the millisecond the same way) and the two meet on the unique key.
export async function loadSources(q: Query, userId: string): Promise<Sources> {
  const agg = (select: string, order: string) => `(SELECT coalesce(json_agg(x ORDER BY ${order}), '[]'::json) FROM (${select}) x)`;
  const { rows } = await q(
    `SELECT
       ${agg(`SELECT id, created_at::text AS at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'Co replied:%'`, "x.at, x.id")} AS replied,
       ${agg(`SELECT message_handle AS handle, sent_at::text AS at, content FROM outbound_messages WHERE user_id = $1 AND sender = 'co'`, "x.at, x.handle")} AS outbound,
       (SELECT count(*)::int FROM outbound_messages WHERE user_id = $1 AND sender <> 'co') AS other,
       ${agg(`SELECT id, decision, action, created_at::text AS at, jsonb_build_object('input', proposal->'input', 'recordAs', proposal->'recordAs', 'made', proposal->'made', 'removal', proposal->'removal') AS proposal FROM harness_decisions WHERE user_id = $1 AND decision LIKE 'tool.%'`, "x.at, x.id")} AS tools,
       ${agg(`SELECT id, memory_type AS type, created_at::text AS at, content FROM co_memories WHERE user_id = $1 AND memory_type = ANY($2::text[])`, "x.at, x.id")} AS memories,
       ${agg(`SELECT id, delivered_at::text AS at, title, channel, version, doc_key, link, status FROM document_deliveries WHERE user_id = $1`, "x.at, x.id")} AS docs,
       ${agg(`SELECT relation, object_key, object_label, url, happened_at::text AS at, source, meta FROM co_facts WHERE owner_user_id = $1 AND meta ? 'ledger'`, "x.at")} AS ledger`,
    [userId, MEMORY_TYPES],
  );
  const r = rows[0] ?? {};
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : typeof v === "string" ? JSON.parse(v) : []);
  return {
    userId,
    replied: list(r.replied).map((x) => ({ id: String(x.id), at: pgTime(x.at), text: String(x.content ?? "").replace(REPLIED, "") })),
    outbound: list(r.outbound).map((x) => ({ handle: String(x.handle), at: pgTime(x.at), content: String(x.content ?? "") })),
    outboundOther: Number(r.other ?? 0),
    tools: list(r.tools).map((x) => ({ id: String(x.id), decision: String(x.decision), action: x.action ?? null, at: pgTime(x.at), proposal: x.proposal ?? null })),
    memories: list(r.memories).map((x) => ({ id: String(x.id), type: String(x.type), at: pgTime(x.at), content: String(x.content ?? "") })),
    docs: list(r.docs).map((x) => ({ id: String(x.id), at: pgTime(x.at), title: String(x.title), channel: String(x.channel), version: Number(x.version), docKey: String(x.doc_key), link: x.link ?? null, status: String(x.status) })),
    ledger: list(r.ledger).map((x) => ({ userId, relation: String(x.relation), objectKey: String(x.object_key), label: String(x.object_label), url: x.url ?? null, at: pgTime(x.at), source: String(x.source), meta: x.meta ?? {} })),
  };
}

// ------------------------------------------------------------ pure helpers

const json = (t: string): any => {
  try {
    return t.trim().startsWith("{") ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};
// A transcript line that notes another act in brackets ("[sent a document: ...]", "[emailed a plan: ...]"): not a text, and the act
// it notes is recorded by its own source (document_deliveries, the tool call).
export const isNote = (text: string) => /^\[[^\]]*\]$/.test(text.trim());
const LINK_ONLY = /^https?:\/\/\S+$/;
const near = (a: Date, b: Date, ms: number) => Math.abs(a.getTime() - b.getTime()) <= ms;

// Pure: the answer an offer got: the first resolved row from its own time (less the triple's window) until the next offer.
export function offerState(pendingAt: Date, nextPendingAt: Date | null, resolved: { at: Date; content: string }[]): string {
  const from = pendingAt.getTime() - TRIPLE_WINDOW_MS;
  const until = nextPendingAt ? nextPendingAt.getTime() - TRIPLE_WINDOW_MS : Infinity;
  const r = resolved.find((x) => x.at.getTime() >= from && x.at.getTime() < until);
  return r ? r.content.trim() : "pending";
}

// Pure: the link a recommendation went out under. A find shared in a reply (agent/loopTools.ts shareFinds) goes link, caption, then
// its recommendation_offered row, and the call's own log (tool.shareFinds) pairs each caption with its link: so the caption texted
// just before the row names the link, even when two calls ran at once. Otherwise the one link-only line within two minutes before
// to one after (several: none, since which is which can't be told; the rule services/coFacts.ts backfillCoActions uses).
export function linkNear(src: Pick<Sources, "replied" | "tools">, at: Date): string | null {
  const t = at.getTime();
  const caption = src.replied.filter((r) => r.at.getTime() <= t && r.at.getTime() >= t - 5_000 && !LINK_ONLY.test(r.text.trim()) && !isNote(r.text)).pop();
  if (caption) {
    const k = textKey(caption.text);
    for (const d of src.tools) {
      if (d.decision !== "tool.shareFinds" || !near(d.at, at, ITEM_WINDOW_MS)) continue;
      const items: any[] = Array.isArray(d.proposal?.input?.items) ? d.proposal.input.items : [];
      const hit = items.find((i) => typeof i?.link === "string" && textKey(String(i?.caption ?? "")) === k);
      if (hit) return String(hit.link).trim();
    }
  }
  const around = src.replied.filter((r) => LINK_ONLY.test(r.text.trim()) && r.at.getTime() >= t - 120_000 && r.at.getTime() <= t + 60_000);
  return around.length === 1 ? around[0].text.trim() : null;
}

const prefixOf = (label: string, segment: string) => {
  const l = normName(label);
  return l.length >= 3 && normName(segment).startsWith(l);
};

export type SourceName = "event offers" | "recommendations offered" | "documents" | "surfacing lines" | "recommendation lines" | "outbound texts" | "transcript lines" | "tool outcomes";
export type BackfillItem = { source: SourceName; ref: string; row: LedgerRow };

// Pure: the rows the backfill writes for one member, in the order they're written (the richest record of a thing first, so a
// later record of the same thing collapses into it: offers and recommendations carry the link, tool calls come last).
export function backfillRows(src: Sources): BackfillItem[] {
  const u = src.userId;
  const out: BackfillItem[] = [];
  const mem = (type: string) => src.memories.filter((m) => m.type === type);
  const pending = mem("event_offer_pending");
  const resolved = mem("event_offer_resolved");
  pending.forEach((p, i) => {
    const payload = json(p.content);
    out.push({ source: "event offers", ref: p.id, row: offerRow({ userId: u, memoryId: p.id, at: p.at, match: payload?.match ?? {}, offerState: offerState(p.at, pending[i + 1]?.at ?? null, resolved) }) });
  });
  const offered = mem("recommendation_offered");
  for (const o of offered) {
    const payload = json(o.content);
    const name = String(payload?.name ?? "").trim();
    if (!name) continue;
    out.push({ source: "recommendations offered", ref: o.id, row: recommendationRow({ userId: u, memoryId: o.id, at: o.at, name, sentAs: linkNear(src, o.at), eventApiId: payload?.event_api_id ?? null }) });
  }
  for (const d of src.docs) out.push({ source: "documents", ref: d.id, row: documentRow({ userId: u, id: d.id, at: d.at, title: d.title, channel: d.channel, version: d.version, docKey: d.docKey, link: d.link, status: d.status }) });
  for (const s of mem("event_discovery_surfacing")) {
    const name = surfacingName(s.content);
    if (name) out.push({ source: "surfacing lines", ref: s.id, row: surfacingRow({ userId: u, memoryId: s.id, at: s.at, name }) });
  }
  for (const r of mem("recommendation")) {
    recommendationSegments(r.content).forEach((segment, index) => {
      // Its recommendation_offered row (the pair) already names it: one act.
      const paired = offered.some((o) => near(o.at, r.at, ITEM_WINDOW_MS) && prefixOf(String(json(o.content)?.name ?? ""), segment));
      if (!paired) out.push({ source: "recommendation lines", ref: `${r.id}:${index}`, row: recommendationSegmentRow({ userId: u, memoryId: r.id, index, at: r.at, segment }) });
    });
  }
  for (const o of src.outbound) out.push({ source: "outbound texts", ref: o.handle, row: textedRow({ userId: u, handle: o.handle, content: o.content, at: o.at }) });
  for (const r of src.replied) {
    if (isNote(r.text)) continue;
    // The same text recorded by its handle: one act, written from outbound_messages above.
    const k = textKey(r.text);
    if (src.outbound.some((o) => near(o.at, r.at, ITEM_WINDOW_MS) && textKey(o.content) === k)) continue;
    out.push({ source: "transcript lines", ref: r.id, row: transcriptTextRow({ userId: u, memoryId: r.id, text: r.text, at: r.at }) });
  }
  for (const t of src.tools) {
    const p = t.proposal ?? {};
    // A removal receipt keeps no input, so its row names the tool only (services/ledger.ts toolOutcomeRow).
    const input = p.removal ? null : (p.recordAs ?? p.input ?? null);
    const receipt = (t.action ?? "done") as ToolReceipt;
    out.push({ source: "tool outcomes", ref: t.id, row: toolOutcomeRow({ userId: u, tool: t.decision.slice(5), receipt, input, made: p.made ?? null, decisionId: t.id, at: t.at, background: p.input?.background === true }) });
  }
  return out;
}

export type BackfillCounts = Record<string, { candidates: number; written: number; conflict: number; collapsed: number }>;
// Writes one member's backfill through a store (the database, or memory for a dry run). Idempotent: an act already in the ledger
// meets the unique key (conflict), and a thing already sent collapses.
export async function runBackfill(store: LedgerStore, src: Sources, onRow?: (item: BackfillItem, result: WriteResult) => void): Promise<BackfillCounts> {
  const counts: BackfillCounts = {};
  for (const item of backfillRows(src)) {
    const c = (counts[item.source] ??= { candidates: 0, written: 0, conflict: 0, collapsed: 0 });
    c.candidates++;
    const result = await writeLedgerRow(store, item.row);
    c[result]++;
    onRow?.(item, result);
  }
  return counts;
}

// ------------------------------------------------------------ reconcile

export type Unmatched = { source: string; ref: string; at: Date; text: string };
export type ReconcileResult = {
  userId: string;
  bySource: Record<string, { total: number; matched: number }>;
  unmatched: Unmatched[];
  // Ledger 'sent' rows for one thing within the window of each other: one act held twice.
  doubles: { a: string; b: string; key: string; at: Date }[];
  // Transcript notes ("[sent a document: ...]"): recorded by their own source, not matched as texts.
  notes: number;
  outboundOther: number;
  ledgerRows: number;
};

// Pure: every old-store act of one member, matched against that member's ledger rows.
export function reconcileMember(src: Sources, ledger: StoredLedgerRow[] = src.ledger): ReconcileResult {
  const mine = ledger.filter((l) => l.userId === src.userId);
  const byKey = new Set(mine.map((l) => l.objectKey));
  const sent = mine.filter((l) => l.relation === "sent");
  const texted = mine.filter((l) => l.relation === "texted");
  const covered = (keys: string[], at: Date) => keys.length > 0 && sent.some((l) => near(l.at, at, ITEM_WINDOW_MS) && ((l.meta?.items as string[]) ?? []).some((k) => keys.includes(k)));
  const bySource: ReconcileResult["bySource"] = {};
  const unmatched: Unmatched[] = [];
  const tally = (source: string, ok: boolean, ref: string, at: Date, text: string) => {
    const b = (bySource[source] ??= { total: 0, matched: 0 });
    b.total++;
    if (ok) b.matched++;
    else unmatched.push({ source, ref, at, text: text.replace(/\s+/g, " ").slice(0, 160) });
  };

  for (const o of src.outbound) tally("outbound texts", byKey.has(`L|outbound:${o.handle}`), o.handle, o.at, o.content);
  let notes = 0;
  for (const r of src.replied) {
    if (isNote(r.text)) {
      notes++;
      continue;
    }
    const k = textKey(r.text);
    tally("transcript lines", texted.some((l) => near(l.at, r.at, ITEM_WINDOW_MS) && textKey(l.label) === k), r.id, r.at, r.text);
  }
  for (const t of src.tools) {
    const p = t.proposal ?? {};
    const input = p.removal ? null : (p.recordAs ?? p.input ?? null);
    const tool = t.decision.slice(5);
    let ok = byKey.has(`L|decision:${t.id}`);
    // A done send whose things are all in the ledger already (a find recorded as a recommendation first): one act.
    if (!ok && (t.action ?? "done") === "done" && input) {
      const acts = (toolAction(tool, input) ?? []).filter((a) => a.relation === "sent");
      ok = acts.length > 0 && acts.every((a) => covered(itemKeys({ url: a.url, name: a.label }), t.at));
    }
    tally("tool outcomes", ok, t.id, t.at, `${t.decision} ${t.action ?? ""}`);
  }
  const offerRows = mine.filter((l) => l.meta?.kind === "offer" && l.meta?.from !== "surfacing");
  for (const m of src.memories) {
    const payload = json(m.content);
    if (m.type === "event_offer_pending") {
      tally("event offers", byKey.has(`L|memory:${m.id}`) || covered(itemKeys({ url: payload?.match?.url, name: payload?.match?.name }), m.at), m.id, m.at, String(payload?.match?.name ?? m.content));
    } else if (m.type === "event_discovery_surfacing") {
      const name = surfacingName(m.content);
      tally("surfacing lines", !!name && covered(itemKeys({ name }), m.at), m.id, m.at, m.content);
    } else if (m.type === "event_offer_resolved") {
      const state = m.content.trim();
      // Part of the offer's one row: its answer, on the offer it answered.
      const ok =
        state === "revealed_directly"
          ? offerRows.some((l) => near(l.at, m.at, 5 * TRIPLE_WINDOW_MS))
          : offerRows.some((l) => l.at.getTime() <= m.at.getTime() && l.meta?.offer_state === state);
      tally("offer answers", ok, m.id, m.at, state);
    } else if (m.type === "recommendation_offered") {
      const name = String(payload?.name ?? "").trim();
      tally("recommendations offered", byKey.has(`L|memory:${m.id}`) || (!!name && covered(itemKeys({ name }), m.at)), m.id, m.at, name || m.content);
    } else if (m.type === "recommendation") {
      recommendationSegments(m.content).forEach((segment, i) => {
        tally("recommendation lines", sent.some((l) => near(l.at, m.at, ITEM_WINDOW_MS) && prefixOf(l.label, segment)), `${m.id}:${i}`, m.at, segment);
      });
    }
  }
  for (const d of src.docs) tally("documents", byKey.has(`L|document_deliveries:${d.id}`) || covered(itemKeys({ name: documentLabel(d.title, d.channel) }), d.at), d.id, d.at, documentLabel(d.title, d.channel));

  const doubles: ReconcileResult["doubles"] = [];
  for (let i = 0; i < sent.length; i++) {
    for (let j = i + 1; j < sent.length; j++) {
      if (!near(sent[i].at, sent[j].at, ITEM_WINDOW_MS)) continue;
      // Two deliveries of a document are two acts (services/ledger.ts documentRow).
      if (sent[i].meta?.kind === "document" && sent[j].meta?.kind === "document") continue;
      const key = ((sent[i].meta?.items as string[]) ?? []).find((k) => ((sent[j].meta?.items as string[]) ?? []).includes(k));
      if (key) doubles.push({ a: sent[i].objectKey, b: sent[j].objectKey, key, at: sent[i].at });
    }
  }
  return { userId: src.userId, bySource, unmatched, doubles, notes, outboundOther: src.outboundOther, ledgerRows: mine.length };
}
