// One action ledger (snapshot design 2026-10-29 §3, PR 1): every act Cue takes is also one co_facts row, written beside the stores
// that hold it today. Nothing reads these rows yet: today's readers of co_facts skip them (NOT_LEDGER), and the reader switch is a
// later PR, after the reconcile script (scripts/ledgerReconcile.ts) reports nothing unmatched.
//
// What is written, one row per act (subject 'co', visibility 'owner', meta.ledger = 1):
//   texted    every text Cue sends, at the one send wrapper (services/sendblue.ts), anchored on its outbound_messages row
//   <tool>    every guarded tool call's outcome (agent/toolGuard.ts), anchored on its harness_decisions row: done is the act's own
//             relation (sent, did, searched); every other receipt (not_done, limited, needs_yes, off, asked_back) is not_done
//   sent      an event offer (the event_offer_pending / event_discovery_surfacing / event_offer_resolved triple is one row, its
//             state in meta.offer_state), a recommendation (the recommendation / recommendation_offered pair is one row), a
//             delivered document (document_deliveries)
//
// One act, one row:
//   - object_key is "L|" + the old-store row the act mirrors (outbound:<handle>, decision:<id>, memory:<id>, document_deliveries:<id>)
//     and happened_at is that row's own time, so the live write and the backfill of the same act meet on co_facts' unique key
//     (owner_user_id, relation, object_key, happened_at) and ON CONFLICT DO NOTHING keeps one. The "L|" prefix keeps them apart
//     from today's content-keyed rows, which a backfilled row would otherwise collide with and be dropped by.
//   - a thing sent is identified by its keys (u:<url>, n:<name>), and two records are the same thing (sameThing) when they share a
//     link, or share a name with no links that disagree: two "Sunday Run Club" finds at /run-sf and /run-oakland are two things.
//     A second sent row for a thing already sent within ITEM_WINDOW_MS (a find recorded as a recommendation and then as the
//     shareFinds call's outcome) is collapsed into the first: the later row keeps only the things not already there, and isn't
//     written when nothing is left. The same link sent on purpose twice within the window is one act, by design.
//
// A ledger write never fails or delays a send: live writes are queued per member (so a member's acts land in the order they
// happened) and run after the caller has moved on. A write that fails is logged as a decision row (ledger.write_failed) with
// the source kind and the error class, never the label.
//
// Every query here is scoped to one member (owner_user_id = $1).
import pool from "../db/db.js";
import { toolAction } from "./coFacts.js";
import { recordDecision } from "../harness/core.js";
import { onShutdown } from "./shutdown.js";

export const LEDGER_VERSION = 1;
// For today's readers of co_facts: leave the ledger's rows out until the reader switch.
export const NOT_LEDGER = `NOT (meta ? 'ledger')`;
// The same thing sent twice within this is one act.
export const ITEM_WINDOW_MS = 2 * 60_000;
// The pieces of one event offer (pending, surfacing, resolved) land within this of each other (snapshot design §3).
export const TRIPLE_WINDOW_MS = 2_000;

export type LedgerRelation = "texted" | "sent" | "did" | "searched" | "not_done";
export type LedgerKind = "text" | "tool" | "offer" | "find" | "document";
// One thing in a row: what it's called, its link, and the keys that identify it for collapsing.
export type LedgerPart = { label: string; url: string | null; keys: string[] };
export type LedgerRow = {
  userId: string;
  relation: LedgerRelation;
  kind: LedgerKind;
  // Where the act happened (outbound:<handle>, tool.<name>, memory:<id>, document_deliveries:<id>).
  source: string;
  // The old-store row this act mirrors: object_key is "L|" + anchor.
  anchor: string;
  // That row's own time.
  at: Date;
  parts: LedgerPart[];
  meta: Record<string, unknown>;
  // false: never collapsed into another row. A document delivery is its own act each time (version 2 three seconds after
  // version 1 is a second delivery), so it only ever covers the tool call that made it.
  collapses?: boolean;
};
// A ledger row as stored (what the stores, the backfill and the reconcile read back).
export type StoredLedgerRow = { userId: string; relation: string; objectKey: string; label: string; url: string | null; at: Date; source: string; meta: Record<string, any> };
export type WriteResult = "written" | "conflict" | "collapsed";

// ------------------------------------------------------------ pure

const s = (v: unknown) => String(v ?? "").trim();
export const normName = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
// Pure: the keys that identify a thing sent: its link, and its name.
export function itemKeys(o: { url?: string | null; name?: string | null }): string[] {
  const out: string[] = [];
  if (s(o.url)) out.push(`u:${s(o.url)}`);
  if (s(o.name)) out.push(`n:${normName(s(o.name))}`);
  return out;
}
// Pure: a text compared as words only (case, punctuation, dashes and spacing folded), so the transcript line and the cleaned text
// that went out (services/sendblue.ts cleanCoMessage) read as one.
export function textKey(t: string): string {
  const k = t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return (k || t.replace(/\s+/g, "")).slice(0, 200);
}
export const objectKey = (row: Pick<LedgerRow, "anchor">) => `L|${row.anchor}`;

// Pure: whether two records (each one thing's keys) are the same thing. A shared link always is. A shared name is, unless both
// carry links and none of them agree (two finds with one name at two different pages are two finds).
export function sameThing(a: string[], b: string[]): boolean {
  const ua = a.filter((k) => k.startsWith("u:"));
  const ub = b.filter((k) => k.startsWith("u:"));
  if (ua.some((k) => ub.includes(k))) return true;
  if (ua.length && ub.length) return false;
  return a.some((k) => k.startsWith("n:") && b.includes(k));
}
// The things a stored ledger row holds, one key list each (meta.groups; a row written without groups is one thing).
export const groupsOf = (meta: Record<string, any> | null | undefined): string[][] =>
  Array.isArray(meta?.groups) ? (meta!.groups as string[][]) : Array.isArray(meta?.items) && meta!.items.length ? [meta!.items as string[]] : [];

// Pure: the row as written, from the parts left after collapsing.
export function finalRow(row: LedgerRow, parts: LedgerPart[] = row.parts): { label: string; url: string | null; meta: Record<string, unknown> } {
  const label = parts.map((p) => p.label).filter(Boolean).join("; ").replace(/\s+/g, " ").trim().slice(0, 500) || row.kind;
  const items = [...new Set(parts.flatMap((p) => p.keys))];
  const groups = parts.filter((p) => p.keys.length).map((p) => p.keys);
  const collapsed = row.parts.length - parts.length;
  return { label, url: parts.length === 1 ? parts[0].url : null, meta: { ...row.meta, ledger: LEDGER_VERSION, kind: row.kind, items, ...(groups.length ? { groups } : {}), ...(collapsed ? { collapsed } : {}) } };
}

// A text Cue sent (services/sendblue.ts). A media-only send (a voice note, a card) has no words.
export function textedRow(o: { userId: string; handle: string; content: string | null; at: Date }): LedgerRow {
  const words = s(o.content).replace(/\s+/g, " ");
  return {
    userId: o.userId, relation: "texted", kind: "text", source: `outbound:${o.handle}`, anchor: `outbound:${o.handle}`, at: o.at,
    parts: [{ label: words || "[media]", url: null, keys: [] }], meta: { handle: o.handle, ...(words ? {} : { media: true }) },
  };
}

// A line of the transcript ("Co replied: ...") with no outbound_messages row of its own: older than that table, or written by a
// path that never reached the wrapper. Backfill only.
export function transcriptTextRow(o: { userId: string; memoryId: string; text: string; at: Date }): LedgerRow {
  return {
    userId: o.userId, relation: "texted", kind: "text", source: `memory:${o.memoryId}`, anchor: `memory:${o.memoryId}`, at: o.at,
    parts: [{ label: s(o.text).replace(/\s+/g, " ") || "[media]", url: null, keys: [] }], meta: { from: "transcript" },
  };
}

export type ToolReceipt = "done" | "not_done" | "off" | "limited" | "needs_yes" | "asked_back";
// A guarded tool call's outcome (agent/toolGuard.ts). input is what the call did (recordAs, when it did only part), or null for a
// removal or voice-read receipt, whose words are never kept (forget-delete-spec.md §2.26): those rows name the tool only.
export function toolOutcomeRow(o: { userId: string; tool: string; receipt: ToolReceipt; input: any; made?: string | null; decisionId: string | null; at: Date; background?: boolean }): LedgerRow {
  const actions = o.input == null ? [] : (toolAction(o.tool, o.input) ?? []);
  const done = o.receipt === "done";
  const relation: LedgerRelation = done ? ((actions[0]?.relation as LedgerRelation) ?? "did") : "not_done";
  const sends = done && relation === "sent";
  const parts: LedgerPart[] = actions.length
    ? actions.map((a) => ({ label: a.label, url: a.url ? s(a.url) : null, keys: sends ? itemKeys({ url: a.url, name: a.label }) : [] }))
    : [{ label: `used ${o.tool}`, url: null, keys: [] }];
  const source = `tool.${o.tool}${o.background ? ".background" : ""}`;
  return {
    userId: o.userId, relation, kind: "tool", source, anchor: o.decisionId ? `decision:${o.decisionId}` : `${source}:${o.at.getTime()}`, at: o.at, parts,
    meta: { tool: o.tool, receipt: o.receipt, ...(o.decisionId ? { decision_id: o.decisionId } : {}), ...(o.made ? { made: s(o.made).slice(0, 200) } : {}) },
  };
}

// An event offer (services/eventSurfacingSweep.ts onEventOfferSent), anchored on its event_offer_pending row.
export function offerRow(o: { userId: string; memoryId: string; at: Date; match: any; offerState: string }): LedgerRow {
  const name = s(o.match?.name);
  const url = s(o.match?.url) || null;
  return {
    userId: o.userId, relation: "sent", kind: "offer", source: `memory:${o.memoryId}`, anchor: `memory:${o.memoryId}`, at: o.at,
    parts: [{ label: name || url || "an event offer", url, keys: itemKeys({ url, name }) }],
    meta: { offer_state: o.offerState, ...(o.match?.event_api_id ? { event_api_id: String(o.match.event_api_id) } : {}), ...(o.match?.event_date ? { when: String(o.match.event_date) } : {}) },
  };
}

// Pure: the event a surfacing line names ("Sent directly (short notice): <name>", "Announced Noise's own event "<name>" ...").
export function surfacingName(content: string): string | null {
  const direct = content.match(/^Sent directly(?: \([^)]*\))?:\s*(.+)$/s);
  if (direct) return direct[1].trim() || null;
  const announced = content.match(/^Announced Noise's own event "(.+)" when it was created$/s);
  return announced ? announced[1].trim() || null : null;
}

// A surfacing line with no pending row beside it. Backfill only; it collapses into the offer when there is one.
export function surfacingRow(o: { userId: string; memoryId: string; at: Date; name: string }): LedgerRow {
  return {
    userId: o.userId, relation: "sent", kind: "offer", source: `memory:${o.memoryId}`, anchor: `memory:${o.memoryId}`, at: o.at,
    parts: [{ label: o.name, url: null, keys: itemKeys({ name: o.name }) }], meta: { from: "surfacing" },
  };
}

// A recommendation (services/recommendation.ts recordRecommendationsSent, services/coEventAnnouncement.ts), anchored on its
// recommendation_offered row.
// sentAs: the link it actually went out under, when the caller knows it (a shareFinds link can differ from the match's own url).
export function recommendationRow(o: { userId: string; memoryId: string; at: Date; name: string; url?: string | null; sentAs?: string | null; eventApiId?: string | null; when?: string | null; whenEnd?: string | null; tier?: string | null }): LedgerRow {
  const url = s(o.sentAs) || s(o.url) || null;
  const keys = [...new Set([...itemKeys({ url: o.sentAs }), ...itemKeys({ url: o.url, name: o.name })])];
  return {
    userId: o.userId, relation: "sent", kind: "find", source: `memory:${o.memoryId}`, anchor: `memory:${o.memoryId}`, at: o.at,
    parts: [{ label: o.name, url, keys }],
    meta: { ...(o.eventApiId ? { event_api_id: o.eventApiId } : {}), ...(o.when ? { when: o.when } : {}), ...(o.whenEnd ? { when_end: o.whenEnd } : {}), ...(o.tier ? { tier: o.tier } : {}) },
  };
}

// Pure: the finds a "recommendation" memory lists ("Cue surfaced N tiered recommendation(s) — [Tier k] name: reason | ..."), each as
// its segment after the tier tag (the name runs into the reason; a name can hold ": " itself, so matching is by prefix).
export function recommendationSegments(content: string): string[] {
  // "Co surfaced" before the rename (2026-10-14).
  const body = content.replace(/^(?:Co|Cue) surfaced \d+ tiered recommendation\(s\)\s*[—-]\s*/, "");
  return body.split(/ \| (?=\[Tier )/).map((x) => x.replace(/^\[Tier [^\]]*\]\s*/, "").trim()).filter(Boolean);
}
// A recommendation memory's find with no recommendation_offered row beside it. Backfill only. Its name is the segment up to the
// first ": " (best effort; reconcile matches by prefix).
export function recommendationSegmentRow(o: { userId: string; memoryId: string; index: number; at: Date; segment: string }): LedgerRow {
  const name = o.segment.split(": ")[0].trim();
  return {
    userId: o.userId, relation: "sent", kind: "find", source: `memory:${o.memoryId}`, anchor: `memory:${o.memoryId}:${o.index}`, at: o.at,
    parts: [{ label: name, url: null, keys: itemKeys({ name }) }], meta: { from: "recommendation" },
  };
}

// The words a document is recorded under, the same as the tool's own (services/coFacts.ts toolAction writeDocument), so
// a document sent by a tool call is one act.
export const documentLabel = (title: string, channel: string) => (channel === "email" ? `a one-page plan sheet: ${title}` : `a document (PDF): ${title}`);
// A document Cue delivered (services/deliveryReceipts.ts), anchored on its document_deliveries row.
export function documentRow(o: { userId: string; id: string | number; at: Date; title: string; channel: string; version: number; docKey: string; link: string | null; status: string }): LedgerRow {
  const label = documentLabel(s(o.title), o.channel);
  return {
    userId: o.userId, relation: "sent", kind: "document", source: `document_deliveries:${o.id}`, anchor: `document_deliveries:${o.id}`, at: o.at,
    parts: [{ label, url: s(o.link) || null, keys: itemKeys({ name: label }) }],
    meta: { version: o.version, channel: o.channel, status: o.status, doc_key: o.docKey },
    collapses: false,
  };
}

// ------------------------------------------------------------ stores

export type LedgerStore = {
  // The things (key lists) the member's ledger 'sent' rows, other than this act's own, hold within windowMs of at.
  nearby: (userId: string, at: Date, windowMs: number, ownKey: string) => Promise<string[][]>;
  // false when the row was already there (the unique key).
  insert: (userId: string, row: LedgerRow, final: ReturnType<typeof finalRow>) => Promise<boolean>;
};

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export function pgLedgerStore(q: Query = (sql, p) => pool.query(sql, p)): LedgerStore {
  return {
    nearby: async (userId, at, windowMs, ownKey) => {
      const { rows } = await q(
        `SELECT meta FROM co_facts
         WHERE owner_user_id = $1 AND relation = 'sent' AND meta ? 'ledger' AND object_key <> $4
           AND happened_at BETWEEN $2::timestamptz - make_interval(secs => $3) AND $2::timestamptz + make_interval(secs => $3)`,
        [userId, at, windowMs / 1000, ownKey],
      );
      return rows.flatMap((r: any) => groupsOf(r.meta));
    },
    insert: async (userId, row, final) => {
      const { rows } = await q(
        `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, url, visibility, source, happened_at, meta)
         VALUES ($1, 'co', $2, $3, $4, $5, 'owner', $6, $7, $8::jsonb)
         ON CONFLICT (owner_user_id, relation, object_key, happened_at) DO NOTHING RETURNING id`,
        [userId, row.relation, final.label, objectKey(row), final.url, row.source, row.at, JSON.stringify(final.meta)],
      );
      return rows.length > 0;
    },
  };
}

// The same rules in memory: the backfill's dry run (seeded with the member's ledger rows as they are) and the tests.
export function memoryLedgerStore(seed: StoredLedgerRow[] = []): LedgerStore & { rows: StoredLedgerRow[] } {
  const rows = [...seed];
  return {
    rows,
    nearby: async (userId, at, windowMs, ownKey) =>
      rows.filter((r) => r.userId === userId && r.relation === "sent" && r.objectKey !== ownKey && Math.abs(r.at.getTime() - at.getTime()) <= windowMs).flatMap((r) => groupsOf(r.meta)),
    insert: async (userId, row, final) => {
      const key = objectKey(row);
      if (rows.some((r) => r.userId === userId && r.relation === row.relation && r.objectKey === key && r.at.getTime() === row.at.getTime())) return false;
      rows.push({ userId, relation: row.relation, objectKey: key, label: final.label, url: final.url, at: row.at, source: row.source, meta: final.meta as Record<string, any> });
      return true;
    },
  };
}

// One row, by the rules above. Throws on a store error (the caller decides what a failure means).
export async function writeLedgerRow(store: LedgerStore, row: LedgerRow): Promise<WriteResult> {
  let parts = row.parts;
  if (row.relation === "sent" && row.collapses !== false) {
    const have = parts.some((p) => p.keys.length) ? await store.nearby(row.userId, row.at, ITEM_WINDOW_MS, objectKey(row)) : [];
    // A part already sent is one act with the row that holds it.
    parts = parts.filter((p) => !p.keys.length || !have.some((g) => sameThing(p.keys, g)));
    if (!parts.length) return "collapsed";
  }
  return (await store.insert(row.userId, row, finalRow(row, parts))) ? "written" : "conflict";
}

// ------------------------------------------------------------ live writes

const chains = new Map<string, Promise<void>>();
let liveStore: LedgerStore = pgLedgerStore();
// Tests: run live writes against another store.
export function setLedgerStoreForTest(store: LedgerStore | null): void {
  liveStore = store ?? pgLedgerStore();
}

// Pure: what a failed write leaves in the decision log: the kind of source and the error's class, never the label.
export function failureDecision(row: Pick<LedgerRow, "userId" | "relation" | "kind" | "source">, err: unknown) {
  const e = err as { code?: unknown; name?: unknown } | null;
  return {
    layer: 3 as const, decision: "ledger.write_failed", userId: row.userId, outcome: "skip" as const, action: row.relation,
    reason: `the ledger row wasn't written (${String(e?.code ?? e?.name ?? "error").slice(0, 40)}); the act itself went ahead`,
    proposal: { kind: row.kind, source: row.source.split(":")[0] },
  };
}

function enqueue(userId: string, work: () => Promise<unknown>, onFail: (err: unknown) => void): void {
  const prev = chains.get(userId) ?? Promise.resolve();
  const next = prev.then(work).then(
    () => undefined,
    (err) => {
      try { onFail(err); } catch { /* never throws */ }
    },
  );
  chains.set(userId, next);
  void next.then(() => {
    if (chains.get(userId) === next) chains.delete(userId);
  });
}

// A ledger row that couldn't be written, or built: logged and recorded, never thrown.
export function ledgerFailed(row: Pick<LedgerRow, "userId" | "relation" | "kind" | "source">, err: unknown): void {
  console.error(`ledger: ${row.kind} row not written (non-fatal):`, (err as any)?.message ?? err);
  void recordDecision(failureDecision(row, err)).catch(() => {});
}

// Write one ledger row in the background: never throws, never awaited by a send.
export function ledgerWrite(row: LedgerRow | null | undefined): void {
  if (!row?.userId) return;
  enqueue(row.userId, () => writeLedgerRow(liveStore, row), (err) => ledgerFailed(row, err));
}

// An event offer's answer, on its one row (event_offer_resolved: interested / not_interested), in the background. When the offer
// collapsed into a row already holding the same thing (services/ledger.ts sameThing), the answer goes on that surviving row; when
// there's no row at all, a decision row says so (ledger.offer_state_unmatched), never a silent no-op.
type OfferStateQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
export async function applyOfferState(q: OfferStateQuery, userId: string, pendingMemoryId: string, state: string): Promise<"own" | "survivor" | "unmatched"> {
  const own = await q(
    `UPDATE co_facts SET meta = meta || jsonb_build_object('offer_state', $3::text)
     WHERE owner_user_id = $1 AND object_key = $2 AND meta ? 'ledger' RETURNING id`,
    [userId, `L|memory:${pendingMemoryId}`, state],
  );
  if (own.rows.length) return "own";
  const { rows: pend } = await q(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND id::text = $2 AND memory_type = 'event_offer_pending'`, [userId, pendingMemoryId]);
  if (pend[0]) {
    let match: any = {};
    try {
      match = JSON.parse(String(pend[0].content))?.match ?? {};
    } catch { /* no match: nothing to find it by */ }
    const at = new Date(pend[0].created_at);
    const keys = itemKeys({ url: match?.url, name: match?.name });
    const { rows } = await q(
      `SELECT id, happened_at, meta FROM co_facts
       WHERE owner_user_id = $1 AND relation = 'sent' AND meta ? 'ledger'
         AND happened_at BETWEEN $2::timestamptz - make_interval(secs => $3) AND $2::timestamptz + make_interval(secs => $3)`,
      [userId, at, ITEM_WINDOW_MS / 1000],
    );
    const survivor = keys.length
      ? rows.filter((r: any) => groupsOf(r.meta).some((g) => sameThing(keys, g))).sort((a: any, b: any) => Math.abs(new Date(a.happened_at).getTime() - at.getTime()) - Math.abs(new Date(b.happened_at).getTime() - at.getTime()))[0]
      : null;
    if (survivor) {
      await q(`UPDATE co_facts SET meta = meta || jsonb_build_object('offer_state', $3::text) WHERE owner_user_id = $1 AND id = $2`, [userId, survivor.id, state]);
      return "survivor";
    }
  }
  await recordDecision({ layer: 3, decision: "ledger.offer_state_unmatched", userId, outcome: "skip", action: state, reason: "an offer's answer found no ledger row for the offer, its own or one it collapsed into", proposal: { kind: "offer" } });
  return "unmatched";
}
export function ledgerOfferState(userId: string, pendingMemoryId: string, state: string): void {
  if (!userId || !pendingMemoryId) return;
  enqueue(userId, () => applyOfferState((sql, p) => pool.query(sql, p as any[]), userId, pendingMemoryId, state), (err) => ledgerFailed({ userId, relation: "sent", kind: "offer", source: "memory" }, err));
}

// Tests and scripts: wait for every queued write.
export async function ledgerSettled(): Promise<void> {
  while (chains.size) await Promise.all([...chains.values()]);
}

// On a restart (services/shutdown.ts), the queued writes get a short while to land: never longer than this, so a stuck database
// can't hold the exit. A write cut off here is one the backfill writes later (the same row, by its anchor).
export const SHUTDOWN_WAIT_MS = 3_000;
export function settleWithin(ms: number): Promise<"settled" | "timed_out"> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<"timed_out">((r) => {
    timer = setTimeout(() => r("timed_out"), ms);
  });
  return Promise.race([ledgerSettled().then(() => "settled" as const), limit]).finally(() => clearTimeout(timer));
}
onShutdown(() => settleWithin(SHUTDOWN_WAIT_MS));
