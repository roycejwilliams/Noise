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
import { stampOf } from "./factLabels.js";
import { openTasks, taskFactLines } from "./coTasks.js";
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
  // The Co event they're registered for today, if any (services/eventPresence.ts).
  todayEvent?: { eventApiId: string; name: string; startAt: string; timezone: string | null } | null;
};

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
        const st = stampOf({ saidOn: x.opened_at, confirmedOn: x.last_touched_at, dueOn: x.due_date instanceof Date ? x.due_date.toISOString().slice(0, 10) : x.due_date }, new Date());
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
    ledgerFacts(userId, `${message}\n${opts.ledgerContext ?? ""}`).catch(() => ({ lines: [] as string[], named: [] as string[] })),
  ]);
  // Their Google, read from the cache in their own time zone (never fetched while they wait).
  const google = await loadGoogleFacts(userId, profile?.city ?? null).catch(() => [] as string[]);
  const [kit, story, advice, tasks, todayEvent] = await Promise.all([
    loadKit(userId).catch(() => ({}) as Kit),
    loadMilestones(userId).then((m) => storyLines(m, 4)).catch(() => [] as string[]),
    loadAdvice(userId).then((a) => adviceLines(a)).catch(() => [] as string[]),
    openTasks(userId).then((t) => taskFactLines(t)).catch(() => [] as string[]),
    import("./eventPresence.js").then((e) => e.todayEventFor(userId)).catch(() => null),
  ]);
  return { userId, message, profile, snapshot, sent, asks, threads, offersThisWeek, emotional, lessons, inlineTarget, ledger, capabilities: capabilitySheet(), google, kit, story, advice, tasks, todayEvent };
}

async function loadGoogleFacts(userId: string, city: string | null): Promise<string[]> {
  const { isConnected } = await import("./googleAuth.js");
  if (!(await isConnected(userId)).connected) return [];
  const { googleFactsFor } = await import("./googleData.js");
  const { getTimezoneForCity } = await import("./geocoding.js");
  const zone = city ? await getTimezoneForCity(city).catch(() => null) : null;
  return googleFactsFor(userId, zone);
}
