// What Co knows, as connected facts (Royce, 2026-09-26: "Do all" on the
// knowledge-graph ideas). One table, co_facts, built up as things happen:
//
//   Co's actions   what Co sent, searched, texted unprompted, and did with its
//                  tools, for which member and when. Co's replies read it, so
//                  "did I send you that?" is looked up, not recalled
//                  (2026-09-26: Co agreed it had never sent a five-day-old
//                  AgentFi link, because it only saw its last ten sends).
//   People         what each member wants and has to offer, for matching
//                  people in a room (services/peopleGraph.ts).
//
// Every fact has an owner (the member it's about or for) and a visibility:
//   owner  only ever used in that member's own conversation, or inside
//          matching; never told to anyone else
//   room   may be told to another guest at a shared Co event (only their own
//          stated ask, word for word, as the match reason has always been)
//   team   internal; never told to a member
// harness/introConsent.ts checks every text drafted about another member
// against the other member's owner-only facts (privateFactLeak).
import { isStated, UNCONFIRMED_RULE } from "./provenance.js";
import pool from "../db/db.js";
import { DEFAULT_ZONE, dateNote, localToday, readDates } from "./dateGuard.js";
import { memberZone } from "./memberTime.js";

export type Visibility = "owner" | "room" | "team";
export type CoFact = {
  ownerUserId: string;
  subject: "co" | "member";
  relation: string;
  label: string;
  url?: string | null;
  visibility: Visibility;
  source: string;
  happenedAt?: Date;
  meta?: Record<string, unknown>;
};

const key = (f: Pick<CoFact, "label" | "url">) => (f.url ? f.url.trim() : f.label.toLowerCase().replace(/\s+/g, " ").trim()).slice(0, 300);

// The same write, for a caller that must know it landed before it acts (services/workingSet.ts: an item leaves the working set only
// after its fact is in the member's record). Throws when it didn't.
export async function recordFactChecked(f: CoFact): Promise<void> {
  if (!f.ownerUserId || !f.label?.trim()) throw new Error("a fact needs an owner and a label");
  await pool.query(
    `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, url, visibility, source, happened_at, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10::jsonb)
     ON CONFLICT (owner_user_id, relation, object_key, happened_at) DO NOTHING`,
    [f.ownerUserId, f.subject, f.relation, f.label.trim().slice(0, 500), key(f), f.url ?? null, f.visibility, f.source, f.happenedAt ?? null, JSON.stringify(f.meta ?? {})],
  );
}

// Never throws: a fact that can't be written must never break a send.
export async function recordFact(f: CoFact): Promise<void> {
  if (!f.ownerUserId || !f.label?.trim()) return;
  await pool
    .query(
      `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, url, visibility, source, happened_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10::jsonb)
       ON CONFLICT (owner_user_id, relation, object_key, happened_at) DO NOTHING`,
      [f.ownerUserId, f.subject, f.relation, f.label.trim().slice(0, 500), key(f), f.url ?? null, f.visibility, f.source, f.happenedAt ?? null, JSON.stringify(f.meta ?? {})],
    )
    .catch((err: any) => console.error(`coFacts: ${f.relation} fact failed (non-fatal):`, err?.message ?? err));
}

// ------------------------------------------------------------ Co's actions

// What a tool call Co made means as a fact, from its own input. Tools that
// only read (listing asks, counting invites) aren't actions and return null.
export function toolAction(tool: string, input: any): { relation: string; label: string; url?: string }[] | null {
  const s = (v: unknown) => String(v ?? "").trim();
  switch (tool) {
    case "shareLink":
      return (Array.isArray(input?.urls) ? input.urls : []).map((u: string) => ({ relation: "sent", label: `the link ${s(u)}`, url: s(u) }));
    case "sendContactCard":
      return [{ relation: "sent", label: "Cue's contact card" }];
    case "sendInvite":
      return [{ relation: "sent", label: "an invite link to forward to a friend" }];
    case "sendProductUpdates":
      return [{ relation: "sent", label: "the list of what's new in Cue" }];
    // Co's own loop (agent/loop.ts): what it looked for, read and sent.
    case "searchEvents":
      return s(input?.what) ? [{ relation: "searched", label: `${s(input.what)}${s(input?.when) ? `, ${s(input.when)}` : ""}` }] : null;
    case "searchPosts":
      return s(input?.query) ? [{ relation: "searched", label: `X posts: ${s(input.query)}` }] : null;
    case "webSearch":
      return Array.isArray(input?.queries) && input.queries.length ? input.queries.map((q: unknown) => ({ relation: "searched", label: s(q) })).filter((x: any) => x.label) : null;
    case "shareFinds":
      return Array.isArray(input?.items) ? input.items.map((i: any) => ({ relation: "sent", label: s(i?.caption).slice(0, 120) || s(i?.link), url: s(i?.link) })).filter((x: any) => x.url) : null;
    case "draftEmail":
      return [{ relation: "did", label: `drafted an email${s(input?.to) ? ` to ${s(input.to)}` : ""} for them to send: ${s(input?.subject)}` }];
    case "emailPlan":
      return [{ relation: "sent", label: `a one-page plan sheet: ${s(input?.title)}` }];
    case "writeDocument":
      return [{ relation: "sent", label: `a document (PDF): ${s(input?.title)}` }];
    // Work Co took on (a call or a text): the record that it really started, not just that it said it would (2026-10-08 call review).
    case "startTask":
      return s(input?.goal) ? [{ relation: "did", label: `took on a task for them: ${s(input.goal).slice(0, 160)}` }] : null;
    case "researchBrief":
      return s(input?.what) ? [{ relation: "did", label: `started researching a venue brief for them: ${s(input.what).slice(0, 160)}` }] : null;
    case "closeTask":
      return [{ relation: "did", label: `closed a task (${s(input?.status) || "done"})${s(input?.outcome) ? `: ${s(input.outcome).slice(0, 160)}` : ""}` }];
    case "offerDocument":
      return [{ relation: "did", label: "offered to write something up for them as a document" }];
    case "saveAsk":
      return [{ relation: "did", label: s(input?.what) ? `saved an ask to keep looking for: ${s(input.what)}` : "saved an ask" }];
    case "closeAsk":
      return [{ relation: "did", label: `closed an ask${s(input?.ask) ? `: ${s(input.ask)}` : ""}` }];
    case "steerAwayFrom":
      return [{ relation: "did", label: `${input?.undo ? "stopped steering away from" : "steered away from"} ${s(input?.kind)}` }];
    case "noteReaction":
      return [{ relation: "did", label: `noted how "${s(input?.item)}" landed: ${s(input?.reaction)}${s(input?.quote) ? ` (their words: "${s(input.quote).slice(0, 120)}")` : ""}` }];
    case "markArrived":
      return [{ relation: "did", label: "recorded that they arrived at a Cue event" }];
    case "requestEventIntro":
      return [{ relation: "did", label: `started a double opt-in intro${s(input?.personName) ? ` with ${s(input.personName)}` : ""}` }];
    case "reactInsteadOfReplying":
      return [{ relation: "did", label: "reacted with a tapback" }];
    default:
      return null;
  }
}

export async function recordToolAction(userId: string, tool: string, input: any): Promise<void> {
  for (const a of toolAction(tool, input) ?? []) {
    // A start made in the background from their request (services/askSplit.ts), not chosen in a reply: its own source, for audits.
    await recordFact({ ownerUserId: userId, subject: "co", relation: a.relation, label: a.label, url: a.url, visibility: "owner", source: input?.background === true ? `tool.${tool}.background` : `tool.${tool}` });
  }
}

export async function recordSentItems(userId: string, items: { name: string; url?: string | null; kind?: string | null; when?: string | null; whenEnd?: string | null }[], source: string): Promise<void> {
  for (const it of items) {
    await recordFact({ ownerUserId: userId, subject: "co", relation: "sent", label: it.name, url: it.url ?? null, visibility: "owner", source, meta: { kind: it.kind ?? null, when: it.when ?? null, when_end: it.whenEnd ?? null } });
  }
}

export async function recordProactiveText(userId: string, type: string, message: string, sendId: string | number | null): Promise<void> {
  await recordFact({ ownerUserId: userId, subject: "co", relation: "texted", label: message.replace(/\s+/g, " ").slice(0, 300), visibility: "owner", source: `proactive_sends:${sendId ?? "?"}`, meta: { type } });
}

// source/provenance: a reaction the catch-up read wrote before provenance existed (2026-10-12) reads as unconfirmed.
export type LedgerRow = { relation: string; label: string; url: string | null; at: Date; when?: string | null; whenEnd?: string | null; source?: string | null; provenance?: string | null };

const STOP = new Set(["ever", "that", "this", "with", "from", "have", "what", "your", "about", "event", "thing", "there", "they", "when", "were", "just", "send", "sent", "never", "didn", "into", "some", "anything", "something", "really", "would", "could", "should"]);
export function distinctiveWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];
}

// Pure: which older rows a message is about, by a distinctive word they share.
export function rowsNamedIn(rows: LedgerRow[], text: string): LedgerRow[] {
  const words = distinctiveWords(text);
  if (!words.length) return [];
  // Whole words only ("ever" isn't in "never").
  const res = words.map((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[^a-z0-9'-]/g, "")}([^a-z0-9]|$)`));
  return rows.filter((r) => {
    const l = r.label.toLowerCase();
    return res.some((re) => re.test(l));
  });
}

// A document is made fresh each time: having sent one is never a reason not to send another (Royce, 2026-10-07: "send it again" got
// "scroll up", and the same request repeated got "it's the same one I already built and sent").
export const DOCUMENT_LABEL = /^a document \(PDF\)/;
// One rule with the receipts (services/deliveryReceipts.ts, 2026-10-08): asked again means the same version again; asked for a
// change means readDocument, then the next version; never again on Co's own initiative.
export const DOCUMENT_AGAIN = "If they ask for it again (lost it, can't find it, send it again), send the same version again with writeDocument, never \"it's already up\". If they want it changed, readDocument first, then writeDocument with revises and changed for the next version. Never send it again on your own.";

export function ledgerLine(r: LedgerRow, today = localToday(), zone: string | null = DEFAULT_ZONE): string {
  // Their day, not the UTC one: a 6pm Pacific send is that Pacific day (Royce, 2026-10-07).
  const day = localToday(zone, r.at);
  // The thing's own date, when known, read against today (dateGuard.ts).
  const note = r.when ? dateNote(readDates({ start: r.when, end: r.whenEnd && r.whenEnd >= r.when ? r.whenEnd : r.when }, today)) : "";
  if (r.relation === "sent" && DOCUMENT_LABEL.test(r.label)) return `On ${day} Cue sent them "${r.label}". ${DOCUMENT_AGAIN}`;
  if (r.relation === "sent") return `On ${day} Cue sent them "${r.label}"${r.url && !r.label.includes(r.url) ? ` (${r.url})` : ""}${note}.`;
  // A first text that carried a link is a send of that link, said plainly
  // (2026-09-27: "texted them first: https://…" was read as not having sent
  // a link, and Co said it "never sent an actual link").
  if (r.relation === "texted") {
    const link = r.label.match(/https?:\/\/\S+/)?.[0];
    const rest = link ? r.label.replace(link, "").trim() : r.label;
    return link ? `On ${day} Cue sent them this link, unprompted: ${link}${rest ? `, with: "${rest}"` : ""}` : `On ${day} Cue texted them first: "${r.label}"`;
  }
  if (r.relation === "searched") return `On ${day} Cue searched for them: "${r.label}".`;
  // The catch-up's word-match reads from before 2026-10-12 (services/provenance.ts): a guess, never what they did.
  if (r.source === "reaction.catchup" && !isStated(r.provenance)) {
    const m = r.label.match(/^noted how "(.+)" landed: ([a-z_]+)/);
    return `On ${day} Cue guessed from a text of theirs that "${m?.[1] ?? r.label}" landed as ${(m?.[2] ?? "a reaction").replace(/_/g, " ")}; they never confirmed it (${UNCONFIRMED_RULE}).`;
  }
  return `On ${day} Cue ${r.label}.`;
}

// For Co's reply: what it sent and did for them lately, plus anything older
// that the message (or Co's own last messages) names. Read as facts, so
// "you never sent me that" is checked against the record.
// Pure: the sends their message names (for the instruction to answer from
// the record, harness/replyGrounding.ts).
// A document is left out unless they are asking WHETHER it was sent: a request for it (again, updated, redone) is not a question
// about the record, and "answer from the record" made Co refuse to send it.
const ASKS_IF_SENT = /\b(did you|have you|had you|didn'?t you|never (?:got|received|sent)|did(?:n'?t)? (?:get|receive)|where (?:is|did)|was (?:it|that) sent)\b/i;
export function sendsNamedIn(all: LedgerRow[], message: string): LedgerRow[] {
  return rowsNamedIn(all, message).filter((r) => (r.relation === "sent" && (!DOCUMENT_LABEL.test(r.label) || ASKS_IF_SENT.test(message))) || (r.relation === "texted" && /https?:\/\//.test(r.label)));
}

export async function ledgerFacts(userId: string, context: string, zoneIn?: string | null): Promise<{ lines: string[]; named: string[] }> {
  const zone = zoneIn !== undefined ? zoneIn : await memberZone(userId);
  const { rows } = await pool
    .query(
      `SELECT relation, object_label AS label, url, happened_at AS at, meta->>'when' AS when, meta->>'when_end' AS when_end, source, meta->>'provenance' AS provenance FROM co_facts
       WHERE owner_user_id = $1 AND subject = 'co' AND relation <> 'exited' AND happened_at > NOW() - INTERVAL '90 days'
       ORDER BY happened_at DESC LIMIT 400`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  const all: LedgerRow[] = rows.map((r: any) => ({ relation: r.relation, label: String(r.label), url: r.url ?? null, at: new Date(r.at), when: r.when ?? null, whenEnd: r.when_end ?? null, source: r.source ?? null, provenance: r.provenance ?? null }));
  const message = context.split("\n")[0] ?? "";
  const today = localToday(zone);
  return { lines: ledgerLinesFrom(all, context, Date.now(), zone), named: sendsNamedIn(all, message).map((r) => ledgerLine(r, today, zone)) };
}

// Pure half, newest first in: the last two weeks of sends (from replies and
// unprompted offers alike), plus older rows the context names.
// Pure: the same action recorded twice within a few minutes (a live write
// and the startup backfill of it) shows once.
export function dedupeRows(rows: LedgerRow[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const r of rows) {
    const k = `${r.relation}|${(r.url ?? r.label).toLowerCase()}`;
    if (out.some((o) => `${o.relation}|${(o.url ?? o.label).toLowerCase()}` === k && Math.abs(o.at.getTime() - r.at.getTime()) < 5 * 60_000)) continue;
    out.push(r);
  }
  return out;
}

// The first line of context is their message; the rest is Co's last lines.
// What their message names always comes through, however old or however
// many recent sends there are (2026-09-27: "Did you ever send me the AgentFi
// thing?" lost the Sep 21 send to the 20 newest sends and to matches on Co's
// own wording, and Co said it never sent it).
export function ledgerLinesFrom(allRows: LedgerRow[], context: string, now = Date.now(), zone: string | null = DEFAULT_ZONE): string[] {
  const today = localToday(zone, new Date(now));
  const all = dedupeRows(allRows);
  const [message = "", ...coLines] = context.split("\n");
  const theyNamed = rowsNamedIn(all, message).slice(0, 12);
  const recentCut = now - 14 * 24 * 3_600_000;
  const recent = all.filter((r) => !theyNamed.includes(r) && r.at.getTime() >= recentCut && (r.relation === "sent" || r.relation === "texted")).slice(0, 20);
  const coNamed = rowsNamedIn(all.filter((r) => !theyNamed.includes(r) && !recent.includes(r)), coLines.join("\n")).slice(0, 6);
  return [...theyNamed, ...recent, ...coNamed].sort((a, b) => a.at.getTime() - b.at.getTime()).map((r) => ledgerLine(r, today, zone));
}

// ------------------------------------------------------------ privacy

const flat = (t: string) => ` ${t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;

// Pure: does text carry 5+ words in a row from any of these facts? A run
// that's also in what they've said may be shared (their own stated ask, the
// one thing another guest is ever told) doesn't count.
export function carriesFact(text: string, facts: string[], allowed: string[] = [], run = 5): string | null {
  const t = flat(text);
  const ok = allowed.map(flat);
  for (const f of facts) {
    const words = flat(f).trim().split(" ").filter(Boolean);
    for (let i = 0; i + run <= words.length; i++) {
      const piece = ` ${words.slice(i, i + run).join(" ")} `;
      if (t.includes(piece) && !ok.some((a) => a.includes(piece))) return f;
    }
  }
  return null;
}

export async function ownerOnlyFacts(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(`SELECT object_label FROM co_facts WHERE owner_user_id = $1 AND subject = 'member' AND visibility = 'owner' AND retired_at IS NULL`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => String(r.object_label));
}

// Text drafted for one member about another: does it carry something only
// the other member may see?
export async function privateFactLeak(text: string, aboutUserId: string): Promise<string | null> {
  const [facts, prof] = await Promise.all([
    ownerOnlyFacts(aboutUserId),
    pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [aboutUserId]).catch(() => ({ rows: [] as any[] })),
  ]);
  const { askEntries } = await import("../harness/profileWrite.js");
  const stated = askEntries(prof.rows[0]?.intent).map((i: any) => String(i.text));
  return carriesFact(text, facts, stated);
}

// ------------------------------------------------------------ backfill

// Fills Co's actions from what was already recorded (the last 90 days), so
// the record starts complete. Idempotent: a fact's owner, relation, key and
// time are unique, so running it on every start only adds what's missing.
export async function backfillCoActions(): Promise<{ texted: number; sent: number; tools: number }> {
  const texted = await pool
    .query(
      `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source, happened_at, meta)
       SELECT ps.user_id, 'co', 'texted', left(regexp_replace(ps.message, '\\s+', ' ', 'g'), 300), left(lower(regexp_replace(ps.message, '\\s+', ' ', 'g')), 300),
              'owner', 'proactive_sends:' || ps.id, ps.sent_at, jsonb_build_object('type', ps.type)
       FROM proactive_sends ps
       WHERE ps.message IS NOT NULL AND ps.sent_at > NOW() - INTERVAL '90 days'
       ON CONFLICT (owner_user_id, relation, object_key, happened_at) DO NOTHING`,
    )
    .then((r) => r.rowCount ?? 0)
    .catch((err: any) => (console.error("coFacts backfill texted failed:", err?.message ?? err), 0));
  // A sent find: its name, and the link Co texted within two minutes of it.
  const sent = await pool
    .query(
      `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, url, visibility, source, happened_at, meta)
       SELECT m.user_id, 'co', 'sent', m.content::jsonb ->> 'name',
              COALESCE(l.url, lower(m.content::jsonb ->> 'name')), l.url, 'owner', 'memory:' || m.id, m.created_at,
              jsonb_build_object('event_api_id', m.content::jsonb ->> 'event_api_id',
                'when', (SELECT se.event_date::text FROM surfaced_events se WHERE se.user_id = m.user_id AND se.event_api_id = m.content::jsonb ->> 'event_api_id' AND se.event_date IS NOT NULL LIMIT 1))
       FROM co_memories m
       -- The link only when exactly one went out around it: with several,
       -- which is which can't be told, and a wrong link is worse than none.
       LEFT JOIN LATERAL (
         SELECT CASE WHEN count(*) = 1 THEN min(substring(x.content from 'https?://\\S+')) END AS url FROM co_memories x
         WHERE x.user_id = m.user_id AND x.memory_type = 'text_exchange' AND x.content ~ '^Co replied: https?://\\S+$'
           AND x.created_at BETWEEN m.created_at - INTERVAL '2 minutes' AND m.created_at + INTERVAL '1 minute'
       ) l ON true
       WHERE m.memory_type = 'recommendation_offered' AND m.created_at > NOW() - INTERVAL '90 days'
         AND m.content ~ '^\\{' AND coalesce(m.content::jsonb ->> 'name', '') <> ''
         -- Not already recorded live when it was sent (recordSentItems).
         AND NOT EXISTS (SELECT 1 FROM co_facts f WHERE f.owner_user_id = m.user_id AND f.relation = 'sent' AND lower(f.object_label) = lower(m.content::jsonb ->> 'name') AND f.source NOT LIKE 'memory:%' AND abs(extract(epoch FROM f.happened_at - m.created_at)) < 300)
       ON CONFLICT (owner_user_id, relation, object_key, happened_at) DO NOTHING`,
    )
    .then((r) => r.rowCount ?? 0)
    .catch((err: any) => (console.error("coFacts backfill sent failed:", err?.message ?? err), 0));
  // Co's tool calls that went through (agent/toolGuard.ts logs).
  const { rows } = await pool
    .query(
      `SELECT user_id, decision, created_at, proposal->'input' AS input FROM harness_decisions
       WHERE decision LIKE 'tool.%' AND action = 'done' AND user_id IS NOT NULL AND created_at > NOW() - INTERVAL '90 days'`,
    )
    .catch(() => ({ rows: [] as any[] }));
  let tools = 0;
  const { rows: live } = await pool
    .query(`SELECT owner_user_id, relation, object_key, happened_at FROM co_facts WHERE subject = 'co' AND source NOT LIKE '%backfill' AND happened_at > NOW() - INTERVAL '90 days'`)
    .catch(() => ({ rows: [] as any[] }));
  const already = (owner: string, relation: string, k: string, at: Date) =>
    live.some((l: any) => l.owner_user_id === owner && l.relation === relation && l.object_key === k && Math.abs(new Date(l.happened_at).getTime() - at.getTime()) < 5 * 60_000);
  for (const r of rows) {
    for (const a of toolAction(String(r.decision).slice(5), r.input ?? {}) ?? []) {
      if (already(r.user_id, a.relation, key(a), new Date(r.created_at))) continue;
      await recordFact({ ownerUserId: r.user_id, subject: "co", relation: a.relation, label: a.label, url: a.url, visibility: "owner", source: `${r.decision}:backfill`, happenedAt: new Date(r.created_at) });
      tools++;
    }
  }
  return { texted, sent, tools };
}
