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
import { eventNameKey, nameTokens, sameEvent, type EventLike } from "../eventIdentity.js";

// One key per link: no scheme or www, no fragment, no trailing slash or punctuation, a lower-case host, and Luma's two hosts (lu.ma,
// luma.com) and its two paths (luma.com/event/x, luma.com/x) as one, so the same event sent under either link is one find. Only tracking
// parameters are dropped (utm_*, ref, tk, fbclid, gclid and the like); a query that says which page it is (garysguide ?region=sf,
// ?id=2) stays, sorted, so two pages on one path are two links (review of #409). The path is lower-cased except where it is a
// case-sensitive id (Partiful).
const TRACKING_PARAM = /^(?:utm(?:_.*)?|ref|ref_src|ref_url|referrer|referral|tk|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|igsh|si|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|aff|affiliate|trk|_branch_match_id)$/i;
const CASE_SENSITIVE_PATH = /^(?:[a-z0-9-]+\.)*partiful\.com$/;
export const normUrlOf = (u: string): string => {
  const s = u.trim().replace(/[.,;!?]+$/, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/#.*$/, "");
  const qi = s.indexOf("?");
  const head = qi === -1 ? s : s.slice(0, qi);
  const query = qi === -1 ? "" : s.slice(qi + 1);
  const si = head.indexOf("/");
  let host = (si === -1 ? head : head.slice(0, si)).toLowerCase().replace(/^www\./, "");
  let path = (si === -1 ? "" : head.slice(si)).replace(/\/+$/, "");
  if (host === "lu.ma") host = "luma.com";
  if (host === "luma.com") path = path.replace(/^\/event(?=\/[^/]+$)/i, "");
  if (!CASE_SENSITIVE_PATH.test(host)) path = path.toLowerCase();
  const params = query
    .split("&")
    .filter((kv) => kv && !TRACKING_PARAM.test(kv.split("=")[0]))
    .map((kv) => { const i = kv.indexOf("="); return i === -1 ? kv.toLowerCase() : `${kv.slice(0, i).toLowerCase()}=${kv.slice(i + 1)}`; })
    .sort();
  return `${host}${path}${params.length ? `?${params.join("&")}` : ""}`;
};

// The record is read many times per run (every find checked against every send): its links and names are normalized once.
const memo = <T>(f: (k: string) => T): ((k: string) => T) => {
  const m = new Map<string, T>();
  return (k) => {
    let v = m.get(k);
    if (v === undefined) {
      if (m.size > 20_000) m.clear();
      v = f(k);
      m.set(k, v);
    }
    return v;
  };
};
const urlKey = memo(normUrlOf);
const nameKey = memo((n: string) => eventNameKey(n));
const tokensKey = memo((n: string) => nameTokens(n));

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

// sameEvent never joins a find with no start of its own: checked first, it's the cheap half.
const hasStart = (e: EventLike): boolean => !!(e.details?.startAt ?? e.startAt ?? e.start_at);

// Two records that each say which event they are (an id, or a date) and disagree are two events, whatever else they share: the same
// listing page, group page or venue page carries many finds (review of #409: funcheap, tagvenue, a meetup group page).
const idsOrDaysDiffer = (rec: SentRecord, p: SentProbe): boolean => {
  const pid = p.eventId ?? p.ident?.event_api_id ?? null;
  if (rec.eventId && pid && rec.eventId !== pid) return true;
  const rd = dayOf(rec.ident), pd = dayOf(p.ident);
  return !!(rd && pd && rd !== pd);
};

// Two named records whose names share no meaningful word (eventNameKey's words, less the little ones) are two finds, even on one
// link: a listing, venue or group page carries many, mostly with no id or date (review of #409: funcheap, tagvenue). This only stops
// a false "same"; a renamed event on the same link may go twice, which beats a real find blocked for good.
const LITTLE = new Set(["a", "an", "the", "and", "or", "of", "in", "at", "on", "for", "with", "to", "by", "from", "x", "vs"]);
const wordsOf = memo((n: string) => new Set(nameKey(n).split(" ").filter((w) => w && !LITTLE.has(w))));
const namesDiffer = (rec: SentRecord, p: SentProbe): boolean => {
  const pn = p.name ?? p.ident?.name ?? "";
  if (!rec.name || !pn) return false;
  const a = wordsOf(rec.name), b = wordsOf(pn);
  if (!a.size || !b.size) return false;
  for (const w of a) if (b.has(w)) return false;
  return true;
};

// Pure: how a record matches a find, or null. Priority: link, event identity, name.
export function matchSent(rec: SentRecord, p: SentProbe): "url" | "event" | "name" | null {
  if (rec.url && p.url && urlKey(rec.url) === urlKey(p.url) && !idsOrDaysDiffer(rec, p) && !namesDiffer(rec, p)) return "url";
  const pid = p.eventId ?? p.ident?.event_api_id ?? null;
  if (rec.eventId && pid && rec.eventId === pid) return "event";
  const pi: EventLike = { name: p.name ?? p.ident?.name ?? null, url: p.url ?? p.ident?.url ?? null, ...(p.ident ?? {}) };
  if (rec.ident.name && pi.name && hasStart(rec.ident) && hasStart(pi) && tokensKey(rec.ident.name) === tokensKey(pi.name) && sameEvent({ ...rec.ident, name: rec.ident.name }, pi)) return "event";
  if (rec.urlOnly) return null;
  const a = nameKey(rec.name), b = nameKey(p.name ?? p.ident?.name ?? "");
  if (!a || a !== b) return null;
  // Same name. Two events that each say which one they are (an id, or a date) are the same only if those agree: a new id or a new date
  // is a recurrence, a new find. A side that doesn't say leaves the name to decide (an opening, a link shared in a reply).
  const rd = dayOf(rec.ident), pd = dayOf(p.ident);
  const recKnown = !!(rec.eventId || rd), probeKnown = !!(pid || pd);
  if (recKnown && probeKnown && idsOrDaysDiffer(rec, p)) return null;
  // Cue's action record alone (a reply-path send: no event id, and rarely a date) never says which event it was. Its name blocks a find
  // that doesn't say either (an opening, a link in a reply), never one that says which event it is: a dated or id'd find of the same
  // name is a recurrence as often as not ("Founder Breakfast" every month; review of #409).
  if (!recKnown && probeKnown && rec.via.every((v) => v === "fact")) return null;
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

// Pure: the three sources as one list, one record per thing (the same rule as the lookup), the latest send's time kept. Each record is
// compared only with those sharing its link, its event id or its name's words (every way matchSent can join two records needs one of
// them), so a long history merges in near-linear time (review of #409: the full scan took 11s at 2,000 records).
export function mergeSentRecords(parts: SentRecord[]): SentRecord[] {
  const out: SentRecord[] = [];
  const index = new Map<string, Set<number>>();
  const keysOf = (r: SentRecord): string[] => {
    const k: string[] = [];
    if (r.url) k.push(`u:${urlKey(r.url)}`);
    if (r.eventId) k.push(`e:${r.eventId}`);
    const t = tokensKey(r.ident.name ?? r.name);
    if (t) k.push(`t:${t}`);
    const n = tokensKey(r.name);
    if (n && n !== t) k.push(`t:${n}`);
    return k;
  };
  const add = (i: number) => {
    for (const k of keysOf(out[i])) {
      const at = index.get(k);
      if (!at) index.set(k, new Set([i]));
      else at.add(i);
    }
  };
  // A name group's members are compared by name and start only (a link or an id finds its match under its own key), so two that each
  // say their day, more than a day apart, are passed over without the full match: a long weekly series stays cheap.
  const dayNum = (r: SentRecord): number | null => { const d = dayOf(r.ident); return d ? Date.parse(d) / 86_400_000 : null; };
  const days: (number | null)[] = [];
  for (const r of parts) {
    const probe = { name: r.name, url: r.url, eventId: r.eventId, ident: r.ident };
    const rd = dayNum(r);
    let hi = -1;
    for (const k of keysOf(r)) {
      const byName = k.startsWith("t:");
      for (const i of index.get(k) ?? []) {
        if (hi !== -1 && i >= hi) continue;
        const x = out[i];
        if (byName && rd !== null) { const xd = days[i]; if (xd !== null && Math.abs(xd - rd) > 1) continue; }
        if (matchSent(x, probe) && matchSent(r, { name: x.name, url: x.url, eventId: x.eventId, ident: x.ident })) hi = i;
      }
    }
    if (hi === -1) {
      out.push({ ...r, via: [...r.via] });
      days.push(rd);
      add(out.length - 1);
      continue;
    }
    const had = out[hi];
    for (const v of r.via) if (!had.via.includes(v)) had.via.push(v);
    if (had.urlOnly && !r.urlOnly) { had.urlOnly = false; had.name = r.name; }
    had.url ??= r.url;
    had.eventId ??= r.eventId;
    had.reaction ??= r.reaction;
    if (!had.kind || (had.kind === "item" && r.kind)) had.kind = r.kind ?? had.kind;
    if (!dayOf(had.ident) && dayOf(r.ident)) had.ident = { ...r.ident, ...had.ident, startAt: r.ident.startAt ?? had.ident.startAt, event_date: r.ident.event_date ?? had.ident.event_date };
    if (r.at > had.at) had.at = r.at;
    days[hi] = dayNum(had);
    add(hi); // what it gained (a link, an id, a name) finds it too
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

// One member's sent record, read once per run and shared by every check in that run (review of #409: each check re-read the whole
// history). null: it couldn't be read; the failure is logged once and every caller fails closed (nothing is pitched as new on a
// record it couldn't read).
export type SentOnce = () => Promise<SentRecord[] | null>;
export function sentOnce(q: Q, userId: string): SentOnce {
  let read: Promise<SentRecord[] | null> | null = null;
  return () =>
    (read ??= sentByReferent(q, userId).catch((err: any) => {
      console.error(`sent lookup failed for ${userId} (failing closed: nothing new is pitched this run):`, err?.message ?? err);
      return null;
    }));
}
