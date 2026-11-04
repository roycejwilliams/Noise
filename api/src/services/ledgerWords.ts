// The member's words age out of Cue's action record after WORDS_DAYS (Royce, 2026-10-31): the same window as the harness_decisions
// log (jobs/index.ts). The fact of the act and its date stay: "searched for them: jazz nights for a date" becomes "searched for them:
// events", a sent find keeps its link, a text keeps that it was sent and when. Run daily by the retention job, after the decision log
// prune; idempotent (a row it reduced carries meta.words_aged and is never read again).
//
// Which rows, per kind (all subject 'co'):
//   ledger tool rows (meta.kind 'tool')     label from the tool's input (their ask, a query, a caption, a title, a name): reduced to
//                                           the act (toolAction's own words without the input), plus each link it sent. The keys
//                                           lose their name part (n:<label>), the links (u:) stay; meta.made (a title) goes.
//   ledger texted rows (meta.kind 'text')   Cue's own text, which often quotes them: reduced to "a text". The handle stays.
//   ledger document rows                    "a document (PDF): <their title>": reduced to "a document (PDF)" (or the plan sheet),
//                                           link kept, doc_key (a slug of the title) dropped. The file itself is document_deliveries.
//   ledger offer and find rows              kept: the name of the event or thing found (its own public name), not their words, and
//                                           the reconcile matches recommendation lines by it.
//   content-keyed tool rows (source tool.*) the same words as the ledger tool rows (services/coFacts.ts toolAction), read today by
//                                           ledgerFacts and followThrough: reduced the same way. A label-keyed row's object_key (the
//                                           lowercased label) becomes "aged|<id>"; a link-keyed row keeps its link.
//   tools whose label never held input   (the contact card, an invite link, a tapback...): marked, label and key left as they are.
//   content-keyed texted rows           Cue's first text (source proactive_sends:<id>), which often quotes them: reduced to the links
//     (source proactive_sends:*)        it carried, or "a text". meta.type stays. The every-boot backfill (services/coFacts.ts
//                                       backfillCoActions) rebuilds these from proactive_sends inside the same 60 days only, so a
//                                       reduced row is never rebuilt with its words.
//   reaction catch-up rows              'noted how "<the thing>" landed: <reaction> (their words: "<quote>")': their quote goes from
//     (source reaction.catchup)         the label and meta.quote; the thing's own name, the reaction and the provenance stay.
// Not here: sent items recorded outside the tool guard (the event's own name), and the source tables (proactive_sends, outbound_messages,
// the members' own memories and transcripts): those are theirs to see and delete, or the record of what went out.
import pool from "../db/db.js";

export const WORDS_DAYS = 60;

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
const s = (v: unknown) => String(v ?? "").trim();

// The act without the input, by tool, in toolAction's grammar (services/coFacts.ts ledgerLine reads them the same way: sent is a
// thing, searched is what was searched, did is what Cue did). A tool whose label never carried input keeps its own words.
const ACT: Record<string, string> = {
  shareLink: "a link",
  shareFinds: "a find",
  sendContactCard: "Cue's contact card",
  sendInvite: "an invite link to forward to a friend",
  sendProductUpdates: "the list of what's new in Cue",
  searchEvents: "events",
  // The reply's event search before Cue's own loop (6f1530bb): its label was what they asked to find.
  searchNow: "events",
  searchPosts: "X posts",
  webSearch: "the web",
  writeDocument: "a document (PDF)",
  startTask: "took on a task for them",
  researchBrief: "started researching venues for them",
  closeTask: "closed a task",
  offerDocument: "offered to write something up for them as a document",
  saveAsk: "saved an ask",
  closeAsk: "closed an ask",
  steerAwayFrom: "changed what Cue steers away from for them",
  noteReaction: "noted how something landed",
  markArrived: "recorded that they arrived at a Noise event",
  requestEventIntro: "took their ask for an intro",
  reactInsteadOfReplying: "reacted with a tapback",
};
// Tools whose label never held anything from the input: their rows keep their label and key as they are (marked, nothing else).
const FIXED = new Set(["sendContactCard", "sendInvite", "sendProductUpdates", "offerDocument", "markArrived", "reactInsteadOfReplying"]);
// Pure: a tool's name from a content-keyed row's source (tool.<name>, tool.<name>.background, tool.<name>:backfill).
export const toolOfSource = (source: string) => s(source).replace(/^tool\./, "").split(/[.:]/)[0];
// Pure: the act a tool row records once its words have aged out. A not_done row says only which tool was tried.
export function actLabel(tool: string, relation: string): string {
  if (relation === "not_done") return `used ${tool || "a tool"}`;
  if (ACT[tool]) return ACT[tool];
  // A tool not named above (an older one): the act by its relation, in the same grammar.
  return relation === "sent" || relation === "searched" ? `something (${tool || "a tool"})` : `used ${tool || "a tool"}`;
}

export type AgingRow = { id: string; ownerUserId: string; relation: string; label: string; objectKey: string; url: string | null; source: string; at: Date; meta: Record<string, any> };
export type AgedRow = { label: string; objectKey: string; meta: Record<string, any>; kind: string };

const linkOf = (keys: unknown): string | null => (Array.isArray(keys) ? (keys.find((k) => typeof k === "string" && k.startsWith("u:")) as string | undefined)?.slice(2) ?? null : null);
const withLink = (act: string, url: string | null) => (url ? `${act} (${url})` : act);
const joinParts = (parts: string[]) => [...new Set(parts)].join("; ").slice(0, 500);
// Keys keep their links (u:) and lose their names (n:, the label lowercased); a group left with no key goes.
const linksOnly = (meta: Record<string, any>) => {
  const out: Record<string, any> = { ...meta };
  if (Array.isArray(meta.items)) out.items = meta.items.filter((k: unknown) => typeof k === "string" && k.startsWith("u:"));
  if (Array.isArray(meta.groups)) {
    const groups = meta.groups.map((g: unknown) => (Array.isArray(g) ? g.filter((k) => typeof k === "string" && k.startsWith("u:")) : [])).filter((g: string[]) => g.length);
    if (groups.length) out.groups = groups;
    else delete out.groups;
  }
  return out;
};

// Pure: what a row becomes once its words age out, or null when it isn't one this reduces (an offer or a find, another subject).
// The same row in gives the same row out, so a second run changes nothing.
export function agedRow(r: AgingRow, day: string): AgedRow | null {
  const m = r.meta ?? {};
  const mark = { words_aged: day };
  if (m.ledger) {
    if (m.kind === "text") {
      const label = m.media ? r.label : "a text";
      return { kind: "texted", label, objectKey: r.objectKey, meta: { ...m, ...mark } };
    }
    if (m.kind === "document") {
      const { doc_key: _k, ...rest } = linksOnly(m);
      return { kind: "document", label: m.channel === "email" ? "a one-page plan sheet" : "a document (PDF)", objectKey: r.objectKey, meta: { ...rest, ...mark } };
    }
    if (m.kind === "tool") {
      const tool = s(m.tool) || toolOfSource(r.source);
      if (FIXED.has(tool) && r.relation !== "not_done") return { kind: `tool ${r.relation}`, label: r.label, objectKey: r.objectKey, meta: { ...m, ...mark } };
      const act = actLabel(tool, r.relation);
      const groups: unknown[] = Array.isArray(m.groups) ? m.groups : [];
      // A send keeps each link it sent, one part per thing (services/ledger.ts finalRow joins parts with "; ").
      const label = r.relation === "sent" && groups.length ? joinParts(groups.map((g) => withLink(act, linkOf(g)))) : withLink(act, r.relation === "sent" ? r.url : null);
      const { made: _m, ...rest } = linksOnly(m);
      return { kind: `tool ${r.relation}`, label, objectKey: r.objectKey, meta: { ...rest, ...mark } };
    }
    return null;
  }
  if (r.relation === "texted" && /^proactive_sends:/.test(r.source)) {
    // A text that carried a link keeps it: ledgerLine reads a texted row with a link as "sent them this link, unprompted".
    const links = [...new Set(r.label.match(/https?:\/\/\S+/g) ?? [])];
    return { kind: "proactive texted", label: links.length ? links.join(" ") : "a text", objectKey: `aged|${r.id}`, meta: { ...m, ...mark } };
  }
  if (r.source === "reaction.catchup") {
    const cut = r.label.indexOf(' (their words: "');
    const label = cut > 0 ? r.label.slice(0, cut) : /^noted how ".+" landed: [a-z_]+$/.test(r.label) ? r.label : actLabel("noteReaction", r.relation);
    const { quote: _q, ...rest } = m;
    return { kind: "reaction catch-up", label, objectKey: label === r.label ? r.objectKey : `aged|${r.id}`, meta: { ...rest, ...mark } };
  }
  if (!/^tool\./.test(r.source)) return null;
  const tool = toolOfSource(r.source);
  if (FIXED.has(tool)) return { kind: `content-keyed ${r.relation}`, label: r.label, objectKey: r.objectKey, meta: { ...m, ...mark } };
  const act = actLabel(tool, r.relation);
  const url = s(r.url) || null;
  // A link-keyed row keeps its key (the link); a label-keyed one held their words in its key too.
  return { kind: `content-keyed ${r.relation}`, label: withLink(act, url), objectKey: url ? r.objectKey : `aged|${r.id}`, meta: { ...m, ...mark } };
}

// The rows due: older than the window, not reduced yet, of the kinds above. One page at a time, by id (the column, numerically: the
// id is read out as text, and ORDER BY id would sort that text, skipping 7 after 23).
const DUE = `subject = 'co' AND happened_at < $1 AND NOT (meta ? 'words_aged')
  AND ((meta ? 'ledger' AND meta->>'kind' IN ('tool', 'text', 'document'))
    OR (NOT (meta ? 'ledger') AND (source LIKE 'tool.%' OR (relation = 'texted' AND source LIKE 'proactive_sends:%') OR source = 'reaction.catchup')))`;
async function duePage(q: Query, cutoff: Date, afterId: string, limit: number, owner: string | null): Promise<AgingRow[]> {
  const { rows } = await q(
    `SELECT id::text AS id, owner_user_id::text AS owner, relation, object_label, object_key, url, source, happened_at, meta FROM co_facts
     WHERE ${DUE} AND co_facts.id > $2::bigint ${owner ? "AND owner_user_id = $4" : ""} ORDER BY co_facts.id LIMIT $3`,
    owner ? [cutoff, afterId, limit, owner] : [cutoff, afterId, limit],
  );
  return rows.map((x: any) => ({ id: x.id, ownerUserId: x.owner, relation: x.relation, label: x.object_label, objectKey: x.object_key, url: x.url ?? null, source: x.source, at: new Date(x.happened_at), meta: x.meta ?? {} }));
}

export type AgingCounts = { rows: number; changed: number; byKind: Record<string, number> };
export type AgingOptions = { now?: Date; batch?: number; maxBatches?: number; owner?: string | null; dryRun?: boolean; onRow?: (before: AgingRow, after: AgedRow) => void };

// Reduces the due rows, a page at a time; each update is scoped to its row's own member and skips a row already reduced (a second run
// at the same time changes nothing twice). dryRun: reads and counts only.
export async function ageLedgerWords(q: Query = (sql, p) => pool.query(sql, p as any[]), o: AgingOptions = {}): Promise<AgingCounts> {
  const now = o.now ?? new Date();
  const cutoff = new Date(now.getTime() - WORDS_DAYS * 86_400_000);
  const day = now.toISOString().slice(0, 10);
  const batch = o.batch ?? 500;
  const counts: AgingCounts = { rows: 0, changed: 0, byKind: {} };
  let after = "0";
  for (let i = 0; i < (o.maxBatches ?? 1_000); i++) {
    const page = await duePage(q, cutoff, after, batch, o.owner ?? null);
    if (!page.length) break;
    after = page[page.length - 1].id;
    const updates: { r: AgingRow; a: AgedRow }[] = [];
    for (const r of page) {
      const a = agedRow(r, day);
      if (!a) continue;
      counts.rows++;
      if (a.label !== r.label || a.objectKey !== r.objectKey) counts.changed++;
      counts.byKind[a.kind] = (counts.byKind[a.kind] ?? 0) + 1;
      o.onRow?.(r, a);
      updates.push({ r, a });
    }
    if (o.dryRun || !updates.length) continue;
    await q(
      `UPDATE co_facts c SET object_label = v.label, object_key = v.key, meta = v.meta
       FROM unnest($1::bigint[], $2::uuid[], $3::text[], $4::text[], $5::jsonb[]) AS v(id, owner, label, key, meta)
       WHERE c.id = v.id AND c.owner_user_id = v.owner AND NOT (c.meta ? 'words_aged')`,
      [updates.map((u) => u.r.id), updates.map((u) => u.r.ownerUserId), updates.map((u) => u.a.label), updates.map((u) => u.a.objectKey), updates.map((u) => JSON.stringify(u.a.meta))],
    );
  }
  return counts;
}
