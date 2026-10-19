// One member-knowledge layer (Royce, 2026-10-09: "The memberKnowledge(userId) assembler: identity and zone, goals with state, open
// asks, delivered/sent merged, one carrying builder, lessons/corrections/preferences, restraint state, timestamped exchanges. Every
// fact stamped with when it was last verified. Stripping mandatory inside it.").
//
// Why: what Co knows about one member was assembled four ways (services/turnContext.ts for a text reply, services/callContext.ts for
// a call, services/personModel.ts for the sweep and tasks, harness/proactive.ts for what Co starts), each with its own slice, its own
// dedupe and its own strip. A goal the member closed still read as current direction on one path; a document they had read as owed on
// another; a strip added to one path was missing on the next. This is the one assembler every path will read from. THIS file only
// adds it: no path is migrated here (each path moves onto it in its own PR).
//
// ---------------------------------------------------------------- the API (stable; paths build on it)
//
//   memberKnowledge(userId, opts?, deps?): Promise<MemberKnowledge>
//     opts.now           the moment it's assembled for (default: now). Every "due", quiet-hours and restraint read is against it.
//     opts.exchanges     how many recent exchanges (default EXCHANGE_DEFAULTS.limit = 20), newest kept, returned oldest first.
//     opts.exchangeDays  how far back exchanges go (default EXCHANGE_DEFAULTS.days = 14).
//     opts.include       the sections to load (default: all of KNOWLEDGE_SECTIONS). A section left out comes back empty ([] or
//                        null) and its loaders never run, so a cheap path (a quiet-hours check) pays only for what it reads.
//     deps               the loaders, injectable for tests (KnowledgeDeps); anything not passed uses the real one (realKnowledgeDeps).
//   A section loader that fails gives an empty section (logged), the way every context read in Co does. The one exception: the
//   other members' names. If they can't be read, memberKnowledge REJECTS (fails closed, PR #118): callers must catch it and go
//   without member context rather than use anything unstripped.
//
//   memberRules(k): MemberRules   the member-level rules as the shared constants (DISCRETION_GUIDE, CO_GROUNDING, CO_MEMBER_SAFETY,
//                                 DELIVERY_SHAPE_RULE) plus the two read from this member's state (restraint, quiet hours in their
//                                 zone). A rule changed once changes everywhere: nothing here restates a constant's words.
//   carryingOf(...)               the one carrying builder (pure), exported for paths and tests.
//   mergeDelivered(...)           the one delivered/sent merge (pure), exported for paths and tests.
//
// Every fact carries verifiedAt (ISO): when its source row was last written or confirmed (a goal state's changed_at, an ask's
// last_mentioned_at, a loop's last_confirmed_at, a receipt's delivered_at, a claim's confirmed_on). Computed-now state (restraint,
// the person model, which is re-read live) carries asOf.
//
// ---------------------------------------------------------------- stripping (mandatory, inside)
// Another member's details never leave this function (services/memberSafeMemories.ts, #49): after the sections are built, EVERY
// string in the result goes through safeMemory with the names of the members this one has been linked with
// (linkedMemberNames), except (a) structural values (ids, kinds, states, timestamps, urls, the zone, the member's own first name)
// and (b) the member's own words (their exchange lines, a claim's quote), which are theirs and kept, as safeMemory keeps "User said:".
// The walk is over the finished object, not field by field, so a field added later is stripped without anyone remembering to.
// There is no un-stripped variant and no flag to skip it.
//
// Every read is scoped to one member (user_id = $1). Read only: nothing here writes (memberZone may store a derived zone, as it
// does for every reader).
import { ASK_ON_FILE } from "./openLoops.js";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { DISCRETION_GUIDE } from "../harness/discretion.js";
import type { EmotionalContext } from "../harness/emotion.js";
import { CO_GROUNDING, CO_MEMBER_SAFETY } from "./coCore.js";
import { collapseCarried, promiseFacts, type CarriedLine, type CorrectionRow } from "./callContext.js";
import { isDoorLook, type BriefView, type CoTask } from "./coTasks.js";
import type { Receipt } from "./deliveryReceipts.js";
import type { Claim, Kind as ClaimKind, Provenance } from "./factLabels.js";
import type { GoalState, GoalStateRow } from "./goalEdges.js";
import { goalHash, restates } from "./goalEdges.js";
import { RESTRAINT, type ProactiveKind } from "./kindRestraint.js";
import { REASONABLE_HOUR_END, REASONABLE_HOUR_START } from "./localHours.js";
import type { Limits } from "./memberLimits.js";
import { memberNamesStrict, safeMemory } from "./memberSafeMemories.js";
import { localDay, localStamp, memberZone, sendableAt, wordsZone } from "./memberTime.js";
import { DELIVERY_SHAPE_RULE } from "./speakable.js";
import { notToTeammate } from "./teamLines.js";
import type { SentItem } from "./turnContext.js";

// ---------------------------------------------------------------- types

// A fact and when its source was last written or confirmed (ISO).
export type Fact<T> = T & { verifiedAt: string };

export type Identity = {
  firstName: string | null;
  city: string | null;
  // Their zone (services/memberTime.ts memberZone, the one source), or null when none is known.
  zone: string | null;
  // The zone every time decision measures in: theirs, else the fallback (wordsZone).
  timeZone: string;
};

// done/stale goals are history, never current direction: read only state === "active" as where they're headed.
// onFile: the goal is on their profile or a goal entry now; false for a state row whose goal is no longer on file (history only, never
// planned from; Phase A4).
// hash: goalHash of the goal as written, before the strip (a goal naming a linked member is rewritten by it), so a reader can match
// the goal to its state row and to its own words (Phase A4).
// source: who set its state on goal_states (goalEdges.ts GoalStateRow: "context" is Co's own read, "member" and "co" were said in
// conversation); null when no state row exists. Readers that need to know whether the member closed a goal read it (sweepSelectContext.ts).
export type Goal = { text: string; state: GoalState; reason: string | null; told: boolean; onFile: boolean; hash: string; source?: "context" | "member" | "co" | null };
export type Ask = { id: string; text: string; kind: "find" | "help" };

// Where a delivered item was seen: a document receipt (document_deliveries), Co's action record (co_facts relation 'sent'), or a
// sent offer (revealed_offers / proactive_candidates / recommendation_offered, turnContext.ts loadSentItems).
export type DeliveredVia = "receipt" | "ledger" | "offer";
export type Delivered = { what: string; kind: string; at: string; via: DeliveredVia[]; url: string | null; reaction: string | null };

export type CarryKind = "task" | "promise" | "lookout" | "brief" | "loop" | "document";
export type CarryItem = {
  what: string;
  kind: CarryKind;
  state: "due" | "outstanding" | "done";
  // Co already told them about it (never news again unless it changed or they ask).
  told: boolean;
  // They already have it (a delivered document, a promise that went): background, never a reason to talk.
  theyHaveIt: boolean;
  dueAt: string | null;
  // For tools, never for member-facing text: "task #12", "brief #4", "doc #7", "loop 31".
  ref: string | null;
  // A loop's own status and detail ("waiting_on_them"), when it has one.
  status: string | null;
  detail: string | null;
};

export type Lesson = { text: string };
export type Correction = { field: string; was: string; now: string | null };
// "stated": what kind of room they told Co they want (services/roomTaste.ts), first; "taste": how what Co sent landed.
export type Preference = { text: string; source: "taste" | "stated" };
export type HeldClaim = { text: string; provenance: Provenance; kind: ClaimKind; quote: string | null; expiresOn: string | null; saidOn: string };

export type Restraint = {
  // proactive_user_state.hold_until / space_until, when still ahead.
  holdUntil: string | null;
  spaceUntil: string | null;
  // co_profiles.safety_hold_until ahead (services/safety.ts safetyHoldActive).
  safetyHold: boolean;
  // harness/emotion.ts: struggling lately (shapes how, never whether), and frustrated with Co itself.
  needsCare: boolean;
  frustratedWithCo: boolean;
  // Their latest feeling, read from their words (one line), or null.
  feeling: string | null;
  // services/kindRestraint.ts: kinds Co doesn't start for them, and those whose one trial may go.
  suppressedKinds: ProactiveKind[];
  trialKinds: ProactiveKind[];
  // Co's proactive texts since they last wrote, for awareness.
  // No pause date: the unanswered pause is the send gate's, per lane (harness/proactive.ts userLevelChecks), and a single date
  // here would be wrong (review of #119).
  unanswered: { count: number; lastInboundAt: string | null; lastSentAt: string | null };
};

export type Exchange = { from: "member" | "co"; text: string; call: boolean };
// What they ruled out (co_profiles.avoid, written by steerAwayFrom) and when they're usually free (their latest ask's own availability,
// else the profile's pattern). Read here only (Phase A6: one reader per fact); applied by services/memberLimits.ts.
export type { Limits };

export type MemberKnowledge = {
  userId: string;
  asOf: string;
  identity: Fact<Identity>;
  goals: Fact<Goal>[];
  asks: Fact<Ask>[];
  delivered: Fact<Delivered>[];
  carrying: Fact<CarryItem>[];
  lessons: Fact<Lesson>[];
  corrections: Fact<Correction>[];
  preferences: Fact<Preference>[];
  claims: Fact<HeldClaim>[];
  restraint: Fact<Restraint> | null;
  exchanges: Fact<Exchange>[];
  person: Fact<{ text: string }> | null;
  limits: Fact<Limits> | null;
  // How many things they asked Co to remove (services/whatCoKnows.ts), never what they were: read with exchanges or corrections.
  removedCount?: number;
};

export const KNOWLEDGE_SECTIONS = ["goals", "asks", "delivered", "carrying", "lessons", "corrections", "preferences", "claims", "restraint", "exchanges", "person", "limits"] as const;
export type KnowledgeSection = (typeof KNOWLEDGE_SECTIONS)[number];
export const EXCHANGE_DEFAULTS = { limit: 20, days: 14 } as const;
// Corrections: the recent ones by default; goal planning reads them all (a goal retired by an old correction must stay retired).
export const CORRECTION_DEFAULTS = { limit: 8, days: 90 as number | null } as const;
export type KnowledgeOptions = { now?: Date; exchanges?: number; exchangeDays?: number; include?: readonly KnowledgeSection[]; corrections?: { limit: number; days: number | null } };

export type MemberRules = {
  discretion: string;
  memberSafety: string;
  grounding: string;
  deliveryShape: string;
  restraint: string;
  quietHours: string;
};

// ---------------------------------------------------------------- loaders (raw rows; injectable)

export type RawProfile = { firstName: string | null; city: string | null; goals: string[] | null; intent: unknown; updatedAt: Date | null };
export type RawAsk = { id: string; text: string; kind: string | null; createdAt: Date; lastMentionedAt: Date | null };
export type RawSent = { label: string; url: string | null; kind: string | null; at: Date };
export type RawLoop = { id: number; title: string; status: string; dueDate: string | null; source: string; detail: string | null; changedAt: Date; lastConfirmedAt: Date | null };
export type RawRestraint = {
  holdUntil: Date | null;
  spaceUntil: Date | null;
  safetyHold: boolean;
  // The whole read (dispatch renders the feeling for its drafts from this same read); the record itself uses needsCare, withCo, current.
  emotional: EmotionalContext | null;
  suppressed: ProactiveKind[];
  trial: ProactiveKind[];
  lastInboundAt: Date | null;
  // Co's proactive sends since lastInboundAt (not exempt), oldest first.
  unansweredSends: Date[];
  // They said they're away from home, and it still holds (services/away.ts): finds tied to where they live wait.
  away?: import("./away.js").AwayState | null;
  // The kind-restraint read itself (services/kindRestraint.ts), for dispatch to sync the learned preference from the same read
  // (Phase A6: dispatch read restraint and emotion a second time); null when it failed and the stored preferences stood in.
  kinds?: { verdicts: Map<ProactiveKind, import("./kindRestraint.js").KindVerdict>; stored: import("./kindRestraint.js").StoredPref[] } | null;
};
export type KnowledgeDeps = {
  profile: (userId: string) => Promise<RawProfile | null>;
  zone: (userId: string) => Promise<string | null>;
  linkedNames: (userId: string) => Promise<string[]>;
  goalStates: (userId: string) => Promise<GoalStateRow[]>;
  asks: (userId: string) => Promise<RawAsk[]>;
  receipts: (userId: string) => Promise<Receipt[]>;
  ledgerSent: (userId: string) => Promise<RawSent[]>;
  offers: (userId: string) => Promise<SentItem[]>;
  tasks: (userId: string) => Promise<CoTask[]>;
  briefs: (userId: string) => Promise<BriefView[]>;
  loops: (userId: string) => Promise<RawLoop[]>;
  promiseResults: (userId: string) => Promise<{ at: Date; content: string }[]>;
  lessons: (userId: string) => Promise<{ text: string; at: Date }[]>;
  corrections: (userId: string, o: { limit: number; days: number | null }) => Promise<CorrectionRow[]>;
  limits: (userId: string) => Promise<Limits & { at: Date | null }>;
  taste: (userId: string) => Promise<{ text: string; at: Date } | null>;
  roomTaste: (userId: string) => Promise<{ text: string; at: Date }[]>;
  // Their design taste (services/designTaste.ts), read with room taste as what they told Co. Optional, so stubs without it still work.
  designTaste?: (userId: string) => Promise<{ text: string; at: Date }[]>;
  claims: (userId: string, now: Date, zone: string | null) => Promise<Claim[]>;
  restraint: (userId: string, now: Date) => Promise<RawRestraint>;
  exchanges: (userId: string, o: { limit: number; days: number }) => Promise<{ content: string; at: Date }[]>;
  person: (userId: string) => Promise<string>;
  // What they corrected or removed through Co (services/whatCoKnows.ts, the live guards): exchanges that say a removed thing are left
  // out, and ones that still say a corrected-away value carry the correction inline. Optional, so stubs without it work.
  forgotten?: (userId: string) => Promise<import("./whatCoKnows.js").ForgottenRow[]>;
};

const rows = (sql: string, args: unknown[]) => pool.query(sql, args).then((r) => r.rows as any[]);
const dateOrNull = (x: unknown) => (x ? new Date(x as string) : null);
const dayString = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));

export const realKnowledgeDeps: KnowledgeDeps = {
  profile: async (userId) => {
    const r = (await rows(`SELECT u.first_name, cp.city, cp.goals, cp.intent, cp.updated_at FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]))[0];
    return r ? { firstName: r.first_name ?? null, city: r.city ?? null, goals: Array.isArray(r.goals) ? r.goals.map(String) : null, intent: r.intent ?? null, updatedAt: dateOrNull(r.updated_at) } : null;
  },
  zone: (userId) => memberZone(userId),
  // The same full name set memberSafe uses (linked matches, Co's records, introductions), read strictly (PR #118).
  linkedNames: (userId) => memberNamesStrict(userId),
  goalStates: async (userId) => [...(await (await import("./goalEdges.js")).goalStates(userId)).values()],
  asks: async (userId) =>
    (await rows(`SELECT ask_id, ask_text, kind, created_at, last_mentioned_at FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY last_mentioned_at DESC NULLS LAST, created_at DESC LIMIT 12`, [userId])).map((r) => ({
      id: String(r.ask_id),
      text: String(r.ask_text ?? ""),
      kind: r.kind ?? null,
      createdAt: new Date(r.created_at),
      lastMentionedAt: dateOrNull(r.last_mentioned_at),
    })),
  receipts: async (userId) => (await import("./deliveryReceipts.js")).pgReceipts.forUser(userId, 30),
  ledgerSent: async (userId) =>
    (
      await rows(
        `SELECT object_label, url, meta->>'kind' AS kind, happened_at FROM co_facts
         WHERE owner_user_id = $1 AND subject = 'co' AND relation = 'sent' AND retired_at IS NULL AND happened_at > NOW() - INTERVAL '45 days'
         ORDER BY happened_at DESC LIMIT 80`,
        [userId],
      )
    ).map((r) => ({ label: String(r.object_label), url: r.url ?? null, kind: r.kind ?? null, at: new Date(r.happened_at) })),
  offers: async (userId) => (await import("./turnContext.js")).loadSentItems(userId, 45),
  tasks: async (userId) => (await import("./coTasks.js")).openTasks(userId),
  briefs: async (userId) => (await import("./coTasks.js")).recentBriefs(userId),
  loops: async (userId) =>
    (
      await rows(
        `SELECT id, title, status, due_date, source, detail, changed_at, last_confirmed_at FROM open_loops
         WHERE user_id = $1 AND closed_at IS NULL AND status NOT IN ('done', 'dropped') ORDER BY changed_at DESC LIMIT 12`,
        [userId],
      )
    ).map((r) => ({ id: Number(r.id), title: String(r.title), status: String(r.status), dueDate: dayString(r.due_date), source: String(r.source), detail: r.detail ?? null, changedAt: new Date(r.changed_at), lastConfirmedAt: dateOrNull(r.last_confirmed_at) })),
  promiseResults: async (userId) =>
    (await rows(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'promise_result' AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 8`, [userId])).map((r) => ({
      at: new Date(r.created_at),
      content: String(r.content),
    })),
  lessons: async (userId) =>
    (await rows(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'co_lesson' ORDER BY created_at DESC LIMIT 6`, [userId])).map((r) => ({ text: String(r.content), at: new Date(r.created_at) })),
  corrections: async (userId, o) =>
    (await rows(
      // A removal (services/whatCoKnows.ts) isn't a correction anyone reads: what they had removed is never put back in front of Co,
      // not even as "was X". Only the rebuild guards read it (forgottenRows). Read through to_jsonb so a database without the column
      // yet still reads every correction.
      `SELECT field, old_value, new_value, corrected_at FROM profile_corrections pc WHERE user_id = $1 AND (to_jsonb(pc)->>'removed') IS DISTINCT FROM 'true' AND ($2::int IS NULL OR corrected_at > NOW() - make_interval(days => $2::int)) ORDER BY corrected_at DESC LIMIT $3`,
      [userId, o.days, o.limit],
    )) as CorrectionRow[],
  limits: async (userId) => {
    const r = (await rows(`SELECT avoid, availability_pattern, intent, updated_at FROM co_profiles WHERE user_id = $1`, [userId]))[0];
    if (!r) return { avoid: [], availability: null, at: null };
    const { latestAskEntry } = await import("../harness/profileWrite.js");
    const latestAsk = latestAskEntry(r.intent);
    const availability = (latestAsk?.availability && String(latestAsk.availability).trim()) || (r.availability_pattern && String(r.availability_pattern).trim()) || null;
    return { avoid: Array.isArray(r.avoid) ? r.avoid.filter((a: unknown) => typeof a === "string" && a.trim()).map((a: string) => a.trim()) : [], availability, at: dateOrNull(r.updated_at) };
  },
  roomTaste: async (userId) => {
    const R = await import("./roomTaste.js");
    return (await R.loadRoomTaste(userId)).map((r) => ({ text: R.roomTasteLine(r.taste), at: r.at }));
  },
  designTaste: async (userId) => {
    const D = await import("./designTaste.js");
    const t = await D.loadDesignTaste(userId);
    return t ? [{ text: D.designTasteLine(t.taste), at: t.at }] : [];
  },
  taste: async (userId) => {
    const text = await (await import("./outcomes.js")).tasteSummary(userId);
    if (!text) return null;
    const at = (await rows(`SELECT MAX(created_at) AS at FROM suggestion_outcomes WHERE user_id = $1 AND result <> 'no_signal'`, [userId]))[0]?.at;
    return { text, at: at ? new Date(at) : new Date() };
  },
  // Backstop: a claim a live guard says was removed or corrected away (services/whatCoKnows.ts) is never read, even if a row of it
  // is still in the table (review of 3108dcf).
  claims: async (userId, now, zone) => {
    const [claims, W] = await Promise.all([(await import("./claims.js")).liveClaims(userId, now, zone), import("./whatCoKnows.js")]);
    const rows = await W.forgottenRows(userId).catch(() => []);
    return rows.length ? claims.filter((c) => !W.forgets(c.text, rows, "claim")) : claims;
  },
  restraint: async (userId, now) => {
    const [state, safetyHold, emotional, kinds, inbound] = await Promise.all([
      rows(`SELECT hold_until, space_until FROM proactive_user_state WHERE user_id = $1`, [userId]).then((r) => r[0] ?? null),
      import("./safety.js").then((s) => s.safetyHoldActive(userId)),
      import("../harness/emotion.js").then((e) => e.getEmotionalContext(userId, now)).catch(() => null),
      import("./kindRestraint.js").then(async (K) => {
        const r = await K.loadKindRestraint(pool, userId, now).catch((err: any) => {
          console.error("memberKnowledge: kind restraint read failed (non-fatal, holding what's stored):", err?.message ?? err);
          return null;
        });
        if (!r) return { suppressed: (await K.loadStoredPrefs(pool, userId).catch(() => [])).filter((p) => p.state === "suppressed").map((p) => p.kind), trial: [] as ProactiveKind[], read: null };
        // A kind whose days off are up has one trial: suppressed is false then, trial true (kindRestraint.ts). It used to be read as
        // suppressed && trial, which is never true, so the trial was never named (Phase A6).
        return { suppressed: K.suppressedKinds(r.verdicts), trial: [...r.verdicts.values()].filter((v) => v.trial).map((v) => v.kind), read: r };
      }),
      rows(`SELECT MAX(created_at) AS at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User %' OR content LIKE '[Call]%')`, [userId]).then((r) => dateOrNull(r[0]?.at)),
    ]);
    // Away (services/away.ts): their live away claim. A failed read holds nothing (no away), like any other claim read.
    const away = await rows(`SELECT kind, text, quote, provenance, expires_on FROM member_claims WHERE user_id = $1 AND kind = 'away'`, [userId])
      .then(async (r) => {
        const A = await import("./away.js");
        const zone = await (await import("./memberTime.js")).memberZone(userId).catch(() => null);
        return A.awayFromClaims(r.map((x: any) => ({ kind: String(x.kind), text: String(x.text), quote: x.quote ?? null, provenance: x.provenance ?? null, expiresOn: x.expires_on ? (x.expires_on instanceof Date ? DateTime.fromJSDate(x.expires_on).toISODate() : String(x.expires_on).slice(0, 10)) : null })), now, zone ?? undefined);
      })
      .catch(() => null);
    const sends = await rows(`SELECT sent_at FROM proactive_sends WHERE user_id = $1 AND NOT exempt AND sent_at > COALESCE($2::timestamptz, NOW() - INTERVAL '30 days') AND sent_at <= $3 ORDER BY sent_at`, [userId, inbound, now]);
    return {
      holdUntil: dateOrNull(state?.hold_until),
      spaceUntil: dateOrNull(state?.space_until),
      safetyHold,
      emotional,
      suppressed: kinds.suppressed,
      trial: kinds.trial,
      kinds: kinds.read,
      lastInboundAt: inbound,
      unansweredSends: sends.map((s) => new Date(s.sent_at)),
      away,
    };
  },
  exchanges: async (userId, o) =>
    (
      await rows(
        `SELECT content, created_at FROM co_memories
         WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} AND created_at > NOW() - make_interval(days => $2)
         ORDER BY created_at DESC LIMIT $3`,
        // Twice the window: notes that aren't exchanges are dropped after, and mustn't use up the member's slots (review of #119).
        [userId, o.days, o.limit * 2],
      )
    ).map((r) => ({ content: String(r.content ?? ""), at: new Date(r.created_at) })),
  person: async (userId) => {
    const P = await import("./personModel.js");
    return P.renderPersonModel(await P.personModelParts(userId));
  },
  forgotten: async (userId) => (await import("./whatCoKnows.js")).forgottenRows(userId),
};

// ---------------------------------------------------------------- pure builders

// Pure: sent items (turnContext.ts loadSentItems) without the ones whose name or the post they came from says something the member
// had Cue forget (rows: removals; W: whatCoKnows' guardText). Every prompt reader of the list uses it: the layer's delivered and
// carrying, the reply's sent list, the call's "what you sent them lately". The reaction matcher reads the list unfiltered.
export function withoutRemovedSent<T extends { name: string; postText?: string | null }>(items: T[], rows: import("./whatCoKnows.js").ForgottenRow[], W: Pick<typeof import("./whatCoKnows.js"), "guardText">): T[] {
  const removed = rows.filter((r) => r.removed);
  if (!removed.length) return items;
  const same = (t: string | null | undefined) => !t || W.guardText(t, removed) === t;
  return items.filter((i) => same(i.name) && same(i.postText));
}

const DAY = 86_400_000;
const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const latest = (...ds: (Date | string | null | undefined)[]): string => {
  const ts = ds.map((d) => (d ? new Date(d).getTime() : NaN)).filter((t) => Number.isFinite(t));
  return new Date(ts.length ? Math.max(...ts) : 0).toISOString();
};
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const urlKey = (u: string | null | undefined) => (u ? u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[/?#]+$/, "") : null);
// Co's ledger labels a document "a document (PDF): Title" (services/coFacts.ts DOCUMENT_LABEL); the title is the thing.
const DOC_LABEL = /^a document(?: \([^)]*\))?:\s*/i;
const docTitle = (label: string) => label.replace(DOC_LABEL, "").trim();

// Meaning words, for "is this the same thing" between a call promise and a task (callContext.ts keeps its own private copy).
const STOP = new Set("the and for but not you are was has had with that this what your have just like would want into some more they them their from about also then than over will send text find".split(" "));
const meaning = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
const sameThing = (a: string, b: string) => {
  const A = meaning(a), B = meaning(b);
  const small = Math.min(A.size, B.size);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return small > 0 && n >= Math.max(2, Math.ceil(small * 0.6));
};

// Pure: goals with state. Profile goals and goal entries (the sources of goalJourney.ts goalTexts) joined with goal_states (goalEdges.ts,
// active/done/stale) by goalHash. An entry they closed ("resolved") is done. A goal_states row with no goal left on file still shows,
// with its state: a done goal is history, never dropped silently and never current.
export function goalsOf(profile: RawProfile | null, states: GoalStateRow[]): Fact<Goal>[] {
  const byHash = new Map(states.map((s) => [s.goalHash, s]));
  const out = new Map<string, Fact<Goal>>();
  const add = (text: string, base: { state: GoalState; at: Date | string | null; reason?: string | null }, onFile = true) => {
    const t = text.trim();
    if (!t) return;
    const h = goalHash(t);
    if (out.has(h)) return;
    const s = byHash.get(h);
    // A stored state wins over "active from the profile"; a closed entry stays done whatever the stored row says.
    const state: GoalState = base.state !== "active" ? base.state : s?.state ?? "active";
    out.set(h, { text: t, state, reason: s?.reason || base.reason || null, told: s ? !!s.toldAt || s.source !== "context" : true, onFile, hash: h, source: s?.source ?? null, verifiedAt: latest(base.at, s?.changedAt) });
  };
  // Goal entries: active is active, resolved is done (goalJourney.ts goalHistory), anything else (set aside, replaced) is stale.
  for (const e of Array.isArray(profile?.intent) ? (profile!.intent as any[]) : []) {
    if (e?.kind !== "goal" || typeof e?.text !== "string") continue;
    const at = e.confirmed_at ?? e.resolved_at ?? e.created_at ?? profile?.updatedAt ?? null;
    if (e.status === "active") add(e.text, { state: "active", at });
    else if (e.status === "resolved") add(e.text, { state: "done", at, reason: "they closed it" });
    else add(e.text, { state: "stale", at, reason: e.status ? `marked ${e.status}` : null });
  }
  for (const g of profile?.goals ?? []) add(String(g), { state: "active", at: profile?.updatedAt ?? null });
  for (const s of states) add(s.goal, { state: s.state, at: s.changedAt }, false);
  const rank = { active: 0, stale: 1, done: 2 } as const;
  return [...out.values()].sort((a, b) => rank[a.state] - rank[b.state]);
}

// Pure: a goal correction whose corrected value is a goal that's since done or set aside says so (Royce, 2026-10-09: "partnering
// with Sequin AI for a November launch party" kept reading as their current goal in calls and nudges after it was done; the
// stale-goal steering bug in a correction's clothes). The old value stays wrong either way, so the correction stays. Only a clear
// match: an active goal with the same words, or one that restates it, leaves it alone.
// The marker leads the value, so a reader that caps the line (nudges cut it at 80 characters) still carries it.
export const SETTLED_GOAL = { done: "since done, history only:", stale: "since set aside, history only:" } as const;
// Pure: a corrected value without the marker, and which marker it had. Comparisons read the plain value (review of #130:
// the marker's words shifted callContext's overlap match, so short goals' call lines were dropped); only display shows it.
const SETTLED_PREFIX = /^\((since done|since set aside), history only:\)\s*/;
export function plainCorrected(v: string | null | undefined): { text: string; settled: "done" | "stale" | null } {
  const s = String(v ?? "");
  const m = s.match(SETTLED_PREFIX);
  return { text: m ? s.slice(m[0].length) : s, settled: m ? (m[1] === "since done" ? "done" : "stale") : null };
}
export function settleGoalCorrections<C extends Correction>(corrections: C[], goals: Pick<Goal, "text" | "state">[]): C[] {
  const same = (a: string, b: string) => goalHash(a) === goalHash(b) || (restates(a, b) && restates(b, a));
  return corrections.map((c) => {
    if (!/\bgoals?\b/i.test(c.field) || !c.now?.trim()) return c;
    const now = c.now;
    if (goals.some((g) => g.state === "active" && same(now, g.text))) return c;
    const closed = goals.find((g) => g.state !== "active" && same(now, g.text));
    return closed ? { ...c, now: `(${SETTLED_GOAL[closed.state === "done" ? "done" : "stale"]}) ${now}` } : c;
  });
}

// Pure: everything Co sent them, one entry per thing (a URL or a name), from all three records. at is the newest send of it.
export function mergeDelivered(o: { receipts: Receipt[]; ledger: RawSent[]; offers: SentItem[] }): Fact<Delivered>[] {
  const items: Fact<Delivered>[] = [];
  const find = (what: string, url: string | null) => {
    const u = urlKey(url), n = norm(what);
    return items.find((i) => (u && urlKey(i.url) === u) || (n && norm(i.what) === n));
  };
  const add = (x: { what: string; kind: string; at: Date; via: DeliveredVia; url: string | null; reaction?: string | null }) => {
    if (!x.what.trim()) return;
    const had = find(x.what, x.url);
    const at = x.at.toISOString();
    if (!had) {
      items.push({ what: x.what.trim(), kind: x.kind, at, via: [x.via], url: x.url, reaction: x.reaction ?? null, verifiedAt: at });
      return;
    }
    if (!had.via.includes(x.via)) had.via.push(x.via);
    had.url ??= x.url;
    had.reaction ??= x.reaction ?? null;
    if (had.kind === "item" && x.kind !== "item") had.kind = x.kind;
    if (at > had.at) had.at = had.verifiedAt = at;
  };
  // One entry per document across versions: the newest.
  const newest = new Map<string, Receipt>();
  for (const r of [...o.receipts].sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime())) if (!newest.has(r.docKey)) newest.set(r.docKey, r);
  for (const r of newest.values()) add({ what: r.title, kind: "document", at: r.deliveredAt, via: "receipt", url: r.link });
  for (const r of o.ledger) {
    const doc = DOC_LABEL.test(r.label);
    add({ what: doc ? docTitle(r.label) : r.label, kind: doc ? "document" : r.kind ?? "item", at: r.at, via: "ledger", url: r.url });
  }
  for (const s of o.offers) add({ what: s.name, kind: s.kind, at: s.sentAt, via: "offer", url: s.url, reaction: s.reaction });
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

// Pure: the one carrying builder. turnContext.ts carryingItems (tasks, briefs, receipts, loops, with told) and callContext.ts
// collapseCarried (a call's promises against what was delivered: "they have it") in one list, each item once: due first, then
// outstanding, then done; within a state, soonest due first.
export function carryingOf(o: { tasks: CoTask[]; briefs: BriefView[]; receipts: Receipt[]; ledger: RawSent[]; loops: RawLoop[]; promises: { at: Date; content: string }[]; now: Date; zone: string | null }): Fact<CarryItem>[] {
  const now = o.now.getTime();
  const tomorrow = localDay(new Date(now + DAY), o.zone);
  const items: Fact<CarryItem>[] = [];
  const item = (x: Omit<CarryItem, "status" | "detail"> & { status?: string | null; detail?: string | null; verifiedAt: string }): Fact<CarryItem> => ({ ...x, status: x.status ?? null, detail: x.detail ?? null });

  for (const t of o.tasks.filter((x) => x.status === "open")) {
    const windowDue = t.window && !t.window.closedAt ? new Date(t.window.deadline).getTime() : null;
    const deadlineDue = t.deadline ? new Date(`${t.deadline}T23:59:00Z`).getTime() : null;
    const due = (windowDue !== null && windowDue - now <= DAY) || (!!t.deadline && t.deadline <= tomorrow) || (!!t.nextCheckAt && new Date(t.nextCheckAt).getTime() <= now);
    // A promise from a reply, or a look-out said aloud on a call: they heard it, so it's told (review of #113).
    // A look-out they asked for is their ask in Co's hands, never "your promise on a call" (review of #131: the label would have Co
    // say it promised on a call that never happened).
    // A first read's look that promised nothing (coTasks.ts isDoorLook) is Co's own work, never "your promise": it was never said.
    const kind: CarryKind = isDoorLook(t) ? "task" : t.source === "lookout" && t.lookoutOrigin !== "member" ? "lookout" : t.source === "promise" ? "promise" : "task";
    const what = kind === "task" ? t.goal : t.goal.replace(/^(?:Keep your promise|Keep an eye out, as promised on a call):\s*/i, "");
    const dueMs = windowDue ?? deadlineDue;
    items.push(item({ what, kind, state: due ? "due" : "outstanding", told: kind !== "task" || !!t.lastTextedAt, theyHaveIt: false, dueAt: dueMs !== null ? new Date(dueMs).toISOString() : null, ref: `task #${t.id}`, verifiedAt: latest(t.createdAt, t.lastTextedAt, t.theirReplyAt, ...(t.notes ?? []).map((n: any) => n?.at)) }));
  }
  for (const b of o.briefs) {
    const at = latest(b.createdAt, b.closedAt, b.held?.at || null);
    if (b.status === "open" && b.held) items.push(item({ what: b.goal, kind: "brief", state: "due", told: false, theyHaveIt: false, dueAt: o.now.toISOString(), ref: `brief #${b.id}`, detail: "finished and hasn't reached them", verifiedAt: at }));
    else if (b.status === "open") items.push(item({ what: b.goal, kind: "brief", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: `brief #${b.id}`, detail: "running", verifiedAt: at }));
    else if (b.status === "done") items.push(item({ what: b.goal, kind: "brief", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: `brief #${b.id}`, detail: "finished", verifiedAt: at }));
  }
  // Documents they have: the newest version of each (receipts), then Co's older ledger record of documents (which predates receipts).
  const newest = new Map<string, Receipt>();
  for (const r of [...o.receipts].sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime())) if (!newest.has(r.docKey)) newest.set(r.docKey, r);
  const docs = [...newest.values()].slice(0, 5);
  for (const r of docs) {
    const pending = r.status === "pdf_pending";
    items.push(item({ what: r.title, kind: "document", state: pending ? "outstanding" : "done", told: true, theyHaveIt: true, dueAt: null, ref: `doc #${r.id}`, detail: pending ? "the text went; the PDF still follows" : `version ${r.version}, delivered`, verifiedAt: r.deliveredAt.toISOString() }));
  }
  const ledgerDocs = o.ledger.filter((r) => DOC_LABEL.test(r.label) && now - r.at.getTime() <= 30 * DAY);
  for (const r of ledgerDocs) {
    const title = docTitle(r.label);
    if (!title || items.some((i) => i.kind === "document" && (norm(i.what) === norm(title) || sameThing(i.what, title)))) continue;
    items.push(item({ what: title, kind: "document", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: null, detail: "delivered", verifiedAt: r.at.toISOString() }));
  }
  // Loops: task loops are the tasks above; the rest (their notes, an ask, an offer) are the loops' own.
  for (const l of o.loops.filter((x) => x.source !== "task" && x.status !== "done" && x.status !== "dropped").slice(0, 6)) {
    const due = !!l.dueDate && l.dueDate <= tomorrow;
    items.push(item({ what: l.title, kind: "loop", state: due ? "due" : "outstanding", told: false, theyHaveIt: false, dueAt: l.dueDate ? new Date(`${l.dueDate}T23:59:00Z`).toISOString() : null, ref: `loop ${l.id}`, status: l.status, detail: l.detail ? l.detail.slice(0, 160) : l.source === "ask" && l.status === "open" ? ASK_ON_FILE : null, verifiedAt: latest(l.lastConfirmedAt, l.changedAt) }));
  }
  // What Co said on a call it would do (promise_result), collapsed against what was delivered (callContext.ts collapseCarried):
  // a promise that went, or that names a document they have, is theirs ("they have it"); the rest is outstanding, and told (they
  // heard it on the call). A promise that is also a task above shows once, as the task.
  const delivered = [...docs.map((r) => ({ title: r.title, at: r.deliveredAt })), ...ledgerDocs.map((r) => ({ title: docTitle(r.label), at: r.at }))];
  // The same "Oct 8: " day prefix callContext gives each line: collapseCarried reads the day from it and strips "Promised on the
  // call:" after it; without it every promise naming a deliverable matched any sent one and dropped (review of #119).
  const zoneDay = (d: Date | string) => DateTime.fromJSDate(d instanceof Date ? d : new Date(d)).setZone(wordsZone(o.zone)).toFormat("LLL d");
  const facts = promiseFacts(o.promises.map((p) => ({ at: p.at, content: p.content })));
  const lines: (CarriedLine & { at: Date | string; what: string })[] = facts.map((f) => ({
    text: `${zoneDay(f.at)}: ${f.text}`,
    from: "promise" as const,
    sent: /\bSent\.$/.test(f.text),
    at: f.at,
    what: f.text.replace(/^Promised on the call:\s*/i, "").replace(/\.\s*(?:Sent|Not sent yet)\.$/i, "").trim(),
  }));
  const open = new Set<CarriedLine>(collapseCarried(lines, delivered, zoneDay).open);
  for (const l of lines) {
    if (items.some((i) => (i.kind === "promise" || i.kind === "lookout" || i.kind === "task") && sameThing(i.what, l.what))) continue;
    if (open.has(l)) items.push(item({ what: l.what, kind: "promise", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: null, verifiedAt: new Date(l.at).toISOString() }));
    // Not open on its own either: handled (sent, or a delivery covers it). Open on its own: a duplicate of another promise, said once.
    else if (!collapseCarried([l], delivered, zoneDay).open.length) items.push(item({ what: l.what, kind: "promise", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: null, verifiedAt: new Date(l.at).toISOString() }));
  }
  const rank = { due: 0, outstanding: 1, done: 2 } as const;
  const dueOf = (i: CarryItem) => (i.dueAt ? new Date(i.dueAt).getTime() : Infinity);
  return items.sort((a, b) => rank[a.state] - rank[b.state] || dueOf(a) - dueOf(b));
}

// Pure: restraint state from its raw reads, against now.
export function restraintOf(r: RawRestraint, now: Date): Fact<Restraint> {
  const ahead = (d: Date | null) => (d && d.getTime() > now.getTime() ? d.toISOString() : null);
  const cur = r.emotional?.current ?? null;
  const count = r.unansweredSends.length;
  const last = count ? r.unansweredSends[count - 1] : null;
  return {
    holdUntil: ahead(r.holdUntil),
    spaceUntil: ahead(r.spaceUntil),
    safetyHold: r.safetyHold,
    needsCare: !!r.emotional?.needsCare, // mood: carries the read
    frustratedWithCo: !!r.emotional?.withCo?.frustrated, // mood: carries the read
    feeling: cur ? `${cur.emotion}${cur.about ? ` about ${cur.about}` : ""} (${cur.intensity}, from a ${cur.source})` : null,
    suppressedKinds: [...r.suppressed],
    trialKinds: [...r.trial],
    unanswered: { count, lastInboundAt: iso(r.lastInboundAt), lastSentAt: iso(last) },
    verifiedAt: now.toISOString(),
  };
}

// Pure: a text_exchange row as an exchange, or null for a line that isn't one (a failed-send note).
export function exchangeOf(row: { content: string; at: Date }): Fact<Exchange> | null {
  const c = row.content;
  const at = row.at.toISOString();
  // A failed-send note is a record, not an exchange (review of #119).
  if (/\bfailed to deliver\b/i.test(c)) return null;
  // Any "User ...:" line is theirs ("User said:", "User sent a voice memo:"), any "Co ...:" line Co's ("Co replied:", "Co is
  // looking:") (review of #119: voice memos were dropped).
  const member = c.match(/^\s*User\b[^:\n]{0,40}:\s*([\s\S]*)$/i);
  if (member) return { from: "member", text: member[1].trim(), call: false, verifiedAt: at };
  const call = c.match(/^\s*\[Call\]\s*([\s\S]*)$/);
  if (call) return { from: "co", text: call[1].trim(), call: true, verifiedAt: at };
  const co = c.match(/^\s*(?:Co|Cue)\b[^:\n]{0,40}:\s*([\s\S]*)$/i);
  if (co) return { from: "co", text: co[1].trim(), call: false, verifiedAt: at };
  return null;
}

// ---------------------------------------------------------------- the strip (every string, inside)

// Keys whose values are structure, not prose: never rewritten (a kind, a state, an id, a time, a URL, the zone, their own name).
const STRUCTURAL = new Set(["hash", "userId", "asOf", "verifiedAt", "at", "dueAt", "expiresOn", "saidOn", "holdUntil", "spaceUntil", "lastInboundAt", "lastSentAt", "id", "ref", "kind", "state", "status", "via", "from", "source", "provenance", "field", "url", "zone", "timeZone", "firstName", "suppressedKinds", "trialKinds"]);
// Their own words: a claim's quote. (Their exchange lines are kept by the walk below, by from === "member".)
const OWN_WORDS = new Set(["quote"]);

function stripDeep<T>(value: T, strip: (s: string) => string, key: string | null = null): T {
  if (typeof value === "string") return (key && (STRUCTURAL.has(key) || OWN_WORDS.has(key)) ? value : strip(value)) as T;
  if (Array.isArray(value)) return value.map((v) => stripDeep(v, strip, key)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const own = (value as any).from === "member";
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = own && k === "text" ? v : stripDeep(v, strip, k);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- the assembler

const empty = (userId: string, now: Date, identity: Fact<Identity>): MemberKnowledge => ({
  userId,
  asOf: now.toISOString(),
  identity,
  goals: [],
  asks: [],
  delivered: [],
  carrying: [],
  lessons: [],
  corrections: [],
  preferences: [],
  claims: [],
  restraint: null,
  exchanges: [],
  person: null,
  limits: null,
});

export async function memberKnowledge(userId: string, opts: KnowledgeOptions = {}, deps: Partial<KnowledgeDeps> = {}): Promise<MemberKnowledge> {
  const d: KnowledgeDeps = { ...realKnowledgeDeps, ...deps };
  const now = opts.now ?? new Date();
  const want = new Set<KnowledgeSection>(opts.include ?? KNOWLEDGE_SECTIONS);
  const on = (s: KnowledgeSection) => want.has(s);
  // A failed section read is an empty section (logged); a failed name read rejects (see the header).
  const safe = <T,>(what: string, p: () => Promise<T>, fallback: T): Promise<T> =>
    Promise.resolve()
      .then(p)
      .catch((err: any) => {
        console.error(`memberKnowledge: ${what} read failed (non-fatal, empty):`, err?.message ?? err);
        return fallback;
      });
  const skip = <T,>(s: KnowledgeSection | KnowledgeSection[], what: string, p: () => Promise<T>, fallback: T) => ((Array.isArray(s) ? s.some(on) : on(s)) ? safe(what, p, fallback) : Promise.resolve(fallback));

  const [profile, zone, names] = await Promise.all([safe("profile", () => d.profile(userId), null), safe("zone", () => d.zone(userId), null), d.linkedNames(userId)]);
  // No names, no knowledge: a failed name read throws rather than returning anything unstripped (fails closed, PR #118).
  const identity: Fact<Identity> = { firstName: profile?.firstName ?? null, city: profile?.city ?? null, zone, timeZone: wordsZone(zone), verifiedAt: latest(profile?.updatedAt ?? null) };
  const k = empty(userId, now, identity);

  const [states, asks, receipts, ledger, offers, tasks, briefs, loops, promises, lessons, corrections, taste, stated, claims, restraint, exchanges, person, limits] = await Promise.all([
    // Corrections read the goal states too: a corrected goal that's since done is history, not their current goal.
    skip(["goals", "corrections"], "goal states", () => d.goalStates(userId), [] as GoalStateRow[]),
    skip("asks", "asks", () => d.asks(userId), [] as RawAsk[]),
    skip(["delivered", "carrying"], "receipts", () => d.receipts(userId), [] as Receipt[]),
    skip(["delivered", "carrying"], "ledger", () => d.ledgerSent(userId), [] as RawSent[]),
    skip("delivered", "offers", () => d.offers(userId), [] as SentItem[]),
    skip("carrying", "tasks", () => d.tasks(userId), [] as CoTask[]),
    skip("carrying", "briefs", () => d.briefs(userId), [] as BriefView[]),
    skip("carrying", "loops", () => d.loops(userId), [] as RawLoop[]),
    skip("carrying", "promises", () => d.promiseResults(userId), [] as { at: Date; content: string }[]),
    skip("lessons", "lessons", () => d.lessons(userId), [] as { text: string; at: Date }[]),
    skip("corrections", "corrections", () => d.corrections(userId, opts.corrections ?? CORRECTION_DEFAULTS), [] as CorrectionRow[]),
    skip("preferences", "taste", () => d.taste(userId), null),
    skip("preferences", "room taste", async () => [...(await d.roomTaste(userId)), ...(d.designTaste ? await d.designTaste(userId).catch(() => []) : [])], [] as { text: string; at: Date }[]),
    skip("claims", "claims", () => d.claims(userId, now, zone), [] as Claim[]),
    skip("restraint", "restraint", () => d.restraint(userId, now), null as RawRestraint | null),
    skip("exchanges", "exchanges", () => d.exchanges(userId, { limit: Math.max(1, opts.exchanges ?? EXCHANGE_DEFAULTS.limit), days: Math.max(1, opts.exchangeDays ?? EXCHANGE_DEFAULTS.days) }), [] as { content: string; at: Date }[]),
    skip("person", "person model", () => d.person(userId), ""),
    skip("limits", "limits", () => d.limits(userId), null as (Limits & { at: Date | null }) | null),
  ]);
  // The raw exchanges read through the live guards (services/whatCoKnows.ts guardText): a line saying something they removed is left
  // out; one still saying what they corrected away keeps its words with the correction inline. Every reader of exchanges (calls,
  // tasks, follow-ups, dispatch, the sweep) gets the same lines.
  // The removals (not the corrections: those stay with the readers that note them) over Cue's lessons, what it's carrying (open
  // loops, promise results) and its record of what it sent: each is written from their words, so a thing they had Cue forget
  // can't come back through one of them. A part that says it goes; a line that is only it goes.
  const guards = (["exchanges", "corrections", "lessons", "carrying", "delivered"] as KnowledgeSection[]).some(on) && d.forgotten ? await safe("forgotten", () => d.forgotten!(userId), []) : [];
  const removed = guards.filter((r) => r.removed);
  const W = guards.length ? await import("./whatCoKnows.js") : null;
  const g = (t: string): string | null => (W && removed.length ? W.guardText(t, removed) : t);
  // A lesson goes whole when any part of it says the removed thing: a lesson is one instruction, and cutting a part ("never joke
  // about X; keep it light" -> "keep it light") can widen what it tells Cue to do.
  const keptLessons = lessons.filter((l) => g(l.text) === l.text);
  const keptLoops = loops.flatMap((l) => { const title = g(l.title); return title === null ? [] : [{ ...l, title, detail: l.detail ? g(l.detail) : l.detail }]; });
  const keptPromises = promises.flatMap((p) => { const content = g(p.content); return content === null ? [] : [{ ...p, content }]; });
  const keptLedger = ledger.flatMap((s) => { const label = g(s.label); return label === null ? [] : [{ ...s, label }]; });
  // What they have (document receipts) and what Cue sent first (offers): a document or a find named by the removed thing is left out.
  const keptReceipts = W && removed.length ? receipts.filter((r) => g(String(r.title ?? "")) === String(r.title ?? "")) : receipts;
  const keptOffers = W && removed.length ? withoutRemovedSent(offers, removed, W) : offers;

  if (on("goals")) k.goals = goalsOf(profile, states);
  if (on("asks")) k.asks = asks.filter((a) => a.text.trim()).map((a) => ({ id: a.id, text: a.text.trim(), kind: a.kind === "help" ? "help" : "find", verifiedAt: latest(a.createdAt, a.lastMentionedAt) }));
  if (on("delivered")) k.delivered = mergeDelivered({ receipts: keptReceipts, ledger: keptLedger, offers: keptOffers });
  if (on("carrying")) k.carrying = carryingOf({ tasks, briefs, receipts: keptReceipts, ledger: keptLedger, loops: keptLoops, promises: keptPromises, now, zone });
  if (on("lessons")) k.lessons = keptLessons.filter((l) => l.text.trim()).map((l) => ({ text: l.text.trim(), verifiedAt: l.at.toISOString() }));
  if (on("corrections")) k.corrections = settleGoalCorrections(corrections.map((c) => ({ field: String(c.field), was: String(c.old_value ?? ""), now: c.new_value == null ? null : String(c.new_value), verifiedAt: latest(c.corrected_at) })), goalsOf(profile, states));
  if (on("preferences")) k.preferences = [
    ...stated.map((s) => ({ text: s.text, source: "stated" as const, verifiedAt: s.at.toISOString() })),
    ...(taste ? [{ text: taste.text, source: "taste" as const, verifiedAt: taste.at.toISOString() }] : []),
  ];
  if (on("claims")) k.claims = claims.map((c) => ({ text: c.text, provenance: c.provenance, kind: c.kind, quote: c.quote, expiresOn: c.expiresOn, saidOn: String(c.saidOn).slice(0, 10), verifiedAt: latest(c.confirmedOn, c.saidOn) }));
  if (on("restraint") && restraint) k.restraint = restraintOf(restraint, now);
  if (removed.length) k.removedCount = removed.length;
  if (on("exchanges")) k.exchanges = exchanges.flatMap((e) => { const content = W ? W.guardText(e.content, guards) : e.content; return content === null ? [] : [{ ...e, content }]; }).map(exchangeOf).filter((x): x is Fact<Exchange> => !!x).sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt)).slice(-(opts.exchanges ?? EXCHANGE_DEFAULTS.limit));
  if (on("person") && person.trim()) k.person = { text: person, verifiedAt: now.toISOString() };
  if (on("limits") && limits) k.limits = { avoid: limits.avoid, availability: limits.availability, verifiedAt: latest(limits.at) };

  // The strip, last, over everything (see the header): nothing un-stripped leaves.
  const linked = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))];
  const strip = (s: string) => safeMemory("member_knowledge", s, linked) ?? "";
  return stripDeep(k, strip);
}

// ---------------------------------------------------------------- member-level rules

const hourWords = (h: number) => DateTime.fromObject({ hour: h }).toFormat("ha").toLowerCase();

// Pure: the quiet-hours rule in their zone, with where "now" sits in it.
export function quietHoursRule(zone: string | null, now: Date): string {
  const tz = wordsZone(zone);
  const local = DateTime.fromJSDate(now).setZone(tz).toFormat("h:mma").toLowerCase();
  return `Quiet hours: Cue starts nothing on its own (no text, call or delivery) before ${hourWords(REASONABLE_HOUR_START)} or from ${hourWords(REASONABLE_HOUR_END)} their time (${tz}${zone ? "" : ", their zone isn't known"}). It's ${local} there now${sendableAt(now, zone) ? "" : ", inside their quiet hours"}.`;
}

// Pure: the restraint rule from this member's state.
export function restraintRule(r: Restraint | null, zone: string | null): string {
  if (!r) return "";
  const when = (at: string) => localStamp(at, zone);
  const lines = [
    r.safetyHold ? "A safety hold is on: no offers, finds or nudges; only care." : null,
    r.holdUntil ? `Cue starts nothing on its own until ${when(r.holdUntil)}.` : null,
    r.spaceUntil ? `Cue is giving them space after handing work to a task: nothing new on its own until ${when(r.spaceUntil)}.` : null,
    // The count only: the real pause is decided per lane by the send gate (harness/proactive.ts userLevelChecks), so no date is
    // stated as fact here (review of #119).
    r.unanswered.count ? `${r.unanswered.count} of Cue's own texts since they last wrote ${r.unanswered.count === 1 ? "has" : "have"} no reply yet: go lighter, and let them lead.` : null,
    r.suppressedKinds.length
      ? `Kinds of message they keep letting pass, which Cue doesn't start (off ${RESTRAINT.offDays} days, then one trial): ${r.suppressedKinds.join(", ")}${r.trialKinds.length ? ` (a trial may go now: ${r.trialKinds.join(", ")})` : ""}. Answers to their own asks still go.`
      : r.trialKinds.length
        ? `Kinds of message they had let pass, now off ${RESTRAINT.offDays} days: one trial may go now (${r.trialKinds.join(", ")}). Answers to their own asks still go.`
        : null,
    r.needsCare ? "They're having a hard time lately: it shapes how Cue says things, never whether they get events or people." : null,
    r.frustratedWithCo ? "They've been frustrated with Cue lately: look wider and try harder." : null,
  ].filter(Boolean);
  return `Restraint: ${lines.length ? lines.join(" ") : "no hold, pause or muted kind is on right now; the usual caps and spacing still apply."}`;
}

// The member-level rules, read with their knowledge. discretion, memberSafety, grounding and deliveryShape are the shared constants
// themselves (harness/discretion.ts, services/coCore.ts, services/speakable.ts); restraint and quietHours are read from k.
export function memberRules(k: MemberKnowledge): MemberRules {
  return {
    discretion: DISCRETION_GUIDE,
    memberSafety: CO_MEMBER_SAFETY,
    grounding: CO_GROUNDING,
    deliveryShape: DELIVERY_SHAPE_RULE,
    restraint: restraintRule(k.restraint, k.identity.zone),
    quietHours: quietHoursRule(k.identity.zone, new Date(k.asOf)),
  };
}
