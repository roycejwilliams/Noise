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
import { localStamp, memberZone, wordsZone } from "./memberTime.js";
import { briefFactLines, openTasks as loadOpenTasks, recentBriefs as loadRecentBriefs, taskFactLines, type BriefView, type CoTask } from "./coTasks.js";
import { adviceLines, loadAdvice } from "./advice.js";
import { loadMilestones, storyLines } from "./milestones.js";
import pool from "../db/db.js";
import { capabilitySheet } from "./capabilities.js";
import { ledgerFacts } from "./coFacts.js";
import { type EventDetails } from "./eventDetails.js";
import { DateTime } from "luxon";
import { ASKS_ABOUT_FIND } from "./exchangeRecord.js";
import { renderDetailsAsOf } from "./asOf.js";
import { describeRead, readLinksLater, savedRead, type LinkRead } from "./linkReader.js";
import { loadKit, type Kit } from "./memberKit.js";
import type { RepliedTo } from "./inlineReply.js";
import { getEmotionalContext, type EmotionalContext } from "../harness/emotion.js";
import { getPersonSnapshot, type PersonSnapshot } from "../harness/personSnapshot.js";
import { memberKnowledge, memberRules, type CarryItem as KnownCarry, type Fact, type KnowledgeDeps, type KnowledgeSection, type MemberKnowledge, type MemberRules } from "./memberKnowledge.js";

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
  // When its details were last read from its page (services/sendCheck.ts stamps it at send); null: as old as the find.
  checkedAt?: string | null;
  // Its date or deadline as on file (an opportunity's deadline, an event's date or start), so nothing past it is raised as waiting.
  endsOn?: string | null;
  // Its city as stored with the send (the offer's match.city), for when no details were saved.
  city?: string | null;
};

export type TurnContext = {
  userId: string;
  message: string;
  profile: Record<string, any> | null;
  snapshot: PersonSnapshot | null;
  sent: SentItem[];
  // The finds their message points at, resolved once for this turn (resolveReferents) with their stored fields filled, no window.
  referents?: SentItem[];
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
  // Their own Google Calendar busy times, when connected (services/googleData.ts).
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
  // What Co's daily search is covering for them now (services/searchCoverage.ts): the reply check's running work reads it.
  searching?: import("./searchCoverage.js").SearchCoverage;
  // What's ahead for them from Co, as scheduled (services/whatsAhead.ts aheadLine): one fact line.
  ahead?: string;
  // Goals they handed Co (services/goalOwnership.ts): offered (waiting on their pick) or active (what Co carries, what's theirs, the
  // check-in on the ledger). Tool references for Co, never member-facing text.
  goals?: { kind: "known" | "scheduled"; text: string }[];
  // Goals Co set aside from context that they haven't heard about yet (services/goalEdges.ts untoldSetAsides), then the goal
  // recheck's (services/goalRecheck.ts recheckForTurn, marked by recheck).
  goalSetAsides?: import("./goalEdges.js").GoalStateRow[];
  // A find ask marked retire-due (services/askRetire.ts retireForTurn): the one to ask about, when no goal question is offered this
  // turn, and any already asked, so the reply reads their answer.
  retire?: { ask: import("./askRetire.js").RetireRow | null; asked: import("./askRetire.js").RetireRow[] };
  // The one stopped-looking note owed (services/askRetire.ts), carried by code in this turn's reply. A hard day makes it wait, decided on
  // this message's own read (harness/replyGrounding.ts, services/moodHold.ts).
  stopNote?: import("./askRetire.js").StopNote | null;
  // Their message may be about something Co is already doing (services/statusCheck.ts, Royce 2026-10-13): the candidate task and where
  // it stands; the reply decides whether it's a status check.
  statusCheck?: import("./statusCheck.js").StatusCheck | null;
  // Findable interests on file and the steering so far (services/coldStart.ts): while there are fewer than two, a reply may ask one
  // easy question that lets them name something Co could find (harness/replyGrounding.ts addColdStartSteer).
  coldStart?: import("./coldStart.js").ColdStartView | null;
  // The door (services/theDoor.ts): a new member's first read, while it's still Co's to give.
  door?: import("./theDoor.js").DoorView | null;
  // The Co event they're registered for today, if any (services/eventPresence.ts).
  todayEvent?: { eventApiId: string; name: string; startAt: string; timezone: string | null } | null;
  // Everything Co is carrying for them, one ordered view: due first, then outstanding, then done (carryingItems).
  carrying?: CarryItem[];
  // What Co knows about them from the one member-knowledge layer (services/memberKnowledge.ts), read once per reply with only the
  // sections a text reply reads (TEXT_KNOWLEDGE), already stripped of other members' details. null when it couldn't be read (the
  // name read failed: fails closed, so nothing from it goes in).
  knowledge?: MemberKnowledge | null;
  // The member-level rules read with it (memberRules): discretion, grounding, member safety, delivery shape, restraint, quiet hours.
  rules?: MemberRules | null;
  // Their world in one read (services/memberWorld.ts, the stand-in for discoveryStatus): what waits on them, what's running, what's
  // next, their live thread and their clock, fenced. A check-in reads it (Royce, 2026-10-14).
  world?: import("./memberWorld.js").MemberWorld | null;
  // What the pick is holding for them (harness/waiting.ts, notification grouping item 9), best first, labels only and stripped of other
  // members' details. Present only when something waits: it turns on anythingForMe and the reply's one allowed mention.
  waiting?: import("../harness/waiting.js").WaitingItem[];
};

// The sections of member knowledge a text reply reads. The path reads the rest itself: the thread (raw, with its hold lines and the
// gaps between texts, before this context is assembled), what Co sent with its saved details (loadSentItems), and the person snapshot.
export const TEXT_KNOWLEDGE: readonly KnowledgeSection[] = ["goals", "asks", "carrying", "lessons", "corrections", "preferences", "claims", "restraint"];

// Pure: member knowledge's carrying as the text reply's one-line items (carryingBlock). The one carrying builder (memberKnowledge.ts
// carryingOf) adds what this path never saw before: a call's promises collapsed against what was delivered, and documents only Co's
// own record (co_facts 'sent') has.
// windows: an open task's own window by its ref ("task #12"), so a promise keeps its words ("tonight") and the zone it was said in.
export function carryFromKnowledge(items: Fact<KnownCarry>[], zone: string | null, windows: Map<string, { words: string; deadline: string; zone: string | null }> = new Map()): CarryItem[] {
  // A deadline day is stored as that day's 23:59 UTC (carryingOf): said as the day, never as a clock time.
  const by = (at: string | null, ref: string | null) => {
    const w = ref ? windows.get(ref) : undefined;
    if (w) return ` (${w.words}, by ${localStamp(w.deadline, w.zone ?? zone)})`;
    return !at ? "" : /T23:59:00(?:\.000)?Z$/.test(at) ? ` (their deadline ${at.slice(0, 10)})` : ` (by ${localStamp(at, zone)})`;
  };
  return items
    // A line the strip blanked is left out, never an empty entry.
    .filter((i) => i.what.trim())
    .map((i): CarryItem => {
      const base = { state: i.state, told: i.told, dueMs: i.dueAt ? new Date(i.dueAt).getTime() : null };
      const ref = i.ref;
      switch (i.kind) {
        case "task":
          return { ...base, kind: "task", label: `${ref ?? "task"}: "${i.what}"${by(i.dueAt, ref)}` };
        case "promise":
        case "lookout":
          return { ...base, kind: "promise", label: `${ref ? `your promise, ${ref}` : "your promise on a call"}: ${i.what}${i.theyHaveIt ? " (they have it)" : ""}${by(i.dueAt, ref)}` };
        case "brief":
          return { ...base, kind: "brief", label: `research ${ref ?? "brief"}: "${i.what}"${i.detail ? `, ${i.detail}` : ""}` };
        case "document":
          return { ...base, kind: "document", label: `${ref ? `${ref} ` : "document "}"${i.what}"${i.detail ? `: ${i.detail}` : ""}` };
        default:
          return { ...base, kind: "loop", label: `${ref ? `[${ref}] ` : ""}${i.what}: ${(i.status ?? "open").replace(/_/g, " ")}${i.detail ? ` (${i.detail.slice(0, 80)})` : ""}${i.dueAt ? `, due ${i.dueAt.slice(0, 10)}` : ""}` };
      }
    })
    .slice(0, 14);
}

// ---------------------------------------------------------------- what Co is carrying (2026-10-08 review B6)
// Tasks, promises, research briefs, delivered documents and open loops, each in one line, in one order: what's due now, then what's
// outstanding, then what's done, each marked "already told them" when Co has. Built by the one carrying builder (memberKnowledge.ts
// carryingOf) and labelled for a text reply by carryFromKnowledge above. Pure.
export type CarryItem = { kind: "task" | "promise" | "brief" | "document" | "loop"; label: string; state: "due" | "outstanding" | "done"; told: boolean; dueMs: number | null };
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
  const [revealed, offers, recs, dated] = await Promise.all([
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
    // Co's own record of what it sent, with the dates it carried (services/coFacts.ts recordSentItems): the date of a find shown in a
    // reply, which revealed_offers doesn't keep.
    pool
      .query(
        `SELECT object_label AS name, meta->>'when' AS when, meta->>'when_end' AS when_end FROM co_facts
         WHERE owner_user_id = $1 AND subject = 'co' AND relation = 'sent' AND NOT (meta ? 'ledger') AND happened_at > NOW() - make_interval(days => $2)
         ORDER BY happened_at DESC LIMIT 60`,
        [userId, days],
      )
      .then((r) => r.rows)
      .catch(() => [] as any[]),
  ]);
  return mergeSent(revealed, offers, recs, dated);
}

// One key per link: no scheme or www, no query or fragment, no trailing slash or punctuation, lower case, and Luma's two hosts (lu.ma,
// luma.com) as one, so the same event sent under either link is one find.
export const normUrlOf = (u: string): string => u.replace(/[.,;!?]+$/, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase().replace(/^lu\.ma(?=\/|$)/, "luma.com");

// Pure: the three sources as one list, one entry per thing, revealed_offers'
// key first (the router's), details and post text filled in from the offers.
// dated: Co's sent-record rows (name, when, when_end): they only fill a date in on something already listed, never add an item.
export function mergeSent(revealed: any[], offers: any[], recs: any[], dated: any[] = []): SentItem[] {
  const items: SentItem[] = [];
  const idOf = (x: SentItem) => (x.key?.startsWith("event:") ? x.key : null);
  // The same thing: the same event id or link; with neither on one side, the same name. Two events of one name with different links or
  // ids (another city, another date) stay two (a lookup by url or id finds the right one).
  const same = (a: SentItem, b: SentItem) => {
    if (idOf(a) && idOf(b)) return idOf(a) === idOf(b);
    if (a.url && b.url) return normUrlOf(a.url) === normUrlOf(b.url);
    return norm(a.name) === norm(b.name);
  };
  const add = (item: SentItem) => {
    const had = items.find((x) => same(x, item));
    if (!had) items.push(item);
    else {
      // Same thing from another source: keep the first key, fill in what's missing.
      had.url ??= item.url;
      had.details ??= item.details;
      had.checkedAt ??= item.checkedAt ?? null;
      had.postText ??= item.postText;
      had.reaction ??= item.reaction;
      had.endsOn ??= item.endsOn ?? null;
      had.city ??= item.city ?? null;
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
      checkedAt: m.checkedAt ?? null,
      endsOn: endsOnOf(m),
      city: m.city ?? m.details?.city ?? null,
    });
  }
  for (const r of recs) {
    let x: any = null;
    try {
      x = JSON.parse(r.content);
    } catch {}
    if (!x?.name) continue;
    add({ key: x.event_api_id ? `event:${x.event_api_id}` : nameKey(x.name), name: x.name, kind: x.event_api_id ? "event" : "opportunity", url: x.url ?? null, sentAt: new Date(r.created_at), reaction: null, details: null, postText: null, endsOn: endsOnOf(x) });
  }
  for (const r of dated) {
    const had = r?.name ? items.find((x) => norm(x.name) === norm(String(r.name))) : undefined;
    if (had && !had.endsOn) had.endsOn = r.when_end || r.when || null;
  }
  return items.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
}

// Pure: the last day a find is still ahead, as on file: an opening's deadline, else the end or the date of the event (the same fields
// services/findForm.ts eventDateOf / eventEndOf read: event_date, details.startAt, statedDates). null: no date on file.
export function endsOnOf(m: any): string | null {
  return m?.deadline ?? m?.statedDates?.end ?? m?.details?.endAt ?? m?.event_date ?? m?.details?.startAt ?? m?.statedDates?.start ?? null;
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
// now: the moment it's read for (tests pin it; 2026-10-11 the Phase B test went red a day later on the real clock).
export function sentDetailLines(ctx: Pick<TurnContext, "sent"> & { google?: string[] }, withinDays = 5, now = new Date(), o: { zone?: string | null; also?: readonly SentItem[]; referentMax?: number } = {}): string[] {
  const cutoff = now.getTime() - withinDays * 86_400_000;
  return [...sentLines(ctx, cutoff, now, o), ...(ctx.google ?? [])];
}

// When Cue sent it, in their zone: "Oct 30". Cue's own record of what went out.
export function sentOnWords(at: Date, zone: string | null = null): string {
  const d = DateTime.fromJSDate(at);
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  return d.isValid ? d.setZone(z).toFormat("LLL d") : "an earlier day";
}

// Pure: everything stored about one find Cue sent, as facts: the day it went out, the link, and its page or saved fields, with what
// isn't stored said as exactly that (never "nothing on file" for a find whose record exists). "The exact address shows after approval"
// is said only when the record says registration needs host approval; otherwise the address is plainly not stored, and the link is where
// to look.
const HIDDEN_ADDRESS = /the exact address is only shown to registered guests/;
export function sentFindFacts(s: SentItem, now = new Date(), zone: string | null = null): string[] {
  const out = [`Cue sent them "${s.name}" on ${sentOnWords(s.sentAt, zone)}${s.url ? `; the link it sent: ${s.url}` : "; no link is on file for it"}.`];
  const gate = (line: string, approval: boolean | null | undefined) => (HIDDEN_ADDRESS.test(line) ? line.replace(HIDDEN_ADDRESS, approval ? "the exact address shows once the host approves their registration" : "its street address isn't stored") : line);
  if (s.read) out.push(describeRead(s.name, s.read).facts.join(" "));
  else if (s.details) {
    const approval = s.details.requiresApproval;
    const known = renderDetailsAsOf(s.name, s.details, s.checkedAt ?? null, now, zone).map((l) => gate(l, approval)).join(" ");
    const missing = [s.details.startAt ? null : "start time", s.details.venue || s.details.address ? null : "address"].filter(Boolean);
    out.push(`Details on file for "${s.name}", which Cue sent them: ${known}${missing.length ? ` Not on file: ${missing.join(", ")}.` : ""}`);
    if (!s.details.online && !s.details.venue && !s.details.address && !s.details.city && s.city) out.push(`"${s.name}" is in ${s.city}; ${approval ? "the exact address shows once the host approves their registration" : "its street address isn't stored"}.`);
  } else {
    if (s.city) out.push(`"${s.name}" is in ${s.city}; its street address isn't stored.`);
    out.push(`Its page hasn't been read yet, so Cue has no start time or address for "${s.name}"${s.url ? `; the link is the place to check` : ""}.`);
  }
  return out;
}

// Pure: which of a find's fields are stored (what a reply may state) and which aren't (said plainly, with the link).
export function storedFields(s: SentItem): { have: string[]; missing: string[] } {
  const d = s.details;
  const f = (s.read as any)?.fields ?? {};
  const has = (k: string) => !!f[k]?.value;
  const have = ["the day Cue sent it"];
  const missing: string[] = [];
  (s.url ? have : missing).push("its link");
  if (s.city || d?.city || has("city")) have.push("its city");
  else missing.push("its city");
  if (d?.startAt || has("start")) have.push("its date and time");
  else missing.push("its date and time");
  if (d?.venue || d?.address || has("venue") || has("address")) have.push("its venue or address");
  else missing.push("its street address");
  return { have, missing };
}

// The plain instruction that goes with a resolved find: its stored facts (sentFindFacts) are the answer. asking: they asked about it
// (a text); false on a call, which has no question yet ("if they ask"). Lists only the fields actually stored and says which aren't. It
// instructs the model and carries no wording of its own.
export function answerFromRecordNote(referents: readonly SentItem[], o: { asking?: boolean } = {}): string | null {
  if (!referents.length) return null;
  const asking = o.asking ?? true;
  const parts = referents.map((r) => {
    const { have, missing } = storedFields(r);
    return `"${r.name}" stored: ${have.join(", ")}${missing.length ? `; not stored: ${missing.join(", ")} (say so${r.url ? ", and give the link" : ""})` : ""}`;
  });
  return `${asking ? "They are asking about a find Cue sent them." : "If they ask about a find Cue sent them,"} Answer from its stored facts. ${parts.join(". ")}. Never say you're not sure, or that you have nothing on file, about what is stored.`;
}

// True when a stored match is this find: the same event id or the same link (Luma's two hosts count as one).
export function isSameFind(item: Pick<SentItem, "url" | "key">, m: { url?: string | null; event_api_id?: string | null } | null | undefined): boolean {
  if (!m) return false;
  if (item.key?.startsWith("event:") && m.event_api_id && item.key === `event:${m.event_api_id}`) return true;
  return !!(item.url && m.url && normUrlOf(item.url) === normUrlOf(m.url));
}

// The referents (named or pointed at) come first, then the recent sends, so a size cap (a call's CALL_SENT_MAX) cuts the oldest recent
// send and never the find they asked about.
function sentLines(ctx: Pick<TurnContext, "sent">, cutoff: number, now = new Date(), o: { zone?: string | null; also?: readonly SentItem[]; referentMax?: number } = {}): string[] {
  const first = [...(o.also ?? [])];
  const recent = ctx.sent.filter((s) => s.sentAt.getTime() > cutoff && !first.includes(s)).slice(0, 5);
  // Over its cap (a call's), the description goes first (the core stays: name, send date, link, city, date/time), then the tail.
  const render = (s: SentItem) => {
    const t = sentFindFacts(s, now, o.zone ?? null).join(" ");
    if (!first.includes(s) || !o.referentMax || t.length <= o.referentMax) return t;
    const lean = sentFindFacts({ ...s, details: s.details ? { ...s.details, description: null } : null }, now, o.zone ?? null).join(" ");
    return lean.length <= o.referentMax ? lean : `${lean.slice(0, o.referentMax - 1).trimEnd()}…`;
  };
  return [...first, ...recent].map(render);
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

// Whole-word match of a name in a text ("coffee" in a sentence is not a find named "Coffee" unless the whole name is there as words).
const WORD_STOP = new Set(["the", "a", "an", "and", "of", "at", "in", "on", "to", "for", "with"]);
const namedIn = (text: string, name: string): number => {
  const n = norm(name);
  if (n.length < 3) return -1;
  // A one-word name ("Coffee") must be written as the name (capitalized, as stored); a lowercase "coffee" in a sentence is the word.
  if (!n.includes(" ")) return new RegExp(`(?:^|[^A-Za-z0-9])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`).exec(text)?.index ?? -1;
  return ` ${norm(text)} `.indexOf(` ${n} `);
};
// Their words point at something Cue said, with a pointing word and no noun of their own ("that", "that one", "the link"); a question
// that names a different thing ("that pottery class") is not pointing at the last find.
const GENERIC_NOUN = "event|dinner|party|meetup|thing|one|place|night|lunch|brunch|mixer|session|gathering|get-together";
const SPECIFIC_NOUN = "class|event|dinner|night|party|meetup|workshop|lunch|brunch|mixer|talk|show|festival|session|gig|retreat|conference";
// "that event", "that dinner", "the place", "that one" point at the find Cue last named; "that pottery class" (a descriptor word, then a
// noun) names something of its own.
export const POINTING = new RegExp(String.raw`\b(?:that|this|it|those)\b(?!\s+(?:(?!(?:${GENERIC_NOUN})\b)[a-z']+\s+){1,2}(?:${SPECIFIC_NOUN})\b)|\b(?:that|this|the) (?:${GENERIC_NOUN})\b|\bthe (?:link|address|location|venue|price|date|time|day|city)\b`, "i");

// Pure: the finds Cue sent that their message points at, so their stored fields reach the reply however old the send is. In order: the
// referent the turn read resolved (meant, #368: its link, else its label); the finds they name (whole words); else, when they point
// ("that", "that one") and name nothing, the find in the newest of Cue's recent texts that names one (coTexts, newest first), the one
// mentioned last in that text. A thing they name that Cue never sent resolves to nothing: never the last find by default.
// The words that place a find (its city, venue, address), for choosing between finds of one name.
const placeWords = (x: SentItem): string[] => [x.city, x.details?.city, x.details?.venue, x.details?.address].filter((w): w is string => !!w && w.trim().length >= 3);
// Same-name candidates narrowed by a place word in their message ("the one in Oakland"); unchanged when none or all match.
function narrowByPlace(cands: SentItem[], message: string): SentItem[] {
  const hit = cands.filter((x) => placeWords(x).some((w) => namedIn(message, w) >= 0 || new RegExp(`(?:^|[^a-z0-9])${reEsc(w.trim())}(?![a-z0-9])`, "i").test(message)));
  return hit.length && hit.length < cands.length ? hit : cands;
}
// A text of Cue's that names a place that isn't a find, by a clear form only: a street ("Gold Street", "Bix on Gold Street") or "at" and a
// capitalized name that isn't a day, a month or "The". Never "in/on/to/by" and a capitalized word: Cue's texts are full of days, months
// and people's names ("on Friday", "in March", "to Jordan"), and those must not stop the walk back to the find.
const NOT_A_PLACE = "The|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const NAMES_A_PLACE = new RegExp(String.raw`\b[A-Z][\w'’&-]*(?:\s+[A-Z][\w'’&-]*)*\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Square|Plaza)\b|\bat\s+(?!(?:${NOT_A_PLACE})\b)[A-Z][\w'’&-]+`);
export function referredSent(sent: readonly SentItem[], o: { message: string; meantLabel?: string | null; meantUrl?: string | null; coTexts?: readonly string[] }): SentItem[] {
  const out: SentItem[] = [];
  const put = (x: SentItem | undefined) => { if (x && !out.includes(x)) out.push(x); };
  const byUrl = (u: string) => sent.find((x) => x.url && normUrlOf(x.url) === normUrlOf(u));
  if (o.meantUrl) put(byUrl(o.meantUrl));
  if (!out.length && o.meantLabel) for (const x of narrowByPlace(sent.filter((x) => norm(x.name) === norm(o.meantLabel!)), o.message).slice(0, 2)) put(x);
  for (const u of o.message.match(/https?:\/\/[^\s)>\]"']+/g) ?? []) put(byUrl(u));
  for (const x of narrowByPlace(sent.filter((x) => namedIn(o.message, x.name) >= 0), o.message)) put(x);
  if (!out.length && POINTING.test(o.message) && ASKS_ABOUT_FIND.test(o.message)) {
    for (const text of (o.coTexts ?? []).slice(0, 8)) {
      const hits = sent.map((x) => ({ x, at: Math.max(namedIn(text, x.name), x.url && text.includes(x.url) ? text.indexOf(x.url) : -1) })).filter((h) => h.at >= 0).sort((a, b) => b.at - a.at);
      if (hits.length) {
        const same = hits.filter((h) => norm(h.x.name) === norm(hits[0].x.name)).map((h) => h.x);
        put(narrowByPlace(same, o.message)[0]);
        break;
      }
      // The newest text that names anything names a place that isn't a find: "that place" is that, never an older find behind it.
      if (NAMES_A_PLACE.test(text)) break;
    }
  }
  return out.slice(0, 2);
}

// Pure: the finds Cue sent that Cue's own recent texts named (a follow-up, a debrief), ranked by how recently a text named them (texts
// newest first; later in a text before earlier), at most max. A call opens with no question yet, so what the thread was just about is the
// referent it can resolve; ranked, never cut by the age of the send.
export function sentNamedIn(sent: readonly SentItem[], textsNewestFirst: readonly string[], max = 3): SentItem[] {
  const out: SentItem[] = [];
  for (const text of textsNewestFirst) {
    const hits = sent.map((x) => ({ x, at: Math.max(namedIn(text, x.name), x.url && text.includes(x.url) ? text.indexOf(x.url) : -1) })).filter((h) => h.at >= 0 && !out.includes(h.x)).sort((a, b) => b.at - a.at);
    for (const h of hits) out.push(h.x);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
const likeEsc = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The stored offer for one find, by its link or event id (by name only when it has neither), however long ago: no window. Scoped to the
// member. Null when none is stored.
export async function loadStoredMatch(userId: string, item: Pick<SentItem, "name" | "url" | "key">, db: Db = pool): Promise<any | null> {
  const apiId = item.key?.startsWith("event:") ? item.key.slice(6) : null;
  const likeUrl = (u: string) => normUrlOf(u).replace(/^luma\.com(?=\/)/, ""); // a Luma event is stored under either host: match on its path
  const pats = [item.url ? `%${likeEsc(likeUrl(item.url))}%` : null, apiId ? `%${likeEsc(apiId)}%` : null, !item.url && !apiId ? `%${likeEsc(item.name)}%` : null].filter((x): x is string => !!x);
  if (!pats.length) return null;
  const { rows } = await db.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'event_offer_pending' AND content ILIKE ANY($2::text[]) ORDER BY created_at DESC LIMIT 20`, [userId, pats]);
  for (const r of rows) {
    let m: any = null;
    try { m = JSON.parse(r.content)?.match; } catch { continue; }
    if (!m?.name) continue;
    const ok = (apiId && m.event_api_id === apiId) || (item.url && m.url && normUrlOf(m.url) === normUrlOf(item.url)) || (!item.url && !apiId && norm(m.name) === norm(item.name));
    if (ok) return m;
  }
  return null;
}

// Finds Cue sent by name (whole words), however long ago: no window, this member only. For a name the turn read or the member gave that
// isn't in the recent list. Newest first, at most 3.
export async function loadSentNamed(userId: string, name: string, db: Db = pool): Promise<SentItem[]> {
  const n = name.trim();
  if (norm(n).length < 3) return [];
  const re = `(^|[^[:alnum:]])${reEsc(n)}([^[:alnum:]]|$)`;
  const [revealed, offers, recs] = await Promise.all([
    db.query(`SELECT item_key, item_name, kind, url, sent_at, reaction FROM revealed_offers WHERE user_id = $1 AND item_name ~* $2 ORDER BY sent_at DESC LIMIT 6`, [userId, re]).then((r) => r.rows).catch(() => [] as any[]),
    db.query(`SELECT payload->'match' AS m, decided_at FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND payload->'match'->>'name' ~* $2 ORDER BY decided_at DESC LIMIT 6`, [userId, re]).then((r) => r.rows).catch(() => [] as any[]),
    db.query(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'recommendation_offered' AND content ~* $2 ORDER BY created_at DESC LIMIT 6`, [userId, re]).then((r) => r.rows).catch(() => [] as any[]),
  ]);
  return mergeSent(revealed, offers, recs).filter((x) => namedIn(n, x.name) >= 0 || namedIn(x.name, n) >= 0).slice(0, 3);
}

// Capitalized or quoted phrases in their message that could name a find (not a leading question word).
const LEAD_STOP = new Set(["where", "what", "when", "which", "who", "how", "did", "do", "does", "is", "was", "are", "can", "could", "would", "i", "hey", "ok", "okay", "thanks", "so", "and", "but", "the", "a"]);
export function namedPhrases(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/["“]([^"”]{3,60})["”]/g)) out.push(m[1].trim());
  for (const m of message.matchAll(/\b[A-Z][\w'’&-]*(?:\s+[A-Z][\w'’&-]*)*/g)) {
    const words = m[0].split(/\s+/);
    while (words.length && (LEAD_STOP.has(words[0].toLowerCase()) && (m.index === 0 || words.length > 1))) words.shift();
    const phrase = words.join(" ");
    if (phrase.length >= 4 && !LEAD_STOP.has(phrase.toLowerCase())) out.push(phrase);
  }
  return [...new Set(out)].slice(0, 3);
}

// Through the removals (memberKnowledge.ts withoutRemovedSent): a find they had Cue forget is no referent, however it was found. The
// finds loaded by name or link bypass the reply's own list, so this is the same filter applied to them. Fails closed: when the removals
// can't be read, nothing resolves (a forgotten find is never answered with its details).
export async function dropRemoved<T extends { name: string; postText?: string | null }>(userId: string, items: T[]): Promise<T[]> {
  if (!items.length) return items;
  try {
    const [W, M] = await Promise.all([import("./whatCoKnows.js"), import("./memberKnowledge.js")]);
    return M.withoutRemovedSent(items, await W.forgottenRows(userId), W);
  } catch {
    return [];
  }
}

// Fill each referent's stored record with no window: the stored offer's details and city, found by link or event id, then the saved
// page read. The one filling both the text turn and the call use.
export async function fillReferents(userId: string, found: SentItem[], o: { db?: Db; fill?: (items: SentItem[]) => Promise<void> } = {}): Promise<void> {
  const db = o.db ?? pool;
  await Promise.all(found.map(async (i) => {
    const m = await loadStoredMatch(userId, i, db).catch(() => null);
    if (m) {
      i.details ??= m.details ?? null;
      i.city ??= m.city ?? m.details?.city ?? null;
      i.checkedAt ??= m.checkedAt ?? null;
      i.postText ??= m.opportunity?.postText ?? m.evidence ?? null;
      i.url ??= m.url ?? null;
    }
  }));
  await (o.fill ?? ((items: SentItem[]) => fillDetails(items, { withinDays: 36500, max: 3 })))(found).catch(() => {});
}

// Resolve, once per turn, the finds their message points at and fill each one's stored record with no window. The turn's lists and the
// facts then read this one result. The turn read's meant (an item's link and label) is passed in; a referent not in the recent list is
// looked up by name, whole words, however old. Every path goes through the removals (dropRemoved; o.keep replaces it in tests).
export async function resolveReferents(userId: string, turn: Pick<TurnContext, "sent" | "message">, o: { message: string; meantLabel?: string | null; meantUrl?: string | null; coTexts?: readonly string[]; db?: Db; fill?: (items: SentItem[]) => Promise<void>; keep?: (items: SentItem[]) => Promise<SentItem[]> } = { message: "" }): Promise<SentItem[]> {
  const db = o.db ?? pool;
  const keep = o.keep ?? ((items: SentItem[]) => dropRemoved(userId, items));
  let found = await keep(referredSent(turn.sent, { message: o.message, meantLabel: o.meantLabel, meantUrl: o.meantUrl, coTexts: o.coTexts }));
  if (!found.length && ASKS_ABOUT_FIND.test(o.message)) {
    const names = [o.meantLabel, ...namedPhrases(o.message)].filter((x): x is string => !!x);
    for (const n of names) {
      const older = await keep(await loadSentNamed(userId, n, db).catch(() => [] as SentItem[]));
      for (const x of older) if (!found.some((f) => f.key === x.key && f.url === x.url)) found.push(x);
      if (found.length) break;
    }
    found = found.slice(0, 2);
  }
  await fillReferents(userId, found, { db, fill: o.fill });
  return found;
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
  // What Co knows about them, one read (services/memberKnowledge.ts): asks, lessons, goals with their state, claims, corrections,
  // taste, restraint and everything Co is carrying, stripped inside. Tasks and briefs are read once and shared with the
  // fact lines below. It throws only when the names to strip can't be read: then none of it goes in (fails closed).
  const shared: Partial<KnowledgeDeps> = { tasks: () => tasksOnce(), briefs: () => briefsOnce() };
  const knowledgeP = memberKnowledge(userId, { include: TEXT_KNOWLEDGE }, shared).catch((err: any) => {
    console.error("assembleContext: member knowledge unavailable (non-fatal, left out):", err?.message ?? err);
    return null;
  });
  // Running work and what's ahead, read from real state every turn (Royce, 2026-10-13), started now so they cost no extra wait.
  // One source fence for the whole turn (services/sourceFence.ts): every member-data read below is stripped by it.
  const fenceP = Promise.all([import("./sourceFence.js"), import("./memberSafeMemories.js").then((m) => m.memberSafeLine(userId)).catch(() => null)]).then(([F, line]) => F.fenceFrom(userId, line));
  const searchingP = Promise.all([import("./searchCoverage.js"), fenceP]).then(([C, fence]) => C.searchCoverage(userId, fence).catch(() => C.UNREADABLE));
  const aheadP = Promise.all([import("./whatsAhead.js"), fenceP]).then(([W, fence]) => W.loadAhead(userId, new Date(), fence)).catch(() => null);
  // Their recent exchange with Co, for what waits on them (services/memberWorld.ts): one fenced read, started now beside the others. A
  // failed fence reads nothing (the world then says some of it isn't shown, never that nothing waits).
  const exchangeP = Promise.all([import("./memberWorld.js"), fenceP]).then(([M, fence]) => (fence.failed ? null : M.readRecentExchange(fence))).catch(() => null);
  // When they were active on any channel (timestamps only), so a question they answered by call or to a teammate never "waits".
  const activityP = Promise.all([import("./memberWorld.js"), fenceP]).then(([M, fence]) => (fence.failed ? null : M.readRecentActivity(fence))).catch(() => null);
  // What the pick could send them on a pull right now (harness/waiting.ts): held items and a safety hold leave it empty, so nothing is
  // mentioned or offered that couldn't go.
  const waitingP = import("../harness/waiting.js").then(async (W) => W.couldGo(await W.loadWaiting(userId))).catch(() => [] as import("../harness/waiting.js").WaitingItem[]);
  const [profile, snapshot, sent, knowledge, threads, offersThisWeek, emotional, inlineTarget, ledger, waiting] = await Promise.all([
    pool.query(`SELECT * FROM co_profiles WHERE user_id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
    getPersonSnapshot(userId).catch(() => null),
    loadSentItems(userId).then(async (items) => {
      // Through the removals (memberKnowledge.ts withoutRemovedSent): a find they had Cue forget isn't in the reply's sent list.
      const kept = await Promise.all([import("./whatCoKnows.js"), import("./memberKnowledge.js")])
        .then(async ([W, M]) => M.withoutRemovedSent(items, await W.forgottenRows(userId), W))
        .catch(() => items);
      await fillDetails(kept).catch(() => {});
      return kept;
    }),
    knowledgeP,
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
    Promise.resolve(opts.inlineTarget ?? null).catch(() => null),
    ledgerFacts(userId, `${message}\n${opts.ledgerContext ?? ""}`, zone).catch(() => ({ lines: [] as string[], named: [] as string[] })),
    waitingP,
  ]);
  // Another member's details stripped from everything this context carries that isn't their own words (2026-10-09 audit and
  // review of #118). Fails closed: if the names can't be read, none of these are sent.
  const fence = await fenceP.catch(() => null);
  const safe = fence && !fence.failed ? fence.strip : null;
  const keep = (x: string | null | undefined) => (safe && x ? safe(String(x)) : null);
  const keepAll = (xs: string[]) => xs.map(keep).filter((x): x is string => !!x);
  // Open asks (the newest 12) and Co's lessons (the newest 6), from member knowledge.
  // A line the strip blanked is left out, never an empty entry.
  const asks = (knowledge?.asks ?? []).filter((a) => a.text.trim()).map((a) => ({ text: a.text, kind: a.kind }));
  const lessons = (knowledge?.lessons ?? []).map((l) => l.text).filter((t) => t.trim());
  // Their Google, read from the cache in their own time zone (never fetched while they wait).
  const google = await loadGoogleFacts(userId, zone).catch(() => [] as string[]);
  const [kit, story, advice, tasks, briefs, todayEvent] = await Promise.all([
    loadKit(userId).catch(() => ({}) as Kit),
    loadMilestones(userId).then((m) => storyLines(m, 4)).catch(() => [] as string[]),
    loadAdvice(userId).then((a) => adviceLines(a)).catch(() => [] as string[]),
    // In their local time (services/memberTime.ts), with each commitment's window.
    openTasks(userId).then((t) => taskFactLines(t, undefined, zone)).catch(() => [] as string[]),
    // Research briefs aren't work tasks (openTasks leaves them out) but are theirs to see: running, held, or sent lately.
    recentBriefs(userId).then((b) => briefFactLines(b, zone)).catch(() => [] as string[]),
    import("./eventPresence.js").then((e) => e.todayEventFor(userId)).catch(() => null),
  ]);
  // Open loops join what Co is carrying through member knowledge (read only; the text route syncs them).
  // Their threads, stripped too (keep, above). What Co is carrying comes stripped from member knowledge, and goes through keep again.
  const safeThreads = threads.flatMap((t) => { const text = keep(t.text); const line = keep(t.line); return text && line ? [{ ...t, text, line }] : []; });
  const rawTasks = await tasksOnce().catch(() => [] as CoTask[]);
  // A message that may be about something Co is already doing: a candidate the reply decides on (services/statusCheck.ts), from the
  // tasks already read, through their fence (the number and goal only when it can't be read).
  const statusCheck = await import("./statusCheck.js").then((S) => S.statusCheckFor(message, S.openWorkFrom(rawTasks), zone, safe)).catch(() => null);
  const rawGoals = await import("./goalOwnership.js").then((G) => G.openGoals(userId)).catch(() => null);
  const goals = await import("./goalOwnership.js").then((G) => G.goalFactLines(rawGoals ?? [], rawTasks, zone)).catch(() => [] as { kind: "known" | "scheduled"; text: string }[]);
  const rawBriefs = await briefsOnce().catch(() => [] as BriefView[]);
  const windows = new Map(rawTasks.filter((t) => t.status === "open" && t.window && !t.window.closedAt).map((t) => [`task #${t.id}`, { words: t.window!.words, deadline: t.window!.deadline, zone: t.window!.zone ?? null }]));
  const carrying = carryFromKnowledge(knowledge?.carrying ?? [], zone, windows).flatMap((c) => { const label = keep(c.label); return label ? [{ ...c, label }] : []; });
  const openWork = keepAll([...rawTasks.filter((t) => t.status === "open").map((t) => t.goal), ...rawBriefs.filter((b) => b.status === "open").map((b) => `research brief: ${b.goal}`)]);
  // Without member knowledge, cold start reads their asks itself (never an empty list that would undercount their seeds).
  // No member knowledge (it failed closed): no cold-start steer either, since it would read their asks unstripped (re-review of #125).
  const coldStartP = knowledge ? import("./coldStart.js").then((c) => c.loadColdStart(userId, { profile, asks })).catch(() => null) : Promise.resolve(null);
  const doorP = import("./theDoor.js").then((d) => d.loadDoor(userId)).catch(() => null);
  // The stopped-looking notes owed (services/askRetire.ts), read alongside the goal reads. Whether a hard day holds the one that goes is
  // decided where the reply's facts are gathered, from this message's own feeling read (replyGrounding.ts, services/moodHold.ts); the
  // read here is from before this message.
  const stopNotesP = import("./askRetire.js").then((A) => A.pendingStopNotes(userId)).catch(() => [] as import("./askRetire.js").StopNote[]);
  const goalSetAsides = await import("./goalEdges.js").then((g) => g.untoldSetAsides(userId)).catch(() => []);
  // The goal recheck (services/goalRecheck.ts): a quiet goal's one question, after the set-asides on the same hint, and any already
  // asked, so the reply reads their answer. This message is read through the turn's fence; no fence, no recheck.
  const goalRechecks = await Promise.all([import("./goalRecheck.js"), fenceP.catch(() => null)]).then(([R, fence]) => R.recheckForTurn(userId, message, fence)).catch(() => []);
  // Ask retirement (services/askRetire.ts): a goal question offered this turn goes first; the ask waits. Their words go through keep().
  const goalQuestion = goalSetAsides.length > 0 || goalRechecks.some((r) => r.recheck === "ask");
  const retireRaw = await Promise.all([import("./askRetire.js"), fenceP.catch(() => null)]).then(([A, fence]) => A.retireForTurn(userId, message, fence, { goalQuestion })).catch(() => null);
  const keepAsk = <T extends { text: string }>(r: T | null): T | null => { const t = r ? keep(r.text) : null; return r && t ? { ...r, text: t } : null; };
  const retire = retireRaw ? { ask: keepAsk(retireRaw.ask), asked: retireRaw.asked.map(keepAsk).filter((r): r is NonNullable<typeof r> => !!r) } : undefined;
  // A note carries their own words, so it goes out only if keep() leaves it whole; the first that does (a stripped one never blocks
  // a newer one).
  const stopNote = await Promise.all([import("./askRetire.js"), stopNotesP]).then(([A, notes]) => A.firstSurviving(notes, keep)).catch(() => null);
  const coldStart = await coldStartP;
  const door = await doorP;
  // Asks and goals read raw go through keep like everything else here (another member's details stripped, fails closed).
  const rawSearching = await searchingP;
  const keptAsks = keepAll(rawSearching.asks), keptGoals = keepAll(rawSearching.goals);
  // With the fence failed, their open tasks and running briefs are left out of the facts (keep withholds them); they still run, so
  // they're counted here and the running-work line never says nothing is running.
  const withheldWork = safe ? 0 : tasks.length + briefs.filter((b) => /^(?:Co|Cue) is putting together|hasn't reached them yet/.test(b)).length;
  const searching = { ...rawSearching, asks: keptAsks, goals: keptGoals, hidden: (rawSearching.hidden ?? 0) + rawSearching.asks.length + rawSearching.goals.length - keptAsks.length - keptGoals.length + withheldWork };
  const rawAhead = await aheadP;
  const ahead = rawAhead ? await import("./whatsAhead.js").then((W) => W.aheadLine(rawAhead, searching, zone, keep)).catch(() => undefined) : undefined;
  // Their world (services/memberWorld.ts), from the reads above plus the exchange: no model call, nothing read twice. Lines go through
  // keep; with the fence failed every line is withheld and counted.
  const [exchange, activity] = await Promise.all([exchangeP, activityP]);
  const world = await import("./memberWorld.js")
    .then((M) =>
      M.buildMemberWorld({
        now: new Date(),
        zone,
        keep: (x) => keep(x),
        tasks: keepAll(tasks),
        briefs: keepAll(briefs),
        searching,
        ahead: rawAhead,
        offeredGoals: (rawGoals ?? []).filter((g) => g.status === "offered").map((g) => ({ title: g.title, offeredAt: g.offeredAt, momentOn: g.moment?.date ?? null })),
        threads: safeThreads,
        exchange,
        sent: sent.map((x) => ({ name: x.name, sentAt: x.sentAt, endsOn: x.endsOn ?? null, reaction: x.reaction })),
        activity,
        // From member knowledge (services/memberKnowledge.ts restraint): unread knowledge leaves the hold unknown, so nothing waits.
        safetyHold: knowledge?.restraint ? knowledge.restraint.safetyHold : null,
        letPass: knowledge?.restraint?.suppressedKinds ?? [],
        unreadable: !safe || rawGoals === null,
      }),
    )
    .catch(() => null);
  return { userId, message, profile, snapshot, sent, asks, threads: safeThreads, offersThisWeek, emotional, lessons: keepAll(lessons), inlineTarget, ledger: { ...ledger, lines: keepAll(ledger.lines), named: keepAll(ledger.named) }, capabilities: capabilitySheet(), google, kit, story, advice, tasks: keepAll(tasks), briefs: keepAll(briefs), goals: goals.flatMap((g) => { const text = keep(g.text); return text ? [{ ...g, text }] : []; }), todayEvent, carrying, goalSetAsides: [...goalSetAsides, ...goalRechecks].flatMap((r) => { const g = keep(r.goal); return g ? [{ ...r, goal: g }] : []; }), retire, stopNote, statusCheck, coldStart, door, knowledge, rules: knowledge ? memberRules(knowledge) : null, searching, ahead, world, ...(waiting.length ? { waiting } : {}) };
}

async function loadGoogleFacts(userId: string, zone: string | null): Promise<string[]> {
  const { calendarConnected } = await import("./cueGrants.js");
  // Busy times come from their calendar grant, only their own.
  if (!(await calendarConnected(userId).catch(() => null))) return [];
  const { googleFactsFor } = await import("./googleData.js");
  return googleFactsFor(userId, zone);
}
