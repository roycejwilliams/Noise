// One lookup of everything Cue sent a member (Memory Spec step 7; Royce's full-retrieval rule: resolve the referent, load its whole
// record, never a window or a LIMIT 1). Three records of a send, read together and owner-only ($1 is the member in every query):
//   - Cue's action record (co_facts, relation 'sent'),
//   - the offers that went out (proactive_candidates, status 'sent', with the find's own match),
//   - the send ledger: revealed_offers (the router's record, keyed event:<id> or name:<name>, which reactions land on) and the action
//     ledger's own 'sent' rows (services/ledger.ts, co_facts meta.ledger), which mirror the stores above and keep links and names but
//     not which event, so they answer by link only (urlOnly) and never fold a recurring event into an old one.
// "Already sent" is asked of this and nothing else: sweepShadow's pool, the surfacing sweep's alreadyDecided, memberKnowledge's delivered
// merge. Same find = same link, then same event (id, or one event on two platforms: eventIdentity.ts sameEvent), then same name. A name
// alone never joins two events that each say when they are: a recurring event (same name, a new id or date) is a NEW find (#391).
import { eventNameKey, sameEvent, type EventLike } from "../eventIdentity.js";

// One key per link: no scheme or www, no query or fragment, no trailing slash or punctuation, lower case, and Luma's two hosts (lu.ma,
// luma.com) as one, so the same event sent under either link is one find.
export const normUrlOf = (u: string): string => u.replace(/[.,;!?]+$/, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase().replace(/^lu\.ma(?=\/|$)/, "luma.com");

export type SentVia = "fact" | "offer" | "ledger";
export type SentRecord = {
  name: string;
  url: string | null;
  // The event's own id (event_api_id), when the record has one.
  eventId: string | null;
  // What the record says the find is (its start, city, venue), for one event on two platforms.
  ident: EventLike;
  kind: string | null;
  at: Date;
  via: SentVia[];
  reaction: string | null;
  // The record knows the link but not which event: it matches by link only.
  urlOnly?: boolean;
};
// The find being asked about; any part may be missing.
export type SentProbe = { name?: string | null; url?: string | null; eventId?: string | null; ident?: EventLike | null };
export type SentHit = { record: SentRecord; by: "url" | "event" | "name" };

type Q = (sql: string, args: unknown[]) => Promise<any[]>;

const dayOf = (e: EventLike | null | undefined): string | null => {
  const s = String(e?.details?.startAt ?? e?.startAt ?? e?.start_at ?? e?.event_date ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const idOf = (key: string | null | undefined): string | null => (key && key.startsWith("event:") ? key.slice(6) : null);

// Pure: how a record matches a find, or null. Priority: link, event identity, name.
export function matchSent(rec: SentRecord, p: SentProbe): "url" | "event" | "name" | null {
  if (rec.url && p.url && normUrlOf(rec.url) === normUrlOf(p.url)) return "url";
  if (rec.eventId && p.eventId && rec.eventId === p.eventId) return "event";
  const pi: EventLike = { name: p.name ?? p.ident?.name ?? null, url: p.url ?? p.ident?.url ?? null, ...(p.ident ?? {}) };
  if (rec.ident.name && pi.name && sameEvent({ ...rec.ident, name: rec.ident.name }, pi)) return "event";
  if (rec.urlOnly) return null;
  const a = eventNameKey(rec.name), b = eventNameKey(p.name ?? p.ident?.name);
  if (!a || a !== b) return null;
  // Same name. Two events that each say which one they are (an id, or a date) are the same only if those agree: a new id or a new date
  // is a recurrence, a new find. A side that doesn't say leaves the name to decide (an opening, a link shared in a reply).
  const pid = p.eventId ?? null, rd = dayOf(rec.ident), pd = dayOf(p.ident);
  const recKnown = !!(rec.eventId || rd), probeKnown = !!(pid || pd);
  if (recKnown && probeKnown) {
    if (rec.eventId && pid && rec.eventId !== pid) return null;
    if (rd && pd && rd !== pd) return null;
  }
  return "name";
}

// Pure: the first record that is this find, best match first (a link beats an event identity beats a name).
export function findSent(records: readonly SentRecord[], p: SentProbe): SentHit | null {
  let best: SentHit | null = null;
  const rank = { url: 0, event: 1, name: 2 } as const;
  for (const record of records) {
    const by = matchSent(record, p);
    if (by && (!best || rank[by] < rank[best.by])) best = { record, by };
    if (best?.by === "url") break;
  }
  return best;
}
export const wasSent = (records: readonly SentRecord[], p: SentProbe): boolean => !!findSent(records, p);

// Pure: a stored match (a backlog item's, an offer payload's) as a probe.
export function probeOfMatch(m: any): SentProbe {
  const d = m?.details && typeof m.details === "object" ? m.details : null;
  return {
    name: m?.name ?? null,
    url: m?.url ?? null,
    eventId: typeof m?.event_api_id === "string" && m.event_api_id ? m.event_api_id : null,
    ident: { name: m?.name ?? null, url: m?.url ?? null, startAt: m?.startAt ?? null, event_date: m?.event_date ?? null, city: m?.city ?? null, details: d },
  };
}

// Pure: the three sources as one list, one record per thing (the same rule as the lookup), the latest send's time kept.
export function mergeSentRecords(parts: SentRecord[]): SentRecord[] {
  const out: SentRecord[] = [];
  for (const r of parts) {
    const had = out.find((x) => matchSent(x, { name: r.name, url: r.url, eventId: r.eventId, ident: r.ident }) && matchSent(r, { name: x.name, url: x.url, eventId: x.eventId, ident: x.ident }));
    if (!had) {
      out.push({ ...r, via: [...r.via] });
      continue;
    }
    for (const v of r.via) if (!had.via.includes(v)) had.via.push(v);
    if (had.urlOnly && !r.urlOnly) { had.urlOnly = false; had.name = r.name; }
    had.url ??= r.url;
    had.eventId ??= r.eventId;
    had.reaction ??= r.reaction;
    if (!had.kind || (had.kind === "item" && r.kind)) had.kind = r.kind ?? had.kind;
    if (!dayOf(had.ident) && dayOf(r.ident)) had.ident = { ...r.ident, ...had.ident, startAt: r.ident.startAt ?? had.ident.startAt, event_date: r.ident.event_date ?? had.ident.event_date };
    if (r.at > had.at) had.at = r.at;
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// Everything Cue sent this member, no window and no row cap. Owner-only: $1 is in every query. A source that fails to read is a
// thrown error here, never a quietly shorter list (a short list sends a find twice).
export async function sentByReferent(q: Q, userId: string): Promise<SentRecord[]> {
  const [facts, offers, ledger, acts] = await Promise.all([
    q(
      `SELECT object_label, object_key, url, meta->>'kind' AS kind, meta->>'when' AS "when", happened_at FROM co_facts
       WHERE owner_user_id = $1 AND subject = 'co' AND relation = 'sent' AND retired_at IS NULL AND NOT (meta ? 'ledger')`,
      [userId],
    ),
    q(`SELECT payload->'match' AS match, COALESCE(decided_at, updated_at) AS at FROM proactive_candidates WHERE user_id = $1 AND status = 'sent' AND payload ? 'match'`, [userId]),
    q(`SELECT item_key, item_name, kind, url, sent_at, reaction FROM revealed_offers WHERE user_id = $1`, [userId]),
    q(`SELECT object_label, meta, happened_at FROM co_facts WHERE owner_user_id = $1 AND subject = 'co' AND relation = 'sent' AND retired_at IS NULL AND meta ? 'ledger'`, [userId]),
  ]);
  const parts: SentRecord[] = [];
  for (const r of facts) {
    const name = String(r.object_label ?? "").trim();
    if (!name) continue;
    parts.push({ name, url: r.url ?? null, eventId: idOf(r.object_key), ident: { name, url: r.url ?? null, event_date: r.when ?? null }, kind: r.kind ?? null, at: new Date(r.happened_at), via: ["fact"], reaction: null });
  }
  for (const r of offers) {
    const p = probeOfMatch(r.match);
    if (!p.name) continue;
    parts.push({ name: String(p.name), url: p.url ?? null, eventId: p.eventId ?? null, ident: p.ident ?? {}, kind: r.match?.tier === 3 ? "opportunity" : "event", at: new Date(r.at), via: ["offer"], reaction: null });
  }
  for (const r of ledger) {
    const name = String(r.item_name ?? "").trim();
    if (!name) continue;
    parts.push({ name, url: r.url ?? null, eventId: idOf(r.item_key), ident: { name, url: r.url ?? null }, kind: r.kind ?? null, at: new Date(r.sent_at), via: ["ledger"], reaction: r.reaction ?? null });
  }
  // The action ledger's sent rows: each thing's keys are u:<link> and n:<name> (services/ledger.ts groupsOf). Only links are used.
  for (const r of acts) {
    const meta = r.meta ?? {};
    const groups: string[][] = Array.isArray(meta.groups) ? meta.groups : Array.isArray(meta.items) && meta.items.length ? [meta.items] : [];
    for (const g of groups) {
      const url = (g.find((k) => typeof k === "string" && k.startsWith("u:")) ?? "").slice(2);
      if (!url) continue;
      const name = (g.find((k) => typeof k === "string" && k.startsWith("n:")) ?? "").slice(2) || String(r.object_label ?? url);
      parts.push({ name, url, eventId: null, ident: { name, url }, kind: meta.kind ?? null, at: new Date(r.happened_at), via: ["ledger"], reaction: null, urlOnly: true });
    }
  }
  return mergeSentRecords(parts);
}
